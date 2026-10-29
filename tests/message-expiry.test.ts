import assert from "node:assert/strict";
import test from "node:test";
import { DesktopMessaging } from "../apps/desktop/src/messaging.js";
import {
  DIRECT_NAMESPACE,
  DirectMessenger,
  type TextEnvelope,
} from "../packages/protocol/src/direct.js";
import { ExpiryTimer } from "../packages/protocol/src/expiry.js";

const a = "a".repeat(64),
  b = "b".repeat(64),
  key = "c".repeat(64);
const peer = { id: b, publicKey: "synthetic", transportKey: key };
const envelope = (at = 1000): TextEnvelope => ({
  namespace: DIRECT_NAMESPACE,
  version: 1,
  type: "text",
  id: "12".repeat(16),
  from: b,
  to: a,
  senderEpoch: "34".repeat(16),
  seq: 1,
  createdAt: at,
  text: "idle plaintext",
});
test("one expiry timer keeps the earlier entry, can replace its deadline and never rearms after close", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const expiry = new ExpiryTimer(() => {
    calls++;
  });
  expiry.include(100, 0);
  expiry.include(200, 0);
  t.mock.timers.tick(99);
  assert.equal(calls, 0);
  t.mock.timers.tick(1);
  assert.equal(calls, 1);
  expiry.schedule(300, 100);
  expiry.schedule(400, 100);
  t.mock.timers.tick(200);
  assert.equal(calls, 1);
  t.mock.timers.tick(100);
  assert.equal(calls, 2);
  expiry.include(500, 400);
  expiry.close();
  expiry.include(401, 400);
  t.mock.timers.tick(1000);
  assert.equal(calls, 2);
});
test("direct content and replay metadata expire while idle without history reads or new traffic", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 1000;
  const direct = new DirectMessenger(a, async () => null, {
    authorized: () => true,
    now: () => now,
  });
  t.after(() => direct.close());
  await direct.handle(peer, envelope(), new AbortController().signal);
  const inboxes = (
    direct as unknown as {
      inboxes: Map<string, { history: unknown[]; seen: Map<string, unknown> }>;
    }
  ).inboxes;
  now += 120001;
  t.mock.timers.tick(120001);
  assert.equal(inboxes.get(b)?.seen.size, 0);
  assert.equal(inboxes.get(b)?.history.length, 1);
  now += 779999;
  t.mock.timers.tick(779999);
  assert.equal(inboxes.size, 0);
});
test("desktop outgoing and incoming content and reply hints expire without renderer reads", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 1000;
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
    { authorized: () => true, blocked: () => false, allowed: () => [b] },
    () => [{ id: b, transportKey: key }],
    () => now,
  );
  t.after(() => service.close());
  await service.send(b, "idle outgoing");
  await service.handle(peer, envelope(), new AbortController().signal);
  const retained = service as unknown as {
    conversations: Map<string, unknown[]>;
    incomingContacts: Map<string, unknown>;
    messenger: { inboxes: Map<string, unknown> };
  };
  assert.equal(retained.conversations.get(b)?.length, 2);
  now += 120000;
  t.mock.timers.tick(120000);
  assert.equal(retained.incomingContacts.size, 0);
  assert.equal(retained.conversations.get(b)?.length, 2);
  now += 780000;
  t.mock.timers.tick(780000);
  assert.equal(retained.conversations.size, 0);
  assert.equal(retained.messenger.inboxes.size, 0);
});
test("a completed inbound handler cannot repopulate reply hints after close", async () => {
  const service = new DesktopMessaging(
    a,
    async () => null,
    { authorized: () => true, blocked: () => false, allowed: () => [b] },
    () => [],
  );
  const handled = service.handle(
    peer,
    { namespace: DIRECT_NAMESPACE, version: 1, type: "ping" },
    new AbortController().signal,
  );
  service.close();
  await handled;
  assert.equal(
    (service as unknown as { incomingContacts: Map<string, unknown> })
      .incomingContacts.size,
    0,
  );
});
