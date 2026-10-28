import { useEffect, useState } from "react";
import {
  OVERLAY_WIDGETS,
  type OverlayPreferences,
  type OverlayStatus,
  type OverlayWidget,
} from "../../../packages/protocol/src/overlay.js";
import type { Preferences } from "../../../packages/protocol/src/preferences.js";

export function OverlaySettings({
  preferences,
  disabled,
  onSaved,
}: {
  preferences: Preferences;
  disabled: boolean;
  onSaved: (preferences: Preferences) => void;
}) {
  const [pending, setPending] = useState(false),
    [notice, setNotice] = useState("");
  const [status, setStatus] = useState<OverlayStatus | null>(null);
  useEffect(() => {
    let active = true,
      busy = false;
    const poll = () => {
      if (busy) return;
      busy = true;
      void window.companion
        .overlay()
        .then((value) => {
          if (active) setStatus(value);
        })
        .catch(() => {
          if (active) setStatus(null);
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
  async function save(overlay: OverlayPreferences) {
    if (pending || disabled) return;
    setPending(true);
    setNotice("");
    try {
      onSaved(await window.companion.updatePreferences({ overlay }));
      setStatus(await window.companion.overlay());
    } catch {
      setNotice("Could not save overlay settings. Please try again.");
    } finally {
      setPending(false);
    }
  }
  const overlay = preferences.overlay,
    locked = disabled || pending;
  const labels: Record<OverlayWidget, string> = {
    network: "Connection",
    session: "Session presence",
    chat: "Approved chat",
  };
  const orderedWidgets = [
    ...overlay.widgets,
    ...OVERLAY_WIDGETS.filter((widget) => !overlay.widgets.includes(widget)),
  ];
  function move(widget: OverlayWidget, direction: -1 | 1) {
    const index = overlay.widgets.indexOf(widget),
      destination = index + direction;
    if (index < 0 || destination < 0 || destination >= overlay.widgets.length)
      return;
    const widgets = [...overlay.widgets];
    widgets.splice(index, 1);
    widgets.splice(destination, 0, widget);
    void save({ ...overlay, widgets });
  }
  return (
    <section className="panel" id="overlaySettings">
      <h2>In-game overlay</h2>
      <p>
        A separate companion window for borderless or windowed play. Choose the
        widgets you need; chat uses your existing contact permissions.
      </p>
      <label className="check">
        <input
          id="overlayEnabled"
          type="checkbox"
          checked={overlay.enabled}
          disabled={locked}
          onChange={(event) => {
            void save({ ...overlay, enabled: event.target.checked });
          }}
        />
        <span>Show overlay</span>
      </label>
      <div className="overlay-options">
        <label>
          Position
          <select
            id="overlayCorner"
            value={overlay.corner}
            disabled={locked}
            onChange={(event) => {
              void save({
                ...overlay,
                corner: event.target.value as OverlayPreferences["corner"],
              });
            }}
          >
            {["top-left", "top-right", "bottom-left", "bottom-right"].map(
              (corner) => (
                <option key={corner} value={corner}>
                  {corner.replace("-", " ")}
                </option>
              ),
            )}
          </select>
        </label>
        <label>
          Opacity
          <select
            id="overlayOpacity"
            value={overlay.opacity}
            disabled={locked}
            onChange={(event) => {
              void save({ ...overlay, opacity: Number(event.target.value) });
            }}
          >
            {[0.5, 0.7, 0.85, 0.95, 1].map((value) => (
              <option key={value} value={value}>
                {Math.round(value * 100)}%
              </option>
            ))}
          </select>
        </label>
      </div>
      <fieldset className="overlay-widgets">
        <legend>Overlay widgets</legend>
        {orderedWidgets.map((widget) => (
          <div className="widget-row" key={widget}>
            <label className="check">
              <input
                type="checkbox"
                data-widget={widget}
                checked={overlay.widgets.includes(widget)}
                disabled={
                  locked ||
                  (overlay.widgets.length === 1 &&
                    overlay.widgets.includes(widget))
                }
                onChange={(event) => {
                  void save({
                    ...overlay,
                    widgets: event.target.checked
                      ? [...overlay.widgets, widget]
                      : overlay.widgets.filter((item) => item !== widget),
                  });
                }}
              />
              <span>{labels[widget]}</span>
            </label>
            {overlay.widgets.includes(widget) && (
              <div className="widget-order">
                <button
                  type="button"
                  className="secondary"
                  aria-label={`Move ${labels[widget]} up`}
                  data-move-up={widget}
                  disabled={locked || overlay.widgets.indexOf(widget) === 0}
                  onClick={() => move(widget, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="secondary"
                  aria-label={`Move ${labels[widget]} down`}
                  disabled={
                    locked ||
                    overlay.widgets.indexOf(widget) ===
                      overlay.widgets.length - 1
                  }
                  onClick={() => move(widget, 1)}
                >
                  ↓
                </button>
              </div>
            )}
          </div>
        ))}
      </fieldset>
      <p className="hint">
        Move widgets up or down to arrange them. Ctrl + Shift + Space toggles
        interaction; otherwise clicks pass through to your game. Voice is not
        yet available. Exclusive fullscreen may hide the overlay.
      </p>
      <button
        id="overlayInteract"
        type="button"
        disabled={locked || status?.state !== "ready"}
        onClick={() => {
          void window.companion
            .overlayMode(!status?.interactive)
            .then(setStatus)
            .catch(() => setNotice("Overlay interaction is unavailable."));
        }}
      >
        {status?.interactive ? "Return input to game" : "Interact with overlay"}
      </button>
      <output className="notice" id="overlayNotice" aria-live="polite">
        {notice ||
          (status?.state === "unavailable"
            ? "The overlay could not open. Disable and enable it to retry."
            : status?.state === "unsupported"
              ? "Overlay is currently supported on Windows only."
              : overlay.enabled && status?.shortcutRegistered === false
                ? "Shortcut unavailable. Use the interaction button here."
                : status?.interactive
                  ? "Overlay accepts keyboard and mouse input."
                  : "Layout and widget choices are saved on this device.")}
      </output>
    </section>
  );
}
