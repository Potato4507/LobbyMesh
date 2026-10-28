import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";

const directory = await mkdtemp(path.join(tmpdir(), "lobbymesh-audio-smoke-"));
let child;
try {
  await mkdir(path.join(directory, "profile"));
  await build({
    entryPoints: ["tests/fixtures/audio-renderer.ts"],
    outfile: path.join(directory, "audio.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
  });
  await build({
    entryPoints: ["tests/fixtures/audio-smoke.ts"],
    outfile: path.join(directory, "main.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
  });
  await writeFile(
    path.join(directory, "audio.html"),
    `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; connect-src 'none'"></head><body><script src="audio.js"></script></body></html>`,
  );
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.NODE_OPTIONS;
  delete environment.NODE_PATH;
  await new Promise((resolve, reject) => {
    child = spawn(
      createRequire(import.meta.url)("electron"),
      [path.join(directory, "main.cjs"), directory],
      {
        windowsHide: true,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      diagnostics = "";
    child.stdout.on("data", (chunk) => {
      output = (output + String(chunk)).slice(-16_384);
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      diagnostics = (diagnostics + String(chunk)).slice(-8192);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`AUDIO_SMOKE_TIMEOUT ${diagnostics}`));
    }, 25_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0 && output.includes('"result":"synthetic-audio-passed"'))
        resolve();
      else reject(new Error(`AUDIO_SMOKE_EXIT ${code}: ${diagnostics}`));
    });
  });
} finally {
  if (child && child.exitCode === null && !child.signalCode)
    await new Promise((resolve) => {
      child.once("exit", resolve);
      child.kill();
    });
  if (
    path.dirname(path.resolve(directory)) === path.resolve(tmpdir()) &&
    path.basename(directory).startsWith("lobbymesh-audio-smoke-")
  ) {
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  } else {
    console.error("INVALID_AUDIO_SMOKE_CLEANUP_PATH");
    process.exitCode = 1;
  }
}
