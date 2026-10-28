import { randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  BrowserWindow,
  type IpcMainEvent,
  ipcMain,
  type Session,
  session,
} from "electron";
import {
  MEDIA_COMMAND,
  MEDIA_REPLY,
  type MediaOperation,
  type MediaOutput,
  mediaError,
  parseMediaCommand,
  parseMediaReply,
  validMediaResult,
} from "../../../packages/voice/src/media-host-protocol.js";
import { allowMediaPermission } from "./media-permission.js";

// Electron retains partition sessions for the process lifetime. Reuse a bounded
// pool after destroying the old contents and resetting both permission handlers.
const sessions: { session: Session; used: boolean }[] = [];

// Trusted main-process owner. No public desktop/overlay IPC reaches this object.
// One instance owns one call and one ephemeral browser session, destroyed on deny.
export class DesktopMediaHost {
  private window: BrowserWindow | undefined;
  private closed = false;
  private capturePermitted = false;
  private loading: Promise<void> | undefined;
  private ready: (() => void) | undefined;
  private slot: (typeof sessions)[number] | undefined;
  private readonly pending = new Map<
    string,
    {
      op: MediaOperation;
      resolve(data: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private readonly assets: string,
    private readonly options: {
      permitted: () => boolean;
      microphoneAllowed?: () => boolean;
      timeoutMs?: number;
    },
  ) {
    if (
      !Number.isSafeInteger(options.timeoutMs ?? 12_000) ||
      (options.timeoutMs ?? 12_000) < 1 ||
      (options.timeoutMs ?? 12_000) > 15_000
    )
      throw new Error("INVALID_MEDIA_HOST_LIMITS");
  }
  private permitted(): boolean {
    try {
      return !this.closed && this.options.permitted() === true;
    } catch {
      return false;
    }
  }
  private check(): void {
    if (!this.permitted()) {
      this.close();
      throw new Error("MEDIA_HOST_DENIED");
    }
  }
  private trusted(event: IpcMainEvent): boolean {
    const window = this.window;
    return (
      !!window &&
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame &&
      event.senderFrame.url ===
        pathToFileURL(path.resolve(this.assets, "media.html")).href
    );
  }
  private readonly reply = (event: IpcMainEvent, value: unknown): void => {
    if (!this.trusted(event)) return;
    try {
      this.check();
      const result = parseMediaReply(value);
      if (result.id === "ready") {
        if (result.ok && result.data === null) this.ready?.();
        return;
      }
      const pending = this.pending.get(result.id);
      if (!pending) return;
      if (!result.ok) {
        this.pending.delete(result.id);
        clearTimeout(pending.timer);
        const reason = mediaError(result.data);
        pending.reject(new Error(reason));
        if (reason !== "MEDIA_NOT_CONNECTED") this.close();
        return;
      }
      if (!validMediaResult(pending.op, result.data))
        throw new Error("MEDIA_HOST_COMMAND_FAILED");
      this.pending.delete(result.id);
      clearTimeout(pending.timer);
      pending.resolve(result.data);
    } catch {
      this.close();
    }
  };
  private start(): Promise<void> {
    this.check();
    if (this.loading) return this.loading;
    let slot = sessions.find((value) => !value.used);
    if (!slot) {
      if (sessions.length >= 4) throw new Error("MEDIA_HOST_SESSION_QUOTA");
      slot = {
        session: session.fromPartition(
          `lobbymesh-media-${randomBytes(16).toString("hex")}`,
        ),
        used: false,
      };
      sessions.push(slot);
    }
    slot.used = true;
    this.slot = slot;
    const mediaSession = slot.session;
    const url = pathToFileURL(path.resolve(this.assets, "media.html")).href;
    const microphone = () => {
      try {
        return (
          this.permitted() &&
          this.capturePermitted &&
          this.options.microphoneAllowed?.() === true
        );
      } catch {
        return false;
      }
    };
    mediaSession.setPermissionCheckHandler(
      (contents, permission, _origin, details) =>
        allowMediaPermission({
          consent: microphone(),
          ownedContents: !!contents && contents === this.window?.webContents,
          permission,
          mainFrame: details.isMainFrame,
          requestingUrl: details.requestingUrl,
          expectedUrl: url,
          mediaTypes: details.mediaType ? [details.mediaType] : undefined,
        }),
    );
    mediaSession.setPermissionRequestHandler(
      (contents, permission, callback, details) =>
        callback(
          allowMediaPermission({
            consent: microphone(),
            ownedContents: contents === this.window?.webContents,
            permission,
            mainFrame: details.isMainFrame,
            requestingUrl: details.requestingUrl,
            expectedUrl: url,
            mediaTypes:
              "mediaTypes" in details && Array.isArray(details.mediaTypes)
                ? details.mediaTypes
                : undefined,
          }),
        ),
    );
    const window = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      webPreferences: {
        session: mediaSession,
        preload: path.join(this.assets, "media-preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        autoplayPolicy: "no-user-gesture-required",
      },
    });
    this.window = window;
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => {
      event.preventDefault();
      this.close();
    });
    window.webContents.on("will-attach-webview", (event) =>
      event.preventDefault(),
    );
    window.webContents.on("render-process-gone", () => this.close());
    window.on("closed", () => this.close());
    ipcMain.on(MEDIA_REPLY, this.reply);
    this.loading = new Promise<void>((resolve, reject) => {
      const id = randomBytes(16).toString("hex");
      const timer = setTimeout(
        () => this.close(),
        this.options.timeoutMs ?? 12_000,
      );
      this.pending.set(id, {
        op: "status",
        resolve: () => resolve(),
        reject,
        timer,
      });
      this.ready = () => {
        this.ready = undefined;
        this.pending.delete(id);
        clearTimeout(timer);
        resolve();
      };
      void window
        .loadFile(path.join(this.assets, "media.html"))
        .catch(() => this.close());
    });
    return this.loading;
  }
  private async command(
    op: MediaOperation,
    data: string | boolean | null | MediaOutput,
  ): Promise<unknown> {
    this.check();
    const command = parseMediaCommand({
      id: randomBytes(16).toString("hex"),
      op,
      data,
    });
    try {
      await this.start();
    } catch (error) {
      this.close();
      throw error;
    }
    this.check();
    if (this.pending.size >= 4) {
      this.close();
      throw new Error("MEDIA_HOST_QUOTA");
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.close(),
        this.options.timeoutMs ?? 12_000,
      );
      this.pending.set(command.id, { op, resolve, reject, timer });
      try {
        this.window?.webContents.send(MEDIA_COMMAND, command);
      } catch {
        this.close();
      }
    });
  }
  offer(consent: boolean): Promise<string> {
    if (consent !== true) return Promise.reject(new Error("MEDIA_HOST_DENIED"));
    this.capturePermitted = true;
    return this.command("offer", true) as Promise<string>;
  }
  answer(sdp: string, consent: boolean): Promise<string> {
    if (consent !== true) return Promise.reject(new Error("MEDIA_HOST_DENIED"));
    this.capturePermitted = true;
    return this.command("answer", sdp) as Promise<string>;
  }
  async acceptAnswer(sdp: string): Promise<void> {
    await this.command("accept-answer", sdp);
  }
  async setTalking(value: boolean): Promise<void> {
    await this.command("talk", value);
  }
  async setOutput(volume: number, muted: boolean): Promise<void> {
    await this.command("output", { volume, muted });
  }
  async status(): Promise<{
    phase: string;
    capturing: boolean;
    transmitting: boolean;
    outputLevel: number | null;
  }> {
    return (await this.command("status", null)) as {
      phase: string;
      capturing: boolean;
      transmitting: boolean;
      outputLevel: number | null;
    };
  }
  async metrics(): Promise<{
    receivedPackets: number;
    receivedBytes: number;
    receivedEnergy: number | null;
  }> {
    return (await this.command("metrics", null)) as {
      receivedPackets: number;
      receivedBytes: number;
      receivedEnergy: number | null;
    };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.capturePermitted = false;
    this.ready = undefined;
    ipcMain.removeListener(MEDIA_REPLY, this.reply);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("MEDIA_HOST_CLOSED"));
    }
    this.pending.clear();
    const window = this.window;
    this.window = undefined;
    if (window && !window.isDestroyed()) window.destroy();
    if (this.slot) {
      this.slot.session.setPermissionCheckHandler(() => false);
      this.slot.session.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(false),
      );
      this.slot.used = false;
      this.slot = undefined;
    }
  }
}
