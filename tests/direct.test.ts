import assert from "node:assert/strict";
import test from "node:test";
import {
  DIRECT_NAMESPACE,
  DirectMessenger,
  type TextEnvelope,
} from "../packages/protocol/src/direct.js";

const a = "a".repeat(64),
  b = "b".repeat(64),
  key = "c".repeat(64);
const peer = {
  id: a,
  publicKey: "synthetic authenticated identity",
  transportKey: key,
};
const contact = { id: b, transportKey: key };
const envelope = (seq = 0): TextEnvelope => ({
  namespace: DIRECT_NAMESPACE,
  version: 1,
  type: "text",
  id: seq.toString(16).padStart(32, "0"),
  from: a,
  to: b,
  senderEpoch: "e".repeat(32),
  seq,
  createdAt: 1000,
  text: `message ${seq}`,
});
test("direct contact policy defaults deny and protocol validates permission, identity, envelope and replay", async () => {
  let allowed = true,
    delivered = 0;
  const receiver = new DirectMessenger(b, async () => null, {
    authorized: () => allowed,
    now: () => 1000,
    onMessage: () => {
      delivered++;
    },
  });
  const denied = new DirectMessenger(a, async () =>
    assert.fail("unauthorized send must not dial"),
  );
  await assert.rejects(
    denied.sendText(contact, "hello"),
    /CONTACT_NOT_AUTHORIZED/,
  );
  const signal = new AbortController().signal;
  const message = envelope();
  const ack = await receiver.handle(peer, message, signal);
  assert.deepEqual(await receiver.handle(peer, message, signal), ack);
  assert.equal(delivered, 1);
  await assert.rejects(
    receiver.handle(peer, { ...message, text: "changed" }, signal),
    /MESSAGE_ID_CONFLICT/,
  );
  for (const value of [
    { ...envelope(1), from: b },
    { ...envelope(1), to: a },
    { ...envelope(1), text: "x".repeat(4097) },
    { ...envelope(1), text: "x\0y" },
    { ...envelope(1), version: 2 },
    { ...envelope(1), createdAt: -120_000 },
  ])
    await assert.rejects(receiver.handle(peer, value, signal));
  const copy = receiver.history(a);
  if (copy[0]) copy[0].envelope.text = "mutation";
  assert.equal(receiver.history(a)[0]?.envelope.text, message.text);
  allowed = false;
  await assert.rejects(
    receiver.handle(peer, envelope(1), signal),
    /CONTACT_NOT_AUTHORIZED/,
  );
  receiver.forget(a);
  allowed = true;
  assert.deepEqual(receiver.history(a), []);
  receiver.close();
  denied.close();
});
test("10,000 synthetic sends survive deterministic drop, duplicate and lost-ACK faults with bounded history", async (t) => {
  let now = 1000,
    delivered = 0,
    attempts = 0;
  const receiver = new DirectMessenger(b, async () => null, {
    authorized: (id) => id === a,
    now: () => now,
    historyLimit: 8,
    onMessage: () => {
      delivered++;
    },
  });
  const counts = new Map<string, number>();
  const sender = new DirectMessenger(
    a,
    async (_contact, value, signal) => {
      const request = value as TextEnvelope;
      if (request.type !== "text")
        return receiver.handle(peer, request, signal);
      attempts++;
      const count = (counts.get(request.id) ?? 0) + 1;
      counts.set(request.id, count);
      if (request.seq % 13 === 0 && count === 1)
        throw new Error("dropped before delivery");
      const ack = await receiver.handle(peer, request, signal);
      if (request.seq % 7 === 0) await receiver.handle(peer, request, signal);
      if (request.seq % 11 === 0 && count === 1) throw new Error("lost ACK");
      return ack;
    },
    {
      authorized: (id) => id === b,
      now: () => now,
      retryDelay: async () => {},
    },
  );
  await sender.negotiate(contact);
  await sender.heartbeat(contact);
  for (let n = 0; n < 10_000; n++) {
    now += 50;
    const result = await sender.sendText(contact, `synthetic ${n}`);
    assert.equal(result.status, "acknowledged");
    assert.ok(result.attempts <= 3);
  }
  assert.equal(delivered, 10_000);
  assert.equal(receiver.history(a).length, 8);
  t.diagnostic(
    `synthetic messages=10000 delivered=${delivered} transportAttempts=${attempts} retainedHistory=8`,
  );
  sender.close();
  receiver.close();
});
test("out-of-order envelopes retain sender sequence; rate limits, stalled transport, cancellation and invalid ACK fail visibly", async () => {
  const signal = new AbortController().signal;
  const receiver = new DirectMessenger(b, async () => null, {
    authorized: () => true,
    now: () => 1000,
  });
  for (const n of [2, 0, 1]) await receiver.handle(peer, envelope(n), signal);
  assert.deepEqual(
    receiver.history(a).map((m) => m.envelope.seq),
    [2, 0, 1],
  );
  for (let n = 3; n < 20; n++) await receiver.handle(peer, envelope(n), signal);
  await assert.rejects(
    receiver.handle(peer, envelope(20), signal),
    /MESSAGE_RATE_LIMIT/,
  );
  const invalid = new DirectMessenger(
    a,
    async () => ({ type: "ack", id: "wrong" }),
    { authorized: () => true },
  );
  await assert.rejects(invalid.sendText(contact, "hello"), /INVALID_ACK/);
  let aborted = false;
  const stalled = new DirectMessenger(
    a,
    async (_peer, _request, combined) => {
      combined.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise(() => {});
    },
    { authorized: () => true, requestTimeoutMs: 5, retryDelay: async () => {} },
  );
  await assert.rejects(stalled.sendText(contact, "hello"), /DIRECT_TIMEOUT/);
  assert.ok(aborted);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    stalled.sendText(contact, "hello", controller.signal),
    /SEND_ABORTED/,
  );
  receiver.close();
  invalid.close();
  stalled.close();
});
