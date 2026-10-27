# /plan — Modular Implementation and Proof Plan

**Project:** Autonomous, infrastructure-independent, opt-in P2P Roblox companion with a public-bootstrap DHT and a separate self-starting application DHT.

**Primary operator goal:** copy `MASTER_PROMPT.md` plus this file into a capable coding agent with filesystem and shell access; the agent should implement and validate each module, then integrate the verified modules without repeatedly asking for routine approval. These Markdown headings are conventions, **not magic ChatGPT commands**.

## /goal

Build a fully automatic (after initial permission/configuration) Windows-first companion. When an authorized Roblox session is available, discover consented fellow participants in the same session, connect securely, and offer text and low-latency voice. Maintain zero mandatory project-owned backend services. Keep the communication framework usable as a standalone, testable P2P system even while Roblox source APIs are unresolved.

### Reality gates that must not be hand-waved

1. `game.JobId` and `Players:GetPlayers()` exist **inside** a Roblox experience. This does **not** prove a universal independent desktop API exists to read a server roster or JobId. The real automatic Roblox discovery goal must be independently validated. Roblox currently limits unsupported off-platform player tracking and identity extraction.
2. **A DHT helps discover peers; it cannot guarantee two NATed computers can connect directly.** Direct P2P may fail behind restrictive networks. Relay-free mode explicitly trades off reliability. Optional community TURN/relay must be off by default, permissioned and clearly labeled as someone else's infrastructure.
3. **Two DHTs means two discovery/routing layers.** Existing public HyperDHT is *only* an entry-point discovery network; the app-specific DHT is a distinct overlay with its own signed key/value storage, routing table, routing protocol, replication, and partition repair. It is not a label slapped on HyperDHT topics.
4. A DHT's discovery records do not prove someone's account identity, age, game session, or good intentions. Cryptographic peer identity and trusted session membership are separate components.
5. When nobody is online, the app DHT can disappear. The first returning user must become public-DHT-discoverable. Simultaneous first users must eventually merge. Public DHT nodes and reachability are **external dependencies**, not guaranteed addresses forever.
6. The goal is usable communication, not covert client manipulation, involuntary connection to minors, or evasion of platform-required safety controls. Implement consent-based sessions, safety controls, and compliant data access.

## /references_to_verify_live

- HyperDHT docs: https://github.com/holepunchto/hyperdht (lookup/announce topics; encrypted streams; public bootstrap; limitations for isolated networks).
- Roblox DataModel `JobId`: https://create.roblox.com/docs/reference/engine/classes/DataModel
- Roblox Players `GetPlayers`: https://create.roblox.com/docs/reference/engine/classes/Players
- Roblox Open Cloud: https://create.roblox.com/docs/cloud
- Roblox Creator Third Party App Policy: https://en.help.roblox.com/hc/en-us/articles/37924211313044-Creator-Third-Party-App-Policy
- Electron security: https://www.electronjs.org/docs/latest/tutorial/security

Before coding against third-party APIs, read **current** docs and check versioned functionality. Do not invent an OAuth scope, endpoint, or session token extraction method.

## /repository_layout

```
companion/
  MASTER_PROMPT.md
  IMPLEMENTATION_PLAN.md
  AGENTS.md                   # optional copy/summary of master instructions
  package.json
  pnpm-workspace.yaml
  pnpm-lock.yaml
  apps/desktop/              # Electron main, narrow preload, React renderer
  packages/protocol/         # schemas, semver, feature negotiation
  packages/identity/         # keys, signatures, ID binding
  packages/public-discovery/ # external DHT adapter
  packages/app-dht/          # own Kademlia overlay
  packages/session/          # supported / mock session providers
  packages/roster/           # opt-in participant roster
  packages/matchmaking/      # session topic, signed ephemeral advertisements
  packages/transport/        # authenticated direct P2P streams, signaling
  packages/security/         # consent, blocklist, quotas, anti-abuse
  packages/text/             # direct reliable messages
  packages/voice/            # WebRTC / Opus and controls
  packages/lifecycle/        # autonomous state machines
  roblox/sdk/                # permitted Luau integration
  roblox/studio-plugin/      # authorized installation/configuration
  tests/simulation/          # fault/churn/network partitions
  tests/e2e/                 # live multi-process test harness
  docs/STATUS.md
  docs/TEST_MATRIX.md
  docs/DECISIONS.md
  docs/THREAT_MODEL.md
  docs/PROTOCOL.md
  docs/PRIVACY.md
  docs/RELEASE.md
  .github/workflows/ci.yml
```

