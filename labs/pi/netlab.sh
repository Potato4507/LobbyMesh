#!/usr/bin/env bash
# Opt-in *isolated* Linux namespace / NAT / netem test lab.
# Does not change physical interfaces, host routing, root firewall or SSH.
set -Eeuo pipefail

names=(lmx-a lmx-b lmx-ra lmx-rb lmx-wan)
marker=lobbymesh-netlab-v1
created=()
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
  for x in ip nft tc sysctl flock; do
    command -v "$x" >/dev/null 2>&1 || { echo "Missing command: $x" >&2; exit 1; }
  done
}
exists() {
  local listing
  listing=$(ip netns list) || { echo 'Cannot list namespaces; stopping' >&2; exit 1; }
  awk '{print $1}' <<<"$listing" | grep -Fxq "$1"
}
all_exist() {
  local n
  for n in "${names[@]}"; do exists "$n" || return 1; done
}
owned() {
  ip -n "$1" -j link show dev lo | grep -Eq '"ifalias":[[:space:]]*"lobbymesh-netlab-v1"'
}
check_owned() {
  local n
  for n in "${names[@]}"; do
    if exists "$n" && ! owned "$n"; then
      echo "Refusing unmarked namespace: $n" >&2
      return 1
    fi
  done
  return 0
}
check_no_pids() {
  local n p
  for n in "${names[@]}"; do
    if exists "$n"; then
      p=$(ip netns pids "$n") || { echo "Cannot inspect namespace processes: $n" >&2; return 1; }
      [[ -z "$p" ]] || { echo "Refusing to delete $n; active PIDs: $p" >&2; return 1; }
    fi
  done
  return 0
}
remove_owned() {
  local n
  check_owned || return 1
  check_no_pids || return 1
  for n in "${names[@]}"; do
    if exists "$n"; then ip netns del "$n" || return 1; fi
  done
  return 0
}
# Create both endpoints directly in namespaces, never in root networking.
connect_pair() {
  local la="$1" lname="$2" ra="$3" rname="$4"
  ip -n "$la" link add "$lname" type veth peer name "$rname" netns "$ra"
}
rollback_creation() {
  local code="$1" n p
  trap - ERR
  echo 'Setup failed: inspecting only namespaces created by this invocation' >&2
  for n in "${created[@]}"; do
    p=$(ip netns pids "$n") || exit "$code"
    [[ -z "$p" ]] || { echo "Retaining active namespace: $n" >&2; exit "$code"; }
  done
  for n in "${created[@]}"; do ip netns del "$n" || exit "$code"; done
  exit "$code"
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
  trap 'rollback_creation "$?"' ERR
  created=()
  for n in "${names[@]}"; do
    ip netns add "$n"
    created+=("$n")
    ip -n "$n" link set lo alias "$marker"
    ip -n "$n" link set lo up
  done
  connect_pair lmx-a eth0 lmx-ra inside0
  connect_pair lmx-b eth0 lmx-rb inside0
  connect_pair lmx-ra outside0 lmx-wan wan-a
  connect_pair lmx-rb outside0 lmx-wan wan-b
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
  check_owned || return 1
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
  # /run is root-owned on supported Linux. Serialize cooperating invocations.
  # Do not unlink the lock file: that would allow two different locked inodes.
  exec 9>/run/lobbymesh-netlab.lock
  flock -n 9 || { echo 'Another lab operation holds the lock' >&2; exit 1; }
  case "$1" in
    create) [[ $# -eq 1 ]] || { usage; exit 2; }; create_lab ;;
    status) [[ $# -eq 1 ]] || { usage; exit 2; }; status_lab ;;
    profile) [[ $# -eq 2 ]] || { usage; exit 2; }; profile_lab "$2" ;;
    destroy) [[ $# -eq 1 ]] || { usage; exit 2; }; remove_owned; echo 'Lab namespaces removed.' ;;
    *) usage; exit 2 ;;
  esac
}
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
