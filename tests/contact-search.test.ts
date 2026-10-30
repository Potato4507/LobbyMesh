import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  type ContactLookup,
  DesktopMessaging,
} from "../apps/desktop/src/messaging.js";

const a = "a".repeat(64),
  b = "b".repeat(64),
  c = "c".repeat(64),
  key = "d".repeat(64);
function fixture(lookup: ContactLookup) {
  let now = 1000,
    allowed = true;
  const service = new DesktopMessaging(
    a,
    async () => null,
    {
      authorized: (id) => allowed && id === b,
      blocked: () => false,
      allowed: () => (allowed ? [b] : []),
    },
    () => [],
    () => now,
    lookup,
  );
  return {
    service,
    advance: () => {
      now += 5000;
    },
    deny: () => {
      allowed = false;
      service.policyChanged(b);
    },
    allow: () => {
      allowed = true;
    },
  };
}
test("contact search uses only approved IDs, projects no transport data and retains a verified matching binding", async () => {
  let calls = 0;
  const f = fixture(async (id, signal) => {
    calls++;
    assert.equal(id, b);
    assert.equal(signal.aborted, false);
    return { contact: { id: b, transportKey: key }, complete: true };
  });
  try {
    await assert.rejects(f.service.rediscover(c), /CONTACT_NOT_AUTHORIZED/);
    assert.equal(calls, 0);
    assert.deepEqual(await f.service.rediscover(b), { state: "found" });
    assert.equal(calls, 1);
    assert.deepEqual(f.service.resolveContact(b), { id: b, transportKey: key });
    await assert.rejects(f.service.rediscover(b), /CONTACT_SEARCH_RATE_LIMIT/);
    assert.equal(calls, 1);
    f.advance();
    assert.deepEqual(await f.service.rediscover(b), { state: "found" });
  } finally {
    f.service.close();
  }
});
test("not located differs from incomplete and malformed or wrong-identity lookup results cannot become bindings", async () => {
  let result: unknown = { contact: null, complete: true };
  const f = fixture(async () => result as Awaited<ReturnType<ContactLookup>>);
  try {
    assert.deepEqual(await f.service.rediscover(b), { state: "not-located" });
    f.advance();
    result = { contact: null, complete: false };
    assert.deepEqual(await f.service.rediscover(b), { state: "incomplete" });
    for (const bad of [
      null,
      [],
      {},
      { contact: { id: c, transportKey: key }, complete: true },
      { contact: { id: b, transportKey: "bad" }, complete: true },
      {
        contact: { id: b, transportKey: key, endpoint: "private" },
        complete: true,
      },
      { contact: null, complete: 1 },
    ]) {
      f.advance();
      result = bad;
      await assert.rejects(
        f.service.rediscover(b),
        /CONTACT_SEARCH_INVALID_RESULT/,
      );
      assert.throws(
        () => f.service.resolveContact(b),
        /CONTACT_NOT_DISCOVERED/,
      );
    }
    f.advance();
    result = { contact: { id: b, transportKey: key }, complete: false };
    assert.deepEqual(await f.service.rediscover(b), { state: "found" });
  } finally {
    f.service.close();
  }
});
test("search rate limiting is global across approved targets", async () => {
  let calls = 0;
  const service = new DesktopMessaging(
    a,
    async () => null,
    {
      authorized: (id) => id === b || id === c,
      blocked: () => false,
      allowed: () => [b, c],
    },
    () => [],
    () => 1000,
    async (id) => {
      calls++;
      return { contact: { id, transportKey: key }, complete: true };
    },
  );
  try {
    await service.rediscover(b);
    await assert.rejects(service.rediscover(c), /CONTACT_SEARCH_RATE_LIMIT/);
    assert.equal(calls, 1);
  } finally {
    service.close();
  }
});
test("a timed-out search retains one underlying job, discards late results and recovers after settlement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish: (v: Awaited<ReturnType<ContactLookup>>) => void = () => {},
    calls = 0,
    signal: AbortSignal | undefined;
  const f = fixture(async (_id, s) => {
    calls++;
    signal = s;
    if (calls > 1) return { contact: null, complete: true };
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  try {
    const pending = f.service.rediscover(b);
    await Promise.resolve();
    t.mock.timers.tick(5000);
    assert.deepEqual(await pending, { state: "incomplete" });
    assert.equal(signal?.aborted, true);
    f.advance();
    await assert.rejects(f.service.rediscover(b), /CONTACT_SEARCH_BUSY/);
    assert.equal(calls, 1);
    finish({ contact: { id: b, transportKey: key }, complete: true });
    await setImmediate();
    assert.throws(() => f.service.resolveContact(b), /CONTACT_NOT_DISCOVERED/);
    assert.deepEqual(await f.service.rediscover(b), { state: "not-located" });
    assert.equal(calls, 2);
  } finally {
    f.service.close();
  }
});
test("withdrawal or close cancels lookup before invocation and a denied late result cannot resurrect permission", async () => {
  for (const close of [false, true]) {
    let calls = 0;
    const f = fixture(async () => {
      calls++;
      return { contact: { id: b, transportKey: key }, complete: true };
    });
    const pending = f.service.rediscover(b),
      check = assert.rejects(pending, /CONTACT_SEARCH_CANCELED/);
    if (close) f.service.close();
    else f.deny();
    await check;
    assert.equal(calls, 0);
    f.service.close();
  }
  let finish: (v: Awaited<ReturnType<ContactLookup>>) => void = () => {};
  const f = fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.service.rediscover(b),
    check = assert.rejects(pending, /CONTACT_SEARCH_CANCELED/);
  await Promise.resolve();
  f.deny();
  await check;
  f.allow();
  finish({ contact: { id: b, transportKey: key }, complete: true });
  await setImmediate();
  assert.throws(() => f.service.resolveContact(b), /CONTACT_NOT_DISCOVERED/);
  f.service.close();
});
test("unavailable or throwing resolvers return fixed failures and never expose raw errors", async () => {
  const service = new DesktopMessaging(
    a,
    async () => null,
    { authorized: () => true, blocked: () => false, allowed: () => [b] },
    () => [],
  );
  await assert.rejects(service.rediscover(b), /CONTACT_SEARCH_UNAVAILABLE/);
  service.close();
  const f = fixture(async () => {
    throw new Error("private address and payload");
  });
  try {
    assert.deepEqual(await f.service.rediscover(b), { state: "incomplete" });
  } finally {
    f.service.close();
  }
});
