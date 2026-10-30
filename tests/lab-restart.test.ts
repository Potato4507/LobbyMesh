import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  type ManagedNetwork,
  NetworkLifecycle,
} from "../packages/app-dht/src/lifecycle.js";
import { restartLabNetwork } from "../scripts/lab/restart.js";

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
function runtime(
  start = async () => {},
  stop = async () => {},
): ManagedNetwork {
  return { start, stop, status: () => undefined, peerCount: () => 0 };
}
const limits = { startupMs: 1000, shutdownMs: 1000, maxAttempts: 1 };

test("stop while old cleanup is held cannot request a replacement instance", async () => {
  const entered = deferred(),
    cleanup = deferred();
  let created = 0,
    stops = 0,
    allowed = true;
  const lifecycle = new NetworkLifecycle(async () => {
    created++;
    return runtime(undefined, async () => {
      stops++;
      entered.resolve();
      await cleanup.promise;
    });
  }, limits);
  const grants: boolean[] = [];
  const owner = {
    setEnabled: (value: boolean) => {
      grants.push(value);
      return lifecycle.setEnabled(value);
    },
    settled: () => lifecycle.settled(),
    status: () => lifecycle.status(),
  };
  try {
    lifecycle.setEnabled(true);
    await lifecycle.settled();
    const pending = assert.rejects(
      restartLabNetwork(owner, () => allowed),
      /^Error: LAB_NETWORK_UNAVAILABLE$/,
    );
    await entered.promise;
    allowed = false;
    const closing = lifecycle.close();
    cleanup.resolve();
    await Promise.all([pending, closing]);
    assert.deepEqual(grants, [false]);
    assert.equal(created, 1);
    assert.equal(stops, 1);
    assert.equal(lifecycle.status().state, "offline");
  } finally {
    cleanup.resolve();
    await lifecycle.close();
  }
});

test("stop during replacement startup rejects its completion and late startup cannot resurrect it", async () => {
  const entered = deferred(),
    startup = deferred();
  let created = 0,
    stops = 0,
    allowed = true;
  const lifecycle = new NetworkLifecycle(async () => {
    const n = ++created;
    return runtime(
      async () => {
        if (n === 2) {
          entered.resolve();
          await startup.promise;
        }
      },
      async () => {
        stops++;
      },
    );
  }, limits);
  try {
    lifecycle.setEnabled(true);
    await lifecycle.settled();
    const pending = assert.rejects(
      restartLabNetwork(lifecycle, () => allowed),
      /^Error: LAB_NETWORK_UNAVAILABLE$/,
    );
    await entered.promise;
    allowed = false;
    await lifecycle.close();
    await pending;
    startup.resolve();
    await setImmediate();
    assert.equal(created, 2);
    assert.equal(stops, 2);
    assert.equal(lifecycle.status().state, "offline");
    assert.throws(() => lifecycle.using(() => true), /NETWORK_NOT_READY/);
  } finally {
    startup.resolve();
    await lifecycle.close();
  }
});

test("failed old cleanup blocks replacement and only an explicit retry can recover", async () => {
  let created = 0,
    stops = 0;
  const lifecycle = new NetworkLifecycle(async () => {
    created++;
    return runtime(undefined, async () => {
      if (++stops === 1) throw new Error("private cleanup detail");
    });
  }, limits);
  try {
    lifecycle.setEnabled(true);
    await lifecycle.settled();
    await assert.rejects(
      restartLabNetwork(lifecycle, () => true),
      /^Error: LAB_NETWORK_UNAVAILABLE$/,
    );
    assert.equal(lifecycle.status().error, "STOP_FAILED");
    assert.equal(created, 1);
    await restartLabNetwork(lifecycle, () => true);
    assert.equal(lifecycle.status().state, "online");
    assert.equal(created, 2);
    assert.equal(stops, 2);
  } finally {
    await lifecycle.close();
  }
});

test("failed replacement startup cannot return success or schedule an implicit retry", async () => {
  let created = 0,
    scheduled = 0;
  const lifecycle = new NetworkLifecycle(
    async () => {
      const n = ++created;
      return runtime(async () => {
        if (n === 2) throw new Error("private startup detail");
      });
    },
    {
      ...limits,
      schedule: () => {
        scheduled++;
        return () => {};
      },
    },
  );
  try {
    lifecycle.setEnabled(true);
    await lifecycle.settled();
    await assert.rejects(
      restartLabNetwork(lifecycle, () => true),
      /^Error: LAB_NETWORK_UNAVAILABLE$/,
    );
    assert.equal(lifecycle.status().error, "START_FAILED");
    assert.equal(created, 2);
    assert.equal(scheduled, 0);
    await restartLabNetwork(lifecycle, () => true);
    assert.equal(created, 3);
    assert.equal(lifecycle.status().state, "online");
  } finally {
    await lifecycle.close();
  }
});

test("an already closed or throwing owner performs no lifecycle operations and exposes no raw error", async () => {
  let operations = 0;
  const lifecycle = new NetworkLifecycle(async () => runtime(), limits);
  const owner = {
    setEnabled: (enabled: boolean) => {
      operations++;
      return lifecycle.setEnabled(enabled);
    },
    settled: () => lifecycle.settled(),
    status: () => lifecycle.status(),
  };
  try {
    for (const permitted of [
      () => false,
      () => {
        throw new Error("private owner detail");
      },
    ])
      await assert.rejects(
        restartLabNetwork(owner, permitted),
        /^Error: LAB_NETWORK_UNAVAILABLE$/,
      );
    assert.equal(operations, 0);
  } finally {
    await lifecycle.close();
  }
});
