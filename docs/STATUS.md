# STATUS
Goal: Build a serverless-by-ownership two-DHT P2P companion.
Current module: M08 bounded iterative routing and healing (next implementation); earlier acceptance gaps remain.
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
| M07 | VERIFIED_UNIT / VERIFIED_INTEGRATION / PARTIAL | Domain-separated Ed25519 identity binding to real HyperDHT Noise session and transport keys, version/capability negotiation, bounded framed RPC, injected inbound handler, authenticated routing admission, idempotent join/referrals and signed record replication/read. Three separate Windows app processes plus local bootstrap tested. Public discovery, cross-NAT, churn and complete product acceptance remain unverified. |
| M08 | IN_PROGRESS | XOR routing and bounded signed store retained; direct-neighbor lookup/replication with paginated results implemented. Iterative lookup, liveness eviction, anti-entropy and periodic discovery still pending. |
| M09–M10 | NOT_STARTED | Session matching and product direct text/media transport remain. |
| M11 | PARTIALLY_VERIFIED | Signed bounded records, replay/expiry tests, preliminary threat model. Network abuse gates and persistent safety controls absent. |
| M12–M18 | NOT_STARTED | Desktop scaffold does not satisfy M14. |

Blocked modules: M00 graphical launch requires Electron binary installation and GUI runtime; M02/M03/M16 require verified official API capability, creator authorization and Roblox Studio/experience tests; M10/M13/M17 require real NAT networks/audio devices; M18 requires Windows install machine.
Risks: high—development-only, no authenticated P2P or production session source; POSIX key fallback is unencrypted at rest; record replay state is process-local; no persistent safety controls. Do not release.
Next immediate action: Implement alpha-bounded iterative FIND_NODE/FIND_VALUE over authenticated RPC, with an overall deadline, query budget and validated referrals; add deterministic multi-hop/churn tests. Then integrate automatic entrypoint probing and periodic discovery.

Resume: read MASTER_PROMPT.md, IMPLEMENTATION_PLAN.md, this file and TEST_MATRIX.md. Current checkout D:\LobbyMesh, branch codex/lobbymesh-authenticated-overlay, preserving imported Cloud commits through 4fb38a1. Run pnpm typecheck, pnpm lint, pnpm test, pnpm build. No release or deployment. No paid services.

Latest proof: 2026-10-27 UTC, full regression commands and audit in docs/evidence/checks-discovery.log. Public smoke command: `pnpm exec tsx scripts/public-smoke.ts /workspace/companion-private-smoke`; exit 2, TIMEOUT then NODE_DESTROYED during cleanup, log docs/evidence/public-smoke.log. Private seed is outside git. No DHT reachability inference beyond this observed timeout.
