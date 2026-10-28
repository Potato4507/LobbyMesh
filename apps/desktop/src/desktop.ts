import path from "node:path";
import {
  BrowserWindow,
  type IpcMainInvokeEvent,
  ipcMain,
  powerMonitor,
  session,
} from "electron";
import { NetworkLifecycle } from "../../../packages/app-dht/src/lifecycle.js";
import { parseStatusRequest } from "../../../packages/protocol/src/index.js";
import {
  parsePeerId,
  parsePreferencePatch,
} from "../../../packages/protocol/src/preferences.js";
import { PreferenceStore } from "../../../packages/security/src/preferences.js";
import {
  WindowsLogSessionProvider,
  windowsLogDirectories,
} from "../../../packages/session/src/windows-logs.js";
import { DesktopMessaging } from "./messaging.js";
import { createDesktopNetwork, type DesktopNetworkFactory } from "./network.js";
import { DesktopSessions } from "./sessions.js";

export async function createDesktop(
  directory: string,
  assets: string,
  show = true,
  options: {
    networkFactory?: DesktopNetworkFactory;
    logProvider?: WindowsLogSessionProvider;
  } = {},
) {
  let preferences: PreferenceStore | undefined;
  try {
    preferences = await PreferenceStore.open(directory);
  } catch {
    /* Fail closed; the existing file/lock is preserved. */
  }
  const logProvider =
    options.logProvider ??
    new WindowsLogSessionProvider(
      windowsLogDirectories(process.env.LOCALAPPDATA),
    );
  let sessionConsent = preferences?.snapshot().sessionConsent ?? false;
  const network = new NetworkLifecycle(async (signal) => {
    if (!preferences) throw new Error("PREFERENCES_UNAVAILABLE");
    const store = preferences;
    const policy = {
      blocked: store.isBlocked,
      authorized: store.isAuthorized,
      allowed: () => store.snapshot().allowedPeers,
    };
    const sessions = {
      provider: logProvider,
      preferences: () => ({
        displayName: store.snapshot().displayName,
        sessionConsent,
      }),
    };
    return options.networkFactory
      ? options.networkFactory(signal, policy, sessions)
      : createDesktopNetwork(
          path.join(path.dirname(directory), "network"),
          signal,
          policy,
          sessions,
        );
  });
  let tearingDown = false,
    permissionRevision = 0,
    activeRequests = 0;
  const suspend = () => network.suspend(),
    resume = () => network.resume();
  powerMonitor.on("suspend", suspend);
  powerMonitor.on("resume", resume);
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
  const sessions = (): DesktopSessions | undefined => {
    try {
      return network.using((runtime) =>
        "sessions" in runtime && runtime.sessions instanceof DesktopSessions
          ? runtime.sessions
          : undefined,
      );
    } catch {
      return undefined;
    }
  };
  const messaging = <T>(action: (service: DesktopMessaging) => T): T =>
    network.using((runtime) => {
      if (
        !("messaging" in runtime) ||
        !(runtime.messaging instanceof DesktopMessaging)
      )
        throw new Error("MESSAGING_UNAVAILABLE");
      return action(runtime.messaging);
    });
  const handle = (
    name: string,
    action: (request: unknown) => unknown | Promise<unknown>,
  ) => {
    channels.push(name);
    ipcMain.handle(name, async (event, request: unknown) => {
      trusted(event);
      if (tearingDown) throw new Error("DESKTOP_CLOSING");
      const priority =
        name === "companion:status" ||
        (name === "companion:network" && request === false);
      if (!priority && activeRequests >= 16) throw new Error("REQUEST_QUOTA");
      if (!priority) activeRequests++;
      try {
        return await action(request);
      } finally {
        if (!priority) activeRequests--;
      }
    });
  };
  handle("companion:status", (request) => {
    parseStatusRequest(request);
    return {
      version: 1,
      session: logProvider.status().state,
      detection: logProvider.status(),
      matching: sessions()?.status() ?? { state: "offline", participants: 0 },
      network: network.status().state,
      connection: network.status(),
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
      const patch = parsePreferencePatch(request);
      if ("networkEnabled" in patch) throw new Error("USE_NETWORK_CONTROL");
      if (patch.sessionConsent === false) {
        sessionConsent = false;
        void sessions()?.settingsChanged();
        await logProvider.setEnabled(false);
      }
      const saved = await preferences.update(patch);
      if (patch.sessionConsent !== undefined) {
        sessionConsent = saved.sessionConsent;
        await logProvider.setEnabled(saved.sessionConsent);
      }
      void sessions()?.settingsChanged();
      return saved;
    } catch {
      throw new Error("PREFERENCES_UPDATE_FAILED");
    }
  });
  handle("companion:network", async (request) => {
    if (!preferences) throw new Error("PREFERENCES_UNAVAILABLE");
    if (typeof request !== "boolean")
      throw new Error("INVALID_NETWORK_PERMISSION");
    const revision = ++permissionRevision;
    if (!request) network.setEnabled(false);
    try {
      await preferences.update({ networkEnabled: request });
    } catch {
      throw new Error(
        request
          ? "NETWORK_PERMISSION_SAVE_FAILED"
          : "NETWORK_STOPPED_SAVE_FAILED",
      );
    }
    if (revision === permissionRevision && request && !tearingDown)
      network.setEnabled(true);
    return network.status();
  });
  handle("companion:messaging", (request) => {
    parseStatusRequest(request);
    try {
      return {
        available: true,
        contacts: messaging((service) => service.contacts()),
      };
    } catch {
      return { available: false, contacts: [] };
    }
  });
  handle("companion:messages", (request) => {
    const peerId = parsePeerId(request);
    return messaging((service) => service.history(peerId));
  });
  handle("companion:messages:send", async (request) => {
    if (
      !request ||
      typeof request !== "object" ||
      Object.keys(request).sort().join(",") !== "peerId,text" ||
      !("peerId" in request) ||
      !("text" in request)
    )
      throw new Error("INVALID_MESSAGE_REQUEST");
    const peerId = parsePeerId(request.peerId);
    return messaging((service) => service.send(peerId, request.text));
  });
  handle("companion:messages:clear", (request) => {
    const peerId = parsePeerId(request);
    messaging((service) => service.clear(peerId));
    return { cleared: true };
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
      const saving = preferences[action](peerId);
      if (action !== "unblock") {
        try {
          messaging((service) => service.policyChanged(parsePeerId(peerId)));
        } catch {
          /* Offline messaging holds no active sends. */
        }
      }
      return await saving;
    } catch {
      throw new Error("CONTACT_UPDATE_FAILED");
    }
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    tearingDown = true;
    powerMonitor.removeListener("suspend", suspend);
    powerMonitor.removeListener("resume", resume);
    closing ??= (async () => {
      for (const channel of channels) ipcMain.removeHandler(channel);
      try {
        await logProvider.stop();
        await network.close();
      } finally {
        await preferences?.close();
      }
    })();
    return closing;
  };
  if (preferences?.snapshot().networkEnabled) network.setEnabled(true);
  await logProvider.setEnabled(preferences?.snapshot().sessionConsent ?? false);
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
