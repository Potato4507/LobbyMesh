# LobbyMesh — repository-wide Codex instructions

## /goal
Continue implementing **LobbyMesh**, a Windows-first, open-source, no-owner-operated-backend, self-organizing P2P communication companion. **Write and test code, not just plans.** Read `MASTER_PROMPT.md`, the relevant parts of `IMPLEMENTATION_PLAN.md`, and current `docs/STATUS.md` before editing. Keep doing the next unblocked task during the active session; do not ask for routine approvals between modules.

## /repository
- Expected existing GitHub repository: `Potato4507/Roblox-app` (current repository name does **not** need to be changed). This is an **existing partial implementation**, not a blank scaffold.
- If source files or a repo branch differ from these notes, **trust the inspected repository**, not this historical snapshot. Preserve ALL existing Cloud Codex source, tests, branches, uncommitted work, and valuable docs.
- Starting snapshot (2026-10-27): M00–M06 partly implemented, M05/M06 unit-tested, M07 authenticated overlay transport the next action; no module fully product-accepted. Public DHT live smoke timed out, not verified. Check `docs/STATUS.md` and `docs/evidence` for authoritative details.
- Use the repo's existing Node/pnpm/Electron stack. Do not regenerate package files, delete tests, reset history, or replace the architecture just because the master plan describes what an empty repository would look like.

## /defaults — make decisions without asking
- Ordinary, reversible changes **inside this repository** are approved: code edits, dependency updates with known justification, tests, test fixtures, builds, formatting, profiling, interface repairs, simulations, local commits, and work on new feature branches.
- Prefer the smallest testable next increment; fix the underlying cause of a failure and rerun the affected test. Avoid repeatedly rerunning an unchanged failing command.
- Keep one source of truth for progress: `docs/STATUS.md`; add exact test evidence to `docs/TEST_MATRIX.md` or `docs/evidence`. Record architecture changes concisely in `docs/DECISIONS.md`.
- Preserve existing dirty work. Check `git status` before staging. Stage only files you changed and own. Do not mix unrelated edits into commits.
- If a remote exists and GitHub write authorization is available, use an isolated `codex/lobbymesh-*` working branch. Push **only that branch** after passing its relevant checks; never force-push, auto-merge, or directly push to `main` without user authorization. If push is unavailable, local commits are enough.
- Inspect existing scripts before invoking them. Prefer pinned toolchain and `pnpm install --frozen-lockfile` when lockfile is consistent. No paid services or unexpected background daemons.
- Choose sane defaults without asking. The user values unattended implementation, a $0 personal infrastructure bill, minimal intervention, privacy, and actual automated session detection. Never replace missing automatic production detection with a manual server-ID prompt and declare success.
- Save checkpoints frequently **at real verified milestones**, not after every minor edit. Keep terse logs to conserve context and the user's Plus allowance.

## /hard boundaries
- No spending, publishing a public release, deleting meaningful user data, unsafe privilege escalation, weakening OS security, scraping client memory, injecting Roblox, capturing Roblox login cookies, tracking nonparticipating users, or evading child-safety protections. Ask for approval only when such an external action would actually be necessary; otherwise mark it blocked and continue independent work.
- No promises of universal reachability: direct NAT connections sometimes fail; the public DHT and volunteer nodes are still infrastructure owned by other people.
- Don't conflate: DHT lookup ≠ verified Roblox session; peer key ≠ Roblox identity; mock test ≠ live platform integration; unit test ≠ real Windows device/NAT test.
- Do not modify local global Codex settings or request bypassing the local agent's approval/sandbox mechanisms.

## /execution_loop
1. Read `docs/STATUS.md`, check working tree, identify first unblocked dependency and existing tests. Read only relevant sections of the long plan.
2. Implement the module's next missing production behavior with explicit interfaces and failure cases.
3. Run focused test/typecheck/lint; repair failures, then cross-package tests. Run full regression at meaningful integration checkpoints, not unnecessarily after every edit.
4. Update status with: observed command/outcome/environment; module verification level; blockers; **one concrete next command/implementation action**.
5. Commit verified edits on the working branch; push only if permitted as above.
6. Immediately proceed to the next unblocked task. If externally blocked, preserve accurate `BLOCKED_EXTERNAL` evidence and work on something else.
7. When forced to stop by context/usage/tool limits, write `docs/RECOVERY.md` containing exact branch, HEAD, dirty files, last tests and next 3 shell actions. Then stop truthfully.

## /verification_labels
`NOT_STARTED`, `IN_PROGRESS`, `VERIFIED_UNIT`, `VERIFIED_INTEGRATION`, `VERIFIED_REAL_WORLD`, `PARTIAL`, `BLOCKED_EXTERNAL`, `UNSUPPORTED`. Mark exactly what was actually observed; a module can have verified unit tests but remain partially complete.

## /priorities
First resume **M07 authenticated app-DHT RPC/transport** if current repo still indicates it. Then M08 iterative routing/healing, M09 session matching, M10 transport, and so on, while continuing feasible M02/M03 research in parallel. Do not rebuild M00 just because it appears first in a plan. The final deliverable is working, tested repository code and verifiable artifacts—not a summary response.
