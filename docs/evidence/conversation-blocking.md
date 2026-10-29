# Conversation safety actions — 2026-10-29

Conversations now exposes Block selected contact using the existing main-window-only persistent block operation. It captures the selected app ID before starting, immediately invalidates the local selection/history and removes that contact's draft. Late polls cannot restore a previous selection's history. Backend policy still performs immediate deny, in-flight send cancellation, local history purge and call teardown; no new contact grant, endpoint input, overlay right or platform identity assertion.

Main IPC allows block/revoke through the priority gate even when all16 ordinary request slots are occupied. The sender trust check and exact action/peer-ID validation remain ahead of mutation. Unblock is an ordinary operation and never grants contact permission. Block/remove controls in Preferences remain available with unsaved edits; their responses merge only policy fields so display name, presence and layout drafts survive. Contact saves have their own pending state rather than unlocking an unrelated pending preferences save.

Successful UI notices distinguish local saved blocking from unconfirmed changes. Failure does not claim persistence; it directs the user to disconnect and review contact permissions. Existing preference-store test proves immediate deny survives a storage failure for the running process. This is app-key blocking, not account/age verification, Sybil prevention, remote erasure or a moderation/report service.

Observed Windows Node24.22.1/Electron45.1.0:

- `pnpm typecheck`, `pnpm lint`161 files, full `pnpm test`148/148, `pnpm build`: pass.
- `pnpm test:desktop`: pass plus separate protected-credential reopen. Starts an actual call coordinator with injected synthetic media, holds16 sends, verifies ordinary preference IPC receives REQUEST_QUOTA, then clicks the Conversations block control. Pending sends settle, capture becomes false/callId null, policy denies messaging/history, and network remains online.
- An unsaved display-name draft survives blocking and remains absent from persisted settings until explicitly saved. Unblock remains permission-denying. Existing sandbox/foreign/overlay denial, text escaping, voice/PTT/gain/output and720x600 layout checks retained.
- Reviewed updated `lobbymesh-messaging-test.png`, labeled synthetic/no live peer. Native fixture initially timed out because its restore/save click used an unscoped form selector; scoped it to Preferences and waited for enabled unblock. No deadline or product assertion was relaxed.

Proof tier: native Windows UI plus injected media/transport, UNIT policy tests. No hardware microphone, actual Roblox, LAN/NAT, real contact-age enforcement, independent-user moderation or release acceptance.
