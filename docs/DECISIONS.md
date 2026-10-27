# Decisions

ADR 001: Node 24 LTS, TypeScript strict, pnpm 11.25.0, Electron 45.1.0 and React 19.3.1. Node built-in test runner via tsx is the equivalent deterministic test framework. Electron renderer is sandboxed with no Node, denied permissions, local CSP, no navigation, and one argument-validated status IPC restricted to its main frame. No network or audio is enabled by the scaffold.

ADR 002: Use Node OpenSSL Ed25519, never custom crypto. Initial fallback storage is a 0700 directory and 0600 exclusive-created key file on POSIX; Windows needs an OS-protected adapter before release. Unsupported future key formats fail closed rather than being overwritten.

ADR 003: Pin HyperDHT 6.35.0. Its upstream README and installed source confirm lookup/announce/unannounce/createServer/listen/destroy APIs. Use stock public bootstrap defaults only for entrypoint discovery. Transport identity is a separately persisted seed/keypair; `transport:<hex>` hints must never pass as authenticated app PeerIds. No app session IDs appear in public topic. Current backend rejects incoming streams until M07 installs an authenticated handler. Public UDP smoke timed out; external availability unresolved.

ADR 004: App overlay foundation uses 256-bit XOR IDs, k=20 retained contacts/bucket and bounded signed record store. Full buckets retain established entries; eviction/liveness checks and iterative lookup remain M08. LocalOverlay deliberately does not implement the preliminary ApplicationDHT interface yet: its signed record schema is versioned RecordV1 and network join/RPC remain absent. A fake announcement is unit evidence only.
