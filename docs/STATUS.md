# STATUS
Goal: Build a serverless-by-ownership two-DHT P2P companion.
Current module: M10 peer transport/lifecycle integration (next implementation); earlier acceptance gaps remain.
Completed modules: none fully accepted; see partial evidence below.
Proof: latest continuation on 2026-10-27 Windows, Node v24.22.1 / pnpm 11.25.0; docs/evidence/local-*.md. Historical Linux proof (Node 24.19.0) retained in docs/evidence/checks*.log.

| Module | State | Implemented / remaining |
| --- | --- | --- |
| M00 | PARTIALLY_VERIFIED | Strict workspace, lockfile, build/typecheck/lint/tests, Electron/React sandbox scaffold, CI. UI launch blocked by Electron binary fetch failure and no xvfb-run. Fresh independent checkout not tested. Simulator clock only, not network simulation. |
| M01 | PARTIALLY_VERIFIED | Node Ed25519, persistence, fingerprint, reset and negative tests. OS credential store, migration, remote revocation and concurrent startup recovery unfinished. Windows file ACL unverified. |
| M02 | BLOCKED_EXTERNAL / PARTIAL | Mock provider tested; preliminary source retrieval saved. Official engine pages returned HTTP 502. No approved self-session OAuth capability or authorized experience test validated. |
| M03 | PARTIALLY_VERIFIED | Companion-only opt-in roster tested at 0/2/30/100, duplicate names, leave, block, quota, field whitelist. Real Roblox source and consent authentication not verified. |
| M04 | PARTIALLY_VERIFIED / BLOCKED_EXTERNAL | Pinned HyperDHT 6.35.0 backend, persistent POSIX seed, query limits/deduplication/cleanup and fake tested. Actual public smoke timed out after 15000ms; no public discovery success claimed. |
| M05 | VERIFIED_UNIT / VERIFIED_INTEGRATION / PARTIAL | Bounded 4-concurrent search, 64 candidates, deadline/cancellation, version/authentication gate and real Noise-authenticated probe adapter. Automatic discovery verified against local bootstrap in separate processes; public internet discovery still unverified. |
| M06 | VERIFIED_UNIT / PARTIAL | Single-node LocalOverlay composes signed store, capped XOR buckets and fake discovery. Local expiry, forged-record rejection and zero-node restart tested. Network RPC and real announcement not verified. |
| M07 | VERIFIED_UNIT / VERIFIED_INTEGRATION / PARTIAL | Domain-separated Ed25519 identity binding to real HyperDHT Noise session and transport keys, version/capability negotiation, bounded framed RPC, injected inbound handler, authenticated routing admission, idempotent join/referrals and signed record replication/read. Three separate Windows app processes plus local bootstrap tested. Public discovery, cross-NAT, churn and complete product acceptance remain unverified. |
| M08 | VERIFIED_UNIT / VERIFIED_INTEGRATION / PARTIAL | Bounded iterative routing, deadlines, query/candidate budgets, incomplete states, authenticated referrals and two-failure contact removal. Lifecycle-owned automatic discovery, 30s republishing, 16-record/2s reconciliation batches. Synthetic three-node partition merge preserves signed TTL; graph-only churn fixtures at 1/2/10/100/500. Real processes discover one another without peer-key input on local bootstrap. Native transaction serialization/retry workaround retained. Full-bucket liveness replacement and large-scale/native partition convergence remain pending. |
| M09 | VERIFIED_UNIT / VERIFIED_INTEGRATION / PARTIAL | Canonical versioned epoch-scoped session keys, opt-in signed membership/tombstones, TTL/block/forgery filtering, remote verification-claim downgrade. Automatic injected-provider/consent coordinator. 50 synthetic participants/five rooms and two real local processes with synthetic sessions tested. Real Roblox provider remains blocked; hashes and peer keys are not platform membership proof. |
| M10 | PARTIAL | Real authenticated encrypted overlay transactions verified locally. Product peer-session negotiation/reuse/heartbeat, text/media and cross-NAT behavior remain. |
| M11 | PARTIALLY_VERIFIED | Signed bounded records, replay/expiry tests, preliminary threat model. Network abuse gates and persistent safety controls absent. |
| M12–M18 | NOT_STARTED | Desktop scaffold does not satisfy M14. |

Blocked modules: M00 graphical launch requires Electron binary installation and GUI runtime; M02/M03/M16 require verified official API capability, creator authorization and Roblox Studio/experience tests; M10/M13/M17 require real NAT networks/audio devices; M18 requires Windows install machine.
Risks: high—development-only; authenticated P2P verified only on local bootstrap, no production session source or cross-NAT/audio proof; key fallback is unencrypted at rest and Windows ACL unverified; record replay state is process-local; no persistent safety controls. Do not release.
Next immediate action: Implement direct authenticated peer control/text transactions with explicit local contact authorization, bounded acknowledgments/retry/deduplication and versioned envelopes; keep real NAT/audio and age/contact safety acceptance separate. Preserve M08 scale and native-concurrency limitations.

Resume: read MASTER_PROMPT.md, IMPLEMENTATION_PLAN.md, this file and TEST_MATRIX.md. Current checkout D:\LobbyMesh, branch codex/lobbymesh-authenticated-overlay, preserving imported Cloud commits through 4fb38a1. Run pnpm typecheck, pnpm lint, pnpm test, pnpm build. No release or deployment. No paid services.

Latest proof: 2026-10-27 UTC, full regression commands and audit in docs/evidence/checks-discovery.log. Public smoke command: `pnpm exec tsx scripts/public-smoke.ts /workspace/companion-private-smoke`; exit 2, TIMEOUT then NODE_DESTROYED during cleanup, log docs/evidence/public-smoke.log. Private seed is outside git. No DHT reachability inference beyond this observed timeout.
