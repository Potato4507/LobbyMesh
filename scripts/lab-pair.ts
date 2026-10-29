import assert from "node:assert/strict";
import { launchLabPeer } from "./lab/client.js";
import { parseLabOptions } from "./lab/options.js";
import { exerciseLabVoice } from "./lab/voice-scenario.js";

// Explicit operator invocation. SSH never installs packages or changes the host.
const fields = new Map<string, string>();
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const key = args[i],
    value = args[i + 1];
  if (
    !key ||
    !["--bootstrap", "--ssh-target", "--remote-root", "--count"].includes(
      key,
    ) ||
    !value ||
    fields.has(key)
  )
    throw new Error("INVALID_LAB_PAIR_OPTIONS");
  fields.set(key, value);
}
const options = parseLabOptions([
  "--bootstrap",
  fields.get("--bootstrap") ?? "",
]);
const countText = fields.get("--count") ?? "4",
  count = Number(countText);
if (
  !/^\d+$/.test(countText) ||
  count < 1 ||
  count > 8 ||
  fields.has("--ssh-target") !== fields.has("--remote-root")
)
  throw new Error("INVALID_LAB_PAIR_OPTIONS");
const target = fields.get("--ssh-target"),
  root = fields.get("--remote-root");
const peers: ReturnType<typeof launchLabPeer>[] = [];
const latencies: number[] = [];
let succeeded = 0,
  attempted = 0,
  cleanupVerified = false,
  passed = false;
let voiceSignaling: Awaited<ReturnType<typeof exerciseLabVoice>> | null = null;
const started = performance.now();
try {
  const peerArgs = [
    "--bootstrap",
    options.bootstrap,
    "--duration-ms",
    "120000",
  ];
  const a = launchLabPeer(peerArgs);
  peers.push(a);
  const infoA = await a.ready;
  const b = launchLabPeer(
    peerArgs,
    target && root ? { target, root } : undefined,
  );
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
  voiceSignaling = await exerciseLabVoice(a, b, infoA.peerId);
  await assert.rejects(a.request("send", "revocation negative check"));
  passed = true;
} catch {
  // No raw native/SSH errors or control-channel content in exported metrics.
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
      scenario: "headless-pair-text-revocation",
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
      physicalAudio: false,
      voiceSignaling,
      actualRoblox: false,
      realExternal: false,
    }),
  );
}
