import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { controlLabPeer } from "../scripts/lab/client.js";

function fixture(source: string) {
  return controlLabPeer(
    spawn(process.execPath, ["-e", source], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    }),
  );
}
const ready = `console.log(JSON.stringify({ready:true,role:'bootstrap'}));`;

test("lab process spawn failure settles readiness, pending work and exit without claiming cleanup", async () => {
  const peer = controlLabPeer(
    spawn(`lobbymesh-nonexistent-executable-${process.pid}`, [], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    }),
  );
  await assert.rejects(peer.ready, /LAB_PROCESS_EXIT/);
  assert.notEqual(await peer.exit, 0);
  await assert.rejects(peer.request("status"), /LAB_CLIENT_UNAVAILABLE/);
  await assert.rejects(peer.stop(), /LAB_CLEANUP_UNCONFIRMED/);
});

test("lab control rejects malformed readiness and excess fields before accepting remote identity", async () => {
  for (const reply of [
    null,
    { ready: true, role: "peer", peerId: "unverified" },
    { ready: true, role: "bootstrap", privateData: "discard" },
    { ready: true, role: "unknown" },
  ]) {
    const peer = fixture(
      `console.log(${JSON.stringify(JSON.stringify(reply))});setInterval(()=>{},1000)`,
    );
    await assert.rejects(peer.ready, /LAB_PROCESS_EXIT/);
    await peer.exit;
    await assert.rejects(peer.stop(), /LAB_CLEANUP_UNCONFIRMED/);
  }
});

test("lab control rejects malformed command replies and settles pending requests", async () => {
  const peer = fixture(
    `${ready}process.stdin.once('data',()=>console.log('null'));setInterval(()=>{},1000)`,
  );
  await peer.ready;
  await assert.rejects(peer.request("status"), /LAB_COMMAND_STATUS_FAILED/);
  await peer.exit;
  await assert.rejects(peer.stop(), /LAB_CLEANUP_UNCONFIRMED/);
});

test("lab stop is shared by concurrent callers and requires confirmation plus clean exit", async () => {
  const peer = fixture(
    `${ready}process.stdin.once('data',d=>{const r=JSON.parse(d);console.log(JSON.stringify({id:r.id,result:{stopped:true,cleanupVerified:true}}));process.exit(0)});`,
  );
  await peer.ready;
  await Promise.all([peer.stop(), peer.stop()]);
  assert.equal(await peer.exit, 0);
  await peer.stop();
});

test(
  "a confirmed stop without process exit is forcibly bounded and never passes cleanup",
  { timeout: 8000 },
  async () => {
    const peer = fixture(
      `${ready}process.on('SIGTERM',()=>{});process.stdin.once('data',d=>{const r=JSON.parse(d);console.log(JSON.stringify({id:r.id,result:{stopped:true,cleanupVerified:true}}))});setInterval(()=>{},1000)`,
    );
    await peer.ready;
    await assert.rejects(peer.stop(), /LAB_CLEANUP_TIMEOUT/);
    await peer.exit;
    await assert.rejects(peer.stop(), /LAB_CLEANUP_TIMEOUT/);
  },
);
