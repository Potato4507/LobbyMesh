import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow } from "electron";
import { createDesktop } from "../../apps/desktop/src/desktop.js";
import { PreferenceStore } from "../../packages/security/src/preferences.js";

async function run() {
  console.log("desktop stage: starting");
  const directory = process.argv[2];
  if (!directory) throw new Error("ISOLATED_DIRECTORY_REQUIRED");
  await mkdir(path.join(directory, "profile"), { recursive: true });
  app.setPath("userData", path.join(directory, "profile"));
  const preferencesPath = path.join(directory, "preferences"),
    allowed = "ab".repeat(32);
  const seed = await PreferenceStore.open(preferencesPath);
  await seed.allow(allowed);
  await seed.close();
  await app.whenReady();
  console.log("desktop stage: ready");
  let desktop: Awaited<ReturnType<typeof createDesktop>> | undefined,
    foreign: BrowserWindow | undefined;
  try {
    desktop = await createDesktop(preferencesPath, path.resolve("dist"), false);
    console.log("desktop stage: loaded");
    const contents = desktop.window.webContents;
    const execute = <T>(code: string): Promise<T> =>
      contents.executeJavaScript(code);
    async function until(code: string) {
      for (let n = 0; n < 250; n++) {
        if (await execute<boolean>(code)) return;
        await delay(20);
      }
      throw new Error(`UI_WAIT_TIMEOUT: ${code}`);
    }
    await until(
      "document.querySelector('#displayName')?.value === 'LobbyMesh user'",
    );
    const security = await execute<{
      sandboxed: boolean;
      contextIsolated: boolean;
    }>("window.companion.security()");
    assert.equal(security.sandboxed, true);
    assert.equal(security.contextIsolated, true);
    assert.deepEqual(await execute("[typeof require, typeof process]"), [
      "undefined",
      "undefined",
    ]);
    assert.equal(
      (await execute<{ network: string }>("window.companion.status()")).network,
      "offline",
    );
    assert.deepEqual(
      await execute(
        "window.companion.preferences().then(p => [p.sessionConsent, p.networkEnabled, p.voiceMode])",
      ),
      [false, false, "off"],
    );
    assert.ok(
      await execute(
        "window.companion.contact('allow', 'a'.repeat(64)).then(() => false, () => true)",
      ),
    );
    await execute(`(() => {
    const input = document.querySelector('#displayName');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Local smoke test');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#sessionConsent').click();
  })()`);
    await until("!document.querySelector('button[type=submit]').disabled");
    await execute("document.querySelector('button[type=submit]').click()");
    await until(
      "document.querySelector('output')?.textContent.includes('Saved on this device')",
    );
    const saved = await execute<{
      displayName: string;
      sessionConsent: boolean;
      networkEnabled: boolean;
      voiceMode: string;
    }>("window.companion.preferences()");
    assert.equal(saved.displayName, "Local smoke test");
    assert.equal(saved.sessionConsent, true);
    assert.equal(saved.networkEnabled, false);
    assert.equal(saved.voiceMode, "off");
    assert.ok(
      await execute(
        "window.companion.updatePreferences({unexpected: true}).then(() => false, () => true)",
      ),
    );
    await execute(
      "Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Block').click()",
    );
    await until(
      "Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Unblock')",
    );
    await execute(
      "Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Unblock').click()",
    );
    await until(
      "!Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Unblock')",
    );
    assert.deepEqual(
      await execute(
        "window.companion.preferences().then(p => [p.allowedPeers, p.blockedPeers])",
      ),
      [[], []],
    );
    foreign = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: path.resolve("dist/preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    await foreign.loadFile(path.resolve("dist/index.html"));
    assert.ok(
      await foreign.webContents.executeJavaScript(
        "window.companion.preferences().then(() => false, () => true)",
      ),
    );
    desktop.window.setContentSize(1080, 1000);
    await delay(100);
    const screenshot = path.resolve("docs/evidence/lobbymesh-settings.png");
    await writeFile(screenshot, (await contents.capturePage()).toPNG());
    await desktop.close();
    assert.equal(
      JSON.parse(
        await readFile(
          path.join(preferencesPath, "preferences-v1.json"),
          "utf8",
        ),
      ).displayName,
      "Local smoke test",
    );
    console.log(
      JSON.stringify({
        result: "passed",
        electron: process.versions.electron,
        checks: [
          "sandbox",
          "context-isolation",
          "no-renderer-node",
          "preload-ipc",
          "form-persistence",
          "consent-default-off",
          "network-and-mic-off",
          "unknown-field-rejected",
          "block-unblock-no-reauthorization",
          "foreign-window-ipc-rejected",
        ],
        screenshot,
      }),
    );
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    foreign?.destroy();
    desktop?.window.destroy();
    await desktop?.close();
    app.exit(Number(process.exitCode ?? 0));
  }
}
void run().catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});
