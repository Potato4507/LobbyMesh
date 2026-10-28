# Voice interruption — 2026-10-28

Verification: VERIFIED_UNIT / VERIFIED_INTEGRATION, same-host Windows, Electron45.1.0. Physical microphone, audible output, distinct machines, NAT traversal and network mobility remain unverified.

`pnpm test:voice-crash` extends the independent desktop-client harness. It starts two separate Electron main processes with isolated profiles, protected identities, explicit mutual signed contact approval and actual authenticated Noise SDP/synthetic Opus. It also checks volume/mute, revocation and protected-profile restart before abruptly terminating only its owned recipient process during the restored call. The survivor receives no local hangup command until capture is confirmed off and its media windows are gone. The harness retains redacted phase/capture/host-count transitions and cleans its own temporary files after process exit.

Before this change, the observed survivor stayed labeled connected until failure/capture-off at11309ms after process termination. After this change:

| Elapsed | Phase | Capture | Media hosts |
| --- | --- | --- | --- |
| 60ms | connected | on | 1 |
| 6340ms | reconnecting | on | 1 |
| 11261ms | reconnecting | on | 0 |
| 11490ms | failed | off | 0 |

Observed final cleanup was11491ms. These timings are one run, not a guaranteed failure-detection bound or an improvement in detection speed. Browser detection precedes the existing five-second disconnect grace. Main-process polling can briefly retain the last conservative capture-on snapshot after a host closes; it does not claim capture off before confirmation.

When the browser reports disconnected, AudioPeer disables owned audio tracks immediately and clears talking. The UI shows “Reconnecting audio…” and keeps End call available. Recovery within the grace keeps the call but does not re-enable transmission. A fresh local press is required. A stale talking request that races this transition receives the bounded MEDIA_NOT_CONNECTED error without destroying the recovering owner. Other media errors, invalid replies and timeouts retain their teardown behavior. There is no new remote protocol operation or heartbeat.

`pnpm test:audio` injects disconnected/connected state events into an otherwise live native RTCPeerConnection. It verifies actual synthetic decoded output becomes silent, stays silent after recovery, and returns after a fresh press. This is a state-transition fault injection, not real network mobility. Coordinator tests cover the same call ID, capture-on/transmission-off recovery, rejected talking while reconnecting and a request racing the transition. Native desktop smoke injects the media state while Space is held, checks the reconnecting label/End call/PTT removal, then requires a new press after recovery. UI transport/media remain synthetic.

Validation: full Node121/121, typecheck, lint, build, native audio, isolated media-host and desktop smoke pass. The independent crash run also passed signed pairing, actual decoded synthetic Opus in both directions, quarter output~0.17678, output mute0, protected identity reopen, retained revocation and reset voice consent. No hardware microphone or audible output was used.
