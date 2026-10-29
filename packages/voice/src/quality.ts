// Local measurements only. Never retain the browser's candidate addresses/IDs.
import type { VoiceQuality } from "../../protocol/src/voice.js";
export type MediaQuality = VoiceQuality;
export const unknownMediaQuality = (): MediaQuality => ({
  roundTripMs: null,
  jitterMs: null,
  packetsLost: null,
});
const bounded = (value: unknown, max: number) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= max;
export function validMediaQuality(value: unknown): value is MediaQuality {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const q = value as MediaQuality;
  return (
    Object.keys(value).sort().join(",") ===
      "jitterMs,packetsLost,roundTripMs" &&
    [q.roundTripMs, q.jitterMs].every(
      (v) => v === null || bounded(v, 60_000),
    ) &&
    (q.packetsLost === null ||
      (Number.isSafeInteger(q.packetsLost) && q.packetsLost >= 0))
  );
}
export function readMediaQuality(
  report: Iterable<[string, unknown]>,
): MediaQuality {
  const result = unknownMediaQuality();
  const records = new Map<string, Record<string, unknown>>();
  try {
    let count = 0;
    for (const [id, record] of report) {
      if (++count > 128) return unknownMediaQuality();
      if (
        typeof id === "string" &&
        id.length <= 256 &&
        record &&
        typeof record === "object" &&
        !Array.isArray(record)
      )
        records.set(id, record as Record<string, unknown>);
    }
    const selected = new Set<string>();
    const inbound: Record<string, unknown>[] = [];
    for (const record of records.values()) {
      if (
        record.type === "transport" &&
        typeof record.selectedCandidatePairId === "string" &&
        record.selectedCandidatePairId.length > 0 &&
        record.selectedCandidatePairId.length <= 256
      )
        selected.add(record.selectedCandidatePairId);
      if (
        record.type === "inbound-rtp" &&
        record.kind === "audio" &&
        record.isRemote !== true
      )
        inbound.push(record);
    }
    if (selected.size === 1) {
      const pair = records.get([...selected][0] ?? "");
      if (
        pair?.type === "candidate-pair" &&
        pair.state === "succeeded" &&
        bounded(pair.currentRoundTripTime, 60)
      )
        result.roundTripMs = (pair.currentRoundTripTime as number) * 1000;
    }
    if (inbound.length === 1) {
      const audio = inbound[0];
      if (bounded(audio?.jitter, 60))
        result.jitterMs = (audio?.jitter as number) * 1000;
      if (
        Number.isSafeInteger(audio?.packetsLost) &&
        (audio?.packetsLost as number) >= 0
      )
        result.packetsLost = audio?.packetsLost as number;
    }
    return result;
  } catch {
    return unknownMediaQuality();
  }
}
