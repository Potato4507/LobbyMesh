# Windows local session detection — 2026-10-28

/goal: add automatic supported local session evidence without manual IDs, injection, account extraction or invented identifiers.

/steps: reconciled clean c0b07a3 and previous pause; added unified product requirements; implemented read-only log tail, provenance validation and consent-controlled native status.

/proof: Windows, Node 24.22.1, pnpm 11.25.0, Electron 45.1.0. Baseline 74/74, typecheck/lint passed. New full suite 78/78; typecheck, lint (86 files), build and native `pnpm test:desktop` passed. Native smoke uses generated temporary player logs and verifies detected status after saving consent, no raw JobId projection, and independent credential reopen. Initial native second-pass fixture mkdir failed EEXIST; corrected to recursive mkdir and the whole native command passed. Settings screenshot reviewed at lobbymesh-settings.png; fixture contains synthetic sessions only.

Sources inspected on this date:

- [Roblox Support log retrieval](https://en.help.roblox.com/hc/en-us/articles/360016022492-How-to-Retrieve-Roblox-Studio-Logs): documented Win32 and Store log locations and Player naming. This documents files, not a stable session event API or approval of every integration.
- [Bloxstrap ActivityWatcher source](https://github.com/bloxstraplabs/bloxstrap/blob/main/Bloxstrap/Integrations/ActivityWatcher.cs): independently corroborates engine join/universe/replicator/disconnect/teleport markers and warns they are volatile. Implementation uses a minimal separately written parser, with no HTTP enrichments, RPC/script output, account IDs or addresses retained.

Supports `%LOCALAPPDATA%/Roblox/logs` and `%LOCALAPPDATA%/Packages/ROBLOXCorporation.ROBLOX_55nm5eh3cm0pr/LocalState/logs`. Exact Player hex-suffix filenames exclude Studio/bootstrapper/crash logs. Unknown paths/variants remain unsupported. Only timestamped explicit FLog events are accepted; complete universe/place/UUID JobId and connection confirmation are required. `windows-log` evidence is always self-asserted, including remote advertisements. No missing IDs are synthesized.

Polling is non-overlapping every second and enabled only by session consent. Boundaries: 2048 directory entries, 256KiB per tail read, 16KiB lines. Partial writes wait for newline; truncation, identity change, rotation or cropped tail resets scope. Older-than-120s file/event evidence is rejected; multiple recent player files are ambiguous and withdraw presence. Stale/missing/error/disable/stop clear the current session; listeners receive copies. Local filesystem errors are generic and recover on subsequent polling. Raw logs never enter IPC, public discovery or evidence files.

Limits: fixture proof is not actual Roblox acceptance. No actual join/teleport/exit was performed; markers can change. A running session with silent logs or a join outside the bounded tail/freshness window may be unavailable until fresh supported join events occur. Multiple recent files may include a recently closed client and temporarily suppress detection. Without a process-bound native lifecycle source, crash/exit detection relies on disconnect markers or freshness expiry (up to 120s). This must be improved and exercised with real Roblox before production acceptance. Polls do not read process memory or cookies. Detection alone does not activate networking or grant contact permission. Desktop session matching wiring is the next integration.
