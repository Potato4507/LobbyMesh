import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("WINDOWS_X64_REQUIRED");
const root = process.cwd();
const metadata = JSON.parse(await readFile("package.json", "utf8"));
const electron = path.dirname(createRequire(import.meta.url)("electron"));
const output = path.resolve("dist", `LobbyMesh-win32-x64-${Date.now()}`);
await mkdir(output); // Exclusive output: never remove/overwrite an existing package.
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
  "renderer.js",
  "overlay.js",
  "index.html",
  "overlay.html",
  "style.css",
])
  await cp(path.join(root, "dist", name), path.join(appDirectory, name));
const packageRows = [];
const destinations = new Map();
const dependencyEdges = [];
let copied = 0;
const installedModules = await realpath(path.join(root, "node_modules"));
async function locate(from, name) {
  if (!/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name))
    throw new Error("INVALID_DEPENDENCY_NAME");
  for (const search of createRequire(
    path.join(from, "package.json"),
  ).resolve.paths(name) ?? []) {
    try {
      const resolved = await realpath(path.join(search, name));
      if (!resolved.startsWith(`${installedModules}${path.sep}`))
        throw new Error("DEPENDENCY_OUTSIDE_INSTALLED_TREE");
      await stat(path.join(resolved, "package.json"));
      return resolved;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new Error(`MISSING_PRODUCTION_DEPENDENCY: ${name}`);
}
function installedDestination(parent, name) {
  for (const search of createRequire(
    path.join(parent, "package.json"),
  ).resolve.paths(name) ?? []) {
    const candidate = path.join(search, name);
    if (destinations.has(candidate)) return candidate;
  }
  return undefined;
}
async function copyPackage(source, parent, name, ancestors = new Set()) {
  dependencyEdges.push({ parent, name, source });
  const existing = installedDestination(parent, name);
  if (existing && destinations.get(existing) === source) return;
  if (ancestors.has(source)) throw new Error("UNRESOLVED_DEPENDENCY_CYCLE");
  const rootDestination = path.join(appDirectory, "node_modules", name);
  const destination =
    !existing && !destinations.has(rootDestination)
      ? rootDestination
      : path.join(parent, "node_modules", name);
  if (destinations.has(destination))
    throw new Error("DEPENDENCY_DESTINATION_CONFLICT");
  if (++copied > 1500 || ancestors.size > 40)
    throw new Error("DEPENDENCY_COPY_QUOTA");
  const info = JSON.parse(
    await readFile(path.join(source, "package.json"), "utf8"),
  );
  destinations.set(destination, source);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: (file) => path.basename(file) !== "node_modules",
  });
  packageRows.push({
    name: info.name,
    version: info.version,
    license: info.license ?? "UNDECLARED",
    path: path.relative(output, destination).replaceAll(path.sep, "/"),
  });
  const next = new Set([...ancestors, source]);
  const dependencies = { ...info.dependencies, ...info.optionalDependencies };
  for (const name of Object.keys(dependencies ?? {}).sort()) {
    let dependency;
    try {
      dependency = await locate(source, name);
    } catch (error) {
      if (
        info.optionalDependencies?.[name] &&
        error.message.startsWith("MISSING_PRODUCTION_DEPENDENCY:")
      )
        continue;
      throw error;
    }
    await copyPackage(dependency, destination, name, next);
  }
}
// React is bundled into renderer.js; HyperDHT and native production dependencies
// remain external. Hoist compatible copies; nest conflicts with exact Node resolution.
await copyPackage(await locate(root, "hyperdht"), appDirectory, "hyperdht");
for (const edge of dependencyEdges) {
  if (
    destinations.get(installedDestination(edge.parent, edge.name)) !==
    edge.source
  )
    throw new Error("DEPENDENCY_RESOLUTION_MISMATCH");
}
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
for (const name of ["react", "react-dom"])
  await bundledNotices(await locate(root, name));
await writeFile(
  path.join(output, "DEVELOPMENT-PREVIEW.txt"),
  "Unsigned local development package. Run LobbyMesh.exe. Networking/session presence default off. No installer, updater, publisher signature, fresh-machine, actual Roblox, audio or cross-NAT acceptance. Project license/distribution review remains unresolved; this is not a public release. Upstream licenses are retained beside their package sources and Electron distribution.\n",
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
