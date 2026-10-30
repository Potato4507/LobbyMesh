import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
test(
  "Windows verification preserves dirty source and a preexisting lock before launching any checks",
  { skip: process.platform !== "win32" },
  async (t) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "lobbymesh-windows-verify-"),
    );
    t.after(async () => {
      assert.equal(path.dirname(directory), path.resolve(tmpdir()));
      assert.ok(
        path.basename(directory).startsWith("lobbymesh-windows-verify-"),
      );
      await rm(directory, { recursive: true, force: true });
    });
    await mkdir(path.join(directory, "scripts"));
    await mkdir(path.join(directory, "dist"));
    const script = path.join(directory, "scripts", "verify-windows.ps1"),
      work = path.join(directory, "user-work.txt"),
      lock = path.join(directory, "dist", "windows-verification.lock");
    await copyFile("scripts/verify-windows.ps1", script);
    await writeFile(work, "preserve user-owned work\n");
    await writeFile(lock, "a lock this invocation does not own\n");
    await writeFile(path.join(directory, ".gitignore"), "dist/\n");
    await execute("git", ["init", "-q", directory], { timeout: 10000 });
    const before = (await readdir(directory))
      .filter((name) => name !== ".git")
      .sort();
    async function denied(reason: string) {
      await assert.rejects(
        execute("pwsh", ["-NoProfile", "-File", script], {
          cwd: directory,
          timeout: 10000,
          maxBuffer: 16384,
        }),
        (error: unknown) => {
          assert.ok(
            error instanceof Error &&
              "stdout" in error &&
              typeof error.stdout === "string" &&
              "code" in error,
          );
          assert.equal(error.code, 1);
          const summary = JSON.parse(error.stdout);
          assert.equal(summary.result, "failed");
          assert.equal(summary.stage, "preflight");
          assert.equal(summary.reason, reason);
          assert.equal(summary.releaseReady, false);
          assert.deepEqual(summary.steps, []);
          return true;
        },
      );
      assert.equal(await readFile(work, "utf8"), "preserve user-owned work\n");
      assert.equal(
        await readFile(lock, "utf8"),
        "a lock this invocation does not own\n",
      );
      assert.deepEqual(
        (await readdir(directory)).filter((name) => name !== ".git").sort(),
        before,
      );
      assert.deepEqual(await readdir(path.join(directory, "dist")), [
        "windows-verification.lock",
      ]);
    }
    await denied("WINDOWS_VERIFICATION_DIRTY_SOURCE");
    await execute(
      "git",
      [
        "-C",
        directory,
        "add",
        ".gitignore",
        "scripts/verify-windows.ps1",
        "user-work.txt",
      ],
      { timeout: 10000 },
    );
    await execute(
      "git",
      [
        "-C",
        directory,
        "-c",
        "user.name=Verification fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "fixture",
      ],
      { timeout: 10000 },
    );
    await denied("WINDOWS_VERIFICATION_BUSY");
  },
);
