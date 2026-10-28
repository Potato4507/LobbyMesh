import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Explicit opt-in command only. Not part of pnpm test; uses public HyperDHT bootstrap.
const children = [];
function participant() {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(
        new URL("../tests/fixtures/runtime-process.ts", import.meta.url),
      ),
      "public",
    ],
    { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true },
  );
  let sequence = 0,
    diagnostic = "";
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    child.on("message", (message) => {
      if (message.ready) {
        resolve(message);
        return;
      }
      const operation = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) operation?.reject(new Error(message.error));
      else operation?.resolve(message.result);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      const error = new Error(`PUBLIC_PARTICIPANT_EXIT ${code}: ${diagnostic}`);
      reject(error);
      for (const operation of pending.values()) operation.reject(error);
    });
  });
  child.stderr.on("data", (chunk) => {
    diagnostic = (diagnostic + String(chunk)).slice(-8192);
  });
  const value = {
    child,
    ready,
    command(op, args = {}) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        pending.set(id, { resolve, reject });
        child.send({ id, op, ...args });
      });
    },
  };
  children.push(value);
  return value;
}
let timer;
try {
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("PUBLIC_PAIR_TIMEOUT_75000MS")),
      75_000,
    );
  });
  await Promise.race([
    (async () => {
      const a = participant(),
        infoA = await a.ready;
      const b = participant(),
        infoB = await b.ready;
      assert.ok(
        (await b.command("contacts")).includes(infoA.id),
        "second app must discover first through public bootstrap",
      );
      assert.ok(
        (await a.command("contacts")).includes(infoB.id),
        "first app must authenticate second",
      );
      const key = "ef".repeat(32);
      const replication = await a.command("put", { key });
      assert.equal(replication.failures, 0);
      assert.ok(replication.replicas >= 1);
      const result = await b.command("lookup", { key });
      assert.ok(
        result.records.some(
          (record) =>
            record.author === infoA.id &&
            record.content === "automatic bootstrap",
        ),
      );
      assert.equal(result.routing.failures, 0);
      assert.equal(result.routing.state, "exhausted");
      console.log(
        JSON.stringify({
          state: "PUBLIC_PAIR_PASSED",
          publicBootstrap: true,
          processes: 2,
          authenticated: true,
          signedRecordRead: true,
          crossNat: false,
          roblox: false,
        }),
      );
      await b.command("stop");
      await a.command("stop");
    })(),
    deadline,
  ]);
} finally {
  clearTimeout(timer);
  await Promise.all(
    children.map(async ({ child }) => {
      if (child.exitCode !== null || child.signalCode) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    }),
  );
}
