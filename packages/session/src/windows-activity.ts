import { execFile } from "node:child_process";
import path from "node:path";

export interface PlayerActivity {
  startedAt: number;
}
export type ActivityReader = () => Promise<PlayerActivity[]>;

// Only process name, desktop session and start time: no command lines, handles,
// modules, memory, credentials or game data. Never request elevated privileges.
const SCRIPT =
  "$ErrorActionPreference='Stop'; $session=(Get-Process -Id $PID).SessionId; $players=@(Get-Process -Name RobloxPlayerBeta -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $session }); if ($players.Count -gt 4) { throw 'quota' }; ConvertTo-Json -InputObject @($players | ForEach-Object { @{startedAt=$_.StartTime.ToUniversalTime().ToString('o')} }) -Compress";
export function parsePlayerActivity(value: unknown): PlayerActivity[] {
  if (!Array.isArray(value) || value.length > 4)
    throw new Error("PLAYER_ACTIVITY_UNAVAILABLE");
  return value.map((item: unknown) => {
    if (
      !item ||
      typeof item !== "object" ||
      Object.keys(item).join(",") !== "startedAt" ||
      !("startedAt" in item) ||
      typeof item.startedAt !== "string"
    )
      throw new Error("PLAYER_ACTIVITY_UNAVAILABLE");
    const startedAt = Date.parse(item.startedAt);
    if (!Number.isSafeInteger(startedAt) || startedAt <= 0)
      throw new Error("PLAYER_ACTIVITY_UNAVAILABLE");
    return { startedAt };
  });
}
export async function readWindowsPlayerActivity(): Promise<PlayerActivity[]> {
  if (process.platform !== "win32")
    throw new Error("PLAYER_ACTIVITY_UNSUPPORTED");
  // execFile bypasses the shell; the fixed script takes no user/game input.
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      path.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", SCRIPT],
      {
        windowsHide: true,
        timeout: 1_500,
        maxBuffer: 16 * 1024,
        encoding: "utf8",
      },
      (error, stdout) => {
        if (error) reject(new Error("PLAYER_ACTIVITY_UNAVAILABLE"));
        else resolve(stdout);
      },
    );
  });
  try {
    return parsePlayerActivity(JSON.parse(output.replace(/^\uFEFF/, "")));
  } catch {
    throw new Error("PLAYER_ACTIVITY_UNAVAILABLE");
  }
}

// At most one bounded native query per five seconds while opted in. Cache errors
// too, so a policy-blocked PowerShell installation does not spawn every log poll.
export function createWindowsActivityReader(
  query: ActivityReader = readWindowsPlayerActivity,
  now = Date.now,
): ActivityReader {
  let cached: Promise<PlayerActivity[]> | undefined,
    queriedAt = 0;
  return async () => {
    const time = now();
    if (!cached || time < queriedAt || time - queriedAt >= 5_000) {
      queriedAt = time;
      cached = query();
    }
    return (await cached).map((player) => ({ ...player }));
  };
}
