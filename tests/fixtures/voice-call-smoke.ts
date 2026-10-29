import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, BrowserWindow } from "electron";
import HyperDHT from "hyperdht";
import { loadDesktopCredentials } from "../../apps/desktop/src/credentials.js";
import { DesktopMediaHost } from "../../apps/desktop/src/media-host.js";
import { createOverlayRuntime } from "../../packages/app-dht/src/runtime.js";
import { VoiceCalls } from "../../packages/voice/src/calls.js";

async function run() {
  const argument = process.argv[2];
  if (!argument) throw new Error("ISOLATED_DIRECTORY_REQUIRED");
  const directory: string = argument;
  app.setPath("userData", path.join(directory, "call-profile"));
  app.on("window-all-closed", () => {});
  const runtimes: Awaited<ReturnType<typeof createOverlayRuntime>>[] = [],
    calls: VoiceCalls[] = [];
  let bootstrap:
    | {
        ready(): Promise<void>;
        destroy(options: { force: boolean }): Promise<void>;
      }
    | undefined;
  try {
    await app.whenReady();
    const socket = createSocket("udp4");
    await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
    const port = socket.address().port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    bootstrap = (
      HyperDHT as {
        bootstrapper(port: number, host: string): NonNullable<typeof bootstrap>;
      }
    ).bootstrapper(port, "127.0.0.1");
    await bootstrap.ready();
    let allowed = true;
    async function create(name: string) {
      const credentials = await loadDesktopCredentials(
        path.join(directory, name),
      );
      let voice: VoiceCalls;
      const runtime = await createOverlayRuntime(path.join(directory, name), {
        credentials,
        bootstrap: [`127.0.0.1:${port}`],
        directHandler: (peer, request, signal) =>
          voice.handle(peer, request, signal),
      });
      runtimes.push(runtime);
      voice = new VoiceCalls(
        runtime.peerId,
        (contact, request, signal) =>
          runtime.overlay.directRequest(contact, request, signal),
        {
          authorized: () => allowed,
          negotiationTimeoutMs: 1500,
          activeTimeoutMs: 15_000,
          createMedia: (context) =>
            new DesktopMediaHost(path.join(directory, "host-assets"), {
              permitted: context.permitted,
            }),
        },
      );
      calls.push(voice);
      await runtime.start();
      return { runtime, voice };
    }
    const left = await create("a"),
      right = await create("b");
    const target = {
      id: right.runtime.peerId,
      transportKey: right.runtime.transportKey,
    };
    await assert.rejects(left.voice.dial(target, true), /VOICE_NOT_PERMITTED/);
    left.voice.setConsent(true);
    await assert.rejects(left.voice.dial(target, true), /REMOTE_RPC_REJECTED/);
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    right.voice.setConsent(true);
    const callId = await left.voice.dial(target, true);
    assert.equal(right.voice.status().phase, "ringing");
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    await right.voice.answer(callId, true);
    const deadline = Date.now() + 7000;
    while (
      (left.voice.status().phase !== "connected" ||
        right.voice.status().phase !== "connected") &&
      Date.now() < deadline
    )
      await delay(25);
    assert.equal(left.voice.status().phase, "connected");
    assert.equal(right.voice.status().phase, "connected");
    await delay(1800);
    assert.equal(left.voice.status().phase, "connected");
    const windows = BrowserWindow.getAllWindows();
    await left.voice.setTalking(true);
    await delay(600);
    const forward = await Promise.all(
      windows.map((window) =>
        window.webContents.executeJavaScript("window.syntheticRms()"),
      ),
    );
    assert.equal(forward.filter((value) => value > 0.01).length, 1);
    await left.voice.setTalking(false);
    await delay(400);
    const silence = await Promise.all(
      windows.map((window) =>
        window.webContents.executeJavaScript("window.syntheticRms()"),
      ),
    );
    assert.ok(silence.every((value) => value < 0.00001));
    await right.voice.setTalking(true);
    await delay(600);
    const reverse = await Promise.all(
      windows.map((window) =>
        window.webContents.executeJavaScript("window.syntheticRms()"),
      ),
    );
    assert.equal(reverse.filter((value) => value > 0.01).length, 1);
    const qualityDeadline = performance.now() + 4000;
    while (
      right.voice.status().quality.jitterMs === null &&
      performance.now() < qualityDeadline
    )
      await delay(25);
    const quality = right.voice.status().quality;
    assert.notEqual(quality.jitterMs, null);
    assert.notEqual(quality.roundTripMs, null);
    assert.notEqual(quality.packetsLost, null);
    await left.voice.hangup();
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    assert.equal(right.voice.status().phase, "idle");
    const second = await left.voice.dial(target, true);
    await right.voice.answer(second, true);
    allowed = false;
    left.voice.policyChanged();
    right.voice.policyChanged();
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    for (const voice of calls) voice.close();
    await Promise.all(runtimes.map((runtime) => runtime.stop()));
    await bootstrap.destroy({ force: true });
    bootstrap = undefined;
    console.log(
      JSON.stringify({
        result: "authenticated-media-passed",
        nativeNoise: true,
        runtimes: 2,
        electronMainProcesses: 1,
        forward,
        silence,
        reverse,
        quality,
        outlivedNegotiation: true,
        microphone: false,
        audibleOutput: false,
        crossNat: false,
      }),
    );
    app.exit(0);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "VOICE_CALL_SMOKE_FAILED",
    );
    for (const voice of calls) voice.close();
    await Promise.allSettled(runtimes.map((runtime) => runtime.stop()));
    await bootstrap?.destroy({ force: true });
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    app.exit(1);
  }
}
void run();
