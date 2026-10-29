export interface DeliveryFailure {
  reason:
    | "canceled"
    | "permission-changed"
    | "timeout"
    | "peer-rejected"
    | "invalid-response"
    | "unknown";
  stage: "connection" | "delivery";
}

// Local projection only, never a remote assertion or an exception-message echo.
export function deliveryFailure(
  error: unknown,
  stage: DeliveryFailure["stage"],
  canceled: boolean,
  permissionChanged: boolean,
): DeliveryFailure {
  if (permissionChanged) return { reason: "permission-changed", stage };
  if (canceled) return { reason: "canceled", stage };
  const code = error instanceof Error ? error.message : null;
  const reason: DeliveryFailure["reason"] =
    code === "DIRECT_TIMEOUT" || code === "RPC_TIMEOUT"
      ? "timeout"
      : code === "REMOTE_RPC_REJECTED"
        ? "peer-rejected"
        : [
              "INVALID_ACK",
              "INVALID_HEARTBEAT",
              "INCOMPATIBLE_DIRECT_PROTOCOL",
              "PEER_ID_MISMATCH",
            ].includes(code ?? "")
          ? "invalid-response"
          : "unknown";
  return { reason, stage };
}

export function unconfirmedLabel(
  failure: DeliveryFailure | null | undefined,
): string {
  const reason = failure?.reason;
  const detail =
    reason === "canceled"
      ? "Canceled locally"
      : reason === "permission-changed"
        ? "Local contact permission changed"
        : reason === "timeout"
          ? failure?.stage === "connection"
            ? "Connection timed out"
            : "Send timed out"
          : reason === "peer-rejected"
            ? "Peer app rejected the request"
            : reason === "invalid-response"
              ? "Peer response could not be verified"
              : null;
  return detail ? `${detail} · delivery unconfirmed` : "Delivery unconfirmed";
}
