import { useEffect, useRef, useState } from "react";
import type { VoiceView } from "../../../packages/protocol/src/voice.js";

export function CallInput({ voice }: { voice: VoiceView }) {
  const [gain, setGain] = useState(voice.inputGain),
    [notice, setNotice] = useState("");
  const desired = useRef({ gain, revision: 0, dirty: false }),
    busy = useRef(false),
    live = useRef(true);
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
      desired.current.gain = voice.inputGain;
      setGain(voice.inputGain);
    }
  }, [voice.inputGain]);
  function schedule(ms: number) {
    clearTimeout(timer.current);
    if (live.current)
      timer.current = setTimeout(() => {
        timer.current = undefined;
        void flush();
      }, ms);
  }
  async function flush() {
    if (!live.current || !voice.callId || !desired.current.dirty) return;
    if (busy.current) {
      schedule(120);
      return;
    }
    busy.current = true;
    const request = { ...desired.current };
    setNotice("Applying microphone gain…");
    try {
      await window.companion.voiceAction({
        action: "input-gain",
        callId: voice.callId,
        gain: request.gain,
      });
      if (live.current) setNotice("");
    } catch {
      if (live.current)
        setNotice(
          "Microphone gain could not be confirmed. End the call and try again.",
        );
    } finally {
      busy.current = false;
      if (live.current) {
        if (request.revision === desired.current.revision)
          desired.current.dirty = false;
        else schedule(120);
      }
    }
  }
  return (
    <fieldset className="call-output">
      <legend>Your microphone · this call</legend>
      <label htmlFor="callInputGain">
        Gain {Math.round(gain * 100)}%
        <input
          id="callInputGain"
          type="range"
          min="0"
          max="200"
          step="1"
          value={Math.round(gain * 100)}
          onChange={(event) => {
            const value = Number(event.target.value) / 100;
            desired.current = {
              gain: value,
              revision: desired.current.revision + 1,
              dirty: true,
            };
            setGain(value);
            schedule(value === 0 ? 0 : 120);
          }}
        />
      </label>
      <p className="hint">
        Adjusts transmitted input. 0% silences input while the microphone stays
        on; hold to talk is still required. Above 100% may distort. Resets each
        call.
      </p>
      <output className="hint" aria-live="polite">
        {notice}
      </output>
    </fieldset>
  );
}
