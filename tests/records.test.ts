import assert from "node:assert/strict";
import test from "node:test";
import { createIdentity } from "../packages/identity/src/index.js";
import { RecordStore, signRecord } from "../packages/security/src/records.js";

test("signed record domain/key binding, replay, expiry, quotas and mutation isolation", () => {
  let now = 1000;
  const identity = createIdentity(),
    key = "a".repeat(64);
  const store = new RecordStore(() => now, 1);
  const record = signRecord(identity, key, "hello", 0, now);
  store.put(key, record);
  record.content = "mutated";
  assert.equal(store.get(key)[0]?.content, "hello");
  assert.throws(() => store.put(key, record), /SIGNATURE/);
  assert.throws(
    () => store.put(key, signRecord(identity, key, "hello", 0, now)),
    /REPLAY/,
  );
  assert.throws(
    () => store.put("b".repeat(64), signRecord(identity, key, "hello", 1, now)),
    /INVALID/,
  );
  assert.throws(
    () => store.put(key, signRecord(createIdentity(), key, "hello", 0, now)),
    /QUOTA/,
  );
  assert.throws(
    () => store.put(key, signRecord(identity, key, "x".repeat(9000), 1, now)),
    /SIZE/,
  );
  now += 60001;
  assert.deepEqual(store.get(key), []);
  assert.throws(
    () => store.put(key, signRecord(identity, key, "old", 1, 1000)),
    /INVALID/,
  );
  store.put(key, signRecord(identity, key, "fresh", 1, now));
  assert.equal(store.get(key).length, 1);
});
