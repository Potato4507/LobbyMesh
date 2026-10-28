# Network lifecycle foundation - 2026-10-27

Windows / Node v24.22.1 / pnpm 11.25.0. New NetworkLifecycle owns one runtime, explicit opt-in, idempotent starts, generation guards, cancellation, bounded startup/cleanup, at most three automatic attempts with exponential backoff/jitter, sleep/resume and copied status snapshots. A failed cleanup remains an error, not a false offline success. Late factory results are disposed; failed late cleanup is retained for explicit retry. Injected factories must honor cancellation; arbitrary ignored dependency code cannot be forcibly terminated.

Runtime changes: cancellation checked before/after identity/key loading, abort listener owns shutdown, overlay cancellation precedes awaited cleanup, graceful directory cleanup has a 1s deadline before native force-close, native close is idempotent. Unknown bootstrap cannot indefinitely keep the app listening during disconnect. Existing signed-record and public-directory contracts unchanged; a forced close may leave expiring public hints.

`pnpm exec tsx --test tests/network-lifecycle.test.ts`: 8/8 passed. Duplicate start, rapid opt-out/opt-in, sleep/wake, disabled wake, late factory, stalled handshake/start, retry cap, canceled retry, failed cleanup and retry. One test uses the actual native runtime against unreachable local bootstrap 127.0.0.1:9, cancels startup, and observes clean offline state (~1.0s). This is not a public or cross-NAT test.

Neighbor verification before UI wiring: existing local-process integration and CJS bundle tests also passed (9/9 at initial lifecycle pass). Desktop controls and live status are the next increment; no network is automatically enabled by this foundation alone.

Milestone regression: typecheck, lint (68 files), full 58/58 tests and build passed. No repeated public-network smoke needed for these cancellation/state-machine changes.
