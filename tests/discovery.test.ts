import assert from "node:assert/strict";
import test from "node:test";
import {
  type DiscoveryBackend,
  type DiscoveryQuery,
  entrypoint,
  MemoryDiscoveryBackend,
  PublicDiscovery,
} from "../packages/public-discovery/src/index.js";

async function collect(source: AsyncIterable<unknown>) {
  const result = [];
  for await (const item of source) result.push(item);
  return result;
}
test("two discovery adapters announce, discover, rate limit, unannounce and restart", async () => {
  const network = new Map<string, Uint8Array>();
  let now = 0;
  const a = new PublicDiscovery(
    new MemoryDiscoveryBackend(network, Buffer.alloc(32, 1)),
    () => now,
  );
  const b = new PublicDiscovery(
    new MemoryDiscoveryBackend(network, Buffer.alloc(32, 2)),
    () => now,
  );
  await assert.rejects(collect(a.findAppEntrypoints()), /NOT_STARTED/);
  await a.start();
  await a.start();
  await b.start();
  await a.announceAppEntrypoint();
  await b.announceAppEntrypoint();
  assert.equal((await collect(a.findAppEntrypoints())).length, 2);
  await assert.rejects(collect(a.findAppEntrypoints()), /RATE_LIMIT/);
  await assert.rejects(a.announceAppEntrypoint(), /RATE_LIMIT/);
  await b.stop();
  now += 30001;
  assert.equal((await collect(a.findAppEntrypoints())).length, 1);
  await a.stop();
  assert.equal(network.size, 0);
  await a.start();
  await a.announceAppEntrypoint();
  await a.stop();
});
test("untrusted lookup results deduplicate and validate keys; query cleanup", async () => {
  let destroyed = false;
  const query: DiscoveryQuery = {
    destroy() {
      destroyed = true;
    },
    async *[Symbol.asyncIterator]() {
      yield null;
      yield {
        peers: [
          {},
          { publicKey: Buffer.alloc(2) },
          { publicKey: Buffer.alloc(32) },
          { publicKey: Buffer.alloc(32) },
        ],
      };
    },
  };
  const backend: DiscoveryBackend = {
    async listen() {},
    lookup() {
      return query;
    },
    announce() {
      return query;
    },
    async unannounce() {},
    async close() {},
  };
  const discovery = new PublicDiscovery(backend);
  await discovery.start();
  assert.equal((await collect(discovery.findAppEntrypoints())).length, 1);
  assert.ok(destroyed);
  assert.equal(entrypoint("bad"), null);
  await discovery.stop();
});
test("stalled query timeout closes backend iterator and surfaces failure", async () => {
  let release: (() => void) | undefined;
  let closed = false;
  const query: DiscoveryQuery = {
    destroy() {
      closed = true;
      release?.();
    },
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  };
  const backend: DiscoveryBackend = {
    async listen() {},
    lookup() {
      return query;
    },
    announce() {
      return query;
    },
    async unannounce() {},
    async close() {},
  };
  const discovery = new PublicDiscovery(backend, Date.now, 5);
  await discovery.start();
  await assert.rejects(
    collect(discovery.findAppEntrypoints()),
    /DISCOVERY_TIMEOUT/,
  );
  assert.ok(closed);
  await discovery.stop();
});
