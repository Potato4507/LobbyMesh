import assert from "node:assert/strict";
import test from "node:test";
import { createIdentity } from "../packages/identity/src/index.js";
import type { SessionIdentity } from "../packages/protocol/src/index.js";
import {
  RecordStore,
  type RecordV1,
  signRecord,
} from "../packages/security/src/records.js";
import {
  canonicalSession,
  SESSION_EPOCH_MS,
  SessionMembership,
  sessionLookupKey,
} from "../packages/session/src/matching.js";

const room = (jobId = "room-1"): SessionIdentity => ({
  universeId: "1",
  placeId: "2",
  jobId,
  evidenceSource: "test",
  verification: "mock",
});
test("session keys have canonical namespace/epoch scope and reject ambiguous/invalid evidence", () => {
  assert.equal(
    canonicalSession(room()),
    JSON.stringify(["companion/session-key/v1", "1", "2", "room-1"]),
  );
  assert.equal(sessionLookupKey(room(), 1), sessionLookupKey({ ...room() }, 1));
  assert.notEqual(
    sessionLookupKey(room(), 1),
    sessionLookupKey(room("room-2"), 1),
  );
  assert.notEqual(sessionLookupKey(room(), 1), sessionLookupKey(room(), 2));
  assert.notEqual(
    sessionLookupKey({ ...room(), universeId: "1", placeId: "23" }, 1),
    sessionLookupKey({ ...room(), universeId: "12", placeId: "3" }, 1),
  );
  for (const value of [
    { ...room(), universeId: "01" },
    { ...room(), jobId: "x\ny" },
    { ...room(), verification: "externally-verified" as const },
  ])
    assert.throws(() => canonicalSession(value), /INVALID_SESSION/);
  assert.throws(() => sessionLookupKey(room(), -1), /INVALID_EPOCH/);
});
test("50 synthetic participants in five rooms match only consented live signed claims; leave, block and rollover", async () => {
  let now = SESSION_EPOCH_MS + 100;
  const store = new RecordStore(() => now),
    blocked = new Set<string>();
  const directory = {
    async put(key: string, record: RecordV1) {
      store.put(key, record);
    },
    async lookup(key: string) {
      return { records: store.get(key) };
    },
  };
  const participants = Array.from({ length: 50 }, (_, n) => {
    const identity = createIdentity(),
      session = room(`room-${n % 5}`);
    return {
      identity,
      session,
      membership: new SessionMembership(identity, directory, {
        transportKey: n.toString(16).padStart(64, "0"),
        displayName: "duplicate display name",
        now: () => now,
        blocked: (id) => blocked.has(id),
      }),
    };
  });
  for (const participant of participants)
    await participant.membership.update(participant.session, true);
  for (const participant of participants) {
    const matched = await participant.membership.find(
      participant.session,
      true,
    );
    const expected = participants
      .filter((p) => p.session.jobId === participant.session.jobId)
      .map((p) => p.identity.peerId)
      .sort();
    assert.deepEqual(
      matched.map((p) => p.peerId),
      expected,
    );
    assert.ok(
      matched.every(
        (p) => p.verification === "mock" && p.identityTrust === "app-key-only",
      ),
    );
  }
  const first = participants[0],
    second = participants[5];
  assert.ok(first && second);
  blocked.add(second.identity.peerId);
  assert.equal((await first.membership.find(first.session, true)).length, 9);
  blocked.clear();
  await second.membership.leave();
  assert.equal((await first.membership.find(first.session, true)).length, 9);
  const epochKey = sessionLookupKey(
    first.session,
    Math.floor(now / SESSION_EPOCH_MS),
  );
  assert.ok(!store.get(epochKey)[0]?.content.includes(first.session.jobId));
  now += SESSION_EPOCH_MS;
  await first.membership.update(first.session, true);
  assert.deepEqual(
    (await first.membership.find(first.session, true)).map((p) => p.peerId),
    [first.identity.peerId],
  );
  await first.membership.update(room("moved"), true);
  assert.deepEqual(await first.membership.find(first.session, true), []);
  assert.equal((await first.membership.find(room("moved"), true)).length, 1);
});
test("no-consent operations are silent; remote verified claims never become externally verified identities", async () => {
  let writes = 0,
    reads = 0;
  const now = 1000,
    identity = createIdentity(),
    key = sessionLookupKey(room(), 0);
  const advertised = room();
  advertised.evidenceSource = "authorized-sdk";
  advertised.verification = "externally-verified";
  let records: RecordV1[] = [];
  const directory = {
    async put(_key: string, record: RecordV1) {
      writes++;
      records = [record];
    },
    async lookup() {
      reads++;
      return { records };
    },
  };
  const membership = new SessionMembership(identity, directory, {
    transportKey: "ab".repeat(32),
    displayName: "participant",
    now: () => now,
  });
  await membership.update(advertised, false);
  assert.deepEqual(await membership.find(advertised, false), []);
  assert.equal(writes, 0);
  assert.equal(reads, 0);
  await membership.update(advertised, true);
  const found = await membership.find(advertised, true);
  assert.equal(found[0]?.verification, "self-asserted");
  assert.equal(found[0]?.claimedVerification, "externally-verified");
  const valid = records[0];
  assert.ok(valid);
  records = [
    { ...valid, signature: Buffer.alloc(64).toString("base64") },
    { ...valid, key: "00".repeat(32) },
    signRecord(
      identity,
      key,
      valid.content,
      valid.seq + 1,
      now - SESSION_EPOCH_MS,
      SESSION_EPOCH_MS,
    ),
  ];
  assert.deepEqual(await membership.find(room(), true), []);
  const incomplete = new SessionMembership(
    identity,
    {
      async put() {},
      async lookup() {
        return { records: [], routing: { state: "timeout", failures: 0 } };
      },
    },
    {
      transportKey: "ab".repeat(32),
      displayName: "participant",
      now: () => now,
    },
  );
  await assert.rejects(
    incomplete.find(room(), true),
    /SESSION_LOOKUP_INCOMPLETE/,
  );
});
