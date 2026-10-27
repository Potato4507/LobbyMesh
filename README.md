# Companion (development, incomplete)

Read MASTER_PROMPT.md and IMPLEMENTATION_PLAN.md for scope. Resume using docs/STATUS.md.

Toolchain: Node 24, pnpm 11.25.0. Run `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`. On a graphical desktop run `pnpm start`. No production session source, public networking, or audio is enabled yet. No author-operated backend. Internet reachability and volunteer infrastructure availability are not guaranteed.

Public discovery development probe: `pnpm exec tsx scripts/public-smoke.ts PRIVATE_STATE_DIRECTORY`. Uses real public HyperDHT defaults, sends only the app entrypoint topic and transport key, and opens a UDP socket. Deadline 15 seconds; this environment timed out. Success is not guaranteed. Never commit the state directory. Normal desktop preview still starts no networking.
