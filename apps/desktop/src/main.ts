import path from "node:path";
import { app } from "electron";
import { createDesktop } from "./desktop.js";

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
      );
    })
    .catch(() => app.quit());
app.on("before-quit", (event) => {
  if (!desktop || closing) return;
  event.preventDefault();
  closing = true;
  void desktop
    .close()
    .catch(() => {})
    .finally(() => app.quit());
});
app.on("window-all-closed", () => app.quit());
