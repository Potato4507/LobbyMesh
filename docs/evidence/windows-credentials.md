# Windows protected credentials — 2026-10-27

Environment: Windows, Node 24.22.1, pnpm 11.25.0, Electron 45.1.0.

Desktop networking loads app Ed25519 and transport seeds through async Electron safeStorage in the trusted main process. Only the Windows provider is accepted; availability/decryption failures stop startup with CREDENTIALS_UNAVAILABLE. The UI reports this separately from connectivity failure. No automatic credential retry or plaintext fallback occurs; a deliberate retry remains available.

Legacy identity-v1.json and transport-seed-v1 migrate to identity-os-v1.bin and transport-os-v1.bin. Migration canonicalizes/validates the original material, encrypts and decrypt-verifies, exclusively writes and flushes ciphertext, reads/decrypts it again, then atomically replaces legacy plaintext with a nonsecret marker. No plaintext backup is written. App PeerId, signing key and transport public key stay unchanged. Conflicts preserve both sources and fail closed. A verified sealed write interrupted before retirement rolls forward. A marker without ciphertext never regenerates identity. Provider-requested resealing retains identity. Concurrent fresh creation has one exclusive winner; retry loads that winner.

Observed checks, all exit 0:

- `pnpm exec tsx --test tests/protected-credentials.test.ts tests/network-lifecycle.test.ts`: 14/14.
- `pnpm typecheck`; `pnpm lint`: 75 files.
- `pnpm test`: 67/67, including real local Noise processes and lifecycle cancellation.
- `pnpm build`; `pnpm test:desktop`: native Windows migration check passed with real safeStorage and generated test credentials. The fixture starts native networking using the migrated credentials against unreachable local bootstrap, then cancels/cleans it. No public bootstrap used here.
- The smoke runner launches a second independent Electron process with the same isolated profile. It reopens protected credentials and compares public identifiers with the first process: `{"result":"credential-reload-passed","independentProcess":true}`. Temporary test state is then removed.

Filesystem fault tests deliberately use a serialization codec, not encryption. Native Electron checks establish actual current-host OS encryption/reopen separately. No private credentials appear in test output; reload proof stores only public identifiers in the isolated fixture profile. Runtime credential filenames and their temporary files are ignored by Git.

[Electron safeStorage documentation](https://www.electronjs.org/docs/latest/api/safe-storage) describes Windows DPAPI protection and async APIs. This protects at rest against other OS users, not other applications running as the same user. Private material is still present in main-process memory during use. JavaScript strings are not guaranteed zeroizable. Legacy disk sectors, Windows ACL enforcement, power-loss durability, protected reset/remote revocation and other OS providers remain unverified or incomplete. Explicit Node development loaders remain plaintext and are not a production fallback. Old loaders/reset refuse protected files. No release-readiness claim.
