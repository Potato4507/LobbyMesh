import {
  type ProbeResult,
  type SearchState,
  searchEntrypoints,
} from "../../entrypoint-search/src/index.js";
import type {
  BootstrapDiscovery,
  PeerContact,
} from "../../protocol/src/index.js";
import type { LookupResult } from "./lookup.js";

export interface MaintenanceOverlay {
  probe(contact: PeerContact, signal: AbortSignal): Promise<ProbeResult>;
  refresh(signal: AbortSignal): Promise<LookupResult>;
  synchronize?(
    signal: AbortSignal,
  ): Promise<{ state: "complete" | "budget" | "aborted" }>;
}
export interface MaintenanceReport {
  at: number;
  discovery: SearchState;
  authenticatedCandidates: number;
  routing: LookupResult["state"] | "failed";
  announcement: "initial" | "republished" | "failed";
  replication: "not-configured" | "complete" | "budget" | "aborted" | "failed";
}
type Schedule = (run: () => void, delayMs: number) => () => void;
const schedule: Schedule = (run, delayMs) => {
  const timer = setTimeout(run, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
};
// Owned by the app lifecycle. Never starts a service merely by importing this module.
export class OverlayMaintenance {
  private running = false;
  private closed = false;
  private cancelTimer: (() => void) | undefined;
  private cycle: Promise<MaintenanceReport> | undefined;
  private controller: AbortController | undefined;
  private lastReport: MaintenanceReport | undefined;
  constructor(
    private readonly discovery: BootstrapDiscovery,
    private readonly overlay: MaintenanceOverlay,
    private readonly options: {
      intervalMs?: number;
      searchTimeoutMs?: number;
      now?: () => number;
      schedule?: Schedule;
    } = {},
  ) {
    const interval = options.intervalMs ?? 30_000,
      timeout = options.searchTimeoutMs ?? 3000;
    if (
      !Number.isSafeInteger(interval) ||
      interval < 30_000 ||
      interval > 600_000 ||
      !Number.isSafeInteger(timeout) ||
      timeout < 1 ||
      timeout > 60_000
    )
      throw new Error("INVALID_MAINTENANCE_LIMITS");
  }
  start(): Promise<MaintenanceReport> {
    if (this.closed) return Promise.reject(new Error("MAINTENANCE_CLOSED"));
    if (this.running && this.lastReport)
      return this.cycle ?? Promise.resolve({ ...this.lastReport });
    this.running = true;
    return this.runOnce(this.lastReport === undefined);
  }
  private runOnce(initial: boolean): Promise<MaintenanceReport> {
    if (this.cycle) return this.cycle;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const report: MaintenanceReport = {
      at: (this.options.now ?? Date.now)(),
      discovery: "discovering",
      authenticatedCandidates: 0,
      routing: "failed",
      announcement: initial ? "initial" : "failed",
      replication: "not-configured",
    };
    const work = async () => {
      try {
        const candidates = await searchEntrypoints(
          (searchSignal) => this.discovery.findAppEntrypoints(searchSignal),
          (contact, searchSignal) =>
            this.overlay.probe(
              contact,
              AbortSignal.any([signal, searchSignal]),
            ),
          (state) => {
            report.discovery = state;
          },
          { timeoutMs: this.options.searchTimeoutMs ?? 3000, signal },
        );
        report.authenticatedCandidates = candidates.length;
      } catch {
        report.discovery = "retrying";
      }
      if (!signal.aborted) {
        try {
          report.routing = (await this.overlay.refresh(signal)).state;
        } catch {
          report.routing = "failed";
        }
      }
      if (!initial && !signal.aborted) {
        try {
          await this.discovery.announceAppEntrypoint();
          report.announcement = "republished";
        } catch {
          report.announcement = "failed";
        }
      }
      if (this.overlay.synchronize && !signal.aborted) {
        try {
          report.replication = (await this.overlay.synchronize(signal)).state;
        } catch {
          report.replication = "failed";
        }
      }
      this.lastReport = { ...report };
      return { ...report };
    };
    this.cycle = work().finally(() => {
      this.cycle = undefined;
      if (this.running && !signal.aborted)
        this.cancelTimer = (this.options.schedule ?? schedule)(() => {
          this.cancelTimer = undefined;
          void this.runOnce(false);
        }, this.options.intervalMs ?? 30_000);
    });
    return this.cycle;
  }
  status(): MaintenanceReport | undefined {
    return this.lastReport ? { ...this.lastReport } : undefined;
  }
  async stop(): Promise<void> {
    this.running = false;
    this.closed = true;
    this.cancelTimer?.();
    this.cancelTimer = undefined;
    this.controller?.abort();
    await this.cycle;
  }
}
