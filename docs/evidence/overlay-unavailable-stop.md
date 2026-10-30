# Stop control while overlay observations are unavailable — 2026-10-30

An unrelated failed overlay dashboard query removed all widgets and End call while synthetic media still captured. The regression failed the retained-End assertion before this change (local overlay-stop-failure-repro.log).

The failure view now retains the last observed call token only for an End attempt. Capture and transmission widgets are not rendered from cached facts. The permanent microphone indicator remains unknown until a new successful status read. The same stop control and existing fixed outcome notice work in the failure view. Interaction mode and main-process exact current-call token validation remain required; no call-start, answer, permission or push-to-talk capability was added to the overlay.

Native synthetic test faults only the production overlay voice query, verifies unavailable/unknown and retained End while the media owner captures, ends the call during failure, verifies actual local capture false and honest failed peer notification, then restores reads and requires the off indicator. It retains stale-ID rejection and remote-still-capturing uncertainty checks. Existing voice query failure, release/no-auto-resume, unknown teardown, optional-widget hiding and native Escape/foreign-sender/IPC checks remain.

Full Node218/218, typecheck/lint203/build and all five Windows desktop processes pass at original30-second limits. Prior845ef6e7e0b34ce2f7f53b0cf27b72a3673c48ec Ubuntu41085156010 succeeds. Unrelated generated screenshots restored. Main header receives independent trusted voice observations; no speculative header change was made. Synthetic native proof is not physical audio, LAN/NAT or release acceptance.
