import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  type ManagedNetwork,
  NetworkLifecycle,
} from "../packages/app-dht/src/lifecycle.js";
import { createOverlayRuntime } from "../packages/app-dht/src/runtime.js";

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function instance(
  options: { start?: () => Promise<void>; stop?: () => Promise<void> } = {},
): ManagedNetwork {
  return {
    start: options.start ?? (async () => {}),
    stop: options.stop ?? (async () => {}),
    status: () => undefined,
    peerCount: () => 2,
  };
}
test("network lifecycle starts only on opt-in, deduplicates, serializes rapid reconnect and handles sleep/resume", async () => {
  let created = 0,
    stopped = 0;
  const firstStop = deferred<void>();
  const lifecycle = new NetworkLifecycle(async () => {
    const number = ++created;
    return instance({
      stop: async () => {
        stopped++;
        if (number === 1) await firstStop.promise;
      },
    });
  });
  assert.equal(created, 0);
  assert.equal(lifecycle.status().state, "offline");
  lifecycle.setEnabled(true);
  lifecycle.setEnabled(true);
  await lifecycle.settled();
  assert.equal(created, 1);
  assert.equal(lifecycle.status().state, "online");
  assert.equal(lifecycle.status().peers, 2);
  lifecycle.setEnabled(false);
  assert.equal(lifecycle.status().state, "stopping");
  lifecycle.setEnabled(true);
  await setImmediate();
  assert.equal(created, 1);
  firstStop.resolve();
  await lifecycle.settled();
  assert.equal(created, 2);
  assert.equal(lifecycle.status().state, "online");
  lifecycle.suspend();
  await lifecycle.settled();
  assert.equal(lifecycle.status().state, "suspended");
  assert.equal(lifecycle.status().enabled, true);
  lifecycle.resume();
  await lifecycle.settled();
  assert.equal(created, 3);
  assert.equal(lifecycle.status().state, "online");
  await lifecycle.close();
  assert.equal(lifecycle.status().state, "offline");
  assert.equal(stopped, 3);
  lifecycle.resume();
  assert.equal(created, 3);
  assert.throws(() => lifecycle.setEnabled(true), /LIFECYCLE_CLOSED/);
});
test("factory resolving after cancellation is stopped without starting or resurrecting the network", async () => {
  const pending = deferred<ManagedNetwork>();
  let stopped = 0,
    started = 0;
  const lifecycle = new NetworkLifecycle(async () => pending.promise);
  lifecycle.setEnabled(true);
  await setImmediate();
  lifecycle.setEnabled(false);
  await lifecycle.settled();
  assert.equal(lifecycle.status().state, "offline");
  pending.resolve(
    instance({
      start: async () => {
        started++;
      },
      stop: async () => {
        stopped++;
      },
    }),
  );
  await setImmediate();
  await lifecycle.settled();
  assert.equal(started, 0);
  assert.equal(stopped, 1);
  assert.equal(lifecycle.status().state, "offline");
  await lifecycle.close();
});
test("stalled start is abortable and late completion cannot overwrite disconnected state", async () => {
  const start = deferred<void>();
  let stopped = 0;
  const lifecycle = new NetworkLifecycle(async () =>
    instance({
      start: () => start.promise,
      stop: async () => {
        stopped++;
      },
    }),
  );
  lifecycle.setEnabled(true);
  await setImmediate();
  lifecycle.setEnabled(false);
  await lifecycle.settled();
  assert.equal(stopped, 1);
  assert.equal(lifecycle.status().state, "offline");
  start.resolve();
  await setImmediate();
  assert.equal(lifecycle.status().state, "offline");
  await lifecycle.close();
});
test("failed startups back off with a finite retry budget; disabling cancels retry", async () => {
  let next: (() => void) | undefined,
    calls = 0;
  const waits: number[] = [];
  const lifecycle = new NetworkLifecycle(
    async () => {
      calls++;
      throw new Error("synthetic offline");
    },
    {
      now: () => 100,
      jitter: () => 0,
      schedule(run, ms) {
        next = run;
        waits.push(ms);
        return () => {
          next = undefined;
        };
      },
    },
  );
  lifecycle.setEnabled(true);
  await lifecycle.settled();
  assert.equal(lifecycle.status().state, "retrying");
  assert.equal(lifecycle.status().retryAt, 600);
  next?.();
  await lifecycle.settled();
  assert.equal(calls, 2);
  next?.();
  next = undefined;
  await lifecycle.settled();
  assert.equal(calls, 3);
  assert.equal(lifecycle.status().state, "error");
  assert.deepEqual(waits, [500, 1000]);
  lifecycle.setEnabled(true);
  await lifecycle.settled();
  assert.equal(lifecycle.status().state, "retrying");
  lifecycle.setEnabled(false);
  assert.equal(next, undefined);
  await lifecycle.close();
});
test("deadlines expose failed startup/cleanup rather than claiming stopped resources", async () => {
  const lifecycle = new NetworkLifecycle(
    async () =>
      instance({
        start: async () => new Promise(() => {}),
        stop: async () => new Promise(() => {}),
      }),
    { startupMs: 5, shutdownMs: 5, maxAttempts: 1 },
  );
  lifecycle.setEnabled(true);
  await lifecycle.settled();
  assert.equal(lifecycle.status().state, "error");
  assert.equal(lifecycle.status().error, "STOP_FAILED");
  await assert.rejects(lifecycle.close(), /NETWORK_CLEANUP_INCOMPLETE/);
});
test("suspended opt-in creates no resources until resume and opt-out remains off after wake", async () => {
  let created = 0;
  const lifecycle = new NetworkLifecycle(async () => {
    created++;
    return instance();
  });
  lifecycle.suspend();
  lifecycle.setEnabled(true);
  await lifecycle.settled();
  assert.equal(created, 0);
  assert.equal(lifecycle.status().state, "suspended");
  lifecycle.setEnabled(false);
  lifecycle.resume();
  await lifecycle.settled();
  assert.equal(created, 0);
  await lifecycle.close();
});

