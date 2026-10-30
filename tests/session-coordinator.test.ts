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

test("a stale provider read rejection cannot erase a newer session event or departure", async () => {
  for (const latest of [room("fresh"), null]) {
    let notify: (value: SessionIdentity | null) => void = () => {};
    let rejectRead: (error: Error) => void = () => {};
    const pending = new Promise<SessionIdentity | null>((_resolve, reject) => {
      rejectRead = reject;
    });
    const found: string[] = [];
    const coordinator = new SessionCoordinator(
      {
        current: () => pending,
        subscribe(handler) {
          notify = handler;
          return () => {};
        },
      },
      {
        async update() {},
        async find(session) {
          found.push(session.jobId);
          return [];
        },
        async leave() {},
      },
    );
    try {
      await coordinator.setConsent(true);
      const starting = coordinator.start();
      notify(latest);
      await coordinator.settled();
      rejectRead(new Error("older source read failed"));
      await starting;
      assert.equal(coordinator.status().state, latest ? "ready" : "idle");
      await coordinator.setConsent(true);
      assert.equal(found.at(-1), latest?.jobId);
      assert.equal(coordinator.status().state, latest ? "ready" : "idle");
    } finally {
      await coordinator.stop();
    }
  }
});

test("withdrawal, session replacement and stop during publication prevent an obsolete roster lookup", async () => {
  for (const action of ["withdraw", "replace", "stop"]) {
    const provider = new MockSessionProvider();
    provider.set(room("old"));
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const found: string[] = [];
    const coordinator = new SessionCoordinator(provider, {
      async update(session, consent) {
        if (session?.jobId === "old" && consent) await held;
      },
      async find(session) {
        found.push(session.jobId);
        return [];
      },
      async leave() {},
    });
    try {
      await coordinator.start();
      const consenting = coordinator.setConsent(true);
      await setImmediate();
      const changed =
        action === "withdraw"
          ? coordinator.setConsent(false)
          : action === "stop"
            ? coordinator.stop()
            : Promise.resolve(provider.set(room("new")));
      release();
      await Promise.all([consenting, changed]);
      await coordinator.settled();
      assert.deepEqual(found, action === "replace" ? ["new"] : []);
      assert.equal(
        coordinator.status().state,
        action === "replace"
          ? "ready"
          : action === "stop"
            ? "idle"
            : "consent-required",
      );
    } finally {
      release();
      await coordinator.stop();
    }
  }
});

test("coordinator withdrawal cancels a replacement join after an in-flight tombstone and can re-enable", async () => {
  const provider = new MockSessionProvider();
  provider.set(room("old"));
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writes: { key: string; state: string }[] = [];
  const membership = new SessionMembership(
    createIdentity(),
    {
      async put(key, record) {
        const state = JSON.parse(record.content).state;
        writes.push({ key, state });
        if (writes.length === 2) await held;
      },
      async lookup() {
        return { records: [] };
      },
    },
    { now: () => 1000, transportKey: "ab".repeat(32), displayName: "fixture" },
  );
  const coordinator = new SessionCoordinator(provider, membership);
  try {
    await coordinator.setConsent(true);
    await coordinator.start();
    provider.set(room("new"));
    await setImmediate();
    assert.equal(writes.length, 2);
    const withdrawing = coordinator.setConsent(false);
    release();
    await withdrawing;
    assert.deepEqual(writes, [
      { key: sessionLookupKey(room("old"), 0), state: "joined" },
      { key: sessionLookupKey(room("old"), 0), state: "left" },
    ]);
    assert.equal(coordinator.status().state, "consent-required");
    await coordinator.setConsent(true);
    assert.equal(coordinator.status().state, "ready");
    assert.deepEqual(writes.at(-1), {
      key: sessionLookupKey(room("new"), 0),
      state: "joined",
    });
    await coordinator.stop();
    assert.deepEqual(writes.at(-1), {
      key: sessionLookupKey(room("new"), 0),
      state: "left",
    });
  } finally {
    release();
    await coordinator.stop();
  }
});
