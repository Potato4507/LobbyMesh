# PTT status ordering — 2026-10-29

Reproduced a coordinator reporting race: a status read may begin before a newer PTT activation/release, then resolve after that command is acknowledged. Applying its older transmitting flag overwrote the newer local result. The new regression failed before repair with true instead of false after release. The opposite direction can hide a newer activation. This is a status-reporting defect; no test established that stale reporting itself enabled native tracks.

The status poll now captures the current talk revision before requesting native status. If a newer PTT command occurred, it preserves the newer transmission state and discards the older input meter sample. Fresh replies continue normal updates. Call ownership/cancellation, capture/phase observation, microphone permission, media deadlines, PTT leases, remote signaling and actual track controls are unchanged.

Deterministic regression holds an old reply, acknowledges activation/release, prevents subsequent fresh polls from masking the result, then releases the old reply. Both directions retain the newer confirmed state and unknown input activity. Existing cancellation, late activation, reconnection, meter expiry/replacement and stopped-capture tests remain.

Windows Node24.22.1: focused call/activity/actions19/19, full153/153, typecheck/lint/build pass. Native authenticated-call and desktop/protected-reopen smokes pass, retaining actual PTT interaction, gain/level/unknown/peak, stalled-zero teardown and block-under-load cases. No physical device, actual game/global PTT, WAN/NAT or timing improvement claim.
