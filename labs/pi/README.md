# Raspberry Pi network-test helper files

The Pi is **not** a production relay, not an obligatory service and not a substitute for real public-network testing. No network or SSH change has been performed as part of this handoff.

`host-facts.sh` performs read-only capability discovery and omits network/SSH addresses. `netlab.sh` is an opt-in Linux namespace experiment and requires explicit approval for `sudo`; it creates only `lmx-a`, `lmx-b`, `lmx-ra`, `lmx-rb`, `lmx-wan`, their four veth pairs, NAT/firewall **inside router namespaces**, and qdiscs **inside the transit namespace**. Both veth endpoints are created directly in namespaces. It does not install software or alter the Pi's host routes, host nftables, Wi-Fi/Ethernet device, router configuration, SSH service, or firewall. Cooperating operations serialize through a root-owned `/run/lobbymesh-netlab.lock` (`flock` required). Existing namespace names block creation. Only namespaces marked on loopback with `lobbymesh-netlab-v1` qualify for later destroy/profile; unmarked older labs require explicit operator inspection. Deletion refuses active processes or failed inspection, checks all namespaces before deleting any, and empty cleanup is idempotent. Setup rollback tracks only this invocation's creations, including nested-command failures. Syntax and eight unprivileged command-model fault cases pass; no actual Pi/kernel namespace operation has been verified.

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

To run a test peer inside a namespace, use `ip netns exec lmx-a` or `lmx-b` with a **non-root** process identity. The implemented headless peer keeps independent app/transport credentials only in memory. It imports production runtime, pairing and messaging; it never loads Electron or captures audio. See [headless protocol and evidence](../../docs/evidence/headless-lab.md).

After read-only inventory and any necessary device authorization, start an explicitly bounded private bootstrap on an operator-selected reachable interface:

```bash
pnpm lab:peer --mode bootstrap --host LAB_INTERFACE_IPV4 --port 49737 --duration-ms 120000
```

Keep its stdin open until the run ends. `LAB_INTERFACE_IPV4` is a placeholder, never a committed home address. On Windows, with an existing authorized SSH alias/known host and this checkout + pinned dependencies already present on the worker:

```text
pnpm lab:pair --bootstrap LAB_INTERFACE_IPV4:49737 --ssh-target AUTHORIZED_ALIAS --remote-root /absolute/checkout --count 4
```

This runs one local and one SSH stdio-controlled peer, authenticates independent signed invitations, approves only ephemeral lab identities, exchanges four acknowledged synthetic messages each way, verifies incoming history and revoked-contact denial, then confirms cleanup. SSH uses BatchMode, strict known-host checking and a five-second connect timeout; it installs nothing. Without SSH options both peers run locally. Counts are limited to 1–8 per direction to stay below production text quotas. No public bootstrap fallback is permitted. Lifetime is 120 seconds by default, bounded to 1–600 seconds for standalone peers; EOF/SIGINT/SIGTERM stop owned resources. `stop` is also an explicit JSONL operation.

JSONL operations are exact `{id,op}` (`status`, `code`, `stop`) or `{id,op,value}` (`preview`, `approve`, `send`, `history`, `revoke`). IDs are positive safe integers; values are bounded to 4096 UTF-8 bytes, total buffered input 8192 bytes, one operation at a time. Control output includes ephemeral public identities/invitations and synthetic messages; **do not retain it as evidence**. The pair runner exports only aggregate metrics, never endpoints/invitations/content/SSH targets. SSH mode reports `REMOTE_UNCLASSIFIED` until actual physical inventory/topology is independently established; it cannot assert distinct computers from an SSH connection alone.

For the virtual lab use the same peers inside client namespaces and an explicitly addressed bootstrap inside transit, under unprivileged identities after approved setup. The runner/SSH path has not been tested on a Pi; ARM native dependency availability, kernel setup, LAN and virtual-NAT acceptance remain unverified. Voice signaling, restart/rekey scenarios and 100+ connection stress remain follow-up work.

The virtual WAN is isolated on a single Linux kernel. It models private subnets, stateful SNAT/inbound filtering and impairments, not arbitrary real carrier-grade NAT, full symmetric NAT or two ISPs. Same home LAN cross-device tests are a separate evidence tier. Do not put the user's personal SSH endpoint, peer private keys or network captures in test artifacts. Run `bash labs/pi/test-netlab.sh` for eight unprivileged command-model cases; this mocks every `ip` call and creates no real namespace, lock or firewall rule.
