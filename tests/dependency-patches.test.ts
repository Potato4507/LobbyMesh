import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  copyNativeLanPatch,
  nativeLanPatchSha256,
} from "../scripts/dependency-patches.js";
import {
  officialNativeServerSha256,
  productionNativeServerSha256,
} from "../scripts/native-lan-candidate.js";

test("packaging retains the pinned patch only with its matching copied native payload", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "lobbymesh-patch-provenance-"),
  );
  const root = path.join(directory, "source"),
    app = path.join(directory, "app"),
    output = path.join(directory, "output");
  const require = createRequire(import.meta.url);
  const patch = await readFile(
    new URL("../patches/hyperdht@6.35.0.patch", import.meta.url),
  );
  const server = await readFile(
    path.join(
      path.dirname(require.resolve("hyperdht/package.json")),
      "lib/server.js",
    ),
  );
  try {
    await mkdir(path.join(root, "patches"), { recursive: true });
    await mkdir(path.join(app, "node_modules/hyperdht/lib"), {
      recursive: true,
    });
    const patchFile = path.join(root, "patches/hyperdht@6.35.0.patch"),
      serverFile = path.join(app, "node_modules/hyperdht/lib/server.js");
    await writeFile(patchFile, patch);
    await writeFile(serverFile, Buffer.from("unpatched or mismatched payload"));
    await assert.rejects(
      copyNativeLanPatch(root, app, output),
      /PROVENANCE_MISMATCH/,
    );
    await writeFile(serverFile, server);
    await writeFile(patchFile, Buffer.concat([patch, Buffer.from("tampered")]));
    await assert.rejects(
      copyNativeLanPatch(root, app, output),
      /PROVENANCE_MISMATCH/,
    );
    await writeFile(patchFile, patch);
    const row = await copyNativeLanPatch(root, app, output);
    assert.equal(row.sha256, nativeLanPatchSha256);
    assert.equal(row.upstreamServerSha256, officialNativeServerSha256);
    assert.equal(row.serverSha256, productionNativeServerSha256);
    assert.deepEqual(await readFile(path.join(output, row.path)), patch);
    await assert.rejects(copyNativeLanPatch(root, app, output), /EEXIST/);
    assert.deepEqual(await readFile(path.join(output, row.path)), patch);
  } finally {
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    assert.ok(
      path.basename(directory).startsWith("lobbymesh-patch-provenance-"),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
