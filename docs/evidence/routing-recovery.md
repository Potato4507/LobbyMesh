# Routing recovery — 2026-10-27

Production RoutingTable now retains up to k replacement contacts per bucket in addition to k active contacts. NetworkOverlay only remembers authenticated peers. Flooding a full bucket cannot displace a live incumbent; newest eligible cached candidates enter only after a slot is removed. Cached candidates can be stale and still require authenticated RPC on reuse. This bounds routing memory, not the cost of creating Sybil identities.

Maintenance refresh first probes at most four globally least-recently active contacts with a two-second overall budget, using pinned app identity over the existing RPC path. Two failed transactions remove an incumbent. Success moves it behind older contacts; cancellation does not count. If another authenticated transaction refreshed that contact while a probe was in flight, the older failure cannot override that newer evidence. Cached blocked contacts are skipped during promotion. Referrals and desktop contact views exclude blocked contacts immediately.

Found and fixed an adjacent cancellation problem: a queued RPC caller previously waited for earlier native transactions before observing its signal. Callers now reject promptly, while the canceled queued task retains its quota slot until drained and checks cancellation before socket creation. Serialization and the 64-slot bound remain.

Observed on Windows / Node 24.22.1 / pnpm 11.25.0:

- Focused routing/network/maintenance tests passed (new routing cases use synthetic authenticated metadata or synthetic stream metadata explicitly; they are not Noise-encryption proof).
- `pnpm typecheck`; `pnpm lint` (75 files); `pnpm test` (72/72); `pnpm build`: exit 0.
- Existing real local HyperDHT process integration tests passed with production maintenance enabled.
- `pnpm test:desktop`: native Electron 45.1.0 UI/security/network-cancellation checks and independent-process protected-credential reopen passed.

Large-table liveness can take many cycles; no fixed internet convergence time is claimed. Real cross-NAT, full Sybil defenses, 500-node record convergence and production session integration remain unverified. Next: fair bounded synchronization and larger reproducible partition/churn experiments.
