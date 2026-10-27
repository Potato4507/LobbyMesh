import assert from "node:assert/strict";
import test from "node:test";
import { OverlayMaintenance } from "../packages/app-dht/src/maintenance.js";
import type { BootstrapDiscovery } from "../packages/protocol/src/index.js";

test("maintenance automatically authenticates candidates, refreshes and republishes without overlapping cycles", async () => {
  let now = 0,
    announced = 0,
    probed = 0,
    refreshed = 0;
  let scheduled: (() => void) | undefined;
  const discovery: BootstrapDiscovery = {
    async start() {},
    async stop() {},
    async announceAppEntrypoint() {
      announced++;
    },
    async *findAppEntrypoints() {
      yield {
        id: "transport:hint",
        publicKey: Buffer.alloc(32, 1),
        connectionHints: [],
      };
    },
  };
  const maintenance = new OverlayMaintenance(
    discovery,
    {
      async probe(_contact, signal) {
        assert.equal(signal.aborted, false);
        probed++;
        return { version: 1, authenticated: true };
      },
      async refresh() {
        refreshed++;
        return {
          state: "exhausted",
          queried: 1,
          failures: 0,
          authenticated: [],
        };
      },
    },
    {
      now: () => now,
      schedule(run, ms) {
        assert.equal(ms, 30_000);
        scheduled = run;
        return () => {
          scheduled = undefined;
        };
      },
    },
  );
  const [first, duplicate] = await Promise.all([
    maintenance.start(),
    maintenance.start(),
  ]);
  assert.deepEqual(first, duplicate);
  assert.equal(probed, 1);
  assert.equal(refreshed, 1);
  assert.equal(announced, 0);
  assert.equal(first.authenticatedCandidates, 1);
  await maintenance.start();
  assert.equal(probed, 1);
  now = 30_000;
  const run = scheduled;
  assert.ok(run);
  run();
  await maintenance.start();
  assert.equal(probed, 2);
  assert.equal(announced, 1);
  assert.equal(maintenance.status()?.announcement, "republished");
  const snapshot = maintenance.status();
  if (snapshot) snapshot.at = 999;
  assert.equal(maintenance.status()?.at, now);
  await maintenance.stop();
  assert.equal(scheduled, undefined);
  await assert.rejects(maintenance.start(), /MAINTENANCE_CLOSED/);
});
test("shutdown cancels stalled discovery promptly and failure reports remain explicit", async () => {
  let returned = false;
  const discovery: BootstrapDiscovery = {
    async start() {},
    async stop() {},
    async announceAppEntrypoint() {
      throw new Error("unavailable");
    },
    findAppEntrypoints() {
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<never>> {
              return new Promise(() => {});
            },
            async return(): Promise<IteratorResult<never>> {
              returned = true;
              return { done: true, value: undefined };
            },
          };
        },
      };
    },
  };
  const maintenance = new OverlayMaintenance(
    discovery,
    {
      async probe() {
        assert.fail("stalled discovery must not probe");
      },
      async refresh() {
        assert.fail("stopped maintenance must not refresh");
      },
    },
    { searchTimeoutMs: 60_000 },
  );
  const started = maintenance.start();
  await maintenance.stop();
  await started;
  assert.ok(returned);
  assert.equal(maintenance.status()?.routing, "failed");
  assert.throws(
    () =>
      new OverlayMaintenance(
        discovery,
        {
          async probe() {
            throw new Error();
          },
          async refresh() {
            throw new Error();
          },
        },
        { intervalMs: 100 },
      ),
    /INVALID_MAINTENANCE_LIMITS/,
  );
});
