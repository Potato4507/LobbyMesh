import {
  AudioPeer,
  type AudioPeerOptions,
} from "../../../packages/voice/src/audio-peer.js";
import {
  type MediaReply,
  mediaError,
  parseMediaCommand,
} from "../../../packages/voice/src/media-host-protocol.js";

interface MediaBridge {
  listen(callback: (command: unknown) => void): void;
  reply(value: MediaReply): void;
}
export function installMediaOwner(
  options: {
    capture?: AudioPeerOptions["capture"];
    outputVolume?: number;
    onRemoteStream?: (stream: MediaStream) => void;
  } = {},
): void {
  const bridge = (globalThis as unknown as { companionMedia: MediaBridge })
    .companionMedia;
  let peer: AudioPeer | undefined,
    closed = false,
    active = 0;
  const sinks: HTMLAudioElement[] = [];
  const close = () => {
    closed = true;
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
        sink.volume = options.outputVolume ?? 1;
        sinks.push(sink);
        void sink.play().catch(close);
      },
    });
    return peer;
  };
  bridge.listen((value) => {
    void (async () => {
      const command = parseMediaCommand(value);
      if (++active > 4) {
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
            break;
          case "status":
            data = peer?.status() ?? {
              phase: "idle",
              capturing: false,
              transmitting: false,
            };
            break;
          case "metrics":
            if (!peer) throw new Error("MEDIA_NOT_READY");
            data = await peer.metrics();
            break;
        }
        bridge.reply({ id: command.id, ok: true, data });
      } catch (error) {
        close();
        bridge.reply({
          id: command.id,
          ok: false,
          data: mediaError(error instanceof Error ? error.message : null),
        });
      } finally {
        active--;
      }
    })().catch(close);
  });
}
