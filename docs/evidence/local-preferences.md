# Persistent local preferences and policy - 2026-10-27

Windows / Node v24.22.1 / pnpm 11.25.0. Previous checkpoint 48e14a3 retained.

`pnpm exec tsx --test tests/preferences.test.ts`: 4/4 passed. Default network disabled, session consent false, voice off; explicit local allow/revoke/block/unblock; blocked overrides allowed; unblocking never automatically re-authorizes. Concurrent updates serialize and retain both changes; snapshots copied; close drains writes and denies authorization; reopen reads saved state.

Storage uses 0700 directory/0600 files on POSIX, exclusive preferences.lock with random ownership token, same-directory random temporary file, file sync then rename. At most one store owns a directory; a second open fails EEXIST. Size cap 128KiB, schema version/field whitelist, allow cap 256 and block cap 1024. Corrupt/future/unsafe files fail closed without replacement. Failed replacement preserves prior snapshot and removes the operation's temporary file. Block and revoke deny immediately in memory; failed save does not re-authorize. Four tests execute real Windows filesystem operations, not a fake storage layer.

Not yet wired into desktop/runtime policy callbacks. This is not OS-encrypted credential storage. Windows ACL and power-loss directory durability are unverified. A crash may leave a lock: fail closed; never delete a lock or overwrite settings automatically. Recovery procedure must verify app is stopped and preserve the file before explicit local repair. Human consent/age/reporting controls remain product gates, not solved by storing an allowlist.

Milestone regression: `pnpm typecheck`, `pnpm lint` (60 files), `pnpm test` (49/49), `pnpm build` passed, exit 0.
