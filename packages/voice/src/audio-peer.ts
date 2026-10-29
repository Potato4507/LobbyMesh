// Browser-only media owner primitive. Main-process permission/identity IPC is a
// separate boundary; only the dedicated media owner loads this primitive.

import {
  type InputActivity,
  readInputActivity,
  unknownInputActivity,
} from "./input-activity.js";
import {
  type MediaQuality,
  readMediaQuality,
  unknownMediaQuality,
} from "./quality.js";
export interface AudioPeerOptions {
  permitted: () => boolean;
  capture?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  onRemoteStream?: (stream: MediaStream) => void;
  onFailure?: (reason: string) => void;
  timeoutMs?: number;
}
function validDescription(sdp: unknown): sdp is string {
  if (typeof sdp !== "string" || new TextEncoder().encode(sdp).length > 12_288)
    return false;
  const media = sdp.match(/^m=.+$/gm) ?? [];
  const fingerprints = [
    ...sdp.matchAll(/^a=fingerprint:sha-256 ([A-Fa-f0-9:]+)\r?$/gm),
  ].map((match) => match[1]?.toUpperCase());
  return (
    media.length === 1 &&
    media[0]?.startsWith("m=audio ") === true &&
    /^a=rtpmap:\d+ opus\/48000(?:\/2)?\r?$/im.test(sdp) &&
    fingerprints.length > 0 &&
    fingerprints.every(
      (value) =>
        typeof value === "string" &&
        /^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(value),
    ) &&
    new Set(fingerprints).size === 1
  );
}

