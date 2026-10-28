import assert from "node:assert/strict";
import {
  appendFile,
  mkdir,
  mkdtemp,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { canonicalSession } from "../packages/session/src/matching.js";
import {
  createWindowsActivityReader,
  parsePlayerActivity,
} from "../packages/session/src/windows-activity.js";
import {
  PlayerLogParser,
  WindowsLogSessionProvider,
  windowsLogDirectories,
} from "../packages/session/src/windows-logs.js";

const now = Date.now(),
  job = "12345678-abcd-1234-abcd-123456789abc";
const line = (message: string, time = now) =>
  `${new Date(time).toISOString()},1.0,abcd,6,Info ${message}\n`;
const joined = () =>
  line(`[FLog::Output] ! Joining game '${job}' place 123 at 127.0.0.1`) +
  line(
    "[FLog::GameJoinLoadTime] Report game_join_loadtime: universeid:456, userid:999",
  ) +
  line("[FLog::Network] Replicator created: serverId: 127.0.0.1|1");
test("player log requires explicit complete engine evidence and never promotes local logs to verified identity", () => {
  const parser = new PlayerLogParser();
  parser.line(
    line(
      `[FLog::CreatorOutput] [FLog::Output] ! Joining game '${job}' place 123 at 127.0.0.1`,
    ).trim(),
    now,
  );
  assert.equal(parser.session(), null);
  for (const entry of joined().split("\n").slice(0, 2)) parser.line(entry, now);
  assert.equal(parser.session(), null);
  assert.equal(parser.state(), "incomplete");
  parser.line(
    line("[FLog::Network] Replicator created: serverId: 127.0.0.1|1").trim(),
    now,
  );
  const session = parser.session();
  assert.equal(session?.universeId, "456");
  assert.equal(session?.evidenceSource, "windows-log");
  assert.equal(session?.verification, "self-asserted");
  assert.ok(session);
  assert.ok(canonicalSession(session));
  assert.throws(() =>
    canonicalSession({ ...session, verification: "externally-verified" }),
  );
  assert.equal(JSON.stringify(session).includes("127.0.0.1"), false);
  assert.equal(JSON.stringify(session).includes("999"), false);
  session.placeId = "789";
  assert.equal(parser.session()?.placeId, "123");
  parser.line(
    line(
      "[FLog::UgcExperienceController] UgcExperienceController: doTeleport: joinScriptUrl",
    ).trim(),
    now,
  );
  assert.equal(parser.session(), null);
  for (const entry of joined().split("\n")) parser.line(entry, now);
  parser.line(
    line("[FLog::Network] Time to disconnect replication data: 1").trim(),
    now,
  );
  assert.equal(parser.session(), null);
});
test("stale, future, malformed, oversized and missing-universe log evidence cannot produce a session", () => {
  for (const time of [now - 120_001, now + 5_001]) {
    const parser = new PlayerLogParser();
    for (const entry of joined()
      .replaceAll(new Date(now).toISOString(), new Date(time).toISOString())
      .split("\n"))
      parser.line(entry, now);
    assert.equal(parser.session(), null);
  }
  const parser = new PlayerLogParser();
  for (const entry of joined().split("\n")) parser.line(entry, now);
  parser.line(
    line("[FLog::Output] ! Joining game 'invalid' place 0 at 0").trim(),
    now,
  );
  assert.equal(parser.session(), null);
  for (const entry of joined().split("\n")) parser.line(entry, now);
  parser.line("x".repeat(16_385), now);
  assert.equal(parser.session(), null);
});
test("read-only Windows monitor handles permission, partial append, truncation, rotation, stale evidence and recovery", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lobbymesh-log-test-"));
  const file = path.join(directory, "0.1_Player_ABCD_last.log");
  let clock = now;
  const provider = new WindowsLogSessionProvider([directory], {
    now: () => clock,
    pollMs: 10_000,
  });
  const events: unknown[] = [];
  provider.subscribe((session) => events.push(session));
  try {
    await writeFile(file, joined().slice(0, -1));
    await provider.refresh();
    assert.equal(provider.status().state, "disabled");
    await provider.setEnabled(true);
    assert.equal(provider.status().state, "incomplete");
    await appendFile(file, "\n");
    await provider.refresh();
    assert.equal(provider.status().state, "detected");
    assert.equal((await provider.current())?.jobId, job);
    await provider.refresh();
    assert.equal(events.length, 1);
    await writeFile(
      file,
      line("[FLog::SingleSurfaceApp] leaveUGCGameInternal"),
    );
    await provider.refresh();
    assert.equal(await provider.current(), null);
    await writeFile(file, joined());
    await provider.setEnabled(false);
    await provider.setEnabled(true);
    assert.equal(provider.status().state, "detected");
    const second = path.join(directory, "0.1_Player_EF01_last.log");
    await writeFile(second, joined());
    await provider.refresh();
    assert.equal(provider.status().state, "ambiguous");
    assert.equal(provider.status().reason, "multiple-player-logs");
    assert.equal(await provider.current(), null);
    await rm(file);
    await provider.refresh();
    assert.equal(provider.status().state, "detected");
    clock += 130_000;
    await provider.refresh();
    assert.equal(provider.status().state, "stale");
    assert.equal(await provider.current(), null);
    await writeFile(
      second,
      joined().replaceAll(
        new Date(now).toISOString(),
        new Date(clock).toISOString(),
      ),
    );
    await utimes(second, new Date(clock), new Date(clock));
    await provider.refresh();
    assert.equal(provider.status().state, "detected");
    await provider.stop();
    assert.equal(provider.status().state, "disabled");
    assert.equal(await provider.current(), null);
  } finally {
    await provider.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
test("bounded log reads discard huge partial lines and ignore Studio and crash handler logs", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "lobbymesh-log-bounds-"));
  const provider = new WindowsLogSessionProvider([directory], {
    now: () => now,
    pollMs: 10_000,
  });
  try {
    await writeFile(path.join(directory, "0.1_Studio_ABCD_last.log"), joined());
    await writeFile(
      path.join(directory, "0.1_Player_ABCD_CrashHandler_last.log"),
      joined(),
    );
    const file = path.join(directory, "0.1_Player_ABCD_last.log");
    await writeFile(file, joined() + "x".repeat(300_000));
    await provider.setEnabled(true);
    assert.equal(await provider.current(), null);
    await appendFile(file, `\n${joined()}`);
    await provider.refresh();
    assert.equal(provider.status().state, "detected");
    await provider.stop();
    await rm(directory, { recursive: true });
    await provider.setEnabled(true);
    assert.equal(provider.status().state, "waiting");
    await mkdir(directory);
    await writeFile(file, joined());
    await provider.refresh();
    assert.equal(provider.status().state, "detected");
    assert.equal(windowsLogDirectories(undefined).length, 0);
    assert.equal(windowsLogDirectories(directory, "linux").length, 0);
    assert.equal(windowsLogDirectories(directory, "win32").length, 2);
  } finally {
    await provider.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("large player logs scan sequentially without publishing an earlier session before catching up", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "lobbymesh-large-player-log-"),
  );
  const file = path.join(directory, "0.1_Player_ABCD_last.log");
  const provider = new WindowsLogSessionProvider([directory], {
    now: () => now,
    pollMs: 10_000,
  });
  try {
    // A disconnect after the first chunk must invalidate the apparently active head.
    const filler = line("[FLog::Network] unrelated bounded diagnostic").repeat(
      60_000,
    );
    assert.ok(Buffer.byteLength(filler) > 4 * 1024 * 1024);
    await writeFile(
      file,
      joined() +
        filler +
        line("[FLog::Network] Time to disconnect replication data: 1"),
    );
    await provider.setEnabled(true);
    assert.equal(provider.status().state, "scanning");
    assert.equal(await provider.current(), null);
    for (let n = 0; n < 4 && provider.status().state === "scanning"; n++)
      await provider.refresh();
    assert.equal(provider.status().state, "waiting");
    assert.equal(await provider.current(), null);
    await appendFile(file, joined());
    await provider.refresh();
    assert.equal(provider.status().state, "detected");
  } finally {
    await provider.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("live process lifetime accepts quiet-session evidence, withdraws on exit, and never reuses an earlier player's logs", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "lobbymesh-player-lifetime-"),
  );
  const file = path.join(directory, "0.1_Player_ABCD_last.log");
  let players = [{ startedAt: now - 160_000 }],
    failed = false;
  const provider = new WindowsLogSessionProvider([directory], {
    now: () => now,
    pollMs: 10_000,
    activity: async () => {
      if (failed) throw new Error("denied");
      return players;
    },
  });
  try {
    const oldTime = now - 150_000;
    await writeFile(
      file,
      joined().replaceAll(
        new Date(now).toISOString(),
        new Date(oldTime).toISOString(),
      ),
    );
    await utimes(file, new Date(oldTime), new Date(oldTime));
    await provider.setEnabled(true);
    assert.equal(provider.status().state, "detected");
    players = [];
    await provider.refresh();
    assert.equal(provider.status().state, "waiting");
    assert.equal(await provider.current(), null);
    players = [{ startedAt: now - 1_000 }];
    await provider.refresh();
    assert.equal(await provider.current(), null);
    // Touching an older log cannot make its pre-process join events current.
    await utimes(file, new Date(now), new Date(now));
    await provider.refresh();
    assert.equal(await provider.current(), null);
    await writeFile(file, joined());
    await provider.stop();
    await provider.setEnabled(true);
    assert.equal(provider.status().state, "detected");
    players = [{ startedAt: now - 1_000 }, { startedAt: now - 500 }];
    await provider.refresh();
    assert.equal(provider.status().state, "ambiguous");
    assert.equal(provider.status().reason, "multiple-player-processes");
    assert.equal(await provider.current(), null);
    failed = true;
    await provider.refresh();
    assert.equal(provider.status().state, "unavailable");
    assert.equal(provider.status().reason, "process-query-failed");
    failed = false;
    players = [{ startedAt: now - 1_000 }];
    await provider.refresh();
    assert.equal(provider.status().state, "detected");
  } finally {
    await provider.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("process metadata is strictly parsed, cached with copies, and failures back off without stale success", async () => {
  assert.deepEqual(parsePlayerActivity([]), []);
  for (const value of [
    null,
    {},
    [{ startedAt: "invalid" }],
    [{ startedAt: "2026-10-28T00:00:00Z", secret: "discard" }],
    Array(5).fill({ startedAt: "2026-10-28T00:00:00Z" }),
  ])
    assert.throws(() => parsePlayerActivity(value), /UNAVAILABLE/);
  let clock = 100,
    queries = 0,
    fail = false;
  const reader = createWindowsActivityReader(
    async () => {
      queries++;
      if (fail) throw new Error("unavailable");
      return [{ startedAt: 123 }];
    },
    () => clock,
  );
  const snapshot = (await reader())[0];
  assert.ok(snapshot);
  snapshot.startedAt = 999;
  assert.equal((await reader())[0]?.startedAt, 123);
  assert.equal(queries, 1);
  clock += 5_000;
  fail = true;
  await assert.rejects(reader());
  await assert.rejects(reader());
  assert.equal(queries, 2);
  clock += 5_000;
  fail = false;
  assert.equal((await reader())[0]?.startedAt, 123);
  assert.equal(queries, 3);
});

test("a preceding player's log flushed after the current process started is not admitted by modification time alone", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "lobbymesh-old-player-log-"),
  );
  const file = path.join(directory, "0.1_Player_ABCD_last.log");
  const clock = Date.now() + 20_000;
  const provider = new WindowsLogSessionProvider([directory], {
    now: () => clock,
    pollMs: 10_000,
    activity: async () => [{ startedAt: clock - 10_000 }],
  });
  try {
    await writeFile(
      file,
      joined().replaceAll(
        new Date(now).toISOString(),
        new Date(clock).toISOString(),
      ),
    );
    await utimes(file, new Date(clock), new Date(clock));
    await provider.setEnabled(true);
    assert.equal(await provider.current(), null);
    assert.equal(provider.status().state, "stale");
  } finally {
    await provider.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("disabling while a process query is pending prevents late detection from restarting the monitor", async () => {
  let finish: (value: { startedAt: number }[]) => void = () => {};
  const pending = new Promise<{ startedAt: number }[]>((resolve) => {
    finish = resolve;
  });
  const provider = new WindowsLogSessionProvider(["unused"], {
    activity: () => pending,
  });
  const enabling = provider.setEnabled(true);
  const disabling = provider.setEnabled(false);
  finish([{ startedAt: now - 1_000 }]);
  await Promise.all([enabling, disabling]);
  assert.equal(provider.status().state, "disabled");
  assert.equal(await provider.current(), null);
});
