export const desktopSmokeProcessTimeoutMs = 30_000;
export function desktopSmokeModes(platform: string, requested: string) {
  if (requested) return [requested];
  return platform === "win32"
    ? [
        "",
        "voice-controls-only",
        "conversation-clear-only",
        "session-status-only",
        "overlay-capture-only",
        "incoming-call-only",
        "credentials-only",
      ]
    : [
        "",
        "voice-controls-only",
        "conversation-clear-only",
        "session-status-only",
        "incoming-call-only",
      ];
}