export class AudioPeer {
  private readonly connection: RTCPeerConnection;
  private readonly lifetime = new AbortController();
  private stream: MediaStream | undefined;
  private processed: MediaStream | undefined;
  private inputContext: AudioContext | undefined;
  private inputGain: GainNode | undefined;
  private inputAnalyser: AnalyserNode | undefined;
  private remote: MediaStream | undefined;
  private phase:
    | "idle"
    | "capturing"
    | "negotiating"
    | "connected"
    | "reconnecting"
    | "closed"
    | "failed" = "idle";
  private busy = false;
  private talking = false;
  private qualityPending = false;
  private disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly options: AudioPeerOptions) {
    if (
      !Number.isSafeInteger(options.timeoutMs ?? 5000) ||
      (options.timeoutMs ?? 5000) < 1 ||
      (options.timeoutMs ?? 5000) > 5000
    )
      throw new Error("INVALID_MEDIA_LIMITS");
    // No project relay, TURN credential, public STUN request or fallback service.
    this.connection = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: "max-bundle",
    });
    this.connection.ontrack = (event) => {
      if (
        !this.allowed() ||
        this.lifetime.signal.aborted ||
        event.track.kind !== "audio" ||
        this.remote
      ) {
        event.track.stop();
        this.fail("MEDIA_REMOTE_TRACK_REJECTED");
        return;
      }
      this.remote = new MediaStream([event.track]);
      event.track.onended = () => this.fail("MEDIA_REMOTE_TRACK_ENDED");
      try {
        this.options.onRemoteStream?.(this.remote);
      } catch {
        this.fail("MEDIA_OUTPUT_FAILED");
      }
    };
    this.connection.onconnectionstatechange = () => {
      if (this.lifetime.signal.aborted) return;
      if (!this.allowed()) {
        this.close();
        return;
      }
      clearTimeout(this.disconnectTimer);
      if (this.connection.connectionState === "failed")
        this.fail("MEDIA_CONNECTION_FAILED");
      else if (this.connection.connectionState === "connected")
        this.phase = "connected";
      else if (this.connection.connectionState === "disconnected") {
        this.phase = "reconnecting";
        this.talking = false;
        for (const stream of [this.stream, this.processed])
          for (const track of stream?.getAudioTracks() ?? [])
            track.enabled = false;
        this.disconnectTimer = setTimeout(
          () => this.fail("MEDIA_DISCONNECTED"),
          5000,
        );
      }
    };
  }
  private allowed(): boolean {
    try {
      return this.options.permitted() === true;
    } catch {
      return false;
    }
  }
  private check(): void {
    if (!this.allowed()) {
      this.close();
      throw new Error("MEDIA_PERMISSION_DENIED");
    }
    if (this.lifetime.signal.aborted) throw new Error("MEDIA_CLOSED");
  }
  private fail(reason: string): void {
    if (this.lifetime.signal.aborted) return;
    this.close();
    this.phase = "failed";
    try {
      this.options.onFailure?.(reason);
    } catch {
      /* State is authoritative. */
    }
  }
  private async bounded<T>(
    work: Promise<T>,
    timeoutMs = this.options.timeoutMs ?? 5000,
  ): Promise<T> {
    let rejectWait: (error: Error) => void = () => {};
    const canceled = new Promise<never>((_resolve, reject) => {
      rejectWait = reject;
    });
    const abort = () => rejectWait(new Error("MEDIA_CLOSED"));
    const timer = setTimeout(
      () => rejectWait(new Error("MEDIA_TIMEOUT")),
      timeoutMs,
    );
    this.lifetime.signal.addEventListener("abort", abort, { once: true });
    try {
      this.check();
      return await Promise.race([work, canceled]);
    } finally {
      clearTimeout(timer);
      this.lifetime.signal.removeEventListener("abort", abort);
    }
  }
  private async capture(answering = false): Promise<void> {
    this.check();
    if (this.stream) return;
    this.phase = "capturing";
    const pending = (
      this.options.capture ??
      ((constraints) => navigator.mediaDevices.getUserMedia(constraints))
    )({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    // getUserMedia itself is not abortable. Stop any late result independently of
    // the race, even after teardown or timeout has already returned to the owner.
    void pending.then(
      (stream) => {
        if (this.lifetime.signal.aborted || !this.allowed())
          for (const track of stream.getTracks()) track.stop();
      },
      () => {},
    );
    const stream = await this.bounded(pending);
    this.stream = stream;
    this.check();
    const tracks = stream.getTracks();
    if (
      tracks.length !== 1 ||
      tracks[0]?.kind !== "audio" ||
      tracks[0].readyState !== "live"
    )
      throw new Error("MEDIA_CAPTURE_FAILED");
    const track = tracks[0];
    track.enabled = false;
    track.onended = () => this.fail("MEDIA_DEVICE_ENDED");
    // Source interruption must not silently resume an earlier held PTT intent.
    // End this media owner; a new call needs fresh explicit user consent.
    track.onmute = () => this.fail("MEDIA_DEVICE_MUTED");
    if (track.muted) throw new Error("MEDIA_DEVICE_UNAVAILABLE");
    const context = new AudioContext();
    this.inputContext = context;
    const gain = context.createGain(),
      destination = context.createMediaStreamDestination();
    this.inputGain = gain;
    gain.gain.value = 1;
    context.createMediaStreamSource(stream).connect(gain);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    this.inputAnalyser = analyser;
    gain.connect(analyser);
    analyser.connect(destination);
    this.processed = destination.stream;
    const outgoing = destination.stream.getAudioTracks()[0];
    if (!outgoing) throw new Error("MEDIA_CAPTURE_FAILED");
    outgoing.enabled = false;
    await this.bounded(context.resume());
    context.onstatechange = () => {
      if (!this.lifetime.signal.aborted && context.state !== "running")
        this.fail("MEDIA_INPUT_INTERRUPTED");
    };
    const transceiver = answering
      ? this.connection
          .getTransceivers()
          .find(
            (value) =>
              value.mid !== null && value.receiver.track.kind === "audio",
          )
      : this.connection.addTransceiver(outgoing, {
          direction: "sendrecv",
          streams: [destination.stream],
        });
    if (!transceiver) throw new Error("MEDIA_INVALID_DESCRIPTION");
    if (answering) {
      transceiver.direction = "sendrecv";
      await this.bounded(transceiver.sender.replaceTrack(outgoing));
      transceiver.sender.setStreams(destination.stream);
    }
    const opus =
      RTCRtpSender.getCapabilities("audio")?.codecs.filter(
        (codec) => codec.mimeType.toLowerCase() === "audio/opus",
      ) ?? [];
    if (!opus.length) throw new Error("MEDIA_OPUS_UNAVAILABLE");
    transceiver.setCodecPreferences(opus);
    this.phase = "negotiating";
  }
  private async localDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<string> {
    await this.bounded(this.connection.setLocalDescription(description));
    if (this.connection.iceGatheringState !== "complete") {
      let cleanup = () => {};
      try {
        await this.bounded(
          new Promise<void>((resolve) => {
            const changed = () => {
              if (this.connection.iceGatheringState === "complete") resolve();
            };
            this.connection.addEventListener(
              "icegatheringstatechange",
              changed,
            );
            cleanup = () =>
              this.connection.removeEventListener(
                "icegatheringstatechange",
                changed,
              );
            changed();
          }),
        );
      } finally {
        cleanup();
      }
    }
    this.check();
    const sdp = this.connection.localDescription?.sdp;
    if (!validDescription(sdp)) throw new Error("MEDIA_INVALID_DESCRIPTION");
    return sdp;
  }
  private async operation<T>(action: () => Promise<T>): Promise<T> {
    this.check();
    if (this.busy) throw new Error("MEDIA_BUSY");
    this.busy = true;
    try {
      const result = await action();
      this.check();
      return result;
    } catch (error) {
      const reason =
        error instanceof Error && error.name === "NotAllowedError"
          ? "MEDIA_PERMISSION_DENIED"
          : error instanceof Error &&
              ["NotFoundError", "NotReadableError"].includes(error.name)
            ? "MEDIA_DEVICE_UNAVAILABLE"
            : error instanceof Error &&
                [
                  "MEDIA_TIMEOUT",
                  "MEDIA_CLOSED",
                  "MEDIA_PERMISSION_DENIED",
                  "MEDIA_DEVICE_UNAVAILABLE",
                  "MEDIA_INVALID_DESCRIPTION",
                  "MEDIA_OPUS_UNAVAILABLE",
                ].includes(error.message)
              ? error.message
              : "MEDIA_NEGOTIATION_FAILED";
      this.fail(reason);
      throw new Error(reason);
    } finally {
      this.busy = false;
    }
  }
  offer(consent: boolean): Promise<string> {
    return this.operation(async () => {
      if (consent !== true) throw new Error("MEDIA_PERMISSION_DENIED");
      if (this.phase !== "idle") throw new Error("MEDIA_INVALID_DESCRIPTION");
      await this.capture();
      return this.localDescription(
        await this.bounded(this.connection.createOffer()),
      );
    });
  }
  answer(sdp: string, consent: boolean): Promise<string> {
    return this.operation(async () => {
      if (consent !== true) throw new Error("MEDIA_PERMISSION_DENIED");
      if (this.phase !== "idle" || !validDescription(sdp))
        throw new Error("MEDIA_INVALID_DESCRIPTION");
      await this.bounded(
        this.connection.setRemoteDescription({ type: "offer", sdp }),
      );
      await this.capture(true);
      return this.localDescription(
        await this.bounded(this.connection.createAnswer()),
      );
    });
  }
  acceptAnswer(sdp: string): Promise<void> {
    return this.operation(async () => {
      if (
        this.connection.signalingState !== "have-local-offer" ||
        !validDescription(sdp)
      )
        throw new Error("MEDIA_INVALID_DESCRIPTION");
      await this.bounded(
        this.connection.setRemoteDescription({ type: "answer", sdp }),
      );
    });
  }
  // Push-to-talk ownership stays in the trusted host; opening a call never talks.
  setInputGain(value: number): void {
    this.check();
    if (!Number.isFinite(value) || value < 0 || value > 2)
      throw new Error("MEDIA_INVALID_INPUT_GAIN");
    if (!this.inputGain) throw new Error("MEDIA_NOT_READY");
    this.inputGain.gain.value = value;
  }
  setTalking(value: boolean): void {
    this.check();
    if (!this.stream) throw new Error("MEDIA_NOT_READY");
    if (value === true && this.connection.connectionState !== "connected")
      throw new Error("MEDIA_NOT_CONNECTED");
    this.talking = value === true;
    for (const stream of [this.stream, this.processed])
      for (const track of stream?.getAudioTracks() ?? [])
        track.enabled = this.talking;
  }
  status(): {
    phase: string;
    transmitting: boolean;
    capturing: boolean;
  } & InputActivity {
    if (!this.allowed()) this.close();
    return {
      ...(this.inputAnalyser &&
      this.phase === "connected" &&
      !this.lifetime.signal.aborted
        ? readInputActivity(this.inputAnalyser, this.talking)
        : unknownInputActivity()),
      phase: this.phase,
      transmitting: this.talking && !this.lifetime.signal.aborted,
      capturing:
        this.stream
          ?.getAudioTracks()
          .some((track) => track.readyState === "live") === true,
    };
  }
  async quality(): Promise<MediaQuality> {
    this.check();
    if (this.qualityPending) return unknownMediaQuality();
    this.qualityPending = true;
    try {
      const work = Promise.resolve()
        .then(() => {
          this.check();
          return this.connection.getStats();
        })
        .then((report) => {
          this.check();
          return readMediaQuality(report);
        })
        .catch(() => unknownMediaQuality())
        .finally(() => {
          this.qualityPending = false;
        });
      return await this.bounded(
        work,
        Math.min(500, this.options.timeoutMs ?? 5000),
      );
    } catch {
      // A timed-out native job keeps its slot until it actually settles.
      // getStats is not abortable; requests cannot accumulate native jobs.
      // Optional diagnostics never turn a healthy media call into a failure.
      return unknownMediaQuality();
    }
  }
  async metrics(): Promise<{
    receivedPackets: number;
    receivedBytes: number;
    receivedEnergy: number | null;
  }> {
    this.check();
    const report = await this.bounded(this.connection.getStats());
    this.check();
    const result: {
      receivedPackets: number;
      receivedBytes: number;
      receivedEnergy: number | null;
    } = { receivedPackets: 0, receivedBytes: 0, receivedEnergy: null };
    report.forEach((entry) => {
      if (entry.type !== "inbound-rtp" || entry.kind !== "audio") return;
      for (const [key, value] of [
        ["receivedPackets", entry.packetsReceived],
        ["receivedBytes", entry.bytesReceived],
        ["receivedEnergy", entry.totalAudioEnergy],
      ] as const) {
        if (typeof value === "number" && Number.isFinite(value) && value >= 0)
          result[key] = (result[key] ?? 0) + value;
      }
    });
    return result;
  }
  close(): void {
    if (this.lifetime.signal.aborted) return;
    this.phase = "closed";
    this.talking = false;
    this.lifetime.abort();
    clearTimeout(this.disconnectTimer);
    for (const stream of [this.stream, this.processed, this.remote])
      for (const track of stream?.getTracks() ?? []) {
        track.enabled = false;
        track.onended = null;
        track.onmute = null;
        track.stop();
      }
    if (this.inputContext) {
      this.inputContext.onstatechange = null;
      void this.inputContext.close().catch(() => {});
    }
    this.inputGain = undefined;
    this.inputAnalyser = undefined;
    this.connection.ontrack = null;
    this.connection.onconnectionstatechange = null;
    this.connection.close();
  }
}
