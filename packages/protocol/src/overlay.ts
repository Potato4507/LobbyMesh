export const OVERLAY_WIDGETS = ["network", "session", "chat", "voice"] as const;
export type OverlayWidget = (typeof OVERLAY_WIDGETS)[number];
export interface OverlayPreferences {
  enabled: boolean;
  corner: "top-left" | "top-right" | "bottom-left" | "bottom-right";
  opacity: number;
  widgets: OverlayWidget[];
}
export const defaultOverlayPreferences = (): OverlayPreferences => ({
  enabled: false,
  corner: "top-right",
  opacity: 0.95,
  widgets: ["network", "session", "chat"],
});
export function parseOverlayPreferences(value: unknown): OverlayPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_OVERLAY_PREFERENCES");
  const object = value as Record<string, unknown>;
  if (
    Object.keys(object).sort().join(",") !== "corner,enabled,opacity,widgets" ||
    typeof object.enabled !== "boolean" ||
    !["top-left", "top-right", "bottom-left", "bottom-right"].includes(
      object.corner as string,
    ) ||
    typeof object.opacity !== "number" ||
    !Number.isFinite(object.opacity) ||
    object.opacity < 0.5 ||
    object.opacity > 1 ||
    !Array.isArray(object.widgets) ||
    object.widgets.length < 1 ||
    object.widgets.length > OVERLAY_WIDGETS.length ||
    new Set(object.widgets).size !== object.widgets.length ||
    !object.widgets.every((widget) => OVERLAY_WIDGETS.includes(widget))
  )
    throw new Error("INVALID_OVERLAY_PREFERENCES");
  return {
    enabled: object.enabled,
    corner: object.corner as OverlayPreferences["corner"],
    opacity: object.opacity,
    widgets: [...object.widgets],
  };
}
export interface OverlayStatus {
  state: "disabled" | "ready" | "unavailable" | "unsupported";
  interactive: boolean;
  shortcutRegistered: boolean;
  preferences: OverlayPreferences;
}
// Read-only call observation plus a separate, strictly call-bound stop action.
// No peer identities, media parameters, permission grants or PTT capability.
export interface OverlayVoiceView {
  phase: string;
  callId: string | null;
  capturing: boolean | null;
  transmitting: boolean | null;
}
export function parseOverlayEndCall(value: unknown): { callId: string } {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).join(",") !== "callId" ||
    !("callId" in value) ||
    typeof value.callId !== "string" ||
    !/^[a-f0-9]{32}$/.test(value.callId)
  )
    throw new Error("INVALID_OVERLAY_END_CALL");
  return { callId: value.callId };
}
export function overlayBounds(
  area: { x: number; y: number; width: number; height: number },
  preferences: OverlayPreferences,
) {
  const margin = Math.min(
    16,
    Math.floor(Math.min(area.width, area.height) / 10),
  );
  const width = Math.min(380, area.width - margin * 2);
  const height = Math.min(
    preferences.widgets.includes("chat")
      ? 650
      : 120 + preferences.widgets.length * 110,
    area.height - margin * 2,
  );
  return {
    x:
      area.x +
      (preferences.corner.endsWith("right")
        ? area.width - width - margin
        : margin),
    y:
      area.y +
      (preferences.corner.startsWith("bottom")
        ? area.height - height - margin
        : margin),
    width,
    height,
  };
}
