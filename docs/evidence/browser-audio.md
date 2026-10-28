# Browser audio primitive — 2026-10-28

VERIFIED_INTEGRATION / PARTIAL. `packages/voice/src/audio-peer.ts` is a browser-only, single-use audio engine. It is not imported by the production desktop or overlay renderer and is not yet connected to the authenticated signaling controller. Production microphone permission remains denied and production voice remains unavailable.

The engine implements explicit consent and a trusted dynamic permission callback before capture, audio-only getUserMedia constraints, muted initial tracks, explicit PTT transmission gating, Opus-only codec preference, one send/receive audio transceiver, browser DTLS-SRTP, complete-ICE SDP negotiation and receiver stream delivery to an owner-provided output. SDP must contain one audio section, Opus and a consistent SHA-256 DTLS fingerprint within the existing 12 KiB bound. Descriptions must come from the authenticated controller in the future integration; the engine itself cannot verify app identity. No recording or custom encryption. ICE has no configured STUN/TURN/relay; this local-host proof does not establish internet reachability.

Each browser operation is deadline bounded (default at most five seconds). Close stops owned local/remote tracks, clears callbacks/timers, closes the RTCPeerConnection and cancels awaiting operations. getUserMedia is not abortable; a late-result continuation independently stops returned tracks after timeout/close or permission withdrawal. Capture failure, device-ended, remote-track rejection, failed connection and five-second disconnect fail closed. The trusted future host must notify permission/policy withdrawal by closing the engine; status also closes when the dynamic permission callback denies. No claim of polling being instantaneous hardware revocation.

Native command: `pnpm test:audio`, Windows Electron45.1.0. A separate sandboxed/no-Node hidden renderer with all browser permissions denied runs two actual RTCPeerConnections and synthetic oscillator tracks. The remote stream is consumed by an audio element with volume zero plus a WebAudio analyser; no speakers are intentionally driven. A receiver element was necessary in this runtime for decoded WebAudio playout: the initial run connected and counted RTP packets but returned zero samples, and correctly failed. The revised test requires actual decoded sample activity, not merely transport success.

Observed passing run:

```json
{"syntheticSources":4,"receivedPackets":46,"receivedBytes":2849,"receivedEnergy":0,"mutedRms":0.000002336051101031902,"talkingRms":0.7057453705404692,"releasedRms":0,"microphone":false,"audibleOutput":false,"crossNat":false,"electron":"45.1.0","sandbox":true,"permissionRequests":1}
```

RMS is the measured decoded waveform in the synthetic renderer. Chromium totalAudioEnergy reported zero even during the tone; it is not accepted as silence/VAD evidence. The metrics API preserves missing energy as null; packets/bytes and RMS, rather than the energy field, establish this experiment's result. Numbers vary by scheduling and are not latency benchmarks.

Checks include no capture before local consent, dynamic denial, malformed offer rejected before capture, one actual browser microphone request denied with no captured stream, muted startup, connected bidirectional peer transports, synthetic tone/receiver packet growth, PTT release to silence, permission withdrawal stopping tracks, close, overlapping capture rejection, capture timeout and late/canceled capture cleanup. Four oscillator streams are synthetic sources including two late-result fault cases. No physical microphone, audible voice, OS hardware switching, echo quality, real app-identity-to-media integration, independent-client media, group stress or cross-NAT acceptance. Explicit OS/isolated-host integration remains next.

Implementation references: [W3C WebRTC Recommendation](https://www.w3.org/TR/webrtc/) for PeerConnection/description/codec/DTLS interfaces and [Media Capture and Streams draft](https://www.w3.org/TR/mediacapture-streams/) for capture/track lifecycle. Requested echo cancellation/noise suppression/automatic gain are constraints, not measured device quality.

Regression: full `pnpm test` 110/110, `pnpm typecheck` and `pnpm build` passed. Native audio checks run separately from the default Node suite; lint checks all 113 files. Production desktop UI and permission configuration are unchanged by this primitive.
