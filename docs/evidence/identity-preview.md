# Identity and interface preview verification

The existing Ed25519 identity and OS-protected private key are preserved. A full
256-bit key ID is displayed alongside a chosen name and optional checked Roblox
username. Signed invitations now bind the optional numeric Roblox account and
canonical username; old app-key-only codes remain clearly unlinked.

New main-process public-profile checks use only documented fixed Roblox HTTPS
user endpoints. Profile proof contains numeric account ID and full app ID.
Review and approval independently check the current profile; app authentication
and explicit two-sided permission remain required. Pins survive reopen and deny
silent account/key replacement or downgrade. Roblox APIs unavailable, invalid
responses, bans, missing proof, redirects, oversize bodies and shutdown fail
closed. No Roblox credentials or client internals are accessed.

Focused tests pass: signed-claim alteration/removal, copied name and wrong-key
claim, canonical username, account/key binding across reopen, downgrade, failed
review and bypass via unchecked preview, proof removal between review and
approval, positive authenticated approval, competing pinned key, oversize/error/
banned responses and late confirmation after service shutdown.

Full Node suite passed 270 total, 269 pass, one POSIX-only skip. Typecheck and
lint pass. All seven existing native desktop modes pass without assertion or
deadline changes. A dedicated 30-second native identity UI check also passes:
real renderer/preload/main-process identity endpoints, UI display-name save,
generated public proof, rejected missing proof, successful synthetic profile
link, signed code creation, rejected impostor, checked contact preview, explicit
consent still required and no horizontal overflow at 760 pixels.

Native screenshots were visually inspected at normal and compact sizes. The
refresh adds a coherent lavender/slate theme, clearer navigation, compact status
cards, identity cards, readable names and full-ID details. Synthetic screenshots
do not represent a real person's Roblox account. `identity-native-ui.json`
contains the exact native observation; the script deliberately states
`externalRobloxOwnership:false` and `publicNetwork:false`.

An actual read-only GET to `https://users.roblox.com/v1/users/1` returned HTTP200,
numeric ID1, canonical username Roblox, string description and boolean banned
flag. This establishes current public API response compatibility, not ownership
of any user's account or universal API availability. Real profile editing was
not performed. Source: [official Roblox users API](https://create.roblox.com/docs/cloud/reference/domains/users).

User explicitly authorized repository publication, release upload and MIT
licensing. `publication-history-scan.json` records a bounded scan of all 2,734
locally reachable objects (1,472 blobs) for common credential/private-key formats
and known private Pi target/credential-path markers, with no findings. This is
not an exhaustive security certification. No history is reset or rewritten.

The refreshed application still requires a clean complete Windows pipeline and
new installer before publishing. Keep actual real-external connectivity, real
Roblox ownership/profile editing, hardware audio and production readiness open.
