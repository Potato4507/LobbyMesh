import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import test from "node:test";
import { launchLabPeer } from "../scripts/lab/client.js";
import { parseLabCommand, parseLabOptions } from "../scripts/lab/options.js";
import { parseLabPairOptions } from "../scripts/lab/pair-options.js";
import { exerciseLabRestart } from "../scripts/lab/restart-scenario.js";
import { exerciseLabVoice } from "../scripts/lab/voice-scenario.js";

test("lab options require explicit endpoints, bounded lifetime and exact control commands", () => {
  assert.equal(
    parseLabOptions(["--bootstrap", "127.0.0.1:1234"]).durationMs,
    120000,
  );
  for (const args of [
    [],
    ["--bootstrap", "public"],
    ["--bootstrap", "127.0.0.1:0"],
    ["--bootstrap", "127.0.0.1:65536"],
    ["--bootstrap", "127.0.0.1:5", "--duration-ms", "Infinity"],
    ["--mode", "bootstrap", "--duration-ms", "999"],
    ["--mode", "bootstrap", "--mode", "peer"],
    ["--mode", "bootstrap", "--bootstrap", "127.0.0.1:2"],
    ["--mode", "bootstrap", "--unknown", "x"],
  ])
    assert.throws(() => parseLabOptions(args), /INVALID_LAB_OPTIONS/);
  assert.deepEqual(parseLabCommand({ id: 1, op: "status" }), {
    id: 1,
    op: "status",
  });
  assert.deepEqual(parseLabCommand({ id: 2, op: "restart" }), {
    id: 2,
    op: "restart",
  });
  for (const command of [
    null,
    {},
    { id: 1, op: "capture" },
    { id: 1, op: "send" },
    { id: 1, op: "status", value: "x" },
    { id: 1, op: "preview", value: "x".repeat(4097) },
    { id: -1, op: "stop" },
    { id: 1, op: "voice-enable", value: "true" },
    { id: 1, op: "voice-answer" },
    { id: 1, op: "voice-capture" },
    { id: 1, op: "restart", value: "new-identity" },
    { id: 1, op: "restart", shell: "arbitrary" },
  ])
    assert.throws(() => parseLabCommand(command), /INVALID_LAB_COMMAND/);
  assert.throws(
    () => launchLabPeer([], { target: "-oProxyCommand=bad", root: "/tmp" }),
    /INVALID_LAB_REMOTE/,
  );
});

test("pair restart scenario is explicit and preserves bounded counts and paired SSH options", () => {
  assert.equal(
    parseLabPairOptions(["--bootstrap", "127.0.0.1:1234"]).scenario,
    "baseline",
  );
  assert.equal(
    parseLabPairOptions([
      "--bootstrap",
      "127.0.0.1:1234",
      "--scenario",
      "restart",
    ]).scenario,
    "restart",
  );
  for (const tail of [
    ["--scenario", "reset-host"],
    ["--scenario", "restart", "--scenario", "baseline"],
    ["--count", "9"],
    ["--count", "Infinity"],
    ["--ssh-target", "worker"],
    ["--remote-root", "/repo"],
    ["--scenario"],
    ["--unknown", "x"],
  ])
    assert.throws(
      () => parseLabPairOptions(["--bootstrap", "127.0.0.1:1234", ...tail]),
      /INVALID_LAB_PAIR_OPTIONS/,
    );
  assert.throws(
    () => parseLabPairOptions(["--scenario", "restart"]),
    /INVALID_LAB_OPTIONS/,
  );
});

test(
  "headless independent peers authenticate signed pairing, ACK encrypted text, deny revocation and exit cleanly",
  { timeout: 60000 },
  async (t) => {
    const socket = createSocket("udp4");
    await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
    const port = socket.address().port;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    const children: ReturnType<typeof launchLabPeer>[] = [];
    t.after(async () => {
      // On early failure the peers are still alive. Retain only their existing
      // aggregate diagnostics before teardown; never invitations or peer IDs.
      const observations = await Promise.allSettled(
        children.map((p) => p.request("status")),
      );
      const diagnostics = observations.flatMap((entry) => {
        if (
          entry.status !== "fulfilled" ||
          !entry.value ||
          typeof entry.value !== "object"
        )
          return [];
        const value = entry.value as {
          diagnostics?: unknown;
          inbound?: unknown;
        };
        return value.diagnostics
          ? [{ outgoing: value.diagnostics, inbound: value.inbound }]
          : [];
      });
      if (diagnostics.length)
        t.diagnostic(JSON.stringify({ labRpc: diagnostics }));
      await Promise.all(children.reverse().map((p) => p.stop()));
    });
    const bootstrap = launchLabPeer([
      "--mode",
      "bootstrap",
      "--port",
      String(port),
    ]);
    children.push(bootstrap);
    await bootstrap.ready;
    await assert.rejects(bootstrap.request("restart"));
    const args = ["--bootstrap", `127.0.0.1:${port}`];
    const a = launchLabPeer(args);
    children.push(a);
    const infoA = await a.ready;
    const b = launchLabPeer(args);
    children.push(b);
    const infoB = await b.ready;
    assert.notEqual(infoA.peerId, infoB.peerId);
    await assert.rejects(a.request("send", "synthetic lab text"));
    const codeA = (await a.request("code")) as { code: string };
    const codeB = (await b.request("code")) as { code: string };
    const previewA = (await a.request("preview", codeB.code)) as {
      ticket: string;
    };
    const previewB = (await b.request("preview", codeA.code)) as {
      ticket: string;
    };
    await a.request("approve", previewA.ticket);
    await b.request("approve", previewB.ticket);
    const sent = (await a.request("send", "synthetic lab text")) as {
      status: string;
    };
    assert.equal(sent.status, "acknowledged");
    const received = (await b.request("history", infoA.peerId)) as {
      text: string;
      direction: string;
    }[];
    assert.equal(
      received.filter(
        (m) => m.direction === "incoming" && m.text === "synthetic lab text",
      ).length,
      1,
    );
    assert.ok(infoA.peerId);
    assert.ok(infoB.peerId);
    const restarted = await exerciseLabRestart(
      a,
      b,
      infoA.peerId,
      infoB.peerId,
    );
    assert.equal(restarted.result, "passed");
    t.diagnostic(JSON.stringify({ headlessNetworkRestart: restarted }));
    assert.deepEqual(await exerciseLabVoice(a, b, infoA.peerId), {
      result: "passed",
      syntheticSignalingOnly: true,
      physicalAudio: false,
    });
    await assert.rejects(
      a.request("send", "revoked synthetic text"),
      /LAB_COMMAND_SEND_FAILED/,
    );
    const revokedRestart = (await b.request("restart")) as {
      approved: number;
      voiceAvailable: boolean;
    };
    assert.equal(revokedRestart.approved, 0);
    assert.equal(revokedRestart.voiceAvailable, false);
    await assert.rejects(
      b.request("history", infoA.peerId),
      /LAB_COMMAND_HISTORY_FAILED/,
    );
    await assert.rejects(
      a.request("send", "revoked contact after network restart"),
      /LAB_COMMAND_SEND_FAILED/,
    );
    const denied = (await a.request("history", infoB.peerId)) as {
      status: string;
    }[];
    assert.equal(denied.at(-1)?.status, "unconfirmed");
    for (const peer of [a, b])
      assert.equal(
        ((await peer.request("status")) as { microphone: string }).microphone,
        "off",
      );
    for (const peer of [b, a, bootstrap]) {
      await peer.stop();
      assert.equal(await peer.exit, 0);
    }
  },
);
