import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import { fileURLToPath } from "node:url";
import DHT from "hyperdht";

// Local-only diagnostic, deliberately outside the application and default suite.
// Fixed nonsecret echo bytes; ephemeral transport keys; no app authentication,
// profiles, public bootstrap, user messages or production configuration changes.
const request = Buffer.from("lobbymesh-native-handoff/v1");
const response = Buffer.from("lobbymesh-native-reply/v1");
const mode = process.argv[2];
const noLan = process.argv.includes("--no-lan");
const reusableSocket = process.argv.includes("--reusable-socket");
const fullyBootstrapped = process.argv.includes("--fully-bootstrapped");
if (mode === "--bootstrap") {
  const socket = createSocket("udp4");
  await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const node = DHT.bootstrapper(port, "127.0.0.1");
  await node.ready();
  process.send({ ready: true, address: `127.0.0.1:${port}` });
  process.once("message", () => {
    void node.destroy({ force: true }).then(() => process.disconnect());
  });
} else if (mode === "--worker") {
  const address = process.argv[3];
  if (!/^127\.0\.0\.1:\d{1,5}$/.test(address))
    throw new Error("LOCAL_BOOTSTRAP_REQUIRED");
  const node = new DHT({ bootstrap: [address] });
  const keys = DHT.keyPair();
  const streams = new Set();
  const counts = { accepted: 0, replies: 0, invalid: 0 };
  function track(stream) {
    streams.add(stream);
    stream.on("error", () => {});
    const timer = setTimeout(() => stream.destroy(), 3000);
    stream.once("close", () => {
      clearTimeout(timer);
      streams.delete(stream);
    });
    return stream;
  }
  const server = node.createServer((incoming) => {
    counts.accepted++;
    const stream = track(incoming);
    let received = Buffer.alloc(0),
      replied = false;
    stream.on("data", (chunk) => {
      if (replied || received.length + chunk.length > request.length) {
        counts.invalid++;
        stream.destroy();
        return;
      }
      received = Buffer.concat([received, chunk]);
      if (received.length !== request.length) return;
      if (!received.equals(request)) {
        counts.invalid++;
        stream.destroy();
        return;
      }
      replied = true;
      counts.replies++;
      stream.end(response);
    });
  });
  await server.listen(keys);
  if (fullyBootstrapped) await node.fullyBootstrapped();
  process.send({ ready: true, key: keys.publicKey.toString("hex") });
  let running = false;
  async function trial(key) {
    const started = performance.now();
    let phase = "transport";
    const stream = track(
      node.connect(Buffer.from(key, "hex"), {
        keyPair: keys,
        ...(noLan ? { localConnection: false } : {}),
        ...(reusableSocket ? { reusableSocket: true } : {}),
      }),
    );
    return new Promise((resolve) => {
      let settled = false,
        received = Buffer.alloc(0);
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          outcome,
          phase,
          elapsedMs: Math.round(performance.now() - started),
        });
        stream.destroy();
      };
      const timer = setTimeout(() => finish("timeout"), 1500);
      stream.once("connect", () => {
        phase = "reply";
      });
      stream.once("error", () => finish("transport-error"));
      stream.once("close", () => finish("closed"));
      stream.on("data", (chunk) => {
        if (received.length + chunk.length > response.length)
          return finish("invalid");
        received = Buffer.concat([received, chunk]);
        if (received.length === response.length)
          finish(received.equals(response) ? "success" : "invalid");
      });
      stream.write(request);
    });
  }
  process.on("message", (message) => {
    void (async () => {
      if (message.op === "stop") {
        for (const stream of streams) stream.destroy();
        await node.destroy({ force: true });
        process.send({
          id: message.id,
          result: { active: streams.size, ...counts },
        });
        process.disconnect();
        return;
      }
      if (message.op === "snapshot") {
        process.send({
          id: message.id,
          result: { active: streams.size, ...counts },
        });
        return;
      }
      if (
        running ||
        message.op !== "trial" ||
        !/^[a-f0-9]{64}$/.test(message.key)
      )
        throw new Error("INVALID_LOCAL_TRIAL");
      running = true;
      try {
        const results = [];
        for (let n = 0; n < 8; n++) results.push(await trial(message.key));
        process.send({ id: message.id, result: results });
      } finally {
        running = false;
      }
    })().catch(() =>
      process.send({ id: message.id, error: "LOCAL_TRIAL_FAILED" }),
    );
  });
} else {
  const children = [];
  function participant(args) {
    const child = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), ...args],
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
      },
    );
    const pending = new Map();
    let sequence = 0;
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const exited = new Promise((resolve) => {
      child.once("error", () => {
        rejectReady(new Error("LOCAL_PROCESS_START_FAILED"));
        resolve();
      });
      child.once("close", (code) => {
        rejectReady(new Error("LOCAL_PROCESS_CLOSED"));
        for (const value of pending.values())
          value.reject(new Error("LOCAL_PROCESS_CLOSED"));
        pending.clear();
        resolve(code);
      });
    });
    child.on("message", (message) => {
      if (message.ready) return resolveReady(message);
      const value = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) value?.reject(new Error("LOCAL_TRIAL_FAILED"));
      else value?.resolve(message.result);
    });
    const command = (op, extra = {}) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        child.send({ id, op, ...extra }, (error) => {
          if (!error) return;
          pending.delete(id);
          reject(new Error("LOCAL_PROCESS_SEND_FAILED"));
        });
      });
    const value = { child, ready, exited, command };
    children.push(value);
    return value;
  }
  const deadline = setTimeout(() => {
    for (const value of children) value.child.kill();
  }, 90_000);
  try {
    const bootstrap = participant(["--bootstrap"]);
    const address = (await bootstrap.ready).address;
    const flags = [
      ...(noLan ? ["--no-lan"] : []),
      ...(reusableSocket ? ["--reusable-socket"] : []),
      ...(fullyBootstrapped ? ["--fully-bootstrapped"] : []),
    ];
    const a = participant(["--worker", address, ...flags]);
    const infoA = await a.ready;
    const b = participant(["--worker", address, ...flags]);
    const infoB = await b.ready;
    assert.notEqual(a.child.pid, b.child.pid);
    const oneWay = [
      await a.command("trial", { key: infoB.key }),
      await b.command("trial", { key: infoA.key }),
    ];
    const bidirectional = await Promise.all([
      a.command("trial", { key: infoB.key }),
      b.command("trial", { key: infoA.key }),
    ]);
    for (const group of [...oneWay, ...bidirectional]) {
      assert.equal(group.length, 8);
      assert.ok(
        group.every((value) =>
          ["success", "timeout", "closed", "transport-error"].includes(
            value.outcome,
          ),
        ),
      );
    }
    const snapshots = await Promise.all([
      a.command("snapshot"),
      b.command("snapshot"),
    ]);
    assert.ok(snapshots.every((value) => value.invalid === 0));
    const attempts = [...oneWay, ...bidirectional].flat();
    const observation = {
      result: "native-handoff-observed",
      localBootstrap: true,
      independentProcesses: true,
      appRpc: false,
      localConnection: !noLan,
      reusableSocket,
      fullyBootstrapped,
      attempts: attempts.length,
      successes: attempts.filter((value) => value.outcome === "success").length,
      oneWay,
      bidirectional,
      snapshots,
    };
    for (const value of [a, b]) {
      const stopped = await value.command("stop");
      assert.equal(stopped.active, 0);
      assert.equal(await value.exited, 0);
    }
    bootstrap.child.send({ op: "stop" });
    assert.equal(await bootstrap.exited, 0);
    console.log(JSON.stringify({ ...observation, cleanupVerified: true }));
  } finally {
    for (const value of children) {
      if (
        value.child.pid &&
        value.child.exitCode === null &&
        value.child.signalCode === null
      )
        value.child.kill();
      await value.exited;
    }
    clearTimeout(deadline);
  }
}
