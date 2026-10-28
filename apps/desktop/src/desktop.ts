import path from "node:path";
import {
  BrowserWindow,
  type IpcMainInvokeEvent,
  ipcMain,
  session,
} from "electron";
import { parseStatusRequest } from "../../../packages/protocol/src/index.js";
import { PreferenceStore } from "../../../packages/security/src/preferences.js";

export async function createDesktop(
  directory: string,
  assets: string,
  show = true,
) {
  let preferences: PreferenceStore | undefined;
  try {
    preferences = await PreferenceStore.open(directory);
  } catch {
    /* Fail closed; the existing file/lock is preserved. */
  }
  session.defaultSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  const window = new BrowserWindow({
    width: 1080,
    height: 800,
    minWidth: 720,
    minHeight: 600,
    show,
    backgroundColor: "#0c1320",
    webPreferences: {
      preload: path.join(assets, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  const trusted = (event: IpcMainInvokeEvent) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error("UNTRUSTED_SENDER");
  };
  const channels: string[] = [];
  const handle = (
    name: string,
    action: (request: unknown) => unknown | Promise<unknown>,
  ) => {
    channels.push(name);
    ipcMain.handle(name, async (event, request: unknown) => {
      trusted(event);
      return action(request);
    });
  };
  handle("companion:status", (request) => {
    parseStatusRequest(request);
    return {
      version: 1,
      session: "unsupported",
      network: "offline",
      microphone: "off",
      preferences: preferences ? "ready" : "unavailable",
    };
  });
  handle("companion:preferences", (request) => {
    parseStatusRequest(request);
    if (!preferences) throw new Error("PREFERENCES_UNAVAILABLE");
    return preferences.snapshot();
  });
  handle("companion:preferences:update", async (request) => {
    if (!preferences) throw new Error("PREFERENCES_UNAVAILABLE");
    try {
      return await preferences.update(request);
    } catch {
      throw new Error("PREFERENCES_UPDATE_FAILED");
    }
  });
  handle("companion:contact", async (request) => {
    if (!preferences) throw new Error("PREFERENCES_UNAVAILABLE");
    if (
      !request ||
      typeof request !== "object" ||
      Object.keys(request).sort().join(",") !== "action,peerId" ||
      !("action" in request) ||
      !("peerId" in request)
    )
      throw new Error("INVALID_CONTACT_ACTION");
    const { action, peerId } = request;
    if (action !== "revoke" && action !== "block" && action !== "unblock")
      throw new Error("INVALID_CONTACT_ACTION");
    try {
      return await preferences[action](peerId);
    } catch {
      throw new Error("CONTACT_UPDATE_FAILED");
    }
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      for (const channel of channels) ipcMain.removeHandler(channel);
      await preferences?.close();
    })();
    return closing;
  };
  try {
    await window.loadFile(path.join(assets, "index.html"));
  } catch (error) {
    await close();
    window.destroy();
    throw error;
  }
  return {
    window,
    close,
  };
}
