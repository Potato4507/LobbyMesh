import assert from "node:assert/strict";
import test from "node:test";
import { parseVoiceAction } from "../packages/protocol/src/voice.js";

test("voice UI actions require exact local consent, bounded IDs and no endpoint or SDP fields", () => {
  const peerId = "a".repeat(64),
    callId = "b".repeat(32);
  for (const gain of [0, 0.25, 1, 2])
    assert.deepEqual(parseVoiceAction({ action: "input-gain", callId, gain }), {
      action: "input-gain",
      callId,
      gain,
    });
  for (const gain of [NaN, Infinity, -1, 2.01, "1", null])
    assert.throws(
      () => parseVoiceAction({ action: "input-gain", callId, gain }),
      /INVALID_VOICE_ACTION/,
    );
  for (const request of [
    { action: "input-gain", callId: null, gain: 1 },
    { action: "input-gain", callId, gain: 1, deviceId: "private" },
  ])
    assert.throws(() => parseVoiceAction(request), /INVALID_VOICE_ACTION/);
  assert.deepEqual(
    parseVoiceAction({ action: "output", callId, volume: 0.5, muted: true }),
    { action: "output", callId, volume: 0.5, muted: true },
  );
  for (const volume of [NaN, Infinity, -1, 1.1, "0.5"])
    assert.throws(
      () =>
        parseVoiceAction({ action: "output", callId, volume, muted: false }),
      /INVALID_VOICE_ACTION/,
    );
  for (const action of [
    { action: "consent", enabled: false },
    { action: "consent", enabled: true },
    { action: "call", peerId, consent: true },
    { action: "answer", callId, consent: true },
    { action: "switch-input", callId, choice: "system-default", consent: true },
    { action: "switch-input", callId, choice: "c".repeat(32), consent: true },
    { action: "hangup", callId: null },
    { action: "hangup", callId },
    { action: "talk", callId, pressed: false, start: false },
    { action: "talk", callId, pressed: true, start: true },
    { action: "talk", callId, pressed: true, start: false },
  ])
    assert.deepEqual(parseVoiceAction(action), action);
  for (const action of [
    null,
    [],
    {},
    { action: "consent", enabled: 1 },
    { action: "call", peerId, consent: false },
    { action: "call", peerId, consent: true, transportKey: peerId },
    { action: "call", peerId, consent: true, sdp: "private" },
    { action: "call", peerId: "bad", consent: true },
    { action: "answer", callId, consent: false },
    { action: "answer", callId: "bad", consent: true },
    { action: "talk", callId: null, pressed: true },
    { action: "talk", callId, pressed: 1 },
    { action: "hangup", callId: undefined },
    { action: "hangup", callId, extra: true },
    { action: "switch-input", callId, choice: "hardware-id", consent: true },
    {
      action: "switch-input",
      callId,
      choice: "system-default",
      consent: false,
    },
    {
      action: "switch-input",
      callId,
      choice: "system-default",
      consent: true,
      deviceId: "private",
    },
  ])
    assert.throws(() => parseVoiceAction(action), /INVALID_VOICE_ACTION/);
});
