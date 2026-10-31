# Explicit production-bootstrap lab mode

The desktop uses public HyperDHT bootstrap; previous headless workers required a custom bootstrap. The lab can now exercise the same production bootstrap selection with `pnpm lab:pair --network public-bootstrap --count 2 --scenario restart`. This is an explicit operator invocation, outside ordinary automated tests. It uses existing public infrastructure, ephemeral identities and synthetic content; no paid service or host configuration changes.

Omitting both network mode and endpoint still fails closed. `--bootstrap public` remains invalid. Public mode rejects every simultaneous custom endpoint and bootstrap-server role. Worker startup, request, transaction and shutdown limits are unchanged. Pair coordination reads both workers' selected mode before approval, records bootstrap mode, and retains SAME_HOST or REMOTE_UNCLASSIFIED topology until independent physical evidence exists.

Local Windows run: see lab-public-bootstrap-local.json. Both independent peers passed signed pairing, four baseline encrypted text acknowledgments, network-instance restart and two further acknowledgments, synthetic voice signaling, revocation and confirmed teardown. This proves SAME_HOST only; it does not resolve the previous physical private-bootstrap failure or establish cross-ISP NAT, physical audio or Roblox acceptance.

Checks: focused nine tests, eight pass and one POSIX-only skip; full Node 249 tests, 248 pass and the same skip; typecheck, lint and build pass. Latest pre-change GitHub Actions run 41169828329 at 092442e succeeded. Prior native-burst failure remains recorded without weaker assertions or longer deadlines.