### Shared interfaces first

Build these in `packages/protocol`; names illustrative; adjust to match library capabilities but preserve their semantics:

```ts
type PeerId = string; // derived from verified cryptographic public key
interface VerifiedPeer { id: PeerId; publicKey: Uint8Array }
interface PeerContact { id: PeerId; publicKey: Uint8Array; connectionHints: unknown[] }
interface SessionIdentity {
  universeId: string; placeId: string; jobId: string;
  evidenceSource: 'test' | 'authorized-sdk' | 'official-api';
  verification: 'mock' | 'self-asserted' | 'externally-verified';
}
interface SessionProvider {
  current(): Promise<SessionIdentity | null>;
  subscribe(handler: (session: SessionIdentity | null) => void): () => void;
}
interface BootstrapDiscovery {
  start(): Promise<void>;
  findAppEntrypoints(): AsyncIterable<PeerContact>;
  announceAppEntrypoint(): Promise<void>;
  stop(): Promise<void>;
}
interface ApplicationDHT {
  start(): Promise<void>;
  join(contact: PeerContact): Promise<void>;
  put(key: Uint8Array, record: SignedRecord): Promise<void>;
  get(key: Uint8Array): Promise<SignedRecord[]>;
  leave(): Promise<void>;
}
interface SignedRecord {
  protocolVersion: number; author: PeerId; seq: number;
  createdAt: number; expiresAt: number;
  content: Uint8Array; signature: Uint8Array;
}
interface PeerTransport {
  connect(contact: PeerContact): Promise<SecureConnection>;
  onIncoming(callback: (c: SecureConnection) => void): () => void;
}
```

Use explicit trust and data provenance. An asserted same-server claim is **not** an externally verified Roblox session. Do not conflate DHT peer keys, Roblox user IDs, and session ownership.

## /dependency_map

- Foundation: **M00 -> M01 -> M04 -> M05 -> M06/M07 -> M08 -> M09 -> M10 -> M12/M13**.
- Security **M11** begins with M01 and is reinforced at every network boundary.
- Roblox API feasibility **M02/M03** starts immediately after M00, in parallel with networking.
- UI **M14** may use test services before real transport.
- Lifecycle **M15** integrates states from all modules.
- Game developer SDK **M16** depends on permissions/official Roblox findings; it must not be required to verify the independent generic network.
- System and packaging **M17/M18** close the loop.
- Independent modules may be implemented in parallel **only if a coding environment actually supports isolated branches and deterministic merge/retest**; otherwise follow dependency order.

---

# /steps — Prompts and acceptance gates

For every module, the coding agent should apply this exact universal instruction:

> **Module instruction:** Implement this module completely within its own package, expose a documented versioned interface, add deterministic tests and at least one negative/failure test, execute the tests, show evidence, update STATUS/TEST_MATRIX, and continue immediately to the next unblocked module. Never substitute pseudocode or mock evidence for a real integration claim. Never rely on another unfinished module except through an explicitly defined fake/test adapter.

## M00 — Repository, contracts, automation, test infrastructure

**/prompt/M00**

> Create a TypeScript pnpm monorepo with independent packages, Electron/React desktop scaffold, Vitest (or equivalent), test fixtures, TypeScript strict settings, lint/format scripts, CI workflow, protocol package, architecture decision records, status tracker, and executable simulator harness. Pin dependencies and record supported Node/Electron versions. Provide `pnpm install`, `pnpm build`, `pnpm test`, `pnpm lint`, and `pnpm typecheck`. Configure safe Electron process separation and IPC from the beginning. Avoid any hosted backend, paid cloud, or credentials.

