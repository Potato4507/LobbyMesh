# Voice control foundation — 2026-10-28

Verification: VERIFIED_UNIT / VERIFIED_INTEGRATION / PARTIAL. `packages/voice/src/signaling.ts` implements consent-bound call control; it does not implement audio. Production desktop routing constructs the controller without a media adapter and without granting consent, so it rejects incoming voice packets. No activation IPC, voice buttons, capture, recording or permission change was added.

The existing authenticated, app-ID-pinned direct Noise channel carries offer/answer/ICE/hangup under `companion/media/v1`. Strict envelopes bind authenticated sender, recipient, call ID, operation and timestamp. SDP is opaque bounded data for a future trusted local media owner; accepting signaling is not proof of a valid SDP or an authenticated DTLS/media connection. A future adapter must validate descriptions, maintain media identity binding, close media on controller cancellation and handle active-call state separately from negotiation.

Defaults and bounds:

- Local contact approval, local voice consent and a trusted available-media callback must all pass. Incoming offers only ring; explicit local answer is required. Session discovery never grants voice permission.
- One call, negotiation lifetime at most 30 seconds, individual sends at most 2 seconds by default (configurable up to 5 seconds), eight outstanding sends. Failure clears the owning call; late transport completion cannot resurrect it. Hangup clears local state before its bounded terminal send. Shutdown aborts terminal sends too.
- SDP at most 12 KiB UTF-8, candidate 2 KiB, mid 256 bytes, envelope 20 KiB inside existing 24 KiB RPC frame. Exact fields, 128-bit packet/call IDs, 30-second packet age and five-second future skew. ICE data is copied at boundaries.
- 48 ICE packets in each direction, 64 pending local media events, 512 replay digests, 256 retained call IDs and rate entries, 90 received packets per peer per ten seconds. Replay/call-ID history lasts 60 seconds; exact packet duplicates ACK without repeating events, conflicting IDs and reused call IDs reject. No SDP/ICE persistence or raw signaling IPC/logging.
- Simultaneous offers may both fail busy. No perfect-negotiation/glare recovery, group rooms, active media, ICE restart or silent relay fallback is claimed. Production consent remains off until a real media/permission implementation is ready.

Observed Windows Node v24.22.1 / pnpm 11.25.0:

- Nine focused voice cases pass: default deny and explicit answer; adapter/contact policy; malformed/spoofed/expired/oversize packets; duplicate/conflict/call/transport mismatch; outbound ICE quota; withdrawal/deadline/close/late completion; invalid ACK/local immediate hangup; reused call ID/rate flood; inbound ICE and concurrent send caps.
- The two-process local-bootstrap integration test uses the production controller and real HyperDHT Noise/app authentication after signed mutual contact pairing. A disabled receiver rejects, an enabled receiver rings, explicit answer transitions to negotiating, synthetic ICE crosses the channel, hangup clears state, and contact revocation discards an unanswered offer and prevents answering.
- Full `pnpm test`: 110/110. `pnpm typecheck`, `pnpm lint` (109 files), `pnpm build` and `pnpm test:desktop` pass, including independent protected credential reopen. Existing microphone-denial and default-off native checks remain passing; native smoke does not exercise real voice media.

All SDP and ICE in tests are synthetic strings. No RTCPeerConnection, RTP, Opus, microphone, audible signal, OS device switching/PTT/mute, echo/jitter, group load, real Roblox or cross-NAT media test occurred. M13 remains partial. Next implement an isolated media owner with explicit OS/local permission and fail-closed capture teardown before exposing controls as functional audio.
