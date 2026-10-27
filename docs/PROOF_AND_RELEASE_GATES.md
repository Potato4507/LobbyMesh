# LobbyMesh — tests, truthfulness, safety and release gate

## Verification taxonomy
- `UNIT_VERIFIED`: deterministic test of one module with controlled dependencies.
- `INTEGRATION_VERIFIED`: at least two real modules/processes exchange real protocol traffic (which boundaries were real must be stated).
- `PUBLIC_NETWORK_VERIFIED`: external public bootstrap discovery actually completed; an earlier timeout is not a pass.
- `REAL_WORLD_VERIFIED`: actual Windows client, device, separate networks, or Roblox-authorized experience exercised as appropriate.
- `BLOCKED_EXTERNAL`: missing device, credential, API, reachable network or permission.
- `UNSUPPORTED`: evidence shows a required feature not offered through permitted interfaces.

A feature may be `UNIT_VERIFIED` yet product-incomplete. Keep exact commands, date, OS, fixture, test count, and honest failure in docs/evidence or TEST_MATRIX. Do not update module to “fully complete” because mocks passed.

## Mandatory acceptance gates
1. Public DHT discovery succeeds between independent peers on an accessible public bootstrap network; optional test must not be confused with private local DHT.
2. Independent LobbyMesh DHT launches single-node, joins on a second process, reconciles simultaneous nodes, handles leave, churn, partition, and whole-network shutdown/restart.
3. Two peers are matched only by correctly scoped, signed, time-limited session claims. DHT and account keys do not prove Roblox identity.
4. Authenticated and encrypted peer transport rejects forged handshakes, replay, oversized frames, untrusted input, and blocked peers.
5. Text messages work across separately running processes with backpressure, retries and dedupe. Microphone transmission never starts before permission and chat controls are consent-based.
6. Cross-NAT reachability and public network are reported honestly. Provide visible failure status where direct connections cannot be established; no hidden billed relay.
7. Automated supported-session detection must be tested with an actual supported legitimate Roblox source. `game.JobId` in Luau is not an automatically available desktop API. No extraction of bystander roster or cookie/memory hacking.
8. Windows app starts, settings persist, sound/overlay behavior is observed on actual hardware, and shutdown cleans up resources.
9. Safety/privacy are reviewed before distribution: minors and unsolicited contact, harassment/reporting, IP exposure, data retention, threats from hostile DHT nodes, platform permission, lawful distribution. If volunteer moderation infrastructure would be required, admit the operational limitation.
10. Release requires user authorization. No unilateral publish/release/paid deployment, no guarantee of worldwide functionality.

## Triage priorities
Functional correctness > protocol compatibility > security/privacy > stability/resource bounds > user experience > speculative extra features. Keep genuine external blockers isolated behind typed interfaces and productive remaining modules moving.