**Proof:** Fresh checkout with documented toolchain installs, builds, unit tests, lints, and launches placeholder UI. CI uses no project server or paid resource. **Next:** M01 and Roblox research M02/M03.

## M01 — Cryptographic installation identity

**/prompt/M01**

> Implement persistent local Ed25519 identity, canonical PeerId derivation, signing/verification, fingerprint display, secure OS credential/key storage when available, strict file permissions as fallback, identity migration/versioning, and identity revocation/reset flow. Never write private keys to logs or DHT records. Ensure libraries work in the Node/Electron runtime. Add bad-signature, wrong-key, corrupted-storage, replay-sequence and restart tests.

**Contract:** `loadOrCreateIdentity()`, `sign()`, `verify()`, `peerIdFromPublicKey()`.

**Proof:** Restart retains identity; independent installations differ; forged records rejected; no secrets in logging snapshots.

## M02 — Automatic Roblox session identification feasibility (research gate)

**/prompt/M02**

> Research currently supported, documented, externally usable Roblox APIs for determining **the consenting local player's currently joined exact instance/JobId** without client memory access, injection, cookies, undocumented endpoints, or collecting bystander identities. Make a capability matrix for official APIs, approved OAuth permissions and game-authorized SDK. Create a `SessionProvider` interface, `MockSessionProvider` for tests, and production provider(s) **only if evidence and authorization permit**. Validate any production method on a Roblox experience we control or a reproducible official API test; record permission requirements, rate limits, and session-change handling. If no general automatic method exists, mark `UNSUPPORTED_UNIVERSAL` and keep the app honest. Do not insert a manual server-ID production workaround and call this milestone successful.

**Proof:** A running supported integration automatically reports stable `(universeId, placeId, jobId)` and changes; test verifies distinct instances differ. If impossible to verify, publish API audit, supported subset, and blocker, not a fake implementation.

## M03 — Roblox roster vs consenting participation

**/prompt/M03**

> Independently audit official ways of obtaining actual players connected to a specific Roblox instance, distinguishing `Players:GetPlayers()` inside developer-controlled experiences from what any independent desktop app is authorized to observe. Design a `RosterProvider` that exposes only consented companion participants. Test with 0, 2, 30, and 100 synthetic players; join/leave; duplicate display names; mapping to verified stable identifiers where authorized. Do not scrape or export nonparticipants' identities, defeat Roblox anti-cheat, or claim public server listings reveal real usernames without supporting evidence.

**Proof:** Supported data source and clear trust model, mock roster tests, public/private-data boundary tests. `BLOCKED_EXTERNAL` is a valid honest research result, not a completed universal roster.

## M04 — Existing public DHT bootstrap adapter

**/prompt/M04**

> Implement a thin existing-public-network adapter using current HyperDHT APIs: connect through supported bootstrap nodes, create a persistent per-installation listening keypair, announce under a fixed versioned **application-entrypoint discovery topic**, look up peer keys, deduplicate and validate results, unannounce on graceful stop, retry with backoff and multiple known bootstrap nodes. Publish no Roblox server IDs or private user information to the public DHT. Provide an in-memory deterministic discovery fake and separate real-network CLI smoke test. Rate-limit queries and announcements.

**Proof:** Two independently launched Node processes discover each other's announced **app entry points** on the public DHT. Connection to the topic is distinct from joining our app DHT. No fixed project-hosted peer is required. Show actual logs for real-network tests or mark them unverified if networking is unavailable.

## M05 — Check for an existing application DHT

**/prompt/M05**

> Implement entrypoint search using the public DHT adapter. Query known live contacts in parallel with a bounded timeout, authenticate app-protocol version compatibility, discard forged/unreachable entries, and return candidate peers ranked by measured reachability and recency. A failed lookup must NOT be taken as proof that there is no network. Expose state events `discovering`, `candidates-found`, `no-reachable-candidate`, and `retrying`.

