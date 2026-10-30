import type {
  SessionIdentity,
  SessionProvider,
} from "../../protocol/src/index.js";
import type { MatchedParticipant } from "./matching.js";
import { canonicalSession } from "./matching.js";

interface MembershipOperations {
  update(session: SessionIdentity | null, consent: boolean): Promise<void>;
  find(
    session: SessionIdentity,
    consent: boolean,
  ): Promise<MatchedParticipant[]>;
  leave(): Promise<void>;
}
export interface SessionMatchStatus {
  state: "idle" | "consent-required" | "matching" | "ready" | "error";
  participants: MatchedParticipant[];
}
type Schedule = (run: () => void, delayMs: number) => () => void;
const schedule: Schedule = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
};
// Session evidence arrives only from the injected provider. No manual server-ID UI fallback.
export class SessionCoordinator {
  private running = false;
  private closed = false;
  private consent = false;
  private session: SessionIdentity | null = null;
  private revision = 0;
  private dirty = false;
  private cycle: Promise<void> | undefined;
  private starting: Promise<void> | undefined;
  private stopping: Promise<void> | undefined;
  private unsubscribe: (() => void) | undefined;
  private cancelTimer: (() => void) | undefined;
  private view: SessionMatchStatus = { state: "idle", participants: [] };
  constructor(
    private readonly provider: SessionProvider,
    private readonly membership: MembershipOperations,
    private readonly options: { refreshMs?: number; schedule?: Schedule } = {},
  ) {
    const refresh = options.refreshMs ?? 20_000;
    if (!Number.isSafeInteger(refresh) || refresh < 10_000 || refresh > 30_000)
      throw new Error("INVALID_REFRESH_INTERVAL");
  }
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("COORDINATOR_CLOSED"));
    this.starting ??= (async () => {
      this.running = true;
      this.unsubscribe = this.provider.subscribe((value) => {
        if (!this.running) return;
        this.revision++;
        this.accept(value);
        void this.reconcile();
      });
      await this.resample();
    })();
    return this.starting;
  }
  private accept(value: SessionIdentity | null): void {
    try {
      if (value) canonicalSession(value);
      this.session = value ? { ...value } : null;
      this.view = {
        state: value
          ? this.consent
            ? "matching"
            : "consent-required"
          : "idle",
        participants: [],
      };
    } catch {
      if (!this.running) return;
      this.session = null;
      this.view = { state: "error", participants: [] };
    }
  }
  private async resample(): Promise<void> {
    const revision = this.revision;
    try {
      const value = await this.provider.current();
      if (!this.running) return;
      if (revision === this.revision) {
        this.revision++;
        this.accept(value);
      }
    } catch {
      if (!this.running) return;
      if (revision === this.revision) {
        this.revision++;
        this.session = null;
        this.view = { state: "error", participants: [] };
      }
    }
    await this.reconcile();
  }
  async setConsent(consent: boolean): Promise<void> {
    if (this.closed) throw new Error("COORDINATOR_CLOSED");
    if (typeof consent !== "boolean") throw new Error("CONSENT_REQUIRED");
    this.consent = consent;
    this.revision++;
    this.view = {
      state: this.session
        ? consent
          ? "matching"
          : "consent-required"
        : "idle",
      participants: [],
    };
    if (this.running) await this.reconcile();
  }
  private reconcile(): Promise<void> {
    this.dirty = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    if (this.cycle) return this.cycle;
    this.cycle = (async () => {
      while (this.running && this.dirty) {
        this.dirty = false;
        const revision = this.revision,
          session = this.session ? { ...this.session } : null,
          consent = this.consent;
        const evidenceError = this.view.state === "error";
        try {
          await this.membership.update(session, consent);
          // A publication already in progress may finish after withdrawal or a
          // newer session event. Do not start another lookup for that old scope.
          if (revision !== this.revision || !this.running) continue;
          const participants =
            session && consent ? await this.membership.find(session, true) : [];
          if (revision === this.revision && this.running)
            this.view = {
              state: evidenceError
                ? "error"
                : session
                  ? consent
                    ? "ready"
                    : "consent-required"
                  : "idle",
              participants,
            };
        } catch {
          if (revision === this.revision)
            this.view = { state: "error", participants: [] };
        }
      }
    })().finally(() => {
      this.cycle = undefined;
      if (this.running)
        this.cancelTimer = (this.options.schedule ?? schedule)(() => {
          this.cancelTimer = undefined;
          void this.resample();
        }, this.options.refreshMs ?? 20_000);
    });
    return this.cycle;
  }
  settled(): Promise<void> {
    return this.cycle ?? Promise.resolve();
  }
  status(): SessionMatchStatus {
    return {
      state: this.view.state,
      participants: this.view.participants.map((p) => ({ ...p })),
    };
  }
  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.closed = true;
      this.running = false;
      this.revision++;
      this.cancelTimer?.();
      this.cancelTimer = undefined;
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      await this.cycle;
      try {
        await this.membership.leave();
        this.view = { state: "idle", participants: [] };
      } catch {
        this.view = { state: "error", participants: [] };
      }
    })();
    return this.stopping;
  }
}
