# PTT-scoped input activity — 2026-10-29

Connected calls now show post-gain input level and a warning when the sampled peak reaches full scale. This is a level/peak observation, not speech classification, proof of audible distortion, VAD or automatic talking. Only explicit PTT controls transmission. The existing permission/capture/voice controls are unchanged.

The sandboxed owner samples a fixed512-float analyser window after input gain, only while transmitting. It never reads the recent sample buffer while PTT is off. Only paired nullable `{inputLevel,inputClipping}` leaves the owner: finite normalized RMS0–1 and a peak-at-least1 boolean; no sample arrays, device IDs, recordings or native reports. Exceptions/nonfinite samples return unknown without ending healthy media. Existing control-result schema remains exact; malformed IPC still fails closed.

Main samples through its existing status poll, copies bounded scalars, requires an owned connected/capturing call, gates positive levels on current talk intent/transmission and expires them after1000ms. Unknown remains unknown, zero remains valid, ended/replaced/reconnecting owners cannot expose retained activity. A stalled status read cannot leave an indefinitely live meter. UI shows unavailable explicitly and peak warning suggests lowering gain if sound is distorted.

Windows Node24.22.1/Electron45.1.0:

- Full152/152, typecheck/lint/build pass. Unit cases cover512 bound, no muted sample read, zero/full scale, nonfinite/throwing analyser, exact nullable IPC, cache expiry, copied state, invalid input and replacement cleanup.
- Native `test:audio` observes unity level0.6958, quarter0.1740, high gain level1/peak true and zero gain level0. Optional analyser failure returns unknown with the call still connected/transmitting. Existing decoded audio, PTT silence, gain and terminal track/context cleanup remain passing.
- Native media-host and authenticated-call smokes pass. Independent two-client crash smoke measures main-process meter unity0.7034, quarter0.1791 and high gain1/peak true; zero gain and release silence pass. Peer-crash cleanup11418ms observed, not a guaranteed bound/improvement.
- Native desktop/protected reopen passes measured/peak/unavailable states without ending call, existing PTT/gain/block and720x600 layout checks. Reviewed updated voice screenshot, explicitly labeled synthetic.

Scalar evidence: `input-activity-native-summary.json`. Native SAME_PROCESS/SAME_HOST uses synthetic oscillators and injected faults. No physical microphone/audible output, calibrated hardware level, device selection, VAD, actual Roblox, LAN/NAT or release acceptance.
