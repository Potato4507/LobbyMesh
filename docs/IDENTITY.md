# Identity and impersonation protection

LobbyMesh shows your chosen display name, a linked Roblox `@username` when
checked, and your permanent full LobbyMesh ID. Roblox's numeric user ID is the
account anchor; display names and usernames can change. The app ID is SHA256 of
the Ed25519 public key. Independent key generation gives computationally unique
256-bit IDs; uniqueness is not based on names or a short visible prefix.
Existing protected identities are preserved. A fresh profile has a new identity.

To link a Roblox account, enter its actual username in Preferences. LobbyMesh
resolves its canonical username and numeric ID using Roblox's public user API.
It supplies a public proof line containing that numeric ID and your full app ID.
You explicitly add this line to your Roblox profile's public About section and
choose Check my profile. Only a matching public profile can complete the link.
Keep the line there for new contact approvals. Generate it in your own app;
never post an unsolicited proof supplied by somebody else.

The signed contact invitation binds the display name, Roblox claim, app ID,
transport key, nonce and expiration. A recipient checks Roblox directly during
review and again during approval, then authenticates the app key before granting
permission. An attacker copying a name, claim or public proof cannot sign for
the original key. A valid profile proof for a different key is rejected once
that account is pinned locally. A previously linked key cannot downgrade to an
unlinked invitation or silently switch Roblox accounts. Removing/blocking a
permission retains the security pin; contact permission is separate from trust.
Automatic key migration/account replacement is deliberately unavailable.

Refresh link accepts a changed username for the same numeric Roblox account.
After refreshing, exchange fresh codes. Approval checks fail closed if Roblox
is unavailable, the profile is banned, the username differs, proof is missing,
or the response is malformed/oversized. No username-only fallback grants checked
status. Requests use fixed HTTPS endpoints, omit credentials, reject redirects,
bound time/body size and stop when the connection is closed. Profile/contact
metadata stays local and is not published into the discovery DHT.

This proves only that Roblox's public profile contained this account/key binding
at the check time. It is not a platform-signed OAuth identity attestation, proof
of a human's legal identity, age, account safety or game membership. It does not
prevent compromise of Roblox accounts, stolen app private keys, malicious local
software or social engineering. Familiar display names are insufficient: compare
full IDs through an existing trusted channel. Unlinked contacts remain usable
with explicit app-key-only consent and no trusted Roblox username badge.

The app never reads Roblox passwords, cookies, client memory or private account
APIs. Only these documented public endpoints are used:
[Roblox users API](https://create.roblox.com/docs/cloud/reference/domains/users).

Verification: signed-claim tampering, copied names/claims, wrong-key proofs,
canonical names, account/key pins across reopen, downgrade rejection, lost proof
between review/approval, request limits and shutdown are covered in
`tests/roblox-profiles.test.ts`. Native UI checks use explicitly synthetic Roblox
responses; a separate read-only real API probe confirms the public response
shape, not ownership of a real user's account. No real Roblox profile was edited
by the agent.
