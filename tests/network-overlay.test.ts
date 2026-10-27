import assert from "node:assert/strict";
import test from "node:test";
import { NetworkOverlay } from "../packages/app-dht/src/network.js";
import { createIdentity } from "../packages/identity/src/index.js";
import { signRecord } from "../packages/security/src/records.js";

const connector = {
  connect(): never {
    throw new Error("NO_NETWORK");
  },
};
test("network overlay validates dispatch, records and pagination; replicated exact duplicates are idempotent", async () => {
  let now = 100;
  const identity = createIdentity(),
    remote = createIdentity();
  const overlay = new NetworkOverlay(identity, connector, { now: () => now });
  const peer = {
    id: remote.peerId,
    publicKey: remote.publicKey,
    transportKey: "12".repeat(32),
  };
  const signal = new AbortController().signal,
    key = "ab".repeat(32);
  await assert.rejects(overlay.get(key), /NOT_STARTED/);
  await overlay.start();
  for (const value of [
    null,
    {},
    { op: "unknown" },
    { op: "put", key: "bad" },
    { op: "find-node", target: "bad" },
    { op: "find-value", key, cursor: -1 },
  ])
    await assert.rejects(overlay.handle(peer, value, signal));
  for (let index = 0; index < 3; index++) {
    const record = signRecord(createIdentity(), key, "fixture", 0, now);
    assert.deepEqual(
      await overlay.handle(peer, { op: "put", key, record }, signal),
      { stored: true },
    );
    assert.deepEqual(
      await overlay.handle(peer, { op: "put", key, record }, signal),
      { stored: true },
    );
    await assert.rejects(
      overlay.handle(
        peer,
        { op: "put", key, record: { ...record, content: "forged" } },
        signal,
      ),
      /SIGNATURE/,
    );
  }
  const page = (await overlay.handle(
    peer,
    { op: "find-value", key },
    signal,
  )) as { records: unknown[]; next: number };
  assert.equal(page.records.length, 2);
  assert.equal(page.next, 2);
  const rest = (await overlay.handle(
    peer,
    { op: "find-value", key, cursor: page.next },
    signal,
  )) as { records: unknown[]; next: null };
  assert.equal(rest.records.length, 1);
  assert.equal(rest.next, null);
  assert.equal((await overlay.get(key)).length, 3);
  now += 60_001;
  assert.deepEqual(await overlay.get(key), []);
  await overlay.leave();
  assert.deepEqual(overlay.authenticatedContacts(), []);
  await assert.rejects(overlay.start(), /OVERLAY_CLOSED/);
});
test("blocked callers and record authors never enter store or routing", async () => {
  const identity = createIdentity(),
    blocked = createIdentity(),
    allowed = createIdentity();
  const overlay = new NetworkOverlay(identity, connector, {
    blocked: (id) => id === blocked.peerId,
  });
  await overlay.start();
  const peer = {
      id: blocked.peerId,
      publicKey: blocked.publicKey,
      transportKey: "12".repeat(32),
    },
    key = "ab".repeat(32),
    signal = new AbortController().signal;
  await assert.rejects(
    overlay.handle(peer, { op: "find-node", target: key }, signal),
    /BLOCKED_PEER/,
  );
  await assert.rejects(
    overlay.handle(
      { ...peer, id: allowed.peerId, publicKey: allowed.publicKey },
      {
        op: "put",
        key,
        record: signRecord(blocked, key, "blocked", 0, Date.now()),
      },
      signal,
    ),
    /BLOCKED_AUTHOR/,
  );
  assert.deepEqual(overlay.authenticatedContacts(), []);
  assert.deepEqual(await overlay.get(key), []);
  await overlay.leave();
});
