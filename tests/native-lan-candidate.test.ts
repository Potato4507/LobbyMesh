import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { compileFunction } from "node:vm";
import { nativeLanCandidate } from "../scripts/native-lan-candidate.js";

const require = createRequire(import.meta.url);
const file = path.join(
  path.dirname(require.resolve("hyperdht/package.json")),
  "lib/server.js",
);
const source = readFileSync(file);
function load(source: Buffer) {
  const module = { exports: {} as unknown };
  compileFunction(source.toString(), ["require", "module", "exports"], {
    filename: file,
  })(createRequire(file), module, module.exports);
  return module.exports as {
    prototype: {
      _onpeerholepunch(
        this: object,
        request: unknown,
        context: unknown,
      ): Promise<unknown>;
    };
  };
}
const changed = nativeLanCandidate(source);
const upstream = load(source),
  candidate = load(changed);
const { FIREWALL, ERROR } = require(
  path.join(path.dirname(file), "constants.js"),
);

async function trial(
  Server: typeof candidate,
  changes: Record<string, unknown> = {},
  remoteError = ERROR.NONE,
  punching = false,
  stable = false,
  denyPunch = false,
) {
  let aborts = 0;
  const aborted = Symbol("aborted");
  const payload = {
    error: remoteError,
    firewall: FIREWALL.UNKNOWN,
    round: 0,
    punching,
    addresses: [],
    remoteAddress: null,
    remoteToken: null,
  };
  const puncher = {
    socket: {},
    destroyed: false,
    remoteHolepunching: punching,
    nat: { firewall: FIREWALL.UNKNOWN, addresses: [], freeze() {} },
    connected: false,
    punching: false,
    updateRemote() {},
    async analyze() {
      return stable;
    },
    async punch() {
      return true;
    },
  };
  const h = {
    payload: {
      decrypt: () => payload,
      token: () => Buffer.alloc(32),
      encrypt: (value: unknown) => value,
    },
    puncher,
    replyFromPuncher: false,
    prepunching: {},
    relayToken: null,
    relayFailedAt: null,
    aborted: false,
    encryptedSocket: null,
    rawStream: { destroyed: false, connected: false },
    round: 0,
    activeHolepunchRequests: 0,
    ...changes,
  };
  const server = {
    _holepunches: [h],
    _closing: null,
    suspended: false,
    _announcer: { isRelay: () => false },
    holepunch: () => !denyPunch,
    _lobbymeshLanAbortDeferrals: 0,
    _abort() {
      aborts++;
      return aborted;
    },
  };
  const value = await Server.prototype._onpeerholepunch.call(
    server,
    {
      id: 0,
      peerAddress: { host: "127.0.0.1", port: 1234 },
      payload: Buffer.alloc(0),
    },
    { from: {}, socket: {} },
  );
  assert.equal(h.activeHolepunchRequests, 0);
  return {
    aborts,
    deferred: server._lobbymeshLanAbortDeferrals,
    value,
    aborted,
  };
}

test("candidate changes only the verified pending LAN unstable-analysis case", async () => {
  assert.equal((await trial(upstream)).aborts, 1);
  const result = await trial(candidate);
  assert.equal(result.aborts, 0);
  assert.equal(result.deferred, 1);
  assert.equal(
    (result.value as { payload: { error: number } }).payload.error,
    ERROR.NONE,
  );
  for (const changes of [
    { replyFromPuncher: true },
    { replyFromPuncher: undefined },
    { prepunching: null },
    { prepunching: undefined },
    { relayToken: Buffer.alloc(32) },
    { aborted: true },
    { encryptedSocket: {} },
    { rawStream: null },
    { rawStream: { destroyed: true, connected: false } },
    { rawStream: { destroyed: false, connected: true } },
    { rawStream: {} },
    { payload: null },
    { puncher: null },
    { puncher: { socket: null } },
  ]) {
    const result = await trial(candidate, changes);
    assert.equal(result.aborts, 1);
    assert.equal(result.deferred, 0);
    assert.equal(result.value, result.aborted);
  }
});

test("candidate preserves remote errors, explicit holepunch denial and stable analysis", async () => {
  assert.equal((await trial(candidate, {}, ERROR.ABORTED)).aborts, 1);
  assert.equal(
    (await trial(candidate, {}, ERROR.NONE, true, false, true)).aborts,
    1,
  );
  for (const Server of [upstream, candidate]) {
    const result = await trial(Server, {}, ERROR.NONE, false, true);
    assert.equal(result.aborts, 0);
    assert.equal(result.deferred, 0);
  }
});

test("candidate rejects different or already patched source", () => {
  assert.throws(
    () => nativeLanCandidate(Buffer.from("different source")),
    /SOURCE_MISMATCH/,
  );
  assert.throws(
    () => nativeLanCandidate(nativeLanCandidate(source)),
    /SOURCE_MISMATCH/,
  );
});
