import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { desktopEvidencePath } from "../scripts/desktop-evidence.js";
import {
  desktopSmokeModes,
  desktopSmokeProcessTimeoutMs,
} from "../scripts/desktop-modes.js";

test("default desktop runs retain every original mode plus isolated voice with the same process budget", () => {
  assert.equal(desktopSmokeProcessTimeoutMs, 30000);
  assert.deepEqual(desktopSmokeModes("win32", ""), [
    "",
    "voice-controls-only",
    "conversation-clear-only",
    "session-status-only",
    "overlay-capture-only",
    "incoming-call-only",
    "credentials-only",
  ]);
  assert.deepEqual(desktopSmokeModes("linux", ""), [
    "",
    "voice-controls-only",
    "conversation-clear-only",
    "session-status-only",
    "incoming-call-only",
  ]);
  assert.deepEqual(desktopSmokeModes("win32", "voice-controls-only"), [
    "voice-controls-only",
  ]);
});

const execute = promisify(execFile);
test("native evidence maps canonical image names into the run directory without changing their identity", () => {
  const directory = path.resolve("dist", "isolated native evidence");
  assert.equal(
    desktopEvidencePath(directory, "docs/evidence/lobbymesh-overlay-test.png"),
    path.join(directory, "lobbymesh-overlay-test.png"),
  );
  assert.equal(
    desktopEvidencePath(
      directory,
      path.resolve("docs/evidence/lobbymesh-settings.png"),
    ),
    path.join(directory, "lobbymesh-settings.png"),
  );
  assert.equal(
    desktopEvidencePath(
      path.resolve("docs/evidence"),
      "docs/evidence/lobbymesh-settings.png",
    ),
    path.resolve("docs/evidence/lobbymesh-settings.png"),
  );
});
test("native evidence rejects relative destinations, foreign files and noncanonical filenames", () => {
  for (const [directory, source] of [
    ["dist/output", "docs/evidence/lobbymesh-settings.png"],
    [path.resolve("dist/output"), "docs/lobbymesh-settings.png"],
    [path.resolve("dist/output"), "docs/evidence/../lobbymesh-settings.png"],
    [path.resolve("dist/output"), "docs/evidence/manifest.json"],
    [path.resolve("dist/output"), "docs/evidence/other.png"],
    [path.resolve("dist/output"), "docs/evidence/lobbymesh-../file.png"],
  ]) {
    assert.ok(directory);
    assert.ok(source);
    assert.throws(
      () => desktopEvidencePath(directory, source),
      /^Error: INVALID_DESKTOP_EVIDENCE_PATH$/,
    );
  }
});
test("desktop driver rejects unknown, conflicting and duplicate options before creating evidence or launching Electron", async (t) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "lobbymesh-cli-options-"),
  );
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("lobbymesh-cli-options-"));
    await rm(directory, { recursive: true, force: true });
  });
  for (const args of [
    ["--unknown"],
    ["--voice-controls-only", "--voice-controls-only"],
    ["--voice-controls-only", "--incoming-call-only"],
    ["--update-evidence", "--update-evidence"],
    ["--session-status-only", "--overlay-capture-only"],
    ["--conversation-clear-only", "--conversation-clear-only"],
    ["--incoming-call-only", "--incoming-call-only"],
    ["--incoming-call-only", "--overlay-capture-only"],
    ["--evidence-directory", "docs/evidence"],
  ])
    await assert.rejects(
      execute(
        process.execPath,
        [path.resolve("scripts/desktop-smoke.mjs"), ...args],
        {
          cwd: directory,
          timeout: 5000,
          maxBuffer: 16384,
        },
      ),
      (error: unknown) =>
        error instanceof Error &&
        "stderr" in error &&
        typeof error.stderr === "string" &&
        error.stderr.includes("INVALID_DESKTOP_SMOKE_OPTIONS"),
    );
  assert.deepEqual(await readdir(directory), []);
});
