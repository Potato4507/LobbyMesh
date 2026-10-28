import assert from "node:assert/strict";
import path from "node:path";
import { app, BrowserWindow, session } from "electron";

async function run() {
  const directory = process.argv[2];
  if (!directory) throw new Error("ISOLATED_DIRECTORY_REQUIRED");
  app.setPath("userData", path.join(directory, "profile"));
  app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
  let window: BrowserWindow | undefined;
  try {
    await app.whenReady();
    let permissionRequests = 0;
    session.defaultSession.setPermissionRequestHandler(
      (_contents, _permission, callback) => {
        permissionRequests++;
        callback(false);
      },
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    await window.loadFile(path.join(directory, "audio.html"));
    const result =
      await window.webContents.executeJavaScript("window.mediaResult");
    assert.equal(result.result, "synthetic-audio-passed");
    assert.ok(permissionRequests <= 1);
    assert.deepEqual(
      await window.webContents.executeJavaScript(
        "[typeof require, typeof process]",
      ),
      ["undefined", "undefined"],
    );
    console.log(
      JSON.stringify({
        ...result,
        electron: process.versions.electron,
        sandbox: true,
        permissionRequests,
      }),
    );
    window.destroy();
    app.exit(0);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "AUDIO_SMOKE_FAILED",
    );
    window?.destroy();
    app.exit(1);
  }
}
void run();
