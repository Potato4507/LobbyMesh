# Verification matrix and acceptance discipline

Track these classifications independently in `docs/TEST_MATRIX.md` or dedicated evidence files. A source change may have multiple proof types; one never implies the next.

| Label | Meaning | Does NOT establish |
| --- | --- | --- |
| UNIT / SIMULATION | Deterministic code and fault fixtures | OS sockets or user experience |
| SAME_PROCESS | Real components sharing one process | Independent process safety |
| SAME_HOST | Two or more real local processes on one machine | Different physical hosts or ISP |
| SAME_LAN_PHYSICAL | Windows and Pi on different physical computers, same home network | Internet NAT traversal |
| VIRTUAL_NAT | Two isolated Linux namespace clients behind isolated virtual routers/firewall/NAT | Different ISPs, actual carrier-grade NAT or real internet reliability |
| REAL_EXTERNAL | Separate physical networks/providers with measured reachability | Universal NAT success |
| ACTUAL_ROBLOX | Observed join/change/leave on an authorized real Roblox client | Account/roster verification without separate proof |
| PHYSICAL_AUDIO | Consented capture and audible output on actual hardware | Group scale or cross-NAT audio |
| PACKAGED | Copied built executable tested, build manifest verified | Installer, publisher signature, fresh-machine working |
| RELEASE_READY | Documented security, platform, accessibility, licensing, distribution and install acceptance | Permanent future network availability |

## Scenario catalog

- Baseline connectivity: simultaneous start, sequential join, 0/1/2+ peers, local discovery vs public bootstrap vs custom synthetic transit, restart and rekey.
- Authentication and policy: forged signing keys, pinned identity mismatch, replay, unapproved contact, blocked contact, revoked preference, quota exhaustion, oversized frame, stale session assertion.
- Transport: UDP path discovery, inbound filtering, NAT/conntrack mapping expiry, reset, repeated bidirectional bursts, request cancellation, timeout vs exhausted classification, zero leaked handles.
- Routing and sessions: partition, merge, TTL, invalid record, session switch, source loss, stale event racing a new room, unreachable peer.
- Text and media: duplicate ACKs, loss/reorder, contact failure, clean hangup, forced crash, permission withdrawn during PTT, unknown capture state, hardware tests only with explicit operator consent.
- Experience: native Windows renderer accessibility/focus, overlay transparency/click-through and hotkey conflict, windowed/borderless game interaction, visual review, small-window clipping, privacy and offline defaults.

## Test artifact schema (suggested, backward-compatible)

For each run record: `scenario`, `commit`, `dateUtc`, `platform`, `hostClass`, `proofTier`, `topology`, `command`, `durationMs`, `attempted`, `succeeded`, `timedOut`, `rejected`, `p50Ms`, `p95Ms`, `packetLossPct` where meaningful, `cleanupVerified`, `environmentLimitations`, `result`, and a redacted `evidencePath`. Report unmeasured fields as null. Avoid peer IPs, usernames, SSH targets, full candidate lists, arbitrary errors, private key data and microphone samples. Do not describe injected impairment as observed ISP behavior.

## CI triage

Older Ubuntu GitHub Actions on `codex/lobbymesh-authenticated-overlay` encountered a failure in `tests/overlay-process.test.ts` when an authenticated local-Noise transaction timed out around app hello, conflicting with a test assertion expecting `exhausted`. Read the **current** failing run; the repo may have changed. Reproduce from a controlled baseline, isolate native library vs application scheduling, record packet/phase diagnostics without identities, and test remediation across Windows and Linux. Never simply increase a timeout without bounded evidence, turn off the integration test, or rewrite an assertion to accept every failure. A Linux CI pass is necessary but is not Windows/real-LAN release acceptance.
