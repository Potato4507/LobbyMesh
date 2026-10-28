import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

if (!process.argv[2]) throw new Error("PACKAGE_DIRECTORY_REQUIRED");
const root = await realpath(path.resolve(process.argv[2]));
const manifestPath = path.join(root, "manifest.json");
const manifestInfo = await lstat(manifestPath);
if (!manifestInfo.isFile() || manifestInfo.size > 8 * 1024 * 1024)
  throw new Error("MANIFEST_TOO_LARGE");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (
  manifest.version !== 1 ||
  manifest.platform !== "win32-x64" ||
  !Array.isArray(manifest.files) ||
  manifest.files.length > 20_000
)
  throw new Error("INVALID_MANIFEST");
const expected = new Map();
let bytes = 0;
for (const entry of manifest.files) {
  if (
    typeof entry.path !== "string" ||
    entry.path.length > 1024 ||
    path.isAbsolute(entry.path) ||
    entry.path
      .split(/[\\/]/)
      .some((part) => part === ".." || part === "." || !part) ||
    !/^[a-f0-9]{64}$/.test(entry.sha256) ||
    !Number.isSafeInteger(entry.bytes) ||
    entry.bytes < 0 ||
    entry.bytes > 4 * 1024 ** 3 ||
    expected.has(entry.path)
  )
    throw new Error("INVALID_MANIFEST_ENTRY");
  expected.set(entry.path, entry);
}
async function verify(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name),
      relative = path.relative(root, file).replaceAll(path.sep, "/");
    if (item.isSymbolicLink()) throw new Error("PACKAGE_LINK_REJECTED");
    if (item.isDirectory()) {
      await verify(file);
      continue;
    }
    if (relative === "manifest.json") continue;
    const entry = expected.get(relative);
    if (!entry) throw new Error(`UNEXPECTED_PACKAGE_FILE: ${relative}`);
    const resolved = await realpath(file);
    if (!resolved.startsWith(`${root}${path.sep}`))
      throw new Error("PACKAGE_PATH_ESCAPE");
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of createReadStream(file)) {
      size += chunk.length;
      bytes += chunk.length;
      if (size > entry.bytes || bytes > 8 * 1024 ** 3)
        throw new Error(`PACKAGE_SIZE_MISMATCH: ${relative}`);
      hash.update(chunk);
    }
    if (size !== entry.bytes || hash.digest("hex") !== entry.sha256)
      throw new Error(`PACKAGE_HASH_MISMATCH: ${relative}`);
    expected.delete(relative);
  }
}
await verify(root);
if (expected.size) throw new Error("MISSING_PACKAGE_FILES");
console.log(
  JSON.stringify({
    result: "package-integrity-passed",
    files: manifest.files.length,
    bytes,
    source: manifest.git,
    packagedSmoke: manifest.smoke,
  }),
);
