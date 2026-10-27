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
  contacts: AsyncIterable<PeerContact>,
  probe: (contact: PeerContact, signal: AbortSignal) => Promise<ProbeResult>,
  onState: (state: SearchState) => void,
  options: { timeoutMs?: number; now?: () => number } = {},
): Promise<Candidate[]> {
  const timeout = options.timeoutMs ?? 3000,
    now = options.now ?? Date.now;
  if (!Number.isFinite(timeout) || timeout < 1)
    throw new Error("INVALID_TIMEOUT");
  onState("discovering");
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("SEARCH_TIMEOUT"));
    }, timeout);
  });
  const results: Candidate[] = [],
    seen = new Set<string>();
  const run = async () => {
    let batch: Promise<void>[] = [];
    for await (const contact of contacts) {
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
    await Promise.race([run(), deadline]);
  } catch {
    onState("retrying");
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  results.sort((a, b) => a.latencyMs - b.latencyMs || b.seenAt - a.seenAt);
  onState(results.length ? "candidates-found" : "no-reachable-candidate");
  return results;
}
