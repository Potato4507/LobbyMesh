import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createSocket } from "node:dgram";
import test from "node:test";
import { promisify } from "node:util";
import { controlLabPeer, launchLabPeer } from "../scripts/lab/client.js";

test("native LAN probe rejects public and malformed bootstrap before loading a network", async () => {
  for (const args of [
    [],
    ["--bootstrap", "8.8.8.8:1234"],
    ["--bootstrap", "127.0.0.1:0"],
    ["--bootstrap", "127.0.0.1:1234", "--unsafe"],
  ])
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        ["scripts/native-lan-probe.mjs", ...args],
        { timeout: 5000 },
      ),
      /PRIVATE_NATIVE_BOOTSTRAP_REQUIRED/,
    );
});

test("native LAN probe identifies its transport role, rejects arbitrary trials and confirms teardown", async (t) => {
  const socket = createSocket("udp4");
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const bootstrap = launchLabPeer([
    "--mode",
    "bootstrap",
    "--port",
    String(port),
  ]);
  t.after(async () => bootstrap.stop());
  await bootstrap.ready;
  const probe = controlLabPeer(
    spawn(
      process.execPath,
      ["scripts/native-lan-probe.mjs", "--bootstrap", `127.0.0.1:${port}`],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    ),
  );
  t.after(async () => probe.stop());
  const info = await probe.ready;
  assert.equal(info.role, "native-probe");
  assert.match(info.transportKey ?? "", /^[a-f0-9]{64}$/);
  assert.equal(info.peerId, undefined);
  await assert.rejects(
    probe.request(
      "send",
      JSON.stringify({ key: "untrusted", reusableSocket: true }),
    ),
    /LAB_COMMAND_SEND_FAILED/,
  );
  assert.deepEqual(await probe.request("status"), {
    hyperdht: "6.35.0",
    active: 0,
    accepted: 0,
    replies: 0,
    invalid: 0,
  });
  await probe.stop();
  assert.equal(await probe.exit, 0);
});
