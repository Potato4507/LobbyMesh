# Retain authenticated work after partial directory failure

2026-10-31: reproduced a production entrypoint-search fault independently of the unresolved native transport failures. A directory iterator yielded a valid hint, then threw while the hint's authentication was in flight. The search immediately aborted that probe and returned zero candidates. The new focused regression failed before the implementation change (`0 !== 1`).

The search now settles its current probe batch before propagating an iterator error. The existing outer deadline and caller cancellation still abort the search; there is no new retry, timeout extension or admission bypass. Existing bounds of four concurrent probes and 64 distinct hints remain. Authentication, protocol-version filtering and cancellation checks still gate candidate insertion.

The failure still emits `retrying`; an authenticated partial result then emits `candidates-found`. Contact recovery uses that peer to resolve the approved identity through authenticated app routing, while retaining `complete:false`. Directory hints alone never become approved contact bindings.

Verification: new positive regression passes after the fix. Additional tests cover partial directory failure with a stalled probe, deadline and caller cancellation, late successful completion after cancellation, and neighboring contact recovery retaining both the authenticated binding and incomplete-search provenance. Focused search/contact/maintenance 13/13 pass. Full Node253:252 pass,1 existing POSIX-only skip,0 failures. Typecheck, lint242 and build pass. No physical Pi rerun or actual packet-path, NAT, microphone or Roblox proof is claimed. This is not a demonstrated fix for CI's native startup/hello failures.

Latest preceding GitHub run41219624595 at1fd85a7 succeeded; the earlier startup contact-inclusion failure41219171070 and physical failed runs remain retained. Next validate the committed source through the existing Windows verification pipeline and inspect its CI result.
