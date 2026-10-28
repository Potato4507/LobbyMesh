import { useEffect, useRef, useState } from "react";
import type { VoiceView } from "../../../packages/protocol/src/voice.js";

export function CallOutput({ voice }: { voice: VoiceView }) {
  const [draft, setDraft] = useState({
    volume: voice.outputVolume,
    muted: voice.outputMuted,
  });
  const [pending, setPending] = useState(false),
    [notice, setNotice] = useState("");
  const desired = useRef({ ...draft, revision: 0, dirty: false }),
    live = useRef(true),
    busy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  useEffect(() => {
    if (!desired.current.dirty) {
      desired.current.volume = voice.outputVolume;
      desired.current.muted = voice.outputMuted;
      setDraft({ volume: voice.outputVolume, muted: voice.outputMuted });
    }
  }, [voice.outputVolume, voice.outputMuted]);
  async function flush() {
    if (!live.current || !voice.callId || !desired.current.dirty) return;
    if (busy.current) {
      schedule(120);
      return;
    }
    busy.current = true;
    setPending(true);
    const request = { ...desired.current };
    try {
      await window.companion.voiceAction({
        action: "output",
        callId: voice.callId,
        volume: request.volume,
        muted: request.muted,
      });
      if (live.current) setNotice("");
    } catch {
      if (live.current)
        setNotice(
          "Output could not be updated. End the call if incoming sound is unwanted.",
        );
    } finally {
      busy.current = false;
      if (live.current) {
        setPending(false);
        if (request.revision === desired.current.revision) {
          desired.current.dirty = false;
          clearTimeout(timer.current);
        } else schedule(120);
      }
    }
  }
  function schedule(milliseconds: number) {
    clearTimeout(timer.current);
    if (live.current)
      timer.current = setTimeout(() => {
        timer.current = undefined;
        void flush();
      }, milliseconds);
  }
  function change(volume: number, muted: boolean) {
    desired.current = {
      volume,
      muted,
      revision: desired.current.revision + 1,
      dirty: true,
    };
    setDraft({ volume, muted });
    schedule(muted ? 0 : 120);
  }
  return (
    <fieldset className="call-output">
      <legend>Incoming audio · this call</legend>
      <label htmlFor="callVolume">
        Volume {Math.round(draft.volume * 100)}%
        <input
          id="callVolume"
          type="range"
          min="0"
          max="100"
          step="1"
          value={Math.round(draft.volume * 100)}
          onChange={(event) =>
            change(Number(event.target.value) / 100, draft.muted)
          }
        />
      </label>
      <label className="check">
        <input
          id="muteIncoming"
          type="checkbox"
          checked={draft.muted}
          onChange={(event) => change(draft.volume, event.target.checked)}
        />
        Mute incoming audio
      </label>
      <div className="output-level">
        {voice.outputLevel === null ? (
          <span className="hint">Output level unavailable</span>
        ) : (
          <>
            <label htmlFor="callOutputLevel">Decoded output level</label>
            <meter
              id="callOutputLevel"
              min="0"
              max="1"
              value={voice.outputLevel}
              aria-label="Decoded output level"
            />
          </>
        )}
      </div>
      <output className="hint" aria-live="polite">
        {pending ? "Applying output…" : notice}
      </output>
    </fieldset>
  );
}
