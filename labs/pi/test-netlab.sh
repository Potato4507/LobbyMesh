#!/usr/bin/env bash
# Unprivileged command-model tests: all ip calls are shell mocks, never OS ops.
set -euo pipefail
cd "$(dirname "$0")/../.."
source labs/pi/netlab.sh
declare -A mock_ns=() mock_owned=() mock_pids=()
mock_fail_list=0 mock_fail_pids=0 mock_fail_veth=0 root_mutations=0 deleted=0
ip() {
  case "$1 $2" in
    'netns list')
      [[ $mock_fail_list -eq 0 ]] || return 1
      local n
      for n in "${!mock_ns[@]}"; do printf '%s\n' "$n"; done ;;
    'netns add') mock_ns["$3"]=1 ;;
    'netns del') unset 'mock_ns[$3]' 'mock_owned[$3]'; deleted=$((deleted+1)) ;;
    'netns pids')
      [[ $mock_fail_pids -eq 0 ]] || return 1
      [[ -z ${mock_pids[$3]:-} ]] || echo "${mock_pids[$3]}" ;;
    'netns exec') return 0 ;;
    '-n '*)
      if [[ "$3 $4 $5 $6" == '-j link show dev' ]]; then
        if [[ ${mock_owned[$2]:-} == 1 ]]; then echo '[{"ifalias":"lobbymesh-netlab-v1"}]'; else echo '[{}]'; fi
      elif [[ "$3 $4 $5 $6" == 'link set lo alias' ]]; then
        mock_owned["$2"]=1
      elif [[ "$3 $4" == 'link add' && $mock_fail_veth -eq 1 ]]; then return 1
      fi ;;
    *) root_mutations=$((root_mutations+1)); return 99 ;;
  esac
}
case "${1:-all}" in
  empty)
    remove_owned; remove_owned
    [[ $deleted -eq 0 ]] ;;
  unmarked)
    mock_ns[lmx-a]=1 mock_owned[lmx-a]=1 mock_ns[lmx-b]=1
    if remove_owned; then exit 1; fi
    [[ $deleted -eq 0 && ${mock_ns[lmx-a]} == 1 ]] ;;
  list-failure)
    mock_ns[lmx-a]=1 mock_owned[lmx-a]=1 mock_fail_list=1
    trap 'if [[ $deleted -eq 0 && ${mock_ns[lmx-a]} == 1 ]]; then exit 42; else exit 43; fi' EXIT
    remove_owned
    exit 44 ;;
  active)
    mock_ns[lmx-a]=1 mock_owned[lmx-a]=1 mock_pids[lmx-a]=123
    if remove_owned; then exit 1; fi
    [[ $deleted -eq 0 ]] ;;
  unreadable)
    mock_ns[lmx-a]=1 mock_owned[lmx-a]=1 mock_fail_pids=1
    if remove_owned; then exit 1; fi
    [[ $deleted -eq 0 ]] ;;
  create)
    create_lab
    [[ ${#mock_ns[@]} -eq 5 && $root_mutations -eq 0 ]]
    remove_owned; remove_owned
    [[ ${#mock_ns[@]} -eq 0 && $deleted -eq 5 ]] ;;
  collision)
    mock_ns[lmx-a]=1
    if ( create_lab ); then exit 1; fi
    [[ $deleted -eq 0 && ${#mock_ns[@]} -eq 1 ]] ;;
  rollback)
    # Bash must retain errexit in this child; the caller expects special exit42
    # only after the EXIT assertion proves failed creation removed its five ns.
    mock_fail_veth=1 mock_ns[unrelated]=1
    trap 'if [[ ${#mock_ns[@]} -eq 1 && ${mock_ns[unrelated]:-} == 1 && $deleted -eq 5 && $root_mutations -eq 0 ]]; then exit 42; else exit 43; fi' EXIT
    create_lab
    exit 44 ;;
  all)
    for scenario in empty unmarked active unreadable create collision; do
      "$BASH" "$0" "$scenario"
    done
    for scenario in rollback list-failure; do
      code=0
      "$BASH" "$0" "$scenario" || code=$?
      [[ $code -eq 42 ]]
    done
    echo 'NETLAB_MODEL_PASSED: 8 cases; no real namespaces or privileges used' ;;
  *) exit 2 ;;
esac
