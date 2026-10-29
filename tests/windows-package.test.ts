import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execute = promisify(execFile);
const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "lobbymesh-package-verifier-"),
  );
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, "payload.txt"),
    manifestFile = path.join(directory, "manifest.json");
  const manifest = {
    version: 1,
    platform: "win32-x64",
    files: [{ path: "payload.txt", bytes: 4, sha256: digest("data") }],
    git: { revision: "fixture", dirty: true },
    smoke: { result: "fixture-only" },
  };
  await writeFile(file, "data");
  await writeFile(manifestFile, JSON.stringify(manifest));
  const pin = digest(await readFile(manifestFile));
  const run = async (args: string[] = []) =>
    JSON.parse(
      (
        await execute(
          process.execPath,
          [
            path.resolve("scripts/verify-windows-package.mjs"),
            directory,
            ...args,
          ],
          { maxBuffer: 64 * 1024 },
        )
      ).stdout,
    );
  return { directory, file, manifest, manifestFile, pin, run };
}
test("package verification accepts an explicit manifest pin and rejects coordinated file/manifest tampering", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.run()).manifestPinned, false);
  const original = await f.run(["--manifest-sha256", f.pin.toUpperCase()]);
  assert.equal(original.manifestPinned, true);
  assert.equal(original.manifestSha256, f.pin);
  await writeFile(f.file, "edit");
  await assert.rejects(f.run(), /PACKAGE_HASH_MISMATCH/);
  const entry = f.manifest.files[0];
  assert.ok(entry);
  entry.sha256 = digest("edit");
  await writeFile(f.manifestFile, JSON.stringify(f.manifest));
  assert.equal((await f.run()).result, "package-integrity-passed");
  await assert.rejects(
    f.run(["--manifest-sha256", f.pin]),
    /MANIFEST_DIGEST_MISMATCH/,
  );
});
test("package verifier rejects malformed options, empty manifests, unsafe entries, missing and unexpected files", async (t) => {
  const f = await fixture(t);
  for (const args of [
    ["--manifest-sha256"],
    ["--manifest-sha256", "bad"],
    ["--unknown", f.pin],
    ["--manifest-sha256", f.pin, "extra"],
  ])
    await assert.rejects(f.run(args), /INVALID_PACKAGE_VERIFY_OPTIONS/);
  await writeFile(path.join(f.directory, "extra.txt"), "extra");
  await assert.rejects(f.run(), /UNEXPECTED_PACKAGE_FILE/);
  await rm(path.join(f.directory, "extra.txt"));
  await rm(f.file);
  await assert.rejects(f.run(), /MISSING_PACKAGE_FILES/);
  for (const files of [
    [],
    [null],
    [{ path: "../outside", bytes: 0, sha256: "a".repeat(64) }],
  ]) {
    await writeFile(f.manifestFile, JSON.stringify({ ...f.manifest, files }));
    await assert.rejects(f.run(), /INVALID_MANIFEST/);
  }
});
