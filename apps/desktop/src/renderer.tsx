import { type FormEvent, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { NetworkStatus } from "../../../packages/app-dht/src/lifecycle.js";
import type {
  OverlayStatus,
  OverlayVoiceView,
} from "../../../packages/protocol/src/overlay.js";
import type { ContactPreview } from "../../../packages/protocol/src/pairing.js";
import type { Preferences } from "../../../packages/protocol/src/preferences.js";
import type {
  VoiceAction,
  VoiceView,
} from "../../../packages/protocol/src/voice.js";
import type { DetectionStatus } from "../../../packages/session/src/windows-logs.js";
import { Messages } from "./messages.js";
import type { ContactView, MessageView } from "./messaging.js";
import { OverlaySettings } from "./overlay-settings.js";
import { PairContacts } from "./pair-contacts.js";
import type { DesktopSessionStatus } from "./sessions.js";

declare global {
  interface Window {
    companion: {
      status(): Promise<{
        network: string;
        session: string;
        detection: DetectionStatus;
        matching: DesktopSessionStatus;
        microphone: string;
        preferences: string;
        connection: NetworkStatus;
      }>;
      network(enabled: boolean): Promise<NetworkStatus>;
      voice(): Promise<VoiceView>;
      voiceAction(request: VoiceAction): Promise<VoiceView>;
      overlay(): Promise<OverlayStatus>;
      overlayVoice(): Promise<OverlayVoiceView>;
      endOverlayCall(request: { callId: string }): Promise<OverlayVoiceView>;
      overlayMode(interactive: boolean): Promise<OverlayStatus>;
      messaging(): Promise<{ available: boolean; contacts: ContactView[] }>;
      messages(peerId: string): Promise<MessageView[]>;
      sendText(
        peerId: string,
        text: string,
      ): Promise<{ id: string; attempts: number; status: "acknowledged" }>;
      clearMessages(peerId: string): Promise<{ cleared: true }>;
      preferences(): Promise<Preferences>;
      updatePreferences(request: unknown): Promise<Preferences>;
      contact(action: string, peerId: string): Promise<Preferences>;
      createPairingCode(): Promise<{ code: string; expiresAt: number }>;
      previewPairingCode(code: string): Promise<ContactPreview>;
      cancelPairing(ticket: string): Promise<{ canceled: true }>;
      approvePairing(ticket: string, consent: boolean): Promise<Preferences>;
    };
  }
}
function App() {
  const views = {
    overview: {
      label: "Overview",
      title: "Stay connected.",
      description: "Your server. Your conversations.",
    },
    messages: {
      label: "Conversations",
      title: "Conversations",
      description: "Online chat with the contacts you approve.",
    },
    preferences: {
      label: "Preferences",
      title: "Your preferences",
      description: "Choose your presence and manage contact permissions.",
    },
    overlay: {
      label: "Overlay",
      title: "In-game companion",
      description: "Keep the widgets you need close at hand.",
    },
  };
  type View = keyof typeof views;
  const [view, setView] = useState<View>("overview");
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const destination = document.getElementById(`view-${view}`);
    if (destination && !destination.hidden) {
      title.current?.focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }
  }, [view]);
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [notice, setNotice] = useState("Loading your preferences…");
  const [connection, setConnection] = useState<NetworkStatus | null>(null);
  const [detection, setDetection] = useState<DetectionStatus | null>(null);
  const [matching, setMatching] = useState<DesktopSessionStatus | null>(null);
  const [microphone, setMicrophone] = useState("off");
  const [networkPending, setNetworkPending] = useState(false);
  const [networkNotice, setNetworkNotice] = useState("");
  const [pending, setPending] = useState(false),
    [dirty, setDirty] = useState(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      const status = await window.companion.status();
      if (active) {
        setConnection(status.connection);
        setDetection(status.detection);
        setMatching(status.matching);
        setMicrophone(status.microphone);
      }
      if (status.preferences !== "ready") throw new Error("UNAVAILABLE");
      const value = await window.companion.preferences();
      if (active) {
        setPreferences(value);
        setNotice("");
      }
    })().catch(() => {
      if (active)
        setNotice(
          "Your preferences could not be opened. Close other LobbyMesh windows and check your local settings before trying again.",
        );
    });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true,
      busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void window.companion
        .status()
        .then((status) => {
          if (active) {
            setConnection(status.connection);
            setDetection(status.detection);
            setMatching(status.matching);
            setMicrophone(status.microphone);
          }
        })
        .catch(() => {
          if (active) setNetworkNotice("Connection status is unavailable.");
        })
        .finally(() => {
          busy = false;
        });
    }, 1000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  async function changeNetwork(enabled: boolean) {
    setNetworkPending(true);
    setNetworkNotice("");
    try {
      setConnection(await window.companion.network(enabled));
      setPreferences((previous) =>
        previous ? { ...previous, networkEnabled: enabled } : previous,
      );
    } catch {
      setNetworkNotice(
        enabled
          ? "Could not save permission to connect. Discovery has not been enabled."
          : "Could not save the startup preference. Check connection status before reopening LobbyMesh.",
      );
    } finally {
      setNetworkPending(false);
    }
  }
  const state = connection?.state;
  const detectionLabel = !detection
    ? "Checking session…"
    : {
        disabled: "Detection off",
        unsupported: "Unsupported on this device",
        waiting: "Waiting for Roblox",
        detected: "Local session detected",
        incomplete: "Session details incomplete",
        scanning: "Reading player session…",
        stale: "Waiting for fresh game logs",
        ambiguous: "Session source ambiguous",
        unavailable: "Game logs unavailable",
      }[detection.state];
  const peers = connection?.peers ?? 0;
  const matchingLabel =
    !matching || matching.state === "offline"
      ? "Session matching is offline."
      : matching.state === "error"
        ? "Session matching is incomplete. Retrying automatically."
        : matching.state === "matching"
          ? "Finding opted-in companions in this session…"
          : matching.state === "consent-required"
            ? "Enable session presence to find companions."
            : matching.state === "ready"
              ? `${matching.participants} ${matching.participants === 1 ? "companion" : "companions"} found in this session. Contact permission is separate.`
              : "Waiting for supported session evidence.";
  const networkLabel =
    state === "online"
      ? peers
        ? `${peers} authenticated ${peers === 1 ? "peer" : "peers"}`
        : "Discovering peers"
      : state === "starting"
        ? "Connecting…"
        : state === "retrying"
          ? "Retrying discovery…"
          : state === "stopping"
            ? "Disconnecting…"
            : state === "suspended"
              ? "Paused"
              : state === "error"
                ? "Connection unavailable"
                : state === "offline"
                  ? "Offline"
                  : "Checking connection…";
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!preferences || pending) return;
    setPending(true);
    try {
      setPreferences(
        await window.companion.updatePreferences({
          displayName: preferences.displayName,
          sessionConsent: preferences.sessionConsent,
        }),
      );
      setDirty(false);
      setNotice("Saved on this device.");
    } catch {
      setNotice(
        "Could not save your changes. Your saved settings have been preserved.",
      );
    } finally {
      setPending(false);
    }
  }
  async function contact(action: string, peerId: string) {
    setPending(true);
    try {
      setPreferences(await window.companion.contact(action, peerId));
      setNotice("Contact preference saved.");
    } catch {
      setNotice("Could not save the contact change. Please try again.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            LM
          </span>
          <div>
            <strong>LobbyMesh</strong>
            <span className="brand-caption">Your companion</span>
          </div>
        </div>
        <nav aria-label="Companion navigation">
          {(Object.keys(views) as View[]).map((key) => (
            <button
              type="button"
              key={key}
              data-view={key}
              aria-current={view === key ? "page" : undefined}
              aria-controls={`view-${key}`}
              aria-label={
                key === "preferences" && dirty
                  ? "Preferences, unsaved changes"
                  : undefined
              }
              onClick={() => setView(key)}
            >
              {views[key].label}
              {key === "preferences" && dirty && (
                <span className="unsaved-dot" aria-hidden="true" />
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-status">
          <span
            className={`connection-dot ${state === "online" ? "online" : ""}`}
            aria-hidden="true"
          />
          <strong>{state === "online" ? "Connected" : networkLabel}</strong>
          <p>
            {microphone === "capturing"
              ? "Microphone on"
              : microphone === "unknown"
                ? "Microphone state unknown"
                : "Microphone off"}
            <br />
            Development preview
          </p>
        </div>
      </aside>
      <main className="workspace">
        <header>
          <div>
            <p className="eyebrow">
              YOUR COMPANION / {views[view].label.toUpperCase()}
            </p>
            <h1 id="viewTitle" ref={title} tabIndex={-1}>
              {views[view].title}
            </h1>
            <p className="view-description">{views[view].description}</p>
          </div>
          <span className="badge">
            {state === "online" ? "Connected" : networkLabel}
          </span>
        </header>
        <section className="status-grid" aria-label="Current connection status">
          <div>
            <span className="status-label">Peer network</span>
            <strong>{networkLabel}</strong>
          </div>
          <div>
            <span className="status-label">Roblox session</span>
            <strong id="sessionStatus">{detectionLabel}</strong>
          </div>
          <div>
            <span className="status-label">Microphone</span>
            <strong id="microphoneStatus">
              {microphone === "capturing"
                ? "On · call in progress"
                : microphone === "unknown"
                  ? "Unknown"
                  : "Off"}
            </strong>
          </div>
        </section>
        {detection?.reason && (
          <output className="hint" id="sessionSourceNotice">
            {
              {
                "multiple-player-processes":
                  "More than one Roblox client is running. Close unused clients so LobbyMesh can select one local session.",
                "multiple-player-logs":
                  "Multiple player logs match this run. LobbyMesh cannot select a session confidently yet.",
                "process-query-failed":
                  "Windows player activity is unavailable. Session detection will retry automatically.",
                "log-read-failed":
                  "Player logs could not be read. Session detection will retry automatically.",
              }[detection.reason]
            }
          </output>
        )}
        <div id="view-overview" hidden={view !== "overview"}>
          <section className="panel">
            <h2>Peer discovery</h2>
            <p>
              Connect automatically to other running LobbyMesh apps. Discovery
              can reveal your network address to peers. Once enabled, it starts
              when you open LobbyMesh.
            </p>
            <div className="connection-actions">
              <button
                id="networkControl"
                type="button"
                disabled={
                  !preferences ||
                  !connection ||
                  networkPending ||
                  state === "stopping"
                }
                onClick={() => {
                  void changeNetwork(
                    connection?.error === "STOP_FAILED"
                      ? false
                      : state === "error"
                        ? true
                        : !connection?.enabled,
                  );
                }}
              >
                {connection?.error === "STOP_FAILED"
                  ? "Retry disconnect"
                  : state === "error"
                    ? "Retry connection"
                    : connection?.enabled
                      ? "Disconnect"
                      : "Enable peer discovery"}
              </button>
              {state === "error" && connection?.enabled && (
                <button
                  type="button"
                  className="secondary"
                  disabled={networkPending}
                  onClick={() => {
                    void changeNetwork(false);
                  }}
                >
                  Disconnect
                </button>
              )}
            </div>
            <p className="hint">
              A connection does not verify a Roblox account or give someone
              permission to contact you.
            </p>
            <p id="matchingStatus" className="hint" aria-live="polite">
              {matchingLabel}
            </p>
            <output id="networkNotice" className="notice" aria-live="polite">
              {networkNotice ||
                (connection?.error === "START_TIMEOUT"
                  ? "Connection timed out. Check your network and try again."
                  : connection?.error === "START_FAILED"
                    ? state === "retrying"
                      ? "Discovery is temporarily unavailable. Retrying automatically."
                      : "Could not connect. You can retry or stay offline."
                    : connection?.error === "CREDENTIALS_UNAVAILABLE"
                      ? "Protected credentials could not be opened on this device. Existing keys are preserved; no plaintext fallback is used."
                      : connection?.error === "STOP_FAILED"
                        ? "Connection cleanup could not be confirmed. Try disconnecting again."
                        : "")}
            </output>
          </section>
        </div>
        <div id="view-preferences" hidden={view !== "preferences"}>
          <PairContacts
            connection={connection}
            disabled={dirty || pending}
            onSaved={setPreferences}
          />
          <section className="panel">
            <h2>Stay in control</h2>
            <p>
              Choose how you appear to other LobbyMesh participants. Session
              detection reads local Windows player logs when enabled. Voice
              controls are in Conversations and reset when you disconnect.
            </p>
            {preferences && (
              <form
                onSubmit={(event) => {
                  void save(event);
                }}
              >
                <label htmlFor="displayName">Your companion name</label>
                <input
                  id="displayName"
                  maxLength={64}
                  value={preferences.displayName}
                  disabled={pending}
                  onChange={(event) => {
                    setPreferences({
                      ...preferences,
                      displayName: event.target.value,
                    });
                    setDirty(true);
                    setNotice("");
                  }}
                />
                <p className="hint">
                  A name you choose for LobbyMesh. This does not verify a Roblox
                  account.
                </p>
                <label className="check">
                  <input
                    id="sessionConsent"
                    type="checkbox"
                    checked={preferences.sessionConsent}
                    disabled={pending}
                    onChange={(event) => {
                      setPreferences({
                        ...preferences,
                        sessionConsent: event.target.checked,
                      });
                      setDirty(true);
                      setNotice("");
                    }}
                  />
                  <span>
                    Detect my Roblox session from local logs and allow companion
                    presence discovery.
                  </span>
                </label>
                <p className="hint">
                  Off by default. Raw logs, account details and server addresses
                  stay out of the UI and public discovery. Detection depends on
                  supported player log events and cannot verify Roblox identity.
                  Enable peer discovery separately to connect.
                </p>
                <button
                  type="submit"
                  disabled={
                    pending || !dirty || !preferences.displayName.trim()
                  }
                >
                  {pending ? "Saving…" : "Save preferences"}
                </button>
              </form>
            )}
            <output
              id="preferencesNotice"
              aria-live="polite"
              className="notice"
            >
              {notice ||
                (dirty
                  ? "You have unsaved changes."
                  : "Your preferences stay on this device.")}
            </output>
          </section>
          <section className="panel">
            <h2>Contact permissions</h2>
            <p>
              Finding someone in a session does not give them permission to
              contact you.
            </p>
            {preferences &&
              preferences.allowedPeers.length === 0 &&
              preferences.blockedPeers.length === 0 && (
                <p className="empty">No contact permissions yet.</p>
              )}
            {preferences?.allowedPeers.map((id) => (
              <div className="contact-row" key={id}>
                <span>
                  App contact <code>{id.slice(0, 12)}</code>
                </span>
                <div>
                  <button
                    type="button"
                    className="secondary"
                    disabled={pending || dirty}
                    onClick={() => {
                      void contact("revoke", id);
                    }}
                  >
                    Remove permission
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={pending || dirty}
                    onClick={() => {
                      void contact("block", id);
                    }}
                  >
                    Block
                  </button>
                </div>
              </div>
            ))}
            {preferences?.blockedPeers.map((id) => (
              <div className="contact-row" key={id}>
                <span>
                  Blocked app contact <code>{id.slice(0, 12)}</code>
                </span>
                <button
                  type="button"
                  className="secondary"
                  disabled={pending || dirty}
                  onClick={() => {
                    void contact("unblock", id);
                  }}
                >
                  Unblock
                </button>
              </div>
            ))}
            <p className="hint">
              Unblocking does not grant contact permission. Direct connections
              can reveal network addresses to connected peers.
            </p>
          </section>
        </div>
        <div id="view-messages" hidden={view !== "messages"}>
          <Messages
            onMicrophone={setMicrophone}
            active={view === "messages"}
            connection={connection}
            onAddContact={() => setView("preferences")}
          />
        </div>
        <div id="view-overlay" hidden={view !== "overlay"}>
          {dirty && (
            <p className="hint">
              Save your preference changes before changing the overlay.
            </p>
          )}
          {preferences && (
            <OverlaySettings
              preferences={preferences}
              disabled={dirty || pending}
              onSaved={setPreferences}
            />
          )}
        </div>
        <footer>
          Independent companion · No paid owner-operated backend · No Roblox
          process modification
        </footer>
      </main>
    </div>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("MISSING_ROOT");
createRoot(root).render(<App />);
