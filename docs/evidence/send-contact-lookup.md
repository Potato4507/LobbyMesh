# Automatic lookup for an explicit approved-contact send — 2026-10-30

Production DesktopMessaging now acquires a pending message and its cancellation owner before looking up a missing binding. It uses the existing trusted authenticated lookup adapter, then rechecks cancellation and permission before negotiation and text dispatch. The desktop and overlay composer allow Send for approved contacts with unknown connection details. An unsuccessful attempt retains the draft and an unconfirmed connection-stage row; there is no background resend.

The existing global single lookup, five-second caller bound/cooldown, underlying-work retention, exact identity/key validation and memory-only binding limits remain. A send cannot cancel or bypass an existing manual lookup. Stop send, conversation clear, permission withdrawal and shutdown abort only owned work; even a nonabortable late result cannot restore a binding or dispatch text. No lookup carries the draft.

Verification:

- Focused lookup/messaging: 22/22, including authenticated protocol ACK after lookup, cached binding reuse, cancellation/clear/withdrawal/close, timeout, malformed/mismatched/null/error results, single-flight and cooldown ownership, pre-canceled and unauthorized work.
- Full Node regression: 212/212; typecheck, lint (200 files), build pass.
- Focused native Windows conversation run passes with synthetic transport: manual incomplete/not-located/found remains, Send enabled for unknown details, Stop aborts lookup and retains draft, subsequent explicit Send resolves then ACKs. Microphone remains off. Existing lost-ACK/clear/quota/block negatives remain.
- Initial native runs retained in local troubleshooting: obsolete disabled-Send assertions failed, then successful-send check exposed a synthetic fixture clock mismatch after advancing hint expiry. Both fixture peers now share the simulated clock; production timestamp bounds were not changed.
- Previous source 57f8e46c4a40f3104b00a7df21d74ebd80008732 GitHub Ubuntu run 41081853549 succeeded.

UNIT and native desktop synthetic-interaction evidence only here. Physical LAN/NAT/audio/actual Roblox and release gates remain open. Independent production-transport restart plus automatic-send lookup is the next acceptance increment. No microphone consent, capture, discovery deadline, protocol ACK assertion or retry policy was relaxed.

Full Windows desktop suite also passed all five isolated processes (main, conversation, session status, overlay capture, credentials), each retaining its original 30-second limit. Generated unrelated screenshots restored from the clean baseline; no new screenshot acceptance claimed.
