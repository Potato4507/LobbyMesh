import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { desktopEvidencePath } from "../scripts/desktop-evidence.js";

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
    ["--update-evidence", "--update-evidence"],
    ["--session-status-only", "--overlay-capture-only"],
    ["--conversation-clear-only", "--conversation-clear-only"],
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
