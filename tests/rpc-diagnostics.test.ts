import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  RpcDiagnostics,
  rpcOutcome,
} from "../packages/app-dht/src/diagnostics.js";
import { NetworkOverlay } from "../packages/app-dht/src/network.js";
import {
  type RpcPhase,
  requestRpc,
  serveRpc,
} from "../packages/app-dht/src/rpc.js";
import { createIdentity } from "../packages/identity/src/index.js";
import { pair } from "./fixtures/noise-pair.js";

test("RPC diagnostics keep bounded redacted copies and retain failures after successful traffic", () => {
  const metrics = new RpcDiagnostics();
  metrics.record({
    operation: "put",
    outcome: "timeout",
    phase: "response",
    queueMs: -1,
    transactionMs: Infinity,
  });
  for (let n = 0; n < 100; n++)
    metrics.record({
      operation: "find-node",
      outcome: "success",
      phase: "complete",
      queueMs: 12.3456,
      transactionMs: 4,
    });
  const first = metrics.snapshot(0);
  assert.equal(first.recent.length, 32);
  assert.equal(first.recentFailures.length, 1);
  assert.equal(first.total, 101);
  assert.equal(first.outcomes.timeout, 1);
  first.recent.length = 0;
  first.recentFailures.length = 0;
  first.outcomes.success = 0;
  assert.equal(metrics.snapshot(0).recent.length, 32);
  assert.equal(metrics.snapshot(0).recentFailures.length, 1);
  assert.equal(metrics.snapshot(0).outcomes.success, 100);
  for (let n = 0; n < 100; n++)
    metrics.record({
      operation: "direct",
      outcome: "transport",
      phase: "connect",
      queueMs: 0,
      transactionMs: 999_999,
    });
  assert.equal(metrics.snapshot(0).recentFailures.length, 16);
  assert.equal(
    rpcOutcome(new Error("IP-address / secret server ID / private payload")),
    "transport",
  );
  assert.equal(JSON.stringify(metrics.snapshot(0)).includes("secret"), false);
});

test("RPC phase observations distinguish pre-authentication from response stalls and cannot change wire behavior", async () => {
  const a = createIdentity(),
    b = createIdentity(),
    phases: RpcPhase[] = [];
  const [client, server] = pair();
  await Promise.all([
    requestRpc(
      client,
      a,
      { secret: "payload" },
      {
        onPhase(phase) {
          phases.push(phase);
          throw new Error("observer failed");
        },
      },
    ),
    serveRpc(server, b, async () => "result"),
  ]);
  assert.deepEqual(phases, [
    "hello",
    "proof",
    "request",
    "response",
    "complete",
  ]);
  const [stalled, unused] = pair();
  const beforeAuth: RpcPhase[] = [];
  await assert.rejects(
    requestRpc(stalled, a, null, {
      timeoutMs: 10,
      onPhase: (phase) => beforeAuth.push(phase),
    }),
    /TIMEOUT/,
  );
  unused.destroy();
  assert.deepEqual(beforeAuth, ["hello"]);
  const [pending, responder] = pair();
  const afterAuth: RpcPhase[] = [];
  const serving = serveRpc(
    responder,
    b,
    async () => new Promise(() => {}),
    200,
  ).catch(() => {});
  await assert.rejects(
    requestRpc(pending, a, null, {
      timeoutMs: 100,
      onPhase: (phase) => afterAuth.push(phase),
    }),
    /TIMEOUT/,
  );
  await serving;
  assert.equal(afterAuth.at(-1), "response");
});

test("network metrics distinguish canceled queued work from opened transactions without storing untrusted error text", async () => {
  const identity = createIdentity(),
    remote = createIdentity(),
    held = new AbortController(),
    queued = new AbortController();
  const servers: ReturnType<typeof pair>[1][] = [];
  let calls = 0;
  const overlay = new NetworkOverlay(identity, {
    connect() {
      calls++;
      const [client, server] = pair();
      servers.push(server);
      return client;
    },
  });
  await overlay.start();
  const contact = { id: remote.peerId, transportKey: "ab".repeat(32) };
  const first = overlay
    .directRequest(contact, { secret: "do-not-log" }, held.signal)
    .catch(() => {});
  await setImmediate();
  const second = overlay
    .directRequest(contact, { secret: "do-not-log" }, queued.signal)
    .catch(() => {});
  queued.abort();
  await second;
  assert.equal(overlay.diagnostics().queued, 2);
  held.abort();
  await first;
  await overlay.leave();
  for (const server of servers) server.destroy();
  assert.equal(calls, 1);
  const snapshot = overlay.diagnostics();
  assert.equal(snapshot.queued, 0);
  assert.equal(snapshot.outcomes.aborted, 2);
  assert.ok(
    snapshot.recent.some(
      (entry) => entry.phase === "queue" && entry.transactionMs === 0,
    ),
  );
  assert.ok(snapshot.recent.some((entry) => entry.phase === "hello"));
  assert.equal(JSON.stringify(snapshot).includes("do-not-log"), false);
  assert.equal(JSON.stringify(snapshot).includes(contact.id), false);
});

