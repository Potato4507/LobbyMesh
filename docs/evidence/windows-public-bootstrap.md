# Windows public bootstrap smoke - 2026-10-27

Environment: Windows / Node v24.22.1 / pnpm 11.25.0 / pinned HyperDHT 6.35.0. The historical Linux 15s timeout is preserved in public-smoke.log; this Windows environment is a changed connectivity hypothesis, not repetition of an unchanged failure.

Single-node command: `pnpm exec tsx scripts/public-smoke.ts PRIVATE_TEMP_DIRECTORY`. Observed `{"state":"QUERY_FINISHED","candidates":1,"authenticated":false}`, exit 0. It does not distinguish own versus foreign candidate and does not prove a second app. Generated private test seed remains outside Git under OS temp; never publish it. A combined shell probe/recursive-cleanup command was rejected by automatic review before execution; the safer probe-only command succeeded, leaving test state untouched.

Pair command: `pnpm smoke:public-pair` (explicit opt-in, not part of regular pnpm test). Exact observed output:

```json
{"state":"PUBLIC_PAIR_PASSED","publicBootstrap":true,"processes":2,"authenticated":true,"signedRecordRead":true,"crossNat":false,"roblox":false}
```

Exit 0. Two independently running Node app processes start real runtime instances with default public HyperDHT bootstrap. Neither is given the other's app/transport key; each must discover/authenticate the other. Test checks mutual routing membership, successful signed replication and verified record lookup, then stops both. A 75s overall deadline bounds the explicit smoke command. It never sends direct chat to outside users and uses synthetic records/identities only.

Scope: public bootstrap service was actually reachable and carried app entrypoint discovery on this run. All app processes were on the same Windows host; the authenticated peer path can be local/LAN. This is not cross-machine/cross-ISP, restrictive-NAT, long-duration availability, media or Roblox proof. No recurring owner-operated infrastructure or release was created.

Relevant regression after adding public mode: `pnpm typecheck` passed, `pnpm lint` (64 files) passed, `pnpm exec tsx --test tests/overlay-process.test.ts` passed 2/2, confirming existing private-bootstrap mode still works. Full 49/49 and native desktop checks had passed at the immediately preceding desktop milestone; not redundantly rerun for the isolated public-smoke script.
