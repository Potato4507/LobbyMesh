# Per-call microphone gain — 2026-10-29

Production voice now exposes linear input gain0–2 (0–200%), unity1 by default, resetting for each call. The dedicated sandboxed media owner builds an input-only WebAudio gain graph feeding its Opus sender; it does not connect input to a local speaker or retain audio. The original capture track and processed sender track both remain muted until explicit PTT, both disable on reconnect, and both stop on teardown. Input-context suspension is terminal, preventing a silent graph from retaining live capture.

The main-window-only exact action is `{action:"input-gain",callId,gain}`; only the current concrete call ID is accepted. Native media command is exact `{id,op:"input-gain",data:number}` with range/finite validation and null ACK. No endpoints, device IDs, remote signaling operation, persistence or new capture permission. Main reports the acknowledged per-call scalar. One update is in flight per owner, rejects overlap, cancels on hangup/policy withdrawal, and late completions cannot overwrite replacements. Failed/unconfirmed native updates end media. Gain0 has priority at the main IPC gate and a200ms hangup watchdog for stalled silence requests; this is distinct from microphone off. Gain above1 may clip; UI explains this.

UI slider coalesces rapid intents to the latest value with120ms debounce, sends zero promptly, cancels timers on unmount and is keyed to call ownership. Existing output controls remain independent. New controls and PTT fit the existing scrollable720x600 layout without horizontal overflow. Reviewed updated `lobbymesh-voice-test.png`; fixture explicitly labels synthetic/no microphone/network.

Windows Node24.22.1/Electron45.1.0:

- `pnpm typecheck`, `pnpm lint`160 files, full `pnpm test`:148/148; `pnpm build` pass.
- `pnpm test:audio`: native decoded unity RMS0.7039, quarter input0.1779, zero0. No gain action starts PTT. Existing source-muted/ended/remote-ended, initially-muted, new input-context-suspended, processed-track cleanup, timeout/late-capture and quality isolation checks pass.
- `pnpm test:media-host`: native sandboxed input command passes with decoded quarter/zero input; output attenuation/mute, isolated sessions, denied hardware permissions and foreign-ready rejection retained.
- `pnpm test:voice-calls`: authenticated production Noise/signaling and bidirectional synthetic media pass.
- `pnpm test:independent-voice`: two separate desktop Electron processes, signed pairing and real app IPC. Unity0.7049, quarter input0.1767, zero0; restore verified, protected identity reopen/revocation and consent reset retained.
- `pnpm test:voice-crash`: independent process loss still mutes/reconnects then clears capture/hosts; final cleanup11294ms in this observation. No latency improvement claim.
- `pnpm test:desktop`: UI gain rapid intents, no PTT activation, stale call rejection, reset-on-new-call, output controls,720x600 layout, overlay denial, sandbox, protected reopen pass. A deliberately stalled zero-gain update ends capture through the main200ms watchdog; a rejected zero-gain request also ends that current call.

Sanitized scalar observations in `input-gain-native-summary.json`. Evidence is native SAME_PROCESS/SAME_HOST with synthetic oscillators. No actual microphone/audible output, physical gain calibration/latency, device compatibility, group scale, Pi/LAN/NAT or actual Roblox proof. Input device selection and VAD remain unfinished.
