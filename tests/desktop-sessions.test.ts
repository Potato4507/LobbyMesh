import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DesktopSessions } from "../apps/desktop/src/sessions.js";
import { createIdentity } from "../packages/identity/src/index.js";
import type { SessionIdentity } from "../packages/protocol/src/index.js";
import {
  RecordStore,
  type RecordV1,
} from "../packages/security/src/records.js";
import { MockSessionProvider } from "../packages/session/src/index.js";
import {
  SessionMembership,
  sessionLookupKey,
} from "../packages/session/src/matching.js";
import { WindowsLogSessionProvider } from "../packages/session/src/windows-logs.js";

test("desktop log sessions publish signed scoped presence, match peers, update names and withdraw without granting contact rights", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "lobbymesh-desktop-sessions-"),
  );
  const provider = new WindowsLogSessionProvider([directory], {
    pollMs: 10_000,
  });
  const self = createIdentity(),
    other = createIdentity(),
    store = new RecordStore(Date.now);
  const backend = {
    async put(key: string, record: RecordV1) {
      store.put(key, record);
    },
    async lookup(key: string) {
      return { records: store.get(key) };
    },
  };
  let consent = false,
    displayName = "First name";
  const blocked = new Set<string>();
  const sessions = new DesktopSessions(
    self,
    backend,
    "aa".repeat(32),
    { provider, preferences: () => ({ displayName, sessionConsent: consent }) },
    (peerId) => blocked.has(peerId),
  );
  const room: SessionIdentity = {
    universeId: "456",
    placeId: "123",
    jobId: "12345678-abcd-1234-abcd-123456789abc",
    evidenceSource: "windows-log",
    verification: "self-asserted",
  };
  const remote = new SessionMembership(other, backend, {
    transportKey: "bb".repeat(32),
    displayName: "Other companion",
  });
  try {
    const prefix = `${new Date().toISOString()},1,abcd,6,Info `;
    await writeFile(
      path.join(directory, "0.1_Player_ABCD_last.log"),
      [
        `[FLog::Output] ! Joining game '${room.jobId}' place 123 at 127.0.0.1`,
        "[FLog::GameJoinLoadTime] Report game_join_loadtime: universeid:456, userid:999",
        "[FLog::Network] Replicator created: serverId: 127.0.0.1|1",
      ]
        .map((line) => `${prefix}${line}\n`)
        .join(""),
    );
    await provider.setEnabled(true);
    await remote.update(room, true);
    await sessions.start();
    assert.equal(sessions.status().state, "consent-required");
    assert.equal(
      store.get(sessionLookupKey(room, Math.floor(Date.now() / 60_000))).length,
      1,
    );
    consent = true;
    await sessions.settingsChanged();
    assert.deepEqual(sessions.status(), { state: "ready", participants: 1 });
    const matches = await remote.find(room, true);
    assert.equal(
      matches.find((peer) => peer.peerId === self.peerId)?.verification,
      "self-asserted",
    );
    displayName = "Changed name";
    await sessions.settingsChanged();
    assert.equal(
      (await remote.find(room, true)).find(
        (peer) => peer.peerId === self.peerId,
      )?.displayName,
      displayName,
    );
    blocked.add(other.peerId);
    assert.equal(sessions.status().participants, 0);
    consent = false;
    const revoked = sessions.settingsChanged();
    assert.equal(sessions.status().participants, 0);
    await revoked;
    assert.equal(
      (await remote.find(room, true)).some(
        (peer) => peer.peerId === self.peerId,
      ),
      false,
    );
    await sessions.stop();
    assert.deepEqual(sessions.status(), { state: "offline", participants: 0 });
    await assert.rejects(sessions.start(), /CLOSED/);
  } finally {
    await sessions.stop();
    await provider.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("desktop matching failures remain visible and stop withdraws local views even when networking fails", async () => {
  const provider = new MockSessionProvider();
  provider.set({
    universeId: "1",
    placeId: "2",
    jobId: "fixture",
    evidenceSource: "test",
    verification: "mock",
  });
  let failed = false;
  const sessions = new DesktopSessions(
    createIdentity(),
    {
      async put() {
        if (failed) throw new Error("unreachable");
      },
      async lookup() {
        return {
          records: [],
          routing: { state: failed ? "deadline" : "exhausted", failures: 0 },
        };
      },
    },
    "aa".repeat(32),
    {
      provider,
      preferences: () => ({ displayName: "Fixture", sessionConsent: true }),
    },
    () => false,
  );
  try {
    await sessions.start();
    assert.deepEqual(sessions.status(), { state: "ready", participants: 0 });
    failed = true;
    await sessions.settingsChanged();
    assert.deepEqual(sessions.status(), { state: "error", participants: 0 });
    await sessions.stop();
    assert.equal(sessions.status().state, "offline");
  } finally {
    await sessions.stop();
  }
});
