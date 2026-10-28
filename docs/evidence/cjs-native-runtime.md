# Native runtime bundle compatibility - 2026-10-27

Windows / Node v24.22.1 / pnpm 11.25.0 / Electron 45.1.0. Reproduced at cac4d0f: bundling packages/app-dht/src/runtime.ts as CJS emitted empty-import-meta warning; requiring output threw ERR_INVALID_ARG_VALUE because createRequire received undefined. This would break desktop startup once the runtime was imported.

Fix: static HyperDHT import with narrow pinned upstream declaration; keep hyperdht external to CJS builds, preserving native addon resolution. Smoke fixture now builds inside project dist (temporary Chromium/preferences state still lives in OS temp), matching application dependency resolution. Electron smoke explicitly imports the runtime factory, verifying native module initialization without creating sockets.

`pnpm exec tsx --test tests/runtime-bundle.test.ts tests/transport-keys.test.ts`: 2/2 passed. The new test builds a CJS runtime bundle, asserts no build warnings and loads it in a separate Node process that exits naturally without sockets. `pnpm typecheck`, `pnpm build`, `pnpm lint` (66 files), `pnpm test:desktop` all passed; Electron loaded the native dependency and existing real settings/security UI checks passed. No public smoke rerun required.
