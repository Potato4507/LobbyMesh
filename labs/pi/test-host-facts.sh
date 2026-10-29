#!/usr/bin/env bash
# Unprivileged command model: no package manager or network tool is executed.
set -euo pipefail
facts="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/host-facts.sh"
uname() { if [[ "$1" == -sr ]]; then echo 'Linux 6.12.0'; else echo aarch64; fi; }
node() {
  [[ "$COREPACK_ENABLE_NETWORK" == 0 && "$COREPACK_ENABLE_AUTO_PIN" == 0 &&
    "$COREPACK_DEFAULT_TO_LATEST" == 0 && "$COREPACK_ENABLE_DOWNLOAD_PROMPT" == 0 &&
    "$COREPACK_ENV_FILE" == 0 && "$COREPACK_ENABLE_PROJECT_SPEC" == 0 ]] || return 99
  if [[ "${TEST_TOOL_FAIL:-0}" == 1 ]]; then printf 'private version failure\n' >&2; return 1; fi
  echo v24.22.1
}
pnpm() { node >/dev/null || return $?; echo 11.25.0; }
success=$(source "$facts")
[[ "$success" == *$'\nnode: v24.22.1\n'* && "$success" == *$'\npnpm: 11.25.0\n'* ]] || { echo 'FACTS_MODEL_VERSION_GUARD_FAILED' >&2; exit 1; }
failure=$(TEST_TOOL_FAIL=1 source "$facts")
[[ "$failure" == *$'\nnode: missing\n'* && "$failure" == *$'\npnpm: missing\n'* && "$failure" != *private* ]] || { echo 'FACTS_MODEL_OFFLINE_FAILURE_NOT_REDACTED' >&2; exit 1; }
echo 'HOST_FACTS_MODEL_PASSED: 2 cases; no package manager, network or privileges used'
