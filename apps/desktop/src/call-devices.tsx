import { useRef, useState } from "react";
import type { VoiceView } from "../../../packages/protocol/src/voice.js";
import {
  type InputOptions,
  validInputOptions,
} from "../../../packages/voice/src/inputs.js";

export function CallDevices({ voice }: { voice: VoiceView }) {
  const [options, setOptions] = useState<InputOptions>();
  const [choice, setChoice] = useState("system-default");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  const connected = voice.phase === "connected" && !!voice.callId;
  async function run(switching: boolean) {
    if (pending.current || !connected || !voice.callId) return;
    pending.current = true;
    setBusy(true);
    try {
      if (switching) {
        await window.companion.voiceAction({
          action: "switch-input",
          callId: voice.callId,
          choice,
          consent: true,
        });
        setNotice("Microphone changed. Press Hold to talk again when ready.");
      } else {
        const next = await window.companion.voiceInputs({
          callId: voice.callId,
        });
        if (!validInputOptions(next)) throw new Error("INVALID_INPUT_OPTIONS");
        setOptions(next);
        setChoice(next.selected ?? "system-default");
        setNotice(
          next.available
            ? "Choose a microphone, then apply. Changing it mutes transmission."
            : "Microphone list unavailable. You can retry or use the system default.",
        );
      }
    } catch {
      setOptions(undefined);
      setChoice("system-default");
      setNotice(
        switching
          ? "Microphone change failed. Refresh the list and check the call status before trying again."
          : "Microphone list unavailable. Try again when the call is connected.",
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <fieldset
      className="call-output"
      disabled={busy || !connected}
      id="callDevices"
    >
      <legend>Microphone device</legend>
      <button type="button" onClick={() => void run(false)}>
        Refresh microphones
      </button>
      {options && (
        <>
          <label htmlFor="callMicrophone">Microphone</label>
          <select
            id="callMicrophone"
            value={choice}
            onChange={(event) => setChoice(event.target.value)}
          >
            {options.choices.map((input) => (
              <option key={input.id} value={input.id}>
                {input.label}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => void run(true)}>
            Use microphone
          </button>
        </>
      )}
      <output className="hint" aria-live="polite">
        {busy
          ? "Updating microphone…"
          : notice || "List devices only when you choose to refresh."}
      </output>
    </fieldset>
  );
}
