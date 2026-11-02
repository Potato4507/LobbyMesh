# Contributing to LobbyMesh

LobbyMesh is MIT licensed. You can fork it, change it, and submit pull requests.
Use GitHub Issues for bugs and ideas; include OS/app version, reproduction steps
and sanitized errors. Do not post contact codes, private keys, login cookies,
message content, home addresses or private diagnostic files.

Start with `docs/STATUS.md`, `AGENTS.md` and the relevant source/tests. Preserve
existing work. Use Node 24 and the pinned pnpm version from `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

For desktop changes, also run `pnpm test:desktop` and `pnpm test:identity` on a
graphical Windows machine. Add focused regression evidence for behavior changes.
Keep synthetic, same-host, physical LAN, real external-network, Roblox ownership
and hardware-audio evidence distinct. Never remove assertions or relax security
checks to obtain passing CI. Document unsupported cases honestly.

Open a pull request against `main` with the problem, behavior change and checks
performed. Maintainers review and merge contributions. Public contribution does
not grant direct repository write access or permission to publish release files.

Names are not identities. Preserve signed app-key binding, full-ID comparison,
independent Roblox public-profile checks, account/key pins and explicit mutual
contact consent. Do not collect Roblox credentials or add client injection.

For a suspected security vulnerability, use GitHub's private vulnerability
reporting feature if available, or contact a maintainer privately before posting
reproduction details publicly. Do not post live secrets in a public issue.
