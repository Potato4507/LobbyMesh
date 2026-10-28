import type { RpcPhase } from "./rpc.js";

export type RpcOperation =
  | "find-node"
  | "find-value"
  | "put"
  | "direct"
  | "unknown";
export type RpcOutcome =
  | "success"
  | "timeout"
  | "aborted"
  | "closed"
  | "remote-rejected"
  | "identity"
  | "protocol"
  | "blocked"
  | "queue-quota"
  | "transport";
export interface RpcMeasurement {
  operation: RpcOperation;
  outcome: RpcOutcome;
  phase: "queue" | "connect" | RpcPhase;
  queueMs: number;
  transactionMs: number;
}
export function rpcOperation(request: unknown): RpcOperation {
  if (!request || typeof request !== "object") return "unknown";
  if (
    "op" in request &&
    (request.op === "find-node" ||
      request.op === "find-value" ||
      request.op === "put")
  )
    return request.op;
  if ("namespace" in request && request.namespace === "companion/direct/v1")
    return "direct";
  return "unknown";
}
export function rpcOutcome(error: unknown): RpcOutcome {
  if (!(error instanceof Error)) return "transport";
  if (error.name === "AbortError") return "aborted";
  switch (error.message) {
    case "RPC_TIMEOUT":
      return "timeout";
    case "RPC_ABORTED":
    case "OVERLAY_CLOSED":
      return "aborted";
    case "RPC_CLOSED":
      return "closed";
    case "REMOTE_RPC_REJECTED":
      return "remote-rejected";
    case "PEER_ID_MISMATCH":
    case "INVALID_IDENTITY":
    case "SELF_CONNECTION":
    case "INVALID_HANDSHAKE_SIGNATURE":
    case "UNAUTHENTICATED_TRANSPORT":
      return "identity";
    case "INCOMPATIBLE_PROTOCOL":
    case "INVALID_RPC_RESPONSE":
    case "FRAME_TOO_LARGE":
    case "FRAME_QUOTA":
    case "INVALID_FRAME":
      return "protocol";
    case "BLOCKED_PEER":
      return "blocked";
    default:
      return "transport";
  }
}

// Local-only fixed-schema diagnostics: no keys, IPs, payloads, signatures, raw errors or timestamps.
export class RpcDiagnostics {
  private total = 0;
  private counts: Partial<Record<RpcOutcome, number>> = {};
  private recent: RpcMeasurement[] = [];
  private failures: RpcMeasurement[] = [];
  record(value: RpcMeasurement): void {
    const bounded = (duration: number) =>
      Number.isFinite(duration)
        ? Math.round(Math.max(0, Math.min(duration, 600_000)) * 100) / 100
        : 0;
    const measurement = {
      operation: value.operation,
      outcome: value.outcome,
      phase: value.phase,
      queueMs: bounded(value.queueMs),
      transactionMs: bounded(value.transactionMs),
    };
    this.total = Math.min(Number.MAX_SAFE_INTEGER, this.total + 1);
    this.counts[value.outcome] = Math.min(
      Number.MAX_SAFE_INTEGER,
      (this.counts[value.outcome] ?? 0) + 1,
    );
    this.recent.push(measurement);
    if (this.recent.length > 32) this.recent.shift();
    if (value.outcome !== "success") {
      this.failures.push(measurement);
      if (this.failures.length > 16) this.failures.shift();
    }
  }
  snapshot(queued: number) {
    return {
      queued,
      total: this.total,
      outcomes: { ...this.counts },
      recent: this.recent.map((entry) => ({ ...entry })),
      recentFailures: this.failures.map((entry) => ({ ...entry })),
    };
  }
}
