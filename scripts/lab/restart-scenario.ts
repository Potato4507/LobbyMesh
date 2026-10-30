import assert from "node:assert/strict";
import type { launchLabPeer } from "./client.js";

type Peer = Pick<ReturnType<typeof launchLabPeer>, "request">;

// Two existing paired workers, after baseline text. Restarts only the remote
// worker's network instance; its process and ephemeral identity owner survive.
export async function exerciseLabRestart(
  a: Peer,
  b: Peer,
  peerA: string,
  peerB: string,
) {
  const code = (await a.request("code")) as { code: string };
  const pending = (await b.request("preview", code.code)) as { ticket: string };
  await a.request("voice-enable");
  await b.request("voice-enable");
  const previousCall = (await a.request("voice-offer")) as string;
  assert.equal(
    ((await b.request("voice-status")) as { phase: string }).phase,
    "ringing",
  );
  assert.deepEqual(await b.request("restart"), {
    networkRestarted: true,
    processRestart: false,
    identityPreserved: true,
    transportPreserved: true,
    approved: 1,
    voiceAvailable: false,
    microphone: "off",
  });
  assert.equal(
    ((await b.request("voice-status")) as { phase: string }).phase,
    "disabled",
  );
  assert.deepEqual(await b.request("voice-events"), []);
  await assert.rejects(b.request("voice-answer", previousCall));
  await assert.rejects(b.request("approve", pending.ticket));
  await a.request("voice-disable");
  assert.deepEqual(await b.request("history", peerA), []);
  for (const [sender, text] of [
    [a, "synthetic text after network restart"],
    [b, "synthetic reply after network restart"],
  ] as const)
    assert.equal(
      ((await sender.request("send", text)) as { status: string }).status,
      "acknowledged",
    );
  for (const [receiver, other, text] of [
    [b, peerA, "synthetic text after network restart"],
    [a, peerB, "synthetic reply after network restart"],
  ] as const) {
    const rows = (await receiver.request("history", other)) as {
      direction: string;
      text: string;
    }[];
    assert.equal(
      rows.filter((row) => row.direction === "incoming" && row.text === text)
        .length,
      1,
    );
    assert.equal(
      ((await receiver.request("voice-status")) as { phase: string }).phase,
      "disabled",
    );
    assert.equal(
      ((await receiver.request("status")) as { microphone: string }).microphone,
      "off",
    );
  }
  return {
    result: "passed" as const,
    networkInstanceRestart: true,
    processRestart: false,
    identityAndTransportPreserved: true,
    approvedContactsRetained: true,
    conversationReset: true,
    voiceConsentReset: true,
    pairingTicketInvalidated: true,
    acknowledgedMessages: 2,
    physicalAudio: false,
  };
}