**Proof:** Simulate (a) network exists, (b) no network, (c) stale records, (d) hostile records, (e) intermittent public DHT, (f) two simultaneous first clients. No hangs or unbounded retries.

## M06 — Start a single-node application DHT

**/prompt/M06**

> Implement an **independent** ephemeral Kademlia-style application-layer DHT that starts with one peer: local node identity, routing table, bounded key/value record store, signed record verification, RPC dispatch over an abstract authenticated stream, protocol namespace/version. Make it operate with exactly one participant while still advertising an app entrypoint through public DHT. Do not instantiate stock HyperDHT with bootstrap=[] and declare it a functional globally accessible DHT. Default to sensible Kademlia parameters and record choices in an ADR.

**Proof:** One node supports valid local put/get, rejects expired/invalid records, advertises to public discovery, and shuts down without leaving an application-specific server.

## M07 — Join an existing application DHT

**/prompt/M07**

> Implement transport of app-overlay RPCs over authenticated streams to discovered peers. Perform protocol/capability negotiation, authenticate remote peer keys, populate routing buckets, validate and replicate records as permitted, and refresh peer contacts. Joining must be idempotent and robust to multiple introductions, disconnections, incompatible versions and simultaneous joins. Use real peer processes for acceptance.

**Proof:** Starting two separate app processes in either order results in a single discoverable app namespace and cross-node record lookup. A third node joins without direct knowledge of the first one's address.

## M08 — Actual DHT routing, lookup, replication and healing

**/prompt/M08**

> Complete the app-specific Kademlia overlay: XOR-distance contact routing, bounded k-buckets and eviction, iterative FIND_NODE/FIND_VALUE, signed record put/get with TTL and capped storage, replication, anti-entropy, query timeouts, partition healing, network merging and re-announcement. Protect from Sybil floods, replay, oversized records, unbounded gossip and memory exhaustion. Make public discovery periodic enough to reconcile two simultaneously started groups, but not part of normal app-overlay lookups. Implement reproducible deterministic tests with fake clock/transport and seeded randomness.

**Proof:** Simulate 1, 2, 10, 100 and 500 ephemeral nodes; random churn and abrupt termination; two partitions merge; signed record availability converges within a documented bounded test time where underlying connectivity allows. Verify shutdown to zero nodes and subsequent restart. Publish lookup latency, routing-table size, memory and traffic measurements. Do not promise a full DHT after network partitions with no usable transport.

## M09 — Session-key matching inside the app DHT

**/prompt/M09**

> Implement a canonical, versioned session-key encoding derived from session evidence `(universeId, placeId, jobId)` and an application namespace, with no ambiguity/collision from string concatenation. Derive short-lived lookup keys, publish only consented participants' signed ephemeral session advertisements, look up matching participants, verify signatures and expiry, reject records blocked by the user, and remove memberships on session departure. Avoid exposing raw identifiers in public-DHT announcements. Explain that hashes of guessable IDs are not secrets. Separate `self-asserted` and `externally verified` session claims; do not infer a real Roblox user is in a server merely from a forged assertion.

**Proof:** 50 participants across five synthetic rooms find only peers in the same session; two identical IDs match; different JobIds do not; stale records and forged signatures fail; leaving removes or expires membership.

## M10 — Direct authenticated P2P streams and NAT behaviors

**/prompt/M10**

> Implement secure peer connection establishment after lookup, using audited Noise-based peer streams or an equivalent current audited authenticated transport; bind the transport identity to the verified PeerId from M01. Provide peer negotiation, connection reuse, heartbeat, cancellation, failure reporting, direct paths, and configurable non-mandatory relay support. Do not host a TURN server or require users to open ports manually. Diagnose cases where direct connections fail under symmetric/restrictive NAT. Never pretend public DHT discovery guarantees NAT traversal.

