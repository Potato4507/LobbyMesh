import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { type CallMedia, VoiceCalls } from "../packages/voice/src/calls.js";

const a = "a".repeat(64),
  b = "b".repeat(64),
  keyA = "c".repeat(64),
  keyB = "d".repeat(64);
function fixture(
  t: test.TestContext,
  extras: {
    negotiationTimeoutMs?: number;
    activeTimeoutMs?: number;
    mediaTimeoutMs?: number;
  } = {},
) {
  const media: (CallMedia & {
    closed: boolean;
    talking: boolean;
    phase: string;
  })[] = [];
  let allowed = true;
  const createMedia = () => {
    const value = {
      closed: false,
      talking: false,
      phase: "negotiating",
      async offer() {
        return "synthetic offer";
      },
      async answer() {
        value.phase = "connected";
        return "synthetic answer";
      },
      async acceptAnswer() {
        value.phase = "connected";
      },
      async setTalking(talk: boolean) {
        value.talking = talk;
      },
      async status() {
        return {
          phase: value.phase,
          capturing: !value.closed,
          transmitting: value.talking,
        };
      },
      close() {
        value.closed = true;
        value.phase = "closed";
        value.talking = false;
      },
    };
    media.push(value);
    return value;
  };
  const options = {
    authorized: () => allowed,
    createMedia,
    pollMs: 1,
    ...extras,
  };
  const left: VoiceCalls = new VoiceCalls(
    a,
    (_contact, request, signal) =>
      right.handle(
        { id: a, transportKey: keyA, publicKey: "synthetic" },
        request,
        signal,
      ),
    options,
  );
  const right: VoiceCalls = new VoiceCalls(
    b,
    (_contact, request, signal) =>
      left.handle(
        { id: b, transportKey: keyB, publicKey: "synthetic" },
        request,
        signal,
      ),
    options,
  );
  t.after(() => {
    left.close();
    right.close();
  });
  return {
    left,
    right,
    media,
    deny: () => {
      allowed = false;
    },
  };
}
test("call coordinator never creates incoming media before local answer and closes both hosts on hangup", async (t) => {
  const { left, right, media } = fixture(t);
  await assert.rejects(
    left.dial({ id: b, transportKey: keyB }, true),
    /VOICE_NOT_PERMITTED/,
  );
  left.setConsent(true);
  right.setConsent(true);
  await assert.rejects(
    left.dial({ id: b, transportKey: keyB }, false),
    /VOICE_NOT_PERMITTED/,
  );
  assert.equal(media.length, 0);
  const id = await left.dial({ id: b, transportKey: keyB }, true);
  assert.equal(media.length, 1);
  assert.equal(right.status().phase, "ringing");
  await assert.rejects(right.answer(id, false), /VOICE_NOT_PERMITTED/);
  assert.equal(media.length, 1);
  await right.answer(id, true);
  await delay(10);
  assert.equal(left.status().phase, "connected");
  assert.equal(right.status().phase, "connected");
  await left.setTalking(true);
  assert.equal(media[0]?.talking, true);
  await left.hangup();
  assert.ok(media.every((value) => value.closed));
  assert.equal(left.status().phase, "idle");
  assert.equal(right.status().phase, "idle");
});
test("local connected media outlives negotiation, expires once, and denial stops capture immediately", async (t) => {
  const { left, right, media, deny } = fixture(t, {
    negotiationTimeoutMs: 40,
    activeTimeoutMs: 100,
  });
  left.setConsent(true);
  right.setConsent(true);
  const id = await left.dial({ id: b, transportKey: keyB }, true);
  await right.answer(id, true);
  await delay(65);
  assert.equal(left.status().phase, "connected");
  deny();
  left.policyChanged();
  right.policyChanged();
  assert.ok(media.every((value) => value.closed));
  assert.equal(left.status().phase, "idle");
  const expiry = fixture(t, { negotiationTimeoutMs: 40, activeTimeoutMs: 50 });
  expiry.left.setConsent(true);
  expiry.right.setConsent(true);
  const next = await expiry.left.dial({ id: b, transportKey: keyB }, true);
  await expiry.right.answer(next, true);
  await delay(80);
  assert.ok(expiry.media.every((value) => value.closed));
  assert.equal(expiry.left.status().phase, "idle");
});
test("canceled or timed out capture cannot transmit a late offer or overwrite a new call", async (t) => {
  let finish: (sdp: string) => void = () => {},
    sends = 0,
    closed = 0,
    captures = 0;
  const calls = new VoiceCalls(
    a,
    async (_contact, request) => {
      sends++;
      return {
        protocol: "companion/media/v1",
        type: "ack",
        id: (request as { id: string }).id,
      };
    },
    {
      authorized: () => true,
      mediaTimeoutMs: 25,
      createMedia: () => ({
        offer: () =>
          ++captures === 2
            ? Promise.resolve("new offer")
            : new Promise((resolve) => {
                finish = resolve;
              }),
        answer: async () => "",
        acceptAnswer: async () => {},
        setTalking: async () => {},
        status: async () => ({
          phase: "negotiating",
          capturing: true,
          transmitting: false,
        }),
        close: () => {
          closed++;
        },
      }),
    },
  );
  t.after(() => calls.close());
  calls.setConsent(true);
  const pending = calls.dial({ id: b, transportKey: keyB }, true);
  const oldFinish = finish;
  calls.setConsent(false);
  await assert.rejects(pending, /VOICE_CALL_CANCELED/);
  assert.equal(sends, 0);
  assert.equal(closed, 1);
  calls.setConsent(true);
  const nextId = await calls.dial({ id: b, transportKey: keyB }, true);
  oldFinish("late previous SDP");
  await delay(0);
  assert.equal(calls.status().callId, nextId);
  assert.equal(calls.status().phase, "offering");
  assert.equal(sends, 1);
  await calls.hangup();
  assert.equal(closed, 2);
  const timeout = calls.dial({ id: b, transportKey: keyB }, true);
  await assert.rejects(timeout, /MEDIA_OWNER_TIMEOUT/);
  finish("late SDP");
  await delay(0);
  assert.equal(sends, 2);
  assert.equal(closed, 3);
});
test("failed capture teardown retains ownership, denies new calls and reports unknown capture", async (t) => {
  const { left, right, media } = fixture(t);
  left.setConsent(true);
  right.setConsent(true);
  await left.dial({ id: b, transportKey: keyB }, true);
  const original = media[0];
  assert.ok(original);
  original.close = () => {
    throw new Error("synthetic teardown fault");
  };
  left.setConsent(false);
  assert.equal(left.status().error, "MEDIA_TEARDOWN_FAILED");
  assert.equal(left.status().capturing, null);
  assert.equal(left.status().transmitting, null);
  await assert.rejects(
    left.dial({ id: b, transportKey: keyB }, true),
    /VOICE_NOT_PERMITTED/,
  );
  assert.throws(() => left.setConsent(true), /MEDIA_TEARDOWN_FAILED/);
  assert.throws(() => left.close(), /MEDIA_TEARDOWN_FAILED/);
  original.close = () => {
    original.closed = true;
  };
  left.close();
  assert.equal(original.closed, true);
});
test("late talk activation cannot overwrite a newer release", async (t) => {
  const { left, right, media } = fixture(t);
  left.setConsent(true);
  right.setConsent(true);
  const id = await left.dial({ id: b, transportKey: keyB }, true);
  await right.answer(id, true);
  await delay(10);
  const local = media[0];
  assert.ok(local);
  let finish: () => void = () => {};
  local.setTalking = async (value: boolean) => {
    if (value)
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    local.talking = value;
  };
  const press = left.setTalking(true);
  await left.setTalking(false);
  finish();
  await press;
  assert.equal(local.talking, false);
  assert.equal(left.status().transmitting, false);
});
