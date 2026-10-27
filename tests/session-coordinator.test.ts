import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { createIdentity } from "../packages/identity/src/index.js";
import type { SessionIdentity } from "../packages/protocol/src/index.js";
import {
  RecordStore,
  type RecordV1,
} from "../packages/security/src/records.js";
import { SessionCoordinator } from "../packages/session/src/coordinator.js";
import { MockSessionProvider } from "../packages/session/src/index.js";
import {
  SessionMembership,
  sessionLookupKey,
} from "../packages/session/src/matching.js";

const room = (jobId: string): SessionIdentity => ({
  universeId: "1",
  placeId: "2",
  jobId,
  evidenceSource: "test",
  verification: "mock",
});
test("provider changes, consent, refresh, departure and shutdown drive membership automatically", async () => {
  let now = 1000,
    writes = 0;
  let scheduled: (() => void) | undefined;
  const provider = new MockSessionProvider(),
    identity = createIdentity(),
    store = new RecordStore(() => now);
  provider.set(room("first"));
  const membership = new SessionMembership(
    identity,
    {
      async put(key: string, record: RecordV1) {
        writes++;
        store.put(key, record);
      },
      async lookup(key) {
        return { records: store.get(key) };
      },
    },
    { now: () => now, transportKey: "ab".repeat(32), displayName: "fixture" },
  );
  const coordinator = new SessionCoordinator(provider, membership, {
    schedule(run, delayMs) {
      assert.equal(delayMs, 20_000);
      scheduled = run;
      return () => {
        scheduled = undefined;
      };
    },
  });
  await coordinator.start();
  assert.equal(coordinator.status().state, "consent-required");
  assert.equal(writes, 0);
  await coordinator.setConsent(true);
  assert.equal(coordinator.status().state, "ready");
  assert.equal(coordinator.status().participants.length, 1);
  provider.set(room("second"));
  await coordinator.settled();
  assert.equal((await membership.find(room("first"), true)).length, 0);
  assert.equal((await membership.find(room("second"), true)).length, 1);
  now += 20_000;
  const refresh = scheduled;
  assert.ok(refresh);
  refresh();
  await setImmediate();
  await coordinator.settled();
  assert.ok(writes >= 4);
  await coordinator.setConsent(false);
  assert.equal(coordinator.status().participants.length, 0);
  assert.equal((await membership.find(room("second"), true)).length, 0);
  await coordinator.setConsent(true);
  const snapshot = coordinator.status();
  snapshot.participants.splice(0);
  assert.equal(coordinator.status().participants.length, 1);
  provider.set(null);
  await coordinator.settled();
  assert.equal(coordinator.status().state, "idle");
  assert.ok(
    store
      .get(sessionLookupKey(room("second"), 0))
      .every((r) => JSON.parse(r.content).state === "left"),
  );
  await coordinator.stop();
  assert.equal(scheduled, undefined);
  const before = writes;
  provider.set(room("third"));
  await setImmediate();
  assert.equal(writes, before);
  await assert.rejects(coordinator.start(), /COORDINATOR_CLOSED/);
});
test("new provider event wins over stale initial read; withdrawal clears stale in-flight results", async () => {
  let notify: (session: SessionIdentity | null) => void = () => {};
  let resolveInitial: (session: SessionIdentity) => void = () => {};
  const initial = new Promise<SessionIdentity>((resolve) => {
    resolveInitial = resolve;
  });
  const published: string[] = [];
  let releaseLookup: (() => void) | undefined;
  const coordinator = new SessionCoordinator(
    {
      current: () => initial,
      subscribe(handler) {
        notify = handler;
        return () => {};
      },
    },
    {
      async update(session, consent) {
        if (session && consent) published.push(session.jobId);
      },
      async find() {
        await new Promise<void>((resolve) => {
          releaseLookup = resolve;
        });
        return [];
      },
      async leave() {},
    },
  );
  const starting = coordinator.start();
  notify(room("new"));
  resolveInitial(room("stale"));
  await starting;
  const consenting = coordinator.setConsent(true);
  await setImmediate();
  assert.deepEqual(published, ["new"]);
  const withdrawing = coordinator.setConsent(false);
  assert.equal(coordinator.status().state, "consent-required");
  releaseLookup?.();
  await consenting;
  await withdrawing;
  assert.equal(coordinator.status().state, "consent-required");
  assert.deepEqual(coordinator.status().participants, []);
  await coordinator.stop();
});
test("network and provider failures clear participants and remain visible", async () => {
  const provider = new MockSessionProvider();
  provider.set(room("first"));
  const coordinator = new SessionCoordinator(provider, {
    async update(_session, consent) {
      if (consent) throw new Error("network unavailable");
    },
    async find() {
      return [];
    },
    async leave() {},
  });
  await coordinator.start();
  await coordinator.setConsent(true);
  assert.equal(coordinator.status().state, "error");
  assert.deepEqual(coordinator.status().participants, []);
  await coordinator.stop();
});
