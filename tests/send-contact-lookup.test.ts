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
  key = "d".repeat(64);
function fixture(lookup: ContactLookup) {
  let allowed = true,
    exchanges = 0;
  const remote = new DirectMessenger(b, async () => null, {
    authorized: () => true,
  });
  const service = new DesktopMessaging(
    a,
    (contact, request, signal) => {
      exchanges++;
      assert.deepEqual(contact, { id: b, transportKey: key });
      return remote.handle(
        { id: a, publicKey: "synthetic", transportKey: key },
        request,
        signal,
      );
    },
    {
      authorized: (id) => allowed && id === b,
      blocked: () => false,
      allowed: () => [b],
    },
    () => [],
    Date.now,
    lookup,
  );
  return {
    service,
    remote,
    exchanges: () => exchanges,
    deny: () => {
      allowed = false;
      service.policyChanged(b);
    },
    allow: () => {
      allowed = true;
    },
    close: () => {
      service.close();
      remote.close();
    },
  };
}
test("explicit send looks up a missing approved binding before protocol negotiation and ACK", async () => {
  let finish!: (value: Awaited<ReturnType<ContactLookup>>) => void,
    calls = 0;
  const f = fixture(async (id, signal) => {
    calls++;
    assert.equal(id, b);
    assert.equal(signal.aborted, false);
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  try {
    const pending = f.service.send(b, "owned lookup text");
    await Promise.resolve();
    assert.equal(f.exchanges(), 0);
    assert.equal(f.service.history(b)[0]?.status, "sending");
    finish({ contact: { id: b, transportKey: key }, complete: true });
    assert.equal((await pending).status, "acknowledged");
    assert.equal(f.remote.history(a).length, 1);
    await f.service.send(b, "reuse authenticated binding");
    assert.equal(calls, 1);
  } finally {
    f.close();
  }
});
test("Stop, Clear, withdrawal and shutdown cancel owned lookup and discard even nonabortable late results", async () => {
  for (const action of ["stop", "clear", "deny", "close"] as const) {
    let finish!: (value: Awaited<ReturnType<ContactLookup>>) => void,
      signal!: AbortSignal;
    const f = fixture(async (_id, s) => {
      signal = s;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    try {
      const pending = f.service.send(b, "must not dispatch"),
        rejected = assert.rejects(pending, /^Error: DELIVERY_UNCONFIRMED$/);
      await Promise.resolve();
      if (action === "stop") {
        const row = f.service.history(b)[0];
        assert.ok(row);
        assert.equal(f.service.cancel(b, row.localId), true);
      }
      if (action === "clear") f.service.clear(b);
      if (action === "deny") f.deny();
      if (action === "close") f.service.close();
      await rejected;
      assert.equal(signal.aborted, true);
      f.allow();
      if (action !== "close") {
        await assert.rejects(f.service.rediscover(b), /CONTACT_SEARCH_BUSY/);
        if (action === "clear") assert.deepEqual(f.service.history(b), []);
        else
          assert.equal(
            f.service.history(b)[0]?.failure?.reason,
            action === "deny" ? "permission-changed" : "canceled",
          );
      }
      finish({ contact: { id: b, transportKey: key }, complete: true });
      await setImmediate();
      assert.equal(f.exchanges(), 0);
      assert.equal(f.remote.history(a).length, 0);
      if (action !== "close")
        assert.throws(
          () => f.service.resolveContact(b),
          /CONTACT_NOT_DISCOVERED/,
        );
    } finally {
      f.close();
    }
  }
});
test("not located, incomplete, invalid and throwing lookup never dispatch text or expose raw details", async () => {
  for (const lookup of [
    async () => ({ contact: null, complete: true }),
    async () => ({ contact: null, complete: false }),
    async () => ({ contact: { id: a, transportKey: key }, complete: true }),
    async () => {
      throw new Error("private endpoint and draft");
    },
  ] satisfies ContactLookup[]) {
    const f = fixture(lookup);
    try {
      await assert.rejects(
        f.service.send(b, "retained draft"),
        /^Error: DELIVERY_UNCONFIRMED$/,
      );
      assert.equal(f.exchanges(), 0);
      assert.equal(f.service.history(b)[0]?.status, "unconfirmed");
      assert.equal(f.service.history(b)[0]?.failure?.stage, "connection");
      assert.equal(
        JSON.stringify(f.service.history(b)).includes("private endpoint"),
        false,
      );
    } finally {
      f.close();
    }
  }
});
test("send does not take ownership of an existing manual lookup or bypass its quota", async () => {
  let finish!: (value: Awaited<ReturnType<ContactLookup>>) => void,
    signal!: AbortSignal,
    calls = 0;
  const f = fixture(async (_id, s) => {
    calls++;
    signal = s;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  try {
    const manual = f.service.rediscover(b);
    await Promise.resolve();
    await assert.rejects(
      f.service.send(b, "busy lookup"),
      /DELIVERY_UNCONFIRMED/,
    );
    assert.equal(signal.aborted, false);
    assert.equal(f.exchanges(), 0);
    finish({ contact: null, complete: true });
    assert.deepEqual(await manual, { state: "not-located" });
    await assert.rejects(
      f.service.send(b, "cooldown lookup"),
      /DELIVERY_UNCONFIRMED/,
    );
    assert.equal(calls, 1);
  } finally {
    f.close();
  }
});
test("lookup timeout leaves connection unconfirmed and never dispatches a late binding", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish!: (value: Awaited<ReturnType<ContactLookup>>) => void;
  const f = fixture(
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  try {
    const pending = f.service.send(b, "bounded lookup");
    const rejected = assert.rejects(pending, /DELIVERY_UNCONFIRMED/);
    await Promise.resolve();
    t.mock.timers.tick(5000);
    await rejected;
    assert.equal(f.service.history(b)[0]?.failure?.stage, "connection");
    finish({ contact: { id: b, transportKey: key }, complete: true });
    await setImmediate();
    assert.equal(f.exchanges(), 0);
    assert.throws(() => f.service.resolveContact(b), /CONTACT_NOT_DISCOVERED/);
  } finally {
    f.close();
  }
});
test("pre-canceled lookup and unauthorized send do not consume a resolver job", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return { contact: null, complete: true };
  });
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      f.service.rediscover(b, controller.signal),
      /CONTACT_SEARCH_CANCELED/,
    );
    f.deny();
    await assert.rejects(f.service.send(b, "denied"), /CONTACT_NOT_AUTHORIZED/);
    assert.equal(calls, 0);
    f.allow();
    assert.deepEqual(await f.service.rediscover(b), { state: "not-located" });
    assert.equal(calls, 1);
  } finally {
    f.close();
  }
});
