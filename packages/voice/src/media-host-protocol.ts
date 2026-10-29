import { validMediaQuality } from "./quality.js";
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
      "MEDIA_NOT_CONNECTED",
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
  | "output"
  | "input-gain"
  | "status"
  | "metrics"
  | "quality";
export interface MediaCommand {
  id: string;
  op: MediaOperation;
  data: string | number | boolean | null | MediaOutput;
}
export interface MediaOutput {
  volume: number;
  muted: boolean;
}
export function validMediaOutput(value: unknown): value is MediaOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const output = value as MediaOutput;
  return (
    Object.keys(value).sort().join(",") === "muted,volume" &&
    typeof output.volume === "number" &&
    Number.isFinite(output.volume) &&
    output.volume >= 0 &&
    output.volume <= 1 &&
    typeof output.muted === "boolean"
  );
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
    ![
      "offer",
      "answer",
      "accept-answer",
      "talk",
      "output",
      "input-gain",
      "status",
      "metrics",
      "quality",
    ].includes(command.op)
  )
    throw new Error("INVALID_MEDIA_COMMAND");
  if (
    command.op === "offer"
      ? command.data !== true
      : command.op === "talk"
        ? typeof command.data !== "boolean"
        : command.op === "input-gain"
          ? typeof command.data !== "number" ||
            !Number.isFinite(command.data) ||
            command.data < 0 ||
            command.data > 2
          : command.op === "output"
            ? !validMediaOutput(command.data)
            : ["status", "metrics", "quality"].includes(command.op)
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
  if (op === "quality") return validMediaQuality(data);
  if (op === "offer" || op === "answer")
    return (
      typeof data === "string" &&
      data.length > 0 &&
      new TextEncoder().encode(data).length <= 12_288
    );
  if (
    op === "talk" ||
    op === "accept-answer" ||
    op === "output" ||
    op === "input-gain"
  )
    return data === null;
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  if (op === "status") {
    const status = data as {
      phase: string;
      capturing: boolean;
      transmitting: boolean;
      outputLevel: number | null;
    };
    return (
      exact(data, ["phase", "capturing", "transmitting", "outputLevel"]) &&
      [
        "idle",
        "capturing",
        "negotiating",
        "connected",
        "reconnecting",
        "closed",
        "failed",
      ].includes(status.phase) &&
      typeof status.capturing === "boolean" &&
      typeof status.transmitting === "boolean" &&
      (status.outputLevel === null ||
        (typeof status.outputLevel === "number" &&
          Number.isFinite(status.outputLevel) &&
          status.outputLevel >= 0 &&
          status.outputLevel <= 1))
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
