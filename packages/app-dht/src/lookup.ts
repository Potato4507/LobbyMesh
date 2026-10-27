import { xorDistance } from "./index.js";

export interface Referral {
  id: string;
  transportKey: string;
}
export function parseReferrals(value: unknown): Referral[] {
  if (!Array.isArray(value) || value.length > 20)
    throw new Error("INVALID_CONTACTS");
  return value.map((v: Referral) => {
    if (
      !v ||
      typeof v.id !== "string" ||
      typeof v.transportKey !== "string" ||
      !/^[a-f0-9]{64}$/.test(v.id) ||
      !/^[a-f0-9]{64}$/.test(v.transportKey)
    )
      throw new Error("INVALID_CONTACT");
    return { id: v.id, transportKey: v.transportKey };
  });
}
export interface LookupResult {
  state: "exhausted" | "budget" | "timeout" | "aborted";
  queried: number;
  failures: number;
  authenticated: Referral[];
}
// Query must authenticate the referral's app ID before returning. Hints never equal membership.
export async function iterativeLookup(
  target: string,
  self: string,
  seeds: Referral[],
  query: (peer: Referral, signal: AbortSignal) => Promise<Referral[]>,
  options: {
    alpha?: number;
    maxQueries?: number;
    maxCandidates?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<LookupResult> {
  xorDistance(target, self);
  const alpha = options.alpha ?? 3,
    maxQueries = options.maxQueries ?? 32,
    maxCandidates = options.maxCandidates ?? 64,
    timeoutMs = options.timeoutMs ?? 3000;
  for (const [number, max] of [
    [alpha, 8],
    [maxQueries, 256],
    [maxCandidates, 512],
    [timeoutMs, 60_000],
  ])
    if (
      !Number.isSafeInteger(number) ||
      (number ?? 0) < 1 ||
      (number ?? 0) > (max ?? 0)
    )
      throw new Error("INVALID_LOOKUP_LIMIT");
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const candidates = new Map<string, Referral>(),
    visited = new Set<string>();
  const authenticated: Referral[] = [];
  let queried = 0,
    failures = 0,
    clipped = false;
  const compare = (a: Referral, b: Referral) => {
    const x = xorDistance(a.id, target),
      y = xorDistance(b.id, target);
    return x < y ? -1 : x > y ? 1 : 0;
  };
  const add = (contacts: Referral[]) => {
    for (const contact of contacts) {
      if (
        contact.id === self ||
        visited.has(contact.id) ||
        candidates.has(contact.id)
      )
        continue;
      if (candidates.size >= maxCandidates) {
        clipped = true;
        const farthest = [...candidates.values()].sort(compare).at(-1);
        if (!farthest || compare(contact, farthest) >= 0) continue;
        candidates.delete(farthest.id);
      }
      candidates.set(contact.id, { ...contact });
    }
  };
  add(parseReferrals(seeds));
  const snapshot = (state: LookupResult["state"]): LookupResult => ({
    state,
    queried,
    failures,
    authenticated: authenticated.map((c) => ({ ...c })),
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const deadline = new Promise<LookupResult>((resolve) => {
    timer = setTimeout(() => {
      resolve(snapshot("timeout"));
      controller.abort();
    }, timeoutMs);
    abortListener = () => resolve(snapshot("aborted"));
    options.signal?.addEventListener("abort", abortListener, { once: true });
  });
  const run = async (): Promise<LookupResult> => {
    while (!signal.aborted) {
      const batch = [...candidates.values()]
        .filter((c) => !visited.has(c.id))
        .sort(compare)
        .slice(0, Math.min(alpha, maxQueries - queried));
      if (!batch.length)
        return snapshot(
          queried >= maxQueries || clipped ? "budget" : "exhausted",
        );
      await Promise.all(
        batch.map(async (peer) => {
          visited.add(peer.id);
          queried++;
          try {
            const contacts = parseReferrals(await query(peer, signal));
            if (!signal.aborted) {
              authenticated.push(peer);
              add(contacts);
            }
          } catch {
            if (!signal.aborted) failures++;
          }
        }),
      );
    }
    return snapshot("aborted");
  };
  try {
    if (options.signal?.aborted) return snapshot("aborted");
    return await Promise.race([run(), deadline]);
  } finally {
    clearTimeout(timer);
    if (abortListener)
      options.signal?.removeEventListener("abort", abortListener);
    controller.abort();
  }
}
