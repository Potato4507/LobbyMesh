import assert from "node:assert/strict";
import test from "node:test";
import { NetworkOverlay } from "../packages/app-dht/src/network.js";
import { serveRpc } from "../packages/app-dht/src/rpc.js";
import { createIdentity } from "../packages/identity/src/index.js";
import { RecordStore, signRecord } from "../packages/security/src/records.js";
import { pair } from "./fixtures/noise-pair.js";

test("bounded store scans page without mutation and omit expired records", () => {
  let now = 100;
  const store = new RecordStore(() => now),
    identity = createIdentity(),
    key = "ab".repeat(32);
  for (let n = 0; n < 17; n++)
    store.put(
      n.toString(16).padStart(64, "0"),
      signRecord(identity, n.toString(16).padStart(64, "0"), "fixture", 0, now),
    );
  const page = store.scan();
  assert.equal(page.records.length, 16);
  assert.equal(page.next, 16);
  assert.equal(store.scan(16).records.length, 1);
  const record = page.records[0];
  if (record) record.content = "mutated";
  assert.equal(store.scan().records[0]?.content, "fixture");
  assert.throws(() => store.scan(-1), /INVALID_SCAN/);
  assert.throws(() => store.scan(0, 100), /INVALID_SCAN/);
  now += 60_001;
  assert.deepEqual(store.scan(), { records: [], next: null });
  store.put(key, signRecord(identity, key, "new", 0, now));
  assert.equal(store.scan().records.length, 1);
});
test("synthetic partition merge reconciles existing signed records without extending TTL", async (t) => {
  const nodes = new Map<
    string,
    { overlay: NetworkOverlay; identity: ReturnType<typeof createIdentity> }
  >();
  const serving = new Set<Promise<void>>();
  let now = 100,
    partitioned = true;
  function node(n: number) {
    const key = n.toString(16).padStart(64, "0"),
      identity = createIdentity();
    const overlay = new NetworkOverlay(
      identity,
      {
        connect(remoteKey) {
          const remoteAddress = Buffer.from(remoteKey).toString("hex");
          if (
            partitioned &&
            (n === 3 || remoteAddress === "3".padStart(64, "0"))
          )
            throw new Error("partition");
          const remote = nodes.get(remoteAddress);
          if (!remote) throw new Error("unreachable");
          const [client, server] = pair();
          Object.assign(client, {
            publicKey: Buffer.from(key, "hex"),
            remotePublicKey: Buffer.from(remoteAddress, "hex"),
          });
          Object.assign(server, {
            publicKey: Buffer.from(remoteAddress, "hex"),
            remotePublicKey: Buffer.from(key, "hex"),
          });
          const task = serveRpc(
            server,
            remote.identity,
            remote.overlay.handle,
          ).catch(() => {});
          serving.add(task);
          void task.finally(() => serving.delete(task));
          return client;
        },
      },
      { now: () => now },
    );
    const value = { overlay, identity, key };
    nodes.set(key, value);
    return value;
  }
  const a = node(1),
    b = node(2),
    c = node(3),
    signal = new AbortController().signal;
  t.after(async () => {
    for (const peer of nodes.values()) await peer.overlay.leave();
    await Promise.all(serving);
  });
  for (const peer of nodes.values()) await peer.overlay.start();
  await b.overlay.join(Buffer.from(a.key, "hex"));
  const key = "ab".repeat(32),
    record = signRecord(a.identity, key, "before merge", 0, now);
  assert.deepEqual(await a.overlay.put(key, record), {
    replicas: 1,
    failures: 0,
  });
  assert.deepEqual((await c.overlay.lookup(key)).records, []);
  partitioned = false;
  await c.overlay.join(Buffer.from(b.key, "hex"));
  const sync = await a.overlay.synchronize(signal);
  assert.equal(sync.state, "complete");
  assert.equal(sync.replicas, 2);
  // Remove all routing: verify C actually stored the repair, rather than reading A on demand.
  c.overlay.routing.clear();
  const repaired = await c.overlay.get(key);
  assert.equal(repaired[0]?.signature, record.signature);
  assert.equal(repaired[0]?.expiresAt, record.expiresAt);
  now = record.expiresAt + 1;
  assert.deepEqual((await c.overlay.lookup(key)).records, []);
  assert.equal((await a.overlay.synchronize(signal)).records, 0);
});
