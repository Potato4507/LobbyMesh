import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Independent packaging pins, cross-checked against the source-transform tests.
const officialNativeServerSha256 =
  "cdff91aee9ee1ce8aeab4daeed550ac7130f44c2750cebb794c605254b31a276";
const productionNativeServerSha256 =
  "1decf578fa2e8ca5e98f5eaaf89164959922a27d36d0a5cf1de359ed7a6eba34";

export const nativeLanPatchSha256 =
  "0e9d708221579e713fdafccbe30ec17bc63e28fabaf9293c20196cc2370ecbcf";

// Keep custom dependency source and provenance with both development artifacts.
// Validate the copied payload, not just the checkout's installed dependency.
export async function copyNativeLanPatch(
  root: string,
  appDirectory: string,
  output: string,
) {
  const patch = await readFile(
    path.join(root, "patches/hyperdht@6.35.0.patch"),
  );
  const server = await readFile(
    path.join(appDirectory, "node_modules/hyperdht/lib/server.js"),
  );
  const sha = (bytes: Buffer) =>
    createHash("sha256").update(bytes).digest("hex");
  if (
    sha(patch) !== nativeLanPatchSha256 ||
    sha(server) !== productionNativeServerSha256
  )
    throw new Error("DEPENDENCY_PATCH_PROVENANCE_MISMATCH");
  const patchPath = "dependency-patches/hyperdht@6.35.0.patch";
  await mkdir(path.join(output, "dependency-patches"), { recursive: true });
  await writeFile(path.join(output, patchPath), patch, { flag: "wx" });
  return {
    name: "hyperdht",
    version: "6.35.0",
    path: patchPath,
    sha256: nativeLanPatchSha256,
    upstreamServerSha256: officialNativeServerSha256,
    serverSha256: productionNativeServerSha256,
  };
}
