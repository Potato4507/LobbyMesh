# Windows Electron preferences integration - 2026-10-27

Windows / Node v24.22.1 / pnpm 11.25.0 / Electron 45.1.0. Previous checkpoint e58937a.

Pinned installer source inspected, then `node node_modules/electron/install.js` passed. Unlike historical Linux fetch failure, the binary is available on this Windows host. `pnpm test:desktop` launches a real hidden Electron window with isolated temporary Chromium/preferences directories; no visible window, no normal app profile modification, no network or microphone activation.

Passed assertions: actual sandboxed/context-isolated preload flags; renderer require/process undefined; preload IPC; offline status and default consent/network/voice off; real form input/save and persisted display name/consent; unknown preference fields rejected; arbitrary allow IPC action rejected; block/unblock updates persisted lists without restoring permission; foreign-window IPC rejected. Renderer error paths expose generic errors rather than filesystem details. Captured docs/evidence/lobbymesh-settings.png and visually inspected: legible controls, complete panels, no overlap at 1080x1000. Normal 1080x800 window scrolls.

Harness corrections: CommonJS fixture requires async wrapper; Electron 45 does not declare getLastWebPreferences, so use real isolated-preload runtime flags plus absence of renderer Node. An initial run exited 0 without a completion marker/image; it was not counted as proof. Parent harness now requires explicit passed marker in addition to exit 0. Idempotent window cleanup and load-failure preference cleanup added. Final command chain passed: `pnpm typecheck`, `pnpm lint` (63 files), `pnpm test` (49/49), `pnpm build`, `pnpm test:desktop`.

Settings screen does not claim desktop peer networking, Roblox detection, voice or contact-request onboarding is implemented. It edits local preferences and existing allow/block entries only. No raw peer/server-ID entry box; no unrestricted authorize IPC method. Microphone permission remains denied. Stale/corrupt preference state is preserved and shown unavailable, never reset silently. Native main-frame guard is source-configured; foreign-window rejection is directly observed.
