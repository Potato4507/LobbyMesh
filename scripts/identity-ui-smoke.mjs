import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";

const directory = await mkdtemp(path.join(tmpdir(), "lobbymesh-identity-ui-"));
const entry = path.resolve("dist", `identity-ui-${process.pid}.cjs`);
await mkdir("dist", { recursive: true });
const evidence = path.resolve("dist", `identity-ui-evidence-${Date.now()}`);
await mkdir(evidence);
try {
  await build({
    entryPoints: ["tests/fixtures/identity-ui-smoke.ts"],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron", "hyperdht"],
  });
  const env = { ...process.env };
  for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH"])
    delete env[key];
  await new Promise((resolve, reject) => {
    const child = spawn(
      createRequire(import.meta.url)("electron"),
      [entry, directory, evidence],
      { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "",
      diagnostic = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      diagnostic = (diagnostic + String(chunk)).slice(-16000);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`IDENTITY_UI_TIMEOUT ${diagnostic}`));
    }, 30000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0 && output.includes('"result":"identity-ui-passed"'))
        resolve();
      else reject(new Error(`IDENTITY_UI_FAILED ${code} ${diagnostic}`));
    });
  });
} finally {
  await unlink(entry).catch(() => {});
  assert.equal(path.dirname(directory), path.resolve(tmpdir()));
  assert.ok(path.basename(directory).startsWith("lobbymesh-identity-ui-"));
  await rm(directory, { recursive: true, force: true });
}
