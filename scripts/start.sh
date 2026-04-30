#!/bin/bash
# Start the OB2 platform.
#
# Options:
#   --with-postgres   Also start the Docker pgvector database
#   --backend sqlite  Force SQLite backend (default)
#   --backend pgvector  Force pgvector backend (requires --with-postgres or existing DB)
#
# Usage:
#   scripts/start.sh                         # SQLite mode, no Docker
#   scripts/start.sh --with-postgres         # pgvector mode with Docker DB
#   scripts/start.sh --backend pgvector      # pgvector mode, assume DB already running

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SERVER_DIR="$PROJECT_DIR/server"
ENV_FILE="$PROJECT_DIR/.env"
DENO="$HOME/.deno/bin/deno"
PID_FILE="$PROJECT_DIR/.ob2.pid"

if [ -f "$PID_FILE" ]; then
  OLD_PID=$(cat "$PID_FILE")
  if kill -0 "$OLD_PID" 2>/dev/null; then
    echo "OB2 is already running (PID $OLD_PID). Use scripts/stop.sh first."
    exit 1
  fi
  rm -f "$PID_FILE"
fi

# Parse args
WITH_POSTGRES=false
BACKEND=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --with-postgres) WITH_POSTGRES=true; shift ;;
    --backend) BACKEND="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 2 ;;
  esac
done

# Load .env
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found. Copy .env.example and configure."
  exit 1
fi

set -a
# shellcheck disable=SC1090
source <(grep -v '^#' "$ENV_FILE" | grep -v '^\s*$')
set +a

# Override backend if specified
if [ -n "$BACKEND" ]; then
  export OB2_STORAGE_BACKEND="$BACKEND"
fi

# Resolve absolute SQLite path to avoid the relative-path bug
if [ "$OB2_STORAGE_BACKEND" = "sqlite" ]; then
  case "$OB2_SQLITE_PATH" in
    /*) ;; # already absolute
    *) export OB2_SQLITE_PATH="$SERVER_DIR/$OB2_SQLITE_PATH" ;;
  esac
fi

# Start Docker if needed
if $WITH_POSTGRES; then
  echo "Starting Docker pgvector database..."
  docker compose -f "$PROJECT_DIR/docker/docker-compose.yml" up -d
  echo "Waiting for Postgres to be healthy..."
  until docker exec ob2-postgres pg_isready -U ob2 -d ob2 >/dev/null 2>&1; do
    sleep 1
  done
  echo "Postgres ready."
  export OB2_PG_URL="postgres://ob2:${OB2_PG_PASSWORD:-ob2secret}@127.0.0.1:${OB2_PG_PORT:-5433}/ob2"
  # Default to two-tier if backend not explicitly set to pgvector
  if [ "$OB2_STORAGE_BACKEND" = "sqlite" ]; then
    export OB2_STORAGE_BACKEND=two-tier
  fi
fi

echo "Starting OB2 server..."
echo "  backend:   $OB2_STORAGE_BACKEND"
echo "  port:      ${OB2_PORT:-7600}"
if [ "$OB2_STORAGE_BACKEND" = "sqlite" ]; then
  echo "  sqlite:    $OB2_SQLITE_PATH"
elif [ "$OB2_STORAGE_BACKEND" = "pgvector" ]; then
  echo "  pg:        ${OB2_PG_URL%%@*}@..."
fi

cd "$SERVER_DIR"
"$DENO" task start > "$PROJECT_DIR/logs/server.log" 2>&1 &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"

# Wait for health
for i in $(seq 1 30); do
  if curl -s "http://${OB2_HOST:-127.0.0.1}:${OB2_PORT:-7600}/health" | grep -q '"sidecar":true'; then
    echo "OB2 running (PID $SERVER_PID)"
    echo "  health:  http://${OB2_HOST:-127.0.0.1}:${OB2_PORT:-7600}/health"
    echo "  MCP:     http://${OB2_HOST:-127.0.0.1}:${OB2_PORT:-7600}/mcp"
    echo "  gateway: http://${OB2_HOST:-127.0.0.1}:${OB2_PORT:-7600}/v1"
    echo "  admin:   http://${OB2_HOST:-127.0.0.1}:${OB2_PORT:-7600}/admin"
    echo "  logs:    $PROJECT_DIR/logs/server.log"
    exit 0
  fi
  sleep 1
done

echo "ERROR: OB2 failed to start within 30s. Check logs/server.log"
cat "$PROJECT_DIR/logs/server.log" | tail -20
kill "$SERVER_PID" 2>/dev/null
rm -f "$PID_FILE"
exit 1
