import path from "node:path";
import { BrowserWindow, globalShortcut, screen } from "electron";
import {
  defaultOverlayPreferences,
  type OverlayPreferences,
  type OverlayStatus,
  overlayBounds,
  parseOverlayPreferences,
} from "../../../packages/protocol/src/overlay.js";

const SHORTCUT = "CommandOrControl+Shift+Space";
export class DesktopOverlay {
  private window: BrowserWindow | undefined;
  private preferences = defaultOverlayPreferences();
  private interactive = false;
  private shortcutRegistered = false;
  private unavailable = false;
  private closed = false;
  private loading: Promise<void> | undefined;
  constructor(
    private readonly assets: string,
    private readonly visible = true,
  ) {
    screen.on("display-metrics-changed", this.position);
    screen.on("display-removed", this.position);
  }
  getWindow(): BrowserWindow | undefined {
    return this.window;
  }
  status(): OverlayStatus {
    return {
      state: !this.preferences.enabled
        ? "disabled"
        : process.platform !== "win32"
          ? "unsupported"
          : this.unavailable
            ? "unavailable"
            : "ready",
      interactive: this.interactive,
      shortcutRegistered: this.shortcutRegistered,
      preferences: parseOverlayPreferences(this.preferences),
    };
  }
  private position = (): void => {
    if (this.window && !this.window.isDestroyed())
      this.window.setBounds(
        overlayBounds(screen.getPrimaryDisplay().workArea, this.preferences),
      );
  };
  setInteractive(value: boolean): OverlayStatus {
    if (typeof value !== "boolean") throw new Error("INVALID_OVERLAY_MODE");
    if (
      !this.window ||
      this.window.isDestroyed() ||
      !this.preferences.enabled ||
      this.closed
    )
      throw new Error("OVERLAY_UNAVAILABLE");
    this.interactive = value;
    this.window.setIgnoreMouseEvents(!value, { forward: true });
    this.window.setFocusable(value);
    if (this.visible) {
      if (value) {
        this.window.show();
        this.window.focus();
      } else {
        this.window.blur();
        this.window.showInactive();
      }
    }
    return this.status();
  }
  private destroyWindow(): void {
    if (this.shortcutRegistered) globalShortcut.unregister(SHORTCUT);
    this.shortcutRegistered = false;
    this.interactive = false;
    const window = this.window;
    this.window = undefined;
    window?.destroy();
  }
  async apply(value: OverlayPreferences): Promise<void> {
    if (this.closed) return;
    this.preferences = parseOverlayPreferences(value);
    if (!value.enabled) {
      this.destroyWindow();
      return;
    }
    if (process.platform !== "win32") return;
    if (!this.window) {
      this.unavailable = false;
      const window = new BrowserWindow({
        ...overlayBounds(screen.getPrimaryDisplay().workArea, this.preferences),
        frame: false,
        resizable: false,
        show: false,
        focusable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        backgroundColor: "#0c1320",
        webPreferences: {
          preload: path.join(this.assets, "preload.cjs"),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
        },
      });
      this.window = window;
      window.setMenu(null);
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      // Keep return-to-game available without waiting for renderer IPC/polling.
      window.webContents.on("before-input-event", (event, input) => {
        if (
          this.window === window &&
          this.interactive &&
          input.type === "keyDown" &&
          input.key === "Escape"
        ) {
          event.preventDefault();
          this.setInteractive(false);
        }
      });
      window.on("close", (event) => {
        if (!this.closed && this.preferences.enabled) {
          event.preventDefault();
          this.setInteractive(false);
        }
      });
      window.webContents.on("render-process-gone", () => {
        this.unavailable = true;
        this.destroyWindow();
      });
      this.loading = window
        .loadFile(path.join(this.assets, "overlay.html"))
        .then(() => {})
        .catch(() => {
          if (this.window === window) {
            this.unavailable = true;
            this.destroyWindow();
          }
        });
    }
    await this.loading;
    if (!this.window || this.closed || !this.preferences.enabled) return;
    this.position();
    this.window.setOpacity(this.preferences.opacity);
    this.setInteractive(this.interactive);
    if (!this.shortcutRegistered)
      this.shortcutRegistered = globalShortcut.register(SHORTCUT, () => {
        this.setInteractive(!this.interactive);
      });
  }
  close(): void {
    this.closed = true;
    screen.removeListener("display-metrics-changed", this.position);
    screen.removeListener("display-removed", this.position);
    this.destroyWindow();
  }
}