**Proof:** Two different local processes exchange encrypted test messages. Cross-machine/cross-ISP verification is required before declaring general internet operation tested. Negative tests for impostors, dropped connections, unexpected close, timeouts and IP exposure disclosures.

## M11 — Security, privacy and abuse protection (ongoing independent module)

**/prompt/M11**

> Threat model all untrusted network inputs, peer authentication, DHT poisoning, Sybil identities, spam, DoS, IP disclosure, encryption downgrade, man-in-the-middle, malformed traffic, forced subscriptions and unsolicited contact with minors. Add signed records, replay windows, bounded buffers, quotas, protocol-version validation, consent state, blocklists, mute/report tools, rate limiting and retention controls. Avoid using Roblox account data to circumvent user age or safety requirements. Make security tests runnable independently and in integration. Do not build custom encryption algorithms.

**Proof:** Document threat model and security tests; reject spoofed peer, invalid signature, duplicate replay, gigantic message, expired record, mismatched room, blocked participant; no automatic microphone capture before consent. Report features that require human moderation infrastructure as unresolved rather than claiming complete safety.

## M12 — Reliable online text messaging

**/prompt/M12**

> Implement direct P2P text messaging over the M10 authenticated streams using versioned envelopes, sender identity, message IDs, timestamps, ordering where practical, ACK/deduplication, bounded retry, backpressure, input sanitation, peer-specific history retention and block enforcement. No centralized store and no offline message delivery claim. Add fake transport and deterministic faults.

**Proof:** Exchange 10,000 synthetic messages between two peers while injecting duplicate packets, reorderings, crashes and reconnections. Document actual message reliability and behavior during partitions.

## M13 — WebRTC/Opus voice

**/prompt/M13**

> Build a separate microphone/audio subsystem: explicit OS microphone permission, muted-by-default or push-to-talk onboarding, gain/VAD, Opus encoding, WebRTC audio transport with secure identity binding to the authenticated control stream, jitter buffer/echo handling, latency metrics, per-peer volume and mute. Exchange WebRTC SDP/ICE signaling over authenticated P2P control channels. Support switching between individual and group rooms, avoid unbounded full-mesh uploads, and surface P2P failure without silent relay substitution. Document if and where endpoint/host media may be decrypted. No surveillance recording.

**Proof:** Two clients can send/receive audio on a test device; mute and PTT visibly work; no captured audio before permission; simulated 2/5/10/30-member stress runs; real 30-user claim requires real network data and cannot be inferred from simulation alone.

## M14 — Desktop UI, overlay and user preferences

**/prompt/M14**

> Build a polished but lightweight Electron + React interface using secure preload IPC. Provide onboarding permissions, app startup preference, automatic/ask/manual **voice participation** (not manual network configuration), microphone settings, compact non-injected overlay where OS supports it, status for public/app DHT/session/P2P/media, available opted-in peers, text chat, mute/block/report, privacy info, and clear unsupported-session messaging. No modifications to Roblox process or game client. Use mocked providers for all UI states and automated component tests.

**Proof:** Screenshot/visual review, UI tests for offline, discovery, zero peers, joining, connecting, active, blocked, invalid session, no mic, and failed NAT. Verify Electron security configuration and IPC validation.

## M15 — Autonomous lifecycle orchestration

**/prompt/M15**

> Implement a deterministic state machine that detects approved application/game lifecycle signals, loads identity, starts public bootstrap, finds or initializes app DHT, joins/maintains, receives supported session changes, publishes/withdraws session advertisements, matches peers and connects securely, manages mic and messaging, and gracefully closes or sleeps. Add cancellation tokens, abortable requests, exponential backoff with jitter, bounded retries, debounce, idempotence and race prevention across quick server switches. Network joining must be automatic; first-run user permission remains explicit. Simulate failures and sleep/resume.

**Proof:** No required user intervention after setup in the supported test flow. Passing chaos tests: crash, sleep, wake, rapid session change, disconnected public DHT, stalled peer handshake, repeated process launch, full last-node shutdown and network restart.

