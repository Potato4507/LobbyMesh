# Desktop network controls - 2026-10-27

Windows / Electron 45.1.0 / Node v24.22.1 / pnpm 11.25.0. Previous lifecycle checkpoint 37295a8.

The desktop now owns NetworkLifecycle and a real createOverlayRuntime/DirectMessenger adapter. Default settings create no network instance. Explicit same-frame boolean network IPC persists permission before enabling; generic preference IPC cannot bypass it. Disconnect cancels first, even if saving fails. Latest permission intent wins across concurrent saves. Up to 16 IPC requests in flight; no raw bootstrap/key/server configuration is accepted. Persisted permission resumes automatically on later launch. Power-monitor suspend/resume listeners are removed on window close; network closes before preferences release their lock.

Live UI displays starting, online/known authenticated-peer count, retrying, stopping, suspended, offline or error. Startup failure/timeout and unconfirmed cleanup stay visible. User opts in after IP-exposure explanation; microphone remains denied and Roblox source unavailable. Connection alone never grants contact permission. Persistent block and authorization callbacks are read dynamically by the actual overlay/direct adapter.

`pnpm test:desktop` passed against a real hidden Electron window with isolated profile. Network UI tests use an injected runtime to deterministically check default-off, opt-in/disconnect, persisted restart, app suspend/resume events and live policy updates; they do not claim public networking by themselves. A separate test in that same Electron process creates the actual native runtime against 127.0.0.1:9, starts it, aborts and confirms teardown/start rejection. No public networking is activated by this desktop smoke. Existing sandbox/isolation/no-renderer-Node, form persistence and foreign-window IPC rejection remain passing, including foreign-window network activation rejection. Screenshot regenerated at 1080x1280 and visually inspected.

Initial extended smoke found a test selector still targeting the first output element after a new status panel was added; preferences now have a stable ID and the test targets it. Active-network persistence assertion updated to reflect its explicit preceding opt-in. Those failed attempts were not counted as proof. No OS security flags were weakened.

Not yet complete: received text is held in the authorized in-memory messenger but needs user-visible history/send UI; no unsolicited/new-contact grant IPC exists. Real physical sleep/resume, distinct-machine/NAT, voice devices, Roblox detection and installer remain separate gates.

Milestone regression: typecheck, lint (69 files), full 58/58 tests, build, and expanded native desktop smoke all passed. No default/public bootstrap call is made by the desktop smoke; public pair evidence remains a distinct explicit run.
