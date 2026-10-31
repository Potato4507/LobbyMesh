import assert from "node:assert/strict";
import fs, {
  appendFile,
  mkdir,
  mkdtemp,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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

test(
  "consent withdrawal stops candidate opens after the current filesystem operation and closes its handle",
  { timeout: 5000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "lobbymesh-log-optout-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeFile(path.join(directory, "0.1_Player_AAAA_last.log"), joined());
    await writeFile(path.join(directory, "0.1_Player_BBBB_last.log"), joined());
    const provider = new WindowsLogSessionProvider([directory], {
      now: () => now,
      pollMs: 10000,
    });
    const originalOpen = fs.open;
    let opens = 0,
      finish: () => void = () => {},
      opened: () => void = () => {};
    let heldHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
    const held = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const mocked = t.mock.method(
      fs,
      "open",
      async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        if (String(args[0]).startsWith(directory)) {
          opens++;
          if (opens === 1) {
            heldHandle = handle;
            opened();
            await gate;
          }
        }
        return handle;
      },
    );
    syncBuiltinESMExports();
    try {
      const enabling = provider.setEnabled(true);
      await held;
      const stopping = provider.stop();
      assert.equal(provider.status().state, "disabled");
      assert.equal(await provider.current(), null);
      finish();
      await Promise.all([enabling, stopping]);
      assert.equal(opens, 1);
      assert.ok(heldHandle);
      await assert.rejects(heldHandle.stat(), /closed|EBADF/);
      await provider.setEnabled(true);
      assert.equal(provider.status().state, "ambiguous");
      assert.equal(provider.status().reason, "multiple-player-logs");
    } finally {
      finish();
      mocked.mock.restore();
      syncBuiltinESMExports();
      await provider.stop();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
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

test(
  "consent withdrawal while a directory open is pending closes it before enumeration",
  { timeout: 5000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "lobbymesh-log-dir-optout-"),
    );
    t.after(() => rm(directory, { recursive: true, force: true }));
    const provider = new WindowsLogSessionProvider([directory], {
      pollMs: 10000,
    });
    const original = fs.opendir;
    let finish: () => void = () => {},
      opened: () => void = () => {},
      iterations = 0;
    let heldDir: Awaited<ReturnType<typeof fs.opendir>> | undefined;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const mocked = t.mock.method(
      fs,
      "opendir",
      async (...args: Parameters<typeof fs.opendir>) => {
        const handle = await original(...args);
        if (String(args[0]) === directory) {
          heldDir = handle;
          const iterator = handle[Symbol.asyncIterator].bind(handle);
          handle[Symbol.asyncIterator] = () => {
            iterations++;
            return iterator();
          };
          opened();
          await gate;
        }
        return handle;
      },
    );
    syncBuiltinESMExports();
    try {
      const enabling = provider.setEnabled(true);
      await ready;
      const stopping = provider.stop();
      finish();
      await Promise.all([enabling, stopping]);
      assert.equal(iterations, 0);
      assert.ok(heldDir);
      await assert.rejects(heldDir.read(), /closed|ERR_DIR_CLOSED/);
      assert.equal(provider.status().state, "disabled");
      assert.equal(await provider.current(), null);
    } finally {
      finish();
      mocked.mock.restore();
      syncBuiltinESMExports();
      await provider.stop();
    }
  },
);
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
test("same-inode larger log rewrites withdraw the old session before reparsing current evidence", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "lobbymesh-log-rewrite-"),
  );
  const file = path.join(directory, "0.1_Player_AAAA_last.log");
  const writer = await fs.open(file, "w+");
  const provider = new WindowsLogSessionProvider([directory], {
    pollMs: 10000,
  });
  const events: (string | null)[] = [];
  provider.subscribe((value) => events.push(value?.jobId ?? null));
  try {
    await writer.writeFile(joined());
    await writer.sync();
    const original = await writer.stat();
    await provider.setEnabled(true);
    assert.equal((await provider.current())?.jobId, job);
    const rewrite = async (text: string) => {
      await writer.truncate(0);
      const data = Buffer.from(text);
      assert.equal(
        (await writer.write(data, 0, data.length, 0)).bytesWritten,
        data.length,
      );
      await writer.sync();
      const current = await writer.stat();
      assert.deepEqual(
        [current.dev, current.ino, current.birthtimeMs],
        [original.dev, original.ino, original.birthtimeMs],
      );
      assert.ok(current.size >= original.size);
    };
    const unrelated = "current log without supported session evidence\n".repeat(
      32,
    );
    await rewrite(unrelated);
    await provider.refresh();
    assert.equal(await provider.current(), null);
    assert.equal(events.at(-1), null);
    const nextJob = "87654321-dcba-4321-dcba-cba987654321";
    await rewrite(joined().replaceAll(job, nextJob) + unrelated.repeat(2));
    await provider.refresh();
    assert.equal((await provider.current())?.jobId, nextJob);
    assert.deepEqual(events, [job, null, nextJob]);
  } finally {
    await provider.stop();
    await writer.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("lobbymesh-log-rewrite-"));
    await rm(directory, { recursive: true, force: true });
  }
});
test("rewritten engine evidence cannot keep an old session when prefix, tail and file length stay unchanged", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "lobbymesh-log-evidence-rewrite-"),
  );
  const file = path.join(directory, "0.1_Player_AAAA_last.log");
  const prefix = "startup record without session details\n".repeat(16),
    tail = "quiet unchanged log suffix\n".repeat(32);
  const provider = new WindowsLogSessionProvider([directory], {
    pollMs: 10000,
  });
  try {
    await writeFile(file, prefix + joined() + tail);
    const original = await fs.stat(file);
    await provider.setEnabled(true);
    assert.equal((await provider.current())?.jobId, job);
    const nextJob = "87654321-dcba-4321-dcba-cba987654321";
    await writeFile(file, prefix + joined().replaceAll(job, nextJob) + tail);
    const rewritten = await fs.stat(file);
    assert.deepEqual(
      [rewritten.dev, rewritten.ino, rewritten.birthtimeMs, rewritten.size],
      [original.dev, original.ino, original.birthtimeMs, original.size],
    );
    await provider.refresh();
    assert.equal((await provider.current())?.jobId, nextJob);
  } finally {
    await provider.stop();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(
      path.basename(directory).startsWith("lobbymesh-log-evidence-rewrite-"),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
test("short appends and quiet polls preserve a current session without spurious withdrawal", async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), "lobbymesh-log-continuity-"),
    ),
    file = path.join(directory, "0.1_Player_AAAA_last.log");
  const provider = new WindowsLogSessionProvider([directory], {
      pollMs: 10000,
    }),
    events: (string | null)[] = [];
  provider.subscribe((value) => events.push(value?.jobId ?? null));
  try {
    await writeFile(file, joined());
    await provider.setEnabled(true);
    for (const text of [
      "\n",
      "x",
      "\n",
      line("[FLog::Output] unrelated current engine output"),
    ]) {
      await appendFile(file, text);
      await provider.refresh();
      assert.equal((await provider.current())?.jobId, job);
    }
    await provider.refresh();
    assert.deepEqual(events, [job]);
  } finally {
    await provider.stop();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("lobbymesh-log-continuity-"));
    await rm(directory, { recursive: true, force: true });
  }
});
test("session evidence split through a UTF-8 codepoint at the read boundary retains exact byte ownership", async () => {
  const directory = await mkdtemp(
      path.join(tmpdir(), "lobbymesh-log-byte-boundary-"),
    ),
    file = path.join(directory, "0.1_Player_AAAA_last.log");
  const provider = new WindowsLogSessionProvider([directory], {
    pollMs: 10000,
  });
  try {
    const joining = line(
      `[FLog::Output] ! Joining game '${job}' place 123 at 127.0.0.1`,
    );
    const universePrefix = line(
      "[FLog::GameJoinLoadTime] Report game_join_loadtime: universeid:456, label:",
    ).trimEnd();
    const prefixLength =
      4 * 1024 * 1024 -
      Buffer.byteLength(joining) -
      Buffer.byteLength(universePrefix) -
      1;
    const prefix = Buffer.alloc(prefixLength, 32);
    prefix[prefix.length - 1] = 10;
    await writeFile(
      file,
      Buffer.concat([
        prefix,
        Buffer.from(
          `${joining}${universePrefix}😀\n${line("[FLog::Network] Replicator created: serverId: 127.0.0.1|1")}`,
        ),
      ]),
    );
    await provider.setEnabled(true);
    assert.equal(provider.status().state, "scanning");
    assert.equal(await provider.current(), null);
    await provider.refresh();
    assert.equal((await provider.current())?.jobId, job);
    await provider.refresh();
    assert.equal((await provider.current())?.jobId, job);
  } finally {
    await provider.stop();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(
      path.basename(directory).startsWith("lobbymesh-log-byte-boundary-"),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
test(
  "withdrawal during a continuity read closes the handle and prevents later evidence reads or publication",
  { timeout: 5000 },
  async (t) => {
    const directory = await mkdtemp(
        path.join(tmpdir(), "lobbymesh-log-checkpoint-stop-"),
      ),
      file = path.join(directory, "0.1_Player_AAAA_last.log");
    const provider = new WindowsLogSessionProvider([directory], {
      pollMs: 10000,
    });
    let reads = 0,
      finish: () => void = () => {},
      opened: () => void = () => {},
      heldHandle: Awaited<ReturnType<typeof fs.open>> | undefined,
      refreshing: Promise<void> | undefined,
      restore = () => {};
    const gate = new Promise<void>((resolve) => {
        finish = resolve;
      }),
      ready = new Promise<void>((resolve) => {
        opened = resolve;
      });
    try {
      await writeFile(file, joined());
      await provider.setEnabled(true);
      const originalOpen = fs.open;
      const mocked = t.mock.method(
        fs,
        "open",
        async (...args: Parameters<typeof fs.open>) => {
          const handle = await originalOpen(...args);
          if (String(args[0]) === file) {
            const originalRead = handle.read.bind(handle);
            handle.read = (async (
              buffer: Buffer,
              offset: number,
              length: number,
              position: number,
            ) => {
              const result = await originalRead(
                buffer,
                offset,
                length,
                position,
              );
              reads++;
              if (reads === 1) {
                heldHandle = handle;
                opened();
                await gate;
              }
              return result;
            }) as typeof handle.read;
          }
          return handle;
        },
      );
      syncBuiltinESMExports();
      restore = () => {
        mocked.mock.restore();
        syncBuiltinESMExports();
      };
      refreshing = provider.refresh();
      await ready;
      const stopping = provider.stop();
      let duplicateSettled = false;
      const duplicateStop = provider.stop().then(() => {
        duplicateSettled = true;
      });
      assert.equal(provider.status().state, "disabled");
      assert.equal(await provider.current(), null);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(
        duplicateSettled,
        false,
        "duplicate Stop must await the owned file handle cleanup",
      );
      finish();
      await Promise.all([refreshing, stopping, duplicateStop]);
      assert.equal(duplicateSettled, true);
      assert.equal(reads, 1);
      assert.equal(await provider.current(), null);
      assert.ok(heldHandle);
      await assert.rejects(heldHandle.stat(), /closed|EBADF/);
    } finally {
      finish();
      restore();
      await refreshing;
      await provider.stop();
      assert.equal(path.dirname(directory), path.resolve(tmpdir()));
      assert.ok(
        path.basename(directory).startsWith("lobbymesh-log-checkpoint-stop-"),
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
);
test(
  "evidence changed by a writer during the scan is rechecked before any session is published",
  { timeout: 5000 },
  async (t) => {
    const directory = await mkdtemp(
        path.join(tmpdir(), "lobbymesh-log-racing-writer-"),
      ),
      file = path.join(directory, "0.1_Player_AAAA_last.log");
    const provider = new WindowsLogSessionProvider([directory], {
        pollMs: 10000,
      }),
      nextJob = "87654321-dcba-4321-dcba-cba987654321",
      events: (string | null)[] = [];
    provider.subscribe((value) => events.push(value?.jobId ?? null));
    let rewritten = false,
      restore = () => {};
    try {
      await writeFile(file, joined());
      const originalOpen = fs.open;
      const mocked = t.mock.method(
        fs,
        "open",
        async (...args: Parameters<typeof fs.open>) => {
          const handle = await originalOpen(...args);
          if (String(args[0]) === file) {
            const originalRead = handle.read.bind(handle);
            handle.read = (async (
              buffer: Buffer,
              offset: number,
              length: number,
              position: number,
            ) => {
              const result = await originalRead(
                buffer,
                offset,
                length,
                position,
              );
              if (!rewritten && result.bytesRead > 0) {
                rewritten = true;
                await writeFile(file, joined().replaceAll(job, nextJob));
              }
              return result;
            }) as typeof handle.read;
          }
          return handle;
        },
      );
      syncBuiltinESMExports();
      restore = () => {
        mocked.mock.restore();
        syncBuiltinESMExports();
      };
      await provider.setEnabled(true);
      assert.equal(rewritten, true);
      assert.equal(await provider.current(), null);
      assert.deepEqual(events, []);
      await provider.refresh();
      assert.equal((await provider.current())?.jobId, nextJob);
      assert.deepEqual(events, [nextJob]);
    } finally {
      restore();
      await provider.stop();
      assert.equal(path.dirname(directory), path.resolve(tmpdir()));
      assert.ok(
        path.basename(directory).startsWith("lobbymesh-log-racing-writer-"),
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
);
test(
  "a source-change subscriber can withdraw consent before rewritten contents are reparsed",
  { timeout: 5000 },
  async (t) => {
    const directory = await mkdtemp(
        path.join(tmpdir(), "lobbymesh-log-subscriber-stop-"),
      ),
      file = path.join(directory, "0.1_Player_AAAA_last.log");
    const provider = new WindowsLogSessionProvider([directory], {
      pollMs: 10000,
    });
    let armed = false,
      reads = 0,
      stopping: Promise<void> | undefined,
      restore = () => {};
    provider.subscribe((value) => {
      if (armed && value === null) stopping = provider.stop();
    });
    try {
      await writeFile(file, joined());
      await provider.setEnabled(true);
      await writeFile(file, "rewritten unrelated contents\n".repeat(32));
      const originalOpen = fs.open;
      const mocked = t.mock.method(
        fs,
        "open",
        async (...args: Parameters<typeof fs.open>) => {
          const handle = await originalOpen(...args);
          if (String(args[0]) === file) {
            const originalRead = handle.read.bind(handle);
            handle.read = (async (
              buffer: Buffer,
              offset: number,
              length: number,
              position: number,
            ) => {
              reads++;
              return originalRead(buffer, offset, length, position);
            }) as typeof handle.read;
          }
          return handle;
        },
      );
      syncBuiltinESMExports();
      restore = () => {
        mocked.mock.restore();
        syncBuiltinESMExports();
      };
      armed = true;
      await provider.refresh();
      assert.ok(stopping);
      await stopping;
      assert.equal(reads, 1);
      assert.equal(provider.status().state, "disabled");
      assert.equal(await provider.current(), null);
    } finally {
      restore();
      await provider.stop();
      assert.equal(path.dirname(directory), path.resolve(tmpdir()));
      assert.ok(
        path.basename(directory).startsWith("lobbymesh-log-subscriber-stop-"),
      );
      await rm(directory, { recursive: true, force: true });
    }
  },
);
