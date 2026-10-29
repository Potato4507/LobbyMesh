import assert from "node:assert/strict";
import type { launchLabPeer } from "./client.js";

type Peer = Pick<ReturnType<typeof launchLabPeer>, "request">;
// Explicitly synthetic SDP/ICE through production authenticated direct RPC.
// Returning success never asserts connected media or physical audio.
export async function exerciseLabVoice(a: Peer, b: Peer, peerA: string) {
  const phase = async (p: Peer, expected: string) => {
    const state = (await p.request("voice-status")) as { phase: string };
    assert.equal(state.phase, expected);
  };
  const events = async (p: Peer, op: string, callId: string) => {
    const received = (await p.request("voice-events")) as {
      op: string;
      callId: string;
    }[];
    assert.equal(received.length, 1);
    assert.equal(received[0]?.op, op);
    assert.equal(received[0]?.callId, callId);
  };
  await phase(a, "disabled");
  await phase(b, "disabled");
  await assert.rejects(a.request("voice-offer"));
  await a.request("voice-enable");
  await assert.rejects(a.request("voice-offer"));
  await phase(a, "idle");
  await phase(b, "disabled");
  await b.request("voice-enable");
  const call = (await a.request("voice-offer")) as string;
  assert.match(call, /^[a-f0-9]{32}$/);
  await phase(a, "offering");
  await phase(b, "ringing");
  await events(b, "offer", call);
  await assert.rejects(b.request("voice-answer", "0".repeat(32)));
  await phase(b, "ringing");
  await b.request("voice-answer", call);
  await events(a, "answer", call);
  for (const p of [a, b]) await phase(p, "negotiating");
  for (const [sender, receiver] of [
    [a, b],
    [b, a],
  ]) {
    assert.ok(sender && receiver);
    await sender.request("voice-ice", call);
    await events(receiver, "ice", call);
  }
  await a.request("voice-hangup", call);
  await events(b, "hangup", call);
  for (const p of [a, b]) await phase(p, "idle");
  await assert.rejects(b.request("voice-answer", call));

  // Local consent withdrawal must clear the recipient immediately.
  const withdrawn = (await a.request("voice-offer")) as string;
  await events(b, "offer", withdrawn);
  await b.request("voice-answer", withdrawn);
  await events(a, "answer", withdrawn);
  await b.request("voice-disable");
  await phase(b, "disabled");
  assert.deepEqual(await b.request("voice-events"), []);
  await assert.rejects(b.request("voice-answer", withdrawn));
  await assert.rejects(a.request("voice-ice", withdrawn));
  await phase(a, "idle");

  // Revoking a paired contact clears pending signaling and blocks another offer.
  await b.request("voice-enable");
  const revoked = (await a.request("voice-offer")) as string;
  await events(b, "offer", revoked);
  await b.request("voice-answer", revoked);
  await events(a, "answer", revoked);
  await b.request("revoke", peerA);
  await phase(b, "idle");
  assert.deepEqual(await b.request("voice-events"), []);
  await assert.rejects(b.request("voice-answer", revoked));
  await assert.rejects(a.request("voice-ice", revoked));
  await assert.rejects(a.request("voice-offer"));
  await phase(a, "idle");
  for (const p of [a, b]) {
    await p.request("voice-disable");
    await phase(p, "disabled");
    assert.equal(
      ((await p.request("status")) as { microphone: string }).microphone,
      "off",
    );
  }
  return {
    result: "passed" as const,
    syntheticSignalingOnly: true,
    physicalAudio: false,
  };
}
