import path from "node:path";
import { app, BrowserWindow, ipcMain, session } from "electron";
import { parseStatusRequest } from "../../../packages/protocol/src/index.js";

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  const window = new BrowserWindow({
    width: 960,
    height: 680,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  ipcMain.handle("companion:status", (event, request: unknown) => {
    if (
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error("UNTRUSTED_SENDER");
    parseStatusRequest(request);
    return {
      version: 1,
      session: "unsupported",
      network: "offline",
      microphone: "off",
    };
  });
  void window.loadFile(path.join(__dirname, "index.html"));
});
app.on("window-all-closed", () => app.quit());
