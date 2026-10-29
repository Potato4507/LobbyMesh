# LobbyMesh Codex continuation package — 2026-10-28

This is an **additive** handoff for the existing private GitHub repo `Potato4507/Roblox-app`, not a replacement source tree. It includes a startup prompt, product continuation instructions, test-evidence policy, Raspberry Pi + simulated-NAT lab design and two Pi helper scripts. The original `AGENTS.md`, `MASTER_PROMPT.md`, 19-module plan, source, tests and status/checkpoint documents stay authoritative and must be retained.

## How to use

1. Open the EXISTING repo in local Codex and inspect its working tree/branches before copying anything. Prefer the handoff feature branch in GitHub once available; alternatively extract this ZIP at the repository root, preserving directory structure. These package paths are new and should not overwrite existing source.
2. Read `CODEX_NEXT_SESSION.txt` and paste its **full contents** into Codex. Use the GitHub repository reference if convenient; do not set up another repository or reset a working tree.
3. The Pi is optional. When you power it on and authorize SSH access, Codex first runs read-only inventory, then asks for any actual privileged OS/netns action. If it is offline, Codex continues CI, product features and tests.
4. The lab helper is **not** pre-validated on your Pi and intentionally does not install dependencies or start networking by itself.
5. Existing active Codex agents may be making changes. Never merge or overwrite a newer live branch blindly. Compare, port these additive docs as needed, and work on a safe non-main branch.

## Package contents

- `CODEX_NEXT_SESSION.txt` — ready-to-paste autonomous coding prompt.
- `docs/CODEX_HANDOFF_20261028.md` — whole-project vision, priorities, constraints and continuity.
- `docs/PROOF_PLAN_20261028.md` — honest evidence tiers, scenario catalog and CI failure triage.
- `docs/PI_NETWORK_LAB.md` — safe Pi SSH/LAN/netns/NAT testing design.
- `labs/pi/host-facts.sh` — read-only Pi capability inventory.
- `labs/pi/netlab.sh` — opt-in isolated Linux namespaces/NAT/netem setup/cleanup.
- `labs/pi/README.md` — user-facing usage, prerequisites and limitations.

No SSH keys, passwords, host IP addresses or app identities are included. No public release, PR, or `main` merge is requested by this package.
