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
    overlay: () => ipcRenderer.invoke("companion:overlay"),
    overlayMode: (interactive: unknown) =>
      ipcRenderer.invoke("companion:overlay:mode", interactive),
    messaging: () => ipcRenderer.invoke("companion:messaging"),
    messages: (peerId: unknown) =>
      ipcRenderer.invoke("companion:messages", peerId),
    sendText: (peerId: unknown, text: unknown) =>
      ipcRenderer.invoke("companion:messages:send", { peerId, text }),
    clearMessages: (peerId: unknown) =>
      ipcRenderer.invoke("companion:messages:clear", peerId),
    network: (enabled: unknown) =>
      ipcRenderer.invoke("companion:network", enabled),
    preferences: () => ipcRenderer.invoke("companion:preferences"),
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
