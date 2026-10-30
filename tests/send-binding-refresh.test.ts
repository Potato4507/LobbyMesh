import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  type ContactLookup,
  DesktopMessaging,
} from "../apps/desktop/src/messaging.js";
import { DirectMessenger } from "../packages/protocol/src/direct.js";

const a = "a".repeat(64),
  b = "b".repeat(64),
  oldKey = "c".repeat(64),
  newKey = "d".repeat(64);
function fixture(
  options: {
    phase?: string;
    error?: unknown;
    freshKey?: string;
    missing?: boolean;
    newFails?: boolean;
    lookup?: ContactLookup;
    lostAck?: boolean;
  } = {},
) {
  let lookups = 0,
    allowed = true;
  const requests: { type: string; key: string }[] = [];
  const remote = new DirectMessenger(b, async () => null, {
    authorized: () => true,
  });
  const service = new DesktopMessaging(
    a,
    async (contact, request, signal) => {
      const type = (request as { type: string }).type;
      requests.push({ type, key: contact.transportKey });
      if (
        (contact.transportKey === oldKey &&
          type === (options.phase ?? "hello")) ||
        options.newFails
      )
        throw options.error ?? new Error("RPC_TIMEOUT");
      const response = await remote.handle(
        { id: a, publicKey: "synthetic", transportKey: newKey },
        request,
        signal,
      );
      if (options.lostAck && type === "text") throw new Error("RPC_TIMEOUT");
      return response;
    },
    {
      authorized: (id) => allowed && id === b,
      blocked: () => false,
      allowed: () => [b],
    },
    () => (options.missing ? [] : [{ id: b, transportKey: oldKey }]),
    Date.now,
    async (id, signal) => {
      lookups++;
      return options.lookup
        ? options.lookup(id, signal)
        : {
            contact: { id: b, transportKey: options.freshKey ?? newKey },
            complete: true,
          };
    },
  );
  return {
    service,
    remote,
    requests,
    lookups: () => lookups,
    deny: () => {
      allowed = false;
      service.policyChanged(b);
    },
    close: () => {
      service.close();
      remote.close();
    },
  };
}
test("one changed authenticated transport binding recovers hello or heartbeat failure before text dispatch", async () => {
  for (const phase of ["hello", "ping"])
    for (const code of ["DIRECT_TIMEOUT", "RPC_TIMEOUT", "RPC_CLOSED"]) {
      const f = fixture({ phase, error: new Error(code) });
      try {
        assert.equal(
          (await f.service.send(b, "new authenticated transport")).status,
          "acknowledged",
        );
        assert.equal(f.lookups(), 1);
        assert.equal(
          f.requests.filter((r) => r.type === phase && r.key === oldKey).length,
          1,
        );
        assert.deepEqual(
          f.requests.filter((r) => r.type === "text"),
          [{ type: "text", key: newKey }],
        );
        assert.equal(f.remote.history(a).length, 1);
      } finally {
        f.close();
      }
    }
});
test("an unchanged binding or failed replacement does not add negotiation retries", async () => {
  for (const options of [{ freshKey: oldKey }, { newFails: true }]) {
    const f = fixture(options);
    try {
      await assert.rejects(
        f.service.send(b, "no loop"),
        /DELIVERY_UNCONFIRMED/,
      );
      assert.equal(f.lookups(), 1);
      assert.equal(f.requests.filter((r) => r.key === oldKey).length, 1);
      assert.equal(
        f.requests.filter((r) => r.key === newKey).length,
        options.newFails ? 1 : 0,
      );
      assert.equal(
        f.requests.some((r) => r.type === "text"),
        false,
      );
      assert.equal(f.service.history(b)[0]?.failure?.stage, "connection");
    } finally {
      f.close();
    }
  }
  const f = fixture({ missing: true, newFails: true });
  try {
    await assert.rejects(
      f.service.send(b, "already searched"),
      /DELIVERY_UNCONFIRMED/,
    );
    assert.equal(f.lookups(), 1);
    assert.equal(f.requests.length, 1);
  } finally {
    f.close();
  }
});
test("peer rejection, identity/protocol failures, arbitrary errors and non-errors never trigger refresh", async () => {
  for (const error of [
    new Error("REMOTE_RPC_REJECTED"),
    new Error("PEER_ID_MISMATCH"),
    new Error("INCOMPATIBLE_DIRECT_PROTOCOL"),
    new Error("RPC_TIMEOUT private"),
    new Error("RPC_ABORTED"),
    "RPC_TIMEOUT",
    { message: "RPC_TIMEOUT" },
  ]) {
    const f = fixture({ error });
    try {
      await assert.rejects(
        f.service.send(b, "no unsafe retry"),
        /DELIVERY_UNCONFIRMED/,
      );
      assert.equal(f.lookups(), 0);
      assert.equal(f.requests.length, 1);
    } finally {
      f.close();
    }
  }
});
test("an ambiguous text ACK loss uses existing same-envelope retries and never refreshes or redispatches via another key", async () => {
  const f = fixture({ phase: "unused", lostAck: true });
  try {
    await assert.rejects(
      f.service.send(b, "accepted once before lost ACK"),
      /DELIVERY_UNCONFIRMED/,
    );
    assert.equal(f.lookups(), 0);
    assert.equal(f.requests.filter((r) => r.type === "text").length, 3);
    assert.ok(f.requests.every((r) => r.key === oldKey));
    assert.equal(f.remote.history(a).length, 1);
    assert.equal(f.service.history(b)[0]?.failure?.stage, "delivery");
  } finally {
    f.close();
  }
});
test("cancel and withdrawal during stale-binding refresh prevent late key replacement from dispatching plaintext", async () => {
  for (const deny of [false, true]) {
    let finish!: (value: Awaited<ReturnType<ContactLookup>>) => void,
      signal!: AbortSignal;
    const f = fixture({
      lookup: async (_id, s) => {
        signal = s;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    });
    try {
      const pending = f.service.send(b, "held stale refresh"),
        check = assert.rejects(pending, /DELIVERY_UNCONFIRMED/);
      await setImmediate();
      if (deny) f.deny();
      else {
        const row = f.service.history(b)[0];
        assert.ok(row);
        assert.equal(f.service.cancel(b, row.localId), true);
      }
      await check;
      assert.equal(signal.aborted, true);
      finish({ contact: { id: b, transportKey: newKey }, complete: true });
      await setImmediate();
      assert.equal(f.lookups(), 1);
      assert.deepEqual(f.requests, [{ type: "hello", key: oldKey }]);
      assert.equal(f.remote.history(a).length, 0);
    } finally {
      f.close();
    }
  }
});
