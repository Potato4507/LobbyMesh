import SDP from "sdp";

// Parse with the SDP implementation used by adapter.js, retaining LobbyMesh's
// narrower audio-only, Opus and single SHA256 fingerprint security contract.
export function validAudioDescription(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    new TextEncoder().encode(value).length > 12288
  )
    return false;
  try {
    const sections = SDP.splitSections(value);
    const media = sections.slice(1);
    const fingerprints = [
      ...value.matchAll(/^a=fingerprint:sha-256 ([A-Fa-f0-9:]+)\r?$/gm),
    ].map((match) => match[1]?.toUpperCase());
    return (
      media.length === 1 &&
      SDP.getKind(media[0] ?? "") === "audio" &&
      SDP.parseRtpParameters(media[0] ?? "").codecs.some(
        (codec) =>
          codec.name.toLowerCase() === "opus" &&
          codec.clockRate === 48000 &&
          [1, 2].includes(codec.channels),
      ) &&
      fingerprints.length > 0 &&
      fingerprints.length === SDP.matchPrefix(value, "a=fingerprint:").length &&
      fingerprints.every(
        (value) =>
          typeof value === "string" &&
          /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(value),
      ) &&
      new Set(fingerprints).size === 1
    );
  } catch {
    return false;
  }
}
export function publicVoiceIceServers(): RTCIceServer[] {
  // Public STUN only: it discovers an address; it is not a TURN/audio relay.
  return [{ urls: "stun:stun.l.google.com:19302" }];
}
