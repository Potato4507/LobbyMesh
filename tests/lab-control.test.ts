import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createSocket } from "node:dgram";
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

test("production bootstrap flushes a delayed stop reply before exiting", async (t) => {
  const socket = createSocket("udp4");
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const preload = `const write=process.stdout.write.bind(process.stdout);process.stdout.write=(chunk,...args)=>{if(String(chunk).includes('"cleanupVerified":true')){setTimeout(()=>write(chunk,...args),80);return true;}return write(chunk,...args);};`;
  const peer = controlLabPeer(
    spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        `data:text/javascript,${encodeURIComponent(preload)}`,
        "scripts/lab-peer.ts",
        "--mode",
        "bootstrap",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--duration-ms",
        "10000",
      ],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    ),
  );
  t.after(async () => {
    await peer.stop().catch(() => {});
    await peer.exit;
  });
  assert.equal((await peer.ready).role, "bootstrap");
  await peer.stop();
  assert.equal(await peer.exit, 0);
});

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
    { ready: true, role: "native-probe", transportKey: "invalid" },
    {
      ready: true,
      role: "native-probe",
      transportKey: "ab".repeat(32),
      peerId: "cd".repeat(32),
    },
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

test("lab cleanup drains a final reply arriving after exit but before stdout close", async (t) => {
  // A short-lived relay preserves stdout after the launcher exits. Its write
  // callback exits the relay; the controller's close event observes pipe drain.
  const source = `${ready}
process.stdin.once('data', data => {
  const request = JSON.parse(data);
  const reply = JSON.stringify({id:request.id,result:{stopped:true,cleanupVerified:true}}) + String.fromCharCode(10);
  const relay = "setTimeout(()=>process.stdout.write(" + JSON.stringify(reply) + ",()=>process.exit(0)),80)";
  require('node:child_process').spawn(process.execPath, ['-e',relay], {
    stdio:['ignore',process.stdout,'ignore'], windowsHide:true, detached:true
  });
  process.exit(0);
});`;
  const child = spawn(process.execPath, ["-e", source], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  let exitSeen = false,
    replyAfterExit = false;
  child.once("exit", () => {
    exitSeen = true;
  });
  child.stdout.on("data", (chunk) => {
    if (String(chunk).includes('"stopped":true')) replyAfterExit = exitSeen;
  });
  const peer = controlLabPeer(child);
  t.after(async () => {
    await peer.stop().catch(() => {});
    await peer.exit;
  });
  await peer.ready;
  const processExited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  const stopped = peer.stop();
  void stopped.catch(() => {});
  await processExited;
  await assert.rejects(peer.request("status"), /LAB_CLIENT_UNAVAILABLE/);
  await stopped;
  assert.equal(replyAfterExit, true);
  assert.equal(await peer.exit, 0);
});

test("an empty error reply still rejects rather than resolving an undefined result", async (t) => {
  const peer = fixture(
    `${ready}process.stdin.on('data',d=>{const r=JSON.parse(d);console.log(JSON.stringify({id:r.id,error:''}))});`,
  );
  t.after(async () => {
    await peer.stop().catch(() => {});
    await peer.exit;
  });
  await peer.ready;
  await assert.rejects(peer.request("status"), /LAB_COMMAND_STATUS_FAILED/);
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
