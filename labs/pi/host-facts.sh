#!/usr/bin/env bash
# Read-only host capability summary: no IP/SSH identifiers or credentials.
set -euo pipefail
printf 'Kernel: '; uname -sr
printf 'Architecture: '; uname -m
if [[ -r /etc/os-release ]]; then
  # shellcheck source=/dev/null
  . /etc/os-release
  printf 'OS: %s\n' "${PRETTY_NAME:-unknown}"
fi
if [[ -r /proc/device-tree/model ]]; then
  printf 'Model: '; tr -d '\0' </proc/device-tree/model; printf '\n'
fi
if [[ -r /proc/meminfo ]]; then
  awk '/^MemTotal:/ {printf "Memory: %.0f MiB\n", $2/1024; exit}' /proc/meminfo
fi
for cmd in ip nft tc node pnpm; do
  if command -v "$cmd" >/dev/null 2>&1; then
    if [[ "$cmd" == node || "$cmd" == pnpm ]]; then
      printf '%s: ' "$cmd"; "$cmd" --version
    else
      printf '%s: present\n' "$cmd"
    fi
  else
    printf '%s: missing\n' "$cmd"
  fi
done
printf 'Net namespaces supported: '
if [[ -e /proc/self/ns/net ]]; then echo yes; else echo no; fi
