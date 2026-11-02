# 0.1.0 Alpha 1 — identity, interface and upstream media

This is an unsigned experimental Windows x64 preview. It is not production-ready.

Published at [the public GitHub alpha release](https://github.com/Potato4507/LobbyMesh/releases/tag/v0.1.0-alpha.1).
The repository is public, default branch is `main`, MIT is recognized by GitHub,
and anonymous installer/checksum access was verified. The tag points to release
source `8c55948594268be77d77c09af3b4b9f2fe8b6360`, whose main-branch CI passed
(run41384942106). Later publication-evidence commits do not change the runtime.

## Downloads

[Windows setup](https://github.com/Potato4507/LobbyMesh/releases/download/v0.1.0-alpha.1/LobbyMesh-Setup.exe)
is a single per-user executable, 171,471,954 bytes. SHA256:

```text
e806f287de848abe36c4072fef6a36f943a2b1456a1c4296b34ade43a01bf275
```

Run setup; no Node installation or manual network addresses are required.
[Detailed installation and troubleshooting](INSTALLATION.md) and the bundled
[quick start](FRIEND_QUICK_START.txt) cover first use, account linking, mutual
approval, conversations, voice, overlay, updates and removal.

## Changes

- Preserves existing OS-protected signing identities; exposes full permanent
  256-bit app IDs beside display names and optional canonical Roblox usernames.
- Public-profile proof independently checked at review and approval. Signed
  claims, authenticated app keys, persistent account/key pins and downgrade
  rejection protect linked account labels. No Roblox credentials are collected.
- Refreshed slate/lavender desktop, navigation, status and identity cards,
  readable conversation names and full-ID details. Compact layout checked.
- Keeps HyperDHT/Noise encrypted chat; integrates pinned upstream adapter.js and
  SDP parsing for voice. Production calls use public STUN for direct-route
  discovery, with no paid TURN fallback.
- Repairs overlay capture refresh being blocked behind a held dashboard read;
  actual failures still show unknown and preserve End/unsent-draft ownership.
- Adds user-selected MIT licensing, contribution instructions, component
  provenance, expanded installation docs and a single-file NSIS installer.

## Verification

Clean runtime source: `970291408051faf0e2115534221d2a26e3a42531`.
Clean installer source: `973e3e1434b9d76200a13f3e250ce45be90dc85a`.

The full eleven-stage Windows pipeline passed: typecheck, lint, Node suite
(272 total, 271 pass, one POSIX-only skip), build, all seven native desktop modes,
identity UI, missing-binding Send recovery, synthetic voice calls, full independent
voice, actual copied executable and pinned payload integrity. GitHub verify run
41384243657 passed for the runtime source.

The final setup passed actual isolated installation, installed-payload integrity,
installed-executable launch, protected-key reopen and uninstall. Unknown files and
the test profile survived uninstall. Sandbox/context isolation remain enabled;
network and microphone default off. An extra normal-registration recheck was
blocked by automatic policy review and was not retried; earlier normal Start-menu/
Installed-apps registration checks remain separately recorded. No real user
profile was touched. Exact evidence: `evidence/public-preview-installer.json`,
`evidence/public-preview-delivery.json` and
`evidence/windows-identity-preview-summary.json`.

## Limits

Real different-home-network delivery, hardware microphone/audible output, actual
Roblox ownership/profile editing, game lifecycle and fresh-friend-machine
acceptance remain unverified. A physical Windows/Pi native-application reliability
failure remains open. Public STUN is not an audio relay and cannot guarantee
connectivity through restrictive NATs. Synthetic identity/audio and same-host
tests do not establish these acceptance gates. No updater or publisher signature.

Profile proof shows that Roblox's public About section contained the app-key
binding at check time. It is not Roblox endorsement, proof of age, a platform
OAuth attestation or session-membership verification. Compare full IDs using a
trusted existing conversation. See [identity guarantees](IDENTITY.md).

Third-party notices and the MIT project license accompany the application.
Contributions through forks/issues/pull requests are welcome; publishing rights
remain with maintainers. No history is rewritten or existing work discarded.
