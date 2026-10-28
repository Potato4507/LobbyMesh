import { type FormEvent, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Preferences } from "../../../packages/protocol/src/preferences.js";

declare global {
  interface Window {
    companion: {
      status(): Promise<{
        network: string;
        session: string;
        microphone: string;
        preferences: string;
      }>;
      preferences(): Promise<Preferences>;
      updatePreferences(request: unknown): Promise<Preferences>;
      contact(action: string, peerId: string): Promise<Preferences>;
    };
  }
}
function App() {
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [notice, setNotice] = useState("Loading your preferences…");
  const [pending, setPending] = useState(false),
    [dirty, setDirty] = useState(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      const status = await window.companion.status();
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
    <main>
      <header>
        <div>
          <p className="eyebrow">LOBBYMESH · DEVELOPMENT PREVIEW</p>
          <h1>
            Your server.
            <br />
            <span>Your conversations.</span>
          </h1>
        </div>
        <span className="badge">Offline</span>
      </header>
      <section className="status-grid" aria-label="Current connection status">
        <div>
          <span className="status-label">Peer network</span>
          <strong>Offline</strong>
        </div>
        <div>
          <span className="status-label">Roblox session</span>
          <strong>Detection unavailable</strong>
        </div>
        <div>
          <span className="status-label">Microphone</span>
          <strong>Off</strong>
        </div>
      </section>
      <section className="panel">
        <h2>Stay in control</h2>
        <p>
          Peer networking and voice are not available in this desktop preview.
          You can set your local privacy preferences now. No connection or
          microphone capture starts here.
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
                }}
              />
              <span>
                Allow companion presence discovery when supported session
                detection is available.
              </span>
            </label>
            <p className="hint">
              Off by default. Changing this preference does not activate
              networking in this preview.
            </p>
            <button
              type="submit"
              disabled={pending || !dirty || !preferences.displayName.trim()}
            >
              {pending ? "Saving…" : "Save preferences"}
            </button>
          </form>
        )}
        <output aria-live="polite" className="notice">
          {notice ||
            (dirty
              ? "You have unsaved changes."
              : "Your preferences stay on this device.")}
        </output>
      </section>
      <section className="panel">
        <h2>Contact permissions</h2>
        <p>
          Finding someone in a session does not give them permission to contact
          you.
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
          Unblocking does not grant contact permission. Direct connections can
          reveal network addresses to connected peers.
        </p>
      </section>
      <footer>
        Independent companion · No paid owner-operated backend · No Roblox
        process modification
      </footer>
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("MISSING_ROOT");
createRoot(root).render(<App />);
