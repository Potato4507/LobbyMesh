import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import {
  desktopSmokeModes,
  desktopSmokeProcessTimeoutMs,
} from "./desktop-modes.ts";

const focusedModes = [
  "voice-controls-only",
  "conversation-clear-only",
  "session-status-only",
  "overlay-capture-only",
  "incoming-call-only",
];
let requestedMode = "",
  updateEvidence = false;
for (const argument of process.argv.slice(2)) {
  if (
    focusedModes.includes(argument.slice(2)) &&
    argument.startsWith("--") &&
    !requestedMode
  )
    requestedMode = argument.slice(2);
  else if (argument === "--update-evidence" && !updateEvidence)
    updateEvidence = true;
  else throw new Error("INVALID_DESKTOP_SMOKE_OPTIONS");
}
const directory = await mkdtemp(
  path.join(tmpdir(), "lobbymesh-desktop-smoke-"),
);
const entry = path.resolve(`dist/desktop-smoke-${process.pid}.cjs`);
try {
  await mkdir("dist", { recursive: true });
  const evidenceDirectory = updateEvidence
    ? path.resolve("docs/evidence")
    : path.resolve("dist", `desktop-evidence-${process.pid}-${Date.now()}`);
  if (!updateEvidence) await mkdir(evidenceDirectory);
  console.log(
    JSON.stringify({
      desktopEvidenceDirectory: evidenceDirectory,
      trackedEvidenceUpdated: updateEvidence,
    }),
  );
  await build({
    entryPoints: ["tests/fixtures/desktop-smoke.ts"],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron", "hyperdht"],
  });
  const executable = createRequire(import.meta.url)("electron"),
    environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  for (const mode of desktopSmokeModes(process.platform, requestedMode))
    await new Promise((resolve, reject) => {
      const child = spawn(
        executable,
        [
          entry,
          focusedModes.includes(mode) ? path.join(directory, mode) : directory,
          mode || "main",
          evidenceDirectory,
        ],
        {
          windowsHide: true,
          env: environment,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let diagnostic = "",
        output = "";
      child.stdout.on("data", (chunk) => {
        output += String(chunk);
        process.stdout.write(chunk);
      });
      child.stderr.on("data", (chunk) => {
        diagnostic = (diagnostic + String(chunk)).slice(-16_384);
      });
      const timer = setTimeout(() => {
        child.kill();
        const stage =
          output
            .split(/\r?\n/)
            .filter((line) => line.startsWith('{"desktopStage":'))
            .at(-1) ?? "no-stage";
        reject(new Error(`DESKTOP_SMOKE_TIMEOUT ${stage} ${diagnostic}`));
      }, desktopSmokeProcessTimeoutMs);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (
          code === 0 &&
          output.includes(
            mode === "voice-controls-only"
              ? '"result":"voice-controls-passed"'
              : mode === "overlay-capture-only"
                ? '"result":"overlay-capture-passed"'
                : mode === "session-status-only"
                  ? '"result":"session-status-passed"'
                  : mode === "conversation-clear-only"
                    ? '"result":"conversation-clear-passed"'
                    : mode === "incoming-call-only"
                      ? '"result":"incoming-call-passed"'
                      : mode
                        ? '"result":"credential-reload-passed"'
                        : '"result":"passed"',
          )
        )
          resolve();
        else reject(new Error(`DESKTOP_SMOKE_EXIT ${code}: ${diagnostic}`));
      });
    });
} finally {
  await unlink(entry).catch(() => {});
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
