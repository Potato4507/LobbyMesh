# Raspberry Pi + one-house LobbyMesh verification lab

Headless recovery extension (2026-10-30): `pnpm lab:pair --bootstrap LAB_INTERFACE_IPV4:49737 --scenario restart` exercises production network-instance replacement, identity/permission retention, voice default-off, fresh text ACKs and revocation with existing optional authorized SSH worker fields. Local SAME_HOST proof only; no Pi/namespace execution or privilege claim. See evidence/headless-network-restart.md.

## Design goal

One Windows computer and one Raspberry Pi on the **same home LAN** are sufficient for real cross-device protocol verification. The Pi can also provide a safe, self-contained Linux virtual-network lab for NAT and traffic impairment. These tests complement, but cannot replace, genuine remote-network trials. This lab is optional: an unavailable Pi never blocks unrelated engineering work.

## Phase 0 — access with least privilege

Implemented Windows entrypoint: `pnpm lab:doctor --ssh-target AUTHORIZED_ALIAS`. It runs the existing read-only facts script through explicitly targeted SSH, with strict known-host checking, existing batch authentication, 5s connect/10s total bound and 8KiB output limit. Reports only normalized capabilities, never the target/raw device strings/errors. No installs, elevation or host networking changes. Unit/child-process tests cover safe options, normalization, malformed/duplicate/oversize facts, nonzero/spawn failures and timeout cleanup. The actual remembered authorized target timed out on 2026-10-29, so no current Pi inventory or physical topology has been verified.

- Ask the user to power on the Pi, enable SSH and supply a target through an approved SSH mechanism; do not invent hostnames/usernames, prompt for passwords in conversation, install SSH credentials or expose port 22 to the internet.
- Collect **read-only** OS/model/architecture/memory information using `bash labs/pi/host-facts.sh`, plus the presence of `ip`, `nft`, `tc`, `node` and `pnpm`. Avoid writing hardware identifiers, home IP addresses or SSH target paths into Git logs.
- Test a non-root SSH session before asking for privileges. Obtain explicit authority for package installation or namespace/firewall commands. Prefer distro-native iproute2/nftables and existing Node 24/pnpm; inspect support for ARM64/native HyperDHT dependencies instead of assuming Electron runs there.
- Make a headless Pi peer that imports the **production networking packages** and runs in isolated ephemeral profiles, with a bounded CLI (`test-peer --listen/--connect/--scenario/--duration ...`) and safe shutdown. Do not force Electron onto Linux ARM or store identities in the checkout.

## Phase 1 — real physical LAN tests

Run a Windows client and a Pi headless client with truly independent identities. Verify bootstrap/discovery and mutual Noise/peer-ID authentication, then short text and control-plane voice signaling, peer restarts, crash/drop/recovery, simultaneous initiation and 100+ repeated connects. Record exact commit/protocol versions, platform, results and cleanup. A LAN path can bypass real NAT; do not label this `REAL_EXTERNAL`. Keep physical-microphone tests on an explicitly consented desktop, not via SSH automation.

## Phase 2 — isolated virtual WAN on Pi

`labs/pi/netlab.sh` creates **five** isolated Linux network namespaces (2 clients, 2 NAT routers, 1 transit). Each client uses a private /24, each router has an independent external /30, and the transit namespace provides only the inter-router path. NAT masquerading and stateful inbound restrictions live **inside router namespaces**, not on the Pi's physical interfaces. `tc netem` impairment is applied **only** on transit interfaces. Linux namespaces isolate interfaces, routes and firewall state; this arrangement does not modify root networking or the SSH connection.

Topology:

```
client A 10.77.1.2/24          client B 10.77.2.2/24
       |                              |
router A 10.77.1.1           router B 10.77.2.1
outside 198.18.10.2          outside 198.18.20.2
       |                              |
WAN A 198.18.10.1 --- WAN B 198.18.20.1
         [isolated transit namespace]
```

Both public-looking addresses are RFC 2544 benchmarking addresses in an isolated lab, **not** publicly routed IPv4 addresses. The normal `nft masquerade` setup gives stateful SNAT behavior but does **not** accurately emulate every cone/symmetric/CGNAT variant or provider filtering rule. Strict NAT-type experiments need explicit validated mapping/port-rewriting fixtures; label each scenario accurately.

Commands (run on Pi only, after authorization and review):

```
bash labs/pi/host-facts.sh
sudo bash labs/pi/netlab.sh create
sudo bash labs/pi/netlab.sh status
sudo bash labs/pi/netlab.sh profile typical
sudo bash labs/pi/netlab.sh profile severe
sudo bash labs/pi/netlab.sh profile clean
sudo bash labs/pi/netlab.sh destroy
```

Run test peers within `lmx-a` and `lmx-b` using `ip netns exec`; **drop to an unprivileged user** before running the Node process. Put an ephemeral test bootstrap in `lmx-wan` (not the real internet) or use explicitly controlled public bootstrap where feasible. Validate all listeners and routes before claims. Do not put the Pi's SSH endpoint in either test namespace. Tests must not add host default routes, alter root `nft` rules, change physical interfaces, install system services, open router ports, or start permanent daemons. On failure run `destroy` only after stopping test-owned processes; it refuses to remove namespaces while processes are still present.

## Minimum scenarios

- clean baseline (10–20 ms, no loss), mild (40 ms/10 ms jitter/1% loss), severe (180 ms/50 ms jitter/7% loss); document values per egress leg and distinguish one-way vs RTT.
- independent same-session claims vs forged/unverified/expired claims; 2–20 synthetic consented peers and repeated restart; split/merge with bounded recovery.
- bidirectional burst concurrency and the historical local connected-but-not-admitted native stream; separate app-handler timeout from native transport phase.
- route failures and recovery, offline DHT discovery fallback, voice signaling and PTT-safe interruption. Include negative tests: invalid key, blocked peer, drop during call, no accidental private voice capture.
- setup/teardown idempotence, test-owned process cleanup, no residual qdiscs/namespaces and SSH continued reachability.

## Useful commands and reference docs

- `ip netns`, virtual Ethernet pairs: `man ip-netns`, `man ip-link`.
- Linux impairment: https://man7.org/linux/man-pages/man8/tc-netem.8.html
- NAT/masquerade: https://wiki.nftables.org/wiki-nftables/index.php/Performing_Network_Address_Translation_(NAT)
- Never assume a successful virtual-NAT test proves cross-ISP NAT or commercial firewall compatibility.
