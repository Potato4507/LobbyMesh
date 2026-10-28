import type { ManagedNetwork } from "../../../packages/app-dht/src/lifecycle.js";
import { createOverlayRuntime } from "../../../packages/app-dht/src/runtime.js";
import {
  type CallMediaFactory,
  VoiceCalls,
} from "../../../packages/voice/src/calls.js";
import { loadDesktopCredentials } from "./credentials.js";
import { DesktopMessaging, type MessagingPolicy } from "./messaging.js";
import { DesktopPairing } from "./pairing.js";
import { type DesktopSessionOptions, DesktopSessions } from "./sessions.js";

export type ContactPolicy = MessagingPolicy;
export interface DesktopManagedNetwork extends ManagedNetwork {
  messaging: DesktopMessaging;
  sessions?: DesktopSessions;
  pairing?: DesktopPairing;
  voice?: VoiceCalls;
}
export type DesktopNetworkFactory = (
  signal: AbortSignal,
  policy: ContactPolicy,
  sessions?: DesktopSessionOptions,
) => Promise<ManagedNetwork>;
export async function createDesktopNetwork(
  directory: string,
  signal: AbortSignal,
  policy: ContactPolicy,
  sessionOptions?: DesktopSessionOptions,
  createMedia?: CallMediaFactory,
): Promise<DesktopManagedNetwork> {
  let messaging: DesktopMessaging;
  let voice: VoiceCalls;
  const credentials = await loadDesktopCredentials(directory, signal);
  const runtime = await createOverlayRuntime(directory, {
    credentials,
    signal,
    blocked: policy.blocked,
    directHandler: (peer, request, requestSignal) =>
      request &&
      typeof request === "object" &&
      "type" in request &&
      request.type === "voice"
        ? voice.handle(peer, request, requestSignal)
        : messaging.handle(peer, request, requestSignal),
  });
  // Local voice consent remains off. A media host is allocated only by explicit
  // call/answer actions, never by discovery or an incoming offer.
  voice = new VoiceCalls(
    runtime.peerId,
    (contact, request, requestSignal) =>
      runtime.overlay.directRequest(contact, request, requestSignal),
    {
      authorized: (id) => policy.authorized(id) && !policy.blocked(id),
      ...(createMedia ? { createMedia } : {}),
    },
  );
  messaging = new DesktopMessaging(
    runtime.peerId,
    (contact, request, requestSignal) =>
      runtime.overlay.directRequest(contact, request, requestSignal),
    policy,
    () =>
      runtime.overlay.authenticatedContacts().map((peer) => ({
        id: peer.id,
        transportKey: Buffer.from(peer.publicKey).toString("hex"),
      })),
  );
  const sessions = sessionOptions
    ? new DesktopSessions(
        runtime.identity,
        runtime.overlay,
        runtime.transportKey,
        sessionOptions,
        policy.blocked,
      )
    : undefined;
  const pairing = new DesktopPairing(
    runtime.identity,
    runtime.transportKey,
    policy,
    (contact, signal) => runtime.overlay.authenticateContact(contact, signal),
    () => sessionOptions?.preferences().displayName ?? "LobbyMesh user",
    (contact) => messaging.rememberContact(contact),
  );
  return {
    messaging,
    pairing,
    voice,
    ...(sessions ? { sessions } : {}),
    async start() {
      const report = await runtime.start();
      // Matching has its own visible state and must not stall network startup.
      void sessions?.start().catch(() => {});
      return report;
    },
    status: runtime.status,
    peerCount: () =>
      runtime.overlay
        .authenticatedContacts()
        .filter((peer) => !policy.blocked(peer.id)).length,
    async stop() {
      const pairingStopped = pairing.close();
      voice.close();
      messaging.close();
      // Revoke local session state immediately; remote copies expire if shutdown
      // prevents a tombstone reaching them. Never keep sockets alive for presence.
      await Promise.all([pairingStopped, sessions?.stop(), runtime.stop()]);
    },
  };
}