## M16 — Roblox Studio SDK and developer capabilities

**/prompt/M16**

> Where allowed, implement a self-contained Luau SDK for an experience its developer explicitly controls: detect `game.JobId`, UniverseId and PlaceId, optional in-experience voice/proximity/gameplay audio hooks, and clear permissions boundaries. Validate creator ownership/authorization through supported mechanisms; do not treat a client claim as proof of developer status. Do not write unrestricted in-game chat around required native filtering or age policy. Create a sample experience and install guide. Research how a permitted desktop pairing/bridge could receive its own verified server ID without imposing manual IDs on ordinary users; if no authorized automatic link exists, mark it blocked and do not claim universal support.

**Proof:** Studio test place returns real JobId/server events, demonstrates permitted proximity/gameplay mechanics, verifies no bystander roster exported, and documents exactly what the SDK cannot provide to a standalone desktop app.

## M17 — End-to-end integration and fault testing

**/prompt/M17**

> Integrate only versioned contracts from independently passing modules. Create a 2-process no-Roblox demonstration and a network-simulated multi-node demonstration. Exercise full pipeline: start app, public bootstrap, locate or create app DHT, join, publish mock session, match, secure peer stream, send text, connect audio, switch mock session, disconnect, restart after zero nodes. Record structured logs, test evidence and resource use. Run fuzz/property tests on message schemas and security gates. Validate integrations in stages rather than one giant merge.

**Proof:** CI build and tests pass; two real processes communicate with test session keys; full clean shutdown and rebootstrap; protocol is documented. Any genuine internet/hardware tests not run stay unchecked. Universal Roblox mode must not be reported passing without M02/M03 evidence.

## M18 — Documentation, packaging, delivery

**/prompt/M18**

> Produce Windows-first installer where build environment supports it, developer/debug CLI, README, onboarding, troubleshooting, privacy and safety documentation, license, security reporting, dependency/license review, supply-chain audit, protocol compatibility guide, network-limitations explainer and GitHub-ready release artifacts. Clarify that free code and no author-operated servers do not imply guaranteed bootstrappers, TURN coverage, or zero cost to volunteer relays. Create a candid release readiness report with `VERIFIED`, `PARTIALLY_VERIFIED`, `BLOCKED_EXTERNAL`, and `UNSUPPORTED` rows. Continue fixing all reproducible failing tests.

**Proof:** Fresh-install verification on available test machine(s), packaged app launches and logs appropriately, all current checks pass, unresolved limitations visible rather than hidden.

---

## /test_matrix — Minimum distinct proofs

| Scenario | Unit/simulator proof | Real integration proof |
|---|---|---|
| No app users | Zero nodes/leak-free cleanup | All processes closed; no app-owned daemon |
| First user | Creates local app DHT | Publishes app entrypoint through public DHT |
| Second user | Selects app join | Actual separate process discovers and joins |
| Simultaneous first users | DHT merge in simulator | Separate launch within same period; eventual discover/merge |
| First user leaves | Routing repairs | Existing peer connection and lookup still work when possible |
| Everyone exits, someone returns | New network epoch | Public DHT bootstrap recovers from empty network |
| Network partitions | Reconciliation and stale record cleanup | Two separate network segments if test infrastructure allows |
| NAT restrictions | Error/fallback state | At least two external network types required; can't fake in CI |
| Forged records | Authentication, replay and expiry tests | Malicious-peer integration fixture |
| Session IDs | Distinct rooms remain separate | Supported Roblox integration only if official authorization verified |
| Microphone | Consent and mute logic | Audio device test; no unapproved capture |
| Account privacy | No bystander information / secrets published | Audit public DHT payload and logs |
| Full automatic lifecycle | Synthetic game-session event changes | Actual supported game-session source, when available |

## /protocol_basics

