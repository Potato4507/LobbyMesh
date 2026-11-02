import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { copyNativeLanPatch } from "./dependency-patches.ts";
import { copyProductionDependencies } from "./production-dependencies.ts";

if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("WINDOWS_X64_REQUIRED");
const root = process.cwd();
const metadata = JSON.parse(await readFile("package.json", "utf8"));
const electron = path.dirname(createRequire(import.meta.url)("electron"));
const output = path.resolve("dist", `LobbyMesh-win32-x64-${Date.now()}`);
await mkdir(output); // Exclusive output: never remove/overwrite an existing package.
await cp(
  path.join(root, "LICENSE"),
  path.join(output, "LOBBYMESH-LICENSE.txt"),
);
await import("./build.mjs");
for (const entry of await readdir(electron))
  await cp(path.join(electron, entry), path.join(output, entry), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
await rename(
  path.join(output, "electron.exe"),
  path.join(output, "LobbyMesh.exe"),
);
const appDirectory = path.join(output, "resources", "app");
await mkdir(appDirectory);
await writeFile(
  path.join(appDirectory, "package.json"),
  JSON.stringify({
    name: metadata.name,
    productName: "LobbyMesh",
    version: metadata.version,
    main: "main.cjs",
    private: true,
  }),
);
for (const name of [
  "main.cjs",
  "preload.cjs",
  "media-preload.cjs",
  "media-renderer.js",
  "media.html",
  "renderer.js",
  "overlay.js",
  "index.html",
  "overlay.html",
  "style.css",
])
  await cp(path.join(root, "dist", name), path.join(appDirectory, name));
const {
  rows: packageRows,
  copied,
  locate,
} = await copyProductionDependencies(root, appDirectory, output);
const dependencyPatches = [
  await copyNativeLanPatch(root, appDirectory, output),
];
const bundled = new Set();
async function bundledNotices(source) {
  if (bundled.has(source)) return;
  bundled.add(source);
  const info = JSON.parse(
    await readFile(path.join(source, "package.json"), "utf8"),
  );
  const target = path.join(
    output,
    "third-party-notices",
    info.name.replaceAll("/", "_"),
  );
  await mkdir(target, { recursive: true });
  const licenses = (await readdir(source)).filter((name) =>
    /^(license|copying|notice)(\.|$)/i.test(name),
  );
  if (!licenses.length) throw new Error("BUNDLED_DEPENDENCY_LICENSE_MISSING");
  for (const filename of licenses)
    await cp(path.join(source, filename), path.join(target, filename));
  await cp(
    path.join(source, "package.json"),
    path.join(target, "package.json"),
  );
  packageRows.push({
    name: info.name,
    version: info.version,
    license: info.license ?? "UNDECLARED",
    path: path.relative(output, target).replaceAll(path.sep, "/"),
    bundled: true,
  });
  for (const name of Object.keys(info.dependencies ?? {}))
    await bundledNotices(await locate(source, name));
}
for (const name of ["react", "react-dom", "webrtc-adapter", "sdp"])
  await bundledNotices(await locate(root, name));
await writeFile(
  path.join(output, "DEVELOPMENT-PREVIEW.txt"),
  "Unsigned experimental preview. Run LobbyMesh.exe or use the separately supplied setup executable. Networking/session presence default off. No updater or publisher signature; fresh-machine, actual Roblox, hardware audio and cross-NAT acceptance remain unverified. LobbyMesh source is MIT licensed; upstream licenses are retained beside their package sources and Electron distribution.\n",
);

const profile = await mkdtemp(path.join(tmpdir(), "lobbymesh-packaged-smoke-"));
if (
  path.dirname(path.resolve(profile)) !== path.resolve(tmpdir()) ||
  !path.basename(profile).startsWith("lobbymesh-packaged-smoke-")
)
  throw new Error("UNSAFE_SMOKE_CLEANUP");
let proof;
try {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.NODE_PATH;
  delete environment.NODE_OPTIONS;
  proof = await new Promise((resolve, reject) => {
    const child = spawn(
      path.join(output, "LobbyMesh.exe"),
      ["--lobbymesh-smoke-profile", profile],
      {
        cwd: output,
        windowsHide: true,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "",
      timedOut = false;
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-16_384);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-16_384);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 30_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const marker = stdout
        .split(/\r?\n/)
        .find((line) => line.startsWith("LOBBYMESH_PACKAGED_SMOKE "));
      if (timedOut || code !== 0 || !marker) {
        reject(new Error(`PACKAGED_SMOKE_FAILED: ${code}: ${stderr}`));
        return;
      }
      try {
        const value = JSON.parse(
          marker.slice("LOBBYMESH_PACKAGED_SMOKE ".length),
        );
        if (value.result !== "passed" || value.packaged !== true)
          throw new Error("INVALID_PACKAGED_PROOF");
        resolve(value);
      } catch (error) {
        reject(error);
      }
    });
  });
} finally {
  await rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}
const files = [];
async function inventory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error("PACKAGE_MUST_NOT_CONTAIN_LINKS");
    if (entry.isDirectory()) await inventory(file);
    else {
      const digest = createHash("sha256");
      let bytes = 0;
      for await (const chunk of createReadStream(file)) {
        bytes += chunk.length;
        digest.update(chunk);
      }
      files.push({
        path: path.relative(output, file).replaceAll(path.sep, "/"),
        bytes,
        sha256: digest.digest("hex"),
      });
    }
  }
}
await inventory(output);
const command = promisify(execFile);
const revision = (await command("git", ["rev-parse", "HEAD"])).stdout.trim();
const dirty = Boolean(
  (await command("git", ["status", "--porcelain"])).stdout.trim(),
);
const manifest = {
  version: 1,
  artifact: "unsigned-local-development-folder",
  platform: "win32-x64",
  projectVersion: metadata.version,
  projectLicense: metadata.license ?? "UNDECLARED",
  git: { revision, dirty },
  lockfileSha256: createHash("sha256")
    .update(await readFile("pnpm-lock.yaml"))
    .digest("hex"),
  smoke: proof,
  dependencies: packageRows,
  dependencyPatches,
  files,
};
await writeFile(
  path.join(output, "manifest.json"),
  JSON.stringify(manifest, null, 2),
);
await writeFile(
  path.join(root, "dist", "windows-development-latest.json"),
  JSON.stringify(
    {
      directory: output,
      executable: path.join(output, "LobbyMesh.exe"),
      source: manifest.git,
      manifest: path.join(output, "manifest.json"),
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    result: "packaged-smoke-passed",
    output,
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    dependencyCopies: copied,
    smoke: proof,
    sourceDirty: dirty,
  }),
);
