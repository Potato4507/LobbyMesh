import assert from "node:assert/strict";
import test from "node:test";
import {
  iterativeLookup,
  parseReferrals,
  type Referral,
} from "../packages/app-dht/src/lookup.js";

const id = (n: number) => n.toString(16).padStart(64, "0");
const contact = (n: number): Referral => ({
  id: id(n),
  transportKey: id(n + 1000),
});
test("iterative lookup follows multi-hop referrals, deduplicates cycles and caps concurrency", async () => {
  let active = 0,
    maximum = 0;
  const graph = new Map([
    [1, [2, 3]],
    [2, [3, 4]],
    [3, [1, 5]],
    [4, [6]],
    [5, [6]],
    [6, []],
  ]);
  const result = await iterativeLookup(
    id(6),
    id(0),
    [contact(1)],
    async (peer) => {
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active--;
      return (graph.get(Number.parseInt(peer.id, 16)) ?? []).map(contact);
    },
  );
  assert.equal(result.state, "exhausted");
  assert.equal(result.queried, 6);
  assert.equal(result.failures, 0);
  assert.ok(maximum > 1 && maximum <= 3);
  assert.ok(result.authenticated.some((p) => p.id === id(6)));
});
test("malformed referrals, dead nodes, query/candidate budgets and stalled transports stay bounded", async () => {
  assert.throws(
    () => parseReferrals([{ id: id(1), transportKey: Array(64).fill("a") }]),
    /INVALID_CONTACT/,
  );
  await assert.rejects(
    iterativeLookup(id(5), id(0), [contact(1)], async () => [], { alpha: 0 }),
    /INVALID_LOOKUP_LIMIT/,
  );
  const dead = await iterativeLookup(id(5), id(0), [contact(1)], async () => {
    throw new Error("offline");
  });
  assert.equal(dead.failures, 1);
  assert.equal(dead.queried, 1);
  const budget = await iterativeLookup(
    id(100),
    id(0),
    [contact(1)],
    async (peer) => [contact(Number.parseInt(peer.id, 16) + 1)],
    { maxQueries: 4 },
  );
  assert.equal(budget.state, "budget");
  assert.equal(budget.queried, 4);
  const clipped = await iterativeLookup(
    id(100),
    id(0),
    [contact(1)],
    async () => [2, 3, 4].map(contact),
    { maxCandidates: 2 },
  );
  assert.equal(clipped.state, "budget");
  assert.ok(clipped.queried <= 3);
  let cancelled = false;
  const stalled = await iterativeLookup(
    id(5),
    id(0),
    [contact(1)],
    async (_peer, signal) => {
      signal.addEventListener("abort", () => {
        cancelled = true;
      });
      return new Promise(() => {});
    },
    { timeoutMs: 15 },
  );
  assert.equal(stalled.state, "timeout");
  assert.ok(cancelled);
  const controller = new AbortController();
  controller.abort();
  const aborted = await iterativeLookup(
    id(5),
    id(0),
    [contact(1)],
    async () => assert.fail("aborted lookup queried peer"),
    { signal: controller.signal },
  );
  assert.equal(aborted.state, "aborted");
  assert.equal(aborted.queried, 0);
});
test("deterministic graph fixtures at 1/2/10/100/500 members bound queries under churn", async (t) => {
  for (const size of [1, 2, 10, 100, 500]) {
    let calls = 0;
    const result = await iterativeLookup(
      id(size),
      id(0),
      size === 1 ? [] : [contact(1)],
      async (peer) => {
        calls++;
        const n = Number.parseInt(peer.id, 16);
        if (n % 11 === 0) throw new Error("simulated churn");
        return [n + 1, n + 2, n * 2]
          .filter((v) => v < size && v !== n)
          .map(contact);
      },
    );
    assert.ok(calls <= 32);
    assert.equal(result.queried, calls);
    assert.ok(result.authenticated.length <= 32);
    t.diagnostic(
      `synthetic members=${size} queries=${calls} state=${result.state} failed=${result.failures}`,
    );
  }
});
