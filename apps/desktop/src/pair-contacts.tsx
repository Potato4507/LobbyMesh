import { useEffect, useRef, useState } from "react";
import type { NetworkStatus } from "../../../packages/app-dht/src/lifecycle.js";
import type { ContactPreview } from "../../../packages/protocol/src/pairing.js";
import type { Preferences } from "../../../packages/protocol/src/preferences.js";

export function PairContacts({
  connection,
  disabled,
  onSaved,
}: {
  connection: NetworkStatus | null;
  disabled: boolean;
  onSaved: (preferences: Preferences) => void;
}) {
  const [generated, setGenerated] = useState<{
    code: string;
    expiresAt: number;
  } | null>(null);
  const [code, setCode] = useState(""),
    [preview, setPreview] = useState<ContactPreview | null>(null);
  const [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const [now, setNow] = useState(Date.now);
  const revision = useRef(0),
    current = useRef<ContactPreview | null>(null);
  const online = connection?.state === "online";
  const enabled = useRef(online && !disabled);
  enabled.current = online && !disabled;
  current.current = preview;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!online || disabled) {
      revision.current++;
      const ticket = current.current?.ticket;
      if (ticket) void window.companion.cancelPairing(ticket).catch(() => {});
      setPreview(null);
      setGenerated(null);
      setConsent(false);
      setBusy(false);
    }
  }, [online, disabled]);
  useEffect(
    () => () => {
      revision.current++;
      const ticket = current.current?.ticket;
      if (ticket) void window.companion.cancelPairing(ticket).catch(() => {});
    },
    [],
  );
  async function create() {
    if (busy || !enabled.current) return;
    const version = ++revision.current;
    setBusy(true);
    setNotice("");
    try {
      const value = await window.companion.createPairingCode();
      if (version === revision.current && enabled.current) setGenerated(value);
    } catch {
      if (version === revision.current)
        setNotice(
          "Could not create a contact code. Check your connection and try again.",
        );
    } finally {
      if (version === revision.current) setBusy(false);
    }
  }
  async function inspect() {
    if (busy || !enabled.current) return;
    const version = ++revision.current;
    setBusy(true);
    setNotice("");
    setConsent(false);
    try {
      if (current.current)
        await window.companion.cancelPairing(current.current.ticket);
      setPreview(null);
      const value = await window.companion.previewPairingCode(code);
      if (version === revision.current && enabled.current) setPreview(value);
      else void window.companion.cancelPairing(value.ticket).catch(() => {});
    } catch {
      if (version === revision.current)
        setNotice(
          "That code is invalid, expired, blocked or belongs to this app. Ask your contact for a fresh code.",
        );
    } finally {
      if (version === revision.current) setBusy(false);
    }
  }
  async function approve() {
    if (
      !preview ||
      !consent ||
      busy ||
      !enabled.current ||
      now >= preview.expiresAt
    )
      return;
    const version = ++revision.current;
    setBusy(true);
    setNotice("");
    try {
      const value = await window.companion.approvePairing(preview.ticket, true);
      if (version === revision.current && enabled.current) {
        onSaved(value);
        setPreview(null);
        setConsent(false);
        setCode("");
        setNotice(
          "Contact permission saved. Your contact must also approve your code before you can exchange messages.",
        );
      }
    } catch (error) {
      if (version === revision.current) {
        setPreview(null);
        setConsent(false);
        setNotice(
          error instanceof Error &&
            error.message.includes("CONTACT_APPROVAL_ROLLBACK_FAILED")
            ? "Permission rollback could not be saved. Review and remove the contact permission before restarting."
            : "Approval could not be confirmed. The code may have expired or the contact may be unreachable. Review contact permissions before trying again.",
        );
      }
    } finally {
      if (version === revision.current) setBusy(false);
    }
  }
  return (
    <section className="panel" id="pairContacts">
      <h2>Add a contact</h2>
      <p>
        Exchange short-lived LobbyMesh codes with someone you know. Both people
        must approve independently. Linked Roblox names are checked against a
        public profile proof. This does not verify age or session membership.
      </p>
      {!online && (
        <p className="hint">
          Enable peer discovery in Overview to exchange contact codes.
        </p>
      )}
      {disabled && (
        <p className="hint">
          Save your preference changes before adding a contact.
        </p>
      )}
      <button
        id="createPairingCode"
        type="button"
        disabled={!online || disabled || busy}
        onClick={() => {
          void create();
        }}
      >
        Create my contact code
      </button>
      {generated && generated.expiresAt > now && (
        <div className="pairing-code">
          <label htmlFor="myPairingCode">
            Your code · expires in{" "}
            {Math.max(0, Math.ceil((generated.expiresAt - now) / 1000))}s
          </label>
          <textarea
            id="myPairingCode"
            rows={2}
            readOnly
            value={generated.code}
            onFocus={(event) => event.target.select()}
          />
          <p className="hint">
            Share using a trusted channel. The code contains public app keys and
            your chosen name. Sharing it grants no one contact permission.
          </p>
        </div>
      )}
      <label htmlFor="pairingCode">Their contact code</label>
      <textarea
        id="pairingCode"
        rows={2}
        maxLength={4096}
        value={code}
        disabled={!online || disabled || busy}
        onChange={(event) => {
          setCode(event.target.value);
          setNotice("");
          const ticket = preview?.ticket;
          if (ticket)
            void window.companion.cancelPairing(ticket).catch(() => {});
          setPreview(null);
          setConsent(false);
        }}
      />
      <button
        id="previewPairingCode"
        type="button"
        className="secondary"
        disabled={!online || disabled || busy || !code.trim()}
        onClick={() => {
          void inspect();
        }}
      >
        Review contact
      </button>
      {preview && (
        <div className="pairing-preview" id="pairingPreview">
          <h3>
            <bdi>{preview.displayName}</bdi>
          </h3>
          <p className="identity-subtitle">
            {preview.roblox && preview.profileCheckedAt ? (
              <>
                @{preview.roblox.username}{" "}
                <span className="trust-chip">Public profile checked</span>
              </>
            ) : (
              <span className="trust-chip unlinked">
                Roblox account not linked
              </span>
            )}
          </p>
          <p className="hint">Permanent LobbyMesh ID</p>
          <code dir="ltr">{preview.peerId}</code>
          <p>App fingerprint · compare with your contact</p>
          <code dir="ltr">{preview.fingerprint}</code>
          <p className="hint">
            Signing proves control of this app key. A public profile check
            proves the matching key was posted on that Roblox profile at check
            time. Compare the full ID using a trusted conversation.
          </p>
          <label className="check">
            <input
              id="pairingConsent"
              type="checkbox"
              checked={consent}
              disabled={busy || now >= preview.expiresAt}
              onChange={(event) => setConsent(event.target.checked)}
            />
            <span>
              I confirmed this fingerprint with my contact and want to allow
              messages. Direct connections can reveal my network address.
            </span>
          </label>
          <button
            id="approvePairingCode"
            type="button"
            disabled={
              !consent ||
              busy ||
              now >= preview.expiresAt ||
              !online ||
              disabled
            }
            onClick={() => {
              void approve();
            }}
          >
            {busy
              ? "Authenticating and saving…"
              : preview.alreadyAuthorized
                ? "Refresh approved contact"
                : "Approve contact"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              revision.current++;
              void window.companion
                .cancelPairing(preview.ticket)
                .catch(() => {});
              setPreview(null);
              setConsent(false);
              setNotice("Review discarded. No contact permission was changed.");
            }}
          >
            Discard review
          </button>
          {now >= preview.expiresAt && (
            <p className="hint">This code expired. Request a fresh code.</p>
          )}
        </div>
      )}
      <output id="pairingNotice" className="notice" aria-live="polite">
        {notice}
      </output>
    </section>
  );
}
