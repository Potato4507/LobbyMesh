# Headless restart cancellation and failure guards — 2026-10-30

Goal resumed after the prior usage-limited checkpoint. Source91ef4d0 Ubuntu41055537182 succeeded; its implementation and the owned recovery note were preserved.

Peer restart now uses a shared owner-guarded operation: check lifetime before touching lifecycle, after old cleanup, and after replacement startup. Cleanup failure prevents replacement; startup must actually reach online before returning. Owner callback errors and lifecycle errors project the fixed LAB_NETWORK_UNAVAILABLE result rather than raw private text. The worker's existing serialized command loop, priority stop, startup10s/cleanup3s/one-attempt limits and stop ACK+exit requirement remain unchanged. No new host operation, secret persistence, network retry or protocol field.

Controlled UNIT tests use the real production NetworkLifecycle with held old cleanup and held replacement startup. Stop cannot request a new grant after old cleanup, and late startup cannot resurrect the closed owner. Separate cases cover cleanup failure/manual retry, failed startup/no implicit retry/manual recovery and pre-denied/throwing owner with zero lifecycle calls. This complements the prior real headless network-restart proof; it is not an actual Pi, namespace or physical fault test.

Windows Node24.22.1: focused restart/lab/control13/13, full206/206, typecheck/lint/build pass. Existing independent headless signed pairing, actual Noise ACKs, fresh state/default-off voice, revoked history/send denial and clean exits pass. No strict native burst/media assertion or deadline weakened. Pi and hardware/actual Roblox/release gates remain separately open. Goal ACTIVE.
