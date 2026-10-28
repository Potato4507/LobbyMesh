# Release readiness

Development only; no public release, installer, code signature or updater produced. Current source/evidence supersedes the historical GUI/Windows blocker.

| Boundary | Status | Evidence / remaining |
| --- | --- | --- |
| Workspace/build | VERIFIED_INTEGRATION | 93 tests, typecheck/lint/build pass on Windows; source and proof retained. |
| Desktop/overlay | VERIFIED_INTEGRATION / PARTIAL | Native sandbox/IPC/navigation/draft/reorder tests and screenshots. Actual Roblox fullscreen/input and assistive-technology acceptance pending. |
| Self-contained Windows package | VERIFIED_INTEGRATION / PARTIAL | Local unsigned folder starts its copied executable from its own directory with isolated profile, no external module cache, networking/mic off and protected credential reopen. File manifest and standalone integrity checker. Fresh-machine, installer, publisher metadata/signature, upgrade/uninstall and distribution acceptance pending. |
| Networking/text | PARTIAL | Same-host real Noise/public-bootstrap evidence and bounded pre-request retry; cross-NAT, long-running native reliability, transport reuse and safe fresh-profile contact onboarding unfinished. |
| Automatic Roblox session | PARTIAL | Log/process lifecycle implemented with fixture proof; latest live source probe selected no session. Positive real join/teleport/exit and verified identity/roster unsupported/unverified. |
| Voice | NOT_STARTED / BLOCKED_EXTERNAL | No media implementation/device acceptance; microphone stays off. |
| Security/safety | PARTIAL | Signed records, bounded RPC, persistent deny/block and Windows protected keys tested. Child/contact-age model, moderation/report operations, ACL and full assessment incomplete. |
| License/distribution | BLOCKED_EXTERNAL / NOT_READY | No project LICENSE or package license declaration found. Bundled dependency licenses and Electron notices retained; project license choice, full redistribution review and user release authorization still required before distribution. |

Local commands: `pnpm package:win` creates a new exclusive folder under dist and runs its actual executable in an isolated smoke profile; `pnpm verify:package PATH_TO_FOLDER` checks the manifest. Latest successful package pointer: `dist/windows-development-latest.json`. Build manifests distinguish dirty development source from a clean commit. Integrity hashes do not authenticate a publisher. These commands do not publish, install, enable networking or use an existing profile. Details: evidence/windows-development-package.md.
