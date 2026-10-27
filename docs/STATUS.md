# STATUS
Goal: Build a serverless-by-ownership two-DHT P2P companion.
Current module: M07 authenticated overlay transport (next implementation); earlier acceptance gaps remain.
Completed modules: none fully accepted; see partial evidence below.
Proof: 2026-10-27 UTC, Node 24.19.0 / pnpm 11.25.0 Linux. See docs/evidence/checks.log for latest exact commands/results.

| Module | State | Implemented / remaining |
| --- | --- | --- |
| M00 | PARTIALLY_VERIFIED | Strict workspace, lockfile, build/typecheck/lint/tests, Electron/React sandbox scaffold, CI. UI launch blocked by Electron binary fetch failure and no xvfb-run. Fresh independent checkout not tested. Simulator clock only, not network simulation. |
| M01 | PARTIALLY_VERIFIED | Node Ed25519, persistence, fingerprint, reset and negative tests. OS credential store, migration, remote revocation and concurrent startup recovery unfinished. Windows file ACL unverified. |
| M02 | BLOCKED_EXTERNAL / PARTIAL | Mock provider tested; preliminary source retrieval saved. Official engine pages returned HTTP 502. No approved self-session OAuth capability or authorized experience test validated. |
| M03 | PARTIALLY_VERIFIED | Companion-only opt-in roster tested at 0/2/30/100, duplicate names, leave, block, quota, field whitelist. Real Roblox source and consent authentication not verified. |
| M04 | PARTIALLY_VERIFIED / BLOCKED_EXTERNAL | Pinned HyperDHT 6.35.0 backend, persistent POSIX seed, query limits/deduplication/cleanup and fake tested. Actual public smoke timed out after 15000ms; no public discovery success claimed. |
| M05 | VERIFIED_UNIT / PARTIAL | Bounded 4-concurrent probes, 64 candidates, deadline, version/authentication gate and ranked results tested. Real authenticated probe adapter pending M07. |
| M06 | VERIFIED_UNIT / PARTIAL | Single-node LocalOverlay composes signed store, capped XOR buckets and fake discovery. Local expiry, forged-record rejection and zero-node restart tested. Network RPC and real announcement not verified. |
| M07–M10 | NOT_STARTED | Authenticated RPC, joining, iterative routing, replication, matchmaking and secure direct transport remain. |
| M11 | PARTIALLY_VERIFIED | Signed bounded records, replay/expiry tests, preliminary threat model. Network abuse gates and persistent safety controls absent. |
| M12–M18 | NOT_STARTED | Desktop scaffold does not satisfy M14. |

Blocked modules: M00 graphical launch requires Electron binary installation and GUI runtime; M02/M03/M16 require verified official API capability, creator authorization and Roblox Studio/experience tests; M10/M13/M17 require real NAT networks/audio devices; M18 requires Windows install machine.
Risks: high—development-only, no authenticated P2P or production session source; POSIX key fallback is unencrypted at rest; record replay state is process-local; no persistent safety controls. Do not release.
Next immediate action: Implement authenticated overlay RPC over HyperDHT Noise streams, binding the app Ed25519 identity to the transport key via a domain-separated signed handshake. Replace the M04 reject-all stream handler with an explicitly injected bounded handler. Add separate-process tests on a local test bootstrap; keep that evidence distinct from public DHT/NAT verification.

Resume: read MASTER_PROMPT.md, IMPLEMENTATION_PLAN.md, this file and TEST_MATRIX.md. Worktree root /workspace/companion. Run pnpm install --frozen-lockfile then pnpm typecheck, pnpm lint, pnpm test, pnpm build. All initial implementation is local; nothing published or deployed. No paid services.

Latest proof: 2026-10-27 UTC, full regression commands and audit in docs/evidence/checks-discovery.log. Public smoke command: `pnpm exec tsx scripts/public-smoke.ts /workspace/companion-private-smoke`; exit 2, TIMEOUT then NODE_DESTROYED during cleanup, log docs/evidence/public-smoke.log. Private seed is outside git. No DHT reachability inference beyond this observed timeout.
