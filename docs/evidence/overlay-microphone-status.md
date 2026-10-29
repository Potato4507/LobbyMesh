# Overlay microphone status — 2026-10-28

The Connection widget previously rendered static “Microphone off” even during a call. It now uses the existing main-owned status field: capturing -> “Microphone on”, off -> “Microphone off”, and unknown/missing -> “Microphone state unknown”. Failed polling hides stale widget content behind the existing unavailable message. The one-second status polling cadence is unchanged; this is a display, not a real-time capture alarm.

Verification: typecheck/lint/build and native Windows Electron45.1.0 desktop smoke pass, including independent protected credential reopen. The actual overlay renderer/preload/main status path reports off before a call, on during an explicitly enabled/answered synthetic call, unknown after an injected media close failure, and off after confirmed cleanup retry. Overlay voice-consent and network actions remain denied. No capture permission or voice action was added to the overlay.

Reviewed screenshot: lobbymesh-overlay-voice-test.png. Its label explicitly identifies synthetic voice without a hardware microphone or real network. This does not establish physical microphone, Roblox/fullscreen, audible output or global PTT acceptance. Unrelated regenerated screenshots were restored.
