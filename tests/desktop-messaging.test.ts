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
test("clearing local conversation cannot restore an accepted message on a lost-ACK retry", async () => {
  let now = 1000;
  const permits = policy();
  const service = new DesktopMessaging(
    a,
    async () => null,
    permits.value,
    () => [{ id: b, transportKey: key }],
    () => now,
  );
  const signal = new AbortController().signal;
  const original: TextEnvelope = {
    namespace: DIRECT_NAMESPACE,
    version: 1,
    type: "text",
    id: "12".repeat(16),
    from: b,
    to: a,
    senderEpoch: "34".repeat(16),
    seq: 1,
    createdAt: now,
    text: "clear this local text",
  };
  const ack = await service.handle(peerB, original, signal);
  assert.equal(service.history(b).length, 1);
  service.clear(b);
  assert.deepEqual(service.history(b), []);
  assert.deepEqual(await service.handle(peerB, original, signal), ack);
  assert.deepEqual(service.history(b), []);
  await assert.rejects(
    service.handle(peerB, { ...original, text: "conflicting content" }, signal),
    /MESSAGE_ID_CONFLICT/,
  );
  now += 119_999;
  await service.handle(peerB, original, signal);
  assert.deepEqual(service.history(b), []);
  now++;
  await assert.rejects(
    service.handle(peerB, original, signal),
    /INVALID_TEXT_ENVELOPE/,
  );
  await service.handle(
    peerB,
    {
      ...original,
      id: "56".repeat(16),
      seq: 2,
      createdAt: now,
      text: "new message after clear",
    },
    signal,
  );
  assert.equal(service.history(b)[0]?.text, "new message after clear");
  service.close();
});
test("blocking deletes both local plaintext histories immediately and retries cannot restore them after reauthorization", async () => {
  const permits = policy();
  const service = new DesktopMessaging(
    a,
    async () => null,
    permits.value,
    () => [{ id: b, transportKey: key }],
  );
  const original: TextEnvelope = {
    namespace: DIRECT_NAMESPACE,
    version: 1,
    type: "text",
    id: "12".repeat(16),
    from: b,
    to: a,
    senderEpoch: "34".repeat(16),
    seq: 1,
    createdAt: Date.now(),
    text: "blocked plaintext",
  };
  const signal = new AbortController().signal;
  await service.handle(peerB, original, signal);
  permits.blocked.add(b);
  service.policyChanged(b);
  const retained = service as unknown as {
    conversations: Map<string, unknown>;
    messenger: DirectMessenger;
  };
  assert.equal(retained.conversations.size, 0);
  permits.blocked.delete(b);
  assert.deepEqual(retained.messenger.history(b), []);
  assert.deepEqual(service.history(b), []);
  await service.handle(peerB, original, signal);
  assert.deepEqual(service.history(b), []);
  service.close();
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
  assert.equal(service.history(b)[0]?.failure?.reason, "permission-changed");
  service.clear(b);
  assert.deepEqual(service.history(b), []);
  service.close();
});

