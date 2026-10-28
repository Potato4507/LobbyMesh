import type { ManagedNetwork } from "../../../packages/app-dht/src/lifecycle.js";
import { createOverlayRuntime } from "../../../packages/app-dht/src/runtime.js";
import { DirectMessenger } from "../../../packages/protocol/src/direct.js";

export interface ContactPolicy {
  blocked(id: string): boolean;
  authorized(id: string): boolean;
}
export type DesktopNetworkFactory = (
  signal: AbortSignal,
  policy: ContactPolicy,
) => Promise<ManagedNetwork>;
export async function createDesktopNetwork(
  directory: string,
  signal: AbortSignal,
  policy: ContactPolicy,
): Promise<ManagedNetwork> {
  let messenger: DirectMessenger;
  const runtime = await createOverlayRuntime(directory, {
    signal,
    blocked: policy.blocked,
    directHandler: (peer, request, requestSignal) =>
      messenger.handle(peer, request, requestSignal),
  });
  messenger = new DirectMessenger(
    runtime.peerId,
    (contact, request, requestSignal) =>
      runtime.overlay.directRequest(contact, request, requestSignal),
    { authorized: policy.authorized },
  );
  return {
    start: runtime.start,
    status: runtime.status,
    peerCount: () =>
      runtime.overlay
        .authenticatedContacts()
        .filter((peer) => !policy.blocked(peer.id)).length,
    async stop() {
      messenger.close();
      await runtime.stop();
    },
  };
}
