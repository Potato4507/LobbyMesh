import type { ManagedNetwork } from "../../../packages/app-dht/src/lifecycle.js";
import { createOverlayRuntime } from "../../../packages/app-dht/src/runtime.js";
import { DesktopMessaging, type MessagingPolicy } from "./messaging.js";

export type ContactPolicy = MessagingPolicy;
export interface DesktopManagedNetwork extends ManagedNetwork {
  messaging: DesktopMessaging;
}
export type DesktopNetworkFactory = (
  signal: AbortSignal,
  policy: ContactPolicy,
) => Promise<ManagedNetwork>;
export async function createDesktopNetwork(
  directory: string,
  signal: AbortSignal,
  policy: ContactPolicy,
): Promise<DesktopManagedNetwork> {
  let messaging: DesktopMessaging;
  const runtime = await createOverlayRuntime(directory, {
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
  return {
    messaging,
    start: runtime.start,
    status: runtime.status,
    peerCount: () =>
      runtime.overlay
        .authenticatedContacts()
        .filter((peer) => !policy.blocked(peer.id)).length,
    async stop() {
      messaging.close();
      await runtime.stop();
    },
  };
}
