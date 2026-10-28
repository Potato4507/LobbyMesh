# Bounded synchronization fairness — 2026-10-27

Inspection found two starvation paths: an exhausted synchronization budget retained the same starting record forever, and fixed replica order could spend every budget on an unreachable closest peer before reaching a healthy replica.

Production synchronization now advances past records attempted before a budget stop. Each full store sweep rotates replica order. It retains 16-record and default two-second limits, signed original records, cancellation semantics and bounded native queue. A validated synchronizationMs option permits explicitly shorter/larger internal budgets (1–10000ms); desktop keeps the default. User/lifecycle abort does not advance the cursor. A budget-induced cancellation does not falsely evict a peer.

Regression fixture: three original signed records, one permanently stalled closest replica, one responsive replica, 80ms budgets. Six cycles visit the three records once with the stalled peer first, then once with the healthy peer first. The healthy node stores all original signatures/expiry values; its routing table is cleared before checking, so the assertion cannot be satisfied by reading records from the sender on demand. Synthetic stream metadata is explicitly used; the production app authentication, framing and record store run unchanged. This is not Noise-encryption, WAN or 500-node convergence proof.

Windows / Node 24.22.1 / pnpm 11.25.0: focused reconciliation tests 3/3; full `pnpm test` 73/73; `pnpm typecheck`, `pnpm lint` (75 files), `pnpm build` exit 0. Native desktop smoke last passed at the preceding routing milestone; this increment changes record synchronization only, covered directly here and by real local-process regression tests.

Records can expire before many maintenance cycles complete, especially in a large/slow network. Numeric scan positions can shift under expiry/churn. No arbitrary global convergence or release-readiness claim is made. Larger reproducible experiments and automatic owner republishing remain necessary.
