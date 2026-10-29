import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow, ipcMain, session } from "electron";
import { DesktopMediaHost } from "../../apps/desktop/src/media-host.js";
import { MEDIA_REPLY } from "../../packages/voice/src/media-host-protocol.js";

async function run() {
  const directory = process.argv[2];
  if (!directory) throw new Error("ISOLATED_DIRECTORY_REQUIRED");
  app.setPath("userData", path.join(directory, "host-profile"));
  app.on("window-all-closed", () => {});
  const hosts: DesktopMediaHost[] = [];
  try {
    await app.whenReady();
    session.defaultSession.setPermissionRequestHandler((_c, _p, callback) =>
      callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    const listenerCount = ipcMain.listenerCount(MEDIA_REPLY);
    const assets = path.join(directory, "host-assets");
    let permitted = true;
    const left = new DesktopMediaHost(assets, { permitted: () => permitted });
    const right = new DesktopMediaHost(assets, { permitted: () => true });
    hosts.push(left, right);
    assert.deepEqual(await left.status(), {
      phase: "idle",
      capturing: false,
      transmitting: false,
      outputLevel: null,
      inputLevel: null,
      inputClipping: null,
    });
    await assert.rejects(left.offer(false), /MEDIA_HOST_DENIED/);
    const offer = await left.offer(true);
    const answer = await right.answer(offer, true);
    await left.acceptAnswer(answer);
    const windows = BrowserWindow.getAllWindows();
    assert.equal(windows.length, 2);
    for (const window of windows) {
      assert.deepEqual(
        await window.webContents.executeJavaScript(
          "window.companionMedia.security()",
        ),
        { sandboxed: true, contextIsolated: true },
      );
      assert.deepEqual(
        await window.webContents.executeJavaScript(
          "[typeof require, typeof process, typeof window.companion, typeof window.companionMedia.reply]",
        ),
        ["undefined", "undefined", "undefined", "function"],
      );
    }
    assert.notEqual(
      windows[0]?.webContents.session,
      windows[1]?.webContents.session,
    );
    const deadline = Date.now() + 7000;
    while (
      ((await left.status()).phase !== "connected" ||
        (await right.status()).phase !== "connected") &&
      Date.now() < deadline
    )
      await delay(25);
    assert.equal((await left.status()).phase, "connected");
    await delay(300);
    const muted = await Promise.all(
      windows.map((window) =>
        window.webContents.executeJavaScript("window.syntheticRms()"),
      ),
    );
    assert.ok(
      muted.every((value) => typeof value === "number" && value < 0.00001),
      `HOST_MUTED_RMS ${JSON.stringify(muted)}`,
    );
    await left.setTalking(true);
    await delay(600);
    const localInput = await left.status();
    assert.ok(localInput.inputLevel !== null && localInput.inputLevel > 0.1);
    const talking = await Promise.all(
      windows.map((window) =>
        window.webContents.executeJavaScript("window.syntheticRms()"),
      ),
    );
    assert.equal(
      talking.filter((value) => value > 0.01).length,
      1,
      `HOST_TALKING_RMS ${JSON.stringify(talking)}`,
    );
    const metrics = await right.metrics();
    const quality = await right.quality();
    assert.notEqual(quality.roundTripMs, null);
    assert.notEqual(quality.jitterMs, null);
    assert.notEqual(quality.packetsLost, null);
    // One optional diagnostic must not consume any of four ordinary slots.
    await Promise.all([
      right.quality(),
      right.status(),
      right.setTalking(false),
      right.setOutput(1, false),
      right.metrics(),
    ]);
    assert.equal((await right.status()).phase, "connected");
    await left.setTalking(true);
    const renewOutputTest = setInterval(() => {
      void left.setTalking(true).catch(() => {});
    }, 200);
    let fullOutput = 0,
      quarterOutput = 0,
      mutedOutput = 0,
      quarterInput = 0,
      zeroInput = 0;
    try {
      const outputRms = async () =>
        Math.max(
          ...(await Promise.all(
            windows.map((window) =>
              window.webContents.executeJavaScript(
                "window.syntheticOutputRms()",
              ),
            ),
          )),
        );
      await delay(100);
      fullOutput = await outputRms();
      assert.ok(fullOutput > 0.1);
      await right.setOutput(0.25, false);
      await delay(180);
      quarterOutput = await outputRms();
      assert.ok(
        quarterOutput / fullOutput > 0.18 && quarterOutput / fullOutput < 0.32,
        "post-gain quarter volume",
      );
      await right.setOutput(0.25, true);
      await delay(180);
      mutedOutput = await outputRms();
      assert.ok(mutedOutput < 0.00001, "deafen must silence output");
      const upstream = await Promise.all(
        windows.map((window) =>
          window.webContents.executeJavaScript("window.syntheticRms()"),
        ),
      );
      assert.ok(
        upstream.some((value) => value > 0.01),
        "deafen must not stop incoming transport",
      );
      assert.equal((await left.status()).transmitting, true);
      await right.setOutput(1, false);
      await delay(180);
      assert.ok((await outputRms()) > 0.1, "unmute restores output");
      await left.setInputGain(0.25);
      await delay(250);
      quarterInput = await outputRms();
      const quarterActivity = await left.status();
      assert.ok(
        quarterActivity.inputLevel !== null &&
          localInput.inputLevel !== null &&
          quarterActivity.inputLevel / localInput.inputLevel > 0.18 &&
          quarterActivity.inputLevel / localInput.inputLevel < 0.32,
      );
      assert.equal(quarterActivity.inputClipping, false);
      assert.ok(
        quarterInput / fullOutput > 0.18 && quarterInput / fullOutput < 0.32,
        "native input gain scales encoded audio",
      );
      await left.setInputGain(0);
      await delay(250);
      zeroInput = await outputRms();
      assert.ok(zeroInput < 0.00001, "zero input gain silences encoded audio");
      assert.equal((await left.status()).capturing, true);
      assert.equal((await left.status()).inputLevel, 0);
      assert.equal((await left.status()).inputClipping, false);
      await left.setInputGain(1);
      await delay(200);
      assert.ok((await outputRms()) > 0.1, "input unity restores audio");
    } finally {
      clearInterval(renewOutputTest);
    }
    assert.ok(
      metrics.receivedPackets > 0 && metrics.receivedBytes > 0,
      `HOST_RTP_METRICS ${JSON.stringify(metrics)}`,
    );
    await left.setTalking(false);
    await delay(400);
    const released = await Promise.all(
      windows.map((window) =>
        window.webContents.executeJavaScript("window.syntheticRms()"),
      ),
    );
    assert.ok(
      released.every((value) => value < 0.00001),
      `HOST_RELEASE_RMS ${JSON.stringify(released)}`,
    );
    await right.setTalking(true);
    await delay(600);
    const reverseTalking = await Promise.all(
      windows.map((window) =>
        window.webContents.executeJavaScript("window.syntheticRms()"),
      ),
    );
    assert.equal(
      reverseTalking.filter((value) => value > 0.01).length,
      1,
      `HOST_REVERSE_RMS ${JSON.stringify(reverseTalking)}`,
    );
    assert.ok((await left.metrics()).receivedPackets > 0);
    await right.setTalking(false);
    await right.setTalking(true);
    await delay(1050);
    const leaseExpired = await Promise.all(
      windows.map((window) =>
        window.webContents.executeJavaScript("window.syntheticRms()"),
      ),
    );
    assert.ok(
      leaseExpired.every((value) => value < 0.00001),
      "PTT lease must mute without a release packet",
    );
    assert.equal((await right.status()).transmitting, false);
    permitted = false;
    await assert.rejects(left.status(), /MEDIA_HOST_DENIED/);
    assert.equal(windows.filter((window) => window.isDestroyed()).length, 1);
    right.close();
    assert.equal(ipcMain.listenerCount(MEDIA_REPLY), listenerCount);
    const denied = new DesktopMediaHost(
      path.join(directory, "production-assets"),
      {
        permitted: () => true,
      },
    );
    hosts.push(denied);
    await assert.rejects(denied.offer(true), /MEDIA_PERMISSION_DENIED/);
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    // A real foreign renderer with the genuine preload cannot unblock host startup.
    const stalledAssets = path.join(directory, "stalled-host");
    await mkdir(stalledAssets);
    await writeFile(
      path.join(stalledAssets, "media.html"),
      "<!doctype html><html><body>no media listener</body></html>",
    );
    await writeFile(
      path.join(stalledAssets, "media-preload.cjs"),
      await readFile(path.join(assets, "media-preload.cjs")),
    );
    const stalled = new DesktopMediaHost(stalledAssets, {
      permitted: () => true,
      timeoutMs: 1000,
    });
    hosts.push(stalled);
    const pending = stalled.status();
    const rejection = assert.rejects(pending, /MEDIA_HOST_CLOSED/);
    const foreign = new BrowserWindow({
      show: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(stalledAssets, "media-preload.cjs"),
      },
    });
    await foreign.loadFile(path.join(stalledAssets, "media.html"));
    await foreign.webContents.executeJavaScript(
      "window.companionMedia.reply({id:'ready',ok:true,data:null})",
    );
    await rejection;
    foreign.destroy();
    const canceledHost = new DesktopMediaHost(assets, {
      permitted: () => true,
    });
    hosts.push(canceledHost);
    await canceledHost.status();
    const canceled = canceledHost.offer(true);
    const canceledCheck = assert.rejects(
      canceled,
      /MEDIA_HOST_CLOSED|MEDIA_HOST_DENIED/,
    );
    canceledHost.close();
    await canceledCheck;
    const bounded = Array.from(
      { length: 5 },
      () => new DesktopMediaHost(assets, { permitted: () => true }),
    );
    hosts.push(...bounded);
    await Promise.all(bounded.slice(0, 4).map((host) => host.status()));
    const excess = bounded[4];
    assert.ok(excess);
    await assert.rejects(excess.status(), /MEDIA_HOST_SESSION_QUOTA/);
    assert.equal(BrowserWindow.getAllWindows().length, 4);
    for (const host of bounded) host.close();
    assert.equal(ipcMain.listenerCount(MEDIA_REPLY), listenerCount);
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    console.log(
      JSON.stringify({
        result: "media-host-passed",
        sandbox: true,
        isolatedSessions: true,
        muted,
        talking,
        released,
        reverseTalking,
        fullOutput,
        quarterOutput,
        mutedOutput,
        quarterInput,
        zeroInput,
        receivedPackets: metrics.receivedPackets,
        quality,
        foreignReadyRejected: true,
        microphone: false,
        audibleOutput: false,
      }),
    );
    app.exit(0);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "MEDIA_HOST_SMOKE_FAILED",
    );
    for (const host of hosts) host.close();
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    app.exit(1);
  }
}
void run();
