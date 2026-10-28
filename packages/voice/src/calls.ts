import type { RpcHandler } from "../../app-dht/src/rpc.js";
import type { DirectContact } from "../../protocol/src/direct.js";
import { VoiceSignaling } from "./signaling.js";

export interface CallMedia {
  offer(consent: boolean): Promise<string>;
  answer(sdp: string, consent: boolean): Promise<string>;
  acceptAnswer(sdp: string): Promise<void>;
  setTalking(value: boolean): Promise<void>;
  setOutput(volume: number, muted: boolean): Promise<void>;
  status(): Promise<{
    phase: string;
    capturing: boolean;
    transmitting: boolean;
    outputLevel?: number | null;
  }>;
  close(): void;
}
export type CallMediaFactory = (context: {
  peerId: string;
  permitted: () => boolean;
}) => CallMedia;
interface OwnedMedia {
  peerId: string;
  callId: string | null;
  media: CallMedia;
  controller: AbortController;
  capturing: boolean | null;
  transmitting: boolean;
  polling: boolean;
  talkRevision: number;
  talkDesired: boolean;
  outputVolume: number;
  outputMuted: boolean;
  outputPending: boolean;
  outputLevel: number | null;
}

// Main-process call lifecycle. Remote SDP can only enter through authenticated
// signaling events; incoming offers never allocate a capture/media host.
export class VoiceCalls {
  private readonly signaling: VoiceSignaling;
  private owner: OwnedMedia | undefined;
  private incoming: { callId: string; peerId: string; sdp: string } | undefined;
  private enabled = false;
  private closed = false;
  private failure: string | null = null;
  private scheduled = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly self: string,
    transact: (
      contact: DirectContact,
      request: unknown,
      signal: AbortSignal,
    ) => Promise<unknown>,
    private readonly options: {
      authorized: (id: string) => boolean;
      createMedia?: CallMediaFactory;
      pollMs?: number;
      negotiationTimeoutMs?: number;
      activeTimeoutMs?: number;
      mediaTimeoutMs?: number;
    },
  ) {
    for (const [value, max] of [
      [options.pollMs ?? 100, 1000],
      [options.mediaTimeoutMs ?? 15_000, 15_000],
    ])
      if (
        !Number.isSafeInteger(value) ||
        (value ?? 0) < 1 ||
        (value ?? 0) > (max ?? 0)
      )
        throw new Error("INVALID_CALL_LIMITS");
    this.signaling = new VoiceSignaling(self, transact, {
      authorized: (id) => this.authorized(id),
      mediaAvailable: () =>
        !!this.options.createMedia && this.enabled && !this.closed,
      ...(options.negotiationTimeoutMs !== undefined
        ? { negotiationTimeoutMs: options.negotiationTimeoutMs }
        : {}),
      ...(options.activeTimeoutMs !== undefined
        ? { activeTimeoutMs: options.activeTimeoutMs }
        : {}),
      onEvents: () => this.scheduleEvents(),
      onCallEnded: (id) => {
        if (this.incoming?.callId === id) this.incoming = undefined;
        if (this.owner?.callId === id) this.release(this.owner);
      },
    });
  }
  readonly handle: RpcHandler = (peer, request, signal) =>
    this.signaling.handle(peer, request, signal);
  private authorized(id: string): boolean {
    try {
      return (
        /^[a-f0-9]{64}$/.test(id) &&
        id !== this.self &&
        this.options.authorized(id) === true
      );
    } catch {
      return false;
    }
  }
  private permitted(id: string): boolean {
    return !this.closed && this.enabled && this.authorized(id);
  }
  private release(owner: OwnedMedia): void {
    owner.controller.abort();
    clearTimeout(this.timer);
    this.timer = undefined;
    try {
      owner.media.close();
      if (this.owner === owner) this.owner = undefined;
      if (this.failure === "MEDIA_TEARDOWN_FAILED") this.failure = null;
    } catch {
      // Retain ownership when teardown cannot be confirmed; no subsequent call.
      this.enabled = false;
      this.failure = "MEDIA_TEARDOWN_FAILED";
      owner.capturing = null;
    }
  }
  setConsent(value: boolean): void {
    if (value === true && this.owner?.controller.signal.aborted)
      throw new Error("MEDIA_TEARDOWN_FAILED");
    if (value !== true && !this.closed) {
      const id = this.signaling.status().callId;
      if (id) void this.signaling.hangup(id).catch(() => {});
    }
    this.enabled = value === true && !this.closed;
    if (!this.enabled && this.owner) this.release(this.owner);
    this.signaling.setConsent(this.enabled);
    if (this.enabled && !this.owner) this.failure = null;
  }
  policyChanged(): void {
    if (this.owner && !this.permitted(this.owner.peerId))
      this.release(this.owner);
    this.signaling.policyChanged();
  }
  status(): {
    available: boolean;
    phase: string;
    peerId: string | null;
    callId: string | null;
    capturing: boolean | null;
    transmitting: boolean | null;
    error: string | null;
    outputVolume: number;
    outputMuted: boolean;
    outputLevel: number | null;
  } {
    this.policyChanged();
    const control = this.signaling.status();
    return {
      available: control.available && this.enabled,
      phase: this.failure
        ? "failed"
        : this.owner && !this.owner.callId
          ? "preparing"
          : control.phase,
      peerId: this.owner?.peerId ?? control.peerId,
      callId: control.callId,
      capturing: this.owner
        ? this.owner.capturing
        : this.failure === "MEDIA_TEARDOWN_FAILED"
          ? null
          : false,
      transmitting:
        this.failure === "MEDIA_TEARDOWN_FAILED"
          ? null
          : (this.owner?.transmitting ?? false),
      error: this.failure,
      outputVolume: this.owner?.outputVolume ?? 1,
      outputMuted: this.owner?.outputMuted ?? false,
      outputLevel: this.owner?.outputLevel ?? null,
    };
  }
  private create(peerId: string): OwnedMedia {
    if (!this.permitted(peerId) || !this.options.createMedia)
      throw new Error("VOICE_DISABLED");
    if (this.owner) throw new Error("VOICE_BUSY");
    let owner: OwnedMedia | undefined;
    const media = this.options.createMedia({
      peerId,
      permitted: () =>
        !!owner &&
        this.owner === owner &&
        !owner.controller.signal.aborted &&
        this.permitted(peerId),
    });
    owner = {
      peerId,
      media,
      callId: null,
      controller: new AbortController(),
      capturing: null,
      transmitting: false,
      polling: false,
      talkRevision: 0,
      talkDesired: false,
      outputVolume: 1,
      outputMuted: false,
      outputPending: false,
      outputLevel: null,
    };
    this.owner = owner;
    this.failure = null;
    this.poll(owner);
    return owner;
  }
  private async media<T>(
    owner: OwnedMedia,
    work: () => Promise<T>,
  ): Promise<T> {
    let rejectWait: (error: Error) => void = () => {};
    const deadline = new Promise<never>((_resolve, reject) => {
      rejectWait = reject;
    });
    const abort = () => rejectWait(new Error("VOICE_CALL_CANCELED"));
    const timer = setTimeout(
      () => rejectWait(new Error("MEDIA_OWNER_TIMEOUT")),
      this.options.mediaTimeoutMs ?? 15_000,
    );
    owner.controller.signal.addEventListener("abort", abort, { once: true });
    try {
      if (
        this.owner !== owner ||
        owner.controller.signal.aborted ||
        !this.permitted(owner.peerId)
      )
        throw new Error("VOICE_CALL_CANCELED");
      const value = await Promise.race([deadline, work()]);
      if (
        this.owner !== owner ||
        owner.controller.signal.aborted ||
        !this.permitted(owner.peerId)
      )
        throw new Error("VOICE_CALL_CANCELED");
      return value;
    } finally {
      clearTimeout(timer);
      owner.controller.signal.removeEventListener("abort", abort);
    }
  }
  private stopWithError(owner: OwnedMedia, reason: string): void {
    if (this.owner !== owner) return;
    this.failure = reason;
    this.release(owner);
    if (owner.callId) void this.signaling.hangup(owner.callId).catch(() => {});
  }
  private scheduleEvents(): void {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (!this.closed) this.consume();
    });
  }
  private consume(): void {
    for (const event of this.signaling.drainEvents()) {
      if (event.op === "offer" && typeof event.data === "string") {
        this.incoming = {
          callId: event.callId,
          peerId: event.peerId,
          sdp: event.data,
        };
      } else if (event.op === "answer" && typeof event.data === "string") {
        const owner = this.owner;
        if (
          !owner ||
          owner.callId !== event.callId ||
          owner.peerId !== event.peerId
        )
          continue;
        void this.media(owner, () =>
          owner.media.acceptAnswer(event.data as string),
        ).then(
          () => this.poll(owner),
          () => this.stopWithError(owner, "MEDIA_ANSWER_FAILED"),
        );
      } else if (event.op === "ice" && this.owner?.callId === event.callId) {
        // This adapter negotiates complete ICE inside authenticated SDP.
        this.stopWithError(this.owner, "VOICE_TRICKLE_UNSUPPORTED");
      }
    }
  }
  private poll(owner: OwnedMedia): void {
    if (
      this.owner !== owner ||
      owner.controller.signal.aborted ||
      owner.polling
    )
      return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      owner.polling = true;
      void this.media(owner, () => owner.media.status()).then(
        (status) => {
          owner.polling = false;
          if (this.owner !== owner) return;
          owner.capturing = status.capturing;
          owner.transmitting = status.transmitting;
          owner.outputLevel =
            typeof status.outputLevel === "number" &&
            Number.isFinite(status.outputLevel) &&
            status.outputLevel >= 0 &&
            status.outputLevel <= 1
              ? status.outputLevel
              : null;
          if (["failed", "closed"].includes(status.phase)) {
            this.stopWithError(owner, "MEDIA_CONNECTION_ENDED");
            return;
          }
          if (status.phase === "connected" && owner.callId) {
            try {
              this.signaling.mediaConnected(owner.callId);
            } catch {
              this.stopWithError(owner, "VOICE_STATE_MISMATCH");
              return;
            }
          }
          this.poll(owner);
        },
        () => {
          owner.polling = false;
          this.stopWithError(owner, "MEDIA_STATUS_FAILED");
        },
      );
    }, this.options.pollMs ?? 100);
    this.timer.unref();
  }
  async dial(contact: DirectContact, consent: boolean): Promise<string> {
    if (
      consent !== true ||
      !this.permitted(contact.id) ||
      !this.options.createMedia ||
      !/^[a-f0-9]{64}$/.test(contact.transportKey)
    )
      throw new Error("VOICE_NOT_PERMITTED");
    if (!["idle"].includes(this.signaling.status().phase))
      throw new Error("VOICE_BUSY");
    const owner = this.create(contact.id);
    try {
      const sdp = await this.media(owner, () => owner.media.offer(true));
      const sent = this.signaling.offer(contact, sdp, owner.controller.signal);
      owner.callId = this.signaling.status().callId;
      const id = await sent;
      if (this.owner !== owner) throw new Error("VOICE_CALL_CANCELED");
      this.poll(owner);
      return id;
    } catch (error) {
      this.stopWithError(owner, "VOICE_DIAL_FAILED");
      throw error;
    }
  }
  async answer(callId: string, consent: boolean): Promise<void> {
    this.consume();
    const incoming = this.incoming;
    if (
      consent !== true ||
      !incoming ||
      incoming.callId !== callId ||
      !this.permitted(incoming.peerId)
    )
      throw new Error("VOICE_NOT_PERMITTED");
    const owner = this.create(incoming.peerId);
    owner.callId = callId;
    this.incoming = undefined;
    try {
      const sdp = await this.media(owner, () =>
        owner.media.answer(incoming.sdp, true),
      );
      await this.signaling.answer(callId, sdp, owner.controller.signal);
      if (this.owner !== owner) throw new Error("VOICE_CALL_CANCELED");
      this.poll(owner);
    } catch (error) {
      this.stopWithError(owner, "VOICE_ANSWER_FAILED");
      throw error;
    }
  }
  async setTalking(value: boolean): Promise<void> {
    const owner = this.owner;
    if (
      !owner ||
      !owner.callId ||
      this.signaling.status().phase !== "connected" ||
      typeof value !== "boolean"
    )
      throw new Error("VOICE_NOT_CONNECTED");
    const revision = ++owner.talkRevision;
    owner.talkDesired = value;
    try {
      await this.media(owner, () => owner.media.setTalking(value));
      if (revision === owner.talkRevision) owner.transmitting = value;
      else if (!owner.talkDesired)
        await this.media(owner, () => owner.media.setTalking(false));
    } catch (error) {
      this.stopWithError(owner, "MEDIA_TALK_FAILED");
      throw error;
    }
  }
  async hangup(): Promise<void> {
    const id = this.signaling.status().callId;
    if (this.owner) this.release(this.owner);
    this.incoming = undefined;
    if (id) await this.signaling.hangup(id);
  }
  async setOutput(volume: number, muted: boolean): Promise<void> {
    if (
      !Number.isFinite(volume) ||
      volume < 0 ||
      volume > 1 ||
      typeof muted !== "boolean"
    )
      throw new Error("INVALID_CALL_OUTPUT");
    const owner = this.owner;
    if (!owner || this.signaling.status().phase !== "connected")
      throw new Error("VOICE_NOT_CONNECTED");
    if (owner.outputPending) throw new Error("OUTPUT_UPDATE_PENDING");
    owner.outputPending = true;
    try {
      await this.media(owner, () => owner.media.setOutput(volume, muted));
      owner.outputVolume = volume;
      owner.outputMuted = muted;
    } catch (error) {
      this.stopWithError(owner, "MEDIA_OUTPUT_FAILED");
      throw error;
    } finally {
      owner.outputPending = false;
    }
  }
  close(): void {
    this.closed = true;
    this.enabled = false;
    this.incoming = undefined;
    clearTimeout(this.timer);
    if (this.owner) this.release(this.owner);
    this.signaling.close();
    if (this.owner) throw new Error("MEDIA_TEARDOWN_FAILED");
  }
}
