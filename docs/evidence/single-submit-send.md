# Prevent duplicate sends before React commits

2026-10-31: native Windows Electron reproduction submitted the Messages form twice synchronously while the synthetic transport held the send. The existing `sending` state had not committed between events, so two outgoing message rows were created. The new assertion failed before the fix with `2 !== 1`.

Messages now acquires a synchronous per-contact pending-send guard before IPC. A second submission for that contact returns immediately. The guard is released in `finally` when the send settles; React state continues to drive the visible button. This does not deduplicate deliberately repeated messages or replay an unconfirmed send. Other contacts retain their own pending ownership.

The existing native conversation mode now asserts exactly one outgoing message from two same-turn submissions. It then retains its clear-under-load, cancel, quota, failed-delivery, draft-retention, contact-search and later successful-send checks, demonstrating that settlement releases the guard. The focused reproduction failed before the fix and passes afterward. All six native Windows modes pass under their original 30-second limits. Screenshots remain in the run-owned ignored evidence directory; no historical image was overwritten.

Full Node253:252 pass,1 existing POSIX-only skip; typecheck, lint243 and build pass. A fresh read-only Windows session diagnostic reports waiting, no selected session, no network started and no raw identifiers. No actual Roblox, physical microphone, cross-device reliability or new packaged acceptance is claimed here. The previous clean Windows pipeline's native burst failure remains recorded separately; latest preceding CI runs at c258e2f and df0634e succeeded without demonstrating a native transport fix.
