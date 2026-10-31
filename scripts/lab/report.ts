export type LabStage =
  | "preflight"
  | "first-start"
  | "second-start"
  | "pairing"
  | "text"
  | "history"
  | "restart"
  | "voice-signaling"
  | "revocation";

// A remote process is not a source of trusted printable diagnostics. Copy only
// bounded counters; never forward its status object, error text or recent data.
export function labTransportSummary(value: unknown) {
  const object = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  const count = (v: unknown) =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null;
  const counters = (v: unknown, keys: string[]) => {
    const fields = object(v);
    return Object.fromEntries(keys.map((key) => [key, count(fields[key])]));
  };
  const outcomes = [
    "success",
    "timeout",
    "aborted",
    "closed",
    "remote-rejected",
    "handler-rejected",
    "identity",
    "protocol",
    "blocked",
    "queue-quota",
    "transport",
  ];
  const status = object(value),
    outgoing = object(status.diagnostics),
    inbound = object(status.inbound);
  const failures = (v: unknown) =>
    (Array.isArray(v) ? v.slice(-16) : []).flatMap((entry) => {
      const fields = object(entry);
      if (
        typeof fields.outcome !== "string" ||
        !outcomes.includes(fields.outcome) ||
        typeof fields.phase !== "string" ||
        ![
          "queue",
          "connect",
          "transport",
          "hello",
          "proof",
          "request",
          "response",
          "closing",
          "complete",
        ].includes(fields.phase)
      )
        return [];
      const duration = (n: unknown) =>
        typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 600000
          ? Math.round(n * 100) / 100
          : null;
      return [
        {
          outcome: fields.outcome,
          phase: fields.phase,
          queueMs: duration(fields.queueMs),
          transactionMs: duration(fields.transactionMs),
        },
      ];
    });
  return {
    outgoing: {
      queued: count(outgoing.queued),
      total: count(outgoing.total),
      outcomes: counters(outgoing.outcomes, outcomes),
      recentFailures: failures(outgoing.recentFailures),
    },
    inbound: {
      active: count(inbound.active),
      total: count(inbound.total),
      outcomes: counters(inbound.outcomes, outcomes),
      recentFailures: failures(inbound.recentFailures),
      admission: counters(inbound.admission, [
        "accepted",
        "disabled",
        "closed",
        "quota",
      ]),
    },
  };
}

// Only fixed codes and operation stages reach evidence. Never export raw SSH,
// native exception messages, invitations or control-channel values.
export function labRunReport(
  stage: LabStage,
  passed: boolean,
  cleanupVerified: boolean,
  error?: unknown,
) {
  if (passed && cleanupVerified)
    return { result: "passed", failureReason: null, failureStage: null };
  const allowed = [
    "LAB_ASKPASS_REQUIRED",
    "INVALID_LAB_REMOTE",
    "LAB_READY_TIMEOUT",
    "LAB_PROCESS_EXIT",
    "LAB_COMMAND_TIMEOUT",
    "LAB_REMOTE_REJECTED",
    "LAB_CLIENT_UNAVAILABLE",
  ];
  return {
    result: "failed",
    failureReason: passed
      ? "LAB_CLEANUP_UNCONFIRMED"
      : error instanceof Error && allowed.includes(error.message)
        ? error.message
        : "LAB_RUN_FAILED",
    failureStage: passed ? "cleanup" : stage,
  };
}
