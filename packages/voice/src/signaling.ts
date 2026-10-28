import { createHash, randomBytes } from "node:crypto";
import type { RpcHandler } from "../../app-dht/src/rpc.js";
import {
  DIRECT_NAMESPACE,
  type DirectContact,
} from "../../protocol/src/direct.js";

const PROTOCOL = "companion/media/v1";
const hex = (v: unknown, size = 64): v is string =>
  typeof v === "string" && new RegExp(`^[a-f0-9]{${size}}$`).test(v);
type Operation = "offer" | "answer" | "ice" | "hangup";
export interface IceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}
interface Envelope {
  namespace: typeof DIRECT_NAMESPACE;
  version: 1;
  type: "voice";
  protocol: typeof PROTOCOL;
  op: Operation;
  id: string;
  from: string;
  to: string;
  callId: string;
  createdAt: number;
  data: string | IceCandidate | null;
}
export interface VoiceEvent {
  callId: string;
  peerId: string;
  op: Operation;
  data: string | IceCandidate | null;
}
interface Call {
  id: string;
  contact: DirectContact;
  phase: "offering" | "ringing" | "negotiating";
  sentIce: number;
  receivedIce: number;
  expiresAt: number;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
}
function exact(value: object, keys: string[]): boolean {
  return Object.keys(value).sort().join(",") === keys.sort().join(",");
}
function validData(op: Operation, data: unknown): boolean {
  if (op === "hangup") return data === null;
  if (op === "offer" || op === "answer")
    return (
      typeof data === "string" &&
      data.length > 0 &&
      Buffer.byteLength(data) <= 12_288
    );
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data) ||
    !exact(data, ["candidate", "sdpMid", "sdpMLineIndex"])
  )
    return false;
  const ice = data as IceCandidate;
  return (
    typeof ice.candidate === "string" &&
    Buffer.byteLength(ice.candidate) <= 2048 &&
    (ice.sdpMid === null ||
      (typeof ice.sdpMid === "string" &&
        Buffer.byteLength(ice.sdpMid) <= 256)) &&
    (ice.sdpMLineIndex === null ||
      (Number.isInteger(ice.sdpMLineIndex) &&
        ice.sdpMLineIndex >= 0 &&
        ice.sdpMLineIndex <= 65535))
  );
}

