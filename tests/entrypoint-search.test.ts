import assert from "node:assert/strict";
import test from "node:test";
import {
  type SearchState,
  searchEntrypoints,
} from "../packages/entrypoint-search/src/index.js";
import { entrypoint } from "../packages/public-discovery/src/index.js";

async function* contacts() {
  for (let i = 0; i < 8; i++) {
    const peer = entrypoint(Buffer.alloc(32, i));
    if (peer) yield peer;
  }
}
test("entrypoint search rejects hostile/incompatible/stale peers; bounded parallelism", async () => {
  let active = 0,
    max = 0;
  const states: SearchState[] = [];
  const found = await searchEntrypoints(
    contacts(),
    async (contact) => {
      active++;
      max = Math.max(active, max);
      await Promise.resolve();
      active--;
      const n = contact.publicKey[0];
      if (n === 0) throw new Error("unreachable");
      return { version: n === 1 ? 2 : 1, authenticated: n !== 2 };
    },
    (state) => states.push(state),
  );
  assert.equal(found.length, 5);
  assert.ok(max <= 4);
  assert.deepEqual(states, ["discovering", "candidates-found"]);
});
test("stalled discovery and probes time out without claiming empty network", async () => {
  const states: SearchState[] = [];
  const result = await searchEntrypoints(
    contacts(),
    async () => new Promise(() => {}),
    (state) => states.push(state),
    { timeoutMs: 10 },
  );
  assert.deepEqual(result, []);
  assert.deepEqual(states, [
    "discovering",
    "retrying",
    "no-reachable-candidate",
  ]);
});
test("intermittent discovery errors and empty network are distinct", async () => {
  function failed() {
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<never>> {
            throw new Error("public DHT unavailable");
          },
        };
      },
    };
  }
  const states: SearchState[] = [];
  await searchEntrypoints(
    failed(),
    async () => ({ version: 1, authenticated: true }),
    (s) => states.push(s),
  );
  assert.ok(states.includes("retrying"));
  const empty: SearchState[] = [];
  await searchEntrypoints(
    (async function* () {})(),
    async () => ({ version: 1, authenticated: true }),
    (s) => empty.push(s),
  );
  assert.deepEqual(empty, ["discovering", "no-reachable-candidate"]);
});

test("the search-owned signal closes a pending discovery query on deadline without opening a pre-canceled source", async () => {
  let supplied: AbortSignal | undefined,
    closed = false,
    factories = 0;
  const source = (signal: AbortSignal) => {
    supplied = signal;
    factories++;
    return {
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              closed = true;
              resolve();
            },
            { once: true },
          ),
        );
      },
    };
  };
  assert.deepEqual(
    await searchEntrypoints(
      source,
      async () => ({ version: 1, authenticated: true }),
      () => {},
      { timeoutMs: 5 },
    ),
    [],
  );
  assert.equal(supplied?.aborted, true);
  assert.equal(closed, true);
  const owner = new AbortController();
  owner.abort();
  assert.deepEqual(
    await searchEntrypoints(
      source,
      async () => ({ version: 1, authenticated: true }),
      () => {},
      { signal: owner.signal },
    ),
    [],
  );
  assert.equal(factories, 1);
});
