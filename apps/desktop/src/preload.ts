import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld(
  "companion",
  Object.freeze({
    security: () => ({
      sandboxed: process.sandboxed === true,
      contextIsolated: process.contextIsolated === true,
    }),
    status: () => ipcRenderer.invoke("companion:status"),
    network: (enabled: unknown) =>
      ipcRenderer.invoke("companion:network", enabled),
    preferences: () => ipcRenderer.invoke("companion:preferences"),
    updatePreferences: (request: unknown) =>
      ipcRenderer.invoke("companion:preferences:update", request),
    contact: (action: unknown, peerId: unknown) =>
      ipcRenderer.invoke("companion:contact", { action, peerId }),
  }),
);
