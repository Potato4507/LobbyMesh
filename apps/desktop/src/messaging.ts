import { randomBytes } from "node:crypto";
import type {
  AuthenticatedPeer,
  RpcHandler,
} from "../../../packages/app-dht/src/rpc.js";
import {
  type DeliveryFailure,
  deliveryFailure,
} from "../../../packages/protocol/src/delivery.js";
import {
  type DirectContact,
  DirectMessenger,
  type ReceivedText,
  validText,
} from "../../../packages/protocol/src/direct.js";
import { ExpiryTimer } from "../../../packages/protocol/src/expiry.js";
import { parsePeerId } from "../../../packages/protocol/src/preferences.js";

export interface MessagingPolicy {
  blocked(id: string): boolean;
  authorized(id: string): boolean;
  allowed(): string[];
}
export interface MessageView {
  peerId: string;
  localId: string;
  messageId: string | null;
  direction: "incoming" | "outgoing";
  text: string;
  at: number;
  status: "received" | "sending" | "acknowledged" | "unconfirmed";
  failure: DeliveryFailure | null;
}
export interface ContactView {
  peerId: string;
  discovered: boolean;
}
export interface ContactSearchResult {
  state: "found" | "not-located" | "incomplete";
}
// Trusted backend adapter: authenticate the requested app identity before
// returning a binding. Unverified referrals or wire booleans are insufficient.
export type ContactLookup = (
  peerId: string,
  signal: AbortSignal,
) => Promise<{ contact: DirectContact | null; complete: boolean }>;
export class DesktopMessaging {
  private readonly messenger: DirectMessenger;
  private readonly conversations = new Map<string, MessageView[]>();
  private readonly incomingContacts = new Map<
    string,
    { contact: DirectContact; expiresAt: number }
  >();
  // Approved app identity with a verified transport binding, not incidental
  // inbound traffic. Memory-only; lifetime ends with permission or this network.
  private readonly approvedBindings = new Map<string, DirectContact>();
  private search: { peerId: string; controller: AbortController } | undefined;
  private lastSearchAt: number | undefined;
  private readonly pending = new Map<
    string,
    { peerId: string; controller: AbortController }
  >();
  private closed = false;
  private readonly expiry = new ExpiryTimer(() => {
    try {
      this.prune();
    } catch {
      this.close();
    }
  });
  private readonly negotiated = new Map<string, string>();
  constructor(
    self: string,
    exchange: (
      contact: DirectContact,
      request: unknown,
      signal: AbortSignal,
    ) => Promise<unknown>,
    private readonly policy: MessagingPolicy,
    private readonly authenticatedContacts: () => DirectContact[],
    private readonly now = Date.now,
    private readonly lookupContact?: ContactLookup,
  ) {
    this.messenger = new DirectMessenger(self, exchange, {
      authorized: (id) => policy.authorized(id) && !policy.blocked(id),
      now,
      maxPeers: 32,
      historyLimit: 50,
      onMessage: (message) => this.received(message),
    });
  }
  private permit(peerId: string): void {
    parsePeerId(peerId);
    if (this.closed) throw new Error("MESSAGING_CLOSED");
    if (!this.policy.authorized(peerId) || this.policy.blocked(peerId))
      throw new Error("CONTACT_NOT_AUTHORIZED");
  }
  private prune(): void {
    const now = this.now();
    let next = Infinity;
    for (const [peerId, messages] of this.conversations) {
      const retained = messages.filter((message) => {
        const expires = message.at + 900_000;
        if (expires <= now) return false;
        next = Math.min(next, expires);
        return true;
      });
      if (retained.length) this.conversations.set(peerId, retained);
      else this.conversations.delete(peerId);
    }
    for (const [id, value] of this.incomingContacts)
      if (
        value.expiresAt <= now ||
        !this.policy.authorized(id) ||
        this.policy.blocked(id)
      )
        this.incomingContacts.delete(id);
      else next = Math.min(next, value.expiresAt);
    for (const id of this.approvedBindings.keys())
      if (!this.policy.authorized(id) || this.policy.blocked(id))
        this.approvedBindings.delete(id);
    this.expiry.schedule(next, now);
  }
  private reserve(peerId: string): MessageView[] {
    this.prune();
    let messages = this.conversations.get(peerId);
    if (!messages) {
      if (this.conversations.size >= 32) throw new Error("CONVERSATION_QUOTA");
      messages = [];
      this.conversations.set(peerId, messages);
    }
    return messages;
  }
  private append(peerId: string, message: MessageView): void {
    const messages = this.reserve(peerId);
    messages.push(message);
    if (messages.length > 50) messages.shift();
    this.expiry.include(message.at + 900_000, this.now());
  }
  private received(message: ReceivedText): void {
    const value = message.envelope;
    this.append(value.from, {
      peerId: value.from,
      localId: `${value.from}:${value.id}`,
      messageId: value.id,
      direction: "incoming",
      text: value.text,
      at: message.receivedAt,
      status: "received",
      failure: null,
    });
  }
  readonly handle: RpcHandler = async (
    peer: AuthenticatedPeer,
    request,
    signal,
  ) => {
    this.permit(peer.id);
    this.prune();
    if (
      !this.incomingContacts.has(peer.id) &&
      this.incomingContacts.size >= 256
    )
      throw new Error("CONTACT_QUOTA");
    if (
      request &&
      typeof request === "object" &&
      "type" in request &&
      request.type === "text"
    )
      this.reserve(peer.id);
    const result = await this.messenger.handle(peer, request, signal);
    // Only authenticated, locally permitted requests can supply a reply transport.
    if (
      !this.closed &&
      this.policy.authorized(peer.id) &&
      !this.policy.blocked(peer.id)
    ) {
      const now = this.now(),
        expiresAt = now + 120_000;
      this.incomingContacts.set(peer.id, {
        contact: { id: peer.id, transportKey: peer.transportKey },
        expiresAt,
      });
      this.expiry.include(expiresAt, now);
    }
    return result;
  };
  contacts(): ContactView[] {
    if (this.closed) return [];
    this.prune();
    const known = new Set(
      this.authenticatedContacts().map((contact) => contact.id),
    );
    for (const id of this.incomingContacts.keys()) known.add(id);
    for (const id of this.approvedBindings.keys()) known.add(id);
    return this.policy
      .allowed()
      .filter((id) => this.policy.authorized(id) && !this.policy.blocked(id))
      .slice(0, 256)
      .map((peerId) => ({ peerId, discovered: known.has(peerId) }));
  }
  rememberContact(contact: { id: string; transportKey: string }): void {
    this.permit(parsePeerId(contact.id));
    if (
      typeof contact.transportKey !== "string" ||
      !/^[a-f0-9]{64}$/.test(contact.transportKey)
    )
      throw new Error("INVALID_CONTACT");
    this.prune();
    if (
      !this.approvedBindings.has(contact.id) &&
      this.approvedBindings.size >= 256
    )
      throw new Error("CONTACT_QUOTA");
    this.approvedBindings.set(contact.id, {
      id: contact.id,
      transportKey: contact.transportKey,
    });
  }
  history(peerId: string): MessageView[] {
    this.permit(peerId);
    this.prune();
    return (this.conversations.get(peerId) ?? []).map((message) => ({
      ...message,
      failure: message.failure ? { ...message.failure } : null,
    }));
  }
  async send(
    peerId: string,
    text: unknown,
  ): Promise<{ id: string; attempts: number; status: "acknowledged" }> {
    this.permit(peerId);
    if (!validText(text)) throw new Error("INVALID_TEXT");
    if (this.pending.size >= 16) throw new Error("SEND_QUEUE_QUOTA");
    this.prune();
    let contact: DirectContact | undefined;
    try {
      contact = this.resolveContact(peerId);
    } catch (error) {
      if (
        !this.lookupContact ||
        !(error instanceof Error) ||
        error.message !== "CONTACT_NOT_DISCOVERED"
      )
        throw error;
    }
    const localId = randomBytes(16).toString("hex"),
      controller = new AbortController();
    const message: MessageView = {
      peerId,
      localId,
      messageId: null,
      direction: "outgoing",
      text,
      at: this.now(),
      status: "sending",
      failure: null,
    };
    this.append(peerId, message);
    this.pending.set(localId, { peerId, controller });
    let stage: DeliveryFailure["stage"] = "connection";
    try {
      if (!contact) {
        // Lookup belongs to this explicit send. Clear/cancel/permission changes
        // end it before any protocol request can carry the draft to the peer.
        const result = await this.rediscover(peerId, controller.signal);
        if (controller.signal.aborted)
          throw new Error("CONTACT_SEARCH_CANCELED");
        this.permit(peerId);
        if (result.state !== "found") throw new Error("CONTACT_NOT_DISCOVERED");
        contact = this.resolveContact(peerId);
      }
      if (this.negotiated.get(peerId) !== contact.transportKey) {
        await this.messenger.negotiate(contact, controller.signal);
        await this.messenger.heartbeat(contact, controller.signal);
        this.permit(peerId);
        this.negotiated.set(peerId, contact.transportKey);
      }
      stage = "delivery";
      const result = await this.messenger.sendText(
        contact,
        text,
        controller.signal,
      );
      message.status = "acknowledged";
      message.messageId = result.id;
      return result;
    } catch (error) {
      message.status = "unconfirmed";
      message.failure = deliveryFailure(
        error,
        stage,
        controller.signal.aborted,
        controller.signal.reason === "permission-changed" ||
          (error instanceof Error &&
            error.message === "CONTACT_NOT_AUTHORIZED"),
      );
      throw new Error("DELIVERY_UNCONFIRMED");
    } finally {
      this.pending.delete(localId);
    }
  }
  // Trusted main-process consumers only; transport endpoints never enter UI IPC.
  resolveContact(peerId: string): DirectContact {
    this.permit(peerId);
    this.prune();
    const contact =
      this.authenticatedContacts().find(
        (candidate) => candidate.id === peerId,
      ) ??
      this.incomingContacts.get(peerId)?.contact ??
      this.approvedBindings.get(peerId);
    if (!contact) throw new Error("CONTACT_NOT_DISCOVERED");
    return { ...contact };
  }
  async rediscover(
    peerId: string,
    signal?: AbortSignal,
  ): Promise<ContactSearchResult> {
    this.permit(peerId);
    if (signal?.aborted) throw new Error("CONTACT_SEARCH_CANCELED");
    const lookup = this.lookupContact;
    if (!lookup) throw new Error("CONTACT_SEARCH_UNAVAILABLE");
    if (this.search) throw new Error("CONTACT_SEARCH_BUSY");
    const now = this.now();
    if (
      this.lastSearchAt !== undefined &&
      now >= this.lastSearchAt &&
      now - this.lastSearchAt < 5000
    )
      throw new Error("CONTACT_SEARCH_RATE_LIMIT");
    this.lastSearchAt = now;
    const owner = { peerId, controller: new AbortController() };
    this.search = owner;
    let settled = false,
      returned = false;
    const release = () => {
      if (settled && returned && this.search === owner) this.search = undefined;
    };
    const work = Promise.resolve().then(() => {
      if (owner.controller.signal.aborted || this.closed)
        throw new Error("CONTACT_SEARCH_CANCELED");
      this.permit(peerId);
      return lookup(peerId, owner.controller.signal);
    });
    void work.then(
      () => {
        settled = true;
        release();
      },
      () => {
        settled = true;
        release();
      },
    );
    let rejectAbort: (error: Error) => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () =>
      rejectAbort(
        new Error(
          owner.controller.signal.reason === "timeout"
            ? "CONTACT_SEARCH_TIMEOUT"
            : "CONTACT_SEARCH_CANCELED",
        ),
      );
    owner.controller.signal.addEventListener("abort", onAbort, { once: true });
    // Attach only after acquiring the search slot: a busy caller must never
    // acquire cancellation rights over another caller's lookup.
    const cancelOwner = () => owner.controller.abort("canceled");
    signal?.addEventListener("abort", cancelOwner, { once: true });
    const timer = setTimeout(() => owner.controller.abort("timeout"), 5000);
    try {
      const result = await Promise.race([work, aborted]);
      if (owner.controller.signal.aborted || this.closed)
        throw new Error("CONTACT_SEARCH_CANCELED");
      this.permit(peerId);
      if (
        !result ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        Object.keys(result).sort().join(",") !== "complete,contact" ||
        typeof result.complete !== "boolean"
      )
        throw new Error("CONTACT_SEARCH_INVALID_RESULT");
      if (result.contact === null)
        return { state: result.complete ? "not-located" : "incomplete" };
      const contact = result.contact;
      if (
        !contact ||
        typeof contact !== "object" ||
        Array.isArray(contact) ||
        Object.keys(contact).sort().join(",") !== "id,transportKey" ||
        contact.id !== peerId ||
        typeof contact.transportKey !== "string" ||
        !/^[a-f0-9]{64}$/.test(contact.transportKey)
      )
        throw new Error("CONTACT_SEARCH_INVALID_RESULT");
      this.rememberContact(contact);
      return { state: "found" };
    } catch (error) {
      if (owner.controller.signal.reason === "timeout")
        return { state: "incomplete" };
      if (owner.controller.signal.aborted || this.closed)
        throw new Error("CONTACT_SEARCH_CANCELED");
      if (
        error instanceof Error &&
        ["CONTACT_NOT_AUTHORIZED", "CONTACT_SEARCH_INVALID_RESULT"].includes(
          error.message,
        )
      )
        throw error;
      return { state: "incomplete" };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancelOwner);
      owner.controller.signal.removeEventListener("abort", onAbort);
      owner.controller.abort();
      returned = true;
      release();
    }
  }
  policyChanged(peerId: string): void {
    if (this.policy.authorized(peerId) && !this.policy.blocked(peerId)) return;
    if (this.search?.peerId === peerId) this.search.controller.abort();
    for (const value of this.pending.values())
      if (value.peerId === peerId) value.controller.abort("permission-changed");
    this.incomingContacts.delete(peerId);
    this.approvedBindings.delete(peerId);
    this.negotiated.delete(peerId);
    if (this.policy.blocked(peerId)) {
      this.conversations.delete(peerId);
      this.messenger.clearHistory(peerId);
    }
    this.prune();
  }
  cancel(peerId: string, localId: string): boolean {
    this.permit(peerId);
    if (typeof localId !== "string" || !/^[a-f0-9]{32}$/.test(localId))
      throw new Error("INVALID_MESSAGE_CANCEL");
    const pending = this.pending.get(localId);
    if (
      !pending ||
      pending.peerId !== peerId ||
      pending.controller.signal.aborted
    )
      return false;
    pending.controller.abort("canceled");
    return true;
  }
  clear(peerId: string): void {
    this.permit(peerId);
    for (const value of this.pending.values())
      if (value.peerId === peerId) value.controller.abort();
    this.conversations.delete(peerId);
    this.messenger.clearHistory(peerId);
    this.prune();
  }
  close(): void {
    this.search?.controller.abort();
    this.expiry.close();
    this.closed = true;
    for (const value of this.pending.values()) value.controller.abort();
    this.pending.clear();
    this.messenger.close();
    this.conversations.clear();
    this.incomingContacts.clear();
    this.approvedBindings.clear();
    this.negotiated.clear();
  }
}
