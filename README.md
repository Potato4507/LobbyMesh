# LobbyMesh (development, incomplete)

Read MASTER_PROMPT.md and IMPLEMENTATION_PLAN.md for scope. Resume using docs/STATUS.md.

Toolchain: Node 24, pnpm 11.25.0. Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`. On a graphical desktop run `pnpm start`. No production session source, public networking, or audio is enabled yet. No author-operated backend. Internet reachability and volunteer infrastructure availability are not guaranteed.

If the pinned Electron binary is absent after installation, run `node node_modules/electron/install.js`. `pnpm test:desktop` verifies the native preferences UI with an isolated temporary profile and writes `docs/evidence/lobbymesh-settings.png`; it requires a usable Electron graphical runtime. The normal desktop remains offline and microphone off. Backend tests exercise real local-bootstrap Noise connections, synthetic session matching and direct text; those are not public-internet/Roblox/audio proof. Current scope and exact evidence: [docs/STATUS.md](docs/STATUS.md).

Public discovery development probe: `pnpm exec tsx scripts/public-smoke.ts PRIVATE_STATE_DIRECTORY`. Uses real public HyperDHT defaults, sends only the app entrypoint topic and transport key, and opens a UDP socket. Deadline 15 seconds; historical Linux run timed out, current Windows run completed. Success is not guaranteed. Never commit the state directory. Normal desktop preview still starts no networking.

Explicit two-process public bootstrap verification: `pnpm smoke:public-pair` (75s deadline). Windows run passed automatic public discovery, authentication and signed record exchange; both peers shared one host, so no cross-NAT claim. Historical Linux public timeout remains recorded. These commands are never run implicitly by the default test suite or desktop.