test("desktop failure projection preserves unconfirmed delivery and copies only bounded reasons", async () => {
  for (const kind of [
    "connect-timeout",
    "peer-rejection",
    "invalid-ack",
    "unknown",
  ] as const) {
    const permits = policy();
    const privateError = "private endpoint and untrusted payload";
    const service = new DesktopMessaging(
      a,
      async (contact, request) => {
        const value = request as TextEnvelope;
        if (kind === "connect-timeout") throw new Error("DIRECT_TIMEOUT");
        if (value.type !== "text")
          return {
            namespace: DIRECT_NAMESPACE,
            version: 1,
            type: "pong",
            peerId: contact.id,
            features: ["text-v1"],
          };
        if (kind === "peer-rejection") throw new Error("REMOTE_RPC_REJECTED");
        if (kind === "unknown") throw new Error(privateError);
        return {
          namespace: DIRECT_NAMESPACE,
          version: 1,
          type: "ack",
          id: "wrong",
        };
      },
      permits.value,
      () => [{ id: b, transportKey: key }],
    );
    try {
      await assert.rejects(
        service.send(b, "visible fixture"),
        /DELIVERY_UNCONFIRMED/,
      );
      const history = service.history(b),
        failure = history[0]?.failure;
      assert.ok(failure);
      assert.equal(history[0]?.status, "unconfirmed");
      assert.equal(history[0]?.messageId, null);
      assert.deepEqual(failure, {
        reason:
          kind === "connect-timeout"
            ? "timeout"
            : kind === "peer-rejection"
              ? "peer-rejected"
              : kind === "invalid-ack"
                ? "invalid-response"
                : "unknown",
        stage: kind === "connect-timeout" ? "connection" : "delivery",
      });
      assert.ok(!JSON.stringify(history).includes(privateError));
      failure.reason = "canceled";
      assert.notEqual(service.history(b)[0]?.failure?.reason, "canceled");
    } finally {
      service.close();
    }
  }
});
test(
  "cancel binds contact and local ID, stops one send, and cannot undo peer acceptance",
  { timeout: 5000 },
  async () => {
    const permits = policy([b, c]);
    const remote = new DirectMessenger(b, async () => null, {
      authorized: () => true,
    });
    let delivered = 0;
    const service = new DesktopMessaging(
      a,
      async (_contact, request, signal) => {
        const response = await remote.handle(peerA, request, signal);
        if ((request as TextEnvelope).type !== "text") return response;
        delivered++;
        return new Promise((_resolve, reject) => {
          if (signal.aborted) reject(new Error("canceled"));
          else
            signal.addEventListener(
              "abort",
              () => reject(new Error("canceled")),
              { once: true },
            );
        });
      },
      permits.value,
      () => [
        { id: b, transportKey: key },
        { id: c, transportKey: key },
      ],
    );
    try {
      const sends = [
        service.send(b, "first accepted but ACK lost"),
        service.send(b, "second accepted but ACK lost"),
      ];
      const checks = sends.map((send) =>
        assert.rejects(send, /DELIVERY_UNCONFIRMED/),
      );
      while (delivered < 2) await setImmediate();
      const first = service.history(b)[0]?.localId,
        second = service.history(b)[1]?.localId;
      assert.ok(first);
      assert.ok(second);
      assert.equal(service.cancel(c, first), false);
      assert.equal(service.cancel(b, "0".repeat(32)), false);
      assert.throws(() => service.cancel(b, "bad"), /INVALID_MESSAGE_CANCEL/);
      assert.equal(service.cancel(b, first), true);
      assert.equal(service.cancel(b, first), false);
      await checks[0];
      assert.equal(service.history(b)[0]?.failure?.reason, "canceled");
      assert.equal(service.history(b)[1]?.status, "sending");
      assert.equal(remote.history(a).length, 2);
      assert.equal(service.cancel(b, second), true);
      await checks[1];
      assert.equal(service.cancel(b, second), false);
      assert.equal(remote.history(a).length, 2);
      permits.allowed.delete(b);
      assert.throws(() => service.cancel(b, first), /CONTACT_NOT_AUTHORIZED/);
    } finally {
      service.close();
      remote.close();
    }
  },
);

test("cancel during connection prevents late handshake completion from starting text", async () => {
  const requests: string[] = [];
  let finish: (value: unknown) => void = () => {};
  const service = new DesktopMessaging(
    a,
    async (_contact, request) => {
      requests.push((request as TextEnvelope).type);
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    policy().value,
    () => [{ id: b, transportKey: key }],
  );
  try {
    const send = service.send(b, "cancel before text"),
      failed = assert.rejects(send, /DELIVERY_UNCONFIRMED/);
    const localId = service.history(b)[0]?.localId;
    assert.ok(localId);
    assert.equal(service.cancel(b, localId), true);
    await failed;
    finish({
      namespace: DIRECT_NAMESPACE,
      version: 1,
      features: ["text-v1"],
      peerId: b,
    });
    await setImmediate();
    assert.deepEqual(requests, ["hello"]);
    assert.deepEqual(service.history(b)[0]?.failure, {
      reason: "canceled",
      stage: "connection",
    });
  } finally {
    service.close();
  }
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
