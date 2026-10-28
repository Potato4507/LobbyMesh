import type { ManagedNetwork } from "../../../packages/app-dht/src/lifecycle.js";
import { createOverlayRuntime } from "../../../packages/app-dht/src/runtime.js";
import { loadDesktopCredentials } from "./credentials.js";
import { DesktopMessaging, type MessagingPolicy } from "./messaging.js";
import { type DesktopSessionOptions, DesktopSessions } from "./sessions.js";

export type ContactPolicy = MessagingPolicy;
export interface DesktopManagedNetwork extends ManagedNetwork {
  messaging: DesktopMessaging;
  sessions?: DesktopSessions;
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
): Promise<DesktopManagedNetwork> {
  let messaging: DesktopMessaging;
  const credentials = await loadDesktopCredentials(directory, signal);
  const runtime = await createOverlayRuntime(directory, {
    credentials,
    signal,
    blocked: policy.blocked,
    directHandler: (peer, request, requestSignal) =>
      messaging.handle(peer, request, requestSignal),
  });
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
  return {
    messaging,
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
      messaging.close();
      // Revoke local session state immediately; remote copies expire if shutdown
      // prevents a tombstone reaching them. Never keep sockets alive for presence.
      await Promise.all([sessions?.stop(), runtime.stop()]);
    },
  };
}
