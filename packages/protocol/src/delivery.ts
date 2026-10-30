export interface DeliveryFailure {
  reason:
    | "canceled"
    | "permission-changed"
    | "timeout"
    | "peer-rejected"
    | "invalid-response"
    | "contact-not-located"
    | "lookup-incomplete"
    | "lookup-deferred"
    | "unknown";
  stage: "connection" | "delivery";
}

export interface MessageCancel {
  peerId: string;
  localId: string;
}
export function parseMessageCancel(value: unknown): MessageCancel {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "localId,peerId"
  )
    throw new Error("INVALID_MESSAGE_CANCEL");
  const request = value as MessageCancel;
  if (
    typeof request.peerId !== "string" ||
    !/^[a-f0-9]{64}$/.test(request.peerId) ||
    typeof request.localId !== "string" ||
    !/^[a-f0-9]{32}$/.test(request.localId)
  )
    throw new Error("INVALID_MESSAGE_CANCEL");
  return { peerId: request.peerId, localId: request.localId };
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
  if (stage === "connection") {
    if (code === "CONTACT_SEARCH_NOT_LOCATED")
      return { reason: "contact-not-located", stage };
    if (code === "CONTACT_SEARCH_INCOMPLETE")
      return { reason: "lookup-incomplete", stage };
    if (code === "CONTACT_SEARCH_BUSY" || code === "CONTACT_SEARCH_RATE_LIMIT")
      return { reason: "lookup-deferred", stage };
  }
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
  if (failure?.stage === "connection") {
    const lookup =
      reason === "contact-not-located"
        ? "Contact not located in this attempt"
        : reason === "lookup-incomplete"
          ? "Contact lookup was incomplete"
          : reason === "lookup-deferred"
            ? "Contact lookup unavailable right now; try again shortly"
            : null;
    if (lookup) return `${lookup} · delivery unconfirmed`;
  }
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
