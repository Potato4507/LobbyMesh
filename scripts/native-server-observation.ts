interface AbortServer {
  _abort(...args: unknown[]): unknown;
}

export function nativeServerAbortCallerLine(stack: unknown): number | null {
  if (typeof stack !== "string" || stack.length > 16384) return null;
  const match = /[/\\]hyperdht[/\\]lib[/\\]server\.js:(\d{1,5}):\d+/.exec(
    stack,
  );
  const line = Number(match?.[1]);
  return Number.isSafeInteger(line) && line > 0 && line <= 10000 ? line : null;
}

// Diagnostic instance only: preserve the native call, receiver and result.
// Never retain handshake objects, addresses, keys, payloads or native errors.
export function observeNativeServerAborts(server: AbortServer) {
  if (typeof server._abort !== "function")
    throw new Error("NATIVE_SERVER_OBSERVATION_UNSUPPORTED");
  const original = server._abort;
  const object = (value: unknown): Record<string, unknown> =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const flag = (value: unknown) => (typeof value === "boolean" ? value : null);
  const sample = (value: unknown, callerLine: number | null) => {
    const h = object(value),
      p = object(h.puncher),
      raw = object(h.rawStream);
    return {
      callerLine,
      payloadPresent: h.payload != null,
      puncherPresent: h.puncher != null,
      puncherDestroyed: flag(p.destroyed),
      puncherSocketPresent: p.socket != null,
      rawStreamPresent: h.rawStream != null,
      rawStreamConnected: flag(raw.connected),
      encryptedStreamPresent: h.encryptedSocket != null,
    };
  };
  let total = 0;
  const recent: ReturnType<typeof sample>[] = [];
  function observed(this: AbortServer, ...args: unknown[]) {
    total = Math.min(Number.MAX_SAFE_INTEGER, total + 1);
    recent.push(
      sample(args[0], nativeServerAbortCallerLine(new Error().stack)),
    );
    if (recent.length > 16) recent.shift();
    return original.apply(this, args);
  }
  server._abort = observed;
  return {
    snapshot: () => ({ total, recent: recent.map((entry) => ({ ...entry })) }),
    restore() {
      if (server._abort === observed) server._abort = original;
    },
  };
}
