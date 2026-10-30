import { isIP } from "node:net";

export interface LabOptions {
  mode: "peer" | "bootstrap";
  durationMs: number;
  bootstrap: string;
  host: string;
  port: number;
}

// Explicit lab endpoints only. Never fall through to public bootstrap defaults.
export function parseLabOptions(args: string[]): LabOptions {
  const fields = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (
      !key ||
      !["--mode", "--duration-ms", "--bootstrap", "--host", "--port"].includes(
        key,
      ) ||
      !value ||
      fields.has(key)
    )
      throw new Error("INVALID_LAB_OPTIONS");
    fields.set(key, value);
  }
  const mode = fields.get("--mode") ?? "peer";
  const duration = fields.get("--duration-ms") ?? "120000";
  const portText = fields.get("--port") ?? "49737";
  const durationMs = Number(duration),
    port = Number(portText);
  const host = fields.get("--host") ?? "127.0.0.1";
  const bootstrap = fields.get("--bootstrap") ?? "";
  const parts = bootstrap.split(":");
  if (
    (mode !== "peer" && mode !== "bootstrap") ||
    !/^\d+$/.test(duration) ||
    !Number.isSafeInteger(durationMs) ||
    durationMs < 1000 ||
    durationMs > 600000 ||
    !/^\d+$/.test(portText) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535 ||
    isIP(host) !== 4 ||
    (mode === "peer" &&
      (fields.has("--host") ||
        fields.has("--port") ||
        parts.length !== 2 ||
        isIP(parts[0] ?? "") !== 4 ||
        !/^\d+$/.test(parts[1] ?? "") ||
        Number(parts[1]) < 1 ||
        Number(parts[1]) > 65535)) ||
    (mode === "bootstrap" && fields.has("--bootstrap"))
  )
    throw new Error("INVALID_LAB_OPTIONS");
  return { mode, durationMs, bootstrap, host, port };
}

export interface LabCommand {
  id: number;
  op:
    | "status"
    | "restart"
    | "code"
    | "preview"
    | "approve"
    | "send"
    | "history"
    | "revoke"
    | "voice-enable"
    | "voice-disable"
    | "voice-status"
    | "voice-events"
    | "voice-offer"
    | "voice-answer"
    | "voice-ice"
    | "voice-hangup"
    | "stop";
  value?: string;
}
export function parseLabCommand(value: unknown): LabCommand {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID_LAB_COMMAND");
  const o = value as Record<string, unknown>;
  const withValue = [
    "preview",
    "approve",
    "send",
    "history",
    "revoke",
    "voice-answer",
    "voice-ice",
    "voice-hangup",
  ].includes(o.op as string);
  if (
    Object.keys(o).sort().join(",") !== (withValue ? "id,op,value" : "id,op") ||
    !Number.isSafeInteger(o.id) ||
    (o.id as number) < 1 ||
    ![
      "status",
      "restart",
      "code",
      "preview",
      "approve",
      "send",
      "history",
      "revoke",
      "voice-enable",
      "voice-disable",
      "voice-status",
      "voice-events",
      "voice-offer",
      "voice-answer",
      "voice-ice",
      "voice-hangup",
      "stop",
    ].includes(o.op as string) ||
    (withValue &&
      (typeof o.value !== "string" ||
        o.value.length < 1 ||
        Buffer.byteLength(o.value) > 4096))
  )
    throw new Error("INVALID_LAB_COMMAND");
  return o as unknown as LabCommand;
}
