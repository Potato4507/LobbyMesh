# Reuse, provenance and remaining custom code

LobbyMesh uses pinned upstream components rather than implementing its own
encryption, codec, browser engine or installer. Reuse does not establish
end-to-end acceptance: application permissions, lifecycle and actual network
behavior still need tests. `pnpm-lock.yaml` pins the resolved dependency graph.

| Area | Reused implementation | LobbyMesh integration and limits |
| --- | --- | --- |
| Encrypted chat transport/discovery | [HyperDHT](https://github.com/holepunchto/hyperdht), NoiseSecretStream/libsodium | Already used for authenticated encrypted connections and public bootstrap. App signatures bind transport sessions to protected Ed25519 identities. No custom cipher. Direct NAT reachability is not universal. |
| Voice codecs/security/ICE | Chromium's native WebRTC, Opus and DTLS-SRTP | Actual audio peer connections, authenticated signaling and audio-only SDP. Local graph owns capture, gain and PTT. No home-grown audio codec or media encryption. |
| Browser compatibility | [webrtc-adapter 9.0.6](https://github.com/webrtcHacks/adapter), BSD-3-Clause | Imported in the dedicated AudioPeer owner. Upstream shims handle browser/spec differences; they do not grant permission or start capture. |
| SDP parsing | [sdp 3.2.2](https://github.com/otalk/sdp), MIT | Uses the same parser ecosystem as adapter.js for media/codec structure. Additional strict one-audio-section, Opus/48kHz and SHA256 fingerprint checks remain. Video/data-channel and malformed descriptions are denied. |
| Public address discovery | Google public STUN as used by the [WebRTC project's ICE sample](https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/) | Used by explicitly started production voice calls; no credentials, account or owner-hosted server. STUN is address discovery, not an audio relay or connectivity guarantee. Synthetic tests keep an empty server list. |
| Identity/signatures | Node/OpenSSL Ed25519 and SHA256 | Full app IDs derive from public keys. OS-protected private keys remain unchanged. Names are not IDs. Roblox public-profile proof is a separate limited ownership check, not custom OAuth. |
| Secret storage | Electron safeStorage on Windows | Main-process protection, migration and protected reopen; unsupported desktop providers fail closed. |
| Desktop | Electron/Chromium and React | Sandboxed, isolated renderer; narrow authenticated IPC. Native Windows focus and lifecycle remain integration concerns. |
| Windows setup | Portable NSIS 3.13, archive/compiler SHA256 pinned | Per-user setup, Start menu and enumerated-file uninstall. No administrator access/services/security changes; installer remains unsigned. |

Chat's acknowledgments, bounded retries, deduplication, contact policy and
ephemeral history are application code over the upstream encrypted transport.
Voice consent, call-state ownership, stale-operation handling and PTT leases are
also application code. These are covered by focused and native tests; they are
not represented as fully inherited from a third-party chat application.

We evaluated simple-peer as a higher-level voice/data library. Its documented
always-created data channel conflicts with LobbyMesh's deliberately audio-only
SDP contract. Adapter.js plus upstream SDP parsing can be integrated without
discarding that contract or replacing the whole signaling/permission system.
A generic library substitution cannot repair OS focus races or supply a free
universal TURN relay. Any broader protocol migration needs independent tests and
must preserve identities, mutual permission and encryption.

New dependency licenses are retained in package third-party notices, alongside
all existing notices and the tracked HyperDHT patch. The root MIT license does
not replace upstream BSD/MIT notices. Upstream code is installed as pinned
dependencies, not copied without attribution. No paid service is configured.

The adapter/parser integration passed focused negative description tests and
native browser-to-browser synthetic audio: capture consent, muted start, PTT,
input/output controls, measured energy, input switching, interruption and cleanup.
That evidence is not physical microphone output, real Roblox use or proof of
real external-network media. The evidence ledger records the exact build source
and failed Windows gates separately from subsequent successes.
