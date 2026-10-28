export const MEDIA_COMMAND = "companion:media:command";
export const MEDIA_REPLY = "companion:media:reply";
export function mediaError(value: unknown): string {
  return typeof value === "string" &&
    [
      "MEDIA_PERMISSION_DENIED",
      "MEDIA_DEVICE_UNAVAILABLE",
      "MEDIA_TIMEOUT",
      "MEDIA_CLOSED",
      "MEDIA_INVALID_DESCRIPTION",
      "MEDIA_OPUS_UNAVAILABLE",
      "MEDIA_NEGOTIATION_FAILED",
      "MEDIA_CONNECTION_FAILED",
      "MEDIA_OUTPUT_FAILED",
    ].includes(value)
    ? value
    : "MEDIA_COMMAND_FAILED";
}
export type MediaOperation =
  | "offer"
  | "answer"
  | "accept-answer"
  | "talk"
  | "status"
  | "metrics";
export interface MediaCommand {
  id: string;
  op: MediaOperation;
  data: string | boolean | null;
}
export interface MediaReply {
  id: string;
  ok: boolean;
  data: unknown;
}
const exact = (value: object, keys: string[]) =>
  Object.keys(value).sort().join(",") === keys.sort().join(",");
export function parseMediaCommand(value: unknown): MediaCommand {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exact(value, ["id", "op", "data"])
  )
    throw new Error("INVALID_MEDIA_COMMAND");
  const command = value as MediaCommand;
  if (
    typeof command.id !== "string" ||
    !/^[a-f0-9]{32}$/.test(command.id) ||
    !["offer", "answer", "accept-answer", "talk", "status", "metrics"].includes(
      command.op,
    )
  )
    throw new Error("INVALID_MEDIA_COMMAND");
  if (
    command.op === "offer"
      ? command.data !== true
      : command.op === "talk"
        ? typeof command.data !== "boolean"
        : ["status", "metrics"].includes(command.op)
          ? command.data !== null
          : typeof command.data !== "string" ||
            !command.data.length ||
            new TextEncoder().encode(command.data).length > 12_288
  )
    throw new Error("INVALID_MEDIA_COMMAND");
  return { ...command };
}
export function parseMediaReply(value: unknown): MediaReply {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !exact(value, ["id", "ok", "data"])
  )
    throw new Error("INVALID_MEDIA_REPLY");
  const reply = value as MediaReply;
  if (
    typeof reply.id !== "string" ||
    !(reply.id === "ready" || /^[a-f0-9]{32}$/.test(reply.id)) ||
    typeof reply.ok !== "boolean"
  )
    throw new Error("INVALID_MEDIA_REPLY");
  return { ...reply };
}
export function validMediaResult(op: MediaOperation, data: unknown): boolean {
  if (op === "offer" || op === "answer")
    return (
      typeof data === "string" &&
      data.length > 0 &&
      new TextEncoder().encode(data).length <= 12_288
    );
  if (op === "talk" || op === "accept-answer") return data === null;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  if (op === "status") {
    const status = data as {
      phase: string;
      capturing: boolean;
      transmitting: boolean;
    };
    return (
      exact(data, ["phase", "capturing", "transmitting"]) &&
      [
        "idle",
        "capturing",
        "negotiating",
        "connected",
        "closed",
        "failed",
      ].includes(status.phase) &&
      typeof status.capturing === "boolean" &&
      typeof status.transmitting === "boolean"
    );
  }
  const metrics = data as {
    receivedPackets: number;
    receivedBytes: number;
    receivedEnergy: number | null;
  };
  return (
    exact(data, ["receivedPackets", "receivedBytes", "receivedEnergy"]) &&
    [metrics.receivedPackets, metrics.receivedBytes].every(
      (v) => Number.isSafeInteger(v) && v >= 0,
    ) &&
    (metrics.receivedEnergy === null ||
      (typeof metrics.receivedEnergy === "number" &&
        Number.isFinite(metrics.receivedEnergy) &&
        metrics.receivedEnergy >= 0))
  );
}
