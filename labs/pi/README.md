# Raspberry Pi network-test helper files

The Pi is **not** a production relay, not an obligatory service and not a substitute for real public-network testing. No network or SSH change has been performed as part of this handoff.

`host-facts.sh` performs read-only capability discovery and omits network/SSH addresses. `netlab.sh` is an opt-in Linux namespace experiment and requires explicit approval for `sudo`; it creates only `lmx-a`, `lmx-b`, `lmx-ra`, `lmx-rb`, `lmx-wan`, their four veth pairs, NAT/firewall **inside router namespaces**, and qdiscs **inside the transit namespace**. It does not install software or alter the Pi's host routes, host nftables, Wi-Fi/Ethernet device, router configuration, SSH service, or firewall. It will refuse `create` if its namespace names exist and refuse `destroy` while namespace processes are present. The script has been syntax-checked, not run against an actual Pi: verify Linux kernel modules, nft and `ip netns` behavior before treating it as tested.

Read `docs/PI_NETWORK_LAB.md` first. Then, with authorized access:

```bash
bash labs/pi/host-facts.sh
# If iproute2 + nftables are available AND you've approved privileged test setup:
sudo bash labs/pi/netlab.sh create
sudo bash labs/pi/netlab.sh status
sudo bash labs/pi/netlab.sh profile typical
# Stop all test processes before cleanup.
sudo bash labs/pi/netlab.sh destroy
```

To run a test peer inside a namespace, use `ip netns exec lmx-a` or `lmx-b` with a **non-root** process identity and an isolated profile; supply the real code-driven CLI once Codex implements a headless peer harness. The current repository does **not** yet include a verified cross-machine orchestration command. Do not invent a non-existent `pnpm test:pi` or claim it passed.

The virtual WAN is isolated on a single Linux kernel. It models private subnets, stateful SNAT/inbound filtering and impairments, not arbitrary real carrier-grade NAT, full symmetric NAT or two ISPs. Same home LAN cross-device tests are a separate evidence tier. Do not put the user's personal SSH endpoint, peer private keys or network captures in test artifacts.
