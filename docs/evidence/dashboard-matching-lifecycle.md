# Matching display follows the network lifetime — 2026-10-30

The native held-dashboard regression reproduced a stale session-matching claim after completed Disconnect: actual network teardown and Enable peer discovery were confirmed, while matchingStatus still read 0 companions found in this session. The exact offline-label assertion failed before repair.

The renderer now clears the prior matching observation when a network action starts and accepts matching snapshots under the same connection action revision as their network snapshot. Non-online connections display matching offline; an online connection without a new matching observation displays Checking session matching rather than reusing the previous network instance's count. Session detection remains independent of networking. Backend matching membership, transport, permissions and contact eligibility are unchanged.

The native fixture asserts matching offline immediately after actual teardown and again after releasing the old online snapshot. The existing MutationObserver still catches transient Connected/Disconnect restoration. All original lifecycle and synthetic voice assertions and30s process limits remain; exact full verification outcome is in STATUS. This does not establish actual Roblox participants, LAN, NAT or physical audio.
