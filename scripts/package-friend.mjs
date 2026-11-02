import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { friendInstallerScript } from "./friend-installer.ts";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length && args[0] !== "--development"))
  throw new Error("INVALID_FRIEND_PACKAGE_OPTIONS");
if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("WINDOWS_X64_REQUIRED");
const run = promisify(execFile),
  root = process.cwd(),
  development = args.includes("--development");
const execute = (file, args, options = {}) =>
  run(file, args, {
    cwd: root,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    timeout: 180000,
    ...options,
  });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const dirty = (await execute("git", ["status", "--porcelain"])).stdout.trim();
if (dirty && !development)
  throw new Error("FRIEND_PACKAGE_CLEAN_SOURCE_REQUIRED");
const installerRevision = (
  await execute("git", ["rev-parse", "HEAD"])
).stdout.trim();
const verified = JSON.parse(
  await readFile(
    "docs/evidence/windows-lan-repair-complete-summary.json",
    "utf8",
  ),
);
assert.equal(verified.result, "passed");
const packageDirectory = path.resolve(root, verified.package.directory);
if (!packageDirectory.startsWith(`${path.resolve(root, "dist")}${path.sep}`))
  throw new Error("VERIFIED_PACKAGE_OUTSIDE_DIST");
const manifestBytes = await readFile(
  path.join(packageDirectory, "manifest.json"),
);
assert.equal(sha(manifestBytes), verified.package.manifestSha256);
const manifest = JSON.parse(manifestBytes.toString());
assert.equal(manifest.git.dirty, false);
const runtimeDiff = (
  await execute("git", [
    "diff",
    "--name-only",
    manifest.git.revision,
    "--",
    "apps",
    "packages",
    "patches",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "scripts/build.mjs",
  ])
).stdout.trim();
if (runtimeDiff) throw new Error("VERIFIED_RUNTIME_OUTDATED");
await execute(process.execPath, [
  "scripts/verify-windows-package.mjs",
  packageDirectory,
  "--manifest-sha256",
  verified.package.manifestSha256,
]);

const id = randomUUID().replaceAll("-", "");
const build = path.resolve(
  root,
  "dist",
  `friend-setup-${Date.now()}-${id.slice(0, 8)}`,
);
await mkdir(build);
const delivery = path.join(build, "delivery");
await mkdir(delivery);
const cache = path.resolve(root, "dist", "installer-tools");
await mkdir(cache, { recursive: true });
const archive = path.join(cache, "nsis-3.13.zip");
const archivePin =
  "ba63dffc4410ee89193e1cb5a41989991bd77c61068da17e3156d136b7b0b3d8";
let archiveBytes;
try {
  archiveBytes = await readFile(archive);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  const response = await fetch(
    "https://downloads.sourceforge.net/project/nsis/NSIS%203/3.13/nsis-3.13.zip",
  );
  if (!response.ok) throw new Error(`NSIS_DOWNLOAD_${response.status}`);
  archiveBytes = Buffer.from(await response.arrayBuffer());
  if (sha(archiveBytes) !== archivePin)
    throw new Error("NSIS_ARCHIVE_HASH_MISMATCH");
  await writeFile(archive, archiveBytes, { flag: "wx" });
}
if (sha(archiveBytes) !== archivePin)
  throw new Error("NSIS_ARCHIVE_HASH_MISMATCH");
const tool = path.join(build, "compiler");
await mkdir(tool);
const entries = (await execute("tar", ["-tf", archive])).stdout
  .trim()
  .split(/\r?\n/);
if (
  entries.length > 5000 ||
  entries.some(
    (file) => !file.startsWith("nsis-3.13/") || file.split("/").includes(".."),
  )
)
  throw new Error("UNSAFE_NSIS_ARCHIVE");
await execute("tar", ["-xf", archive, "-C", tool]);
const compiler = path.join(tool, "nsis-3.13", "makensis.exe");
const compilerPin =
  "4ec390d0f96f9728507fbc2f4e91311dd90bfc6c8ddfe2159357b3651ae151c0";
assert.equal(sha(await readFile(compiler)), compilerPin);
const executable = path.join(delivery, "LobbyMesh-Setup.exe");
const script = path.join(build, "setup.nsi");
const files = [...manifest.files.map((file) => file.path), "manifest.json"];
await writeFile(
  script,
  friendInstallerScript({
    packageDirectory,
    outputExecutable: executable,
    instructions: path.join(root, "docs/FRIEND_QUICK_START.txt"),
    notices: path.join(tool, "nsis-3.13/COPYING"),
    smokeId: id,
    files,
  }),
);
console.log(
  JSON.stringify({
    stage: "compiling-private-setup",
    runtime: manifest.git.revision,
    files: files.length,
  }),
);
const compiled = await execute(compiler, ["/NOCONFIG", "/V2", script]);
await writeFile(
  path.join(build, "compiler.log"),
  compiled.stdout + compiled.stderr,
);

