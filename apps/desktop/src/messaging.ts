import { randomBytes } from "node:crypto";
import type {
  AuthenticatedPeer,
  RpcHandler,
} from "../../../packages/app-dht/src/rpc.js";
import {
  type DirectContact,
  DirectMessenger,
  type ReceivedText,
  validText,
} from "../../../packages/protocol/src/direct.js";
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
}
export interface ContactView {
  peerId: string;
  discovered: boolean;
}
export class DesktopMessaging {
  private readonly messenger: DirectMessenger;
  private readonly conversations = new Map<string, MessageView[]>();
  private readonly incomingContacts = new Map<
    string,
    { contact: DirectContact; expiresAt: number }
  >();
  private readonly pending = new Map<
    string,
    { peerId: string; controller: AbortController }
  >();
  private closed = false;
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
    for (const [peerId, messages] of this.conversations) {
      const retained = messages.filter((message) => message.at + 900_000 > now);
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
    if (this.policy.authorized(peer.id) && !this.policy.blocked(peer.id))
      this.incomingContacts.set(peer.id, {
        contact: { id: peer.id, transportKey: peer.transportKey },
        expiresAt: this.now() + 120_000,
      });
    return result;
  };
  contacts(): ContactView[] {
    if (this.closed) return [];
    this.prune();
    const known = new Set(
      this.authenticatedContacts().map((contact) => contact.id),
    );
    for (const id of this.incomingContacts.keys()) known.add(id);
    return this.policy
      .allowed()
      .filter((id) => this.policy.authorized(id) && !this.policy.blocked(id))
      .slice(0, 256)
      .map((peerId) => ({ peerId, discovered: known.has(peerId) }));
  }
  rememberContact(contact: { id: string; transportKey: string }): void {
    this.permit(parsePeerId(contact.id));
    if (!/^[a-f0-9]{64}$/.test(contact.transportKey))
      throw new Error("INVALID_CONTACT");
    this.prune();
    if (
      !this.incomingContacts.has(contact.id) &&
      this.incomingContacts.size >= 256
    )
      throw new Error("CONTACT_QUOTA");
    this.incomingContacts.set(contact.id, {
      contact: { ...contact },
      expiresAt: this.now() + 120_000,
    });
  }
  history(peerId: string): MessageView[] {
    this.permit(peerId);
    this.prune();
    return (this.conversations.get(peerId) ?? []).map((message) => ({
      ...message,
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
    const contact = this.resolveContact(peerId);
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
    };
    this.append(peerId, message);
    this.pending.set(localId, { peerId, controller });
    try {
      if (this.negotiated.get(peerId) !== contact.transportKey) {
        await this.messenger.negotiate(contact, controller.signal);
        await this.messenger.heartbeat(contact, controller.signal);
        this.permit(peerId);
        this.negotiated.set(peerId, contact.transportKey);
      }
      const result = await this.messenger.sendText(
        contact,
        text,
        controller.signal,
      );
      message.status = "acknowledged";
      message.messageId = result.id;
      return result;
    } catch {
      message.status = "unconfirmed";
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
      ) ?? this.incomingContacts.get(peerId)?.contact;
    if (!contact) throw new Error("CONTACT_NOT_DISCOVERED");
    return { ...contact };
  }
  policyChanged(peerId: string): void {
    if (this.policy.authorized(peerId) && !this.policy.blocked(peerId)) return;
    for (const value of this.pending.values())
      if (value.peerId === peerId) value.controller.abort();
    this.incomingContacts.delete(peerId);
    this.negotiated.delete(peerId);
  }
  clear(peerId: string): void {
    this.permit(peerId);
    for (const value of this.pending.values())
      if (value.peerId === peerId) value.controller.abort();
    this.conversations.delete(peerId);
    this.messenger.forget(peerId);
  }
  close(): void {
    this.closed = true;
    for (const value of this.pending.values()) value.controller.abort();
    this.pending.clear();
    this.messenger.close();
    this.conversations.clear();
    this.incomingContacts.clear();
    this.negotiated.clear();
  }
}
