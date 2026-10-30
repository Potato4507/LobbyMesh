import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";

const directory = await mkdtemp(
  path.join(tmpdir(), "lobbymesh-desktop-smoke-"),
);
const entry = path.resolve(`dist/desktop-smoke-${process.pid}.cjs`);
try {
  await mkdir("dist", { recursive: true });
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
  const focusedModes = [
    "conversation-clear-only",
    "session-status-only",
    "overlay-capture-only",
  ];
  for (const mode of [
    "--conversation-clear-only",
    "--session-status-only",
    "--overlay-capture-only",
  ].includes(process.argv[2])
    ? [process.argv[2].slice(2)]
    : process.platform === "win32"
      ? [
          "",
          "conversation-clear-only",
          "session-status-only",
          "overlay-capture-only",
          "credentials-only",
        ]
      : ["", "conversation-clear-only", "session-status-only"])
    await new Promise((resolve, reject) => {
      const child = spawn(
        executable,
        [
          entry,
          focusedModes.includes(mode) ? path.join(directory, mode) : directory,
          ...(mode ? [mode] : []),
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
        reject(new Error(`DESKTOP_SMOKE_TIMEOUT ${diagnostic}`));
      }, 30_000);
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (
          code === 0 &&
          output.includes(
            mode === "overlay-capture-only"
              ? '"result":"overlay-capture-passed"'
              : mode === "session-status-only"
                ? '"result":"session-status-passed"'
                : mode === "conversation-clear-only"
                  ? '"result":"conversation-clear-passed"'
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
