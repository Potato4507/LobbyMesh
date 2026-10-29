# LobbyMesh — continued engineering brief (2026-10-28)

This document supplements, **does not replace**, `MASTER_PROMPT.md`, `IMPLEMENTATION_PLAN.md`, `AGENTS.md`, `docs/STATUS.md`, or `docs/RECOVERY.md`. The source tree and fresh test output take precedence. Apply to the EXISTING `Potato4507/Roblox-app` repository; brand the application LobbyMesh. Never start a new repo, reinitialize its history, overwrite someone else's dirty work, or redo completed modules without reason.

## Mission and constraints

Ship a dependable Windows-first opt-in decentralized communications companion with no mandatory owner-funded backend. The application should discover supported Roblox session changes where authorized data exists, match **consenting companion users**, automatically manage DHT bootstrap/joins/lifecycle once permitted, support encrypted text and explicit peer-approved voice, and expose a compelling usable desktop interface plus an independently rendered, customizable overlay. Users must not need to supply DHT seeds, IPs, server JobIds or network parameters in ordinary supported production flows. A manual diagnostic may exist without being called production automatic detection.

Remain platform-compliant: no Roblox code injection, client memory or cookie extraction, nonparticipant tracking, voice interception, chat filtering bypass, or circumvention of age/safety requirements. Internal Luau `game.JobId` and `Players:GetPlayers()` do not establish a universal external desktop API. Unsupported real-session discovery remains honestly marked unsupported when evidence is absent. App keys and DHT claims do not prove Roblox identity, age or same-session membership. Consent, block/deny, abuse controls, and privacy by default are product requirements, not polish.

The public HyperDHT is only bootstrap; the signed, versioned, Kademlia-style application DHT is a distinct routing/record system. Secure direct P2P is separate again. Direct NAT traversal is not guaranteed and there must be no covert relay or obligatory owned server. Respect network/mic consent; no silent microphone capture.

## Fresh checkpoint hints — verify, do not freeze

As inspected on 2026-10-28: the active `codex/lobbymesh-authenticated-overlay` branch had advanced beyond `main`, with a Windows Electron UI and overlay, signed pairing, real same-host public-bootstrap/Noise text, a separate app overlay, synthetic voice between independent Electron clients, and Windows read-only Roblox log monitoring. Node, typecheck/lint/build and desktop smoke have previously passed locally, while GitHub Actions exposed occasional failing Linux native network integration tests. Native HyperDHT handoff sometimes establishes a client stream without a server admission; an isolated version comparison was inconclusive about the exact source. Existing `docs/RECOVERY.md` describes newer local-call RTT/jitter/loss measurements and packaging; recheck all of this against HEAD. None of this proves physical audio, actual Roblox gameplay, cross-ISP NAT, or release readiness.

## Balanced continuation lanes

Treat these as a dependency-aware set, **not** a strict order or permission to hyperfocus on one:

1. Network correctness: reliable public discovery, bounded app-DHT lookup/replication/repair, direct P2P, NAT constraints, reproducible CI/native transport failures, safe cancellation and diagnostics.
2. Real integration: authorized Windows process/player-log lifecycle, observed Roblox join/leave/teleport, trusted session evidence where feasible, provenance and consenting roster. Distinguish mock/source/actual game.
3. Conversations: pairing, mutual identity approval, encrypted text, acknowledgement/retry semantics, recipient blocking, eligible contacts, reporting/abuse protection, continuity and teardown.
4. Voice: actual input/output devices, explicit consent/answer, PTT focus safety, gain/device controls, group-call architecture, stats and connection recovery, physical measurements and UX.
5. Experience: readable polished desktop navigation, onboarding and actionable offline/error states; modular overlay widgets with persisted order, visibility, opacity, placement, chat/status/call controls under appropriate permissions. Test actual click-through, foreground focus, windowed/borderless Roblox and fullscreen limitations. Do not add character-anchored in-game chat bubbles.
6. Product delivery: accessibility, telemetry minimization, privacy, license review, Windows packaging, integrity/signing/installer/upgrader, fresh-machine evidence and release gates.

Avoid reimplementing things marked verified without a failed regression. Track risks and the *next best unblocked task* for each lane; switch lanes when a dependency is genuinely blocked. Use current module names/contracts, not a second parallel architecture.

## Pi and local virtual-WAN addition

The Raspberry Pi is a **potential, not yet connected**, remotely controlled testing worker on the **same home LAN**. Local Codex should perform a read-only capability check first; do not assume host/SSH username/password/address or modify global settings. Then support a headless production-protocol peer on Linux ARM64 where supported; do not run Electron on the Pi just to satisfy a desktop artifact test.

1. Cross-host real LAN: Windows client + Raspberry Pi, distinct physical machines, authenticated identity/key continuity, public/local bootstrap diagnostics, direct messaging and control-plane voice signaling. Test 0/1/2 peers, simultaneous joins, app restarts and packet measurements. This is `SAME_LAN_PHYSICAL`, not internet/NAT acceptance.
2. Virtual WAN: two isolated Pi Linux client namespaces behind separate NAT-router namespaces plus an isolated transit namespace; different private subnets, routed gateways, conntrack filtering and netem impairments. No modification of physical `wlan0`/`eth0`, root routing, root firewall or SSH. Run only under explicit privilege approval. This is `VIRTUAL_NAT`, not real ISPs.
3. Optional later remote ISP: mark `NOT_TESTED` until genuinely external physical network is available. No new paid VPS/TURN/cloud dependency.

Introduce a portable headless peer harness, typed CLI options, bounded runs, deterministic test scenario parameters, machine-readable anonymized metrics, and clean stop commands. Never commit SSH keys, app identity stores, cookies, home addresses, network captures or raw participant data. Favor minimal reversible network actions; verify after teardown that no `lmx-*` namespaces/qdiscs/processes remain.

## Workflow and evidence

At the start inspect `git status`, branch/remotes, latest commits, `docs/STATUS.md`, `docs/RECOVERY.md`, active tests and CI. If another agent is changing the worktree, preserve it; work on a dedicated branch or carefully layer without overwriting. Use existing pinned Node/pnpm and scripts. Implement the smallest valuable improvement, test focused and boundary cases, run platform-specific validations separately, record the exact commands/platform/commit/outcome, checkpoint at meaningful milestones, then continue to another unblocked area. Do not treat a success on simulated streams as native-Noise or hardware evidence; do not hide failed runs. When CI fails, identify failing command and failure signature, test a hypothesis, and avoid changes that just mute a test. Use `docs/PROOF_PLAN_20261028.md` to classify claims.

No spending, global security modifications, SSH exposure, router port forwarding, public release or direct `main` mutations without specific approval. On access/privilege issues, keep coding/testing everything that does not require the Pi. On context or usage limits, write a concise truthful `docs/RECOVERY.md` checkpoint and stop.
