import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DesktopMessaging } from "../../apps/desktop/src/messaging.js";
import { DesktopPairing } from "../../apps/desktop/src/pairing.js";
import { createOverlayRuntime } from "../../packages/app-dht/src/runtime.js";
import { signRecord } from "../../packages/security/src/records.js";
import { SessionCoordinator } from "../../packages/session/src/coordinator.js";
import { MockSessionProvider } from "../../packages/session/src/index.js";
import { SessionMembership } from "../../packages/session/src/matching.js";
import { VoiceSignaling } from "../../packages/voice/src/signaling.js";

const directory = await mkdtemp(path.join(tmpdir(), "lobbymesh-runtime-"));
let messenger: DesktopMessaging;
let voice: VoiceSignaling;
const authorized = new Set<string>();
const runtime = await createOverlayRuntime(directory, {
  ...(process.argv[2] === "public"
    ? {}
    : { bootstrap: [process.argv[2] ?? ""] }),
  directHandler: (peer, request, signal) =>
    request &&
    typeof request === "object" &&
    "type" in request &&
    request.type === "voice"
      ? voice.handle(peer, request, signal)
      : messenger.handle(peer, request, signal),
});
voice = new VoiceSignaling(
  runtime.peerId,
  (contact, request, signal) =>
    runtime.overlay.directRequest(contact, request, signal),
  { authorized: (id) => authorized.has(id), mediaAvailable: () => true },
);
messenger = new DesktopMessaging(
  runtime.peerId,
  (contact, request, signal) =>
    runtime.overlay.directRequest(contact, request, signal),
  {
    authorized: (id) => authorized.has(id),
    blocked: () => false,
    allowed: () => [...authorized],
  },
  () =>
    runtime.overlay.authenticatedContacts().map((peer) => ({
      id: peer.id,
      transportKey: Buffer.from(peer.publicKey).toString("hex"),
    })),
);
await runtime.start();
const provider = new MockSessionProvider();
const pairing = new DesktopPairing(
  runtime.identity,
  runtime.transportKey,
  {
    authorized: (id) => authorized.has(id),
    blocked: () => false,
    allowed: () => [...authorized],
  },
  (contact, signal) => runtime.overlay.authenticateContact(contact, signal),
  () => "synthetic fixture",
  (contact) => messenger.rememberContact(contact),
);
const membership = new SessionMembership(runtime.identity, runtime.overlay, {
  transportKey: runtime.transportKey,
  displayName: "synthetic fixture",
});
const sessions = new SessionCoordinator(provider, membership);
await sessions.start();
process.send?.({ ready: true, id: runtime.peerId, key: runtime.transportKey });
process.on(
  "message",
  (message: {
    id: number;
    op: string;
    key: string;
    room?: string;
    peerId?: string;
    text?: string;
    code?: string;
    ticket?: string;
    callId?: string;
  }) => {
    void (async () => {
      switch (message.op) {
        case "voice-enable":
          voice.setConsent(true);
          return voice.status();
        case "voice-offer":
          return voice.offer(
            { id: message.peerId ?? "", transportKey: message.key },
            "synthetic SDP offer, no media",
          );
        case "voice-answer":
          await voice.answer(
            message.callId ?? "",
            "synthetic SDP answer, no media",
          );
          return voice.status();
        case "voice-ice":
          await voice.ice(message.callId ?? "", {
            candidate: "synthetic candidate, no media",
            sdpMid: "0",
            sdpMLineIndex: 0,
          });
          return true;
        case "voice-hangup":
          await voice.hangup(message.callId ?? "");
          return voice.status();
        case "voice-status":
          return voice.status();
        case "voice-events":
          return voice.drainEvents();
        case "pairing-code":
          return pairing.create();
        case "pairing-preview":
          return pairing.preview(message.code);
        case "pairing-approve":
          await pairing.approve(message.ticket, async (id, guard) => {
            if (!guard()) throw new Error("canceled");
            authorized.add(id);
          });
          return true;
        case "diagnostics":
          return runtime.overlay.diagnostics();
        case "direct-allow":
          authorized.add(message.peerId ?? "");
          return true;
        case "direct-deny":
          authorized.delete(message.peerId ?? "");
          voice.policyChanged();
          messenger.policyChanged(message.peerId ?? "");
          return true;
        case "direct-history":
          return messenger.history(message.peerId ?? "");
        case "direct-send": {
          return messenger.send(
            message.peerId ?? "",
            message.text ?? "synthetic direct message",
          );
        }
        case "session":
          provider.set({
            universeId: "1",
            placeId: "2",
            jobId: message.room ?? "fixture",
            evidenceSource: "test",
            verification: "mock",
          });
          await sessions.setConsent(true);
          return sessions.status();
        case "matches": {
          const session = await provider.current();
          return session ? membership.find(session, true) : [];
        }
        case "leave-session":
          provider.set(null);
          await sessions.settled();
          return sessions.status();
        case "put":
          return runtime.overlay.put(
            message.key,
            signRecord(
              runtime.identity,
              message.key,
              "automatic bootstrap",
              0,
              Date.now(),
            ),
          );
        case "lookup":
          return runtime.overlay.lookup(message.key);
        case "contacts":
          return runtime.overlay.authenticatedContacts().map((c) => c.id);
        case "stop":
          voice.close();
          await pairing.close();
          messenger.close();
          await sessions.stop();
          await runtime.stop();
          await rm(directory, { recursive: true, force: true });
          return "stopped";
        default:
          throw new Error("UNKNOWN_COMMAND");
      }
    })()
      .then((result) => {
        process.send?.({ id: message.id, result });
        if (message.op === "stop") process.disconnect();
      })
      .catch((error: Error) =>
        process.send?.({ id: message.id, error: error.message }),
      );
  },
);