test("RPC setup distinguishes unopened Noise from an established transport waiting for app hello", async () => {
  const identity = createIdentity();
  for (const establish of [false, true]) {
    const [client, server] = pair();
    const hash = client.handshakeHash;
    client.handshakeHash = null;
    const phases: RpcPhase[] = [];
    const request = requestRpc(client, identity, null, {
      timeoutMs: 30,
      onPhase: (phase) => phases.push(phase),
    });
    assert.deepEqual(phases, ["transport"]);
    assert.equal(client.listenerCount("connect"), 1);
    if (establish) {
      client.handshakeHash = hash;
      client.emit("connect");
      client.emit("connect");
    }
    await assert.rejects(request, /RPC_TIMEOUT/);
    await setImmediate();
    server.destroy();
    assert.deepEqual(
      phases,
      establish ? ["transport", "hello"] : ["transport"],
    );
    assert.equal(client.listenerCount("connect"), 0);
    client.emit("connect");
    assert.deepEqual(
      phases,
      establish ? ["transport", "hello"] : ["transport"],
    );
  }
});

test("known-contact setup retries once before dispatch, retaining the failed attempt without repeating the handler", async () => {
  const identity = createIdentity(),
    remote = createIdentity();
  let connections = 0,
    dispatches = 0;
  const servers: ReturnType<typeof pair>[1][] = [],
    serving: Promise<unknown>[] = [];
  const overlay = new NetworkOverlay(
    identity,
    {
      connect() {
        connections++;
        const [client, server] = pair();
        servers.push(server);
        if (connections === 1) client.handshakeHash = null;
        if (connections > 1)
          serving.push(
            serveRpc(server, remote, async () => {
              dispatches++;
              return "accepted";
            }).catch(() => {}),
          );
        return client;
      },
    },
    { timeoutMs: 30 },
  );
  await overlay.start();
  try {
    assert.equal(
      await overlay.directRequest(
        { id: remote.peerId, transportKey: "ab".repeat(32) },
        { secret: "never-in-diagnostics" },
        new AbortController().signal,
      ),
      "accepted",
    );
    assert.equal(connections, 2);
    assert.equal(dispatches, 1);
    const view = overlay.diagnostics();
    assert.equal(view.outcomes.timeout, 1);
    assert.equal(view.outcomes.success, 1);
    assert.equal(view.recentFailures[0]?.phase, "transport");
    assert.equal(JSON.stringify(view).includes("never-in-diagnostics"), false);
  } finally {
    await overlay.leave();
    for (const server of servers) server.destroy();
    await Promise.all(serving);
  }
});

test("setup retry budget is finite and a newly blocked contact cannot open the retry socket", async () => {
  for (const blockAfterFirst of [false, true]) {
    const identity = createIdentity(),
      remote = createIdentity();
    let connections = 0;
    const servers: ReturnType<typeof pair>[1][] = [];
    const overlay = new NetworkOverlay(
      identity,
      {
        connect() {
          connections++;
          const [client, server] = pair();
          servers.push(server);
          return client;
        },
      },
      { timeoutMs: 10, blocked: () => blockAfterFirst && connections > 0 },
    );
    await overlay.start();
    const contact = { id: remote.peerId, transportKey: "ab".repeat(32) };
    overlay.routing.add({
      id: remote.peerId,
      publicKey: Buffer.from(contact.transportKey, "hex"),
      connectionHints: [],
    });
    try {
      await assert.rejects(
        overlay.directRequest(contact, {}, new AbortController().signal),
        blockAfterFirst ? /BLOCKED_PEER/ : /RPC_TIMEOUT/,
      );
      assert.equal(connections, blockAfterFirst ? 1 : 2);
      // Two failed physical setup attempts are one logical liveness failure.
      assert.equal(overlay.routing.has(remote.peerId), true);
    } finally {
      await overlay.leave();
      for (const server of servers) server.destroy();
    }
  }
});

test("identity mismatches, remote rejections and post-dispatch response timeouts never qualify for setup retry", async () => {
  for (const mode of ["impostor", "rejected", "response-timeout"] as const) {
    const identity = createIdentity(),
      remote = createIdentity(),
      impostor = createIdentity();
    let connections = 0,
      dispatches = 0;
    const serving: Promise<unknown>[] = [];
    const overlay = new NetworkOverlay(
      identity,
      {
        connect() {
          connections++;
          const [client, server] = pair();
          serving.push(
            serveRpc(
              server,
              mode === "impostor" ? impostor : remote,
              async () => {
                dispatches++;
                if (mode === "rejected") throw new Error("private reason");
                return new Promise(() => {});
              },
              100,
            ).catch(() => {}),
          );
          return client;
        },
      },
      { timeoutMs: 50 },
    );
    await overlay.start();
    try {
      await assert.rejects(
        overlay.directRequest(
          { id: remote.peerId, transportKey: "ab".repeat(32) },
          {},
          new AbortController().signal,
        ),
        mode === "impostor"
          ? /PEER_ID_MISMATCH/
          : mode === "rejected"
            ? /REMOTE_RPC_REJECTED/
            : /RPC_TIMEOUT/,
      );
      assert.equal(connections, 1);
      assert.equal(dispatches, mode === "impostor" ? 0 : 1);
      assert.equal(
        overlay.diagnostics().recentFailures[0]?.phase,
        mode === "impostor" ? "proof" : "response",
      );
    } finally {
      await overlay.leave();
      await Promise.all(serving);
    }
  }
});
