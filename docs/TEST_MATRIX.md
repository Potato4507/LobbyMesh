# Test matrix

[x] executed, [ ] unexecuted. Tests use synthetic identities and sessions only.

| Area | Unit | Simulation | 2-process | Cross-machine | External API | Security | Release |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Protocol | [x] version / IPC argument rejection | [ ] | [ ] | [ ] | [ ] | [x] malformed version | [ ] |
| Identity | [x] signing, persistence/reset, corrupt storage, wrong key | [ ] | [ ] | [ ] | [ ] | [x] POSIX permissions and tamper | [ ] |
| Record primitive | [x] key/domain signature, expiry, quotas, replay | [ ] | [ ] | [ ] | [ ] | [x] oversized / forged | [ ] |
| Session mock | [x] changes, unsubscribe, copy, provenance | [ ] | [ ] | [ ] | [ ] production provider | [x] refuses verified provenance | [ ] |
| Roster | [x] 0/2/30/100, duplicate names, join/leave | [ ] | [ ] | [ ] | [ ] Roblox roster | [x] whitelist, block, quota | [ ] |
| Simulator | [x] clock only | [ ] network/churn | [ ] | [ ] | [ ] | [ ] | [ ] |
| Desktop | [ ] components | [ ] | [ ] | [ ] | [ ] | [ ] runtime IPC / sandbox | [ ] launch |
| Public discovery | [x] fake, dedup, quota/rate, cleanup, timeout, installed key persistence | [x] two fake adapters | [x] local and public bootstrap | [ ] | [x] Windows pair; historical Linux timeout | [x] malformed key rejection | [ ] |
| Entrypoint search | [x] four-concurrent cap, deadline, auth/version filtering, error states | [x] unreachable/incompatible/stalled | [ ] | [ ] | [ ] | [x] rejects unauthenticated | [ ] |
| Local overlay | [x] XOR order, bucket cap, signed store, expiry, restart | [x] fake announcement only | [ ] | [ ] | [ ] | [x] forged record rejection | [ ] |
| Multi-node overlay / text | [x] bounded protocols | [x] graph churn / text faults / small partition repair | [x] local/public bootstrap | [ ] NAT | [ ] Roblox | [x] authentication/consent gates | [ ] |
| Voice | [ ] | [ ] | [ ] | [ ] audio | [ ] | [ ] | [ ] |

Do not infer internet/NAT, audio, Roblox integration, Windows support or release readiness from these tests.

2026-10-27 Windows local continuation: Node v24.22.1 / pnpm 11.25.0. Baseline typecheck passed, 20/20 tests passed; initial lint failed on CRLF checkout formatting, corrected through repository LF policy. See docs/evidence/local-m07.md.

| New boundary | Observed proof | Still unverified |
| --- | --- | --- |
| App RPC | Mutual authentication, forged/replayed signatures, app-ID pinning, incompatible version, oversize/malformed/flood frames, fragmentation, deadlines, cancellation, private error redaction | Public internet, cross-NAT, full adversarial assessment |
| Network overlay | Record validation, duplicate replication, paging, expiry, block enforcement, leave lifecycle | Routing/healing at scale, persistent safety settings |
| Real processes | Local HyperDHT bootstrap + three independent Windows Node processes; third learns first via second; real encrypted streams; signed replication and cross-node read; graceful shutdown | Public-DHT bootstrap success, cross-machine, Windows Electron GUI, Roblox and audio |

M08/runtime continuation: 36/36 tests, typecheck, lint (51 files), build passed; evidence in docs/evidence/local-m08.md and local-runtime.md. Added iterative budgets/churn graph fixtures, simultaneous join retry, automatic two-process discovery without peer-key input, canceled maintenance, periodic republishing and synthetic partition record repair. Graph fixtures at 500 nodes do not prove 500-node record convergence. Native parallel connection setup remains worked around by serialization, not resolved upstream.

M09 continuation: 42/42 tests, typecheck, lint (55 files), build passed. Six matching/provider lifecycle tests include 50 synthetic participants/five rooms, consent, tombstone/expiry, provenance, forgery, source-change races and stale-result suppression. Real local-runtime process fixture also matches/separates synthetic rooms over Noise. See docs/evidence/local-m09.md; no Roblox provider verification claimed.

Direct text continuation: 45/45 tests, typecheck, lint (57 files), build passed. 10,000 deterministic synthetic messages delivered with 11,610 attempts and bounded retained history; real local-process negotiation/ping/acknowledged text and contact revocation. See docs/evidence/local-direct-text.md. No crash-persistent exactly-once, WAN or GUI claim.

Persistent preferences: 49/49 tests, typecheck, lint (60 files), build passed. Four real-filesystem tests cover defaults, serialization/reopen, exclusive lock, schema/corruption, failed atomic replacement and immediate block despite disk failure. See docs/evidence/local-preferences.md. Windows ACL and desktop wiring remain pending.

Desktop preferences: `pnpm test:desktop` passed against real Electron 45.1.0 on Windows with temporary profile, real form/persistence/contact actions and foreign-window IPC rejection; sandbox/context-isolation flags observed, Node absent in renderer. Screenshot visually inspected. Full 49/49 suite, typecheck, lint (63 files), build also passed. See docs/evidence/local-desktop.md and lobbymesh-settings.png. Desktop networking/audio and installer remain incomplete.

Public bootstrap: explicit `pnpm smoke:public-pair` passed with two real processes, public entrypoint discovery, mutual app authentication and signed record exchange. Same host; not cross-NAT. Single smoke also exited 0 with one unauthenticated candidate. See docs/evidence/windows-public-bootstrap.md. Never infer cross-host/audio/Roblox support from these runs.
