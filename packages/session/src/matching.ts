import { createHash } from "node:crypto";
import type { Identity } from "../../identity/src/index.js";
import type { SessionIdentity } from "../../protocol/src/index.js";
import {
  type RecordV1,
  signRecord,
  validateRecord,
} from "../../security/src/records.js";

export const SESSION_EPOCH_MS = 60_000;
const DOMAIN = "companion/session-ad/v1";
const hex = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export function canonicalSession(session: SessionIdentity): string {
  if (
    !session ||
    typeof session.universeId !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(session.universeId) ||
    typeof session.placeId !== "string" ||
    !/^[1-9][0-9]{0,19}$/.test(session.placeId) ||
    typeof session.jobId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(session.jobId) ||
    !["test", "authorized-sdk", "official-api", "windows-log"].includes(
      session.evidenceSource,
    ) ||
    !["mock", "self-asserted", "externally-verified"].includes(
      session.verification,
    ) ||
    (session.evidenceSource === "test") !== (session.verification === "mock") ||
    (session.evidenceSource === "windows-log" &&
      session.verification !== "self-asserted")
  )
    throw new Error("INVALID_SESSION_EVIDENCE");
  return JSON.stringify([
    "companion/session-key/v1",
    session.universeId,
    session.placeId,
    session.jobId,
  ]);
}
export function sessionLookupKey(
  session: SessionIdentity,
  epoch: number,
): string {
  if (!Number.isSafeInteger(epoch) || epoch < 0)
    throw new Error("INVALID_EPOCH");
  // A deterministic hash scopes a claim. It is not a secret or evidence of server membership.
  return createHash("sha256")
    .update(JSON.stringify([canonicalSession(session), epoch]))
    .digest("hex");
}
interface Advertisement {
  version: 1;
  domain: typeof DOMAIN;
  state: "joined" | "left";
  consent: true;
  displayName: string;
  transportKey: string;
  claimedVerification: SessionIdentity["verification"];
  claimedSource: SessionIdentity["evidenceSource"];
}
export interface MatchedParticipant {
  peerId: string;
  displayName: string;
  transportKey: string;
  identityTrust: "app-key-only";
  consent: true;
  verification: "mock" | "self-asserted";
  claimedVerification: SessionIdentity["verification"];
}
export interface SessionDirectory {
  put(key: string, record: RecordV1): Promise<unknown>;
  lookup(key: string): Promise<{
    records: RecordV1[];
    routing?: { state: string; failures: number };
  }>;
}
function nameValid(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 64 &&
    !Array.from(name).some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  );
}
function parseAdvertisement(record: RecordV1): Advertisement {
  const value = JSON.parse(record.content) as Advertisement | null;
  if (
    !value ||
    value.version !== 1 ||
    value.domain !== DOMAIN ||
    !["joined", "left"].includes(value.state) ||
    value.consent !== true ||
    !hex(value.transportKey) ||
    !nameValid(value.displayName) ||
    !["mock", "self-asserted", "externally-verified"].includes(
      value.claimedVerification,
    ) ||
    !["test", "authorized-sdk", "official-api", "windows-log"].includes(
      value.claimedSource,
    ) ||
    (value.claimedSource === "windows-log" &&
      value.claimedVerification !== "self-asserted") ||
    (value.claimedSource === "test") !== (value.claimedVerification === "mock")
  )
    throw new Error("INVALID_SESSION_AD");
  return value;
}
export class SessionMembership {
  private readonly active = new Map<
    string,
    { expiresAt: number; ad: Advertisement }
  >();
  private sequence = -1;
  private tail: Promise<void> = Promise.resolve();
  constructor(
    private readonly identity: Identity,
    private readonly directory: SessionDirectory,
    private readonly options: {
      transportKey: string;
      displayName: string;
      now?: () => number;
      blocked?: (id: string) => boolean;
    },
  ) {
    if (!hex(options.transportKey) || !nameValid(options.displayName))
      throw new Error("INVALID_MEMBERSHIP_OPTIONS");
    this.options = { ...options };
  }
  private now(): number {
    const now = (this.options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_TIME");
    return now;
  }
  private async write(
    key: string,
    ad: Advertisement,
    now: number,
  ): Promise<void> {
    this.sequence = Math.max(this.sequence + 1, now);
    const record = signRecord(
      this.identity,
      key,
      JSON.stringify(ad),
      this.sequence,
      now,
      SESSION_EPOCH_MS,
    );
    await this.directory.put(key, record);
  }
  async update(
    session: SessionIdentity | null,
    consent: boolean,
  ): Promise<void> {
    // Copy and validate before queueing: a caller cannot mutate scope during an await.
    const snapshot = session ? { ...session } : null;
    if (snapshot) canonicalSession(snapshot);
    if (typeof consent !== "boolean")
      return Promise.reject(new Error("CONSENT_REQUIRED"));
    const task = this.tail.then(() => this.updateNow(snapshot, consent));
    this.tail = task.catch(() => {});
    return task;
  }
  private async updateNow(
    session: SessionIdentity | null,
    consent: boolean,
  ): Promise<void> {
    const now = this.now();
    const key =
      session && consent
        ? sessionLookupKey(session, Math.floor(now / SESSION_EPOCH_MS))
        : null;
    for (const [oldKey, old] of this.active) {
      if (old.expiresAt <= now) {
        this.active.delete(oldKey);
        continue;
      }
      if (oldKey !== key) {
        await this.write(oldKey, { ...old.ad, state: "left" }, now);
        this.active.delete(oldKey);
      }
    }
    if (!key || !session) return;
    const ad: Advertisement = {
      version: 1,
      domain: DOMAIN,
      state: "joined",
      consent: true,
      displayName: this.options.displayName,
      transportKey: this.options.transportKey,
      claimedVerification: session.verification,
      claimedSource: session.evidenceSource,
    };
    await this.write(key, ad, now);
    this.active.set(key, { expiresAt: now + SESSION_EPOCH_MS, ad });
  }
  leave(): Promise<void> {
    return this.update(null, false);
  }
  async find(
    session: SessionIdentity,
    consent: boolean,
  ): Promise<MatchedParticipant[]> {
    canonicalSession(session);
    if (consent !== true) return [];
    const now = this.now(),
      epoch = Math.floor(now / SESSION_EPOCH_MS);
    const latest = new Map<string, { record: RecordV1; ad: Advertisement }>();
    for (const window of epoch > 0 ? [epoch, epoch - 1] : [epoch]) {
      const key = sessionLookupKey(session, window);
      const result = await this.directory.lookup(key);
      if (
        result.routing &&
        (result.routing.state !== "exhausted" || result.routing.failures > 0)
      )
        throw new Error("SESSION_LOOKUP_INCOMPLETE");
      if (!Array.isArray(result.records) || result.records.length > 64)
        throw new Error("SESSION_RESULT_QUOTA");
      for (const candidate of result.records) {
        try {
          const record = validateRecord(candidate, key, this.now());
          if (this.options.blocked?.(record.author)) continue;
          const ad = parseAdvertisement(record);
          const previous = latest.get(record.author);
          if (!previous || record.seq > previous.record.seq)
            latest.set(record.author, { record, ad });
        } catch {
          /* Hostile records never become roster entries. */
        }
      }
    }
    return [...latest.values()]
      .filter(
        ({ record, ad }) =>
          ad.state === "joined" && record.expiresAt > this.now(),
      )
      .map<MatchedParticipant>(({ record, ad }) => ({
        peerId: record.author,
        displayName: ad.displayName,
        transportKey: ad.transportKey,
        identityTrust: "app-key-only",
        consent: true,
        verification:
          ad.claimedVerification === "mock" ? "mock" : "self-asserted",
        claimedVerification: ad.claimedVerification,
      }))
      .sort((a, b) => a.peerId.localeCompare(b.peerId));
  }
}
