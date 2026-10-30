# Network action observation ownership — 2026-10-30

Native regression reproduced a stale dashboard response undoing the display of a completed Disconnect. It held a real online status response, clicked Disconnect, required Enable peer discovery and the actual fixture stop count, then released the old response. A MutationObserver caught Connected/Disconnect returning transiently; the assertion failed before repair.

The renderer now records a connection observation revision at network action start and completion. Startup/periodic dashboard reads apply their connection value only if the revision still matches. This prevents reads begun before or during an action from undoing its returned outcome. Other observation domains remain independent. Backend lifecycle, persistence, authentication and network permission rules are unchanged.

The native test keeps the original30s process limit and checks actual fixture teardown before watching DOM mutations. Full results are recorded in STATUS. No LAN, NAT, real platform or physical audio claim follows from this synthetic native regression.

The preceding clean e500a943b3dd310a53fe08cce231742acfc5c72f Windows artifact LobbyMesh-win32-x64-1793399156858 passed actual packaged executable smoke, network/microphone off, protected credential reopen and pinned656-file integrity415677935bytes. Manifest SHA256:705941e15ede814cebd9450cd989691f3748be64db2880d71fc8e6f7ce1631d4. Signature NotSigned; no public release or fresh-machine acceptance. That artifact precedes this connection guard.
