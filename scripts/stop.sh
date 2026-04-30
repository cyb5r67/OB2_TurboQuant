#!/bin/bash
# Stop the OB2 platform.
#
# Stops the Deno server + Python sidecar, and optionally the Docker database.
#
# Options:
#   --with-postgres   Also stop the Docker pgvector database
#
# Usage:
#   scripts/stop.sh                  # stop server only
#   scripts/stop.sh --with-postgres  # stop server + Docker DB

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PID_FILE="$PROJECT_DIR/.ob2.pid"

WITH_POSTGRES=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --with-postgres) WITH_POSTGRES=true; shift ;;
    *) echo "Unknown arg: $1"; exit 2 ;;
  esac
done

if [ -f "$PID_FILE" ]; then
  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "Stopping OB2 server (PID $PID)..."
    kill "$PID"
    wait "$PID" 2>/dev/null || true
    echo "Server stopped."
  else
    echo "PID $PID not running (stale pidfile)."
  fi
  rm -f "$PID_FILE"
else
  echo "No .ob2.pid found — server may not be running."
fi

if $WITH_POSTGRES; then
  echo "Stopping Docker pgvector database..."
  docker compose -f "$PROJECT_DIR/docker/docker-compose.yml" down
  echo "Docker stopped."
fi
