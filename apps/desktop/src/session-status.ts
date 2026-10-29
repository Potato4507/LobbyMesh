import type {
  DetectionState,
  DetectionStatus,
} from "../../../packages/session/src/windows-logs.js";

const labels: Record<DetectionState, string> = {
  disabled: "Detection off",
  unsupported: "Unsupported on this device",
  waiting: "Waiting for session details",
  detected: "Local session detected",
  incomplete: "Session details incomplete",
  scanning: "Reading player session…",
  stale: "Waiting for fresh game logs",
  ambiguous: "Session source ambiguous",
  unavailable: "Session detection unavailable",
};
const details: Record<DetectionState, string> = {
  disabled:
    "Enable local session detection in Preferences to look for your session. It does not start networking or your microphone.",
  unsupported:
    "Automatic session detection is unavailable for this platform or profile. No session is selected.",
  waiting:
    "No complete local session has been identified yet. Matching stays paused while detection checks supported player logs.",
  detected:
    "Local logs are unverified evidence. They do not verify Roblox identity or who else is in the session.",
  incomplete:
    "Player logs do not yet contain enough information to identify one session. Matching stays paused.",
  scanning:
    "Reading a bounded portion of the player log. Matching stays paused until the scanner catches up.",
  stale:
    "Only older player logs were found. Earlier runs are not used for current session matching.",
  ambiguous:
    "More than one source could describe this session. Matching stays paused until one source can be selected confidently.",
  unavailable:
    "Local session information is unavailable. Detection will retry automatically while enabled.",
};
const reasons: Record<
  Exclude<DetectionStatus["reason"], null>,
  { label?: string; detail: string }
> = {
  "player-not-running": {
    label: "Waiting for Roblox",
    detail:
      "No Roblox player was found in this Windows desktop session. Open a supported Roblox player to begin local detection.",
  },
  "player-log-pending": {
    label: "Waiting for player logs",
    detail:
      "A Roblox player is running, but it has not produced an eligible log yet. Matching stays paused while detection retries.",
  },
  "multiple-player-processes": {
    detail:
      "More than one Roblox client is running. Close unused clients so LobbyMesh can select one local session.",
  },
  "multiple-player-logs": {
    detail:
      "Multiple player logs match this run. LobbyMesh cannot select a session confidently yet.",
  },
  "process-query-failed": {
    detail:
      "Windows player activity is unavailable. Session detection will retry automatically.",
  },
  "log-read-failed": {
    detail:
      "Player logs could not be read. Session detection will retry automatically.",
  },
};
export function sessionPresentation(status: DetectionStatus | null): {
  label: string;
  detail: string;
} {
  if (!status)
    return {
      label: "Checking session…",
      detail:
        "Checking local session detection. No session has been selected yet.",
    };
  const reason = status.reason ? reasons[status.reason] : undefined;
  return {
    label: reason?.label ?? labels[status.state],
    detail: reason?.detail ?? details[status.state],
  };
}
