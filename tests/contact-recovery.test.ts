import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { recoverContact } from "../packages/app-dht/src/contact-recovery.js";
import type { LookupResult } from "../packages/app-dht/src/lookup.js";

const target = "ab".repeat(32),
  key = "cd".repeat(32);
const result = (found = false): LookupResult => ({
  state: "exhausted",
  queried: 1,
  failures: 0,
  authenticated: found ? [{ id: target, transportKey: key }] : [],
});
const hint = {
  id: `transport:${key}`,
  publicKey: Buffer.from(key, "hex"),
  connectionHints: [],
};

test("partial directory failure retains authenticated reachability without claiming complete search", async () => {
  let authenticated = false;
  const recovered = await recoverContact(
    target,
    {
      authenticatedContacts: () => [],
      async probe(_contact, signal) {
        await setImmediate();
        assert.equal(signal.aborted, false);
        authenticated = true;
        return { version: 1, authenticated: true };
      },
      async findNodes() {
        return result(authenticated);
      },
    },
    {
      async *findAppEntrypoints() {
        yield hint;
        throw new Error("directory interrupted");
      },
    },
    new AbortController().signal,
  );
  assert.deepEqual(recovered, {
    contact: { id: target, transportKey: key },
    complete: false,
  });
});

test("warm authenticated target avoids public search and copies only its binding", async () => {
  const original = { id: target, transportKey: key };
  const recovered = await recoverContact(
    target,
    {
      authenticatedContacts: () => [hint],
      async findNodes() {
        return { ...result(), authenticated: [original] };
      },
      async probe() {
        assert.fail("already located target must not probe public hints");
      },
    },
    {
      findAppEntrypoints() {
        assert.fail("already located target must not search bootstrap");
      },
    },
    new AbortController().signal,
  );
  assert.deepEqual(recovered, { contact: original, complete: true });
  assert.notEqual(recovered.contact, original);
});

test("cold graph authenticates bootstrap candidates before looking for the exact approved target", async () => {
  let authenticated = false,
    queries = 0;
  const owner = new AbortController();
  const recovered = await recoverContact(
    target,
    {
      authenticatedContacts: () => [],
      async findNodes(id, _seeds, signal) {
        assert.equal(id, target);
        assert.equal(signal, owner.signal);
        assert.ok(authenticated);
        queries++;
        return result(true);
      },
      async probe(candidate, signal) {
        assert.equal(candidate, hint);
        assert.equal(signal.aborted, false);
        authenticated = true;
        return { version: 1, authenticated: true };
      },
    },
    {
      async *findAppEntrypoints() {
        yield hint;
      },
    },
    owner.signal,
  );
  assert.equal(queries, 1);
  assert.deepEqual(recovered, {
    contact: { id: target, transportKey: key },
    complete: true,
  });
});

test("a referral never supplies a binding; a failed bootstrap traversal keeps an empty result incomplete", async () => {
  for (const failed of [false, true]) {
    let lookups = 0,
      searches = 0;
    const recovered = await recoverContact(
      target,
      {
        authenticatedContacts: () => [hint],
        async findNodes() {
          lookups++;
          return result();
        },
        async probe() {
          return { version: 1, authenticated: true };
        },
      },
      {
        async *findAppEntrypoints() {
          searches++;
          if (failed) throw new Error("private directory failure");
          yield hint;
        },
      },
      new AbortController().signal,
    );
    assert.deepEqual(recovered, { contact: null, complete: !failed });
    assert.equal(lookups, 2);
    assert.equal(searches, 1);
  }
});

test("cancellation before work or during bootstrap cannot start a later app lookup", async () => {
  let lookups = 0,
    release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const overlay = {
    authenticatedContacts: () => [],
    async findNodes() {
      lookups++;
      return result();
    },
    async probe() {
      assert.fail("canceled hint must not authenticate");
    },
  };
  const discovery = {
    async *findAppEntrypoints() {
      await gate;
      yield hint;
    },
  };
  const before = new AbortController();
  before.abort();
  await assert.rejects(
    recoverContact(target, overlay, discovery, before.signal),
    /CONTACT_RECOVERY_ABORTED/,
  );
  const during = new AbortController();
  const pending = recoverContact(target, overlay, discovery, during.signal);
  await setImmediate();
  during.abort();
  await assert.rejects(pending, /CONTACT_RECOVERY_ABORTED/);
  release();
  await setImmediate();
  assert.equal(lookups, 0);
  await assert.rejects(
    recoverContact("bad", overlay, discovery, new AbortController().signal),
    /INVALID_CONTACT_TARGET/,
  );
});
