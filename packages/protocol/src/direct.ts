import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AuthenticatedPeer, RpcHandler } from "../../app-dht/src/rpc.js";

export const DIRECT_NAMESPACE = "companion/direct/v1";
export interface DirectContact {
  id: string;
  transportKey: string;
}
export interface TextEnvelope {
  namespace: typeof DIRECT_NAMESPACE;
  version: 1;
  type: "text";
  id: string;
  from: string;
  to: string;
  senderEpoch: string;
  seq: number;
  createdAt: number;
  text: string;
}
export interface ReceivedText {
  envelope: TextEnvelope;
  receivedAt: number;
}
const hex = (value: unknown, size = 64): value is string =>
  typeof value === "string" && new RegExp(`^[a-f0-9]{${size}}$`).test(value);
function validText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value) <= 4096 &&
    !Array.from(value).some(
      (c) =>
        (c.charCodeAt(0) < 32 && ![9, 10, 13].includes(c.charCodeAt(0))) ||
        c.charCodeAt(0) === 127,
    )
  );
}
interface Inbox {
  history: ReceivedText[];
  seen: Map<string, { digest: string; expiresAt: number }>;
  window: number;
  count: number;
}
// Direct transactions share audited Noise RPC, but require independent local contact permission.
// Session matching never authorizes a conversation on its own.
export class DirectMessenger {
  private readonly inboxes = new Map<string, Inbox>();
  private readonly senderEpoch = randomBytes(16).toString("hex");
  private sequence = 0;
  private pending = 0;
  private readonly controller = new AbortController();
  constructor(
    private readonly self: string,
    private readonly transact: (
      contact: DirectContact,
      request: unknown,
      signal: AbortSignal,
    ) => Promise<unknown>,
    private readonly options: {
      authorized?: (id: string) => boolean;
      now?: () => number;
      maxPeers?: number;
      historyLimit?: number;
      dedupeTtlMs?: number;
      requestTimeoutMs?: number;
      onMessage?: (message: ReceivedText) => void;
      retryDelay?: (attempt: number, signal: AbortSignal) => Promise<void>;
    } = {},
  ) {
    if (!hex(self)) throw new Error("INVALID_PEER_ID");
    this.options = { ...options };
    if (
      (options.dedupeTtlMs ?? 60_000) < 10_000 ||
      !Number.isSafeInteger(options.requestTimeoutMs ?? 2000) ||
      (options.requestTimeoutMs ?? 2000) < 1 ||
      (options.requestTimeoutMs ?? 2000) > 5000
    )
      throw new Error("INVALID_DIRECT_LIMITS");
    for (const [value, max] of [
      [options.maxPeers ?? 100, 100],
      [options.historyLimit ?? 100, 200],
      [options.dedupeTtlMs ?? 60_000, 120_000],
    ])
      if (
        !Number.isSafeInteger(value) ||
        (value ?? 0) < 1 ||
        (value ?? 0) > (max ?? 0)
      )
        throw new Error("INVALID_DIRECT_LIMITS");
  }
  private permit(id: string): void {
    if (this.controller.signal.aborted) throw new Error("MESSENGER_CLOSED");
    if (!hex(id) || id === this.self || this.options.authorized?.(id) !== true)
      throw new Error("CONTACT_NOT_AUTHORIZED");
  }
  private now(): number {
    const now = (this.options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_TIME");
    return now;
  }
  private prune(now: number): void {
    for (const [id, inbox] of this.inboxes) {
      for (const [key, value] of inbox.seen)
        if (value.expiresAt <= now) inbox.seen.delete(key);
      inbox.history = inbox.history.filter((m) => m.receivedAt + 900_000 > now);
      if (!inbox.history.length && !inbox.seen.size) this.inboxes.delete(id);
    }
  }
  readonly handle: RpcHandler = async (
    peer: AuthenticatedPeer,
    request,
    signal,
  ) => {
    this.permit(peer.id);
    if (signal.aborted) throw new Error("RPC_ABORTED");
    const value = request as
      | TextEnvelope
      | { namespace?: unknown; version?: unknown; type?: unknown }
      | null;
    if (!value || value.namespace !== DIRECT_NAMESPACE || value.version !== 1)
      throw new Error("INCOMPATIBLE_DIRECT_PROTOCOL");
    if (value.type === "hello")
      return {
        namespace: DIRECT_NAMESPACE,
        version: 1,
        features: ["text-v1"],
        peerId: this.self,
      };
    if (value.type === "ping")
      return { namespace: DIRECT_NAMESPACE, version: 1, type: "pong" };
    if (value.type !== "text") throw new Error("INVALID_DIRECT_REQUEST");
    const envelope = value as TextEnvelope,
      now = this.now();
    if (
      !hex(envelope.id, 32) ||
      !hex(envelope.senderEpoch, 32) ||
      envelope.from !== peer.id ||
      envelope.to !== this.self ||
      !Number.isSafeInteger(envelope.seq) ||
      envelope.seq < 0 ||
      !Number.isSafeInteger(envelope.createdAt) ||
      envelope.createdAt > now + 30_000 ||
      envelope.createdAt <= now - 120_000 ||
      !validText(envelope.text)
    )
      throw new Error("INVALID_TEXT_ENVELOPE");
    const message: TextEnvelope = {
      namespace: DIRECT_NAMESPACE,
      version: 1,
      type: "text",
      id: envelope.id,
      from: peer.id,
      to: this.self,
      senderEpoch: envelope.senderEpoch,
      seq: envelope.seq,
      createdAt: envelope.createdAt,
      text: envelope.text,
    };
    this.prune(now);
    let inbox = this.inboxes.get(peer.id);
    if (!inbox) {
      if (this.inboxes.size >= (this.options.maxPeers ?? 100))
        throw new Error("PEER_QUOTA");
      inbox = { history: [], seen: new Map(), window: now, count: 0 };
      this.inboxes.set(peer.id, inbox);
    }
    const digest = createHash("sha256")
      .update(JSON.stringify(message))
      .digest("hex");
    const previous = inbox.seen.get(message.id);
    if (previous && previous.digest !== digest)
      throw new Error("MESSAGE_ID_CONFLICT");
    if (!previous) {
      if (inbox.seen.size >= 4096) throw new Error("DEDUPE_QUOTA");
      if (now - inbox.window >= 1000) {
        inbox.window = now;
        inbox.count = 0;
      }
      if (++inbox.count > 20) throw new Error("MESSAGE_RATE_LIMIT");
      inbox.seen.set(message.id, {
        digest,
        expiresAt: Math.max(
          now + (this.options.dedupeTtlMs ?? 60_000),
          message.createdAt + 120_001,
        ),
      });
      const received = { envelope: message, receivedAt: now };
      inbox.history.push(received);
      if (inbox.history.length > (this.options.historyLimit ?? 100))
        inbox.history.shift();
      try {
        this.options.onMessage?.({ envelope: { ...message }, receivedAt: now });
      } catch {
        /* Retained inbox is authoritative even if UI notification fails. */
      }
    }
    return {
      namespace: DIRECT_NAMESPACE,
      version: 1,
      type: "ack",
      id: message.id,
    };
  };
  private contact(contact: DirectContact): void {
    if (!hex(contact.transportKey)) throw new Error("INVALID_TRANSPORT_KEY");
    this.permit(contact.id);
  }
  private async exchange(
    contact: DirectContact,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    const combined = AbortSignal.any([
      controller.signal,
      this.controller.signal,
      ...(signal ? [signal] : []),
    ]);
    let rejectDeadline: (error: Error) => void = () => {};
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const abort = () => rejectDeadline(new Error("DIRECT_ABORTED"));
    combined.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      rejectDeadline(new Error("DIRECT_TIMEOUT"));
      controller.abort();
    }, this.options.requestTimeoutMs ?? 2000);
    try {
      if (combined.aborted) throw new Error("DIRECT_ABORTED");
      return await Promise.race([
        deadline,
        this.transact(contact, request, combined),
      ]);
    } finally {
      clearTimeout(timer);
      combined.removeEventListener("abort", abort);
      controller.abort();
    }
  }
  async negotiate(contact: DirectContact, signal?: AbortSignal): Promise<void> {
    this.contact(contact);
    const result = (await this.exchange(
      contact,
      { namespace: DIRECT_NAMESPACE, version: 1, type: "hello" },
      signal,
    )) as {
      namespace?: unknown;
      version?: unknown;
      peerId?: unknown;
      features?: unknown;
    } | null;
    if (
      !result ||
      result.namespace !== DIRECT_NAMESPACE ||
      result.version !== 1 ||
      result.peerId !== contact.id ||
      !Array.isArray(result.features) ||
      !result.features.includes("text-v1")
    )
      throw new Error("INCOMPATIBLE_DIRECT_PROTOCOL");
  }
  async heartbeat(contact: DirectContact, signal?: AbortSignal): Promise<void> {
    this.contact(contact);
    const response = (await this.exchange(
      contact,
      { namespace: DIRECT_NAMESPACE, version: 1, type: "ping" },
      signal,
    )) as { namespace?: unknown; version?: unknown; type?: unknown } | null;
    if (
      response?.namespace !== DIRECT_NAMESPACE ||
      response.version !== 1 ||
      response.type !== "pong"
    )
      throw new Error("INVALID_HEARTBEAT");
  }
  async sendText(
    contact: DirectContact,
    text: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; attempts: number; status: "acknowledged" }> {
    this.contact(contact);
    if (!validText(text)) throw new Error("INVALID_TEXT");
    if (this.pending >= 32) throw new Error("SEND_QUEUE_QUOTA");
    if (!Number.isSafeInteger(this.sequence + 1))
      throw new Error("SEQUENCE_EXHAUSTED");
    const envelope: TextEnvelope = {
      namespace: DIRECT_NAMESPACE,
      version: 1,
      type: "text",
      id: randomBytes(16).toString("hex"),
      from: this.self,
      to: contact.id,
      senderEpoch: this.senderEpoch,
      seq: this.sequence++,
      createdAt: this.now(),
      text,
    };
    const combined = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal;
    this.pending++;
    try {
      for (let attempt = 1; ; attempt++) {
        this.contact(contact);
        if (combined.aborted) throw new Error("SEND_ABORTED");
        let result: unknown;
        try {
          result = await this.exchange(contact, envelope, combined);
        } catch (error) {
          if (
            attempt >= 3 ||
            combined.aborted ||
            (error instanceof Error && error.message === "REMOTE_RPC_REJECTED")
          )
            throw error;
          if (this.options.retryDelay)
            await this.options.retryDelay(attempt, combined);
          else await delay(100 * attempt, undefined, { signal: combined });
          continue;
        }
        const ack = result as {
          namespace?: unknown;
          version?: unknown;
          type?: unknown;
          id?: unknown;
        } | null;
        if (
          ack?.namespace !== DIRECT_NAMESPACE ||
          ack.version !== 1 ||
          ack.type !== "ack" ||
          ack.id !== envelope.id
        )
          throw new Error("INVALID_ACK");
        return { id: envelope.id, attempts: attempt, status: "acknowledged" };
      }
    } finally {
      this.pending--;
    }
  }
  history(peerId: string): ReceivedText[] {
    this.permit(peerId);
    this.prune(this.now());
    return (this.inboxes.get(peerId)?.history ?? []).map((m) => ({
      envelope: { ...m.envelope },
      receivedAt: m.receivedAt,
    }));
  }
  forget(peerId: string): void {
    this.inboxes.delete(peerId);
  }
  close(): void {
    this.controller.abort();
    this.inboxes.clear();
  }
}
