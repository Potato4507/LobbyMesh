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