test("late factory cleanup failure stays visible and prevents another runtime until cleaned", async () => {
  const pending = deferred<ManagedNetwork>();
  let stops = 0,
    factories = 0;
  const lifecycle = new NetworkLifecycle(async () => {
    factories++;
    return pending.promise;
  });
  lifecycle.setEnabled(true);
  await setImmediate();
  lifecycle.setEnabled(false);
  await lifecycle.settled();
  pending.resolve(
    instance({
      stop: async () => {
        if (++stops === 1) throw new Error("cleanup failed");
      },
    }),
  );
  await setImmediate();
  await lifecycle.settled();
  assert.equal(lifecycle.status().error, "STOP_FAILED");
  assert.equal(factories, 1);
  lifecycle.setEnabled(false);
  await lifecycle.settled();
  assert.equal(stops, 2);
  assert.equal(lifecycle.status().state, "offline");
  await lifecycle.close();
});

test(
  "real native runtime cancels unreachable local bootstrap and closes instead of waiting indefinitely",
  { timeout: 10_000 },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lobbymesh-cancel-")),
      allocated = deferred<void>();
    const lifecycle = new NetworkLifecycle(async (signal) => {
      const runtime = await createOverlayRuntime(directory, {
        signal,
        bootstrap: ["127.0.0.1:9"],
      });
      allocated.resolve();
      return {
        ...runtime,
        peerCount: () => runtime.overlay.authenticatedContacts().length,
      };
    });
    try {
      lifecycle.setEnabled(true);
      await allocated.promise;
      await setImmediate();
      lifecycle.setEnabled(false);
      await lifecycle.settled();
      assert.equal(lifecycle.status().state, "offline");
      assert.equal(lifecycle.status().error, null);
    } finally {
      await lifecycle.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
test("credential failures stay explicit without retries; manual retry recovers", async () => {
  let attempts = 0,
    scheduled = 0;
  const lifecycle = new NetworkLifecycle(
    async () => {
      if (++attempts === 1) throw new Error("CREDENTIALS_UNAVAILABLE");
      return instance();
    },
    {
      schedule: () => {
        scheduled++;
        return () => {};
      },
    },
  );
  try {
    lifecycle.setEnabled(true);
    await lifecycle.settled();
    assert.equal(lifecycle.status().state, "error");
    assert.equal(lifecycle.status().error, "CREDENTIALS_UNAVAILABLE");
    assert.equal(lifecycle.status().enabled, true);
    assert.equal(lifecycle.status().retryAt, null);
    assert.equal(scheduled, 0);
    assert.equal(attempts, 1);
    lifecycle.setEnabled(true);
    await lifecycle.settled();
    assert.equal(lifecycle.status().state, "online");
    assert.equal(lifecycle.status().error, null);
    assert.equal(attempts, 2);
  } finally {
    await lifecycle.close();
  }
});
