# Bounded iterative routing - 2026-10-27

Environment unchanged: Windows / Node v24.22.1 / pnpm 11.25.0 / HyperDHT 6.35.0. M07 checkpoint 71998f2 remains ancestor.

`pnpm exec tsx --test tests/lookup.test.ts`: three tests passed. Multi-hop traversal/cycles, alpha <=3, malformed hints, dead peers, query/candidate budgets, deadline and cancellation. Deterministic graph-only fixtures (not 500 real clients): 1 member -> 0 queries; 2 -> 1; 10 -> 9; 100 and 500 -> 32 query cap, budget state. Churn failures 0/0/0/2/1 respectively. No record convergence or traffic/memory claim from this graph fixture.

`pnpm exec tsx --test tests/overlay-process.test.ts tests/network-overlay.test.ts`: 3/3 passed after implementation corrections. Separate-process fixture now initiates simultaneous bilateral joins with duplicate local calls, third-peer referral, replication, read and explicit lookup exhausted/zero-failures assertion.

Observed native limitation: overlapping same-host outbound connects opened at client but one did not reach server RPC dispatch before the 3s deadline. Serialized production transaction scheduling (64 queued maximum) eliminated that observed stall; generic iterative algorithm still supports alpha=3, production native RPC currently executes one transaction at a time per overlay. Simultaneous bilateral setup also stalled initially; bounded transient retries (at most two, 100-399ms jitter times attempt) recovered in the real-process fixture. This is a conservative workaround, not a claimed upstream root-cause fix or WAN performance proof.

Lookup reports state/queried/failures/authenticated peers separately from records. Empty incomplete lookups throw LOOKUP_INCOMPLETE through get; callers needing partial diagnostics use lookup. Two consecutive failed requests remove a known routing contact; successful authenticated requests reset that count. Canceled queries do not evict contacts. Record replication now discovers closer peers first. Full-bucket liveness replacement and anti-entropy remain pending.

Milestone regression: `pnpm typecheck`, `pnpm lint` (45 files), `pnpm test` (31/31, including simultaneous real-process joins), `pnpm build` all passed in sequence, exit 0.
