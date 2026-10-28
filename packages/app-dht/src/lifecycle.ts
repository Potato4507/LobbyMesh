import { randomInt } from "node:crypto";
import type { MaintenanceReport } from "./maintenance.js";

export interface ManagedNetwork {
  start(): Promise<unknown>;
  stop(): Promise<void>;
  status(): MaintenanceReport | undefined;
  peerCount(): number;
}
export interface NetworkStatus {
  state:
    | "offline"
    | "starting"
    | "online"
    | "retrying"
    | "stopping"
    | "suspended"
    | "error";
  enabled: boolean;
  peers: number;
  discovery: MaintenanceReport["discovery"] | null;
  attempt: number;
  retryAt: number | null;
  error: "START_FAILED" | "START_TIMEOUT" | "STOP_FAILED" | null;
}
type Schedule = (run: () => void, ms: number) => () => void;
const schedule: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  timer.unref();
  return () => clearTimeout(timer);
};
async function within<T>(
  work: Promise<T>,
  ms: number,
  code: string,
  signal?: AbortSignal,
): Promise<T> {
  let rejectDeadline: (error: Error) => void = () => {};
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const abort = () => rejectDeadline(new Error("ABORTED"));
  const timer = setTimeout(() => rejectDeadline(new Error(code)), ms);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throw new Error("ABORTED");
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
// Coordinates a single network instance. Factories must honor cancellation and
// stop must release sockets; ignored injected code cannot be forcibly terminated.
export class NetworkLifecycle {
  private desired = false;
  private sleeping = false;
  private closed = false;
  private generation = 0;
  private attempt = 0;
  private runtime: ManagedNetwork | undefined;
  private opening: AbortController | undefined;
  private cancelRetry: (() => void) | undefined;
  private readonly jobs = new Set<Promise<void>>();
  private readonly cleanup = new Map<ManagedNetwork, Promise<void>>();
  private readonly orphans = new Set<ManagedNetwork>();
  private view: NetworkStatus = {
    state: "offline",
    enabled: false,
    peers: 0,
    discovery: null,
    attempt: 0,
    retryAt: null,
    error: null,
  };
  constructor(
    private readonly factory: (signal: AbortSignal) => Promise<ManagedNetwork>,
    private readonly options: {
      startupMs?: number;
      shutdownMs?: number;
      maxAttempts?: number;
      now?: () => number;
      jitter?: () => number;
      schedule?: Schedule;
    } = {},
  ) {
    for (const [value, max] of [
      [options.startupMs ?? 15_000, 60_000],
      [options.shutdownMs ?? 3000, 30_000],
      [options.maxAttempts ?? 3, 5],
    ])
      if (
        !Number.isSafeInteger(value) ||
        (value ?? 0) < 1 ||
        (value ?? 0) > (max ?? 0)
      )
        throw new Error("INVALID_LIFECYCLE_LIMIT");
  }
  status(): NetworkStatus {
    const report =
      this.view.state === "online" ? this.runtime?.status() : undefined;
    return {
      ...this.view,
      enabled: this.desired,
      peers:
        this.view.state === "online" ? (this.runtime?.peerCount() ?? 0) : 0,
      discovery: report?.discovery ?? this.view.discovery,
    };
  }
  private publish(
    state: NetworkStatus["state"],
    error: NetworkStatus["error"] = null,
    retryAt: number | null = null,
  ) {
    this.view = {
      state,
      error,
      retryAt,
      enabled: this.desired,
      attempt: this.attempt,
      peers: 0,
      discovery: null,
    };
  }
  private track(work: Promise<void>): void {
    this.jobs.add(work);
    void work.finally(() => this.jobs.delete(work)).catch(() => {});
  }
  private reap(runtime: ManagedNetwork): Promise<void> {
    const existing = this.cleanup.get(runtime);
    if (existing) return existing;
    const work = within(
      Promise.resolve().then(() => runtime.stop()),
      this.options.shutdownMs ?? 3000,
      "STOP_FAILED",
    )
      .then(() => {
        this.orphans.delete(runtime);
        if (this.runtime === runtime) this.runtime = undefined;
      })
      .finally(() => this.cleanup.delete(runtime));
    this.cleanup.set(runtime, work);
    return work;
  }
  setEnabled(enabled: boolean): NetworkStatus {
    if (this.closed) throw new Error("LIFECYCLE_CLOSED");
    if (typeof enabled !== "boolean")
      throw new Error("INVALID_NETWORK_PERMISSION");
    if (
      this.desired === enabled &&
      (this.view.state === "online" ||
        this.view.state === "starting" ||
        this.view.state === "retrying" ||
        (!enabled && this.view.state === "offline"))
    )
      return this.status();
    this.desired = enabled;
    this.attempt = 0;
    this.cancelRetry?.();
    this.cancelRetry = undefined;
    this.opening?.abort();
    if (!enabled || this.sleeping || this.runtime || this.orphans.size)
      this.halt();
    else this.launch();
    return this.status();
  }
  private launch(): void {
    if (!this.desired || this.sleeping || this.closed) return;
    const token = ++this.generation,
      controller = new AbortController();
    this.opening = controller;
    this.attempt++;
    this.publish("starting");
    this.track(this.open(token, controller));
  }
  private async open(
    token: number,
    controller: AbortController,
  ): Promise<void> {
    let created: ManagedNetwork | undefined;
    const production = Promise.resolve().then(() =>
      this.factory(controller.signal),
    );
    // If an injected factory resolves after cancellation, dispose that late result.
    void production
      .then((runtime) => {
        if (controller.signal.aborted) {
          this.orphans.add(runtime);
          this.track(
            this.reap(runtime).catch(() => {
              this.publish("error", "STOP_FAILED");
            }),
          );
        }
      })
      .catch(() => {});
    try {
      await within(
        (async () => {
          created = await production;
          if (controller.signal.aborted || token !== this.generation)
            throw new Error("ABORTED");
          this.runtime = created;
          await created.start();
        })(),
        this.options.startupMs ?? 15_000,
        "START_TIMEOUT",
        controller.signal,
      );
      if (!controller.signal.aborted && token === this.generation)
        this.publish("online");
    } catch (error) {
      controller.abort();
      if (created) {
        try {
          await this.reap(created);
        } catch {
          if (token === this.generation) this.publish("error", "STOP_FAILED");
          return;
        }
      }
      if (
        token !== this.generation ||
        !this.desired ||
        this.sleeping ||
        this.closed
      )
        return;
      const code =
        error instanceof Error && error.message === "START_TIMEOUT"
          ? "START_TIMEOUT"
          : "START_FAILED";
      if (this.attempt >= (this.options.maxAttempts ?? 3)) {
        this.publish("error", code);
        return;
      }
      const jitter = this.options.jitter?.() ?? randomInt(0, 101);
      if (!Number.isSafeInteger(jitter) || jitter < 0 || jitter > 100) {
        this.publish("error", "START_FAILED");
        return;
      }
      const wait = Math.min(10_000, 500 * 2 ** (this.attempt - 1) + jitter);
      this.publish("retrying", code, (this.options.now ?? Date.now)() + wait);
      this.cancelRetry = (this.options.schedule ?? schedule)(() => {
        this.cancelRetry = undefined;
        this.launch();
      }, wait);
    } finally {
      if (this.opening === controller) this.opening = undefined;
    }
  }
  private halt(): void {
    const token = ++this.generation;
    this.opening?.abort();
    this.cancelRetry?.();
    this.cancelRetry = undefined;
    const runtimes = [
      ...new Set([...(this.runtime ? [this.runtime] : []), ...this.orphans]),
    ];
    this.publish(
      runtimes.length
        ? "stopping"
        : this.desired && this.sleeping
          ? "suspended"
          : "offline",
    );
    if (!runtimes.length) {
      if (this.desired && !this.sleeping && !this.closed) this.launch();
      return;
    }
    this.track(
      (async () => {
        try {
          await Promise.all(runtimes.map((runtime) => this.reap(runtime)));
        } catch {
          if (token === this.generation) this.publish("error", "STOP_FAILED");
          return;
        }
        if (token !== this.generation) return;
        this.publish(this.desired && this.sleeping ? "suspended" : "offline");
        if (this.desired && !this.sleeping && !this.closed) this.launch();
      })(),
    );
  }
  suspend(): void {
    if (this.closed || this.sleeping) return;
    this.sleeping = true;
    this.halt();
  }
  resume(): void {
    if (this.closed || !this.sleeping) return;
    this.sleeping = false;
    this.attempt = 0;
    if (this.desired) {
      if (this.runtime || this.orphans.size) this.halt();
      else this.launch();
    } else this.publish("offline");
  }
  async settled(): Promise<void> {
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
  }
  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.desired = false;
      this.halt();
    }
    await this.settled();
    if (this.runtime || this.orphans.size)
      throw new Error("NETWORK_CLEANUP_INCOMPLETE");
  }
}
