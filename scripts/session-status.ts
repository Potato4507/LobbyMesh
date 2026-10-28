import { setTimeout as delay } from "node:timers/promises";
import { createWindowsActivityReader } from "../packages/session/src/windows-activity.js";
import {
  WindowsLogSessionProvider,
  windowsLogDirectories,
} from "../packages/session/src/windows-logs.js";

// Explicit local-only diagnostic. No settings changes, publication, raw log or identifier output.
const provider = new WindowsLogSessionProvider(
  windowsLogDirectories(process.env.LOCALAPPDATA),
  { activity: createWindowsActivityReader() },
);
try {
  await provider.setEnabled(true);
  // Optional, bounded catch-up for large existing logs; default remains one scan.
  const deadline = Date.now() + 30_000;
  while (
    process.argv.includes("--follow") &&
    provider.status().state === "scanning" &&
    Date.now() < deadline
  )
    await delay(250);
  console.log(
    JSON.stringify({
      probe: "local-session-read-only",
      detection: provider.status(),
      sessionSelected: Boolean(await provider.current()),
      networkStarted: false,
      rawIdentifiersPrinted: false,
    }),
  );
} finally {
  await provider.stop();
}
