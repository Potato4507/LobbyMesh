# LobbyMesh — local Codex GitHub handoff

**Existing repository:** `Potato4507/Roblox-app` (previous Cloud Codex code is already there). **Brand name:** LobbyMesh. **This ZIP contains instructions, not replacement application source.** Do not delete the existing repository, `docs/STATUS.md`, tests or Git history.

## Safest installation
1. Clone/open your existing `Roblox-app` working directory in local Codex. Check `git status` first. If any local changes are uncommitted, keep them; don't reset.
2. Extract this ZIP into the repository root. This will introduce `AGENTS.md` and the new handoff documents. `MASTER_PROMPT.md` and `IMPLEMENTATION_PLAN.md` are intentional revisions; **compare/back up the existing versions before replacement**. The other files here are new names and do not overwrite `docs/STATUS.md` or existing code.
3. Ensure Codex has workspace access and Git remote is configured. It is fine to keep the repo named `Roblox-app`; the product can be called LobbyMesh. Use a new Codex feature branch for implementation instead of working on protected `main`.
4. In local Codex, paste the contents of `CODEX_START_PROMPT.txt`. If you attach/mention `@GitHub`, use it to identify the **same existing repository**, not to generate another project. The local checkout/remotes are the canonical working directory.
5. On future sessions, use `RESUME_PROMPT.txt`. Codex's checkpoint docs must contain the exact next command and current branch.

## Files in the ZIP
- `AGENTS.md`: repository-wide low-interruption guidance read by Codex.
- `MASTER_PROMPT.md`: full `/goal`, invariants, execution/permission policy and Git handoff.
- `IMPLEMENTATION_PLAN.md`: **all original 19 M00–M18 modules** with acceptance checks, renamed and annotated for continuation.
- `CODEX_START_PROMPT.txt`: one startup command to paste.
- `RESUME_PROMPT.txt`: shorter command to use after interruptions/usage limits.
- `docs/HANDOFF_NOTES.md`: snapshot of observed Cloud work, not a replacement for live status.
- `docs/PROOF_AND_RELEASE_GATES.md`: evidence requirements, privacy and permission gates.
- `docs/ARCHITECTURE_INVARIANTS.md`: explicit two-DHT architecture constraints.
- `docs/BRANDING.md`: selected name/technical identifiers.

## Expected behavior
The agent should **not** write another plan or restart M00; it should locate and implement missing behavior (known checkpoint: M07), run relevant tests, repair failures, document honest proof levels, checkpoint and continue until an actual tool/session limit. Local Codex inference still uses your Plus allowance; prompts cannot force execution past usage limits or auto-authorize privileged operations.

## Existing stack observed
Node 24 / pnpm 11.25.0, TypeScript, Electron/React, HyperDHT 6.35.0, Biome. Expected scripts currently include `pnpm typecheck`, `pnpm lint`, `pnpm test`, and `pnpm build`. Inspect live `package.json` in case these change.

## Existing known blockers
A public HyperDHT smoke test previously timed out, Windows GUI and actual microphone tests are not yet established, and there is no verified universal Roblox external server identity API. These remain external verification gates, not reasons to halt all unrelated implementation.
