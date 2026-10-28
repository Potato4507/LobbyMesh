# Production-overlay recovery experiments — 2026-10-27

Environment: Windows, Node 24.22.1, pnpm 11.25.0. Seed 4507. The final harness uses deterministic test Ed25519 keys, seeded topology/churn, production NetworkOverlay/RPC framing/signature checks/RecordStore/OverlayMaintenance, synthetic duplex stream metadata and a synthetic shared bootstrap directory. No Noise encryption, UDP, public DHT, Roblox sessions or cross-NAT behavior is tested here.

Each partition initially publishes its own signed record at the same key. A seeded subset of nodes then becomes abruptly unreachable. One bridge joins after connectivity returns; production maintenance samples up to three shared-directory hints per live node, authenticates them, refreshes routing and repairs records. Measurements query every surviving node for both original signatures and expiry values. Availability means retrievable records, not a stored copy on every node. The fake clock advances 1000ms per logical round; this is an accelerated scheduling experiment, not a real 30-second maintenance/TTL acceptance test. Lookup budgets remain explicit, and finding the records does not imply an exhaustive lookup.

Final observed results:

| Nodes | Abrupt outages | Surviving nodes with all records | Rounds | RPC attempts | Framed bytes | Lookup p95 ms |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 | 1/1 | 1 | 0 | 0 | 0.42 |
| 2 | 0 | 2/2 | 1 | 15 | 21,053 | 6.78 |
| 10 | 2 | 8/8 | 1 | 276 | 562,660 | 6.95 |
| 100 | 9 | 91/91 | 1 | 6,355 | 24,633,024 | 35.03 |
| 500 | 53 | 447/447 | 1 | 31,654 | 125,752,141 | 61.43 |

Raw final evidence: `overlay-scale-final-small.json` and `overlay-scale-full-maintenance.json`. The 500-node run took 42.10 seconds of host wall time; maximum active/replacement counts were 104/62 across at most 13 buckets. Both records had retained copies (9 and 7), and all 447 live nodes retrieved both. 430 lookups still reported incomplete/budget/failure diagnostics; successful retrieval is a narrower result. All routing entries were cleared after fixture shutdown. `routingJsonBytes` measures serialized active-contact samples capped at 100 per node; it excludes replacement caches and is not heap/RSS or total application-memory proof. Frame-byte counts exclude native transport overhead. Timings are host observations, not network latency benchmarks.

Historical unsuccessful experiments are deliberately retained:

- `overlay-scale.json`: repair-only baseline, 500 nodes reached 7/447 availability after three rounds.
- `overlay-scale-targeted-repair.json`: target resolution alone, still 7/447.
- `overlay-scale-merged-routing.json`: replacement lookup/replica changes, still 4/447 under repair-only scheduling.
- `overlay-scale-diagnostics.json`: same repair-only scenario with per-record diagnostics; records remained concentrated in the original partitions (availability 232 and 219, overlap 4).

These intermediate files predate the final maintenance harness and are not reproduced by its current default command. They establish that record repair with one bridge did not independently merge these partitions. Full production maintenance with a shared discovery model is a different recovery condition; no claim that the replica changes alone caused the 500-node recovery is made. Target-aware repair is separately checked by the strengthened three-node test, which requires discovering a new replica through B before C can store the record.

Observed verification:

- `pnpm simulate:overlay docs/evidence/overlay-scale-full-maintenance.json 500`: exit 0 before pause, same final production/harness logic.
- `pnpm simulate:overlay docs/evidence/overlay-scale-final-small.json 1,2,10,100`: exit 0 during finalization.
- `pnpm typecheck`, `pnpm lint` (84 files), `pnpm build`, `pnpm test:desktop`: exit 0. Desktop check includes independent-process protected-credential reopen.
- Final `pnpm test`: 74/74. One preceding full run had a local native runtime replication timeout (expected 1 replica, observed 0 with 1 failure). Focused `tests/overlay-process.test.ts` then passed 2/2, followed by the passing full run. No test retry loop or timing relaxation was added; native intermittency remains unresolved.

The CLI writes new output exclusively and exits nonzero on missing record availability or uncleared routing entries. Generated JSON can be formatted with the repository's Biome command before committing. The default suite runs only the 10-node fixture; larger runs are explicit. Multiple seeds, repeated/long-running churn, realistic maintenance/expiry timing, native swarm memory/traffic and cross-machine recovery remain unverified. Development is stopped at the user's request.
