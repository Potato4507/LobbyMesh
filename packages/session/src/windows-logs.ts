import { open, opendir } from "node:fs/promises";
import path from "node:path";
import type {
  SessionIdentity,
  SessionProvider,
} from "../../protocol/src/index.js";

export type DetectionState =
  | "disabled"
  | "unsupported"
  | "waiting"
  | "incomplete"
  | "detected"
  | "stale"
  | "ambiguous"
  | "unavailable";
export interface DetectionStatus {
  state: DetectionState;
  source: "windows-log";
  verification: "self-asserted";
}
const MAX_READ = 256 * 1024;
const MAX_LINE = 16 * 1024;
const FRESH_MS = 120_000;
const id = "([1-9][0-9]{0,19})";
const join = new RegExp(
  `^\\[FLog::Output\\] ! Joining game '([a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12})' place ${id} at `,
);
const universe = new RegExp(
  `^\\[FLog::GameJoinLoadTime\\] Report game_join_loadtime:.*?\\buniverseid:${id}(?:,|\\s|$)`,
);

// Only explicit engine log channels are accepted; CreatorOutput/script text cannot supply evidence.
export class PlayerLogParser {
  private pending:
    | {
        jobId: string;
        placeId: string;
        universeId?: string;
        connected: boolean;
      }
    | undefined;
  private value: SessionIdentity | null = null;
  private lastTime = 0;
  reset(): void {
    this.pending = undefined;
    this.value = null;
    this.lastTime = 0;
  }
  session(): SessionIdentity | null {
    return this.value ? { ...this.value } : null;
  }
  state(): "waiting" | "incomplete" | "detected" {
    return this.value ? "detected" : this.pending ? "incomplete" : "waiting";
  }
  line(line: string, now: number): void {
    if (line.length > MAX_LINE) {
      this.reset();
      return;
    }
    const header =
      /^(\d{4}-\d{2}-\d{2}T[^,]{1,32}),[^\r\n]*? (\[FLog::[^\r\n]*)$/.exec(
        line,
      );
    if (!header) return;
    const timestamp = Date.parse(header[1] ?? ""),
      message = header[2] ?? "";
    if (
      !Number.isFinite(timestamp) ||
      timestamp > now + 5_000 ||
      now - timestamp > FRESH_MS ||
      timestamp < this.lastTime
    )
      return;
    this.lastTime = timestamp;
    if (
      /^\[FLog::(?:Network|SingleSurfaceApp|UgcExperienceController)\] (?:Time to disconnect replication data:|leaveUGCGameInternal|UgcExperienceController: doTeleport:)/.test(
        message,
      )
    ) {
      this.pending = undefined;
      this.value = null;
      return;
    }
    if (message.startsWith("[FLog::Output] ! Joining game")) {
      this.pending = undefined;
      this.value = null;
      const match = join.exec(message);
      if (match)
        this.pending = {
          jobId: (match[1] ?? "").toLowerCase(),
          placeId: match[2] ?? "",
          connected: false,
        };
      return;
    }
    if (!this.pending) return;
    const match = universe.exec(message);
    if (match?.[1]) this.pending.universeId = match[1];
    if (message.startsWith("[FLog::Network] Replicator created: "))
      this.pending.connected = true;
    if (this.pending.connected && this.pending.universeId)
      this.value = {
        universeId: this.pending.universeId,
        placeId: this.pending.placeId,
        jobId: this.pending.jobId,
        evidenceSource: "windows-log",
        verification: "self-asserted",
      };
  }
}

export function windowsLogDirectories(
  localAppData: string | undefined,
  platform = process.platform,
): string[] {
  if (platform !== "win32" || !localAppData) return [];
  return [
    path.join(localAppData, "Roblox", "logs"),
    path.join(
      localAppData,
      "Packages",
      "ROBLOXCorporation.ROBLOX_55nm5eh3cm0pr",
      "LocalState",
      "logs",
    ),
  ];
}

// Read-only, bounded polling tolerates append/rotation without depending on fs.watch notifications.
// Freshness is conservative: silent logs expire instead of silently retaining a departed session.
export class WindowsLogSessionProvider implements SessionProvider {
  private parser = new PlayerLogParser();
  private handlers = new Set<(value: SessionIdentity | null) => void>();
  private selected = "";
  private identity = "";
  private offset = 0;
  private partial = "";
  private discardLine = false;
  private value: SessionIdentity | null = null;
  private view: DetectionState = "disabled";
  private enabled = false;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scanning: Promise<void> | undefined;
  constructor(
    private readonly directories: readonly string[],
    private readonly options: { now?: () => number; pollMs?: number } = {},
  ) {
    const interval = options.pollMs ?? 1_000;
    if (!Number.isSafeInteger(interval) || interval < 100 || interval > 10_000)
      throw new Error("INVALID_LOG_POLL_INTERVAL");
  }
  status(): DetectionStatus {
    return {
      state: this.view,
      source: "windows-log",
      verification: "self-asserted",
    };
  }
  async current(): Promise<SessionIdentity | null> {
    return this.value ? { ...this.value } : null;
  }
  subscribe(handler: (value: SessionIdentity | null) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
  private publish(state: DetectionState, value: SessionIdentity | null): void {
    this.view = state;
    const changed = JSON.stringify(this.value) !== JSON.stringify(value);
    this.value = value ? { ...value } : null;
    if (changed)
      for (const handler of this.handlers) {
        try {
          handler(this.value ? { ...this.value } : null);
        } catch {
          /* A consumer cannot break monitoring. */
        }
      }
  }
  private reset(): void {
    this.parser.reset();
    this.selected = "";
    this.identity = "";
    this.offset = 0;
    this.partial = "";
    this.discardLine = false;
  }
  async setEnabled(enabled: boolean): Promise<void> {
    if (typeof enabled !== "boolean") throw new Error("INVALID_LOG_PERMISSION");
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.reset();
    this.publish(
      enabled
        ? this.directories.length
          ? "waiting"
          : "unsupported"
        : "disabled",
      null,
    );
    await this.scanning;
    if (enabled && this.enabled) {
      await this.refresh();
      this.schedule();
    }
  }
  private schedule(): void {
    if (!this.enabled || !this.directories.length || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.refresh().finally(() => this.schedule());
    }, this.options.pollMs ?? 1_000);
    this.timer.unref();
  }
  refresh(): Promise<void> {
    if (!this.enabled || !this.directories.length) return Promise.resolve();
    this.scanning ??= this.scan(this.generation).finally(() => {
      this.scanning = undefined;
    });
    return this.scanning;
  }
  private async scan(generation: number): Promise<void> {
    const valid = () => this.enabled && generation === this.generation;
    const now = (this.options.now ?? Date.now)();
    try {
      const candidates: { file: string; modified: number }[] = [];
      let count = 0,
        sawOld = false;
      for (const directory of this.directories) {
        let entries: Awaited<ReturnType<typeof opendir>>;
        try {
          entries = await opendir(directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        for await (const entry of entries) {
          if (++count > 2048) throw new Error("LOG_DIRECTORY_QUOTA");
          if (
            !entry.isFile() ||
            !/_Player_[a-f0-9]+_last\.log$/i.test(entry.name)
          )
            continue;
          const file = path.join(directory, entry.name);
          const handle = await open(file, "r");
          try {
            const stat = await handle.stat();
            if (!stat.isFile()) continue;
            if (now - stat.mtimeMs > FRESH_MS) {
              sawOld = true;
              continue;
            }
            if (stat.mtimeMs > now + 5_000) continue;
            candidates.push({ file, modified: stat.mtimeMs });
          } finally {
            await handle.close();
          }
        }
      }
      if (!valid()) return;
      if (candidates.length !== 1) {
        this.reset();
        this.publish(
          candidates.length > 1 ? "ambiguous" : sawOld ? "stale" : "waiting",
          null,
        );
        return;
      }
      const candidate = candidates[0];
      if (!candidate) return;
      const handle = await open(candidate.file, "r");
      try {
        const stat = await handle.stat(),
          identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
        if (!valid()) return;
        if (
          this.selected !== candidate.file ||
          this.identity !== identity ||
          stat.size < this.offset
        ) {
          this.reset();
          this.selected = candidate.file;
          this.identity = identity;
          this.offset = Math.max(0, stat.size - MAX_READ);
          this.discardLine = this.offset > 0;
          this.publish("waiting", null);
        }
        if (stat.size - this.offset > MAX_READ) {
          this.parser.reset();
          this.partial = "";
          this.offset = stat.size - MAX_READ;
          this.discardLine = true;
          this.publish("incomplete", null);
        }
        const buffer = Buffer.alloc(
          Math.min(MAX_READ, Math.max(0, stat.size - this.offset)),
        );
        const result = await handle.read(buffer, 0, buffer.length, this.offset);
        if (!valid()) return;
        this.offset += result.bytesRead;
        // Log markers are ASCII. Split UTF-8 codepoints in unrelated text cannot affect identifiers.
        const lines = (
          this.partial + buffer.subarray(0, result.bytesRead).toString("utf8")
        ).split("\n");
        this.partial = lines.pop() ?? "";
        for (let line of lines) {
          if (this.discardLine) {
            this.discardLine = false;
            continue;
          }
          if (line.endsWith("\r")) line = line.slice(0, -1);
          this.parser.line(line, now);
        }
        if (this.partial.length > MAX_LINE) {
          this.partial = "";
          this.discardLine = true;
          this.parser.reset();
        }
        this.publish(this.parser.state(), this.parser.session());
      } finally {
        await handle.close();
      }
    } catch {
      if (valid()) {
        this.reset();
        this.publish("unavailable", null);
      }
    }
  }
  async stop(): Promise<void> {
    await this.setEnabled(false);
  }
}
