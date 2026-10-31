# Flush the headless stop acknowledgement — 2026-10-30

An actual production bootstrap subprocess failed cleanup confirmation when a test preload delayed only its terminal stdout write80ms. The worker called process.exit(0) immediately after queueing the acknowledgement, discarding it before it reached the controller. The controller correctly rejected LAB_COMMAND_STOP_FAILED. No confirmed-stop assertion was relaxed.

The worker now exits successfully only from the final stdout write callback. After teardown it replaces the ordinary lifetime timer with a bounded1s terminal-output timer; a failed or stalled write cannot keep it alive indefinitely. The existing controller4s cleanup deadline and its requirement for both a valid stop acknowledgement and exit0 remain unchanged. This prevents loss on asynchronous pipe/SSH output without claiming delivery on a broken channel.

The same actual production bootstrap with delayed stdout now confirms stop and exit0. Focused control/production-peer/report tests11/11, full242 total241pass/1POSIX-only skip/0fail, typecheck and lint219 pass. Existing authenticated pairing, encrypted ACKs, network restart, synthetic voice signaling, revocation and no-exit forced-cleanup negative tests remain. No physical LAN proof follows from this local fault injection.

The user has now explicitly approved checksum-verified Node24 and pinned lab dependencies under ~/lobbymesh-lab plus bounded synthetic LAN tests. Sudo, services, firewall, router and login settings remain out of scope. A prior optional credential-provider recheck was blocked before execution by automatic approval review; the approval changes installation authority, not a claim of completed remote setup. Clean headless packaging and authorized transfer/runtime verification are next.
