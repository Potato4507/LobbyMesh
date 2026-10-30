import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  OverlayStatus,
  OverlayVoiceView,
  OverlayWidget,
} from "../../../packages/protocol/src/overlay.js";
import { voiceEndNotice } from "../../../packages/protocol/src/voice.js";
import { Messages } from "./messages.js";

type Status = Awaited<ReturnType<Window["companion"]["status"]>>;
function Overlay() {
  const [status, setStatus] = useState<Status | null>(null),
    [overlay, setOverlay] = useState<OverlayStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [voice, setVoice] = useState<OverlayVoiceView | null>(null);
  const [ending, setEnding] = useState(false),
    [callError, setCallError] = useState("");
  const voiceRevision = useRef(0),
    endPending = useRef(false);
  useEffect(() => {
    let active = true,
      busy = false;
    const poll = () => {
      if (busy) return;
      busy = true;
      const revision = voiceRevision.current;
      void Promise.all([
        window.companion.status(),
        window.companion.overlay(),
        window.companion.overlayVoice(),
      ])
        .then(([current, view, call]) => {
          if (active) {
            setStatus(current);
            setOverlay(view);
            setFailed(false);
            if (revision === voiceRevision.current && !endPending.current)
              setVoice(call);
          }
        })
        .catch(() => {
          if (active) {
            setStatus(null);
            // Keep only the last call token available for a stop attempt.
            // Failed dashboards render no cached capture/activity facts.
            setFailed(true);
          }
        })
        .finally(() => {
          busy = false;
        });
    };
    poll();
    const timer = setInterval(poll, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  async function endCall() {
    if (!voice?.callId || endPending.current) return;
    const callId = voice.callId;
    voiceRevision.current++;
    endPending.current = true;
    setEnding(true);
    setCallError("");
    try {
      setVoice(await window.companion.endOverlayCall({ callId }));
    } catch (error) {
      setVoice(null);
      setCallError(
        voiceEndNotice(error) ??
          "Could not confirm call ended. Check the main window.",
      );
    } finally {
      voiceRevision.current++;
      endPending.current = false;
      setEnding(false);
    }
  }
  const endControl = voice?.callId ? (
    overlay?.interactive ? (
      <button
        id="overlayEndCall"
        type="button"
        disabled={ending}
        onClick={() => {
          void endCall();
        }}
      >
        {ending ? "Ending call…" : "End call"}
      </button>
    ) : (
      <small>Interact with overlay to end call.</small>
    )
  ) : null;
  const widgets: Record<OverlayWidget, () => React.ReactNode> = {
    network: () => (
      <section className="panel" data-overlay-widget="network">
        <h2>Connection</h2>
        <strong>{status?.connection.state ?? "Unavailable"}</strong>
        <p>
          {status?.connection.peers ?? 0} authenticated peers ·{" "}
          <span id="overlayMicrophoneStatus">
            {status?.microphone === "capturing"
              ? "Microphone on"
              : status?.microphone === "off"
                ? "Microphone off"
                : "Microphone state unknown"}
          </span>
        </p>
      </section>
    ),
    session: () => (
      <section className="panel" data-overlay-widget="session">
        <h2>Session presence</h2>
        <strong>
          {status?.session === "detected"
            ? "Local Roblox session"
            : (status?.session ?? "Unavailable")}
        </strong>
        <p>
          {status?.matching.state === "ready"
            ? `${status.matching.participants} opted-in companions`
            : status?.matching.state === "error"
              ? "Matching incomplete — retrying"
              : "Waiting for session matching"}
        </p>
        <small>Local evidence · App identities are unverified</small>
      </section>
    ),
    chat: () => (
      <div data-overlay-widget="chat">
        <Messages connection={status?.connection ?? null} compact />
      </div>
    ),
    voice: () => (
      <section className="panel" data-overlay-widget="voice">
        <h2>Current call</h2>
        <strong id="overlayCallPhase">
          {voice
            ? ({
                disabled: "Voice off",
                idle: "No active call",
                offering: "Calling",
                ringing: "Incoming call",
                negotiating: "Connecting",
                preparing: "Preparing call",
                connected: "Connected",
                reconnecting: "Reconnecting",
                failed: "Call needs attention",
              }[voice.phase] ?? "Call status unavailable")
            : "Call status unavailable"}
        </strong>
        <p id="overlayCallCapture">
          {voice?.capturing === true
            ? "Microphone on"
            : voice?.capturing === false
              ? "Microphone off"
              : "Microphone state unknown"}{" "}
          ·{" "}
          {voice?.transmitting === true
            ? "Transmitting"
            : voice?.transmitting === false
              ? "Not transmitting"
              : "Transmission unknown"}
        </p>
        {!failed && endControl}
        <p>
          <small>Start, answer and hold to talk in the main window.</small>
        </p>
        {!failed && callError && (
          <p id="overlayCallError" role="alert">
            {callError}
          </p>
        )}
      </section>
    ),
  };
  return (
    <main className="overlay-shell">
      <header>
        <div>
          <p className="eyebrow">LOBBYMESH</p>
          <span>
            {overlay?.interactive
              ? "Interaction mode · Esc to return"
              : "Click-through · Ctrl + Shift + Space"}
          </span>
          <p className="hint">
            <output id="overlayCaptureStatus" aria-live="polite">
              {status?.microphone === "capturing"
                ? "LobbyMesh microphone on"
                : status?.microphone === "off"
                  ? "LobbyMesh microphone off"
                  : "LobbyMesh microphone state unknown"}
            </output>
          </p>
        </div>
        {overlay?.interactive && (
          <button
            id="overlayLock"
            type="button"
            className="secondary"
            onClick={() => {
              void window.companion
                .overlayMode(false)
                .then(setOverlay)
                .catch(() => setFailed(true));
            }}
          >
            Back to game
          </button>
        )}
      </header>
      {failed && (
        <section aria-label="Unavailable companion status">
          <p role="alert">Companion status unavailable.</p>
          {endControl}
          {callError && (
            <p id="overlayCallError" role="alert">
              {callError}
            </p>
          )}
        </section>
      )}
      {/* Keep drafts in their existing component owner through a transient
          status failure. Null status still suspends chat; hidden widgets grant
          no stale interaction or activity presentation. */}
      <div hidden={failed}>
        {overlay?.preferences.widgets.map((widget) => (
          <div key={widget}>{widgets[widget]()}</div>
        ))}
      </div>
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("MISSING_ROOT");
createRoot(root).render(<Overlay />);
