# Versioned implementation contracts

All implemented packages are v1. Protocol types are preliminary and require review before wire use. No authenticated transport adapter exists yet.

Identity: loadOrCreateIdentity(directory) persists PKCS8 Ed25519 with exclusive creation and rejects corrupted/future versions. Concurrent creation fails closed; callers must retry after the creator completes. Identity closure exposes signing but not private export. resetIdentity removes local credentials; remote revocation is not implemented. POSIX fallback permissions tested. Windows credential protection and migration are incomplete.

RecordStore: key-bound canonical JSON arrays, domain app-overlay/v1, SPKI public key, SHA256 PeerId, Ed25519 signatures, safe integer sequence, 120-second TTL maximum, 8KiB serialized input and 1024 author/key slots. Replay high-water marks bounded for process lifetime. Capacity exhaustion rejects new slots (availability tradeoff). This is a local security primitive, not a complete app DHT. Caller must bound incoming frames BEFORE JSON decoding; records take untrusted decoded objects only.

Session: MockSessionProvider is test-only, accepts only mock provenance; copies on publish/read. No production session API or manual server-ID entry.

Roster: consumes previously authenticated opted-in app participants; does not prove consent or Roblox account identity from an untrusted boolean. Callers must validate ads and establish consent before join. Rejects invalid identifiers, control characters and quota overflow; names need not be unique. Exports only whitelisted app data and enforces block on rejoin. In-memory block persistence and moderation remain unfinished.

Public-discovery/v1: fixed SHA256 topic, transport-key hints with no connection address export, at most 256 candidates/query, lookup minimum 1s and announce minimum 30s, query deadline 10s. Injected query destroy MUST terminate pending async iteration. Listening and graceful unannouncement currently depend on backend completion; standalone smoke bounds the entire lifecycle at 15s. Backend instances are single-use after stop; allocate a fresh HyperDHTBackend to reconnect. Periodic republishing/backoff and persistent key OS protection remain integration work. Memory fake supports restart. Native keys are intentionally distinct from app identity; binding required in M07.

Entrypoint-search/v1: max 4 parallel probes, 64 unique keys, overall deadline (default 3s), AbortSignal forwarded to probes. Probe is a trusted adapter responsible for real cryptographic verification; an untrusted wire boolean must never populate authenticated directly. Injected probes and iterators must release resources on cancellation; timeout bounds caller waiting but cannot force arbitrary injected code to terminate. Discovery hints alone are insufficient. No-reachable-candidate is never proof that no overlay exists.

LocalOverlay v1: start publishes entrypoint through injected discovery; failure cleans discovery. put/get only while running; leave clears ephemeral routing/store. RPC, join and peer authentication absent. RoutingTable accepts already authenticated app contacts only (not raw public hints); caller must validate key-to-PeerId binding in M07. All contact output is copied, connection hints discarded.
