#!/bin/bash
# Stop the OB2 Docker stack.
#
# Usage:
#   scripts/docker-stop.sh              # stop default services
#   scripts/docker-stop.sh --with-chat  # also stop ob2-openwebui (profile: openwebui)
#
# The --with-chat flag is only required when ob2-openwebui is running; it
# activates the "openwebui" profile so `docker compose down` actually tears
# that container down. Running a plain stop with --with-chat missing leaves
# ob2-openwebui orphaned and holding the default network.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE="$PROJECT_DIR/docker/docker-compose.yml"
ENV_FILE="$PROJECT_DIR/.env"

WITH_CHAT=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-chat) WITH_CHAT=true; shift ;;
    *) echo "Unknown arg: $1"; echo "Usage: $0 [--with-chat]"; exit 2 ;;
  esac
done

COMPOSE_ARGS=(-f "$COMPOSE")
[ -f "$ENV_FILE" ] && COMPOSE_ARGS+=(--env-file "$ENV_FILE")
if $WITH_CHAT; then
  COMPOSE_ARGS+=(--profile openwebui)
fi

docker compose "${COMPOSE_ARGS[@]}" down
echo "OB2 platform stopped${WITH_CHAT:+ (including chat)}."
