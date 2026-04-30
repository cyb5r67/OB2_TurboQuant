#!/bin/bash
# Restart the OB2 Docker stack. Thin wrapper that passes all args through
# to docker-stop.sh and docker-start.sh.
#
# Usage:
#   scripts/docker-restart.sh                       # restart default services
#   scripts/docker-restart.sh --with-chat           # + Open WebUI
#   scripts/docker-restart.sh --with-chat --build   # force rebuild
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Split --build off — stop doesn't accept it.
BUILD_ARG=()
STOP_ARGS=()
START_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --build) BUILD_ARG=("--build") ;;
    *) STOP_ARGS+=("$arg"); START_ARGS+=("$arg") ;;
  esac
done

"$SCRIPT_DIR/docker-stop.sh" "${STOP_ARGS[@]}"
sleep 1
"$SCRIPT_DIR/docker-start.sh" "${START_ARGS[@]}" "${BUILD_ARG[@]}"
