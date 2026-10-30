import assert from "node:assert/strict";
import { launchLabPeer } from "./lab/client.js";
import { parseLabPairOptions } from "./lab/pair-options.js";
import { exerciseLabRestart } from "./lab/restart-scenario.js";
import { labRemoteArguments } from "./lab/ssh.js";
import { exerciseLabVoice } from "./lab/voice-scenario.js";

// Explicit operator invocation. SSH never installs packages or changes the host.
const options = parseLabPairOptions(process.argv.slice(2));
const { count, target, root } = options;
const peers: ReturnType<typeof launchLabPeer>[] = [];
const latencies: number[] = [];
let succeeded = 0,
  attempted = 0,
  cleanupVerified = false,
  passed = false;
let failureReason: string | null = null;
let voiceSignaling: Awaited<ReturnType<typeof exerciseLabVoice>> | null = null;
let networkRestart: Awaited<ReturnType<typeof exerciseLabRestart>> | null =
  null;
const started = performance.now();
try {
  const peerArgs = [
    "--bootstrap",
    options.bootstrap,
    "--duration-ms",
    "120000",
  ];
  const remote =
    target && root
      ? { target, root, layout: options.layout, auth: options.auth }
      : undefined;
  if (remote) labRemoteArguments(remote, peerArgs);
  const a = launchLabPeer(peerArgs);
  peers.push(a);
  const infoA = await a.ready;
  const b = launchLabPeer(peerArgs, remote);
  peers.push(b);
  const infoB = await b.ready;
  assert.notEqual(infoA.peerId, infoB.peerId);
  const codeA = (await a.request("code")) as { code: string },
    codeB = (await b.request("code")) as { code: string };
  const previewA = (await a.request("preview", codeB.code)) as {
      ticket: string;
    },
    previewB = (await b.request("preview", codeA.code)) as { ticket: string };
  await a.request("approve", previewA.ticket);
  await b.request("approve", previewB.ticket);
  for (let i = 0; i < count; i++) {
    for (const peer of [a, b]) {
      attempted++;
      const at = performance.now();
      assert.equal(
        (
          (await peer.request("send", `synthetic lab message ${i}`)) as {
            status: string;
          }
        ).status,
        "acknowledged",
      );
      latencies.push(performance.now() - at);
      succeeded++;
    }
  }
  for (const [peer, id] of [
    [a, infoB.peerId],
    [b, infoA.peerId],
  ] as const) {
    const history = (await peer.request("history", id)) as {
      direction: string;
    }[];
    assert.equal(
      history.filter((m) => m.direction === "incoming").length,
      count,
    );
    assert.equal(
      ((await peer.request("status")) as { microphone: string }).microphone,
      "off",
    );
  }
  assert.ok(infoA.peerId);
  assert.ok(infoB.peerId);
  if (options.scenario === "restart")
    networkRestart = await exerciseLabRestart(a, b, infoA.peerId, infoB.peerId);
  voiceSignaling = await exerciseLabVoice(a, b, infoA.peerId);
  await assert.rejects(a.request("send", "revocation negative check"));
  passed = true;
} catch (error) {
  // No raw native/SSH errors or control-channel content in exported metrics.
  failureReason =
    error instanceof Error &&
    [
      "LAB_ASKPASS_REQUIRED",
      "INVALID_LAB_REMOTE",
      "LAB_READY_TIMEOUT",
      "LAB_PROCESS_EXIT",
      "LAB_COMMAND_TIMEOUT",
      "LAB_REMOTE_REJECTED",
      "LAB_CLIENT_UNAVAILABLE",
    ].includes(error.message)
      ? error.message
      : "LAB_RUN_FAILED";
  process.exitCode = 1;
} finally {
  const cleanup = await Promise.allSettled(
    peers.reverse().map((peer) => peer.stop()),
  );
  cleanupVerified = cleanup.every((r) => r.status === "fulfilled");
  if (!cleanupVerified) process.exitCode = 1;
  latencies.sort((a, b) => a - b);
  const percentile = (p: number) =>
    latencies.length
      ? Math.round(
          (latencies[Math.ceil(latencies.length * p) - 1] ?? 0) * 100,
        ) / 100
      : null;
  console.log(
    JSON.stringify({
      scenario:
        options.scenario === "restart"
          ? "headless-pair-text-network-restart-revocation"
          : "headless-pair-text-revocation",
      messageMetricScope: "baseline-text",
      networkRestartRequested: options.scenario === "restart",
      networkRestart,
      dateUtc: new Date().toISOString(),
      platform: process.platform,
      proofTier: target ? "REMOTE_UNCLASSIFIED" : "SAME_HOST",
      topology: target
        ? "operator-supplied SSH worker; physical separation unverified"
        : "two independent processes; explicit bootstrap",
      durationMs: Math.round(performance.now() - started),
      attempted,
      succeeded,
      p50AckMs: percentile(0.5),
      p95AckMs: percentile(0.95),
      cleanupVerified,
      result: passed && cleanupVerified ? "passed" : "failed",
      failureReason,
      physicalAudio: false,
      voiceSignaling,
      actualRoblox: false,
      realExternal: false,
    }),
  );
}
