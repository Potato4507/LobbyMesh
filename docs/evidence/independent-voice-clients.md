# Independent desktop media clients — 2026-10-28

VERIFIED_INTEGRATION / PARTIAL. `pnpm test:independent-voice` launches two separate source-built Electron desktop clients with distinct temporary profiles, actual protected Windows app/transport credentials, production createDesktop/createDesktopNetwork/VoiceCalls/preload/UI/media-host/engine and a local-only HyperDHT bootstrap. The app factory accepts an optional trusted bootstrap override for this hermetic test; ordinary production defaults and renderer IPC have no manual endpoint/bootstrap input.

This closes the earlier shared-Electron-main limitation for synthetic media. It does not test two packaged executables, distinct computers/NATs, physical microphones, audible output or real Roblox. Fixture main entries drive genuine main-window preload IPC; media capture alone is replaced by a synthetic oscillator and output volume is zero. Actual main-window focus is acquired for consent/call/answer/PTT. Raw test waveform probes are confined to the fixture; the app UI receives no samples/SDP/endpoints.

Observed Windows run:

```json
{"result":"independent-voice-passed","electronMainProcesses":2,"clientLaunches":3,"restartedIdentityPreserved":true,"voiceConsentReset":true,"revokedContactPersisted":true,"distinctProfiles":true,"distinctAppIdentities":true,"protectedCredentials":true,"mutualSignedPairing":true,"forward":0.7045295438484639,"silence":0,"reverse":0.7058946105956927,"recipientNoCaptureBeforeAnswer":true,"microphone":false,"audibleOutput":false,"crossNat":false}
```

Assertions compare actual child process IDs with each client's reported main PID, distinct app IDs/profiles, default voice/mic off, signed contact-code approval on both sides through real pinned Noise authentication and persistent policy, recipient default denial, no recipient media host before explicit answer, connected WebRTC media, sustained PTT across renewals, decoded receiver RMS in each direction, release to silence, hangup and immediate revoked-contact host teardown.

One client exits cleanly and is relaunched in the same isolated profile with a new PID. Its Ed25519 app identity survives actual OS-protected reopen, revoked approval remains denied, and voice permission is off. Explicit fresh reapproval/voice enable restores an authenticated call. Protected ciphertext file presence/bounds/plaintext-marker absence are checked without logging bytes; real native credential loading/reopen provides the encryption evidence, not marker absence alone. Final cleanup requires zero windows and exit0 for both active clients, then removes only the guarded owned temp root/build entry and local bootstrap.

The initial harness run reached media/cleanup checks but failed on an invented credential filename. Corrected to the existing identity-os-v1.bin format, then reran successfully. No application credential migration or real profile was changed.

Node118/118, typecheck, lint132 files pass. The script runs separately from the default Node suite because it requires native Windows Electron/safeStorage and temporarily focuses its own app windows. Current public artifact remains clean2ea4154; this is source-built integration proof, not a new package release.

Remaining: packaged-client/remote-host variants, abrupt process/network failure timing, physical mic/OS grant/audible quality, device switching, volume/deafen/VAD/latency controls, group bounds/stress, game/global-input/fullscreen, contact eligibility/safety and cross-NAT. No formal release or security acceptance inferred.
