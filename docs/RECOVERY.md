# Active checkpoint — 2026-10-28

Goal active. D:\LobbyMesh, branch codex/lobbymesh-authenticated-overlay, remote Potato4507/Roblox-app. Prior clean source7e96f7b preserved. Current milestone adds explicit desktop voice controls; use git log -1 after commit. No main push/PR/release/merge/deployment. No preexisting dirty work. No intentional test process remains running.

Production UI: Conversations now has connection-local voice consent (off by default/reset on reconnect), approved-contact call, explicit answer/decline/end and focused pointer/Space/Enter hold-to-talk. Targets resolved inside main through DesktopMessaging.resolveContact; strict main-window-only action parser never accepts SDP/endpoints. Ordinary overlay/foreign actions reject. Main/side/panel capture status shows on/off/unknown; microphone stays captured while in call even when PTT transmission is muted. No global/game/overlay PTT yet. VoiceMode preference remains off and does not restore capture permissions.

PTT: frontend250ms renewal, main600ms/media750ms expiring leases, new press distinct from renewal so timer resumption cannot rearm a canceled lease. Release on key/pointer/cancel/leave/lost capture/blur/pagehide/visibility/view/call change; main checks actual window focus and releases on blur. If mute ACK stalls, configured200ms main watchdog hangs up and destroys host. Late activation cannot override newer release. Cancellation/status bypass ordinary IPC saturation. Timer settings are not OS real-time guarantees.

Cleanup hardening: VoiceCalls.close throws if media owner remains unconfirmed; network factory still tears down other resources then propagates voice failure. Unknown capture/transmission retained through disconnected/error views via last owned service, rather than showing off; retry-confirmed close clears failure. Unit fault test verifies retained ownership, unknown fields and throwing close. Native UI injects a stalled mute and verifies watchdog closes call.

Proof: full Node118/118, typecheck, lint129 files, build and native desktop smoke with independent protected credential reopen pass. Native UI uses real renderer/preload/main/VoiceCalls but synthetic transport/media: no hardware mic/network. Actual key+pointer inputs, held renewal, release, real focus transfer to temporary BrowserWindow (blur() alone was a no-op), view loss, stale renewal rejection, call/answer/decline, overlay/foreign denial and permission reset across disconnect/reconnect checked. Screenshot lobbymesh-voice-test.png explicitly labeled synthetic; messaging/settings updated and visually reviewed, sidebar state corrected;720x600 no horizontal overflow. Native test:media-host separately passes actual synthetic Opus both ways and lease-expiry silence. Native test:voice-calls passes real Noise/authenticated SDP/synthetic Opus across two app runtimes under ONE Electron main. Physical microphone/OS grant, audible output, independent full-client media, group/device/volume/VAD/latency, real Roblox/fullscreen/global input and cross-NAT remain unverified. See docs/evidence/desktop-voice-controls.md.

Next3 shell actions:

```powershell
git status --short; git log -4 --oneline
pnpm package:win
Get-Content dist/windows-development-latest.json
```

Next refresh/verify clean Windows artifact and record exact source/hash/count/smoke evidence. Then extend native media proof to independent full app processes with isolated profiles, actual protected credentials/Noise and synthetic audio, retaining explicit consent and no physical mic capture. Keep balanced backlog: device/PTT/volume/metrics, positive real Roblox lifecycle, native setup root cause/reuse, multiple-seed resilience, contact eligibility/safety and release gates. No module fully product-accepted; do not complete goal.

Latest actual package before refresh remains dist/LobbyMesh-win32-x64-1793213204638/LobbyMesh.exe from clean e17692d,653 files/415476184 bytes,56 external copies; actual executable/independent verifier passed. Unsigned/no installer/fresh-machine/public release; LICENSE unresolved. Prior prototype folders retained because optional cleanup was rejected by automatic approval review (blocked by policy); do not retry deletion via workaround. Preserve external private seed and history. Unified requirements already persisted in IMPLEMENTATION_PLAN.md.
