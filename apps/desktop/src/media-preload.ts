import { contextBridge, ipcRenderer } from "electron";
import {
  MEDIA_COMMAND,
  MEDIA_REPLY,
  parseMediaCommand,
  parseMediaReply,
} from "../../../packages/voice/src/media-host-protocol.js";

let installed = false;
contextBridge.exposeInMainWorld(
  "companionMedia",
  Object.freeze({
    security: () => ({
      sandboxed: process.sandboxed === true,
      contextIsolated: process.contextIsolated === true,
    }),
    listen: (callback: (command: unknown) => void) => {
      if (installed || typeof callback !== "function")
        throw new Error("MEDIA_LISTENER_UNAVAILABLE");
      installed = true;
      ipcRenderer.on(MEDIA_COMMAND, (_event, value: unknown) => {
        try {
          callback(parseMediaCommand(value));
        } catch {
          /* Malformed commands grant nothing. */
        }
      });
      ipcRenderer.send(MEDIA_REPLY, { id: "ready", ok: true, data: null });
    },
    reply: (value: unknown) =>
      ipcRenderer.send(MEDIA_REPLY, parseMediaReply(value)),
  }),
);
