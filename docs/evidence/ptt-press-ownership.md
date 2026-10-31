# Keep delayed talk failures scoped to their press

2026-10-31: reproduced a native Windows renderer race with real production IPC validation and synthetic media. The fixture held a successful talk operation's reply, released that press, began a fresh press, then rejected the old reply. The old renderer catch handler unconditionally called release, muting the fresh press. The new assertion failed before the fix: aria-pressed was false instead of true.

VoiceControls now increments a hold revision on release. Each renewal captures that revision and its call ID. A rejection releases transmission and displays its notice only while that exact press and call are still current and the component is alive. Unmounted controls cannot dispatch renewals. The capture-consent, focus, permission, lease-renewal and backend stop rules remain unchanged; no failed operation can start capture.

The native regression verifies that an old rejection preserves a newer press, then injects a rejection for the current press and verifies that it still mutes. A further fresh press recovers, followed by the original reconnect, keyboard, pointer, focus-loss and stalled-teardown checks. All six native modes pass with their original 30-second bounds. Full Node253:252pass,1 existing POSIX-only skip; typecheck, lint244 and build pass. No real microphone or audible output was used.

Previous clean package source fb2a381 remains retained separately. Its GitHub run41220239378 and evidence checkpoint db0173b run41220454708 passed; neither proves the intermittent native transport issue fixed. New source packaging will be recorded separately after commit. Physical app reliability, actual Roblox, physical audio and release acceptance remain open.
