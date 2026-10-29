import path from "node:path";
import {
  BrowserWindow,
  type IpcMainInvokeEvent,
  ipcMain,
  powerMonitor,
  session,
  systemPreferences,
} from "electron";
import { NetworkLifecycle } from "../../../packages/app-dht/src/lifecycle.js";
import { parseStatusRequest } from "../../../packages/protocol/src/index.js";
import {
  type OverlayVoiceView,
  parseOverlayEndCall,
} from "../../../packages/protocol/src/overlay.js";
import {
  parsePeerId,
  parsePreferencePatch,
} from "../../../packages/protocol/src/preferences.js";
import {
  parseVoiceAction,
  type VoiceView,
} from "../../../packages/protocol/src/voice.js";
import { PreferenceStore } from "../../../packages/security/src/preferences.js";
import { createWindowsActivityReader } from "../../../packages/session/src/windows-activity.js";
import {
  WindowsLogSessionProvider,
  windowsLogDirectories,
} from "../../../packages/session/src/windows-logs.js";
import { VoiceCalls } from "../../../packages/voice/src/calls.js";
import { unknownMediaQuality } from "../../../packages/voice/src/quality.js";
import { DesktopMediaHost } from "./media-host.js";
import { DesktopMessaging } from "./messaging.js";
import { createDesktopNetwork, type DesktopNetworkFactory } from "./network.js";
import { DesktopOverlay } from "./overlay-window.js";
import { DesktopPairing } from "./pairing.js";
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
      { activity: createWindowsActivityReader() },
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
          (context) =>
            new DesktopMediaHost(assets, {
              permitted: context.permitted,
              microphoneAllowed: () =>
                context.permitted() &&
                ["granted", "not-determined"].includes(
                  systemPreferences.getMediaAccessStatus("microphone"),
                ),
            }),
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
  const overlay = new DesktopOverlay(assets, show);
  const trusted = (event: IpcMainInvokeEvent, channel: string) => {
    const overlayWindow = overlay.getWindow();
    if (
      overlayWindow &&
      !overlayWindow.isDestroyed() &&
      event.sender === overlayWindow.webContents &&
      event.senderFrame === overlayWindow.webContents.mainFrame &&
      [
        "companion:status",
        "companion:overlay",
        "companion:overlay:mode",
        "companion:overlay:voice",
        "companion:overlay:voice:end",
        "companion:messaging",
        "companion:messages",
        "companion:messages:send",
        "companion:messages:clear",
      ].includes(channel)
    )
      return;
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error("UNTRUSTED_SENDER");
  };
  const channels: string[] = [];
  const pairing = (): DesktopPairing =>
    network.using((runtime) => {
      if (
        !("pairing" in runtime) ||
        !(runtime.pairing instanceof DesktopPairing)
      )
        throw new Error("PAIRING_UNAVAILABLE");
      return runtime.pairing;
    });
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
  let lastVoice: VoiceCalls | undefined;
  const voice = (): VoiceCalls =>
    network.using((runtime) => {
      if (!("voice" in runtime) || !(runtime.voice instanceof VoiceCalls))
        throw new Error("VOICE_UNAVAILABLE");
      lastVoice = runtime.voice;
      return runtime.voice;
    });
  const voiceView = (): VoiceView => {
    let microphonePermission: VoiceView["microphonePermission"] = "unknown";
    try {
      microphonePermission =
        systemPreferences.getMediaAccessStatus("microphone");
    } catch {
      /* Unsupported OS stays unknown. */
    }
    try {
      const status = voice().status();
      return {
        ...status,
        supported: true,
        enabled: status.available,
        microphonePermission,
      };
    } catch {
      let capturing: boolean | null = lastVoice ? null : false;
      let transmitting: boolean | null = lastVoice ? null : false;
      let error: string | null = null;
      try {
        if (lastVoice) {
          const retained = lastVoice.status();
          capturing = retained.capturing;
          transmitting = retained.transmitting;
          error = retained.error;
        }
      } catch {
        error = "VOICE_STATUS_UNKNOWN";
      }
      return {
        supported: false,
        enabled: false,
        phase: error ? "failed" : "disabled",
        peerId: null,
        callId: null,
        capturing,
        transmitting,
        error,
        outputVolume: 1,
        outputMuted: false,
        outputLevel: null,
        quality: unknownMediaQuality(),
        microphonePermission,
      };
    }
  };
  let talkDesired = false,
    talkLease: ReturnType<typeof setTimeout> | undefined;
  const stopTalking = () => {
    talkDesired = false;
    clearTimeout(talkLease);
    try {
      const service = voice(),
        callId = service.status().callId;
      const mute = service.setTalking(false);
      const watchdog = setTimeout(() => {
        if (callId && service.status().callId === callId)
          void service.hangup().catch(() => {});
      }, 200);
      void mute.then(
        () => clearTimeout(watchdog),
        () => clearTimeout(watchdog),
      );
    } catch {
      /* Offline runtime already owns teardown. */
    }
  };
  window.on("blur", stopTalking);
  const handle = (
    name: string,
    action: (request: unknown) => unknown | Promise<unknown>,
  ) => {
    channels.push(name);
    ipcMain.handle(name, async (event, request: unknown) => {
      trusted(event, name);
      if (tearingDown) throw new Error("DESKTOP_CLOSING");
      const priority =
        name === "companion:status" ||
        name === "companion:voice" ||
        name === "companion:overlay" ||
        name === "companion:overlay:voice" ||
        name === "companion:overlay:voice:end" ||
        (name === "companion:overlay:mode" && request === false) ||
        (name === "companion:network" && request === false) ||
        (name === "companion:voice:action" &&
          !!request &&
          typeof request === "object" &&
          "action" in request &&
          (request.action === "hangup" ||
            (request.action === "consent" &&
              "enabled" in request &&
              request.enabled === false) ||
            (request.action === "talk" &&
              "pressed" in request &&
              request.pressed === false) ||
            (request.action === "output" &&
              "muted" in request &&
              request.muted === true)));
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
    const microphone = voiceView().capturing;
    return {
      version: 1,
      session: logProvider.status().state,
      detection: logProvider.status(),
      matching: sessions()?.status() ?? { state: "offline", participants: 0 },
      network: network.status().state,
      connection: network.status(),
      microphone:
        microphone === null ? "unknown" : microphone ? "capturing" : "off",
      preferences: preferences ? "ready" : "unavailable",
    };
  });
  handle("companion:voice", (request) => {
    parseStatusRequest(request);
    return voiceView();
  });
  handle("companion:voice:action", async (request) => {
    const action = parseVoiceAction(request);
    if (action.action === "consent" && action.enabled === false) {
      stopTalking();
      try {
        voice().setConsent(false);
      } catch {
        /* Already offline. */
      }
      return voiceView();
    }
    const service = voice();
    try {
      if (action.action === "consent") {
        if (!window.isFocused()) throw new Error("VOICE_WINDOW_NOT_FOCUSED");
        service.setConsent(true);
      } else if (action.action === "call") {
        if (!window.isFocused()) throw new Error("VOICE_WINDOW_NOT_FOCUSED");
        await service.dial(
          messaging((messages) => messages.resolveContact(action.peerId)),
          true,
        );
      } else if (action.action === "answer") {
        if (!window.isFocused()) throw new Error("VOICE_WINDOW_NOT_FOCUSED");
        await service.answer(action.callId, true);
      } else if (action.action === "hangup") {
        if (service.status().callId !== action.callId)
          throw new Error("VOICE_STATE_MISMATCH");
        stopTalking();
        await service.hangup();
      } else if (action.action === "output") {
        if (service.status().callId !== action.callId)
          throw new Error("VOICE_STATE_MISMATCH");
        const watchdog = action.muted
          ? setTimeout(() => {
              if (service.status().callId === action.callId)
                void service.hangup().catch(() => {});
            }, 200)
          : undefined;
        try {
          await service.setOutput(action.volume, action.muted);
        } finally {
          clearTimeout(watchdog);
        }
      } else {
        if (service.status().callId !== action.callId)
          throw new Error("VOICE_STATE_MISMATCH");
        if (!action.pressed) stopTalking();
        else {
          if (!window.isFocused()) throw new Error("VOICE_WINDOW_NOT_FOCUSED");
          if (!action.start && !talkDesired)
            throw new Error("VOICE_NOT_CONNECTED");
          talkDesired = true;
          clearTimeout(talkLease);
          talkLease = setTimeout(stopTalking, 600);
          await service.setTalking(true);
          if (!talkDesired || !window.isFocused()) stopTalking();
        }
      }
      return voiceView();
    } catch (error) {
      const code =
        error instanceof Error &&
        [
          "VOICE_WINDOW_NOT_FOCUSED",
          "VOICE_STATE_MISMATCH",
          "VOICE_NOT_PERMITTED",
          "VOICE_NOT_CONNECTED",
          "MEDIA_NOT_CONNECTED",
          "VOICE_BUSY",
          "CONTACT_NOT_DISCOVERED",
          "MEDIA_PERMISSION_DENIED",
          "MEDIA_DEVICE_UNAVAILABLE",
        ].includes(error.message)
          ? error.message
          : "VOICE_ACTION_FAILED";
      throw new Error(code);
    }
  });
  handle("companion:overlay", (request) => {
    parseStatusRequest(request);
    return overlay.status();
  });
  const overlayVoiceView = (): OverlayVoiceView => {
    const { phase, callId, capturing, transmitting } = voiceView();
    return { phase, callId, capturing, transmitting };
  };
  handle("companion:overlay:voice", (request) => {
    parseStatusRequest(request);
    return overlayVoiceView();
  });
  handle("companion:overlay:voice:end", async (request) => {
    const { callId } = parseOverlayEndCall(request);
    const service = voice();
    if (service.status().callId !== callId)
      throw new Error("VOICE_STATE_MISMATCH");
    stopTalking();
    await service.hangup();
    return overlayVoiceView();
  });
  handle("companion:overlay:mode", (request) => {
    if (typeof request !== "boolean") throw new Error("INVALID_OVERLAY_MODE");
    return overlay.setInteractive(request);
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
      if (patch.sessionConsent !== undefined || patch.displayName !== undefined)
        void sessions()?.settingsChanged();
      if (patch.overlay !== undefined) await overlay.apply(saved.overlay);
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
    if (!request) {
      stopTalking();
      network.setEnabled(false);
    }
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
      try {
        pairing().policyChanged();
      } catch {
        /* Offline pairing has already been closed. */
      }
      const saving = preferences[action](peerId);
      if (action !== "unblock") {
        try {
          network.using((runtime) => {
            if ("voice" in runtime && runtime.voice instanceof VoiceCalls)
              runtime.voice.policyChanged();
          });
        } catch {
          /* Offline voice has already been closed. */
        }
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
  handle("companion:pairing:create", (request) => {
    parseStatusRequest(request);
    return pairing().create();
  });
  handle("companion:pairing:preview", (request) => pairing().preview(request));
  handle("companion:pairing:cancel", (request) => {
    pairing().cancel(request);
    return { canceled: true };
  });
  handle("companion:pairing:approve", async (request) => {
    if (!preferences) throw new Error("PREFERENCES_UNAVAILABLE");
    if (
      !request ||
      typeof request !== "object" ||
      Object.keys(request).sort().join(",") !== "consent,ticket" ||
      Array.isArray(request) ||
      !("consent" in request) ||
      request.consent !== true ||
      !("ticket" in request)
    )
      throw new Error("PAIRING_CONSENT_REQUIRED");
    const store = preferences;
    try {
      await pairing().approve(request.ticket, (id, guard) =>
        store.allow(id, guard),
      );
      return store.snapshot();
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "CONTACT_APPROVAL_ROLLBACK_FAILED"
      )
        throw new Error("CONTACT_APPROVAL_ROLLBACK_FAILED");
      throw new Error("PAIRING_APPROVAL_FAILED");
    }
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    tearingDown = true;
    stopTalking();
    window.removeListener("blur", stopTalking);
    overlay.close();
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
  window.on("closed", () => {
    void close().catch(() => {});
  });
  if (preferences?.snapshot().networkEnabled) network.setEnabled(true);
  await logProvider.setEnabled(preferences?.snapshot().sessionConsent ?? false);
  if (preferences) await overlay.apply(preferences.snapshot().overlay);
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
    overlay,
  };
}
