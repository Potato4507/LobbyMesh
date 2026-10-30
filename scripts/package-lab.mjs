import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createSocket } from "node:dgram";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { controlLabPeer } from "./lab/client.ts";
import { copyProductionDependencies } from "./production-dependencies.ts";

if (process.argv.length !== 2) throw new Error("INVALID_LAB_PACKAGE_OPTIONS");
const root = process.cwd();
const project = JSON.parse(await readFile("package.json", "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(project.dependencies?.hyperdht ?? ""))
  throw new Error("LAB_DEPENDENCY_PIN_REQUIRED");
await mkdir("dist", { recursive: true });
const output = path.resolve("dist", `LobbyMesh-headless-${Date.now()}`);
await mkdir(output);
await writeFile(
  path.join(output, "package.json"),
  JSON.stringify(
    {
      name: "lobbymesh-private-headless-lab",
      version: "0.1.0",
      private: true,
      type: "module",
      engines: { node: ">=24 <25" },
      dependencies: { hyperdht: project.dependencies.hyperdht },
    },
    null,
    2,
  ),
);
const bundled = await build({
  entryPoints: ["scripts/lab-peer.ts"],
  outfile: path.join(output, "lab-peer.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  external: ["hyperdht"],
  metafile: true,
  banner: {
    js: "import { createRequire as __labCreateRequire } from 'node:module'; const require = __labCreateRequire(import.meta.url);",
  },
});
if (
  Object.keys(bundled.metafile.inputs).some((file) =>
    /(?:^|[/\\])node_modules[/\\]electron(?:[/\\]|$)/.test(file),
  )
)
  throw new Error("LAB_PACKAGE_ELECTRON_NOT_ALLOWED");
const dependencies = await copyProductionDependencies(root, output, output);
if (
  !dependencies.rows.some(
    (row) =>
      row.path === "node_modules/hyperdht" &&
      row.version === project.dependencies.hyperdht,
  )
)
  throw new Error("LAB_DEPENDENCY_PIN_MISMATCH");
assert.equal(
  dependencies.rows.some((row) => row.name === "electron"),
  false,
);
await writeFile(
  path.join(output, "LAB-ONLY.txt"),
  "Private synthetic headless lab. Requires Node24; no runtime included. No Electron or audio capture. Ephemeral identities and explicit local lab approval only. No host, firewall, account or service changes. ARM64 binaries are inventoried, not execution proof. Not a public release. Upstream licenses remain with their packages.\n",
);
const files = [];
async function inventory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name),
      info = await lstat(file);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
      throw new Error("LAB_PACKAGE_UNSAFE_ENTRY");
    if (info.isDirectory()) await inventory(file);
    else {
      const bytes = await readFile(file);
      files.push({
        path: path.relative(output, file).replaceAll(path.sep, "/"),
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
}
await inventory(output);
files.sort((a, b) => a.path.localeCompare(b.path));
const arm64 = [];
for (const name of ["udx-native", "sodium-native"]) {
  const row = files.find(
    (f) =>
      f.path.endsWith(
        `/node_modules/${name}/prebuilds/linux-arm64/${name}.node`,
      ) || f.path === `node_modules/${name}/prebuilds/linux-arm64/${name}.node`,
  );
  if (!row) throw new Error("LAB_ARM64_PREBUILD_MISSING");
  const bytes = await readFile(path.join(output, row.path));
  if (
    bytes.subarray(0, 4).toString("hex") !== "7f454c46" ||
    bytes[4] !== 2 ||
    bytes[5] !== 1 ||
    bytes.readUInt16LE(18) !== 183
  )
    throw new Error("LAB_ARM64_PREBUILD_INVALID");
  arm64.push({ name, path: row.path, sha256: row.sha256 });
}
const socket = createSocket("udp4");
await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const env = { ...process.env };
for (const key of ["NODE_PATH", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"])
  delete env[key];
const peer = controlLabPeer(
  spawn(
    process.execPath,
    [
      path.join(output, "lab-peer.mjs"),
      "--mode",
      "bootstrap",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--duration-ms",
      "10000",
    ],
    { cwd: output, env, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
  ),
);
try {
  assert.equal((await peer.ready).role, "bootstrap");
  await peer.stop();
} finally {
  await peer.stop().catch(() => {});
}
const command = promisify(execFile);
const revision = (await command("git", ["rev-parse", "HEAD"])).stdout.trim();
const dirty = Boolean(
  (await command("git", ["status", "--porcelain"])).stdout.trim(),
);
const manifest = {
  version: 1,
  artifact: "private-portable-headless-lab",
  git: { revision, dirty },
  lockfileSha256: createHash("sha256")
    .update(await readFile("pnpm-lock.yaml"))
    .digest("hex"),
  runtimeRequired: ">=24 <25",
  runtimeIncluded: false,
  electronIncluded: false,
  dependencies: dependencies.rows,
  linuxArm64Prebuilds: arm64,
  smoke: {
    platform: process.platform,
    architecture: process.arch,
    bootstrapReady: true,
    cleanupConfirmed: true,
    linuxArm64Executed:
      process.platform === "linux" && process.arch === "arm64",
    audioCapture: false,
  },
  files,
  releaseReady: false,
};
await writeFile(
  path.join(output, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
const archive = `${output}.tar.gz`;
await command("tar", ["-czf", archive, "-C", output, "."], {
  timeout: 30000,
  maxBuffer: 16384,
  windowsHide: true,
});
const archiveSha256 = createHash("sha256")
  .update(await readFile(archive))
  .digest("hex");
await writeFile(
  "dist/headless-lab-latest.json",
  `${JSON.stringify(
    { directory: output, archive, archiveSha256, source: manifest.git },
    null,
    2,
  )}\n`,
);
console.log(
  JSON.stringify({
    result: "headless-lab-package-passed",
    directory: output,
    archive,
    archiveSha256,
    files: files.length,
    dependencyCopies: dependencies.copied,
    arm64Prebuilds: arm64.length,
    linuxArm64Executed: manifest.smoke.linuxArm64Executed,
    audioCapture: false,
    sourceDirty: dirty,
  }),
);
