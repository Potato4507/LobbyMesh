import assert from "node:assert/strict";
import test from "node:test";
import {
  nativeServerAbortCallerLine,
  observeNativeServerAborts,
} from "../scripts/native-server-observation.js";

test("native abort observation preserves receiver, arguments, result and exceptions without retaining secrets", () => {
  const h = {
    payload: { secret: "private" },
    puncher: { destroyed: true, socket: "private" },
    rawStream: { connected: false },
    encryptedSocket: null,
  };
  const result = { secret: "private result" };
  const failure = new Error("private native error");
  let calls = 0;
  const server = {
    _abort(...args: unknown[]) {
      assert.equal(this, server);
      assert.equal(args[0], h);
      calls++;
      if (args[1] === "throw") throw failure;
      return result;
    },
  };
  const original = server._abort;
  const observation = observeNativeServerAborts(server);
  assert.equal(server._abort(h), result);
  assert.throws(
    () => server._abort(h, "throw"),
    (error) => error === failure,
  );
  for (let i = 0; i < 20; i++) server._abort(h);
  const snapshot = observation.snapshot();
  assert.equal(snapshot.total, 22);
  assert.equal(snapshot.recent.length, 16);
  assert.deepEqual(snapshot.recent[0], {
    callerLine: null,
    payloadPresent: true,
    puncherPresent: true,
    puncherDestroyed: true,
    puncherSocketPresent: true,
    rawStreamPresent: true,
    rawStreamConnected: false,
    encryptedStreamPresent: false,
  });
  assert.equal(JSON.stringify(snapshot).includes("private"), false);
  snapshot.recent.length = 0;
  assert.equal(observation.snapshot().recent.length, 16);
  observation.restore();
  assert.equal(server._abort, original);
  server._abort(h);
  assert.equal(calls, 23);
  assert.equal(observation.snapshot().total, 22);
});

test("abort call-site observation retains only a bounded native source line", () => {
  assert.equal(
    nativeServerAbortCallerLine(
      "at Server._onpeerholepunch (C:\\private\\node_modules\\hyperdht\\lib\\server.js:546:19)",
    ),
    546,
  );
  assert.equal(
    nativeServerAbortCallerLine(
      "at Server._onpeerholepunch (/private/node_modules/hyperdht/lib/server.js:572:18)",
    ),
    572,
  );
  for (const value of [
    undefined,
    null,
    "private message",
    "at /private/server.js:1:1",
    "at /hyperdht/lib/server.js:0:1",
    "at /hyperdht/lib/server.js:10001:1",
    "x".repeat(16385),
  ])
    assert.equal(nativeServerAbortCallerLine(value), null);
});