const install = path.join(tmpdir(), `lobbymesh-installer-smoke-${id}`);
const profile = await mkdtemp(path.join(tmpdir(), "lobbymesh-packaged-smoke-"));
let proof,
  uninstallVerified = false,
  unknownFilePreserved = false,
  profilePreserved = false;
try {
  assert.equal(path.dirname(install), path.resolve(tmpdir()));
  await assert.rejects(access(install));
  await execute(executable, ["/S", "/LOBBYMESH_SMOKE"]);
  const installedApp = path.join(install, "App");
  await execute(process.execPath, [
    "scripts/verify-windows-package.mjs",
    installedApp,
    "--manifest-sha256",
    verified.package.manifestSha256,
  ]);
  const env = { ...process.env };
  for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH"])
    delete env[key];
  const launched = await execute(
    path.join(installedApp, "LobbyMesh.exe"),
    ["--lobbymesh-smoke-profile", profile],
    { cwd: installedApp, env, timeout: 30000 },
  );
  const marker = launched.stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("LOBBYMESH_PACKAGED_SMOKE "));
  assert.ok(marker);
  proof = JSON.parse(marker.slice("LOBBYMESH_PACKAGED_SMOKE ".length));
  assert.equal(proof.result, "passed");
  assert.equal(proof.network, "offline");
  assert.equal(proof.microphone, "off");
  const sentinel = path.join(installedApp, "user-kept.txt");
  await writeFile(sentinel, "preserve unrelated files");
  const profileSentinel = path.join(profile, "preserved-profile.txt");
  await writeFile(profileSentinel, "preserve settings and keys");
  await execute(path.join(install, "Uninstall.exe"), ["/S"]);
  const deadline = Date.now() + 10000;
  const removedPaths = [
    ...files.map((file) => path.join(installedApp, file)),
    ...["START-HERE.txt", "INSTALLER-LICENSES.txt", "Uninstall.exe"].map(
      (file) => path.join(install, file),
    ),
  ];
  for (;;) {
    const remaining = await Promise.all(
      removedPaths.map(async (file) => {
        try {
          await access(file);
          return true;
        } catch {
          return false;
        }
      }),
    );
    if (remaining.every((exists) => !exists)) break;
    if (Date.now() >= deadline) throw new Error("UNINSTALL_TIMEOUT");
    await delay(100);
  }
  // The uninstaller's detached copy can finish after its initial launcher exits.
  for (const relative of files)
    await assert.rejects(access(path.join(installedApp, relative)));
  unknownFilePreserved =
    (await readFile(sentinel, "utf8")) === "preserve unrelated files";
  profilePreserved =
    (await readFile(profileSentinel, "utf8")) === "preserve settings and keys";
  assert.ok(unknownFilePreserved && profilePreserved);
  uninstallVerified = true;
  await rm(sentinel);
  await rmdir(installedApp);
  await rmdir(install);
} finally {
  assert.equal(path.dirname(profile), path.resolve(tmpdir()));
  assert.ok(path.basename(profile).startsWith("lobbymesh-packaged-smoke-"));
  await rm(profile, { recursive: true, force: true });
}
const setupSha256 = sha(await readFile(executable));
const signature = (
  await execute(
    "pwsh",
    [
      "-NoProfile",
      "-Command",
      "(Get-AuthenticodeSignature -LiteralPath $env:LOBBYMESH_INSTALLER_CHECK).Status.ToString()",
    ],
    { env: { ...process.env, LOBBYMESH_INSTALLER_CHECK: executable } },
  )
).stdout.trim();
await writeFile(
  path.join(delivery, "LobbyMesh-Setup.exe.sha256"),
  `${setupSha256}  LobbyMesh-Setup.exe\n`,
);
await writeFile(
  path.join(delivery, "START-HERE.txt"),
  await readFile("docs/FRIEND_QUICK_START.txt"),
);
const result = {
  result: "private-friend-setup-passed",
  installerSource: { revision: installerRevision, dirty: Boolean(dirty) },
  runtimeSource: manifest.git,
  executable,
  setupSha256,
  signature,
  runtimeManifestSha256: verified.package.manifestSha256,
  compiler: {
    version: "3.13",
    archiveSha256: archivePin,
    executableSha256: compilerPin,
  },
  smoke: {
    installedPayloadIntegrity: true,
    installedExecutable: proof,
    uninstallVerified,
    unknownFilePreserved,
    profilePreserved,
    administrativePrivileges: false,
    realProfileTouched: false,
    realShortcutsTested: false,
  },
  hardwareAudio: false,
  realExternal: false,
  releaseReady: false,
};
await writeFile(
  path.join(build, "summary.json"),
  `${JSON.stringify(result, null, 2)}\n`,
);
await writeFile(
  "dist/friend-setup-latest.json",
  `${JSON.stringify(
    {
      directory: delivery,
      summary: path.join(build, "summary.json"),
      executable,
      setupSha256,
    },
    null,
    2,
  )}\n`,
);
console.log(JSON.stringify(result));
