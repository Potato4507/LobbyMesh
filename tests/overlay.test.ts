import assert from "node:assert/strict";
import test from "node:test";
import {
  LocalOverlay,
  RoutingTable,
  xorDistance,
} from "../packages/app-dht/src/index.js";
import { createIdentity } from "../packages/identity/src/index.js";
import {
  MemoryDiscoveryBackend,
  PublicDiscovery,
} from "../packages/public-discovery/src/index.js";
import { signRecord } from "../packages/security/src/records.js";

const id = (n: number) => n.toString(16).padStart(64, "0");
test("routing XOR order, bucket cap, self rejection and copy isolation", () => {
  const table = new RoutingTable(id(0), 2);
  assert.equal(
    table.add({ id: id(0), publicKey: Buffer.alloc(32), connectionHints: [] }),
    false,
  );
  for (const n of [4, 5])
    assert.ok(
      table.add({
        id: id(n),
        publicKey: Buffer.alloc(32, n),
        connectionHints: [],
      }),
    );
  assert.equal(
    table.add({ id: id(6), publicKey: Buffer.alloc(32), connectionHints: [] }),
    false,
  );
  assert.deepEqual(
    table.nearest(id(5)).map((c) => c.id),
    [id(5), id(4)],
  );
  const first = table.nearest(id(5))[0];
  if (first) first.publicKey.fill(0);
  assert.equal(table.nearest(id(5))[0]?.publicKey[0], 5);
  assert.throws(() => xorDistance("invalid", id(0)));
  table.clear();
  assert.deepEqual(table.nearest(id(0)), []);
});
test("local overlay publishes entrypoint and enforces signatures/expiry; zero-node restart loses records", async () => {
  const identity = createIdentity(),
    network = new Map<string, Uint8Array>();
  let now = 100;
  const discovery = new PublicDiscovery(
    new MemoryDiscoveryBackend(network, Buffer.alloc(32, 1)),
    () => now,
  );
  const overlay = new LocalOverlay(identity.peerId, discovery, () => now);
  const key = id(1);
  assert.throws(() => overlay.get(key), /NOT_STARTED/);
  await overlay.start();
  assert.equal(network.size, 1);
  const record = signRecord(identity, key, "data", 0, now);
  overlay.put(key, record);
  assert.equal(overlay.get(key).length, 1);
  assert.throws(
    () => overlay.put(key, { ...record, seq: 1, content: "forged" }),
    /SIGNATURE/,
  );
  now += 60001;
  assert.deepEqual(overlay.get(key), []);
  await overlay.leave();
  assert.equal(network.size, 0);
  await overlay.start();
  assert.deepEqual(overlay.get(key), []);
  await overlay.leave();
});
