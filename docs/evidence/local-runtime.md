# Automatic overlay runtime and reconciliation - 2026-10-27

Windows / Node v24.22.1 / pnpm 11.25.0 / HyperDHT 6.35.0. Existing feature branch, prior checkpoint c56652f.

`pnpm exec tsx --test tests/reconciliation.test.ts tests/rpc.test.ts tests/maintenance.test.ts tests/overlay-process.test.ts`: 11/11 passed. Includes two separate processes with persisted test credentials, automatic public-discovery adapter lookup on a **private local bootstrap**, real Noise-authenticated probes, authenticated routing, signed replication/read and graceful shutdown. Neither process receives the other's transport key. This is not public-internet bootstrap proof.

Maintenance unit tests: duplicate start/cycle deduplication, 30s scheduling, republishing after initial announcement, immutable status snapshots, stop cancellation of stalled iterator, no probes/refresh after stop. Timers owned by runtime, unreferenced and canceled on stop; no background service installed.

Reconciliation unit/synthetic integration: RecordStore bounded scans, expiry and copy isolation; three synthetic transports partition then merge, re-send preexisting signed records, verify receiving node's local store after its routing is cleared, confirm unchanged signature/expiry and disappearance after TTL. Synthetic channel metadata is not Noise encryption proof. Scan budget 16 records/cycle, 2s deadline, up to three replicas. Does not prove 500-node record convergence or WAN performance. A saturated store or slow network may outlive the repair budget before TTL; no convergence guarantee is claimed.

Correctness adjustment: native per-RPC default now 1500ms within the 3000ms overall lookup deadline, allowing explicit failed-peer accounting instead of every dead request being hidden behind overall cancellation. Generic standalone requestRpc default remains 5s. Windows local simultaneous-join test recovers with jittered retries in about 2.7s on this run. WAN timeout tuning remains unverified.

Full regression first exposed a self-entrypoint probe consuming the native connection budget. Runtime now passes its own transport key and rejects self hints before opening a stream. Focused real-process check then passed 2/2; `pnpm test` passed 36/36. `pnpm typecheck`, `pnpm lint` (51 files), and `pnpm build` passed after the correction. This failed attempt is retained as evidence rather than relabeled a pass.
