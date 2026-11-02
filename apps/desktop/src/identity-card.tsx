import { useEffect, useRef, useState } from "react";
import type {
  AccountView,
  RobloxClaim,
} from "../../../packages/protocol/src/roblox-account.js";

export function IdentityCard({
  online,
  displayName,
}: {
  online: boolean;
  displayName: string;
}) {
  const [account, setAccount] = useState<AccountView | null>(null);
  const [username, setUsername] = useState("");
  const [challenge, setChallenge] = useState<
    (RobloxClaim & { proof: string }) | null
  >(null);
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    let active = true;
    setBusy(false);
    setNotice("");
    setChallenge(null);
    setAccount(null);
    if (online)
      void window.companion
        .account()
        .then((value) => {
          if (active) setAccount(value);
        })
        .catch(() => {
          if (active)
            setNotice("Your identity is unavailable for this connection.");
        });
    return () => {
      active = false;
      generation.current++;
    };
  }, [online]);
  async function begin() {
    if (!online || busy) return;
    const revision = generation.current;
    setBusy(true);
    setNotice("");
    try {
      const value = await window.companion.beginAccount(username.trim());
      if (revision === generation.current) setChallenge(value);
    } catch {
      if (revision === generation.current)
        setNotice(
          "Could not find that Roblox username. Check the spelling and your connection.",
        );
    } finally {
      if (revision === generation.current) setBusy(false);
    }
  }
  async function confirm() {
    if (!challenge || !online || busy) return;
    const revision = generation.current;
    setBusy(true);
    setNotice("");
    try {
      const value = await window.companion.confirmAccount({
        userId: challenge.userId,
        username: challenge.username,
      });
      if (revision !== generation.current) return;
      setAccount(value);
      setChallenge(null);
      if (revision === generation.current)
        setNotice(
          "Profile linked. Keep the proof in your About section so new contacts can check it.",
        );
    } catch {
      if (revision === generation.current)
        setNotice(
          "The profile proof could not be confirmed. Check your public About section and try again. Existing account links cannot be replaced.",
        );
    } finally {
      if (revision === generation.current) setBusy(false);
    }
  }
  return (
    <section className="panel identity-card" aria-labelledby="identityHeading">
      <div className="section-eyebrow">YOUR IDENTITY</div>
      <div className="identity-heading">
        <div className="identity-avatar" aria-hidden="true">
          {displayName.trim().slice(0, 1).toUpperCase() || "L"}
        </div>
        <div>
          <h2 id="identityHeading">
            <bdi>{displayName}</bdi>
          </h2>
          <p>
            {account?.roblox ? (
              <>
                @{account.roblox.username}{" "}
                <span className="trust-chip">Profile linked</span>
              </>
            ) : (
              "Link your Roblox profile so friends know it’s you."
            )}
          </p>
        </div>
      </div>
      {account && (
        <details className="identity-key">
          <summary>
            Permanent LobbyMesh ID · {account.peerId.slice(0, 12)}…
          </summary>
          <code dir="ltr">{account.peerId}</code>
          <p className="hint">
            This full ID identifies your app key. Names can be copied; this key
            cannot be used without its private signing key. Reinstalling with a
            new profile creates a different ID.
          </p>
        </details>
      )}
      {!online ? (
        <p className="hint">
          Enable peer discovery to open your protected app identity.
        </p>
      ) : (
        <div className="account-link-form">
          <label htmlFor="robloxUsername">Roblox username</label>
          <div className="inline-field">
            <span aria-hidden="true">@</span>
            <input
              id="robloxUsername"
              autoComplete="off"
              maxLength={20}
              placeholder="Your actual username"
              value={username}
              disabled={busy}
              onChange={(event) => {
                setUsername(event.target.value);
                setChallenge(null);
              }}
            />
            <button
              type="button"
              id="beginAccountLink"
              disabled={busy || !username.trim()}
              onClick={() => {
                void begin();
              }}
            >
              {account?.roblox ? "Refresh link" : "Link profile"}
            </button>
          </div>
          <p className="hint">
            We read only public profile information. Never share a Roblox
            password or login cookie.
          </p>
        </div>
      )}
      {online && challenge && (
        <div className="profile-proof">
          <h3>Confirm @{challenge.username} is yours</h3>
          <p>
            Add this exact line to your Roblox profile’s public About section,
            then save it on Roblox.
          </p>
          <textarea
            id="accountProof"
            aria-label="Your Roblox profile proof"
            readOnly
            value={challenge.proof}
            rows={3}
            onFocus={(event) => event.target.select()}
          />
          <p className="hint">
            Only post a proof generated by your own app. It links this Roblox
            account to your full LobbyMesh ID. Contacts check it directly with
            Roblox; it is not an official Roblox badge or proof of age.
          </p>
          <button
            type="button"
            id="confirmAccountLink"
            disabled={busy}
            onClick={() => {
              void confirm();
            }}
          >
            {busy ? "Checking profile…" : "I saved it · check my profile"}
          </button>
        </div>
      )}
      <output className="notice" aria-live="polite">
        {notice}
      </output>
    </section>
  );
}
