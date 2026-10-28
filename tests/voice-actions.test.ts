import assert from "node:assert/strict";
import test from "node:test";
import { parseVoiceAction } from "../packages/protocol/src/voice.js";

test("voice UI actions require exact local consent, bounded IDs and no endpoint or SDP fields", () => {
  const peerId = "a".repeat(64),
    callId = "b".repeat(32);
  for (const action of [
    { action: "consent", enabled: false },
    { action: "consent", enabled: true },
    { action: "call", peerId, consent: true },
    { action: "answer", callId, consent: true },
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
  ])
    assert.throws(() => parseVoiceAction(action), /INVALID_VOICE_ACTION/);
});
