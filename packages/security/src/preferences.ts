import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  defaultPreferences,
  type Preferences,
  parsePeerId,
  parsePreferencePatch,
  parsePreferences,
} from "../../protocol/src/preferences.js";

const MAX_BYTES = 128 * 1024;
export class PreferenceStore {
  private tail: Promise<void> = Promise.resolve();
  private closing = false;
  private closed: Promise<void> | undefined;
  private readonly pendingBlocks = new Set<string>();
  private readonly pendingRevocations = new Set<string>();
  private constructor(
    private readonly directory: string,
    private value: Preferences,
    private readonly lockToken: string,
  ) {}
  static async open(directory: string): Promise<PreferenceStore> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      (process.platform !== "win32" && info.mode & 0o077)
    )
      throw new Error("UNSAFE_PREFERENCE_DIRECTORY");
    const token = randomBytes(16).toString("hex"),
      lockPath = path.join(directory, "preferences.lock");
    const lock = await open(lockPath, "wx", 0o600);
    try {
      await lock.writeFile(
        JSON.stringify({ version: 1, pid: process.pid, token }),
      );
      await lock.sync();
    } catch (error) {
      await lock.close();
      await unlink(lockPath);
      throw error;
    }
    await lock.close();
    try {
      let value = defaultPreferences();
      const filename = path.join(directory, "preferences-v1.json");
      try {
        const stored = await lstat(filename);
        if (
          !stored.isFile() ||
          stored.size > MAX_BYTES ||
          (process.platform !== "win32" && stored.mode & 0o077)
        )
          throw new Error("UNSAFE_PREFERENCES");
        value = parsePreferences(JSON.parse(await readFile(filename, "utf8")));
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          )
        )
          throw error;
      }
      return new PreferenceStore(directory, value, token);
    } catch (error) {
      await unlink(lockPath);
      throw error;
    }
  }
  snapshot(): Preferences {
    return {
      ...this.value,
      overlay: {
        ...this.value.overlay,
        widgets: [...this.value.overlay.widgets],
      },
      allowedPeers: [...this.value.allowedPeers],
      blockedPeers: [...this.value.blockedPeers],
    };
  }
  isBlocked = (id: string): boolean =>
    this.pendingBlocks.has(id) || this.value.blockedPeers.includes(id);
  isAuthorized = (id: string): boolean =>
    !this.closing &&
    !this.pendingRevocations.has(id) &&
    !this.isBlocked(id) &&
    this.value.allowedPeers.includes(id);
  private mutate(
    change: (previous: Preferences) => Preferences,
  ): Promise<Preferences> {
    if (this.closing) return Promise.reject(new Error("PREFERENCES_CLOSED"));
    const task = this.tail.then(async () => {
      const next = parsePreferences(change(this.snapshot()));
      const temporary = path.join(
        this.directory,
        `.preferences-${randomBytes(16).toString("hex")}.tmp`,
      );
      const handle = await open(temporary, "wx", 0o600);
      try {
        try {
          await handle.writeFile(JSON.stringify(next));
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(
          temporary,
          path.join(this.directory, "preferences-v1.json"),
        );
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
      this.value = next;
      return this.snapshot();
    });
    this.tail = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  update(patch: unknown): Promise<Preferences> {
    const parsed = parsePreferencePatch(patch);
    return this.mutate((previous) => ({ ...previous, ...parsed }));
  }
  allow(peerId: unknown): Promise<Preferences> {
    const id = parsePeerId(peerId);
    if (this.isBlocked(id)) return Promise.reject(new Error("PEER_BLOCKED"));
    return this.mutate((previous) => {
      if (previous.blockedPeers.includes(id)) throw new Error("PEER_BLOCKED");
      return {
        ...previous,
        allowedPeers: [...new Set([...previous.allowedPeers, id])],
      };
    }).then((value) => {
      this.pendingRevocations.delete(id);
      return value;
    });
  }
  revoke(peerId: unknown): Promise<Preferences> {
    const id = parsePeerId(peerId);
    if (this.value.allowedPeers.includes(id)) this.pendingRevocations.add(id);
    return this.mutate((previous) => ({
      ...previous,
      allowedPeers: previous.allowedPeers.filter((peer) => peer !== id),
    })).then((value) => {
      this.pendingRevocations.delete(id);
      return value;
    });
  }
  block(peerId: unknown): Promise<Preferences> {
    const id = parsePeerId(peerId);
    if (!this.pendingBlocks.has(id) && this.pendingBlocks.size >= 1024)
      return Promise.reject(new Error("PEER_LIST_QUOTA"));
    this.pendingBlocks.add(id);
    return this.mutate((previous) => ({
      ...previous,
      blockedPeers: [...new Set([...previous.blockedPeers, id])],
      allowedPeers: previous.allowedPeers.filter((peer) => peer !== id),
    })).then((value) => {
      this.pendingBlocks.delete(id);
      return value;
    });
  }
  unblock(peerId: unknown): Promise<Preferences> {
    const id = parsePeerId(peerId);
    return this.mutate((previous) => ({
      ...previous,
      blockedPeers: previous.blockedPeers.filter((peer) => peer !== id),
      allowedPeers: previous.allowedPeers.filter((peer) => peer !== id),
    })).then((value) => {
      this.pendingBlocks.delete(id);
      return value;
    });
  }
  close(): Promise<void> {
    this.closing = true;
    this.closed ??= (async () => {
      await this.tail;
      const filename = path.join(this.directory, "preferences.lock");
      const lock = JSON.parse(await readFile(filename, "utf8")) as {
        token?: unknown;
      };
      if (lock.token !== this.lockToken)
        throw new Error("PREFERENCE_LOCK_CHANGED");
      await unlink(filename);
    })();
    return this.closed;
  }
}
