# Current-call overlay widget — 2026-10-29 UTC

Base `63ef7ea`; tested Windows source working tree, Electron45.1.0/Node24.22.1. Optional `voice` widget preserves the original three-widget default and existing saved layouts. Visibility/order persist in v1 preferences; up to four unique widgets remain bounded. No automatic permission migration.

Separate trusted-main-frame channels expose exactly `{phase,callId,capturing,transmitting}` and accept exactly `{callId}` to end the current call. Concrete 32-hex ID required; null, extra fields and stale IDs deny. Main compares the current service call before clearing the talk lease and hanging up. Stop bypasses ordinary command quota. No new capture grant, answer, call, output or PTT capability. Existing overlay voice-action/status denial remains. Foreign windows cannot use either new channel.

Renderer shows actual capture/transmission (including unknown), reconnecting and incoming status. End is visible only in interaction mode. Poll results predating an End action cannot replace its returned observation; error says cleanup is unconfirmed and directs to main window. Main-window controls remain responsible for starting/answering/talking. The overlay uses existing scrolling when all widgets exceed the work area.

Validation:

- `pnpm typecheck`, `pnpm lint`152 files, `pnpm test`131/131, `pnpm build`: pass.
- Protocol/preferences tests cover malformed stop requests, four-widget validation, persisted voice order, legacy defaults and snapshot isolation.
- `pnpm test:desktop`: actual Windows renderer/preload/main calls pass, including redacted response keys, denied general voice/status/network grants, invalid/stale/null/extra-field stop requests, actual End click, synthetic failed-teardown unknown, confirmed cleanup, replacement-call stale-ID rejection, foreign-window denial and passive restart with saved voice order. Separate protected-credential reopen passes.
- Reviewed `lobbymesh-overlay-voice-test.png`: real native overlay, clearly marked synthetic voice/no microphone or network, current call/End/capture/transmission visible. New settings checkbox reviewed. All other regenerated screenshots restored to avoid unrelated noise.

Fixture debugging retained: adding a replacement call after the intentional close failure required explicitly ending the independently owned remote fixture. Local voice is disabled on failed teardown, so the remote's final signal returns exact VOICE_DISABLED; its call is still cleared locally. This does not prove a remote receives hangup on a failed path. A later persistence assertion was updated to require the newly selected voice widget. Final smoke passes; no production timeout, permission or transport assertion relaxed.

Proof: native UI/IPC with injected control/media; **not PHYSICAL_AUDIO, ACTUAL_ROBLOX, real gameplay/global input or cross-NAT acceptance**. No real microphone or voice activation outside explicit main controls.
