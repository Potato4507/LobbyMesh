import {
  AudioPeer,
  type AudioPeerOptions,
} from "../../../packages/voice/src/audio-peer.js";
import { InputRegistry } from "../../../packages/voice/src/inputs.js";
import {
  type MediaOutput,
  type MediaReply,
  mediaError,
  parseMediaCommand,
} from "../../../packages/voice/src/media-host-protocol.js";
import { unknownMediaQuality } from "../../../packages/voice/src/quality.js";

interface MediaBridge {
  listen(callback: (command: unknown) => void): void;
  reply(value: MediaReply): void;
}
export function installMediaOwner(
  options: {
    capture?: AudioPeerOptions["capture"];
    enumerateInputs?: () => Promise<
      readonly { kind: string; deviceId: string; label: string }[]
    >;
    outputVolume?: number;
    onRemoteStream?: (stream: MediaStream) => void;
  } = {},
): { outputLevel(): number | null } {
  const bridge = (globalThis as unknown as { companionMedia: MediaBridge })
    .companionMedia;
  let peer: AudioPeer | undefined,
    closed = false,
    active = 0;
  let qualityActive = false;
  const sinks: HTMLAudioElement[] = [];
  let talkLease: ReturnType<typeof setTimeout> | undefined;
  let outputContext: AudioContext | undefined,
    outputGain: GainNode | undefined,
    outputAnalyser: AnalyserNode | undefined;
  let output: MediaOutput = { volume: 1, muted: false };
  const inputs = new InputRegistry(
    options.enumerateInputs ??
      (() => navigator.mediaDevices.enumerateDevices()),
    () =>
      Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join(""),
  );
  const invalidateInputs = () => inputs.invalidate();
  navigator.mediaDevices?.addEventListener("devicechange", invalidateInputs);
  const close = () => {
    inputs.close();
    navigator.mediaDevices?.removeEventListener(
      "devicechange",
      invalidateInputs,
    );
    clearTimeout(talkLease);
    closed = true;
    if (outputGain) outputGain.gain.value = 0;
    if (outputContext) void outputContext.close().catch(() => {});
    peer?.close();
    for (const sink of sinks) {
      sink.pause();
      sink.srcObject = null;
    }
  };
  addEventListener("pagehide", close);
  const create = () => {
    if (peer || closed) throw new Error("MEDIA_OWNER_USED");
    peer = new AudioPeer({
      permitted: () => !closed,
      ...(options.capture ? { capture: options.capture } : {}),
      onFailure: close,
      onRemoteStream: (stream) => {
        options.onRemoteStream?.(stream);
        const sink = new Audio();
        sink.srcObject = stream;
        // The element drives Chromium's remote decoder. Audio is played only
        // through the controlled WebAudio gain graph below.
        sink.volume = 0;
        sinks.push(sink);
        void sink.play().catch(close);
        outputContext = new AudioContext();
        outputGain = outputContext.createGain();
        outputGain.gain.value = output.muted ? 0 : output.volume;
        outputAnalyser = outputContext.createAnalyser();
        const hardwareGain = outputContext.createGain();
        hardwareGain.gain.value = options.outputVolume ?? 1;
        outputContext.createMediaStreamSource(stream).connect(outputGain);
        outputGain.connect(outputAnalyser);
        outputAnalyser.connect(hardwareGain);
        hardwareGain.connect(outputContext.destination);
        void outputContext.resume().catch(close);
      },
    });
    return peer;
  };
  bridge.listen((value) => {
    void (async () => {
      const command = parseMediaCommand(value);
      const diagnostic = command.op === "quality";
      if (diagnostic && (qualityActive || active >= 4)) {
        bridge.reply({ id: command.id, ok: true, data: unknownMediaQuality() });
        return;
      }
      if (diagnostic) qualityActive = true;
      else if (++active > 4) {
        active--;
        close();
        bridge.reply({ id: command.id, ok: false, data: null });
        return;
      }
      try {
        let data: unknown = null;
        if (closed) throw new Error("MEDIA_OWNER_CLOSED");
        switch (command.op) {
          case "offer":
            data = await create().offer(true);
            break;
          case "answer":
            data = await create().answer(command.data as string, true);
            break;
          case "accept-answer":
            if (!peer) throw new Error("MEDIA_NOT_READY");
            await peer.acceptAnswer(command.data as string);
            break;
          case "talk":
            if (!peer) throw new Error("MEDIA_NOT_READY");
            peer.setTalking(command.data === true);
            clearTimeout(talkLease);
            if (command.data === true)
              talkLease = setTimeout(() => {
                try {
                  peer?.setTalking(false);
                } catch {
                  close();
                }
              }, 750);
            break;
          case "status":
            data = {
              ...(peer?.status() ?? {
                phase: "idle",
                capturing: false,
                transmitting: false,
                inputLevel: null,
                inputClipping: null,
              }),
              outputLevel: outputLevel(),
            };
            break;
          case "quality":
            if (!peer) throw new Error("MEDIA_NOT_READY");
            data = await peer.quality();
            break;
          case "output":
            if (!peer) throw new Error("MEDIA_NOT_READY");
            output = { ...(command.data as MediaOutput) };
            if (outputGain)
              outputGain.gain.value = output.muted ? 0 : output.volume;
            break;
          case "input-gain":
            if (!peer) throw new Error("MEDIA_NOT_READY");
            peer.setInputGain(command.data as number);
            break;
          case "input-choices":
            if (!peer || peer.status().phase !== "connected")
              throw new Error("MEDIA_NOT_CONNECTED");
            data = await inputs.refresh();
            break;
          case "switch-input": {
            if (!peer) throw new Error("MEDIA_NOT_READY");
            clearTimeout(talkLease);
            peer.setTalking(false);
            const raw = inputs.resolve(command.data as string);
            await peer.switchInput(raw);
            inputs.select(raw);
            break;
          }
          case "metrics":
            if (!peer) throw new Error("MEDIA_NOT_READY");
            data = await peer.metrics();
            break;
        }
        bridge.reply({ id: command.id, ok: true, data });
      } catch (error) {
        const reason = mediaError(
          error instanceof Error ? error.message : null,
        );
        if (
          reason !== "MEDIA_NOT_CONNECTED" &&
          !(
            command.op === "switch-input" &&
            reason === "MEDIA_INPUT_CHOICE_EXPIRED"
          )
        )
          close();
        bridge.reply({
          id: command.id,
          ok: false,
          data: reason,
        });
      } finally {
        if (diagnostic) qualityActive = false;
        else active--;
      }
    })().catch(close);
  });
  function outputLevel(): number | null {
    if (!outputAnalyser || closed) return null;
    const values = new Float32Array(outputAnalyser.fftSize);
    outputAnalyser.getFloatTimeDomainData(values);
    const rms = Math.sqrt(
      values.reduce((sum, value) => sum + value * value, 0) / values.length,
    );
    return Number.isFinite(rms) ? Math.min(1, rms) : null;
  }
  return { outputLevel };
}
