import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import HyperDHT from "hyperdht";

const root = await mkdtemp(path.join(tmpdir(), "lobbymesh-independent-voice-"));
const entry = path.resolve(
  "dist",
  `independent-voice-${process.pid}-${Date.now()}.cjs`,
);
const clients = [];
const crashMode = process.argv.includes("--crash");
const contactRecoveryMode = process.argv.includes("--contact-recovery");
let crashCleanupMs = null;
const crashTrace = [];
let bootstrap;
function client(directory, address, assets) {
  const env = { ...process.env };
  for (const key of ["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH"])
    delete env[key];
  const child = spawn(
    createRequire(import.meta.url)("electron"),
    [entry, directory, address, assets],
    { windowsHide: true, env, stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  let sequence = 0,
    diagnostics = "",
    readyResolve,
    readyReject;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const timer = setTimeout(
    () => readyReject(new Error(`CLIENT_READY_TIMEOUT ${diagnostics}`)),
    20_000,
  );
  const exited = new Promise((resolve) =>
    child.once("close", (code) => {
      clearTimeout(timer);
      const error = new Error(`CLIENT_EXIT ${code} ${diagnostics}`);
      readyReject(error);
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(error);
      }
      pending.clear();
      resolve(code);
    }),
  );
  child.on("error", (error) => {
    clearTimeout(timer);
    readyReject(error);
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      diagnostics = (diagnostics + String(chunk)).slice(-12_000);
    });
  child.on("message", (message) => {
    if (message.ready) {
      clearTimeout(timer);
      readyResolve(message);
      return;
    }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) {
      const error = new Error(`CLIENT_COMMAND ${item.op} ${message.error}`);
      error.operation = item.op;
      error.diagnostics = message.diagnostics;
      item.reject(error);
    } else item.resolve(message.result);
  });
  return {
    child,
    ready,
    exited,
    command(op, args = {}) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CLIENT_COMMAND_TIMEOUT ${op} ${diagnostics}`));
        }, 15_000);
        pending.set(id, { op, resolve, reject, timer });
        child.send({ id, op, ...args });
      });
    },
  };
}
async function until(check, label) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error(`INDEPENDENT_WAIT_TIMEOUT ${label}`);
}
try {
  await import("./build.mjs");
  const assets = path.join(root, "media");
  await mkdir(assets);
  for (const name of ["media.html", "media-preload.cjs"])
    await copyFile(path.resolve("dist", name), path.join(assets, name));
  await build({
    entryPoints: ["tests/fixtures/media-host-renderer.ts"],
    outfile: path.join(assets, "media-renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
  });
  await build({
    entryPoints: ["tests/fixtures/independent-voice-client.ts"],
    outfile: entry,
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron", "hyperdht"],
  });
  const socket = createSocket("udp4");
  await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  bootstrap = HyperDHT.bootstrapper(port, "127.0.0.1");
  await bootstrap.ready();
  for (const name of ["a", "b"]) {
    const directory = path.join(root, name);
    await mkdir(path.join(directory, "profile"), { recursive: true });
    clients.push(client(directory, `127.0.0.1:${port}`, assets));
  }
  const [a, originalB] = clients,
    [infoA, infoB] = await Promise.all(clients.map((value) => value.ready));
  assert.notEqual(infoA.pid, infoB.pid);
  assert.equal(infoA.pid, a.child.pid);
  assert.equal(infoB.pid, originalB.child.pid);
  let b = originalB;
  assert.notEqual(infoA.peerId, infoB.peerId);
  const initial = await Promise.all(
    clients.map((value) => value.command("snapshot")),
  );
  assert.ok(
    initial.every(
      (value) => value.voice.enabled === false && value.microphone === "off",
    ),
  );
  const [codeA, codeB] = await Promise.all(
    clients.map((value) => value.command("code")),
  );
  await a.command("approve", { code: codeB.code });
  await b.command("approve", { code: codeA.code });
  if (contactRecoveryMode) {
    assert.deepEqual(
      await a.command("baseline-text", { peerId: infoB.peerId }),
      { status: "acknowledged" },
    );
    await b.command("revoke", { peerId: infoA.peerId });
    await assert.rejects(
      b.command("rediscover", { peerId: infoA.peerId }),
      /CONTACT_NOT_AUTHORIZED/,
    );
    assert.equal((await a.command("stop")).windows, 0);
    assert.equal(await a.exited, 0);
    const restored = client(path.join(root, "a"), `127.0.0.1:${port}`, assets);
    clients.push(restored);
    const next = await restored.ready;
    assert.notEqual(next.pid, infoA.pid);
    assert.equal(next.pid, restored.child.pid);
    assert.equal(next.peerId, infoA.peerId);
    assert.equal(
      await restored.command("permission", { peerId: infoB.peerId }),
      true,
    );
    const beforeLookup = await restored.command("recovery-state");
    // Startup already consumes the shared public-discovery query quota (1s).
    // Let that existing quota reopen; this does not extend the search deadline.
    await delay(1100);
    const recovered = await restored.command("rediscover", {
      peerId: infoB.peerId,
    });
    if (recovered.state !== "found")
      console.log(
        JSON.stringify({
          contactRestartLookup: {
            result: recovered,
            before: beforeLookup,
            after: await restored.command("recovery-state"),
          },
        }),
      );
    assert.deepEqual(recovered, { state: "found" });
    const freshCode = await restored.command("code");
    await b.command("approve", { code: freshCode.code });
    assert.equal(
      await b.command("received-recovery-text", { peerId: infoA.peerId }),
      false,
    );
    assert.deepEqual(
      await restored.command("recovery-text", { peerId: infoB.peerId }),
      { status: "acknowledged" },
    );
    assert.equal(
      await b.command("received-recovery-text", { peerId: infoA.peerId }),
      true,
    );
    for (const value of [restored, b]) {
      const snapshot = await value.command("snapshot");
      assert.equal(snapshot.voice.enabled, false);
      assert.equal(snapshot.microphone, "off");
      assert.equal((await value.command("samples")).hosts, 0);
      assert.equal((await value.command("stop")).windows, 0);
      assert.equal(await value.exited, 0);
    }
    console.log(
      JSON.stringify({
        result: "independent-contact-recovery-passed",
        electronMainProcesses: 2,
        clientLaunches: 3,
        fullProcessRestart: true,
        identityPreserved: true,
        approvedPermissionPreserved: true,
        revokedRediscoveryDenied: true,
        authenticatedRediscovery: true,
        initialAuthenticatedPeers: beforeLookup.connection.peers,
        acknowledgedText: true,
        voice: "off",
        microphone: false,
        physicalNetwork: false,
      }),
    );
  } else {
    await a.command("enable-voice");
    await assert.rejects(
      a.command("call", { peerId: infoB.peerId }),
      (error) => {
        assert.match(error.message, /VOICE_ACTION_FAILED/);
        assert.equal(error.operation, "call");
        const diagnostic = error.diagnostics;
        assert.deepEqual(Object.keys(diagnostic.transport).sort(), [
          "inbound",
          "outgoing",
        ]);
        assert.ok(diagnostic.transport.outgoing.recent.length <= 32);
        assert.ok(
          diagnostic.transport.outgoing.recentFailures.some(
            (entry) => entry.outcome === "remote-rejected",
          ),
        );
        assert.equal(diagnostic.local.capturing, false);
        assert.equal(diagnostic.local.controlPresent, false);
        const encoded = JSON.stringify(diagnostic);
        assert.equal(encoded.includes(infoA.peerId), false);
        assert.equal(encoded.includes(infoB.peerId), false);
        assert.equal(encoded.includes("v=0"), false);
        return true;
      },
    );
    assert.equal((await a.command("samples")).hosts, 0);
    await b.command("enable-voice");
    const offering = await a.command("call", { peerId: infoB.peerId });
    const ringing = await b.command("snapshot");
    assert.equal(ringing.voice.phase, "ringing");
    assert.deepEqual(ringing.voice.quality, {
      roundTripMs: null,
      jitterMs: null,
      packetsLost: null,
    });
    assert.equal((await b.command("samples")).hosts, 0);
    await b.command("answer", { callId: offering.callId });
    await until(
      async () =>
        (
          await Promise.all(clients.map((value) => value.command("snapshot")))
        ).every((value) => value.voice.phase === "connected"),
      "connected",
    );
    await a.command("talk");
    await delay(1000);
    const forward = await b.command("samples");
    assert.equal(forward.hosts, 1);
    assert.ok(forward.rms[0] > 0.01);
    const activity = (value) => ({
      level: value.inputLevel,
      peak: value.inputClipping,
    });
    const inputActivityView = (await a.command("snapshot")).voice;
    const inputActivityUnity = activity(inputActivityView);
    if (!(inputActivityUnity.level > 0.1)) {
      const view = inputActivityView;
      console.log(
        JSON.stringify({
          nativeInputActivityFailure: {
            phase: view.phase,
            capturing: view.capturing,
            transmitting: view.transmitting,
            inputGain: view.inputGain,
            inputLevel: view.inputLevel,
            inputClipping: view.inputClipping,
          },
        }),
      );
    }
    assert.ok(inputActivityUnity.level > 0.1);
    await until(
      async () => (await b.command("snapshot")).voice.quality.jitterMs !== null,
      "native call quality",
    );
    const quality = (await b.command("snapshot")).voice.quality;
    assert.equal(typeof quality.roundTripMs, "number");
    assert.equal(typeof quality.packetsLost, "number");
    assert.equal(
      Object.keys(quality).sort().join(","),
      "jitterMs,packetsLost,roundTripMs",
    );
    await b.command("output", { volume: 0.25, muted: false });
    await delay(200);
    const quiet = await b.command("samples");
    assert.ok(
      quiet.outputRms[0] / forward.outputRms[0] > 0.18 &&
        quiet.outputRms[0] / forward.outputRms[0] < 0.32,
    );
    await b.command("output", { volume: 0.25, muted: true });
    await delay(200);
    const deafened = await b.command("samples");
    assert.ok(deafened.outputRms[0] < 0.00001 && deafened.rms[0] > 0.01);
    assert.equal((await a.command("snapshot")).voice.transmitting, true);
    assert.equal((await b.command("snapshot")).voice.capturing, true);
    await b.command("output", { volume: 1, muted: false });
    await a.command("input-gain", { gain: 0.25 });
    await delay(400);
    const quarterInput = await b.command("samples");
    const inputActivityQuarter = activity((await a.command("snapshot")).voice);
    assert.ok(
      inputActivityQuarter.level / inputActivityUnity.level > 0.18 &&
        inputActivityQuarter.level / inputActivityUnity.level < 0.32,
    );
    assert.equal(inputActivityQuarter.peak, false);
    assert.ok(
      quarterInput.rms[0] / forward.rms[0] > 0.18 &&
        quarterInput.rms[0] / forward.rms[0] < 0.32,
    );
    await a.command("input-gain", { gain: 2 });
    await delay(300);
    const inputActivityHigh = activity((await a.command("snapshot")).voice);
    assert.equal(inputActivityHigh.peak, true);
    assert.equal(inputActivityHigh.level, 1);
    await a.command("input-gain", { gain: 0 });
    await delay(400);
    const zeroInput = await b.command("samples");
    assert.ok(zeroInput.rms[0] < 0.00001);
    assert.equal((await a.command("snapshot")).voice.capturing, true);
    assert.equal((await a.command("snapshot")).voice.inputLevel, 0);
    assert.equal((await a.command("snapshot")).voice.inputClipping, false);
    await a.command("input-gain", { gain: 1 });
    await delay(400);
    assert.ok((await b.command("samples")).rms[0] > 0.1);
    await a.command("release");
    await delay(400);
    const silence = await b.command("samples");
    assert.ok(silence.rms[0] < 0.00001);
    await b.command("talk");
    await delay(1000);
    const reverse = await a.command("samples");
    assert.ok(reverse.rms[0] > 0.01);
    await b.command("release");
    await a.command("hangup");
    await until(
      async () =>
        (
          await Promise.all(clients.map((value) => value.command("samples")))
        ).every((value) => value.hosts === 0),
      "hangup cleanup",
    );
    const second = await a.command("call", { peerId: infoB.peerId });
    await b.command("answer", { callId: second.callId });
    await b.command("revoke", { peerId: infoA.peerId });
    assert.equal((await b.command("samples")).hosts, 0);
    await a.command("hangup").catch(() => {});
    assert.equal((await b.command("stop")).windows, 0);
    assert.equal(await b.exited, 0);
    b = client(path.join(root, "b"), `127.0.0.1:${port}`, assets);
    clients.push(b);
    const restarted = await b.ready;
    assert.notEqual(restarted.pid, infoB.pid);
    assert.equal(restarted.pid, b.child.pid);
    assert.equal(restarted.peerId, infoB.peerId);
    assert.equal((await b.command("snapshot")).voice.enabled, false);
    assert.equal(
      await b.command("permission", { peerId: infoA.peerId }),
      false,
    );
    const freshCodeA = await a.command("code");
    await b.command("approve", { code: freshCodeA.code });
    await b.command("enable-voice");
    const reopened = await a.command("call", { peerId: infoB.peerId });
    await b.command("answer", { callId: reopened.callId });
    await until(
      async () => (await b.command("snapshot")).voice.phase === "connected",
      "reopened protected client connected",
    );
    if (crashMode) {
      const started = performance.now();
      b.child.kill();
      await b.exited;
      console.log(
        "independent voice: peer process terminated; observing surviving call",
      );
      let previous = "";
      while (performance.now() - started < 45_000) {
        const snapshot = await a.command("snapshot"),
          sample = await a.command("samples");
        const state = JSON.stringify({
          phase: snapshot.voice.phase,
          capturing: snapshot.voice.capturing,
          hosts: sample.hosts,
        });
        if (state !== previous) {
          previous = state;
          const entry = {
            elapsedMs: Math.round(performance.now() - started),
            ...JSON.parse(state),
          };
          crashTrace.push(entry);
          console.log(JSON.stringify({ crashObservation: entry }));
        }
        if (sample.hosts === 0 && snapshot.voice.capturing === false) {
          crashCleanupMs = Math.round(performance.now() - started);
          break;
        }
        await delay(200);
      }
      assert.notEqual(
        crashCleanupMs,
        null,
        `CRASH_CAPTURE_STILL_ACTIVE ${JSON.stringify(crashTrace)}`,
      );
    } else await a.command("hangup");
    for (const name of ["a", "b"]) {
      const encryptedIdentity = await readFile(
        path.join(root, name, "network", "identity", "identity-os-v1.bin"),
      );
      assert.ok(
        encryptedIdentity.length > 0 && encryptedIdentity.length <= 16_384,
      );
      assert.equal(
        encryptedIdentity.includes(Buffer.from("PRIVATE KEY")),
        false,
      );
    }
    for (const value of [a, b]) {
      if (value.child.exitCode !== null || value.child.signalCode) continue;
      const stopped = await value.command("stop");
      assert.equal(stopped.windows, 0);
      assert.equal(await value.exited, 0);
    }
    console.log(
      JSON.stringify({
        result: "independent-voice-passed",
        electronMainProcesses: 2,
        clientLaunches: 3,
        restartedIdentityPreserved: true,
        voiceConsentReset: true,
        revokedContactPersisted: true,
        distinctProfiles: true,
        distinctAppIdentities: true,
        protectedCredentials: true,
        mutualSignedPairing: true,
        forward: forward.rms[0],
        silence: silence.rms[0],
        reverse: reverse.rms[0],
        quarterOutput: quiet.outputRms[0],
        quarterInput: quarterInput.rms[0],
        inputActivity: {
          unity: inputActivityUnity,
          quarter: inputActivityQuarter,
          high: inputActivityHigh,
        },
        zeroInput: zeroInput.rms[0],
        mutedOutput: deafened.outputRms[0],
        recipientNoCaptureBeforeAnswer: true,
        microphone: false,
        audibleOutput: false,
        crossNat: false,
        crashCleanupMs,
        crashTrace,
        quality,
      }),
    );
  }
} catch (error) {
  if (error?.diagnostics)
    console.error(
      JSON.stringify({
        nativeClientFailure: {
          operation: error.operation,
          diagnostics: error.diagnostics,
        },
      }),
    );
  throw error;
} finally {
  await Promise.all(
    clients.map(async (value) => {
      if (
        value.child.pid !== undefined &&
        value.child.exitCode === null &&
        !value.child.signalCode
      ) {
        value.child.kill();
        await value.exited;
      }
    }),
  );
  await bootstrap?.destroy({ force: true });
  await unlink(entry).catch(() => {});
  if (
    path.dirname(path.resolve(root)) === path.resolve(tmpdir()) &&
    path.basename(root).startsWith("lobbymesh-independent-voice-")
  )
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  else {
    console.error("INVALID_INDEPENDENT_CLEANUP_PATH");
    process.exitCode = 1;
  }
}