// Control only: no microphone, WebRTC connection, audio state, persistence or UI IPC.
// The future trusted media owner consumes SDP/ICE events locally, never via the DHT.
export class VoiceSignaling {
  private consent = false;
  private closed = false;
  private call: Call | undefined;
  private events: VoiceEvent[] = [];
  private pending = 0;
  private readonly lifetime = new AbortController();
  private readonly seen = new Map<
    string,
    { digest: string; expiresAt: number }
  >();
  private readonly rates = new Map<string, { at: number; count: number }>();
  private readonly callIds = new Map<string, number>();
  constructor(
    private readonly self: string,
    private readonly transact: (
      contact: DirectContact,
      request: unknown,
      signal: AbortSignal,
    ) => Promise<unknown>,
    private readonly options: {
      authorized: (id: string) => boolean;
      mediaAvailable?: () => boolean;
      now?: () => number;
      requestTimeoutMs?: number;
      negotiationTimeoutMs?: number;
    },
  ) {
    if (!hex(self)) throw new Error("INVALID_PEER_ID");
    for (const [value, max] of [
      [options.requestTimeoutMs ?? 2000, 5000],
      [options.negotiationTimeoutMs ?? 30_000, 30_000],
    ])
      if (
        !Number.isSafeInteger(value) ||
        (value ?? 0) < 1 ||
        (value ?? 0) > (max ?? 0)
      )
        throw new Error("INVALID_VOICE_LIMITS");
  }
  private now(): number {
    const now = (this.options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("INVALID_TIME");
    return now;
  }
  private available(): boolean {
    try {
      return (
        !this.closed && this.consent && this.options.mediaAvailable?.() === true
      );
    } catch {
      return false;
    }
  }
  private permitted(id: string): boolean {
    try {
      return (
        hex(id) && id !== this.self && this.options.authorized(id) === true
      );
    } catch {
      return false;
    }
  }
  private clear(): void {
    const call = this.call;
    this.call = undefined;
    this.events = [];
    if (call) {
      clearTimeout(call.timer);
      call.controller.abort();
    }
  }
  policyChanged(): void {
    if (
      !this.available() ||
      (this.call && !this.permitted(this.call.contact.id))
    )
      this.clear();
  }
  setConsent(value: boolean): void {
    this.consent = value === true && !this.closed;
    this.policyChanged();
  }
  private reconcile(): void {
    this.policyChanged();
    if (this.call && this.call.expiresAt <= this.now()) this.clear();
  }
  status(): {
    available: boolean;
    phase: "disabled" | "idle" | Call["phase"];
    peerId: string | null;
    callId: string | null;
  } {
    this.reconcile();
    return {
      available: this.available(),
      phase: this.call?.phase ?? (this.available() ? "idle" : "disabled"),
      peerId: this.call?.contact.id ?? null,
      callId: this.call?.id ?? null,
    };
  }
  drainEvents(): VoiceEvent[] {
    this.reconcile();
    const result = this.events.filter((event) => this.permitted(event.peerId));
    this.events = [];
    return result;
  }
  private requirePeer(contact: DirectContact): void {
    this.reconcile();
    if (!this.available()) throw new Error("VOICE_DISABLED");
    if (!this.permitted(contact.id) || !hex(contact.transportKey))
      throw new Error("CONTACT_NOT_AUTHORIZED");
  }
  private begin(
    contact: DirectContact,
    id: string,
    phase: Call["phase"],
  ): Call {
    if (this.call) throw new Error("VOICE_BUSY");
    const now = this.now();
    for (const [key, expiresAt] of this.callIds)
      if (expiresAt <= now) this.callIds.delete(key);
    const key = `${contact.id}:${id}`;
    if (this.callIds.has(key)) throw new Error("VOICE_CALL_REUSED");
    if (this.callIds.size >= 256) throw new Error("VOICE_CALL_QUOTA");
    this.callIds.set(key, now + 60_000);
    const controller = new AbortController();
    const call: Call = {
      id,
      contact: { ...contact },
      phase,
      controller,
      sentIce: 0,
      receivedIce: 0,
      expiresAt: this.now() + (this.options.negotiationTimeoutMs ?? 30_000),
      timer: setTimeout(() => {
        if (this.call === call) this.clear();
      }, this.options.negotiationTimeoutMs ?? 30_000),
    };
    call.timer.unref();
    this.call = call;
    return call;
  }
  private enqueue(call: Call, op: Operation, data: Envelope["data"]): void {
    if (this.events.length >= 64) {
      this.clear();
      throw new Error("VOICE_EVENT_QUOTA");
    }
    this.events.push({
      callId: call.id,
      peerId: call.contact.id,
      op,
      data: data && typeof data === "object" ? { ...data } : data,
    });
  }
  readonly handle: RpcHandler = async (peer, request, signal) => {
    this.requirePeer({ id: peer.id, transportKey: peer.transportKey });
    if (signal.aborted) throw new Error("RPC_ABORTED");
    if (
      !request ||
      typeof request !== "object" ||
      Array.isArray(request) ||
      !exact(request, [
        "namespace",
        "version",
        "type",
        "protocol",
        "op",
        "id",
        "from",
        "to",
        "callId",
        "createdAt",
        "data",
      ])
    )
      throw new Error("INVALID_VOICE_ENVELOPE");
    const value = request as Envelope,
      now = this.now();
    if (
      value.namespace !== DIRECT_NAMESPACE ||
      value.version !== 1 ||
      value.type !== "voice" ||
      value.protocol !== PROTOCOL ||
      !["offer", "answer", "ice", "hangup"].includes(value.op) ||
      !hex(value.id, 32) ||
      !hex(value.callId, 32) ||
      value.from !== peer.id ||
      value.to !== this.self ||
      !Number.isSafeInteger(value.createdAt) ||
      value.createdAt <= now - 30_000 ||
      value.createdAt > now + 5000 ||
      !validData(value.op, value.data) ||
      Buffer.byteLength(JSON.stringify(value)) > 20_480
    )
      throw new Error("INVALID_VOICE_ENVELOPE");
    for (const [id, entry] of this.seen)
      if (entry.expiresAt <= now) this.seen.delete(id);
    for (const [id, rate] of this.rates)
      if (rate.at + 10_000 <= now) this.rates.delete(id);
    let rate = this.rates.get(peer.id);
    if (!rate) {
      if (this.rates.size >= 256) throw new Error("VOICE_PEER_QUOTA");
      rate = { at: now, count: 0 };
      this.rates.set(peer.id, rate);
    }
    if (++rate.count > 90) throw new Error("VOICE_RATE_LIMIT");
    const key = `${peer.id}:${value.id}`,
      digest = createHash("sha256").update(JSON.stringify(value)).digest("hex"),
      previous = this.seen.get(key);
    if (previous && previous.digest !== digest)
      throw new Error("VOICE_ID_CONFLICT");
    const ack = { protocol: PROTOCOL, type: "ack", id: value.id };
    if (previous) return ack;
    if (this.seen.size >= 512) throw new Error("VOICE_REPLAY_QUOTA");
    let call = this.call;
    if (value.op === "offer") {
      call = this.begin(
        { id: peer.id, transportKey: peer.transportKey },
        value.callId,
        "ringing",
      );
      this.enqueue(call, value.op, value.data);
    } else {
      if (
        !call ||
        call.id !== value.callId ||
        call.contact.id !== peer.id ||
        call.contact.transportKey !== peer.transportKey
      )
        throw new Error("VOICE_CALL_MISMATCH");
      if (value.op === "hangup") {
        this.clear();
        // A bounded terminal event lets a future owner close its media transport.
        this.enqueue(call, "hangup", null);
      } else if (value.op === "answer") {
        if (call.phase !== "offering") throw new Error("VOICE_STATE_MISMATCH");
        call.phase = "negotiating";
        this.enqueue(call, value.op, value.data);
      } else {
        if (call.phase !== "negotiating")
          throw new Error("VOICE_STATE_MISMATCH");
        if (++call.receivedIce > 48) {
          this.clear();
          throw new Error("VOICE_ICE_QUOTA");
        }
        this.enqueue(call, value.op, value.data);
      }
    }
    this.seen.set(key, { digest, expiresAt: now + 60_000 });
    return ack;
  };
  private async send(
    call: Call,
    op: Operation,
    data: Envelope["data"],
    signal?: AbortSignal,
  ): Promise<void> {
    this.requirePeer(call.contact);
    if (this.pending >= 8) {
      if (this.call === call) this.clear();
      throw new Error("VOICE_SEND_QUOTA");
    }
    const envelope: Envelope = {
      namespace: DIRECT_NAMESPACE,
      version: 1,
      type: "voice",
      protocol: PROTOCOL,
      op,
      id: randomBytes(16).toString("hex"),
      from: this.self,
      to: call.contact.id,
      callId: call.id,
      createdAt: this.now(),
      data,
    };
    const controller = new AbortController(),
      combined = AbortSignal.any([
        controller.signal,
        this.lifetime.signal,
        call.controller.signal,
        ...(signal ? [signal] : []),
      ]);
    let rejectDeadline: (error: Error) => void = () => {};
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const abort = () => rejectDeadline(new Error("VOICE_ABORTED"));
    const timer = setTimeout(() => {
      rejectDeadline(new Error("VOICE_TIMEOUT"));
      controller.abort();
    }, this.options.requestTimeoutMs ?? 2000);
    combined.addEventListener("abort", abort, { once: true });
    this.pending++;
    try {
      if (combined.aborted) throw new Error("VOICE_ABORTED");
      const reply = (await Promise.race([
        deadline,
        this.transact(call.contact, envelope, combined),
      ])) as { protocol?: unknown; type?: unknown; id?: unknown } | null;
      this.requirePeer(call.contact);
      if (combined.aborted) throw new Error("VOICE_ABORTED");
      if (
        reply?.protocol !== PROTOCOL ||
        reply.type !== "ack" ||
        reply.id !== envelope.id
      )
        throw new Error("INVALID_VOICE_ACK");
    } catch (error) {
      if (this.call === call) this.clear();
      throw error;
    } finally {
      this.pending--;
      clearTimeout(timer);
      combined.removeEventListener("abort", abort);
      controller.abort();
    }
  }
  async offer(
    contact: DirectContact,
    sdp: string,
    signal?: AbortSignal,
  ): Promise<string> {
    this.requirePeer(contact);
    if (!validData("offer", sdp)) throw new Error("INVALID_VOICE_DATA");
    const call = this.begin(
      contact,
      randomBytes(16).toString("hex"),
      "offering",
    );
    await this.send(call, "offer", sdp, signal);
    return call.id;
  }
  async answer(
    callId: string,
    sdp: string,
    signal?: AbortSignal,
  ): Promise<void> {
    this.reconcile();
    const call = this.call;
    if (!call || call.id !== callId || call.phase !== "ringing")
      throw new Error("VOICE_STATE_MISMATCH");
    if (!validData("answer", sdp)) throw new Error("INVALID_VOICE_DATA");
    call.phase = "negotiating";
    await this.send(call, "answer", sdp, signal);
  }
  async ice(
    callId: string,
    candidate: IceCandidate,
    signal?: AbortSignal,
  ): Promise<void> {
    this.reconcile();
    const call = this.call;
    if (!call || call.id !== callId || call.phase !== "negotiating")
      throw new Error("VOICE_STATE_MISMATCH");
    if (!validData("ice", candidate)) throw new Error("INVALID_VOICE_DATA");
    if (++call.sentIce > 48) {
      this.clear();
      throw new Error("VOICE_ICE_QUOTA");
    }
    await this.send(call, "ice", { ...candidate }, signal);
  }
  async hangup(callId: string): Promise<void> {
    this.reconcile();
    const call = this.call;
    if (!call || call.id !== callId) return;
    this.clear();
    // Local cancellation is immediate; a fresh controller bounds the terminal send.
    await this.send(
      { ...call, controller: new AbortController() },
      "hangup",
      null,
    );
  }
  close(): void {
    this.closed = true;
    this.consent = false;
    this.lifetime.abort();
    this.clear();
    this.seen.clear();
    this.rates.clear();
    this.callIds.clear();
  }
}