- Use independently versioned `public-discovery/v1`, `app-overlay/v1`, `session-advert/v1`, `peer-control/v1` and `media/v1` protocols. Version negotiation must reject incompatible peers safely.
- Use structured canonical byte encoding for signed messages; include protocol, domain separator, author key, nonce/monotonic seq, timestamp and expiry. Reject invalid size, unknown major version and bad signatures.
- Session ads should be short-lived and contain minimal opt-in peer contact data, not all Roblox usernames. Sensitive game/session metadata must not be leaked to unrelated public DHT participants.
- Self-authenticating peer keys prove possession of an app key, not that the holder is a particular Roblox person. Keep `identityTrust` explicit in APIs.
- A privately operated app DHT may be eavesdropped on/poisoned by malicious participants unless messages and access controls are designed to resist that; don't assume DHT membership itself is trusted.
- Cross-player network topology, per-user outgoing bandwidth, WebRTC signaling, and direct-vs-relayed connection reporting must be observable locally but not centralized.

## /autonomous_execution_rules

**Rule A:** As soon as one module reaches `VERIFIED_UNIT` and its dependent integration checks, launch the next unlocked module automatically. No ordinary approval prompts.

**Rule B:** While one module is externally blocked, proceed with other independently testable modules using the dependency-injected mock implementation. Do not silently downgrade the acceptance criteria for the blocked module.

**Rule C:** If a test fails, retry *after changing code for an identified cause*. Do not infinitely rerun the same failing command without modification.

**Rule D:** If encountering API ambiguity, read official source docs and test small reproducible probes. Record the exact endpoint and response schema or absence thereof. Never use undisclosed scraping of private data, auth cookies, game memory or client injection to assert success.

**Rule E:** At each checkpoint update status, changed files, tests run/results, external blockers, risks, and **one next action**. If code model has a context limit, ensure everything required to resume is in repo artifacts.

**Rule F:** Do not optimize away actual proof. Simulated DHT scale is not real global-network reliability; local TCP connections are not cross-NAT proof; fake room IDs are not Roblox server detection.

**Rule G:** Stop reporting progress as complete only when every achievable acceptance condition has evidence. If success depends on missing external tools, authorization or hardware, end with a truthful blocker list and a fully functioning standalone/testable core.

## /status_template

```
# STATUS
Goal: Build a serverless-by-ownership self-bootstrapping two-DHT P2P Roblox companion.
Phase: M00
Module table:
| Module | State | Last test/evidence | Next dependency |
| M00 | NOT_STARTED | - | - |
...
Known blockers:
- Roblox universal self-session identification: UNVERIFIED; don't claim complete.
- Some NAT pairs require relay: inherent limitation.
Next action: Implement M00 monorepo and run fresh-checkout scripts.
```

## /suggested_agent_subprompts

These prompts should be automatically invoked by the primary agent as needed; the user should **not** have to paste them one-by-one:

**/audit**
> Audit the last module against its explicit interface, acceptance tests, security obligations, and original user goal. Run the relevant commands; report any gap with file paths and tests. Fix gaps before advancement.

**/verify**
> Execute independent tests, cross-package integration tests, typechecks and lint. Record exact command, execution environment, pass/fail output and limitations. Never claim unrun tests pass.

**/next**
> Read STATUS and dependency map. Select the next unblocked module, define implementation and test delta, then implement immediately. If blocked, switch to a parallel module and document the blocker.

**/recover**
> Read all persisted plans, statuses, test matrices and ADRs after interruption. Reconcile working tree, rerun fast regression tests, continue the exact next action. Avoid asking the user to restate requirements.

**/release-audit**
> Produce a feature-by-feature final report separating verified functionality, simulation-only evidence, unsupported external Roblox capabilities, security issues, known connectivity limitations, and artifact paths. Do not describe incomplete areas as finished.

## /final_acceptance

A completed generic P2P core is not equivalent to a completed universal Roblox companion. The distinction is required in release descriptions. The project is successful as an engineering exercise if its independently testable core works and every unsupported platform capability is correctly isolated, documented, and never claimed to be functional. Production release requires additional authorization, safety, privacy, and compatibility review appropriate to the deployed features.
