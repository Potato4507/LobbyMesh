export type LabStage =
  | "preflight"
  | "first-start"
  | "second-start"
  | "pairing"
  | "text"
  | "history"
  | "restart"
  | "voice-signaling"
  | "revocation";

// Only fixed codes and operation stages reach evidence. Never export raw SSH,
// native exception messages, invitations or control-channel values.
export function labRunReport(
  stage: LabStage,
  passed: boolean,
  cleanupVerified: boolean,
  error?: unknown,
) {
  if (passed && cleanupVerified)
    return { result: "passed", failureReason: null, failureStage: null };
  const allowed = [
    "LAB_ASKPASS_REQUIRED",
    "INVALID_LAB_REMOTE",
    "LAB_READY_TIMEOUT",
    "LAB_PROCESS_EXIT",
    "LAB_COMMAND_TIMEOUT",
    "LAB_REMOTE_REJECTED",
    "LAB_CLIENT_UNAVAILABLE",
  ];
  return {
    result: "failed",
    failureReason: passed
      ? "LAB_CLEANUP_UNCONFIRMED"
      : error instanceof Error && allowed.includes(error.message)
        ? error.message
        : "LAB_RUN_FAILED",
    failureStage: passed ? "cleanup" : stage,
  };
}
