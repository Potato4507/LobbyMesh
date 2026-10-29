# Namespace helper fault validation — 2026-10-29 UTC

Base `0753303`, Windows GNU Bash5.2.37 (bundled Git `sh.exe`, with its sibling tools on the child shell's PATH). No actual `ip`, `nft`, `tc`, sudo or SSH operation was run. All network commands in tests are Bash functions; OS privileges/lock acquisition are never invoked. This is **UNIT / SIMULATION**, not VIRTUAL_NAT or Linux-kernel proof.

Source defects found in the additive handoff helper:

- Empty/partially absent cleanup could return a false final shell status under errexit.
- `ip netns pids` failure was treated as absence of active processes.
- Fixed namespace names alone did not establish ownership for later deletion/profile.
- An intermediate veth failure could leave a root-namespace endpoint.
- ERR trap did not inherit into helper functions; the injected nested failure reproduced absent rollback until `set -E` was enabled.

Implemented explicit successful no-op cleanup; fail-closed enumeration/PID inspection; loopback ownership marker and all-namespace preflight before deletion/profile; cooperating invocation `flock` lock in root-owned /run; both veth endpoints created directly in owned namespaces; tracked per-invocation rollback with inherited ERR handling. Rollback retains namespaces if processes cannot safely be ruled out. Old unmarked labs are refused for mutation and need operator inspection, not inferred ownership.

`bash labs/pi/test-netlab.sh`: **8/8 command-model cases pass**, covering empty/repeated cleanup, unmarked namespace after a marked one (no partial deletion), active PID, failed PID inspection, create/delete/idempotence, preexisting collision, nested setup rollback preserving an unrelated namespace, and enumeration failure stopping cleanup. All source scripts parse; typecheck/lint152 pass. CI now runs these unprivileged tests in addition to all existing strict TypeScript/native tests.

The test file is sourceable/mockable without running `main`; the real executable path still requires root/dependencies and obtains the lock. Linux iproute2 syntax/namespace mounting/nft/kernel support and actual isolation/cleanup must be verified on an authorized Pi before VIRTUAL_NAT claims. No privileged execution was attempted. The available WSL inventory command did not respond promptly and was canceled; the bundled GNU Bash was used only for syntax/model tests.
