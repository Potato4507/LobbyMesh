export interface Preferences {
  version: 1;
  networkEnabled: boolean;
  sessionConsent: boolean;
  voiceMode: "off" | "push-to-talk";
  displayName: string;
  allowedPeers: string[];
  blockedPeers: string[];
}
export const defaultPreferences = (): Preferences => ({
  version: 1,
  networkEnabled: false,
  sessionConsent: false,
  voiceMode: "off",
  displayName: "LobbyMesh user",
  allowedPeers: [],
  blockedPeers: [],
});
export type PreferencePatch = Partial<
  Pick<
    Preferences,
    "networkEnabled" | "sessionConsent" | "voiceMode" | "displayName"
  >
>;
export function parsePreferencePatch(value: unknown): PreferencePatch {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_PREFERENCES");
  const result: PreferencePatch = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "networkEnabled" || key === "sessionConsent") {
      if (typeof entry !== "boolean") throw new Error("INVALID_PREFERENCES");
      result[key] = entry;
    } else if (key === "voiceMode") {
      if (entry !== "off" && entry !== "push-to-talk")
        throw new Error("INVALID_PREFERENCES");
      result.voiceMode = entry;
    } else if (key === "displayName") {
      if (
        typeof entry !== "string" ||
        entry.trim().length < 1 ||
        entry.length > 64 ||
        Array.from(entry).some(
          (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
        )
      )
        throw new Error("INVALID_PREFERENCES");
      result.displayName = entry;
    } else throw new Error("UNKNOWN_PREFERENCE");
  }
  return result;
}
export function parsePeerId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error("INVALID_PEER_ID");
  return value;
}
export function parsePreferences(value: unknown): Preferences {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_PREFERENCES");
  const object = value as Record<string, unknown>;
  if (
    object.version !== 1 ||
    Object.keys(object).sort().join(",") !==
      "allowedPeers,blockedPeers,displayName,networkEnabled,sessionConsent,version,voiceMode"
  )
    throw new Error("UNSUPPORTED_PREFERENCES");
  const basic = parsePreferencePatch({
    networkEnabled: object.networkEnabled,
    sessionConsent: object.sessionConsent,
    voiceMode: object.voiceMode,
    displayName: object.displayName,
  });
  const peers = (list: unknown, limit: number): string[] => {
    if (!Array.isArray(list) || list.length > limit)
      throw new Error("PEER_LIST_QUOTA");
    return [...new Set(list.map(parsePeerId))].sort();
  };
  const blockedPeers = peers(object.blockedPeers, 1024),
    allowedPeers = peers(object.allowedPeers, 256).filter(
      (id) => !blockedPeers.includes(id),
    );
  return { ...defaultPreferences(), ...basic, blockedPeers, allowedPeers };
}
