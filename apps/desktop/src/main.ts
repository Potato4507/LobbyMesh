import { tmpdir } from "node:os";
import path from "node:path";
import { app } from "electron";
import { loadDesktopCredentials } from "./credentials.js";
import { createDesktop } from "./desktop.js";

// Explicit developer smoke mode is isolated from real profiles. The launcher
// owns cleanup after process exit; no arbitrary script/URL or profile is accepted.
const smokeIndex = process.argv.indexOf("--lobbymesh-smoke-profile");
const smokeProfile = smokeIndex < 0 ? undefined : process.argv[smokeIndex + 1];
if (
  smokeIndex >= 0 &&
  (!smokeProfile ||
    path.dirname(path.resolve(smokeProfile)) !== path.resolve(tmpdir()) ||
    !path.basename(smokeProfile).startsWith("lobbymesh-packaged-smoke-"))
)
  app.exit(1);
if (smokeProfile) app.setPath("userData", smokeProfile);

let desktop: Awaited<ReturnType<typeof createDesktop>> | undefined,
  closing = false;
if (!app.requestSingleInstanceLock()) app.quit();
else
  app
    .whenReady()
    .then(async () => {
      desktop = await createDesktop(
        path.join(app.getPath("userData"), "preferences"),
        __dirname,
        !smokeProfile,
      );
      if (smokeProfile) {
        const resources = `${path.resolve(process.resourcesPath)}${path.sep}`;
        if (
          Object.keys(require.cache).some(
            (file) => path.isAbsolute(file) && !file.startsWith(resources),
          )
        )
          throw new Error("PACKAGED_DEPENDENCY_ESCAPED_RESOURCES");
        const status = await desktop.window.webContents.executeJavaScript(
          "window.companion.status()",
        );
        const security = await desktop.window.webContents.executeJavaScript(
          "[window.companion.security(), typeof require, typeof process]",
        );
        if (
          status.network !== "offline" ||
          status.microphone !== "off" ||
          status.preferences !== "ready" ||
          status.session !== "disabled" ||
          security[0]?.sandboxed !== true ||
          security[0]?.contextIsolated !== true ||
          security[1] !== "undefined" ||
          security[2] !== "undefined"
        )
          throw new Error("PACKAGED_SECURITY_CHECK_FAILED");
        const credentials = await loadDesktopCredentials(
          path.join(smokeProfile, "network"),
        );
        const reopened = await loadDesktopCredentials(
          path.join(smokeProfile, "network"),
        );
        if (
          credentials.identity.peerId !== reopened.identity.peerId ||
          !credentials.transportKeys.publicKey.equals(
            reopened.transportKeys.publicKey,
          )
        )
          throw new Error("PACKAGED_CREDENTIAL_CHECK_FAILED");
        closing = true;
        await desktop.close();
        desktop.window.destroy();
        console.log(
          `LOBBYMESH_PACKAGED_SMOKE ${JSON.stringify({ result: "passed", packaged: app.isPackaged, electron: process.versions.electron, sandbox: true, contextIsolation: true, network: "offline", microphone: "off", credentials: "protected-reopen" })}`,
        );
        app.exit(0);
      }
    })
    .catch(() => {
      if (smokeProfile) {
        console.error("LOBBYMESH_PACKAGED_SMOKE_FAILED");
        app.exit(1);
      } else app.quit();
    });
app.on("before-quit", (event) => {
  if (!desktop || closing) return;
  event.preventDefault();
  closing = true;
  void desktop
    .close()
    .catch(() => {})
    .finally(() => app.quit());
});
app.on("window-all-closed", () => {
  if (!smokeProfile) app.quit();
});
