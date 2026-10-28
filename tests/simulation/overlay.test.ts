import assert from "node:assert/strict";
import test from "node:test";
import { simulateOverlay } from "../fixtures/overlay-simulation.js";

test("seeded production-overlay fixture restores record availability after partition and abrupt churn", async () => {
  const result = await simulateOverlay(10);
  assert.equal(result.convergedInFixture, true);
  assert.equal(result.abruptlyUnreachable, 2);
  assert.equal(result.rounds.at(-1)?.available, 8);
  assert.ok(result.dispatched > 0 && result.framedBytes > 0);
  assert.ok(result.routing.maxActive <= 9);
  assert.ok(result.attempts < 1000);
  assert.equal(result.publicDht, false);
  assert.equal(result.cleanup.routingEntriesAfterClose, 0);
});
