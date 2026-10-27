import assert from "node:assert/strict";
import test from "node:test";
import {
  FrameChannel,
  MAX_FRAME_BYTES,
  requestRpc,
  serveRpc,
} from "../packages/app-dht/src/rpc.js";
import {
  createIdentity,
  type Identity,
} from "../packages/identity/src/index.js";

import { pair } from "./fixtures/noise-pair.js";

test("RPC mutually authenticates before dispatch and pins expected app identity", async () => {
  const a = createIdentity(),
    b = createIdentity();
  const [client, server] = pair();
  const serving = serveRpc(server, b, async (peer, request) => {
    assert.equal(peer.id, a.peerId);
    assert.equal(peer.transportKey, client.publicKey.toString("hex"));
    return { echo: request };
  });
  const result = await requestRpc(client, a, "ping", {
    expectedPeerId: b.peerId,
  });
  assert.equal(result.peer.id, b.peerId);
  assert.deepEqual(result.result, { echo: "ping" });
  await serving;
  const [c, s] = pair();
  const rejected = serveRpc(s, b, async () => {
    assert.fail("must not dispatch");
  }).catch(() => {});
  await assert.rejects(
    requestRpc(c, a, null, { expectedPeerId: a.peerId }),
    /PEER_ID_MISMATCH/,
  );
  await rejected;
});
test("forged signatures, identity substitution and signatures replayed across Noise sessions fail", async () => {
  const a = createIdentity(),
    b = createIdentity();
  let signature: Buffer = Buffer.alloc(64);
  const capturing: Identity = {
    ...a,
    sign(data) {
      signature = a.sign(data);
      return signature;
    },
  };
  const [c, s] = pair();
  await Promise.all([
    requestRpc(c, capturing, null),
    serveRpc(s, b, async () => null),
  ]);
  for (const bad of [
    { ...a, sign: () => Buffer.alloc(64) },
    { ...a, sign: () => signature },
    { ...a, publicKey: b.publicKey },
  ]) {
    const [client, server] = pair();
    let dispatched = false;
    const serving = serveRpc(server, b, async () => {
      dispatched = true;
    }).catch(() => {});
    await assert.rejects(requestRpc(client, bad, null));
    await serving;
    assert.equal(dispatched, false);
  }
});
test("framing rejects advertised oversize, malformed JSON, floods and supports fragmentation", async () => {
  for (const bytes of [
    Buffer.from([0, 1, 0, 0]),
    Buffer.from([0, 0, 0, 1, 0xff]),
    Buffer.concat(
      Array.from({ length: 5 }, () => Buffer.from([0, 0, 0, 1, 49])),
    ),
  ]) {
    const [a, b] = pair();
    const channel = new FrameChannel(b);
    const read = channel.read();
    a.write(bytes, () => {});
    if (bytes.length < 10) await assert.rejects(read);
    else {
      await read;
      await assert.rejects(channel.read(), /QUOTA/);
    }
    channel.dispose();
    a.destroy();
    b.destroy();
  }
  const [a, b] = pair();
  const channel = new FrameChannel(b);
  const read = channel.read();
  for (const byte of [0, 0, 0, 4, 110, 117, 108, 108])
    a.write(Buffer.from([byte]), () => {});
  assert.equal(await read, null);
  await assert.rejects(channel.write("x".repeat(MAX_FRAME_BYTES)), /TOO_LARGE/);
  channel.dispose();
  a.destroy();
  b.destroy();
});
test("protocol negotiation fails closed, deadlines and cancellation bound stalled peers", async () => {
  const a = createIdentity();
  const [c, s] = pair();
  const channel = new FrameChannel(s);
  const rejection = requestRpc(c, a, null);
  await channel.read();
  await channel.write({ version: 2 });
  await assert.rejects(rejection, /INCOMPATIBLE_PROTOCOL/);
  channel.dispose();
  s.destroy();
  const [client, server] = pair();
  await assert.rejects(
    requestRpc(client, a, null, { timeoutMs: 20 }),
    /RPC_TIMEOUT/,
  );
  server.destroy();
  const [abortClient, abortServer] = pair();
  const controller = new AbortController();
  const pending = requestRpc(abortClient, a, null, {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, /RPC_ABORTED/);
  abortServer.destroy();
});
test("handler errors stay private and stalled handlers observe cancellation", async () => {
  const [c, s] = pair();
  await Promise.all([
    assert.rejects(
      requestRpc(c, createIdentity(), null),
      /^Error: REMOTE_RPC_REJECTED$/,
    ),
    serveRpc(s, createIdentity(), async () => {
      throw new Error("private detail");
    }),
  ]);
  const [client, server] = pair();
  let aborted = false;
  const serving = serveRpc(
    server,
    createIdentity(),
    async (_peer, _request, signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      await new Promise(() => {});
    },
    30,
  );
  await Promise.all([
    assert.rejects(serving, /RPC_TIMEOUT/),
    assert.rejects(requestRpc(client, createIdentity(), null)),
  ]);
  assert.ok(aborted);
});
