# LobbyMesh

A Windows companion for opt-in peer discovery, encrypted conversations, voice
and a separate, non-injected Roblox overlay. Networking and microphone capture
start only with permission. Experimental preview; direct connectivity is not
guaranteed on every home network.

**[Download Windows setup](https://github.com/Potato4507/LobbyMesh/releases/download/v0.1.0-alpha.1/LobbyMesh-Setup.exe)** ·
[Release notes and checksum](https://github.com/Potato4507/LobbyMesh/releases/tag/v0.1.0-alpha.1) ·
[Quick start](docs/FRIEND_QUICK_START.txt) · [Detailed installation](docs/INSTALLATION.md) · [Contribute](CONTRIBUTING.md)

Run the setup file; no Node installation or network-address configuration is
needed. Exchange contact codes and approve each other. The download is unsigned;
verify its SHA256 against the release checksum and keep Windows security enabled.

Your identity combines a display name, an optional checked Roblox username and
a permanent 256-bit app-key ID. Names alone are never trusted. Link your Roblox
profile in Preferences by posting the app-specific proof in your public About
section. Other apps check that proof directly with Roblox, recheck on approval,
and pin the account to its app key. This is a public-profile ownership check,
not a Roblox endorsement, age check or session-membership proof.
See [identity guarantees and limits](docs/IDENTITY.md).

Open source under the [MIT license](LICENSE). Forks, issues and pull requests
are welcome. See [contribution instructions](CONTRIBUTING.md).
Chat uses HyperDHT/Noise encrypted streams; voice uses Chromium WebRTC, upstream
adapter.js/SDP parsing and public STUN. See [component reuse and limits](docs/REUSED_COMPONENTS.md).

![Identity panel preview with explicitly synthetic profiles](docs/images/identity-preview.png)

Read MASTER_PROMPT.md and IMPLEMENTATION_PLAN.md for scope. Resume using docs/STATUS.md.

Local Windows x64 packaging: `pnpm package:win` builds and smoke-tests a self-contained folder. `pnpm package:friend --verification-summary PATH` wraps a successfully verified Windows pipeline summary in a single per-user installer, checks installed bytes, runs the installed executable and verifies uninstall. Inspect `dist/friend-setup-latest.json` for the output. No auto-updater or publisher signature is provided; see [release limits](docs/RELEASE.md).

Desktop navigation: Overview controls connectivity; Conversations contains approved online chat and explicit voice controls; Preferences manages local presence/contact policy; Overlay configures widget visibility, order, position and opacity. Switching pages preserves unsent drafts and unsaved preferences. Enforceable contact-age/safety and physical audio acceptance remain unfinished.

Voice: enable “Allow voice this connection” in Conversations, then call an approved discovered contact or explicitly answer a call. Calling/answering requests microphone access and begins with transmission muted. The microphone stays on during the call; hold the focused talk button (pointer, Space or Enter) to send audio. Focus loss/view change releases talking, and disconnect resets voice permission. Global game PTT remains unavailable. Two independent source-built clients exchange synthetic media locally; physical mic, audible quality, packaged pairs and cross-NAT remain unverified. See [voice proof and limits](docs/evidence/desktop-voice-controls.md) and [independent-client proof](docs/evidence/independent-voice-clients.md).

During a call, incoming volume/mute controls affect only your playback; they do not stop microphone capture or change PTT. A decoded output-level meter shows measured graph level when available. Settings reset for each call. See [output verification](docs/evidence/call-output-controls.md). The optional Current call overlay widget shows capture/transmission and can end the current call in interaction mode. Start, answer and talk remain in the main window. See [overlay call evidence](docs/evidence/overlay-current-call.md).

Microphone gain adjusts your transmitted input from0–200%, with100% as the default each call. At0%, input is silent while the microphone remains on; hold to talk is still required. Levels above100% may distort. This control is available in the main Conversations window during a connected call. Native tests measure synthetic audio only; physical input compatibility remains unverified. See [input gain evidence](docs/evidence/microphone-input-gain.md).

The input-level meter measures the post-gain signal while you hold to talk. Its peak warning suggests lowering gain if sound is distorted; unavailable readings are shown explicitly. It does not enable automatic talking or send audio without PTT. Only level/peak scalars leave the media owner. See [activity evidence](docs/evidence/microphone-input-activity.md).

If the microphone source becomes unavailable or muted by the system, or the remote audio track ends, the call stops capture and transmission. Start a new call explicitly after resolving the device issue; unmuting the device cannot resume an old held talk control. These lifecycle cases have synthetic native tests; physical device compatibility remains unverified. See [track interruption evidence](docs/evidence/audio-track-interruption.md).

Contact onboarding: with peer discovery enabled, use Preferences → Add a contact. Exchange short-lived codes using a trusted channel, compare full app fingerprints, then approve on both sides. Preview/sharing alone grants nothing; the app authenticates the remote app key before saving. Linked Roblox claims require an independent current public-profile proof. Unlinked app contacts stay clearly labeled. Age and server membership are not verified. Broader contact-age/safety acceptance remains incomplete. See [identity guarantees](docs/IDENTITY.md) and [historical pairing evidence](docs/evidence/contact-pairing.md).

Use **Block selected contact** in Conversations to stop that app contact's messages/calls and clear its local conversation. Blocking stays available under message load and with unsaved preference edits. Manage blocked contacts in Preferences; unblocking does not approve them again. A failed save is shown as unconfirmed. See [blocking evidence](docs/evidence/conversation-blocking.md).

Local detection diagnostic: `pnpm diagnose:session` reads supported Windows process metadata/player logs once, prints only redacted state/reason and whether a complete session was selected, then stops. Add `--follow` to wait up to 30s for bounded large-log catch-up. It changes no saved settings and starts no network. Latest live probe reports waiting with no selected session; positive real Roblox lifecycle acceptance remains unverified. See [source/catch-up evidence](docs/evidence/windows-log-catchup.md).

Toolchain: Node 24, pnpm 11.25.0. Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`. On a graphical desktop run `pnpm start`. Peer discovery is off initially; explicitly enable it in the app to join the network automatically. Saved network permission resumes on later launches; voice permission does not. Opt-in Windows player-log detection and signed session matching have fixture proof; actual Roblox compatibility is unverified. No author-operated backend. Internet reachability and volunteer infrastructure availability are not guaranteed.

If the pinned Electron binary is absent after installation, run `node node_modules/electron/install.js`. `pnpm test:desktop` verifies native preferences/network controls with an isolated temporary profile and writes `docs/evidence/lobbymesh-settings.png`; it requires a usable Electron graphical runtime. Its control tests inject a runtime; a separate native cancellation check uses unreachable local bootstrap, never public bootstrap. The microphone stays off. Current scope and exact evidence: [docs/STATUS.md](docs/STATUS.md).

Public discovery development probe: `pnpm exec tsx scripts/public-smoke.ts PRIVATE_STATE_DIRECTORY`. Uses real public HyperDHT defaults, sends only the app entrypoint topic and transport key, and opens a UDP socket. Deadline 15 seconds; historical Linux run timed out, current Windows run completed. Success is not guaranteed. Never commit the state directory. Normal desktop starts networking only after explicit permission or a previously saved opt-in.

Explicit two-process public bootstrap verification: `pnpm smoke:public-pair` (75s deadline). Windows run passed automatic public discovery, authentication and signed record exchange; both peers shared one host, so no cross-NAT claim. Historical Linux public timeout remains recorded. These commands are never run implicitly by the default test suite or desktop.

Desktop messaging works only for approved app contacts whose transport has been authenticated/discovered. Fresh profiles start with no permissions; two-sided signed contact-code approval is available in Preferences. Roblox identity/age and broader safety acceptance remain unverified. No manual network/server-key setup is required. Messages are ephemeral, memory-only and cleared on disconnect; an acknowledgment means accepted by the peer app, not read by a person.

Windows desktop credentials use OS protection in the main process. Existing development keys migrate without changing identities; failed protection stops networking and preserves existing files. Other desktop OS providers are currently unsupported. Node development probes still use plaintext credentials: keep their private state outside the checkout. See [credential evidence and limitations](docs/evidence/windows-credentials.md).

Offline overlay experiment: `pnpm simulate:overlay` runs seeded 1/2/10/100/500-node fixtures using production app RPC, records and maintenance with synthetic streams/bootstrap. Optional arguments are a new JSON output filename and comma-separated sizes, e.g. `pnpm simulate:overlay dist/overlay-run.json 10,100`. Output creation is exclusive; existing evidence is never overwritten. A 500-node run takes roughly 40 seconds on the observed Windows host. These fixtures open no public network sockets and do not prove real NAT or native Noise performance. Results and failed repair-only baselines: [overlay scale evidence](docs/evidence/overlay-scale.md).

Windows overlay: enable Show overlay in the app, choose saved corner/opacity/widgets, and use Ctrl + Shift + Space or Interact with overlay to type into approved chat. Default mode passes clicks through; Back to game returns to passive input. This is a separate non-injected window for windowed/borderless play; actual Roblox/fullscreen/physical input acceptance remains unverified. See [overlay evidence](docs/evidence/desktop-overlay.md).
