export interface VoiceQuality {
  roundTripMs: number | null;
  jitterMs: number | null;
  packetsLost: number | null;
}
export interface VoiceView {
  supported: boolean;
  enabled: boolean;
  phase: string;
  peerId: string | null;
  callId: string | null;
  capturing: boolean | null;
  transmitting: boolean | null;
  error: string | null;
  outputVolume: number;
  inputGain: number;
  inputLevel: number | null;
  inputClipping: boolean | null;
  outputMuted: boolean;
  outputLevel: number | null;
  quality: VoiceQuality;
  microphonePermission:
    | "not-determined"
    | "granted"
    | "denied"
    | "restricted"
    | "unknown";
}
export type VoiceAction =
  | { action: "consent"; enabled: boolean }
  | { action: "call"; peerId: string; consent: true }
  | { action: "answer"; callId: string; consent: true }
  | { action: "hangup"; callId: string | null }
  | { action: "talk"; callId: string; pressed: boolean; start: boolean }
  | { action: "output"; callId: string; volume: number; muted: boolean }
  | { action: "input-gain"; callId: string; gain: number }
  | { action: "switch-input"; callId: string; choice: string; consent: true };
export function parseVoiceAction(value: unknown): VoiceAction {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_VOICE_ACTION");
  const action = value as VoiceAction;
  const keys = Object.keys(value).sort().join(",");
  const callId = (id: unknown) =>
    typeof id === "string" && /^[a-f0-9]{32}$/.test(id);
  if (
    (action.action === "consent" &&
      keys === "action,enabled" &&
      typeof action.enabled === "boolean") ||
    (action.action === "call" &&
      keys === "action,consent,peerId" &&
      action.consent === true &&
      typeof action.peerId === "string" &&
      /^[a-f0-9]{64}$/.test(action.peerId)) ||
    (action.action === "answer" &&
      keys === "action,callId,consent" &&
      action.consent === true &&
      callId(action.callId)) ||
    (action.action === "hangup" &&
      keys === "action,callId" &&
      (action.callId === null || callId(action.callId))) ||
    (action.action === "output" &&
      keys === "action,callId,muted,volume" &&
      callId(action.callId) &&
      typeof action.volume === "number" &&
      Number.isFinite(action.volume) &&
      action.volume >= 0 &&
      action.volume <= 1 &&
      typeof action.muted === "boolean") ||
    (action.action === "input-gain" &&
      keys === "action,callId,gain" &&
      callId(action.callId) &&
      typeof action.gain === "number" &&
      Number.isFinite(action.gain) &&
      action.gain >= 0 &&
      action.gain <= 2) ||
    (action.action === "switch-input" &&
      keys === "action,callId,choice,consent" &&
      callId(action.callId) &&
      action.consent === true &&
      typeof action.choice === "string" &&
      (action.choice === "system-default" ||
        /^[a-f0-9]{32}$/.test(action.choice))) ||
    (action.action === "talk" &&
      keys === "action,callId,pressed,start" &&
      callId(action.callId) &&
      typeof action.pressed === "boolean" &&
      typeof action.start === "boolean" &&
      (action.pressed || !action.start))
  )
    return { ...action };
  throw new Error("INVALID_VOICE_ACTION");
}

// Main-process observation only. A peer error or renderer assertion cannot
// establish local teardown; missing facts always retain uncertainty.
export function voiceEndFailure(
  capturing: unknown,
  transmitting: unknown,
  callId: unknown,
) {
  return capturing === false && transmitting === false && callId === null
    ? "VOICE_END_NOTIFICATION_UNCONFIRMED"
    : "VOICE_END_UNCONFIRMED";
}
export function voiceEndNotice(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  let code = error.message;
  for (const channel of [
    "companion:voice:action",
    "companion:overlay:voice:end",
  ]) {
    for (const candidate of [
      "VOICE_END_NOTIFICATION_UNCONFIRMED",
      "VOICE_END_UNCONFIRMED",
    ]) {
      if (
        code ===
        `Error invoking remote method '${channel}': Error: ${candidate}`
      )
        code = candidate;
    }
  }
  return code === "VOICE_END_NOTIFICATION_UNCONFIRMED"
    ? "Call ended on this computer. Peer notification was not confirmed; the other app may still show the call."
    : code === "VOICE_END_UNCONFIRMED"
      ? "Call cleanup could not be confirmed. Check microphone status and disconnect."
      : null;
}
