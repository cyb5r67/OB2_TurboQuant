#!/bin/bash
# Start the full OB2 platform via Docker Compose.
#
# Default services:
#   - ob2-server:   Deno + Python sidecar (port 7600)
#   - ob2-postgres: pgvector database    (port 5433)
#   - ob2-pgadmin:  Database admin       (port 5051)
#
# Optional (--with-chat / --with-llamacpp):
#   - ob2-openwebui:  Open WebUI chat surface, reached through ob2-server's
#                     reverse proxy on port 7601.
#   - ob2-llamacpp:   llama.cpp / turboquant_plus manager + llama-server.
#
# Usage:
#   scripts/docker-start.sh                      # default services
#   scripts/docker-start.sh --with-chat          # + Open WebUI
#   scripts/docker-start.sh --with-chat --build  # force rebuild of ob2-server
#
# Endpoints after start:
#   http://localhost:7600/health     — liveness
#   http://localhost:7600/dashboard  — web admin
#   http://localhost:7600/mcp        — MCP tools
#   http://localhost:7600/v1         — OpenAI gateway
#   http://localhost:7601            — Open WebUI (if --with-chat)
#   http://localhost:5051            — pgAdmin

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE="$PROJECT_DIR/docker/docker-compose.yml"
ENV_FILE="$PROJECT_DIR/.env"

WITH_CHAT=false
WITH_LLAMACPP=false
BUILD_FLAG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-chat) WITH_CHAT=true; shift ;;
    --with-llamacpp) WITH_LLAMACPP=true; shift ;;
    --build) BUILD_FLAG="--build"; shift ;;
    *) echo "Unknown arg: $1"; echo "Usage: $0 [--with-chat] [--with-llamacpp] [--build]"; exit 2 ;;
  esac
done

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found. Copy .env.example and configure."
  exit 1
fi

# Auto-generate the manager token if --with-llamacpp is set and the env doesn't already have one.
if $WITH_LLAMACPP; then
  if ! grep -q "^OB2_LLAMACPP_MANAGER_TOKEN=" "$ENV_FILE" || \
     [ -z "$(grep "^OB2_LLAMACPP_MANAGER_TOKEN=" "$ENV_FILE" | cut -d= -f2-)" ]; then
    TOKEN=$(openssl rand -hex 32)
    sed -i.bak '/^OB2_LLAMACPP_MANAGER_TOKEN=/d' "$ENV_FILE"
    echo "OB2_LLAMACPP_MANAGER_TOKEN=$TOKEN" >> "$ENV_FILE"
    rm -f "$ENV_FILE.bak"
    echo "Generated OB2_LLAMACPP_MANAGER_TOKEN in .env"
  fi
  # Set OB2_LLM_PROVIDER=llamacpp if not already set.
  if ! grep -q "^OB2_LLM_PROVIDER=llamacpp" "$ENV_FILE"; then
    sed -i.bak '/^OB2_LLM_PROVIDER=/d' "$ENV_FILE"
    echo "OB2_LLM_PROVIDER=llamacpp" >> "$ENV_FILE"
    rm -f "$ENV_FILE.bak"
    echo "Set OB2_LLM_PROVIDER=llamacpp in .env"
  fi
fi

COMPOSE_ARGS=(-f "$COMPOSE" --env-file "$ENV_FILE")
if $WITH_CHAT; then
  COMPOSE_ARGS+=(--profile openwebui)
fi
if $WITH_LLAMACPP; then
  COMPOSE_ARGS+=(--profile llamacpp)
fi

echo "Starting OB2 platform via Docker${WITH_CHAT:+ (with chat)}..."
docker compose "${COMPOSE_ARGS[@]}" up -d $BUILD_FLAG

echo
echo "Waiting for OB2 server to be healthy..."
for i in $(seq 1 60); do
  if curl -sf http://localhost:7600/health >/dev/null 2>&1; then
    # ob2-server is healthy. If --with-chat, ob2-openwebui was blocked on this
    # health condition and never started in the initial `up -d`. Re-run compose
    # now so Docker can satisfy the dependency and launch it.
    if $WITH_CHAT; then
      echo "OB2 server ready. Starting Open WebUI..."
      docker compose "${COMPOSE_ARGS[@]}" up -d >/dev/null 2>&1
      echo "Waiting for Open WebUI to be healthy..."
      for j in $(seq 1 60); do
        STATUS=$(docker inspect -f '{{.State.Health.Status}}' ob2-openwebui 2>/dev/null || true)
        [ "$STATUS" = "healthy" ] && break
        sleep 2
      done
      STATUS=$(docker inspect -f '{{.State.Health.Status}}' ob2-openwebui 2>/dev/null || true)
      if [ "$STATUS" != "healthy" ]; then
        echo "WARNING: Open WebUI did not become healthy within 120s."
        echo "Check logs: docker compose -f docker/docker-compose.yml logs ob2-openwebui"
      fi
    fi
    echo "OB2 ready!"
    echo
    echo "  Health:     http://localhost:7600/health"
    echo "  Dashboard:  http://localhost:7600/dashboard"
    echo "  MCP:        http://localhost:7600/mcp"
    echo "  Gateway:    http://localhost:7600/v1"
    if $WITH_CHAT; then
      echo "  Chat:       http://localhost:7601  (or click Chat in the dashboard)"
    fi
    if $WITH_LLAMACPP; then
      echo "  llama.cpp:  internal — manager on ob2-llamacpp:8081, chat on ob2-llamacpp:8080"
    fi
    echo "  pgAdmin:    http://localhost:5051"
    echo
    echo "  Logs:       docker compose -f docker/docker-compose.yml logs -f ob2-server"
    echo "  Stop:       scripts/docker-stop.sh${WITH_CHAT:+ --with-chat}${WITH_LLAMACPP:+ --with-llamacpp}"
    exit 0
  fi
  sleep 2
done

echo "ERROR: OB2 did not become healthy within 120s."
echo "Check logs: docker compose -f docker/docker-compose.yml logs ob2-server"
exit 1
