import { createHash } from "node:crypto";
import { open, opendir } from "node:fs/promises";
import path from "node:path";
import type {
  SessionIdentity,
  SessionProvider,
} from "../../protocol/src/index.js";
import type { ActivityReader } from "./windows-activity.js";

export type DetectionState =
  | "disabled"
  | "unsupported"
  | "waiting"
  | "incomplete"
  | "scanning"
  | "detected"
  | "stale"
  | "ambiguous"
  | "unavailable";
export interface DetectionStatus {
  state: DetectionState;
  source: "windows-log";
  verification: "self-asserted";
  reason:
    | "multiple-player-processes"
    | "multiple-player-logs"
    | "process-query-failed"
    | "log-read-failed"
    | "player-not-running"
    | "player-log-pending"
    | null;
}
const MAX_READ = 4 * 1024 * 1024;
const MAX_LINE = 16 * 1024;
const CHECKPOINT_BYTES = 256;
interface LogCheckpoint {
  length: number;
  hash: string;
}
const checkpoint = (bytes: Buffer): LogCheckpoint => {
  // At most three accepted lines plus two 256-byte continuity windows.
  // A bounded UTF-16 line can occupy up to four times as many UTF-8 bytes.
  if (bytes.length > MAX_LINE * 4 + 1) throw new Error("LOG_CHECKPOINT_QUOTA");
  return {
    length: bytes.length,
    hash: createHash("sha256").update(bytes).digest("hex"),
  };
};
const FRESH_MS = 120_000;
const id = "([1-9][0-9]{0,19})";
const join = new RegExp(
  `^\\[FLog::Output\\] ! Joining game '([a-fA-F0-9]{8}-(?:[a-fA-F0-9]{4}-){3}[a-fA-F0-9]{12})' place ${id} at `,
);
const universe = new RegExp(
  `^\\[FLog::GameJoinLoadTime\\] Report game_join_loadtime:.*?\\buniverseid:${id}(?:,|\\s|$)`,
);
type SessionLogMarker = "join" | "universe" | "replicator" | "reset";

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
  line(
    line: string,
    now: number,
    processStartedAt?: number,
  ): SessionLogMarker | undefined {
    if (line.length > MAX_LINE) {
      this.reset();
      return "reset";
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
      (processStartedAt === undefined
        ? now - timestamp > FRESH_MS
        : timestamp < processStartedAt) ||
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
      return "reset";
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
      return match ? "join" : "reset";
    }
    if (!this.pending) return;
    const match = universe.exec(message);
    let marker: SessionLogMarker | undefined;
    if (match?.[1]) {
      this.pending.universeId = match[1];
      marker = "universe";
    }
    if (message.startsWith("[FLog::Network] Replicator created: ")) {
      this.pending.connected = true;
      marker = "replicator";
    }
    if (this.pending.connected && this.pending.universeId)
      this.value = {
        universeId: this.pending.universeId,
        placeId: this.pending.placeId,
        jobId: this.pending.jobId,
        evidenceSource: "windows-log",
        verification: "self-asserted",
      };
    return marker;
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
// Without process activity, quiet logs expire conservatively. A known player
// lifetime permits quiet evidence until that player exits or the source changes.
export class WindowsLogSessionProvider implements SessionProvider {
  private parser = new PlayerLogParser();
  private handlers = new Set<(value: SessionIdentity | null) => void>();
  private selected = "";
  private identity = "";
  private offset = 0;
  private partial = Buffer.alloc(0);
  private discardLine = false;
  private prefix: LogCheckpoint | undefined;
  private tail: LogCheckpoint | undefined;
  private readonly evidence = new Map<
    Exclude<SessionLogMarker, "reset">,
    { position: number; value: LogCheckpoint }
  >();
  private value: SessionIdentity | null = null;
  private view: DetectionState = "disabled";
  private reason: DetectionStatus["reason"] = null;
  private enabled = false;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private scanning: Promise<void> | undefined;
  private processStartedAt: number | undefined;
  constructor(
    private readonly directories: readonly string[],
    private readonly options: {
      now?: () => number;
      pollMs?: number;
      activity?: ActivityReader;
    } = {},
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
      reason: this.reason,
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
  private publish(
    state: DetectionState,
    value: SessionIdentity | null,
    reason: DetectionStatus["reason"] = null,
  ): void {
    this.view = state;
    this.reason = reason;
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
    this.partial = Buffer.alloc(0);
    this.discardLine = false;
    this.prefix = undefined;
    this.tail = undefined;
    this.evidence.clear();
  }
  async setEnabled(enabled: boolean): Promise<void> {
    if (typeof enabled !== "boolean") throw new Error("INVALID_LOG_PERMISSION");
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.reset();
    this.processStartedAt = undefined;
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
    let phase: "activity" | "logs" = this.options.activity
      ? "activity"
      : "logs";
    try {
      if (this.options.activity) {
        const players = await this.options.activity();
        if (!valid()) return;
        if (players.length !== 1) {
          this.reset();
          this.processStartedAt = undefined;
          this.publish(
            players.length ? "ambiguous" : "waiting",
            null,
            players.length ? "multiple-player-processes" : "player-not-running",
          );
          return;
        }
        const startedAt = players[0]?.startedAt;
        if (
          !Number.isSafeInteger(startedAt) ||
          !startedAt ||
          startedAt < 0 ||
          startedAt > now + 5_000
        )
          throw new Error("PLAYER_ACTIVITY_UNAVAILABLE");
        if (startedAt !== this.processStartedAt) {
          this.reset();
          this.processStartedAt = startedAt;
          this.publish("waiting", null);
        }
      }
      phase = "logs";
      const candidates: { file: string; modified: number }[] = [];
      let count = 0,
        sawOld = false;
      for (const directory of this.directories) {
        if (!valid()) return;
        let entries: Awaited<ReturnType<typeof opendir>>;
        try {
          entries = await opendir(directory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (!valid()) {
          await entries.close();
          return;
        }
        for await (const entry of entries) {
          if (!valid()) return;
          if (++count > 2048) throw new Error("LOG_DIRECTORY_QUOTA");
          if (
            !entry.isFile() ||
            !/_Player_[a-f0-9]+_last\.log$/i.test(entry.name)
          )
            continue;
          const file = path.join(directory, entry.name);
          const handle = await open(file, "r");
          try {
            if (!valid()) return;
            const stat = await handle.stat();
            if (!valid()) return;
            if (!stat.isFile()) continue;
            if (
              this.processStartedAt === undefined
                ? now - stat.mtimeMs > FRESH_MS
                : stat.mtimeMs < this.processStartedAt ||
                  stat.birthtimeMs < this.processStartedAt
            ) {
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
          candidates.length > 1
            ? "multiple-player-logs"
            : !sawOld && this.processStartedAt !== undefined
              ? "player-log-pending"
              : null,
        );
        return;
      }
      const candidate = candidates[0];
      if (!candidate) return;
      const handle = await open(candidate.file, "r");
      try {
        if (!valid()) return;
        const stat = await handle.stat(),
          identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
        if (!valid()) return;
        const rewind = () => {
          this.reset();
          this.selected = candidate.file;
          this.identity = identity;
          this.publish("waiting", null);
        };
        if (
          this.selected !== candidate.file ||
          this.identity !== identity ||
          stat.size < this.offset
        ) {
          rewind();
        }
        // A truncate-and-rewrite can grow past the previous offset between
        // polls without changing the file identity. Check bounded continuity
        // windows before trusting the old parser state. Retain only hashes.
        let previousTail = Buffer.alloc(0);
        if (this.offset > 0 && this.prefix && this.tail) {
          const windows = [
            { position: 0, value: this.prefix, tail: false },
            {
              position: this.offset - this.tail.length,
              value: this.tail,
              tail: true,
            },
            ...[...this.evidence.values()].map((entry) => ({
              ...entry,
              tail: false,
            })),
          ];
          for (const window of windows) {
            const bytes = Buffer.alloc(window.value.length);
            const read = await handle.read(
              bytes,
              0,
              bytes.length,
              window.position,
            );
            if (!valid()) return;
            if (
              read.bytesRead !== bytes.length ||
              checkpoint(bytes).hash !== window.value.hash
            ) {
              rewind();
              previousTail = Buffer.alloc(0);
              break;
            }
            if (window.tail) previousTail = bytes;
          }
        }
        // A source-withdrawal subscriber may revoke consent synchronously.
        if (!valid()) return;
        const buffer = Buffer.alloc(
          Math.min(MAX_READ, Math.max(0, stat.size - this.offset)),
        );
        const result = await handle.read(buffer, 0, buffer.length, this.offset);
        if (!valid()) return;
        this.offset += result.bytesRead;
        if (result.bytesRead > 0) {
          if (!this.prefix)
            this.prefix = checkpoint(
              buffer.subarray(0, Math.min(CHECKPOINT_BYTES, result.bytesRead)),
            );
          const ending =
            result.bytesRead >= CHECKPOINT_BYTES
              ? buffer.subarray(
                  result.bytesRead - CHECKPOINT_BYTES,
                  result.bytesRead,
                )
              : Buffer.concat([
                  previousTail,
                  buffer.subarray(0, result.bytesRead),
                ]).subarray(-CHECKPOINT_BYTES);
          this.tail = checkpoint(ending);
        }
        // Byte framing preserves exact evidence offsets across UTF-8 and read
        // boundaries. Persistent checkpoints contain hashes, never log text.
        const chunkStart = this.offset - result.bytesRead - this.partial.length;
        const combined = Buffer.concat([
          this.partial,
          buffer.subarray(0, result.bytesRead),
        ]);
        let start = 0,
          newline = combined.indexOf(10),
          evidenceChanged = false;
        while (newline !== -1) {
          const position = chunkStart + start;
          const rawLine = combined.subarray(start, newline + 1);
          let line = combined.subarray(start, newline).toString("utf8");
          start = newline + 1;
          newline = combined.indexOf(10, start);
          if (this.discardLine) {
            this.discardLine = false;
            continue;
          }
          if (line.endsWith("\r")) line = line.slice(0, -1);
          const marker = this.parser.line(line, now, this.processStartedAt);
          if (marker === "reset" || marker === "join") this.evidence.clear();
          if (marker && marker !== "reset") {
            this.evidence.set(marker, { position, value: checkpoint(rawLine) });
            evidenceChanged = true;
          }
        }
        const remaining = combined.subarray(start);
        if (remaining.toString("utf8").length > MAX_LINE) {
          this.partial = Buffer.alloc(0);
          this.discardLine = true;
          this.parser.reset();
          this.evidence.clear();
        } else this.partial = Buffer.from(remaining);
        if (evidenceChanged) {
          // Revalidate completed evidence before publishing a line assembled
          // across reads, including a writer racing the current scan.
          for (const entry of this.evidence.values()) {
            const bytes = Buffer.alloc(entry.value.length);
            const read = await handle.read(
              bytes,
              0,
              bytes.length,
              entry.position,
            );
            if (!valid()) return;
            if (
              read.bytesRead !== bytes.length ||
              checkpoint(bytes).hash !== entry.value.hash
            ) {
              rewind();
              return;
            }
          }
        }
        if (this.offset < stat.size) this.publish("scanning", null);
        else this.publish(this.parser.state(), this.parser.session());
      } finally {
        await handle.close();
      }
    } catch {
      if (valid()) {
        this.reset();
        this.publish(
          "unavailable",
          null,
          phase === "activity" ? "process-query-failed" : "log-read-failed",
        );
      }
    }
  }
  async stop(): Promise<void> {
    await this.setEnabled(false);
  }
}
