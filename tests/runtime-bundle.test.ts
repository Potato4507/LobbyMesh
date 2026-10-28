import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { build } from "esbuild";

test("CommonJS runtime bundle loads pinned native HyperDHT without import.meta or opening a socket", async () => {
  await mkdir("dist", { recursive: true });
  const directory = await mkdtemp(path.resolve("dist/runtime-bundle-"));
  try {
    const output = path.join(directory, "runtime.cjs");
    const result = await build({
      entryPoints: ["packages/app-dht/src/runtime.ts"],
      outfile: output,
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["hyperdht"],
      logLevel: "silent",
    });
    assert.deepEqual(result.warnings, []);
    const loaded = await promisify(execFile)(
      process.execPath,
      [
        "-e",
        "const r = require(process.argv[1]); if (typeof r.createOverlayRuntime !== 'function') process.exit(1); console.log('NATIVE_RUNTIME_LOADED')",
        output,
      ],
      { timeout: 10_000 },
    );
    assert.match(loaded.stdout, /NATIVE_RUNTIME_LOADED/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
