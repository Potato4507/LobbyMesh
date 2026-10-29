# Native audio track interruption — 2026-10-29

Production AudioPeer now ends its media owner when the local source emits mute or the remote audio track ends. Existing local-ended handling is retained. Closing disables/stops owned tracks, removes ended/mute handlers, closes the peer connection and notifies the media owner. An already-muted source is rejected as MEDIA_DEVICE_UNAVAILABLE and stopped during offer cleanup. An unmute event cannot revive an old call or held PTT intent; a new call requires explicit consent. This deliberately ends a call on source interruption instead of automatically resuming capture/transmission.

Observed Windows Electron45.1.0, Node24.22.1:

- `pnpm test:audio`: pass using native sandboxed Chromium/WebRTC and synthetic oscillator streams; 11 sources. Existing decoded sound/PTT silence, timeout/late-capture cleanup and optional-stat isolation checks retained. Injected source mute, source ended, remote ended and initially-muted fixtures verify terminal state, capture/transmission off, stopped/disabled source, detached handlers, no unmute reactivation and old PTT rejection. Browser microphone permission remains denied.
- `pnpm test:media-host`: pass, isolated renderer ownership, bidirectional synthetic audio, output controls, statistics and permission denial.
- `pnpm test:voice-calls`: pass, two production runtimes with native Noise signaling, synthetic media, consent and teardown.
- The initially-muted fixture first revealed that the generic operation mapper discarded MEDIA_DEVICE_UNAVAILABLE; it now preserves that existing allowlisted error. No new IPC or wire operation.

Tier: native SAME_PROCESS synthetic media. Lifecycle events are injected, not observed hardware removal or OS mute. No actual microphone, audible playback, physical latency, Pi, LAN/NAT, Roblox or packaged-pair claim. Device-specific acceptance remains open.
