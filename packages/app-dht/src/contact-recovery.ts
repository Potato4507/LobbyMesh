import { searchEntrypoints } from "../../entrypoint-search/src/index.js";
import type { BootstrapDiscovery } from "../../protocol/src/index.js";
import type { Referral } from "./lookup.js";
import type { NetworkOverlay } from "./network.js";

// Explicit user-requested recovery only. Public hints seed authenticated app-DHT
// routing; they never directly supply an approved contact's binding.
export async function recoverContact(
  peerId: string,
  overlay: Pick<
    NetworkOverlay,
    "findNodes" | "authenticatedContacts" | "probe"
  >,
  discovery: Pick<BootstrapDiscovery, "findAppEntrypoints">,
  signal: AbortSignal,
): Promise<{ contact: Referral | null; complete: boolean }> {
  if (!/^[a-f0-9]{64}$/.test(peerId)) throw new Error("INVALID_CONTACT_TARGET");
  const check = () => {
    if (signal.aborted) throw new Error("CONTACT_RECOVERY_ABORTED");
  };
  const lookup = async () => {
    check();
    const result = await overlay.findNodes(peerId, undefined, signal);
    check();
    const found = result.authenticated.find((contact) => contact.id === peerId);
    return {
      contact: found
        ? { id: found.id, transportKey: found.transportKey }
        : null,
      complete: result.state === "exhausted" && result.failures === 0,
    };
  };
  check();
  if (overlay.authenticatedContacts().length) {
    const first = await lookup();
    if (first.contact) return first;
  }
  let incomplete = false;
  await searchEntrypoints(
    discovery.findAppEntrypoints(),
    (contact, searchSignal) => overlay.probe(contact, searchSignal),
    (state) => {
      if (state === "retrying") incomplete = true;
    },
    { timeoutMs: 3000, signal },
  );
  check();
  const result = await lookup();
  return { ...result, complete: result.complete && !incomplete };
}
