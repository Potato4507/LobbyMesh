# Headless production-protocol test peers — 2026-10-29 UTC

Source base: additive Pi handoff `29d3a44354d0f5ef31b932799f8c197b8e9e5690`, descended from preserved development `355527a`. New files were tested in the working tree before commit. Windows x64 Node 24.22.1 / pnpm 11.25.0 / pinned HyperDHT 6.35.0.

Implemented `pnpm lab:peer` and `pnpm lab:pair`: ephemeral app and transport identities; explicit private bootstrap (no public fallback); production OverlayRuntime, DesktopPairing, DesktopMessaging; signed app-ID/Noise endpoint authentication, independent temporary approval, acknowledged bidirectional encrypted synthetic text and negative revocation. No Electron/media/provider activation, persisted credentials, package install, service or OS network changes. JSONL control works through local pipes; authorized SSH launch uses strict host checking, batch-only auth and shell-quoted checkout/arguments. SSH remote execution remains unverified.

Observed:

- `pnpm typecheck`, `pnpm lint`: pass (152 files at this milestone).
- `pnpm test`: 130/130 pass, including new CLI validation and independent three-process lab test. Existing native tests retain exact replica counts and zero-failure/exhausted assertions.
- `pnpm build`: exit 0.
- Explicit `scripts/lab-pair.ts` against an owned loopback bootstrap: 8/8 ACKs, received counts in both directions, revocation rejection, microphone off and `cleanupVerified=true`, exit 0. 629ms total, observed ACK p50=3.95ms/p95=12.69ms. These are single-run application ACK timings, not physical media or general network latency. Driver and bootstrap exited cleanly.
- Input validation rejects implicit/public bootstrap, invalid ports/lifetimes, duplicate/unknown flags, extra command fields, oversize values and SSH option injection. Worker output buffering and client response buffers bounded. Cleanup is reported verified only after a cleanup ACK and exit 0.

Tier: **SAME_HOST**, independent processes with real native Noise/app authentication. No physical Pi/LAN, virtual NAT, real external network, hardware audio, actual Roblox or packaged acceptance. No configured SSH target was present in the current user's SSH config; no device access attempted or credentials guessed. Existing unrelated SSH keys were not read.

# Current CI reconciliation

GitHub Actions read via authenticated REST (credential helper output remained process-local). Latest handoff run [40803293787](https://github.com/Potato4507/Roblox-app/actions/runs/40803293787) at `29d3a44`: success; seven preceding additive handoff runs also success.

Latest failed development run [40796246251](https://github.com/Potato4507/Roblox-app/actions/runs/40796246251), `355527a`: native three-app-process replica assertion actual `{replicas:1,failures:1}`, required `{replicas:2,failures:0}`. Previous [40795914890](https://github.com/Potato4507/Roblox-app/actions/runs/40795914890), `013ba60`: reverse lookup had one failure; native diagnostics include a pre-establishment transport failure and a separate recovered hello timeout. These differ from the older timeout/exhausted handoff hint. Linux CI intermittency remains unresolved; newer passing runs do not prove repair.

Current focused Windows process tests 2/2 and full suite 130/130 pass; full run retained a recovered hello timeout around 1512ms. Added replica-assertion diagnostics from all three peers without relaxing assertions, increasing deadlines, skipping cases or changing production transport. Further native repair needs reproducible error/phase evidence; avoid speculative retry of protocol or post-dispatch errors.
