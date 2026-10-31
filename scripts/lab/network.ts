import {
  DesktopMessaging,
  type MessagingPolicy,
} from "../../apps/desktop/src/messaging.js";
import { DesktopPairing } from "../../apps/desktop/src/pairing.js";
import { createOverlayRuntime } from "../../packages/app-dht/src/runtime.js";
import type { Identity } from "../../packages/identity/src/index.js";
import type { KeyPair } from "../../packages/public-discovery/src/hyperdht.js";
import { VoiceSignaling } from "../../packages/voice/src/signaling.js";
import { type LabOptions, labBootstrapOptions } from "./options.js";

// Ephemeral lab identities are owned by the worker, not an individual network
// instance. No Electron, physical media or credential files are involved.
export async function createLabNetwork(
  identity: Identity,
  keys: KeyPair,
  policy: MessagingPolicy,
  options: Pick<LabOptions, "network" | "bootstrap">,
  signal: AbortSignal,
) {
  let messaging: DesktopMessaging, voice: VoiceSignaling;
  const runtime = await createOverlayRuntime("", {
    credentials: { identity, transportKeys: keys },
    ...labBootstrapOptions(options),
    signal,
    directHandler: (peer, request, requestSignal) =>
      request &&
      typeof request === "object" &&
      "type" in request &&
      request.type === "voice"
        ? voice.handle(peer, request, requestSignal)
        : messaging.handle(peer, request, requestSignal),
  });
  // Synthetic signaling only; every new instance starts with voice consent off.
  voice = new VoiceSignaling(
    runtime.peerId,
    (peer, request, requestSignal) =>
      runtime.overlay.directRequest(peer, request, requestSignal),
    { authorized: policy.authorized, mediaAvailable: () => true },
  );
  messaging = new DesktopMessaging(
    runtime.peerId,
    (peer, request, requestSignal) =>
      runtime.overlay.directRequest(peer, request, requestSignal),
    policy,
    () =>
      runtime.overlay.authenticatedContacts().map((peer) => ({
        id: peer.id,
        transportKey: Buffer.from(peer.publicKey).toString("hex"),
      })),
    Date.now,
    (id, requestSignal) => runtime.recoverContact(id, requestSignal),
  );
  const pairing = new DesktopPairing(
    identity,
    runtime.transportKey,
    policy,
    (peer, requestSignal) =>
      runtime.overlay.authenticateContact(peer, requestSignal),
    () => "synthetic lab peer",
    (peer) => messaging.rememberContact(peer),
  );
  return {
    runtime,
    messaging,
    voice,
    pairing,
    start: () => runtime.start(),
    status: runtime.status,
    peerCount: () => runtime.overlay.authenticatedContacts().length,
    async stop() {
      voice.close();
      messaging.close();
      await Promise.all([pairing.close(), runtime.stop()]);
    },
  };
}
export type LabNetwork = Awaited<ReturnType<typeof createLabNetwork>>;
