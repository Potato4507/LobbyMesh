export interface VoiceView {
  supported: boolean;
  enabled: boolean;
  phase: string;
  peerId: string | null;
  callId: string | null;
  capturing: boolean | null;
  transmitting: boolean | null;
  error: string | null;
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
  | { action: "talk"; callId: string; pressed: boolean; start: boolean };
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
