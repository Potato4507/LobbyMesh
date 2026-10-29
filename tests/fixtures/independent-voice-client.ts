import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow } from "electron";
import { loadDesktopCredentials } from "../../apps/desktop/src/credentials.js";
import { createDesktop } from "../../apps/desktop/src/desktop.js";
import { DesktopMediaHost } from "../../apps/desktop/src/media-host.js";
import { createDesktopNetwork } from "../../apps/desktop/src/network.js";

async function run() {
  const argument = process.argv[2],
    bootstrap = process.argv[3],
    mediaAssets = process.argv[4];
  if (!argument || !bootstrap || !mediaAssets || !process.send)
    throw new Error("ISOLATED_CLIENT_ARGUMENTS_REQUIRED");
  const directory = path.resolve(argument);
  app.setPath("userData", path.join(directory, "profile"));
  assert.ok(app.requestSingleInstanceLock());
  app.on("window-all-closed", () => {});
  await app.whenReady();
  const desktop = await createDesktop(
    path.join(directory, "preferences"),
    path.resolve("dist"),
    false,
    {
      networkFactory: (signal, policy, sessions) =>
        createDesktopNetwork(
          path.join(directory, "network"),
          signal,
          policy,
          sessions,
          (context) =>
            new DesktopMediaHost(mediaAssets, { permitted: context.permitted }),
          { bootstrap: [bootstrap] },
        ),
    },
  );
  const execute = <T>(code: string): Promise<T> =>
    desktop.window.webContents.executeJavaScript(code);
  async function focus() {
    desktop.window.show();
    desktop.window.focus();
    const deadline = Date.now() + 3000;
    while (!desktop.window.isFocused() && Date.now() < deadline) {
      desktop.window.focus();
      await delay(20);
    }
    assert.ok(desktop.window.isFocused(), "CLIENT_FOCUS_REQUIRED");
  }
  await execute("window.companion.network(true)");
  const deadline = Date.now() + 15_000;
  while (
    (await execute<{ network: string }>("window.companion.status()"))
      .network !== "online" &&
    Date.now() < deadline
  )
    await delay(25);
  assert.equal(
    (await execute<{ network: string }>("window.companion.status()")).network,
    "online",
  );
  const credentials = await loadDesktopCredentials(
    path.join(directory, "network"),
  );
  let renewal: ReturnType<typeof setInterval> | undefined,
    callId: string | undefined,
    busy = false;
  const release = async () => {
    clearInterval(renewal);
    renewal = undefined;
    if (callId)
      await execute(
        `window.companion.voiceAction({action:'talk',callId:${JSON.stringify(callId)},pressed:false,start:false})`,
      ).catch(() => {});
    callId = undefined;
  };
  process.send?.({
    ready: true,
    peerId: credentials.identity.peerId,
    pid: process.pid,
  });
  process.on(
    "message",
    (message: {
      id: number;
      op: string;
      code?: string;
      peerId?: string;
      callId?: string;
      volume?: number;
      gain?: number;
      muted?: boolean;
    }) => {
      void (async () => {
        switch (message.op) {
          case "snapshot":
            return execute(
              "Promise.all([window.companion.status(),window.companion.voice()]).then(([app,voice])=>({network:app.network,microphone:app.microphone,voice}))",
            );
          case "code":
            return execute("window.companion.createPairingCode()");
          case "permission":
            return execute(
              `window.companion.preferences().then(p=>p.allowedPeers.includes(${JSON.stringify(message.peerId)}))`,
            );
          case "approve":
            return execute(
              `window.companion.previewPairingCode(${JSON.stringify(message.code)}).then(p=>window.companion.approvePairing(p.ticket,true)).then(()=>true)`,
            );
          case "enable-voice":
            await focus();
            await execute(
              "window.companion.voiceAction({action:'consent',enabled:true})",
            );
            desktop.window.hide();
            return true;
          case "call":
            await focus();
            try {
              return await execute(
                `window.companion.voiceAction({action:'call',peerId:${JSON.stringify(message.peerId)},consent:true})`,
              );
            } finally {
              desktop.window.hide();
            }
          case "answer":
            await focus();
            try {
              return await execute(
                `window.companion.voiceAction({action:'answer',callId:${JSON.stringify(message.callId)},consent:true})`,
              );
            } finally {
              desktop.window.hide();
            }
          case "talk": {
            await focus();
            const status = await execute<{ callId: string }>(
              "window.companion.voice()",
            );
            callId = status.callId;
            await execute(
              `window.companion.voiceAction({action:'talk',callId:${JSON.stringify(callId)},pressed:true,start:true})`,
            );
            renewal = setInterval(() => {
              if (busy || !callId) return;
              busy = true;
              void execute(
                `window.companion.voiceAction({action:'talk',callId:${JSON.stringify(callId)},pressed:true,start:false})`,
              )
                .catch(() => {
                  clearInterval(renewal);
                })
                .finally(() => {
                  busy = false;
                });
            }, 200);
            return true;
          }
          case "release":
            await release();
            desktop.window.hide();
            return true;
          case "samples": {
            const windows = BrowserWindow.getAllWindows().filter(
              (window) => window !== desktop.window,
            );
            const rms = await Promise.all(
              windows.map((window) =>
                window.webContents.executeJavaScript("window.syntheticRms()"),
              ),
            );
            const outputRms = await Promise.all(
              windows.map((window) =>
                window.webContents.executeJavaScript(
                  "window.syntheticOutputRms()",
                ),
              ),
            );
            return { hosts: windows.length, rms, outputRms };
          }
          case "output":
            return execute(
              `window.companion.voice().then(s=>window.companion.voiceAction({action:'output',callId:s.callId,volume:${JSON.stringify(message.volume)},muted:${JSON.stringify(message.muted)}}))`,
            );
          case "input-gain":
            return execute(
              `window.companion.voice().then(s=>window.companion.voiceAction({action:'input-gain',callId:s.callId,gain:${JSON.stringify(message.gain)}}))`,
            );
          case "hangup":
            await release();
            return execute(
              "window.companion.voice().then(s=>window.companion.voiceAction({action:'hangup',callId:s.callId}))",
            );
          case "revoke":
            return execute(
              `window.companion.contact('revoke',${JSON.stringify(message.peerId)}).then(()=>true)`,
            );
          case "stop":
            await release();
            await desktop.close();
            desktop.window.destroy();
            return {
              stopped: true,
              windows: BrowserWindow.getAllWindows().length,
            };
          default:
            throw new Error("UNKNOWN_CLIENT_COMMAND");
        }
      })().then(
        (result) => {
          process.send?.(
            { id: message.id, result },
            undefined,
            undefined,
            () => {
              if (message.op === "stop") app.exit(0);
            },
          );
        },
        (error: unknown) =>
          process.send?.({
            id: message.id,
            error:
              error instanceof Error ? error.message : "CLIENT_COMMAND_FAILED",
          }),
      );
    },
  );
}
void run().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "INDEPENDENT_CLIENT_FAILED",
  );
  app.exit(1);
});
