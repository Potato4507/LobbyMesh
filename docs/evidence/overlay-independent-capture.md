# Capture refresh independent of pending dashboard reads

The identity preview's second clean Windows pipeline passed main, voice,
conversation and session modes, then failed `PERSISTENT_CAPTURE_STATUS_TIMEOUT`
in the overlay mode. The original failed summary is retained in
`identity-preview-second-windows-failure.json`; no package was produced.

The overlay previously polled status, overlay settings and voice in one
`Promise.all` guarded by one busy flag. A deliberately held status read prevented
fresh capture facts from being rendered even though the independent voice owner
had already started capture. The focused before-fix run reproduced the same
timeout. This is a presentation/ownership bug, not physical-audio evidence.

Voice now has its own single-in-flight polling path. The persistent microphone
indicator uses that dedicated voice snapshot. Dashboard and voice failures are
tracked separately; either actual read failure still renders unknown, hides
activity/chat, retains End and preserves the existing draft owner. Action
revisions continue to discard late voice snapshots. No capture, transmission,
consent, IPC authentication or PTT security guard is relaxed.

The native regression now explicitly holds an overlay dashboard completion,
asserts it is actually held, starts a synthetic call, and requires the persistent
indicator to show capture before releasing that completion. All original capture,
unknown, End failure, stale observation, draft recovery and focus tests remain.
Focused `pnpm test:desktop --overlay-capture-only` passes after the repair, with
the original 30-second process bound and original status assertions intact.
Original failure logs and before/after focused logs are retained under `dist`.
