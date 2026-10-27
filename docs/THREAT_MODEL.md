# Preliminary threat model

Untrusted peers can forge room claims, create Sybil keys, spam routing tables, replay records, withhold results, and exhaust resources. App keys prove possession only; they do not establish Roblox account, age or trusted room membership. DHT membership is not authorization. Direct peers can observe network addresses. Public infrastructure availability is external.

Implemented boundaries: strict protocol major check, narrow renderer IPC with main-frame sender checks, permissions denied, no audio/network startup, bounded signed record store with key/domain binding and replay checks, consent-only test roster with block filtering. Node OpenSSL Ed25519; no custom encryption.

Unfinished: authenticated transport, stream frame limits, persistent block/consent, admission controls, traffic rate limits, durable sequence/revocation, session authorization and media identity binding. No secure network product claim until these are integrated and tested. No reporting service or human moderation exists. Do not activate unsolicited contact based on mock or self-asserted membership.
