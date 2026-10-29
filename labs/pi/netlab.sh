#!/usr/bin/env bash
# Opt-in *isolated* Linux namespace / NAT / netem test lab.
# Does not change physical interfaces, host routing, root firewall or SSH.
set -euo pipefail

names=(lmx-a lmx-b lmx-ra lmx-rb lmx-wan)
usage() {
  cat <<'HELP'
Usage: sudo bash labs/pi/netlab.sh create|status|profile clean|profile typical|profile severe|destroy
WARNING: create/destroy require network namespace privileges; review before execution.
The lab creates five lmx-* namespaces. It does not run peer processes.
Stop processes inside lab namespaces before destroy.
HELP
}
need_root() { [[ $EUID -eq 0 ]] || { echo 'Requires approved sudo/root for namespace operations' >&2; exit 1; }; }
need_deps() {
  for x in ip nft tc sysctl; do
    command -v "$x" >/dev/null 2>&1 || { echo "Missing command: $x" >&2; exit 1; }
  done
}
exists() { ip netns list | awk '{print $1}' | grep -Fxq "$1"; }
all_exist() {
  local n
  for n in "${names[@]}"; do exists "$n" || return 1; done
}
check_no_pids() {
  local n p
  for n in "${names[@]}"; do
    if exists "$n"; then
      p=$(ip netns pids "$n" || true)
      [[ -z "$p" ]] || { echo "Refusing to delete $n; active PIDs: $p" >&2; return 1; }
    fi
  done
}
remove_owned() {
  local n
  check_no_pids
  for n in "${names[@]}"; do exists "$n" && ip netns del "$n"; done
}
# A veth endpoint is created briefly in root WITHOUT an address, then moved to a namespace.
connect_pair() {
  local left="$1" la="$2" lname="$3" right="$4" ra="$5" rname="$6"
  ip link add "$left" type veth peer name "$right"
  ip link set "$left" netns "$la"
  ip link set "$right" netns "$ra"
  ip -n "$la" link set "$left" name "$lname"
  ip -n "$ra" link set "$right" name "$rname"
}
set_up() {
  local n="$1" d="$2" address="$3"
  ip -n "$n" addr add "$address" dev "$d"
  ip -n "$n" link set "$d" up
}
nat_router() {
  local n="$1"
  ip netns exec "$n" sysctl -q -w net.ipv4.ip_forward=1
  ip netns exec "$n" nft 'add table ip lm_nat'
  ip netns exec "$n" nft 'add chain ip lm_nat postrouting { type nat hook postrouting priority srcnat; policy accept; }'
  ip netns exec "$n" nft 'add rule ip lm_nat postrouting oifname "outside0" masquerade'
  ip netns exec "$n" nft 'add table inet lm_filter'
  ip netns exec "$n" nft 'add chain inet lm_filter forward { type filter hook forward priority filter; policy drop; }'
  ip netns exec "$n" nft 'add rule inet lm_filter forward ct state established,related accept'
  ip netns exec "$n" nft 'add rule inet lm_filter forward iifname "inside0" oifname "outside0" accept'
}
create_lab() {
  local n
  for n in "${names[@]}"; do
    exists "$n" && { echo "Already exists: $n (refusing to touch existing lab)" >&2; exit 1; }
  done
  # Safe rollback applies only to our previously absent namespaces.
  trap 'echo "Setup failed: reverting owned lab namespaces" >&2; remove_owned' ERR
  for n in "${names[@]}"; do ip netns add "$n"; ip -n "$n" link set lo up; done
  connect_pair lmx_a0 lmx-a eth0 lmx_ra0 lmx-ra inside0
  connect_pair lmx_b0 lmx-b eth0 lmx_rb0 lmx-rb inside0
  connect_pair lmx_ra1 lmx-ra outside0 lmx_wa0 lmx-wan wan-a
  connect_pair lmx_rb1 lmx-rb outside0 lmx_wb0 lmx-wan wan-b
  set_up lmx-a eth0 10.77.1.2/24
  set_up lmx-ra inside0 10.77.1.1/24
  set_up lmx-ra outside0 198.18.10.2/30
  set_up lmx-wan wan-a 198.18.10.1/30
  set_up lmx-b eth0 10.77.2.2/24
  set_up lmx-rb inside0 10.77.2.1/24
  set_up lmx-rb outside0 198.18.20.2/30
  set_up lmx-wan wan-b 198.18.20.1/30
  ip -n lmx-a route add default via 10.77.1.1
  ip -n lmx-b route add default via 10.77.2.1
  ip -n lmx-ra route add default via 198.18.10.1
  ip -n lmx-rb route add default via 198.18.20.1
  ip netns exec lmx-wan sysctl -q -w net.ipv4.ip_forward=1
  nat_router lmx-ra
  nat_router lmx-rb
  trap - ERR
  echo 'Lab created. Run status/profile, launch only opted-in headless test peers, then destroy.'
}
profile_lab() {
  local name="${1:-}"
  all_exist || { echo 'Incomplete lab; use status, inspect, and destroy safely' >&2; exit 1; }
  local device
  case "$name" in
    clean)
      for device in wan-a wan-b; do
        ip netns exec lmx-wan tc qdisc del dev "$device" root 2>/dev/null || true
      done ;;
    typical)
      for device in wan-a wan-b; do
        ip netns exec lmx-wan tc qdisc replace dev "$device" root netem delay 40ms 10ms loss 1%
      done ;;
    severe)
      for device in wan-a wan-b; do
        ip netns exec lmx-wan tc qdisc replace dev "$device" root netem delay 180ms 50ms loss 7%
      done ;;
    *) echo 'Valid profiles: clean | typical | severe' >&2; exit 2 ;;
  esac
  echo "Applied $name to isolated transit egress only (each direction one leg)."
}
status_lab() {
  local n
  echo 'Managed namespaces:'
  for n in "${names[@]}"; do
    if exists "$n"; then
      echo "[$n]"
      ip -n "$n" -br addr show
      ip -n "$n" route show
      echo 'PIDs:'; ip netns pids "$n" || true
    else echo "[$n missing]"; fi
  done
  if exists lmx-wan; then
    for n in wan-a wan-b; do ip netns exec lmx-wan tc qdisc show dev "$n"; done
  fi
}
main() {
  [[ $# -gt 0 ]] || { usage; exit 2; }
  [[ "$1" == help || "$1" == --help || "$1" == -h ]] && { usage; exit 0; }
  need_root
  need_deps
  case "$1" in
    create) [[ $# -eq 1 ]] || { usage; exit 2; }; create_lab ;;
    status) [[ $# -eq 1 ]] || { usage; exit 2; }; status_lab ;;
    profile) [[ $# -eq 2 ]] || { usage; exit 2; }; profile_lab "$2" ;;
    destroy) [[ $# -eq 1 ]] || { usage; exit 2; }; remove_owned; echo 'Lab namespaces removed.' ;;
    *) usage; exit 2 ;;
  esac
}
main "$@"
