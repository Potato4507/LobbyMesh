# Two-DHT networking invariants

```text
Existing public DHT network
     |
     | discover LobbyMesh application entry-point(s)
     v
LobbyMesh ephemeral application-layer DHT
     |
     | resolve short-lived signed opt-in session advertisements
     v
Authenticated direct peer connections
     |
     +-- encrypted control + text
     +-- negotiated secure low-latency audio
```

- These are **two separate distributed discovery layers**. Public DHT is not session database. LobbyMesh DHT is not merely a peer list or a renamed namespace of the same public DHT.
- Participants operate the application DHT only while their app runs; when zero are online, it has zero active nodes. On restart, a first participant can create a new single-node overlay and advertise its discoverable entry point on the *existing* public DHT.
- Public bootstrap is a dependency on others' independently operated infrastructure; an advertised contact is not a guaranteed reachable address. A failing NAT/firewall path may require an optional user-chosen relay, or communication fails.
- Use common protocol identifiers and versioned keys; simultaneous first nodes and partitions must reconcile by periodic discovery, authenticated membership exchange, anti-entropy and bounded record convergence.
- Distinguish transport keys, app identity keys, session claims and verified Roblox session identity. Bind app identities to transport handshakes; store no plaintext secrets in DHT announcements.
- Do not turn an unverified Roblox server seed into a trusted proof or leak discoverable session identifiers through untrusted public topics. No public directory of bystanders.
- A public DHT announcement should only advertise minimal app entry-point information. The application DHT should store only authorized, short-lived, signed session entries; voice/text use direct authenticated media/data streams when available.
- Measure bandwidth and memory with 2, 10, 100+ simulated members and targeted real clients; document mesh fanout limits and connection failures.
