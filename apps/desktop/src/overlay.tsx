import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  OverlayStatus,
  OverlayWidget,
} from "../../../packages/protocol/src/overlay.js";
import { Messages } from "./messages.js";

type Status = Awaited<ReturnType<Window["companion"]["status"]>>;
function Overlay() {
  const [status, setStatus] = useState<Status | null>(null),
    [overlay, setOverlay] = useState<OverlayStatus | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true,
      busy = false;
    const poll = () => {
      if (busy) return;
      busy = true;
      void Promise.all([window.companion.status(), window.companion.overlay()])
        .then(([current, view]) => {
          if (active) {
            setStatus(current);
            setOverlay(view);
            setFailed(false);
          }
        })
        .catch(() => {
          if (active) {
            setStatus(null);
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
  };
  return (
    <main className="overlay-shell">
      <header>
        <div>
          <p className="eyebrow">LOBBYMESH</p>
          <span>
            {overlay?.interactive
              ? "Interaction mode"
              : "Click-through · Ctrl + Shift + Space"}
          </span>
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
      {failed ? (
        <p role="alert">Companion status unavailable.</p>
      ) : (
        overlay?.preferences.widgets.map((widget) => (
          <div key={widget}>{widgets[widget]()}</div>
        ))
      )}
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("MISSING_ROOT");
createRoot(root).render(<Overlay />);
