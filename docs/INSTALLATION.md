# Install and use LobbyMesh

## Windows download

Use the Windows x64 setup from the
[official release page](https://github.com/Potato4507/LobbyMesh/releases/tag/v0.1.0-alpha.1).
Download `LobbyMesh-Setup.exe`. Node, pnpm, Git, a Raspberry Pi, a server account
and manual IP/port entry are not required to run the app.

This is an unsigned experimental alpha, not a production-ready release. The
release includes a `.sha256` file. An optional checksum check in PowerShell is:

```powershell
Get-FileHash -Algorithm SHA256 -LiteralPath "$env:USERPROFILE\Downloads\LobbyMesh-Setup.exe"
```

Compare the full result with the release checksum. Keep Windows security
enabled. Only obtain builds from a source you trust.

1. Close an existing LobbyMesh window, then run setup.
2. Setup installs for your current Windows account, without administrator access.
3. Leave **Open LobbyMesh** checked on the finish page, or find LobbyMesh in Start.

Files install beneath `%LOCALAPPDATA%\Programs\LobbyMesh`. Settings and protected
keys live in Electron's per-user app-data location, separately from installation
files. No services, startup tasks, router settings or firewall rules are changed.

## First use and account identity

In Preferences, choose a display name and save it. In Overview, enable peer
discovery when ready; it can expose your network address to participating peers.
Saved network consent resumes on later launches. Microphone/voice consent does
not resume automatically.

To show a checked Roblox username, use the identity card in Preferences:

1. Enter your actual Roblox username and choose **Link profile**.
2. LobbyMesh resolves the canonical username and numeric account ID.
3. Copy the generated proof line into your Roblox profile's public About section
   using Roblox itself, and save the profile.
4. Choose **I saved it · check my profile** in LobbyMesh.
5. Keep the proof line there so new contacts can independently check it.

Never post an unsolicited proof supplied by someone else. No Roblox password,
cookie or client injection is used. The proof links that public account to this
app's full signing-key ID. A changed Roblox username can be refreshed for the
same numeric account. Account/key changes are not silently accepted; see
[identity guarantees, pins and limits](IDENTITY.md).

## Connect with a friend

Both people need the updated app running with discovery enabled. In Preferences,
choose **Create my contact code**. Exchange fresh codes through a chat you already
trust. Paste the other person's code and choose **Review contact**.

Check the displayed name, canonical Roblox username/profile-check state and full
LobbyMesh ID. Compare the full fingerprint with your friend, then explicitly
approve. Both people must approve each other. Sharing or reviewing a code alone
does not grant permission. Codes expire; generate fresh ones if needed.

Unlinked contacts are labeled Roblox-account-not-linked and have app-key-only
trust. A familiar name is insufficient. In Conversations, select your contact and
send a short message. **Accepted by peer app** confirms app acknowledgment, not
that someone read it. **Delivery unconfirmed** may mean it arrived; avoid repeated
duplicates. Messages are memory-only, expire locally and clear on disconnect.

## Voice and overlay

Both people enable **Allow voice this connection**. Call an approved contact;
the recipient explicitly answers. Starting/answering requests microphone access.
Calls start muted for transmission; the microphone remains captured during the
call. Hold the focused talk button to send audio and release to stop. Focus loss
releases talk. End the call to stop capture. Global game push-to-talk is not yet
available. Device/gain/output controls are in Conversations.

Voice uses Chromium WebRTC with DTLS-SRTP and Opus, plus adapter.js compatibility
and upstream SDP parsing. Production calls use public STUN at
`stun:stun.l.google.com:19302` for address discovery. That service learns your
network address; it does not relay audio. Synthetic tests disable public STUN.
No paid TURN relay or owner-operated backend is configured. See
[reused components](REUSED_COMPONENTS.md).

Enable the separate overlay and select widgets in Overlay. Ctrl+Shift+Space
switches to interaction mode; Escape returns to click-through mode. It does not
inject into Roblox. Windowed/borderless use is the intended experimental path;
actual Roblox/fullscreen compatibility is not accepted yet.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Contact missing | Both apps open, discovery enabled, fresh code and mutual approval; try Find contact. |
| Profile proof rejected | Exact proof saved publicly, actual username spelling, same numeric account, Roblox API reachable. Existing pins cannot be silently replaced. |
| Same account with a different app ID | Stop and confirm with the person through an existing trusted channel. Do not approve a replacement based on its name. |
| No voice | Both grant voice consent, recipient answers, Windows microphone permission/device is available, then hold the talk button in the focused app. |
| Delivery unconfirmed | Avoid duplicates; check both apps' state. An ACK can be lost even when text arrived. |
| Discovery/calls fail on home networks | Direct NAT traversal can fail; public STUN is not a universal relay. Do not disable security or change router ports to follow these instructions. |
| Settings/keys unavailable | Close duplicate app processes and preserve the existing profile; never delete keys as a first repair step. |

Hardware microphone/audio, a fresh friend's Windows installation, real
different-home-network delivery and actual Roblox lifecycle behavior remain
unverified. A physical Windows/Pi native-application reliability issue is retained
in the evidence ledger. Successful synthetic or same-host tests are narrower.

## Updates and removal

There is no automatic updater. Close LobbyMesh and run a newer trusted installer
for the same Windows account. Setup refuses to proceed while the app window is
open. Upgrade/profile retention on a fresh machine is still an acceptance gate.

Uninstall through Windows Installed apps. Known installed package files, the
Start-menu shortcut and uninstall entry are removed. Settings/app keys and
unrelated files are preserved. Removing app keys changes your identity and
requires contacts to review a new full ID; never confuse this with changing a
display name. Do not share your app-data directory or private key files.

## Build from source

Install Node 24 and the exact pnpm version in `package.json`, then clone
`https://github.com/Potato4507/LobbyMesh.git`. From the checkout:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm start
```

On graphical Windows x64, `pnpm test:desktop`, `pnpm test:identity`,
`pnpm test:audio` and `pnpm test:independent-voice` provide native/synthetic checks.
`pnpm verify:windows` requires a clean committed tree, pins the revision, runs
the complete pipeline and produces a package only if every stage succeeds.
It retains its exact summary under `dist/windows-verification-*/summary.json`.

Build the per-user installer with a successful summary:

```sh
pnpm package:friend --verification-summary dist/windows-verification-YOUR-ID/summary.json
```

The builder checks clean source, runtime compatibility, pinned package bytes,
checksum-pinned NSIS, actual isolated installation/launch/uninstall and outputs
`dist/friend-setup-latest.json`. It does not publish anything. Upstream licenses
and the MIT project license accompany the package. Preserve all failure evidence.

For changes and pull requests, read [CONTRIBUTING.md](../CONTRIBUTING.md).
