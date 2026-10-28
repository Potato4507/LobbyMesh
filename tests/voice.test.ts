import assert from "node:assert/strict";
import test from "node:test";
import type { AuthenticatedPeer } from "../packages/app-dht/src/rpc.js";
import { DIRECT_NAMESPACE } from "../packages/protocol/src/direct.js";
import { VoiceSignaling } from "../packages/voice/src/signaling.js";

const a = "a".repeat(64),
  b = "b".repeat(64);
const contactA = { id: a, transportKey: "c".repeat(64) },
  contactB = { id: b, transportKey: "d".repeat(64) };
const peer = (contact: typeof contactA): AuthenticatedPeer => ({
  ...contact,
  publicKey: "synthetic-public-key",
});
const candidate = {
  candidate: "candidate:synthetic",
  sdpMid: "0",
  sdpMLineIndex: 0,
};
function envelope(
  op = "offer",
  data: unknown = "synthetic offer",
  extra: object = {},
) {
  return {
    namespace: DIRECT_NAMESPACE,
    version: 1,
    type: "voice",
    protocol: "companion/media/v1",
    op,
    id: "1".repeat(32),
    from: a,
    to: b,
    callId: "2".repeat(32),
    createdAt: 100_000,
    data,
    ...extra,
  };
}
function pair(t: test.TestContext, timeout = 30_000) {
  let permitted = true,
    mediaAvailable = true;
  const options = {
    authorized: () => permitted,
    mediaAvailable: () => mediaAvailable,
    negotiationTimeoutMs: timeout,
  };
  const left: VoiceSignaling = new VoiceSignaling(
    a,
    (_c, request, signal) => right.handle(peer(contactA), request, signal),
    options,
  );
  const right: VoiceSignaling = new VoiceSignaling(
    b,
    (_c, request, signal) => left.handle(peer(contactB), request, signal),
    options,
  );
  t.after(() => {
    left.close();
    right.close();
  });
  return {
    left,
    right,
    deny: () => {
      permitted = false;
    },
    loseMedia: () => {
      mediaAvailable = false;
    },
  };
}
test("voice defaults deny; offers cannot opt in or answer for the recipient", async (t) => {
  const { left, right } = pair(t);
  await assert.rejects(left.offer(contactB, "offer"), /VOICE_DISABLED/);
  left.setConsent(true);
  await assert.rejects(left.offer(contactB, "offer"), /VOICE_DISABLED/);
  assert.equal(left.status().phase, "idle");
  assert.deepEqual(right.drainEvents(), []);
  right.setConsent(true);
  const id = await left.offer(contactB, "synthetic offer");
  assert.equal(right.status().phase, "ringing");
  assert.equal(left.status().phase, "offering");
  assert.deepEqual(right.drainEvents(), [
    { callId: id, peerId: a, op: "offer", data: "synthetic offer" },
  ]);
  await assert.rejects(left.ice(id, candidate), /VOICE_STATE_MISMATCH/);
  await right.answer(id, "synthetic answer");
  assert.equal(left.status().phase, "negotiating");
  assert.equal(right.status().phase, "negotiating");
  assert.equal(left.drainEvents()[0]?.data, "synthetic answer");
  await left.ice(id, candidate);
  assert.deepEqual(right.drainEvents()[0]?.data, candidate);
  await left.hangup(id);
  assert.equal(left.status().phase, "idle");
  assert.equal(right.status().phase, "idle");
  assert.deepEqual(right.drainEvents(), [
    { callId: id, peerId: a, op: "hangup", data: null },
  ]);
});
test("voice requires a trusted media adapter and local contact permission at each boundary", async (t) => {
  const { left, right, deny, loseMedia } = pair(t);
  left.setConsent(true);
  right.setConsent(true);
  await left.offer(contactB, "synthetic offer");
  deny();
  assert.equal(right.status().phase, "idle");
  assert.deepEqual(right.drainEvents(), []);
  await assert.rejects(left.offer(contactB, "offer"), /CONTACT_NOT_AUTHORIZED/);
  loseMedia();
  assert.equal(left.status().phase, "disabled");
  const noAdapter = new VoiceSignaling(a, async () => null, {
    authorized: () => true,
  });
  t.after(() => noAdapter.close());
  noAdapter.setConsent(true);
  assert.equal(noAdapter.status().available, false);
  await assert.rejects(noAdapter.offer(contactB, "offer"), /VOICE_DISABLED/);
});
test("voice validates envelope identity, freshness, fields and byte bounds before retaining SDP", async (t) => {
  const voice = new VoiceSignaling(b, async () => null, {
    authorized: () => true,
    mediaAvailable: () => true,
    now: () => 100_000,
  });
  t.after(() => voice.close());
  voice.setConsent(true);
  for (const value of [
    envelope("offer", "x", { from: b }),
    envelope("offer", "x", { to: a }),
    envelope("offer", "x", { createdAt: 70_000 }),
    envelope("offer", "x", { createdAt: 105_001 }),
    envelope("offer", "x", { version: 2 }),
    envelope("offer", "x", { extra: true }),
    envelope("offer", "x", { callId: "bad" }),
    envelope("offer", "é".repeat(6145)),
    envelope("offer", ""),
    envelope("ice", { ...candidate, candidate: "x".repeat(2049) }),
    envelope("ice", { ...candidate, sdpMLineIndex: -1 }),
    envelope("ice", { ...candidate, sdpMid: 0 }),
    envelope("ice", { ...candidate, extra: true }),
    envelope("hangup", "x"),
  ]) {
    await assert.rejects(
      voice.handle(peer(contactA), value, new AbortController().signal),
      /INVALID_VOICE_ENVELOPE/,
    );
    assert.equal(voice.status().phase, "idle");
  }
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    voice.handle(peer(contactA), envelope(), aborted.signal),
    /RPC_ABORTED/,
  );
  await voice.handle(peer(contactA), envelope(), new AbortController().signal);
  assert.equal(voice.status().phase, "ringing");
});
test("voice deduplicates exact packets, rejects conflicting IDs and rejects unrelated calls", async (t) => {
  const voice = new VoiceSignaling(b, async () => null, {
    authorized: () => true,
    mediaAvailable: () => true,
    now: () => 100_000,
  });
  t.after(() => voice.close());
  voice.setConsent(true);
  const signal = new AbortController().signal;
  const first = await voice.handle(peer(contactA), envelope(), signal);
  assert.deepEqual(
    await voice.handle(peer(contactA), envelope(), signal),
    first,
  );
  assert.equal(voice.drainEvents().length, 1);
  await assert.rejects(
    voice.handle(peer(contactA), envelope("offer", "changed"), signal),
    /VOICE_ID_CONFLICT/,
  );
  await assert.rejects(
    voice.handle(
      peer(contactA),
      envelope("offer", "another", { id: "3".repeat(32) }),
      signal,
    ),
    /VOICE_BUSY/,
  );
  await assert.rejects(
    voice.handle(
      peer(contactA),
      envelope("hangup", null, { id: "4".repeat(32), callId: "5".repeat(32) }),
      signal,
    ),
    /VOICE_CALL_MISMATCH/,
  );
  await assert.rejects(
    voice.handle(
      { ...peer(contactA), transportKey: "e".repeat(64) },
      envelope("hangup", null, { id: "6".repeat(32) }),
      signal,
    ),
    /VOICE_CALL_MISMATCH/,
  );
  const hangup = envelope("hangup", null, { id: "7".repeat(32) });
  await voice.handle(peer(contactA), hangup, signal);
  voice.drainEvents();
  await voice.handle(peer(contactA), envelope(), signal);
  assert.equal(voice.status().phase, "idle");
  assert.deepEqual(voice.drainEvents(), []);
});
test("voice bounds ICE and clears call on overflow", async (t) => {
  const { left, right } = pair(t);
  left.setConsent(true);
  right.setConsent(true);
  const id = await left.offer(contactB, "offer");
  await right.answer(id, "answer");
  left.drainEvents();
  right.drainEvents();
  for (let i = 0; i < 48; i++) await left.ice(id, candidate);
  assert.equal(right.drainEvents().length, 48);
  await assert.rejects(left.ice(id, candidate), /VOICE_ICE_QUOTA/);
  assert.equal(left.status().phase, "idle");
});
test("voice withdrawal, expiration, close and late transport completion cannot resurrect a call", async (t) => {
  let finish: (value: unknown) => void = () => {},
    captured: { id?: string } = {};
  const voice = new VoiceSignaling(
    a,
    (_c, request) => {
      captured = request as { id?: string };
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    {
      authorized: () => true,
      mediaAvailable: () => true,
      requestTimeoutMs: 25,
    },
  );
  t.after(() => voice.close());
  voice.setConsent(true);
  let pending = voice.offer(contactB, "offer");
  voice.setConsent(false);
  await assert.rejects(pending, /VOICE_ABORTED/);
  finish({ protocol: "companion/media/v1", type: "ack", id: captured.id });
  assert.equal(voice.status().phase, "disabled");
  voice.setConsent(true);
  pending = voice.offer(contactB, "offer");
  await assert.rejects(pending, /VOICE_TIMEOUT/);
  finish({ protocol: "companion/media/v1", type: "ack", id: captured.id });
  assert.equal(voice.status().phase, "idle");
  pending = voice.offer(contactB, "offer");
  voice.close();
  await assert.rejects(pending, /VOICE_ABORTED/);
  const { left, right } = pair(t, 25);
  left.setConsent(true);
  right.setConsent(true);
  await left.offer(contactB, "offer");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(left.status().phase, "idle");
  assert.equal(right.status().phase, "idle");
  assert.deepEqual(right.drainEvents(), []);
});
test("voice rejects invalid ACK and local hangup clears before a stalled send completes", async (t) => {
  const bad = new VoiceSignaling(a, async () => ({ type: "ack" }), {
    authorized: () => true,
    mediaAvailable: () => true,
  });
  t.after(() => bad.close());
  bad.setConsent(true);
  await assert.rejects(bad.offer(contactB, "offer"), /INVALID_VOICE_ACK/);
  assert.equal(bad.status().phase, "idle");
  let stalled = false;
  const voice = new VoiceSignaling(
    a,
    async (_c, req) => {
      const value = req as { id: string; op: string };
      if (value.op === "hangup") {
        stalled = true;
        return new Promise(() => {});
      }
      return { protocol: "companion/media/v1", type: "ack", id: value.id };
    },
    {
      authorized: () => true,
      mediaAvailable: () => true,
      requestTimeoutMs: 25,
    },
  );
  t.after(() => voice.close());
  voice.setConsent(true);
  const id = await voice.offer(contactB, "offer");
  const pending = voice.hangup(id);
  assert.equal(stalled, true);
  assert.equal(voice.status().phase, "idle");
  voice.close();
  await assert.rejects(pending, /VOICE_ABORTED/);
});

test("voice rejects reused call IDs and bounds retransmit floods", async (t) => {
  const voice = new VoiceSignaling(b, async () => null, {
    authorized: () => true,
    mediaAvailable: () => true,
    now: () => 100_000,
  });
  t.after(() => voice.close());
  voice.setConsent(true);
  const signal = new AbortController().signal;
  await voice.handle(peer(contactA), envelope(), signal);
  await voice.handle(
    peer(contactA),
    envelope("hangup", null, { id: "3".repeat(32) }),
    signal,
  );
  await assert.rejects(
    voice.handle(
      peer(contactA),
      envelope("offer", "reused", { id: "4".repeat(32) }),
      signal,
    ),
    /VOICE_CALL_REUSED/,
  );
  for (let i = 0; i < 87; i++)
    await voice.handle(peer(contactA), envelope(), signal);
  await assert.rejects(
    voice.handle(peer(contactA), envelope(), signal),
    /VOICE_RATE_LIMIT/,
  );
  assert.equal(voice.status().phase, "idle");
});
test("voice bounds hostile inbound ICE and concurrent outbound sends", async (t) => {
  let offerId = "",
    packets = 0;
  const voice = new VoiceSignaling(
    a,
    async (_c, request) => {
      const value = request as { id: string; callId: string; op: string };
      offerId = value.callId;
      if (value.op === "ice") {
        packets++;
        return new Promise(() => {});
      }
      return { protocol: "companion/media/v1", type: "ack", id: value.id };
    },
    { authorized: () => true, mediaAvailable: () => true },
  );
  t.after(() => voice.close());
  voice.setConsent(true);
  await voice.offer(contactB, "offer");
  const signal = new AbortController().signal;
  const remote = (op: string, data: unknown, id: number) =>
    envelope(op, data, {
      from: b,
      to: a,
      callId: offerId,
      id: id.toString(16).padStart(32, "0"),
      createdAt: Date.now(),
    });
  await voice.handle(peer(contactB), remote("answer", "answer", 1), signal);
  for (let i = 0; i < 48; i++)
    await voice.handle(peer(contactB), remote("ice", candidate, i + 2), signal);
  await assert.rejects(
    voice.handle(peer(contactB), remote("ice", candidate, 50), signal),
    /VOICE_ICE_QUOTA/,
  );
  assert.equal(voice.status().phase, "idle");
  assert.deepEqual(voice.drainEvents(), []);
  await voice.offer(contactB, "new offer");
  await voice.handle(peer(contactB), remote("answer", "answer", 51), signal);
  const sends = Array.from({ length: 8 }, () => voice.ice(offerId, candidate));
  const settled = Promise.allSettled(sends);
  await assert.rejects(voice.ice(offerId, candidate), /VOICE_SEND_QUOTA/);
  assert.equal(packets, 8);
  assert.ok((await settled).every((result) => result.status === "rejected"));
  assert.equal(voice.status().phase, "idle");
});
