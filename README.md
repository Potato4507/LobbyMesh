# LobbyMesh (development, incomplete)

Read MASTER_PROMPT.md and IMPLEMENTATION_PLAN.md for scope. Resume using docs/STATUS.md.

Toolchain: Node 24, pnpm 11.25.0. Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`. On a graphical desktop run `pnpm start`. Peer discovery is off initially; explicitly enable it in the app to join the network automatically. Saved permission resumes on later launches. Roblox session detection and voice remain unavailable. No author-operated backend. Internet reachability and volunteer infrastructure availability are not guaranteed.

If the pinned Electron binary is absent after installation, run `node node_modules/electron/install.js`. `pnpm test:desktop` verifies native preferences/network controls with an isolated temporary profile and writes `docs/evidence/lobbymesh-settings.png`; it requires a usable Electron graphical runtime. Its control tests inject a runtime; a separate native cancellation check uses unreachable local bootstrap, never public bootstrap. The microphone stays off. Current scope and exact evidence: [docs/STATUS.md](docs/STATUS.md).

Public discovery development probe: `pnpm exec tsx scripts/public-smoke.ts PRIVATE_STATE_DIRECTORY`. Uses real public HyperDHT defaults, sends only the app entrypoint topic and transport key, and opens a UDP socket. Deadline 15 seconds; historical Linux run timed out, current Windows run completed. Success is not guaranteed. Never commit the state directory. Normal desktop starts networking only after explicit permission or a previously saved opt-in.

Explicit two-process public bootstrap verification: `pnpm smoke:public-pair` (75s deadline). Windows run passed automatic public discovery, authentication and signed record exchange; both peers shared one host, so no cross-NAT claim. Historical Linux public timeout remains recorded. These commands are never run implicitly by the default test suite or desktop.

Desktop messaging works only for already-approved app contacts whose transport has been authenticated/discovered. Fresh profiles have no approved contacts; safe new-contact onboarding and automatic Roblox identity/session detection remain incomplete. No manual peer/server-key setup is provided. Messages are ephemeral, memory-only and cleared on disconnect; an acknowledgment means accepted by the peer app, not read by a person.

Windows desktop credentials use OS protection in the main process. Existing development keys migrate without changing identities; failed protection stops networking and preserves existing files. Other desktop OS providers are currently unsupported. Node development probes still use plaintext credentials: keep their private state outside the checkout. See [credential evidence and limitations](docs/evidence/windows-credentials.md).
