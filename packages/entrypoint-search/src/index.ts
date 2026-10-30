import type { PeerContact } from "../../protocol/src/index.js";
export type SearchState =
  | "discovering"
  | "candidates-found"
  | "no-reachable-candidate"
  | "retrying";
export interface Candidate {
  contact: PeerContact;
  latencyMs: number;
  seenAt: number;
}
export interface ProbeResult {
  version: number;
  authenticated: boolean;
}
export async function searchEntrypoints(
  contacts:
    | AsyncIterable<PeerContact>
    | ((signal: AbortSignal) => AsyncIterable<PeerContact>),
  probe: (contact: PeerContact, signal: AbortSignal) => Promise<ProbeResult>,
  onState: (state: SearchState) => void,
  options: {
    timeoutMs?: number;
    now?: () => number;
    signal?: AbortSignal;
  } = {},
): Promise<Candidate[]> {
  const timeout = options.timeoutMs ?? 3000,
    now = options.now ?? Date.now;
  if (!Number.isFinite(timeout) || timeout < 1)
    throw new Error("INVALID_TIMEOUT");
  onState("discovering");
  const controller = new AbortController();
  let iterator: AsyncIterator<PeerContact>;
  try {
    iterator = options.signal?.aborted
      ? { next: async () => ({ done: true, value: undefined }) }
      : (typeof contacts === "function"
          ? contacts(controller.signal)
          : contacts)[Symbol.asyncIterator]();
  } catch {
    controller.abort();
    onState("retrying");
    onState("no-reachable-candidate");
    return [];
  }
  let rejectDeadline: (error: Error) => void = () => {};
  const cancel = () => {
    controller.abort();
    rejectDeadline(new Error("SEARCH_ABORTED"));
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("SEARCH_TIMEOUT"));
    }, timeout);
  });
  options.signal?.addEventListener("abort", cancel, { once: true });
  const results: Candidate[] = [],
    seen = new Set<string>();
  const run = async () => {
    let batch: Promise<void>[] = [];
    while (!controller.signal.aborted) {
      const next = await iterator.next();
      if (next.done) break;
      const contact = next.value;
      if (controller.signal.aborted || seen.size >= 64) break;
      if (
        !(contact.publicKey instanceof Uint8Array) ||
        contact.publicKey.byteLength !== 32
      )
        continue;
      const key = Buffer.from(contact.publicKey).toString("hex");
      if (seen.has(key)) continue;
      seen.add(key);
      const started = now();
      batch.push(
        (async () => {
          try {
            const result = await probe(contact, controller.signal);
            if (
              !controller.signal.aborted &&
              result.version === 1 &&
              result.authenticated === true
            )
              results.push({
                contact,
                latencyMs: Math.max(0, now() - started),
                seenAt: now(),
              });
          } catch {
            /* A failed probe says nothing about global network existence. */
          }
        })(),
      );
      if (batch.length === 4) {
        await Promise.all(batch);
        batch = [];
      }
    }
    await Promise.all(batch);
  };
  try {
    if (options.signal?.aborted) throw new Error("SEARCH_ABORTED");
    await Promise.race([run(), deadline]);
  } catch {
    onState("retrying");
  } finally {
    clearTimeout(timer);
    controller.abort();
    options.signal?.removeEventListener("abort", cancel);
    void iterator.return?.().catch(() => {});
  }
  results.sort((a, b) => a.latencyMs - b.latencyMs || b.seenAt - a.seenAt);
  onState(results.length ? "candidates-found" : "no-reachable-candidate");
  return results;
}
