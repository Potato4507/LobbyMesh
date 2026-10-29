import { useCallback, useEffect, useRef, useState } from "react";
import type {
  VoiceAction,
  VoiceView,
} from "../../../packages/protocol/src/voice.js";
import { CallOutput } from "./call-output.js";

export function VoiceControls({
  peerId,
  discovered,
  online,
  active,
  onMicrophone,
}: {
  peerId: string;
  discovered: boolean;
  online: boolean;
  active: boolean;
  onMicrophone?: (value: "off" | "capturing" | "unknown") => void;
}) {
  const [voice, setVoice] = useState<VoiceView | null>(null),
    [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false),
    [held, setHeld] = useState(false);
  const current = useRef(voice);
  current.current = voice;
  const starting = useRef(false);
  const previousCall = useRef<string | null>(null);
  const holding = useRef(false),
    actionRevision = useRef(0),
    alive = useRef(true);
  const release = useCallback(() => {
    const wasHeld = holding.current;
    holding.current = false;
    if (alive.current) setHeld(false);
    const callId = current.current?.callId;
    if (wasHeld && callId)
      void window.companion
        .voiceAction({ action: "talk", callId, pressed: false, start: false })
        .catch(() => {});
  }, []);
  useEffect(() => {
    alive.current = true;
    let busy = false,
      live = true;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const value = await window.companion.voice();
        if (live) {
          setVoice(value);
          onMicrophone?.(
            value.capturing === null
              ? "unknown"
              : value.capturing
                ? "capturing"
                : "off",
          );
        }
      } catch {
        if (live) {
          release();
          setVoice(null);
        }
      } finally {
        busy = false;
      }
    };
    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 300);
    const hidden = () => {
      if (document.hidden) release();
    };
    window.addEventListener("blur", release);
    window.addEventListener("pagehide", release);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      live = false;
      release();
      alive.current = false;
      actionRevision.current++;
      clearInterval(timer);
      window.removeEventListener("blur", release);
      window.removeEventListener("pagehide", release);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [release, onMicrophone]);
  useEffect(() => {
    if (!active || !online || voice?.phase !== "connected") release();
  }, [active, online, voice?.phase, release]);
  useEffect(() => {
    if (previousCall.current !== (voice?.callId ?? null)) release();
    previousCall.current = voice?.callId ?? null;
  }, [voice?.callId, release]);
  useEffect(() => {
    if (!held) return;
    let busy = false;
    const renew = async () => {
      if (busy || !holding.current || !current.current?.callId) return;
      busy = true;
      const start = starting.current;
      starting.current = false;
      try {
        await window.companion.voiceAction({
          action: "talk",
          callId: current.current.callId,
          pressed: true,
          start,
        });
      } catch {
        release();
        if (alive.current)
          setNotice(
            "Talking stopped. Wait for connected audio, focus this window and press again.",
          );
      } finally {
        busy = false;
      }
    };
    void renew();
    const timer = setInterval(() => {
      void renew();
    }, 250);
    return () => clearInterval(timer);
  }, [held, release]);
  async function act(request: VoiceAction) {
    const revision = ++actionRevision.current;
    release();
    setPending(true);
    setNotice("");
    try {
      await window.companion.voiceAction(request);
    } catch (error) {
      if (alive.current && revision === actionRevision.current) {
        const message = error instanceof Error ? error.message : "";
        setNotice(
          message.includes("MEDIA_PERMISSION_DENIED")
            ? "Microphone access was denied. Check Windows microphone privacy settings before trying again."
            : message.includes("MEDIA_DEVICE_UNAVAILABLE")
              ? "No usable microphone is available. Check your input device."
              : message.includes("CONTACT_NOT_DISCOVERED")
                ? "This contact is not reachable yet."
                : message.includes("VOICE_WINDOW_NOT_FOCUSED")
                  ? "Focus this window and try again."
                  : "The voice action could not be completed. You can cancel or try again.",
        );
      }
    } finally {
      if (alive.current && revision === actionRevision.current)
        setPending(false);
    }
  }
  const phase = voice?.phase ?? "unavailable",
    connected = phase === "connected";
  const idle = ["idle", "failed"].includes(phase);
  const inCall = [
    "preparing",
    "offering",
    "ringing",
    "negotiating",
    "connected",
    "reconnecting",
  ].includes(phase);
  const permissionDenied =
    voice?.microphonePermission === "denied" ||
    voice?.microphonePermission === "restricted";
  const label: Record<string, string> = {
    disabled: "Voice is off",
    idle: "Ready for calls",
    failed: "Call ended",
    preparing: "Preparing your microphone…",
    offering: "Waiting for an answer…",
    ringing: "Incoming call",
    negotiating: "Connecting audio…",
    connected: "Connected",
    reconnecting: "Reconnecting audio…",
    unavailable: "Voice unavailable",
  };
  return (
    <section
      id="voicePanel"
      className="voice-panel"
      data-call-id={voice?.callId ?? ""}
      aria-label="Voice calls"
    >
      <div className="voice-heading">
        <div>
          <span className="eyebrow">PUSH TO TALK</span>
          <h3 id="voiceState" aria-live="polite">
            {label[phase] ?? "Voice unavailable"}
          </h3>
        </div>
        <label className="check">
          <input
            id="voiceConsent"
            type="checkbox"
            checked={voice?.enabled ?? false}
            disabled={!online || !voice?.supported}
            onChange={(event) => {
              void act({ action: "consent", enabled: event.target.checked });
            }}
          />
          Allow voice this connection
        </label>
      </div>
      <p className="hint">
        Calls are for contacts you approve. Answering or calling requests
        microphone access and starts muted. Your microphone stays on during a
        call; audio is sent only while you hold the talk button. Voice
        permission resets when you disconnect.
      </p>
      {(voice?.peerId || peerId) && (
        <p className="voice-peer">
          {inCall ? "Call with" : "Selected"}: App contact{" "}
          {(voice?.peerId || peerId).slice(0, 12)}
        </p>
      )}
      <div className="voice-actions">
        {idle && (
          <button
            id="callContact"
            type="button"
            disabled={
              pending ||
              !online ||
              !voice?.enabled ||
              !peerId ||
              !discovered ||
              permissionDenied
            }
            onClick={() => {
              void act({ action: "call", peerId, consent: true });
            }}
          >
            Call selected contact
          </button>
        )}
        {phase === "ringing" && (
          <button
            id="answerCall"
            type="button"
            disabled={pending || permissionDenied}
            onClick={() => {
              if (voice?.callId)
                void act({
                  action: "answer",
                  callId: voice.callId,
                  consent: true,
                });
            }}
          >
            Answer · microphone on
          </button>
        )}
        {inCall && (
          <button
            id="hangupCall"
            className="secondary"
            type="button"
            onClick={() => {
              void act({ action: "hangup", callId: voice?.callId ?? null });
            }}
          >
            {phase === "ringing" ? "Decline" : "End call"}
          </button>
        )}
        {connected && (
          <button
            id="pushToTalk"
            type="button"
            className="ptt"
            aria-pressed={held}
            onPointerDown={(event) => {
              if (event.button === 0 && active && !holding.current) {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                holding.current = true;
                starting.current = true;
                setHeld(true);
              }
            }}
            onPointerUp={release}
            onPointerCancel={release}
            onLostPointerCapture={release}
            onPointerLeave={release}
            onBlur={release}
            onKeyDown={(event) => {
              if (
                (event.code === "Space" || event.code === "Enter") &&
                active
              ) {
                event.preventDefault();
                if (!event.repeat && !holding.current) {
                  holding.current = true;
                  starting.current = true;
                  setHeld(true);
                }
              }
            }}
            onKeyUp={(event) => {
              if (event.code === "Space" || event.code === "Enter") {
                event.preventDefault();
                release();
              }
            }}
            onContextMenu={(event) => event.preventDefault()}
          >
            {held ? "Release to mute" : "Hold to talk"}
          </button>
        )}
      </div>
      <p id="voiceCapture" className="hint" aria-live="polite">
        {voice?.capturing === null
          ? voice.error === "MEDIA_TEARDOWN_FAILED"
            ? "Microphone state unknown. Disconnect cleanup could not be confirmed."
            : "Microphone state is being checked."
          : voice?.capturing
            ? voice.transmitting
              ? "Microphone on · transmitting"
              : "Microphone on · transmission muted"
            : "Microphone off"}
      </p>
      {connected && voice && <CallOutput key={voice.callId} voice={voice} />}
      {connected && voice && (
        <div id="callQuality" className="hint">
          <span>
            Network RTT:{" "}
            {voice.quality.roundTripMs === null
              ? "Unavailable"
              : `${voice.quality.roundTripMs.toFixed(1)} ms`}
          </span>
          {" · "}
          <span>
            Inbound jitter:{" "}
            {voice.quality.jitterMs === null
              ? "Unavailable"
              : `${voice.quality.jitterMs.toFixed(1)} ms`}
          </span>
          {" · "}
          <span>
            Lost packets:{" "}
            {voice.quality.packetsLost === null
              ? "Unavailable"
              : voice.quality.packetsLost}
          </span>
          <p>
            Loss is cumulative for this inbound audio stream. RTT measures the
            network path, not mouth-to-ear latency.
          </p>
        </div>
      )}
      {permissionDenied && (
        <p className="notice">
          Windows microphone access is blocked. Enable access in Windows privacy
          settings to place or answer calls.
        </p>
      )}
      <output id="voiceNotice" className="notice" aria-live="polite">
        {notice ||
          (voice?.error
            ? "The call ended because media or connection state could not be confirmed."
            : "")}
      </output>
    </section>
  );
}
