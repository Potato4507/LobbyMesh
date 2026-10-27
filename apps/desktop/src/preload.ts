import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld(
  "companion",
  Object.freeze({ status: () => ipcRenderer.invoke("companion:status") }),
);
