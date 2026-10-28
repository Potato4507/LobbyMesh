import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  DesktopMessaging,
  type MessagingPolicy,
} from "../apps/desktop/src/messaging.js";
import {
  DIRECT_NAMESPACE,
  DirectMessenger,
  type TextEnvelope,
} from "../packages/protocol/src/direct.js";

const a = "a".repeat(64),
  b = "b".repeat(64),
  c = "c".repeat(64),
  key = "d".repeat(64);
const peerA = { id: a, publicKey: "synthetic", transportKey: key },
  peerB = { id: b, publicKey: "synthetic", transportKey: key };
function policy(ids = [b]) {
  const allowed = new Set(ids),
    blocked = new Set<string>();
  const value: MessagingPolicy = {
    allowed: () => [...allowed],
    authorized: (id) => allowed.has(id) && !blocked.has(id),
    blocked: (id) => blocked.has(id),
  };
  return { allowed, blocked, value };
}
test("desktop messages show actual send acknowledgments and deduplicated incoming text only for authorized contacts", async () => {
  let now = 1000;
  const permits = policy();
  const remote = new DirectMessenger(b, async () => null, {
    authorized: (id) => id === a,
    now: () => now,
  });
  const service = new DesktopMessaging(
    a,
    (_contact, request, signal) => remote.handle(peerA, request, signal),
    permits.value,
    () => [
      { id: b, transportKey: key },
      { id: c, transportKey: key },
    ],
    () => now,
  );
  assert.deepEqual(service.contacts(), [{ peerId: b, discovered: true }]);
  await assert.rejects(
    service.send(c, "no permission"),
    /CONTACT_NOT_AUTHORIZED/,
  );
  await assert.rejects(service.send(b, "x".repeat(4097)), /INVALID_TEXT/);
  const result = await service.send(b, "hello");
  assert.equal(service.history(b)[0]?.messageId, result.id);
  assert.equal(service.history(b)[0]?.status, "acknowledged");
  const message: TextEnvelope = {
    namespace: DIRECT_NAMESPACE,
    version: 1,
    type: "text",
    id: "12".repeat(16),
    from: b,
    to: a,
    senderEpoch: "34".repeat(16),
    seq: 1,
    createdAt: now,
    text: "reply",
  };
  const signal = new AbortController().signal;
  await service.handle(peerB, message, signal);
  await service.handle(peerB, message, signal);
  assert.deepEqual(
    service.history(b).map((m) => [m.direction, m.text]),
    [
      ["outgoing", "hello"],
      ["incoming", "reply"],
    ],
  );
  const copied = service.history(b);
  if (copied[0]) copied[0].text = "mutated";
  assert.equal(service.history(b)[0]?.text, "hello");
  now += 900_001;
  assert.deepEqual(service.history(b), []);
  service.close();
  remote.close();
});
test("pending/unconfirmed delivery is explicit; revocation aborts pending work and hides history", async () => {
  const permits = policy();
  const service = new DesktopMessaging(
    a,
    async (_contact, _request, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("canceled")), {
          once: true,
        });
      }),
    permits.value,
    () => [{ id: b, transportKey: key }],
  );
  const send = service.send(b, "in flight");
  await setImmediate();
  assert.equal(service.history(b)[0]?.status, "sending");
  assert.equal(service.history(b)[0]?.messageId, null);
  permits.allowed.delete(b);
  service.policyChanged(b);
  await assert.rejects(send, /DELIVERY_UNCONFIRMED/);
  assert.throws(() => service.history(b), /CONTACT_NOT_AUTHORIZED/);
  assert.deepEqual(service.contacts(), []);
  permits.allowed.add(b);
  assert.equal(service.history(b)[0]?.status, "unconfirmed");
  service.clear(b);
  assert.deepEqual(service.history(b), []);
  service.close();
});
test("conversation/history bounds reject before accepting invisible incoming messages", async () => {
  let now = 1000;
  const ids = Array.from({ length: 33 }, (_, n) =>
      (n + 1).toString(16).padStart(64, "0"),
    ),
    permits = policy(ids);
  const service = new DesktopMessaging(
    a,
    async (contact, request) => {
      const value = request as TextEnvelope;
      return value.type === "text"
        ? { namespace: DIRECT_NAMESPACE, version: 1, type: "ack", id: value.id }
        : {
            namespace: DIRECT_NAMESPACE,
            version: 1,
            type: "pong",
            peerId: contact.id,
            features: ["text-v1"],
          };
    },
    permits.value,
    () => ids.map((id) => ({ id, transportKey: key })),
    () => now,
  );
  const first = ids[0];
  assert.ok(first);
  for (let n = 0; n < 60; n++) {
    now += 50;
    await service.send(first, `message ${n}`);
  }
  assert.equal(service.history(first).length, 50);
  for (const id of ids.slice(1, 32)) await service.send(id, "bounded fixture");
  const extra = ids[32];
  assert.ok(extra);
  await assert.rejects(
    service.handle(
      { ...peerB, id: extra },
      { namespace: DIRECT_NAMESPACE, version: 1, type: "text" },
      new AbortController().signal,
    ),
    /CONVERSATION_QUOTA/,
  );
  await assert.rejects(service.send(extra, "no room"), /CONVERSATION_QUOTA/);
  service.clear(first);
  await service.send(extra, "space restored");
  service.close();
  assert.deepEqual(service.contacts(), []);
});
