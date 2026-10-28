import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow, powerMonitor } from "electron";
import { createDesktop } from "../../apps/desktop/src/desktop.js";
import { DesktopMessaging } from "../../apps/desktop/src/messaging.js";
import type {
  ContactPolicy,
  DesktopNetworkFactory,
} from "../../apps/desktop/src/network.js";
import { createOverlayRuntime } from "../../packages/app-dht/src/runtime.js";
import {
  DIRECT_NAMESPACE,
  DirectMessenger,
  type TextEnvelope,
} from "../../packages/protocol/src/direct.js";
import { PreferenceStore } from "../../packages/security/src/preferences.js";

async function run() {
  assert.equal(typeof createOverlayRuntime, "function");
  console.log("desktop stage: starting");
  const directory = process.argv[2];
  if (!directory) throw new Error("ISOLATED_DIRECTORY_REQUIRED");
  await mkdir(path.join(directory, "profile"), { recursive: true });
  app.setPath("userData", path.join(directory, "profile"));
  app.on("window-all-closed", () => {});
  const preferencesPath = path.join(directory, "preferences"),
    allowed = "ab".repeat(32);
  const seed = await PreferenceStore.open(preferencesPath);
  await seed.allow(allowed);
  await seed.close();
  await app.whenReady();
  console.log("desktop stage: ready");
  let desktop: Awaited<ReturnType<typeof createDesktop>> | undefined,
    foreign: BrowserWindow | undefined;
  let starts = 0,
    stops = 0,
    policy: ContactPolicy | undefined;
  const self = "aa".repeat(32),
    transportKey = "cd".repeat(32);
  let messaging: DesktopMessaging | undefined,
    receiver: DirectMessenger | undefined,
    holdSends = false;
  const networkFactory: DesktopNetworkFactory = async (_signal, value) => {
    policy = value;
    const remote = new DirectMessenger(allowed, async () => null, {
      authorized: (id) => id === self,
    });
    const service = new DesktopMessaging(
      self,
      async (_contact, request, signal) => {
        if (holdSends && (request as { type?: string }).type === "text")
          return new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new Error("test canceled")),
              { once: true },
            );
          });
        return remote.handle(
          { id: self, publicKey: "synthetic app", transportKey },
          request,
          signal,
        );
      },
      value,
      () => [{ id: allowed, transportKey }],
    );
    messaging = service;
    receiver = remote;
    return {
      messaging: service,
      async start() {
        starts++;
      },
      async stop() {
        service.close();
        remote.close();
        stops++;
      },
      status: () => undefined,
      peerCount: () => 1,
    };
  };
  try {
    desktop = await createDesktop(
      preferencesPath,
      path.resolve("dist"),
      false,
      { networkFactory },
    );
    console.log("desktop stage: loaded");
    let contents = desktop.window.webContents;
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
    assert.equal(starts, 0);
    assert.ok(
      await execute(
        "window.companion.network('yes').then(() => false, () => true)",
      ),
    );
    assert.ok(
      await execute(
        "window.companion.updatePreferences({networkEnabled:true}).then(() => false, () => true)",
      ),
    );
    await execute("document.querySelector('#networkControl').click()");
    await until(
      "document.querySelector('#networkControl')?.textContent === 'Disconnect'",
    );
    await until("window.companion.status().then(s => s.network === 'online')");
    assert.equal(starts, 1);
    assert.ok(policy?.authorized(allowed));
    assert.equal(
      await execute(
        "window.companion.preferences().then(p => p.networkEnabled)",
      ),
      true,
    );
    powerMonitor.emit("suspend");
    await until(
      "window.companion.status().then(s => s.network === 'suspended')",
    );
    powerMonitor.emit("resume");
    await until("window.companion.status().then(s => s.network === 'online')");
    assert.equal(starts, 2);
    await until(
      `document.querySelector('#contactSelect')?.value === ${JSON.stringify(allowed)}`,
    );
    const draft = (text: string) =>
      execute(`(() => {
      const input = document.querySelector('#messageDraft');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await draft("native UI message");
    await until("!document.querySelector('#sendMessage').disabled");
    await execute("document.querySelector('#sendMessage').click()");
    await until(
      "document.querySelector('#messageHistory .outgoing[data-status=acknowledged]')?.textContent.includes('native UI message')",
    );
    assert.equal(
      receiver?.history(self)[0]?.envelope.text,
      "native UI message",
    );
    assert.ok(messaging);
    const incoming: TextEnvelope = {
      namespace: DIRECT_NAMESPACE,
      version: 1,
      type: "text",
      id: "12".repeat(16),
      from: allowed,
      to: self,
      senderEpoch: "34".repeat(16),
      seq: 0,
      createdAt: Date.now(),
      text: "<script>window.untrusted = true</script>",
    };
    await messaging.handle(
      { id: allowed, publicKey: "synthetic app", transportKey },
      incoming,
      new AbortController().signal,
    );
    await until(
      "document.querySelector('#messageHistory .incoming')?.textContent.includes('<script>')",
    );
    assert.equal(
      await execute(
        "document.querySelector('#messageHistory script') === null && window.untrusted === undefined",
      ),
      true,
    );
    await execute(
      "(() => { const label = document.createElement('p'); label.id = 'syntheticLabel'; label.className = 'eyebrow'; label.textContent = 'SYNTHETIC UI TEST · NO LIVE PEER'; document.querySelector('#messagesPanel').prepend(label); document.querySelector('#messagesPanel').scrollIntoView(); })()",
    );
    await delay(100);
    await writeFile(
      path.resolve("docs/evidence/lobbymesh-messaging-test.png"),
      (await contents.capturePage()).toPNG(),
    );
    await execute(
      "document.querySelector('#syntheticLabel').remove(); document.querySelector('#clearMessages').click()",
    );
    await until(
      "document.querySelectorAll('#messageHistory article').length === 0",
    );
    await draft("😀".repeat(1025));
    await until("document.querySelector('#sendMessage').disabled");
    await draft("");
    await assert.rejects(
      execute(`window.companion.sendText('${"ef".repeat(32)}', 'forbidden')`),
      /CONTACT_NOT_AUTHORIZED/,
    );
    // Disconnect must remain available even when all ordinary IPC slots are busy.
    holdSends = true;
    await execute(
      `(() => { window.pendingMessages = Array.from({length:16}, () => window.companion.sendText('${allowed}', 'held fixture').catch(() => null)); return true; })()`,
    );
    await delay(30);
    await execute("window.companion.network(false)");
    await execute("Promise.all(window.pendingMessages)");
    await until("window.companion.status().then(s => s.network === 'offline')");
    holdSends = false;
    await execute("window.companion.network(true)");
    await until("window.companion.status().then(s => s.network === 'online')");
    await execute("window.scrollTo(0, 0)");
    await execute(`(() => {
    const input = document.querySelector('#displayName');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Local smoke test');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#sessionConsent').click();
  })()`);
    await until("!document.querySelector('button[type=submit]').disabled");
    await execute("document.querySelector('button[type=submit]').click()");
    await until(
      "document.querySelector('#preferencesNotice')?.textContent.includes('Saved on this device')",
    );
    const saved = await execute<{
      displayName: string;
      sessionConsent: boolean;
      networkEnabled: boolean;
      voiceMode: string;
    }>("window.companion.preferences()");
    assert.equal(saved.displayName, "Local smoke test");
    assert.equal(saved.sessionConsent, true);
    assert.equal(saved.networkEnabled, true);
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
    assert.ok(policy?.blocked(allowed));
    assert.equal(policy?.authorized(allowed), false);
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
    await execute("document.querySelector('#networkControl').click()");
    await until("window.companion.status().then(s => s.network === 'offline')");
    await until(
      "document.querySelector('#networkControl')?.textContent === 'Enable peer discovery'",
    );
    assert.equal(stops, 3);
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
    assert.ok(
      await foreign.webContents.executeJavaScript(
        "window.companion.network(true).then(() => false, () => true)",
      ),
    );
    desktop.window.setContentSize(1080, 1280);
    await delay(100);
    const screenshot = path.resolve("docs/evidence/lobbymesh-settings.png");
    await writeFile(screenshot, (await contents.capturePage()).toPNG());
    // A prior explicit permission must resume without asking for network keys.
    await execute("window.companion.network(true)");
    await until("window.companion.status().then(s => s.network === 'online')");
    await desktop.close();
    desktop.window.destroy();
    desktop = await createDesktop(
      preferencesPath,
      path.resolve("dist"),
      false,
      { networkFactory },
    );
    contents = desktop.window.webContents;
    await until("window.companion.status().then(s => s.network === 'online')");
    assert.equal(starts, 5);
    await execute("window.companion.network(false)");
    await until("window.companion.status().then(s => s.network === 'offline')");
    assert.equal(stops, 5);
    const canceled = new AbortController();
    const native = await createOverlayRuntime(
      path.join(directory, "native-runtime"),
      { signal: canceled.signal, bootstrap: ["127.0.0.1:9"] },
    );
    let rejected = false;
    const starting = native.start().catch(() => {
      rejected = true;
    });
    await delay(20);
    canceled.abort();
    await native.stop();
    await starting;
    assert.ok(rejected);
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
          "network-opt-in-and-disconnect",
          "sleep-resume-app-events",
          "persisted-network-permission-resumes",
          "live-policy-callbacks",
          "electron-native-runtime-cancellation",
          "authorized-messaging-ui",
          "incoming-text-escaped",
          "message-byte-limit-and-clear",
          "disconnect-under-ipc-load",
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
