# Bounded native setup-abort recovery — 2026-10-29

Inspected current Ubuntu [run40866041526](https://github.com/Potato4507/Roblox-app/actions/runs/40866041526), documentation checkpoint3f9a4b8. Headless pairing failed before its text/voice scenario. New aggregate diagnostics identify a find-node transaction rejected at transport phase in17.2ms with nativeCode HOLEPUNCH_ABORTED. Opposite peer reported no admission/policy/quota failure. This is the first retained exact native code for this CI symptom; it does not establish every historical transport failure shares that cause.

Pinned local HyperDHT6.35.0 source exposes HOLEPUNCH_ABORTED from pre-establishment holepunch/LAN failure paths. Its precise upstream cause in this run is unknown. No dependency or installed source was changed for this increment.

Production NetworkOverlay now allows this exact code, only before Noise establishment and with an expected app identity, to consume the existing one setup retry. The request is not dispatched on the failed attempt. Existing25–75ms jitter,1500ms attempt deadline and overall lookup/call budgets are unchanged; retries cannot add a third attempt. Block/cancellation are rechecked. Diagnostics still retain the failed attempt. Unknown codes, DUPLICATE_CONNECTION, identity/protocol errors, remote rejection, and native abort after establishment/request dispatch do not qualify.

Windows Node24.22.1 observations:

- `pnpm typecheck`, `pnpm lint`158 files, `pnpm test`:146/146 pass; `pnpm build` passes.
- Native headless and overlay process checks pass with exact replica/zero-failure/exhausted assertions retained. A separate hello timeout around1500ms was recovered through the existing timeout policy; this increment does not fix that path.
- Deterministic fault coverage verifies exact-code success on attempt2/one handler dispatch; finite failures; cancellation and blocking after attempt1; unpinned probe exclusion; rejection after establishment and after dispatch. Existing forged identity, remote-rejected, post-dispatch timeout and unrelated native-code negatives retained.

UNIT plus SAME_HOST native evidence. No Pi/LAN, virtual NAT, real external, actual Roblox, hardware audio or universal reachability claim. Await current Ubuntu CI; even a passing run cannot establish all native intermittency is resolved.
