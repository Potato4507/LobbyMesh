import assert from "node:assert/strict";
import test from "node:test";
import { allowMediaPermission } from "../apps/desktop/src/media-permission.js";
import {
  parseMediaCommand,
  parseMediaReply,
  validMediaResult,
} from "../packages/voice/src/media-host-protocol.js";

const id = "a".repeat(32);
test("media commands and replies reject coercion, unknown fields, oversize and invalid consent", () => {
  const command = { id, op: "offer", data: true };
  assert.deepEqual(parseMediaCommand(command), command);
  assert.deepEqual(
    parseMediaCommand({ id, op: "output", data: { volume: 0.25, muted: true } })
      .data,
    { volume: 0.25, muted: true },
  );
  for (const data of [
    { volume: NaN, muted: false },
    { volume: Infinity, muted: false },
    { volume: 1.01, muted: false },
    { volume: -1, muted: false },
    { volume: "1", muted: false },
    { volume: 0.5, muted: 1 },
    { volume: 0.5, muted: true, extra: true },
  ])
    assert.throws(
      () => parseMediaCommand({ id, op: "output", data }),
      /INVALID_MEDIA_COMMAND/,
    );
  for (const value of [
    null,
    [],
    { ...command, extra: true },
    { ...command, id: BigInt("1".repeat(32)) },
    { ...command, op: "evaluate" },
    { ...command, data: false },
    { id, op: "talk", data: 1 },
    { id, op: "status", data: true },
    { id, op: "metrics", data: {} },
    { id, op: "answer", data: "é".repeat(6145) },
    { id, op: "accept-answer", data: "" },
  ])
    assert.throws(() => parseMediaCommand(value), /INVALID_MEDIA_COMMAND/);
  for (const value of [
    null,
    [],
    { id, ok: "true", data: null },
    { id, ok: true, data: null, extra: true },
    { id: BigInt("1".repeat(32)), ok: true, data: null },
  ])
    assert.throws(() => parseMediaReply(value), /INVALID_MEDIA_REPLY/);
  assert.deepEqual(parseMediaReply({ id: "ready", ok: true, data: null }), {
    id: "ready",
    ok: true,
    data: null,
  });
  assert.equal(
    validMediaResult("status", {
      phase: "reconnecting",
      capturing: true,
      transmitting: false,
      outputLevel: null,
    }),
    true,
  );
  assert.equal(
    validMediaResult("status", {
      phase: "connected",
      capturing: true,
      transmitting: false,
      outputLevel: null,
    }),
    true,
  );
  for (const outputLevel of [NaN, Infinity, -1, 1.01, "0"])
    assert.equal(
      validMediaResult("status", {
        phase: "connected",
        capturing: true,
        transmitting: false,
        outputLevel,
      }),
      false,
    );
  assert.equal(
    validMediaResult("status", {
      phase: "connected",
      capturing: true,
      transmitting: false,
      sdp: "private",
    }),
    false,
  );
  assert.equal(
    validMediaResult("metrics", {
      receivedPackets: 1,
      receivedBytes: 2,
      receivedEnergy: null,
    }),
    true,
  );
  for (const number of [-1, NaN, Infinity, 1.5])
    assert.equal(
      validMediaResult("metrics", {
        receivedPackets: number,
        receivedBytes: 2,
        receivedEnergy: null,
      }),
      false,
    );
  assert.equal(
    validMediaResult("metrics", {
      receivedPackets: 1,
      receivedBytes: 2,
      receivedEnergy: NaN,
    }),
    false,
  );
  assert.equal(validMediaResult("offer", "x".repeat(12289)), false);
});
test("microphone grant predicate requires owned local main frame and exactly audio", () => {
  const input = {
    consent: true,
    ownedContents: true,
    permission: "media",
    mainFrame: true,
    requestingUrl: "file:///trusted/media.html",
    expectedUrl: "file:///trusted/media.html",
    mediaTypes: ["audio"],
  };
  assert.equal(allowMediaPermission(input), true);
  for (const patch of [
    { consent: false },
    { ownedContents: false },
    { permission: "display-capture" },
    { mainFrame: false },
    { requestingUrl: undefined },
    { requestingUrl: "https://untrusted.example" },
    { requestingUrl: "file:///trusted/media.html#untrusted" },
    { mediaTypes: undefined },
    { mediaTypes: [] },
    { mediaTypes: ["audio", "video"] },
    { mediaTypes: ["audio", "audio"] },
    { mediaTypes: ["video"] },
    { mediaTypes: ["unknown"] },
  ])
    assert.equal(allowMediaPermission({ ...input, ...patch }), false);
});
