import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld(
  "companion",
  Object.freeze({
    security: () => ({
      sandboxed: process.sandboxed === true,
      contextIsolated: process.contextIsolated === true,
    }),
    status: () => ipcRenderer.invoke("companion:status"),
    voice: () => ipcRenderer.invoke("companion:voice"),
    voiceAction: (request: unknown) =>
      ipcRenderer.invoke("companion:voice:action", request),
    voiceInputs: (request: unknown) =>
      ipcRenderer.invoke("companion:voice:inputs", request),
    overlay: () => ipcRenderer.invoke("companion:overlay"),
    overlayVoice: () => ipcRenderer.invoke("companion:overlay:voice"),
    endOverlayCall: (request: unknown) =>
      ipcRenderer.invoke("companion:overlay:voice:end", request),
    overlayMode: (interactive: unknown) =>
      ipcRenderer.invoke("companion:overlay:mode", interactive),
    messaging: () => ipcRenderer.invoke("companion:messaging"),
    messages: (peerId: unknown) =>
      ipcRenderer.invoke("companion:messages", peerId),
    rediscoverContact: (peerId: unknown) =>
      ipcRenderer.invoke("companion:messages:discover", peerId),
    sendText: (peerId: unknown, text: unknown) =>
      ipcRenderer.invoke("companion:messages:send", { peerId, text }),
    clearMessages: (peerId: unknown) =>
      ipcRenderer.invoke("companion:messages:clear", peerId),
    cancelMessage: (request: unknown) =>
      ipcRenderer.invoke("companion:messages:cancel", request),
    network: (enabled: unknown) =>
      ipcRenderer.invoke("companion:network", enabled),
    preferences: () => ipcRenderer.invoke("companion:preferences"),
    account: () => ipcRenderer.invoke("companion:account"),
    beginAccount: (username: unknown) =>
      ipcRenderer.invoke("companion:account:begin", username),
    confirmAccount: (claim: unknown) =>
      ipcRenderer.invoke("companion:account:confirm", claim),
    createPairingCode: () => ipcRenderer.invoke("companion:pairing:create"),
    previewPairingCode: (code: unknown) =>
      ipcRenderer.invoke("companion:pairing:preview", code),
    cancelPairing: (ticket: unknown) =>
      ipcRenderer.invoke("companion:pairing:cancel", ticket),
    approvePairing: (ticket: unknown, consent: unknown) =>
      ipcRenderer.invoke("companion:pairing:approve", { ticket, consent }),
    updatePreferences: (request: unknown) =>
      ipcRenderer.invoke("companion:preferences:update", request),
    contact: (action: unknown, peerId: unknown) =>
      ipcRenderer.invoke("companion:contact", { action, peerId }),
  }),
);
