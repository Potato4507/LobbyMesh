import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { NetworkOverlay } from "../packages/app-dht/src/network.js";
import { serveRpc } from "../packages/app-dht/src/rpc.js";
import { createIdentity } from "../packages/identity/src/index.js";
import { signRecord } from "../packages/security/src/records.js";
import { pair } from "./fixtures/noise-pair.js";

const connector = {
  connect(): never {
    throw new Error("NO_NETWORK");
  },
};
test(
  "queued routing probes cancel without waiting for an unrelated stalled transaction",
  { timeout: 1000 },
  async () => {
    const identity = createIdentity(),
      remote = createIdentity();
    const held = new AbortController(),
      sweep = new AbortController();
    let connections = 0;
    const servers: ReturnType<typeof pair>[1][] = [];
    const overlay = new NetworkOverlay(
      identity,
      {
        connect() {
          connections++;
          const [client, server] = pair();
          servers.push(server);
          return client;
        },
      },
      { timeoutMs: 2000 },
    );
    await overlay.start();
    const contact = { id: remote.peerId, transportKey: "12".repeat(32) };
    overlay.routing.add({
      id: contact.id,
      publicKey: Buffer.from(contact.transportKey, "hex"),
      connectionHints: [],
    });
    const first = overlay
      .directRequest(contact, {}, held.signal)
      .catch(() => {});
    try {
      await setImmediate();
      const probing = overlay.maintainRouting(sweep.signal);
      await setImmediate();
      sweep.abort();
      assert.equal((await probing).state, "aborted");
      assert.equal(connections, 1);
      assert.equal(overlay.routing.has(contact.id), true);
    } finally {
      held.abort();
      await first;
      await overlay.leave();
      for (const server of servers) server.destroy();
    }
  },
);
test("routing maintenance evicts only after two failures, promotes authenticated replacements and preserves canceled probes", async () => {
  const identity = createIdentity();
  const overlay = new NetworkOverlay(identity, connector);
  await overlay.start();
  const signal = new AbortController().signal;
  const contacts = Array.from({ length: 22 }, (_, index) => ({
    // All fixture IDs fall in the most distant bucket; the handler receives
    // synthetic already-authenticated metadata, not cryptographic identity proof.
    id: (BigInt(`0x${identity.peerId}`) ^ ((1n << 255n) + BigInt(index)))
      .toString(16)
      .padStart(64, "0"),
    publicKey: identity.publicKey,
    transportKey: Buffer.alloc(32, index + 1).toString("hex"),
  }));
  try {
    for (const peer of contacts)
      await overlay.handle(
        peer,
        { op: "find-node", target: identity.peerId },
        signal,
      );
    assert.equal(overlay.routing.nearest(identity.peerId, 100).length, 20);
    const first = contacts[0],
      newest = contacts[21],
      previous = contacts[20];
    assert.ok(first && newest && previous);
    const canceled = new AbortController();
    canceled.abort();
    assert.equal(
      (await overlay.maintainRouting(canceled.signal)).state,
      "aborted",
    );
    assert.equal(overlay.routing.has(first.id), true);
    assert.deepEqual(await overlay.maintainRouting(signal), {
      checked: 4,
      failed: 4,
      state: "complete",
    });
    assert.equal(overlay.routing.has(first.id), true);
    await overlay.maintainRouting(signal);
    for (const peer of contacts.slice(0, 4))
      assert.equal(overlay.routing.has(peer.id), false);
    assert.equal(overlay.routing.has(newest.id), true);
    assert.equal(overlay.routing.has(previous.id), true);
    assert.equal(overlay.routing.nearest(identity.peerId, 100).length, 18);
  } finally {
    await overlay.leave();
  }
});

test("successful authenticated liveness rotates across contacts beyond the first four", async () => {
  const identity = createIdentity(),
    remotes = Array.from({ length: 6 }, () => createIdentity());
  let calls = 0;
  const overlay = new NetworkOverlay(identity, {
    connect(key) {
      const remote = remotes[(Buffer.from(key)[0] ?? 0) - 1];
      assert.ok(remote);
      const [client, server] = pair();
      Object.assign(client, { remotePublicKey: Buffer.from(key) });
      Object.assign(server, { publicKey: Buffer.from(key) });
      calls++;
      void serveRpc(server, remote, async () => ({ contacts: [] })).catch(
        () => {},
      );
      return client;
    },
  });
  await overlay.start();
  try {
    remotes.forEach((remote, index) => {
      overlay.routing.add({
        id: remote.peerId,
        publicKey: Buffer.alloc(32, index + 1),
        connectionHints: [],
      });
    });
    const before = overlay.routing.oldest(6).map((c) => c.id);
    const signal = new AbortController().signal;
    assert.deepEqual(await overlay.maintainRouting(signal), {
      checked: 4,
      failed: 0,
      state: "complete",
    });
    assert.deepEqual(
      overlay.routing.oldest(2).map((c) => c.id),
      before.slice(4),
    );
    await overlay.maintainRouting(signal);
    assert.equal(calls, 8);
    assert.equal(overlay.authenticatedContacts().length, 6);
  } finally {
    await overlay.leave();
  }
});

test("fresh authenticated inbound activity wins over an older in-flight liveness failure", async () => {
  const identity = createIdentity(),
    remote = createIdentity();
  const peer = {
    id: remote.peerId,
    publicKey: remote.publicKey,
    transportKey: "12".repeat(32),
  };
  const signal = new AbortController().signal;
  let calls = 0;
  const overlay = new NetworkOverlay(identity, {
    connect() {
      if (++calls !== 2) throw new Error("NO_NETWORK");
      const [client, server] = pair();
      queueMicrotask(() => {
        void overlay.handle(
          peer,
          { op: "find-node", target: identity.peerId },
          signal,
        );
        server.destroy();
      });
      return client;
    },
  });
  await overlay.start();
  try {
    await overlay.handle(
      peer,
      { op: "find-node", target: identity.peerId },
      signal,
    );
    await overlay.maintainRouting(signal);
    await overlay.maintainRouting(signal);
    assert.equal(overlay.routing.has(peer.id), true);
    await overlay.maintainRouting(signal);
    assert.equal(overlay.routing.has(peer.id), true);
    await overlay.maintainRouting(signal);
    assert.equal(overlay.routing.has(peer.id), false);
  } finally {
    await overlay.leave();
  }
});
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
  await assert.rejects(overlay.get(key), /LOOKUP_INCOMPLETE/);
  assert.deepEqual((await overlay.lookup(key)).records, []);
  assert.deepEqual(overlay.authenticatedContacts(), []);
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
