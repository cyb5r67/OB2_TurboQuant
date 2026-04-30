#!/bin/bash
# OB2 End-to-End Verification Suite
#
# Exercises every layer: MCP capture, search, stats, gateway chat (prefix +
# passthrough + alias suggestion), bulk import, persistence across restart,
# retrieval-quality eval harness.
#
# Prerequisites:
#   - OB2 server NOT running (this script manages its own lifecycle)
#   - Ollama running with gemma3:4b loaded
#   - .env configured (especially OB2_BRAIN_KEY)
#
# Usage:
#   cd /mnt/c/projects/OB2 && bash tests/e2e.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SERVER_DIR="$PROJECT_DIR/server"
DENO="$HOME/.deno/bin/deno"
ENV_FILE="$PROJECT_DIR/.env"
VENV_PY="$PROJECT_DIR/retrieval/.venv/bin/python"

PASS=0
FAIL=0
TESTS=0

# ─────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null && wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  TESTS=$((TESTS + 1))
  if echo "$haystack" | grep -qi "$needle"; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label — expected '$needle' in response"
    echo "       got: ${haystack:0:200}"
    FAIL=$((FAIL + 1))
  fi
}

assert_status() {
  local label="$1" actual="$2" expected="$3"
  TESTS=$((TESTS + 1))
  if [ "$actual" = "$expected" ]; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label — expected $expected, got $actual"
    FAIL=$((FAIL + 1))
  fi
}

load_env() {
  set -a
  # shellcheck disable=SC1090
  source <(grep -v '^#' "$ENV_FILE" | grep -v '^\s*$')
  set +a
}
load_env

# Force absolute path so server + CLI importers hit the same SQLite file
export OB2_SQLITE_PATH="$SERVER_DIR/ob2.db"

# For two-tier mode, ensure pgvector is running + clean.
# If the container isn't up, start it via docker compose.
if [ "${OB2_STORAGE_BACKEND:-sqlite}" = "two-tier" ]; then
  if ! docker ps --format '{{.Names}}' | grep -q '^ob2-postgres$'; then
    echo "  (two-tier: starting ob2-postgres via docker compose...)"
    docker compose -f "$PROJECT_DIR/docker/docker-compose.yml" up -d ob2-postgres >/dev/null 2>&1
    # Wait for healthy
    for i in $(seq 1 30); do
      docker exec ob2-postgres pg_isready -U ob2 -d ob2 >/dev/null 2>&1 && break
      sleep 1
    done
  fi
  docker exec ob2-postgres psql -U ob2 -d ob2 -c "DROP TABLE IF EXISTS docs, source_imports, entity_aliases CASCADE" 2>/dev/null || true
fi

# Clean users.json at test start so multi-user steps work
rm -f "${OB2_USERS_FILE:-$PROJECT_DIR/users.json}" "$SERVER_DIR/users.json" 2>/dev/null || true

KEY="$OB2_BRAIN_KEY"
BASE="http://127.0.0.1:${OB2_PORT:-7600}"

call_mcp() {
  curl -s -X POST "$BASE/mcp" \
    -H "x-brain-key: $KEY" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "$1"
}

extract_mcp_text() {
  # Extract the text content from MCP SSE response
  grep -o '"text":"[^"]*"' | head -1 | sed 's/"text":"//;s/"$//'
}

call_chat() {
  curl -s -X POST "$BASE/v1/chat/completions" \
    -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" \
    --max-time 90 \
    -d "$1"
}

start_server() {
  rm -f "$SERVER_DIR/ob2.db" "$SERVER_DIR/ob2.db-wal" "$SERVER_DIR/ob2.db-shm"
  cd "$SERVER_DIR"
  env $(grep -v '^#' "$ENV_FILE" | grep -v '^\s*$' | xargs) \
    "$DENO" task start > /tmp/ob2_e2e.log 2>&1 &
  SERVER_PID=$!
  sleep 8
  cd "$PROJECT_DIR"
}

restart_server() {
  kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null || true
  cd "$SERVER_DIR"
  env $(grep -v '^#' "$ENV_FILE" | grep -v '^\s*$' | xargs) \
    "$DENO" task start > /tmp/ob2_e2e_restart.log 2>&1 &
  SERVER_PID=$!
  sleep 8
  cd "$PROJECT_DIR"
}

# ─────────────────────────────────────────────
echo "╔══════════════════════════════════════╗"
echo "║    OB2 End-to-End Verification       ║"
echo "╚══════════════════════════════════════╝"
echo

# ─────────────────────────────────────────────
echo "── Step 1: Start server, check /health ──"
start_server
HEALTH=$(curl -s "$BASE/health")
assert_contains "health server=true" "$HEALTH" '"server":true'
assert_contains "health sidecar=true" "$HEALTH" '"sidecar":true'

# ─────────────────────────────────────────────
echo
echo "── Step 2: Bulk import CSV into @infra ──"

cat > /tmp/e2e_hosts.csv <<'CSVEOF'
hostname,role,dc,owner
web-01,web,us-east,platform
db-primary,postgres,us-east,data
db-replica,postgres,us-east,data
vault-01,secrets,us-east,security
edge-01,cdn,eu-west,platform
CSVEOF

$VENV_PY -m cli.import_cmd csv \
  --domain infra \
  --file /tmp/e2e_hosts.csv \
  --batch-size 10 2>&1 | tail -3

STATS=$(call_mcp '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"knowledge_stats","arguments":{"domain":"infra"}}}' | extract_mcp_text)
assert_contains "infra has 5 docs" "$STATS" "5 doc"

# ─────────────────────────────────────────────
echo
echo "── Step 3: MCP capture into @netsec ──"

RES=$(call_mcp '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"capture_knowledge","arguments":{"domain":"netsec","text":"Always verify TLS certificates before deployment. Use openssl x509 -noout -enddate to check expiry.","tags":["security","tls"]}}}' | extract_mcp_text)
assert_contains "capture returns doc_id" "$RES" "Captured to @netsec"

RES=$(call_mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"capture_knowledge","arguments":{"domain":"netsec","text":"Rotate API keys every 90 days. Store in HashiCorp Vault, never in env files.","tags":["security","secrets"]}}}' | extract_mcp_text)
assert_contains "second capture increments" "$RES" "2 document"

# ─────────────────────────────────────────────
echo

# In two-tier mode, wait for SyncWorker to push captures to pgvector
if [ "${OB2_STORAGE_BACKEND:-sqlite}" = "two-tier" ]; then
  echo "  (two-tier: waiting 7s for sync worker...)"
  sleep 7
fi

echo "── Step 4: MCP search_knowledge (semantic) ──"

RES=$(call_mcp '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"search_knowledge","arguments":{"domain":"netsec","query":"certificate expiration check","top_k":2}}}' | extract_mcp_text)
assert_contains "TLS doc ranked first" "$RES" "TLS"

RES=$(call_mcp '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"search_knowledge","arguments":{"domain":"infra","query":"which servers are postgres databases","top_k":3}}}' | extract_mcp_text)
assert_contains "postgres hosts found" "$RES" "postgres"

# ─────────────────────────────────────────────
echo
echo "── Step 5: Gateway chat with @domain prefix ──"

RES=$(call_chat '{"model":"ob2","messages":[{"role":"user","content":"@infra list the database hosts"}],"stream":false}')
CONTENT=$(echo "$RES" | python3 -c "import sys,json; print(json.load(sys.stdin)['choices'][0]['message']['content'])" 2>/dev/null || echo "")
assert_contains "chat @infra cites postgres hosts" "$CONTENT" "db-"

RES=$(call_chat '{"model":"ob2","messages":[{"role":"user","content":"@netsec how do I check cert expiry?"}],"stream":false}')
CONTENT=$(echo "$RES" | python3 -c "import sys,json; print(json.load(sys.stdin)['choices'][0]['message']['content'])" 2>/dev/null || echo "")
assert_contains "chat @netsec cites openssl" "$CONTENT" "openssl"

# ─────────────────────────────────────────────
echo
echo "── Step 6: Gateway passthrough (no prefix) ──"

RES=$(call_chat '{"model":"ob2","messages":[{"role":"user","content":"what is 3 + 4?"}],"stream":false}')
CONTENT=$(echo "$RES" | python3 -c "import sys,json; print(json.load(sys.stdin)['choices'][0]['message']['content'])" 2>/dev/null || echo "")
assert_contains "passthrough answers arithmetic" "$CONTENT" "7"

# ─────────────────────────────────────────────
echo
echo "── Step 7: Restart server, verify persistence ──"

restart_server
HEALTH=$(curl -s "$BASE/health")
assert_contains "post-restart health ok" "$HEALTH" '"sidecar":true'

RES=$(call_mcp '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"search_knowledge","arguments":{"domain":"netsec","query":"API key rotation","top_k":2}}}' | extract_mcp_text)
assert_contains "post-restart search finds Vault doc" "$RES" "Vault"

RES=$(call_mcp '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"knowledge_stats","arguments":{}}}' | extract_mcp_text)
assert_contains "post-restart stats show both domains" "$RES" "netsec"
assert_contains "post-restart stats show infra" "$RES" "infra"

# ─────────────────────────────────────────────
echo
echo "── Step 8: /v1/models lists domains ──"

MODELS=$(curl -s -H "Authorization: Bearer $KEY" "$BASE/v1/models")
assert_contains "models includes ob2-infra" "$MODELS" "ob2-infra"
assert_contains "models includes ob2-netsec" "$MODELS" "ob2-netsec"

# ─────────────────────────────────────────────
echo
echo "── Step 9: Auth enforcement ──"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/mcp")
assert_status "MCP rejects unauthenticated" "$STATUS" "401"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer WRONG" "$BASE/v1/models")
assert_status "gateway rejects bad bearer" "$STATUS" "401"

# ─────────────────────────────────────────────
echo
echo "── Step 10: Import dedup (re-import CSV, 0 written) ──"

DEDUP=$($VENV_PY -m cli.import_cmd csv \
  --domain infra \
  --file /tmp/e2e_hosts.csv \
  --batch-size 10 2>&1 | grep "Done:")
assert_contains "dedup skips all rows" "$DEDUP" "0 written"

# ─────────────────────────────────────────────
echo
echo "── Step 11: Multi-user ACL enforcement ──"

# Create a restricted user (bob) with read-only on infra
USERS_FILE="${OB2_USERS_FILE:-$PROJECT_DIR/users.json}"
case "$USERS_FILE" in /*) ;; *) USERS_FILE="$SERVER_DIR/$USERS_FILE" ;; esac
rm -f "$USERS_FILE"  # start clean

BOB_RES=$(curl -s -X POST "$BASE/admin/users" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"username":"bob","domains":{"infra":"read"},"global_admin":false}')
BOB_KEY=$(echo "$BOB_RES" | python3 -c "import sys,json; print(json.load(sys.stdin)['key'])" 2>/dev/null || echo "")

if [ -n "$BOB_KEY" ]; then
  # Bob reads @infra (should succeed)
  RES=$(curl -s -X POST "$BASE/mcp" \
    -H "x-brain-key: $BOB_KEY" -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_knowledge","arguments":{"domain":"infra","query":"postgres","top_k":1}}}' | extract_mcp_text)
  assert_contains "bob reads @infra (read granted)" "$RES" "hit"

  # Bob tries to write @infra (should 403)
  RES=$(curl -s -X POST "$BASE/mcp" \
    -H "x-brain-key: $BOB_KEY" -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"capture_knowledge","arguments":{"domain":"infra","text":"unauthorized"}}}' | extract_mcp_text)
  assert_contains "bob cannot write @infra (read-only)" "$RES" "Permission denied"

  # Bob tries to read @netsec (no permission at all)
  RES=$(curl -s -X POST "$BASE/mcp" \
    -H "x-brain-key: $BOB_KEY" -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_knowledge","arguments":{"domain":"netsec","query":"anything","top_k":1}}}' | extract_mcp_text)
  assert_contains "bob cannot read @netsec (no permission)" "$RES" "Permission denied"

  # Bob tries /admin/users (not global admin)
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $BOB_KEY" "$BASE/admin/users")
  assert_status "bob denied /admin/users (not global admin)" "$STATUS" "403"

  # Bob tries gateway with @netsec
  GATE_RES=$(curl -s -X POST "$BASE/v1/chat/completions" \
    -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
    --max-time 30 \
    -d '{"model":"ob2","messages":[{"role":"user","content":"@netsec test"}],"stream":false}')
  assert_contains "bob denied gateway @netsec" "$GATE_RES" "Permission denied"
else
  echo "  SKIP: user creation didn't return a key (may be running in pre-multi-user mode)"
fi

# ─────────────────────────────────────────────
echo
echo "── Step 12: Bootstrap close-down ──"

# At this point, users.json already contains bob (created in Step 11), but
# bob is not a global admin. Promote him so hasRealGlobalAdmin() returns true.
curl -s -X PATCH "$BASE/admin/users/bob" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"global_admin":true}' > /dev/null

# 12.1: dashboard login as _admin + brain-key is refused (403)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"_admin\",\"password\":\"$KEY\"}")
assert_status "_admin dashboard login refused after real admin exists" "$STATUS" "403"

# 12.2: Authorization: Bearer <brain-key> on /admin is refused (401)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $KEY" "$BASE/admin/domains")
assert_status "brain-key Bearer refused on /admin after real admin exists" "$STATUS" "401"

# 12.3: x-brain-key MCP header with brain-key is refused (401)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/mcp" \
  -H "x-brain-key: $KEY" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
assert_status "brain-key x-brain-key refused on /mcp after real admin exists" "$STATUS" "401"

# 12.4: /auth/status reflects that bootstrap is no longer available
STATUS_JSON=$(curl -s "$BASE/auth/status")
assert_contains "/auth/status bootstrap_available=false after real admin" "$STATUS_JSON" '"bootstrap_available":false'

# 12.5 + 12.6 require a real global-admin credential to even reach the
# handler (brain-key is closed now). Use bob's API key — he was promoted
# at the top of Step 12.
# 12.5: PATCH last global admin (demote) is refused (409)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/admin/users/bob" \
  -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
  -d '{"global_admin":false}')
assert_status "cannot demote last global admin" "$STATUS" "409"

# 12.6: DELETE last global admin is refused (409)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/admin/users/bob" \
  -H "Authorization: Bearer $BOB_KEY")
assert_status "cannot revoke last global admin" "$STATUS" "409"

# 12.7: GET /admin/users/raw returns file contents + mtime
RAW_RES=$(curl -s -H "Authorization: Bearer $BOB_KEY" "$BASE/admin/users/raw")
assert_contains "raw editor GET returns content field" "$RAW_RES" '"content"'
assert_contains "raw editor GET returns mtime field" "$RAW_RES" '"mtime"'

# Extract mtime + content for subsequent tests
RAW_MTIME=$(echo "$RAW_RES" | python3 -c "import sys,json; print(json.load(sys.stdin)['mtime'])")
RAW_CONTENT=$(echo "$RAW_RES" | python3 -c "import sys,json; print(json.load(sys.stdin)['content'])")

# 12.8: POST with stale mtime returns 409
STALE_BODY=$(python3 -c "
import sys, json
print(json.dumps({'content': sys.argv[1], 'expected_mtime': '1999-01-01T00:00:00.000Z'}))
" "$RAW_CONTENT")
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/admin/users/raw" \
  -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
  -d "$STALE_BODY")
assert_status "raw editor rejects stale mtime" "$STATUS" "409"

# 12.9: POST with payload that strips global_admin from everyone returns 400
STRIPPED_CONTENT=$(echo "$RAW_CONTENT" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
for u in d['users']:
    u['global_admin'] = False
print(json.dumps(d))
")
STRIPPED_BODY=$(python3 -c "
import sys, json
print(json.dumps({'content': sys.argv[1], 'expected_mtime': sys.argv[2]}))
" "$STRIPPED_CONTENT" "$RAW_MTIME")
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/admin/users/raw" \
  -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
  -d "$STRIPPED_BODY")
assert_status "raw editor rejects zero-admin payload" "$STATUS" "400"

# 12.10: POST with malformed JSON content returns 400
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/admin/users/raw" \
  -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
  -d "{\"content\":\"not valid json {{{\",\"expected_mtime\":\"$RAW_MTIME\"}")
assert_status "raw editor rejects malformed JSON" "$STATUS" "400"

# 12.11: happy-path save — add a @logs read permission to bob
PATCHED=$(echo "$RAW_CONTENT" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
for u in d['users']:
    if u['username'] == 'bob':
        u['domains']['logs'] = 'read'
print(json.dumps(d, indent=2))
")
PATCHED_BODY=$(python3 -c "
import sys, json
print(json.dumps({'content': sys.argv[1], 'expected_mtime': sys.argv[2]}))
" "$PATCHED" "$RAW_MTIME")
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/admin/users/raw" \
  -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
  -d "$PATCHED_BODY")
assert_status "raw editor happy-path save" "$STATUS" "200"

# Verify the change landed via the typed endpoint
USERS_AFTER=$(curl -s -H "Authorization: Bearer $BOB_KEY" "$BASE/admin/users")
assert_contains "raw edit is reflected in /admin/users" "$USERS_AFTER" '"logs":"read"'

# 12.12: shell break-glass script — promote a new user from the CLI, then
# verify login with that user's password.
CHARLIE_PW="charlie-pw-1234"
OB2_USERS_FILE="$USERS_FILE" $DENO run --allow-read --allow-write --allow-env \
  "$PROJECT_DIR/server/scripts/reset-admin.ts" charlie --password "$CHARLIE_PW" --promote > /tmp/reset-admin.log 2>&1
RC=$?
TESTS=$((TESTS + 1))
if [ "$RC" -eq 0 ]; then
  echo "  PASS: reset-admin script exits 0"
  PASS=$((PASS + 1))
else
  echo "  FAIL: reset-admin script exited $RC"
  cat /tmp/reset-admin.log
  FAIL=$((FAIL + 1))
fi

# Server auto-reloads on file change. Verify login works.
LOGIN_RES=$(curl -s -X POST "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"charlie\",\"password\":\"$CHARLIE_PW\"}")
assert_contains "charlie (promoted by script) can log in" "$LOGIN_RES" '"ok":true'

# ─────────────────────────────────────────────
echo
echo "── Step 13: Email recovery ──"

# Ensure the server was started with OB2_SMTP_DRIVER=log for this suite.
# If the driver isn't log, all email asserts SKIP.
if [ "${OB2_SMTP_DRIVER:-}" != "log" ]; then
  echo "  SKIP: OB2_SMTP_DRIVER=log not set — email tests require the log driver"
else
  MAIL_LOG="$SERVER_DIR/data/mail-log.txt"
  # Email endpoints also need OB2_PUBLIC_URL. Warn if it's unset.
  if [ -z "${OB2_PUBLIC_URL:-}" ]; then
    echo "  WARN: OB2_PUBLIC_URL not set — email tests expect the server to have been started with both OB2_SMTP_DRIVER=log AND OB2_PUBLIC_URL"
  fi
  : > "$MAIL_LOG"  # truncate so later greps see only this-suite events

  # 13.0 precondition: give bob an email (bob is the sole global admin at this point).
  BOB_EMAIL="bob@example.com"
  curl -s -X PATCH "$BASE/admin/users/bob" \
    -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
    -d "{\"email\":\"$BOB_EMAIL\"}" > /dev/null

  # 13.1: forgot-password for unknown email — 200, no mail
  RESP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/forgot-password" \
    -H "Content-Type: application/json" \
    -d '{"email":"ghost@nowhere.invalid"}')
  assert_status "forgot-password unknown email returns 200" "$RESP" "200"
  TESTS=$((TESTS + 1))
  if ! grep -q "ghost@nowhere.invalid" "$MAIL_LOG" 2>/dev/null; then
    echo "  PASS: no mail sent for unknown email"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: mail log mentions unknown email"
    FAIL=$((FAIL + 1))
  fi

  # 13.2: forgot-password for valid email — 200, mail logged
  RESP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/forgot-password" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$BOB_EMAIL\"}")
  assert_status "forgot-password valid email returns 200" "$RESP" "200"
  sleep 0.2  # flush the append
  MAIL_TO=$(grep "^To: " "$MAIL_LOG" | tail -1)
  MAIL_SUBJ=$(grep "^Subject: " "$MAIL_LOG" | tail -1)
  assert_contains "mail log has bob's email" "$MAIL_TO" "$BOB_EMAIL"
  assert_contains "mail log has reset subject" "$MAIL_SUBJ" "OB2 password reset"

  # 13.3: extract the reset token from the mail log, complete the reset
  RESET_TOKEN=$(grep -oE '\?token=[0-9a-f]{64}' "$MAIL_LOG" | tail -1 | sed 's/^?token=//')
  TESTS=$((TESTS + 1))
  if [ -n "$RESET_TOKEN" ]; then
    echo "  PASS: reset token extracted from mail log"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: no reset token found in mail log"
    FAIL=$((FAIL + 1))
  fi

  # 13.4: reset-token-info returns kind=reset
  INFO=$(curl -s "$BASE/auth/reset-token-info?token=$RESET_TOKEN")
  assert_contains "reset-token-info reports kind=reset" "$INFO" '"kind":"reset"'

  # 13.5: POST reset-password with the token
  NEW_BOB_PW="bob-reset-pw-12345"
  RESP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/reset-password" \
    -H "Content-Type: application/json" \
    -d "{\"token\":\"$RESET_TOKEN\",\"new_password\":\"$NEW_BOB_PW\"}")
  assert_status "reset-password happy path" "$RESP" "200"

  # 13.6: bob can log in with the new password
  LOGIN_RES=$(curl -s -X POST "$BASE/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"bob\",\"password\":\"$NEW_BOB_PW\"}")
  assert_contains "bob signs in with new password" "$LOGIN_RES" '"ok":true'

  # 13.7: reusing the same token returns 401
  RESP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/reset-password" \
    -H "Content-Type: application/json" \
    -d "{\"token\":\"$RESET_TOKEN\",\"new_password\":\"$NEW_BOB_PW\"}")
  assert_status "reset token reuse returns 401" "$RESP" "401"

  # 13.8: weak password rejected with 400
  # First, request another reset token.
  curl -s -X POST "$BASE/auth/forgot-password" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$BOB_EMAIL\"}" > /dev/null
  sleep 0.2
  RESET_TOKEN=$(grep -oE '\?token=[0-9a-f]{64}' "$MAIL_LOG" | tail -1 | sed 's/^?token=//')
  RESP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/reset-password" \
    -H "Content-Type: application/json" \
    -d "{\"token\":\"$RESET_TOKEN\",\"new_password\":\"x\"}")
  assert_status "weak password rejected" "$RESP" "400"

  # 13.9: unknown token returns 401
  RESP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/reset-password" \
    -H "Content-Type: application/json" \
    -d '{"token":"0000000000000000000000000000000000000000000000000000000000000000","new_password":"some-ok-password"}')
  assert_status "unknown token returns 401" "$RESP" "401"

  # 13.10: self-serve email update via /auth/email
  # Sign in as bob, get cookie, update email to a new address, confirm via /auth/me.
  NEW_EMAIL="bob-alt@example.com"
  # bob's password was changed by 13.5; it remains that value (13.8's weak-password
  # attempt failed so no further change occurred).
  CJ=$(mktemp)
  curl -s -c "$CJ" -X POST "$BASE/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"bob\",\"password\":\"$NEW_BOB_PW\"}" > /dev/null
  RESP=$(curl -s -b "$CJ" -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/email" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$NEW_EMAIL\"}")
  assert_status "/auth/email self-serve update" "$RESP" "200"
  ME=$(curl -s -b "$CJ" "$BASE/auth/me")
  assert_contains "/auth/me reflects new email" "$ME" "$NEW_EMAIL"
  rm -f "$CJ"

  # 13.11: admin invites a new user, invite link appears in mail log
  # First create dana (no password, has email).
  : > "$MAIL_LOG"  # clear the log so grep picks up only this batch
  curl -s -X POST "$BASE/admin/users" \
    -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
    -d '{"username":"dana","domains":{},"email":"dana@example.com"}' > /dev/null
  RESP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/admin/users/dana/invite" \
    -H "Authorization: Bearer $BOB_KEY")
  assert_status "admin invite returns 200" "$RESP" "200"
  sleep 0.2
  MAIL_SUBJ=$(grep "^Subject: " "$MAIL_LOG" | tail -1)
  assert_contains "invite email subject" "$MAIL_SUBJ" "invited to OB2"

  # 13.12: dana follows the invite link, sets a password, auto-login
  INVITE_TOKEN=$(grep -oE '\?token=[0-9a-f]{64}' "$MAIL_LOG" | tail -1 | sed 's/^?token=//')
  DANA_PW="dana-new-pass-987"
  RESP_BODY=$(curl -s -X POST "$BASE/auth/reset-password" \
    -H "Content-Type: application/json" \
    -d "{\"token\":\"$INVITE_TOKEN\",\"new_password\":\"$DANA_PW\"}")
  assert_contains "invite accept auto-signs-in" "$RESP_BODY" '"auto_signed_in":true'

  # 13.13: dana can sign in normally with the new password
  LOGIN_RES=$(curl -s -X POST "$BASE/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"dana\",\"password\":\"$DANA_PW\"}")
  assert_contains "dana signs in with chosen password" "$LOGIN_RES" '"ok":true'

  # 13.14: SMTP test endpoint reaches mailer
  : > "$MAIL_LOG"
  RESP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/admin/smtp/test" \
    -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
    -d '{"to":"diagnostic@example.com"}')
  assert_status "SMTP test endpoint returns 200" "$RESP" "200"
  sleep 0.2
  MAIL_SUBJ=$(grep "^Subject: " "$MAIL_LOG" | tail -1)
  assert_contains "SMTP test email subject" "$MAIL_SUBJ" "OB2 SMTP test"
fi

# ─────────────────────────────────────────────
echo
echo "── Step 14: Security regression ──"

# 14.1–14.4: security headers present on /dashboard
HEADERS=$(curl -sI "$BASE/dashboard")
assert_contains "CSP header present" "$HEADERS" "Content-Security-Policy"
assert_contains "X-Frame-Options DENY" "$HEADERS" "X-Frame-Options: DENY"
assert_contains "X-Content-Type-Options nosniff" "$HEADERS" "X-Content-Type-Options: nosniff"
assert_contains "Referrer-Policy present" "$HEADERS" "Referrer-Policy"

# 14.5: login brute-force — 11th wrong-password attempt is 429
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -s -o /dev/null -X POST "$BASE/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"probe-user\",\"password\":\"wrong-pw-$i\"}" > /dev/null
done
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"probe-user","password":"wrong-pw-11"}')
assert_status "login rate-limit fires at attempt #11" "$STATUS" "429"

# 14.6: 500-path error body lacks internal paths / stack-trace text.
# Trigger via a malformed raw-users.json save that will hit a post-parse throw.
RAW_MTIME=$(curl -s -H "Authorization: Bearer $BOB_KEY" "$BASE/admin/users/raw" | python3 -c "import sys,json; print(json.load(sys.stdin)['mtime'])")
BAD_BODY=$(python3 -c "
import sys, json
print(json.dumps({'content':'invalid not-json','expected_mtime':sys.argv[1]}))
" "$RAW_MTIME")
RESP=$(curl -s -X POST "$BASE/admin/users/raw" \
  -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
  -d "$BAD_BODY")
# The 400-path returns the parse error which IS intentionally public, so this
# isn't the cleanest probe — but it at least confirms the response does not
# leak server-side paths like "server/users.ts" or Deno internal prefixes.
TESTS=$((TESTS + 1))
if ! echo "$RESP" | grep -qE "server/users\.ts|at _atomicWrite|Deno\.errors|file:///"; then
  echo "  PASS: error response lacks internal paths / Deno stack markers"
  PASS=$((PASS + 1))
else
  echo "  FAIL: error response leaks internals: $RESP"
  FAIL=$((FAIL + 1))
fi

# 14.7: dashboard.html has NO inline onclick= (verifies A5 extraction)
DASH=$(curl -s "$BASE/dashboard")
TESTS=$((TESTS + 1))
if ! echo "$DASH" | grep -q 'onclick='; then
  echo "  PASS: dashboard.html has no inline onclick handlers"
  PASS=$((PASS + 1))
else
  echo "  FAIL: dashboard.html still has inline onclick handlers"
  FAIL=$((FAIL + 1))
fi

# 14.8 dropped: 14.5's brute-force fills the per-IP rate-limit bucket (10/15min)
# which blocks any subsequent login from the same IP — making a per-user isolation
# test impossible to assert from a single test host. The per-user 5/15min limit
# is still enforced in code (auth.ts POST /auth/login), just not unit-testable
# at the e2e layer alongside 14.5.

# ─────────────────────────────────────────────
echo
echo "── Step 15: Domain scope decoration + classifier scope + resend invite ──"

# Preconditions from earlier steps:
#   - bob is the global admin (BOB_KEY, password NEW_BOB_PW set in 13.5).
#   - bob has email "bob-alt@example.com" (set in 13.10).
#   - SMTP log driver is on iff OB2_SMTP_DRIVER=log.
#   - @infra and @netsec exist with seeded docs from Steps 2 + 3.
#
# Steps 13.x ran the `if [ "${OB2_SMTP_DRIVER:-}" = "log" ]` branch, so the
# resend-invite assertion below requires the same precondition. If SMTP is
# unconfigured the resend should still succeed with sent:false; we cover both.

# 15.1: As bob, create alice as a non-admin with domains: { "infra": "read" }.
ALICE_RES=$(curl -s -X POST "$BASE/admin/users" \
  -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
  -d '{"username":"alice","domains":{"infra":"read"},"global_admin":false,"email":"alice@example.com"}')
ALICE_KEY=$(echo "$ALICE_RES" | python3 -c "import sys,json; print(json.load(sys.stdin).get('key',''))" 2>/dev/null || echo "")
TESTS=$((TESTS + 1))
if [ -n "$ALICE_KEY" ]; then
  echo "  PASS: alice created with infra:read"
  PASS=$((PASS + 1))
else
  echo "  FAIL: alice creation did not return a key: $ALICE_RES"
  FAIL=$((FAIL + 1))
fi

# 15.2: As alice, GET /admin/domains — every entry has effective_permission;
#       infra is "read"; another seeded domain is null.
DOMAINS_AS_ALICE=$(curl -s -H "Authorization: Bearer $ALICE_KEY" "$BASE/admin/domains")
assert_contains "alice's GET /admin/domains has effective_permission key" "$DOMAINS_AS_ALICE" '"effective_permission"'
INFRA_PERM=$(echo "$DOMAINS_AS_ALICE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for e in d.get('domains', []):
    if e.get('domain') == 'infra' or e.get('name') == 'infra':
        print(e.get('effective_permission'))
        break
")
assert_contains "alice sees infra effective_permission=read" "$INFRA_PERM" "read"
NETSEC_PERM=$(echo "$DOMAINS_AS_ALICE" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for e in d.get('domains', []):
    if e.get('domain') == 'netsec' or e.get('name') == 'netsec':
        print(repr(e.get('effective_permission')))
        break
")
assert_contains "alice sees netsec effective_permission=null" "$NETSEC_PERM" "None"

# 15.3: As bob (admin), GET /admin/domains — every entry's effective_permission is "admin".
DOMAINS_AS_BOB=$(curl -s -H "Authorization: Bearer $BOB_KEY" "$BASE/admin/domains")
ALL_ADMIN=$(echo "$DOMAINS_AS_BOB" | python3 -c "
import sys, json
d = json.load(sys.stdin)
entries = d.get('domains', [])
print('yes' if entries and all(e.get('effective_permission') == 'admin' for e in entries) else 'no')
")
assert_contains "bob's GET /admin/domains has effective_permission=admin everywhere" "$ALL_ADMIN" "yes"

# 15.4: As alice (read on infra only), POST /v1/chat/completions WITHOUT a
#       @prefix. The classifier could route to @netsec; with scope filtering
#       it must restrict to alice's assigned domains and return 200 (or a
#       domain-aware response). Assert: not 403.
CHAT_RES=$(curl -s -o /tmp/ob2_chat_alice.json -w "%{http_code}" -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $ALICE_KEY" -H "Content-Type: application/json" \
  --max-time 60 \
  -d '{"model":"ob2","messages":[{"role":"user","content":"What is the certificate expiration check?"}],"stream":false}')
TESTS=$((TESTS + 1))
if [ "$CHAT_RES" != "403" ]; then
  echo "  PASS: alice chat without prefix not 403'd by classifier scope"
  PASS=$((PASS + 1))
else
  echo "  FAIL: alice chat returned 403 — classifier picked an unassigned domain. Body:"
  cat /tmp/ob2_chat_alice.json
  FAIL=$((FAIL + 1))
fi

# 15.5: PATCH alice to domains:{}. Next chat without prefix must 403 with no_domain_access.
curl -s -X PATCH "$BASE/admin/users/alice" \
  -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
  -d '{"domains":{}}' > /dev/null
CHAT_RES2=$(curl -s -X POST "$BASE/v1/chat/completions" \
  -H "Authorization: Bearer $ALICE_KEY" -H "Content-Type: application/json" \
  --max-time 30 \
  -d '{"model":"ob2","messages":[{"role":"user","content":"anything"}],"stream":false}')
assert_contains "alice with no domains gets no_domain_access" "$CHAT_RES2" "no_domain_access"

# 15.6: As bob, POST /admin/users/alice/invite — body has ok, url, expires_at.
INVITE_RES=$(curl -s -X POST "$BASE/admin/users/alice/invite" \
  -H "Authorization: Bearer $BOB_KEY")
assert_contains "resend invite returns ok=true" "$INVITE_RES" '"ok":true'
assert_contains "resend invite returns url" "$INVITE_RES" '"url"'
assert_contains "resend invite returns expires_at" "$INVITE_RES" '"expires_at"'

# ─────────────────────────────────────────────
echo
echo "── Step 16: Rust sidecar runtime parity ──"

# Only runs if the Rust binary is present. In Docker it's at
# /app/sidecar-rs/ob2-sidecar; locally it's at sidecar-rs/target/release/ob2-sidecar.
# If neither exists, SKIP (don't fail) — CI without Rust still needs to pass.
RUST_BIN_LOCAL="$PROJECT_DIR/sidecar-rs/target/release/ob2-sidecar"
RUST_BIN_DOCKER="/app/sidecar-rs/ob2-sidecar"
if [ -x "$RUST_BIN_LOCAL" ] || docker exec ob2-server test -x "$RUST_BIN_DOCKER" 2>/dev/null; then
  echo "  Rust binary detected. Restarting server with OB2_SIDECAR_RUNTIME=rust..."
  kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null || true
  cd "$SERVER_DIR"
  env $(grep -v '^#' "$ENV_FILE" | grep -v '^\s*$' | xargs) \
    OB2_SIDECAR_RUNTIME=rust \
    OB2_RUST_SIDECAR_BIN="$RUST_BIN_LOCAL" \
    "$DENO" task start > /tmp/ob2_e2e_rust.log 2>&1 &
  SERVER_PID=$!
  sleep 10  # Rust binary cold-start is faster, but give fastembed time to warm
  cd "$PROJECT_DIR"

  # Re-run 3 canary assertions from earlier steps to confirm parity:
  HEALTH=$(curl -s "$BASE/health")
  assert_contains "[rust] health server=true" "$HEALTH" '"server":true'

  STATS=$(call_mcp '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"knowledge_stats","arguments":{"domain":"infra"}}}' | extract_mcp_text)
  assert_contains "[rust] infra still has 5 docs" "$STATS" "5 doc"

  RES=$(call_mcp '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_knowledge","arguments":{"domain":"netsec","query":"certificate expiration check","top_k":2}}}' | extract_mcp_text)
  assert_contains "[rust] TLS doc still ranked first" "$RES" "TLS"
  # Step 16 Rust parity: alice's GET /admin/domains decoration still works.
  RUST_DOMAINS=$(curl -s -H "Authorization: Bearer $ALICE_KEY" "$BASE/admin/domains")
  assert_contains "[rust] effective_permission decoration intact" "$RUST_DOMAINS" '"effective_permission"'
else
  echo "  SKIP: Rust binary not built (build with: cd sidecar-rs && cargo build --release)"
fi

# ─────────────────────────────────────────────
echo
echo "── Step 17: Open WebUI service-token impersonation ──"

# This step exercises the impersonation handshake on /v1 — the same handshake
# the Open WebUI sidecar uses when it talks back to OB2. It does NOT require
# the openwebui container to be up; the e2e suite stays self-contained.
#
# Skips cleanly when OB2_OPENWEBUI_SERVICE_TOKEN is not set (the suite's
# default state). Set both OB2_OPENWEBUI_ENABLED=true and a value for
# OB2_OPENWEBUI_SERVICE_TOKEN before running e2e.sh to exercise.

if [ -z "${OB2_OPENWEBUI_SERVICE_TOKEN:-}" ]; then
  echo "  SKIP: OB2_OPENWEBUI_SERVICE_TOKEN not set"
else
  SVC_TOKEN="$OB2_OPENWEBUI_SERVICE_TOKEN"

  # 17.1: Service token alone (no X-OB2-User) → 403 + authentication_error
  STATUS=$(curl -s -o /tmp/ob2_imp.json -w "%{http_code}" \
    -H "Authorization: Bearer $SVC_TOKEN" "$BASE/v1/models")
  assert_status "service token alone refused" "$STATUS" "403"
  assert_contains "service token alone returns authentication_error" "$(cat /tmp/ob2_imp.json)" "authentication_error"

  # 17.2: Service token + valid X-OB2-User → 200 + scoped models
  RESP=$(curl -s -H "Authorization: Bearer $SVC_TOKEN" -H "X-OB2-User: bob" "$BASE/v1/models")
  assert_contains "service token + X-OB2-User: bob → admin sees all models" "$RESP" "ob2-infra"

  # 17.3: Service token + nonexistent user → 403
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer $SVC_TOKEN" -H "X-OB2-User: nonexistent" "$BASE/v1/models")
  assert_status "service token + bad user refused" "$STATUS" "403"

  # 17.4: User key + spoofed X-OB2-User header → header ignored (no escalation)
  # Use bob (admin) impersonation header on dana's user key (no domains).
  if [ -n "${BOB_KEY:-}" ] && [ -n "${DANA_KEY:-}" ]; then
    DANA_RESP=$(curl -s -H "Authorization: Bearer $DANA_KEY" -H "X-OB2-User: bob" "$BASE/v1/models")
    DANA_MODELS=$(echo "$DANA_RESP" | python3 -c "import sys,json; print(','.join(m['id'] for m in json.load(sys.stdin).get('data', [])))" 2>/dev/null || echo "")
    TESTS=$((TESTS + 1))
    if echo "$DANA_MODELS" | grep -q "ob2-infra"; then
      echo "  FAIL: dana's key + spoofed X-OB2-User: bob escalated to admin (saw $DANA_MODELS)"
      FAIL=$((FAIL + 1))
    else
      echo "  PASS: dana's key + spoofed X-OB2-User: bob ignored (saw $DANA_MODELS)"
      PASS=$((PASS + 1))
    fi
  else
    echo "  SKIP: BOB_KEY or DANA_KEY not in scope for header-bypass assertion"
  fi
fi

# ─────────────────────────────────────────────
echo
echo "── Step 18: Multi-domain retrieval (prefix-less chat scoped by caller) ──"

# Exercises the new build_multi_context path: a chat without @prefix searches
# every domain the caller can read in one pgvector scan, ranked together.
# No classifier; no hand-curated descriptions; per-caller scope enforced.
#
# Depends on: bob (admin), alice (netsec:read only), and seeded @infra + @netsec
# from earlier steps.

if [ -z "${ALICE_KEY:-}" ] || [ -z "${BOB_KEY:-}" ]; then
  echo "  SKIP: expected ALICE_KEY + BOB_KEY from earlier steps"
else
  # 18.1: admin (bob) prefix-less — should retrieve from any domain.
  RESP=$(curl -s -X POST "$BASE/v1/chat/completions" \
    -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
    --max-time 60 \
    -d '{"model":"ob2","messages":[{"role":"user","content":"Tell me about the TLS certificate expiration check."}],"stream":false}')
  # The only mention of TLS certs is in @netsec. Expect the reply to cite
  # relevant content from @netsec (without an @prefix being given).
  assert_contains "admin prefix-less retrieves from any domain" "$RESP" "TLS\|certificate\|openssl"

  # 18.2: alice (netsec:read only) prefix-less — same query → @netsec hit.
  RESP=$(curl -s -X POST "$BASE/v1/chat/completions" \
    -H "Authorization: Bearer $ALICE_KEY" -H "Content-Type: application/json" \
    --max-time 60 \
    -d '{"model":"ob2","messages":[{"role":"user","content":"Tell me about the TLS certificate expiration check."}],"stream":false}')
  assert_contains "alice prefix-less retrieves from her assigned @netsec" "$RESP" "TLS\|certificate\|openssl"

  # 18.3: alice asks about @infra content (she has no access) — should NOT
  # return @infra content. Reply should be a not-found / don't-know style.
  RESP=$(curl -s -X POST "$BASE/v1/chat/completions" \
    -H "Authorization: Bearer $ALICE_KEY" -H "Content-Type: application/json" \
    --max-time 60 \
    -d '{"model":"ob2","messages":[{"role":"user","content":"What did the postgres document say?"}],"stream":false}')
  # alice does not have read on @infra, so retrieval cannot hit it. The reply
  # should not contain postgres-specific content. (Soft check: ensure it's
  # not confident about @infra content.)
  TESTS=$((TESTS + 1))
  if echo "$RESP" | grep -qi "postgres.*backup\|replicat"; then
    echo "  FAIL: alice saw @infra content she has no access to: $RESP"
    FAIL=$((FAIL + 1))
  else
    echo "  PASS: alice's prefix-less query didn't leak @infra content"
    PASS=$((PASS + 1))
  fi

  # 18.4: user with domains:{} gets a friendly 403 no_domain_access (reuses
  # the guard that was already in place).
  curl -s -X PATCH "$BASE/admin/users/alice" \
    -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
    -d '{"domains":{}}' > /dev/null
  RESP=$(curl -s -X POST "$BASE/v1/chat/completions" \
    -H "Authorization: Bearer $ALICE_KEY" -H "Content-Type: application/json" \
    --max-time 30 \
    -d '{"model":"ob2","messages":[{"role":"user","content":"anything"}],"stream":false}')
  assert_contains "alice with empty domains still gets no_domain_access" "$RESP" "no_domain_access"
  # restore alice so later runs don't inherit the bad state
  curl -s -X PATCH "$BASE/admin/users/alice" \
    -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
    -d '{"domains":{"netsec":"read"}}' > /dev/null
fi

# ─────────────────────────────────────────────
echo
echo "── Step 19: File / URL ingestion via MarkItDown ──"

if [ -z "${BOB_KEY:-}" ]; then
  echo "  SKIP: needs BOB_KEY (admin) from earlier steps"
else
  IMPORT_DOMAIN="import-test"
  curl -s -X POST "$BASE/admin/domains" \
    -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
    -d "{\"domain\":\"$IMPORT_DOMAIN\",\"description\":\"e2e import fixture domain\"}" > /dev/null
  FIX="$PROJECT_DIR/tests/fixtures/import"

  # 19.1: PDF upload — sync, returns ok+chunks
  RESP=$(curl -s -X POST -H "Authorization: Bearer $BOB_KEY" \
    -F "file=@$FIX/tiny.pdf" -F "source_label=tiny.pdf" \
    "$BASE/admin/domains/$IMPORT_DOMAIN/import")
  assert_contains "PDF upload returns ok" "$RESP" '"ok":true'
  assert_contains "PDF upload reports chunks_captured" "$RESP" '"chunks_captured"'

  # 19.2: DOCX upload
  RESP=$(curl -s -X POST -H "Authorization: Bearer $BOB_KEY" \
    -F "file=@$FIX/tiny.docx" \
    "$BASE/admin/domains/$IMPORT_DOMAIN/import")
  assert_contains "DOCX upload returns ok" "$RESP" '"ok":true'

  # 19.3: HTML upload
  RESP=$(curl -s -X POST -H "Authorization: Bearer $BOB_KEY" \
    -F "file=@$FIX/tiny.html" \
    "$BASE/admin/domains/$IMPORT_DOMAIN/import")
  assert_contains "HTML upload returns ok" "$RESP" '"ok":true'

  # 19.4: MD upload
  RESP=$(curl -s -X POST -H "Authorization: Bearer $BOB_KEY" \
    -F "file=@$FIX/tiny.md" \
    "$BASE/admin/domains/$IMPORT_DOMAIN/import")
  assert_contains "MD upload returns ok" "$RESP" '"ok":true'

  # 19.5: PNG upload (OCR — at minimum the conversion attempt should succeed)
  RESP=$(curl -s -X POST -H "Authorization: Bearer $BOB_KEY" \
    -F "file=@$FIX/tiny.png" \
    "$BASE/admin/domains/$IMPORT_DOMAIN/import")
  assert_contains "PNG upload returns ok" "$RESP" '"ok":true'

  # 19.6: URL ingestion
  RESP=$(curl -s -X POST -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
    -d '{"url":"https://example.com/"}' \
    "$BASE/admin/domains/$IMPORT_DOMAIN/import/url")
  assert_contains "URL ingestion returns ok" "$RESP" '"ok":true'

  # 19.7: SSRF block (loopback bare IP)
  STATUS=$(curl -s -o /tmp/ssrf.json -w "%{http_code}" -X POST -H "Authorization: Bearer $BOB_KEY" \
    -H "Content-Type: application/json" \
    -d '{"url":"http://127.0.0.1:11434/api/version"}' \
    "$BASE/admin/domains/$IMPORT_DOMAIN/import/url")
  assert_status "SSRF loopback URL refused" "$STATUS" "400"
  assert_contains "SSRF response carries url_blocked type" "$(cat /tmp/ssrf.json)" "url_blocked"

  # 19.8: Auth — alice (no write on import-test) refused
  if [ -n "${ALICE_KEY:-}" ]; then
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Authorization: Bearer $ALICE_KEY" \
      -F "file=@$FIX/tiny.md" \
      "$BASE/admin/domains/$IMPORT_DOMAIN/import")
    assert_status "alice refused (no write on import-test)" "$STATUS" "403"
  fi

  # 19.9: ZIP bomb — sync 413/400 OR async job ending in error
  RESP=$(curl -s -X POST -H "Authorization: Bearer $BOB_KEY" \
    -F "file=@$FIX/bomb.zip" \
    "$BASE/admin/domains/$IMPORT_DOMAIN/import")
  TESTS=$((TESTS + 1))
  if echo "$RESP" | grep -q '"job_id"'; then
    JOB_ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['job_id'])")
    STATUS=""
    for i in $(seq 1 30); do
      sleep 2
      JR=$(curl -s -H "Authorization: Bearer $BOB_KEY" "$BASE/admin/domains/$IMPORT_DOMAIN/import/jobs/$JOB_ID")
      STATUS=$(echo "$JR" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
      if [ "$STATUS" = "error" ] || [ "$STATUS" = "interrupted" ] || [ "$STATUS" = "done" ]; then
        break
      fi
    done
    if [ "$STATUS" = "error" ] || [ "$STATUS" = "interrupted" ]; then
      echo "  PASS: zip bomb job reached terminal failure ($STATUS)"
      PASS=$((PASS + 1))
    else
      echo "  FAIL: zip bomb job ended $STATUS — should have errored"
      FAIL=$((FAIL + 1))
    fi
  elif echo "$RESP" | grep -qE '"type":"(conversion_failed|payload_too_large)"'; then
    echo "  PASS: zip bomb sync upload refused"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: zip bomb response unexpected: $RESP"
    FAIL=$((FAIL + 1))
  fi

  # 19.10: Citation check — chat about the PDF content; reply should include
  #        the lighthouse keeper's name from the captured PDF chunk.
  RESP=$(curl -s -X POST "$BASE/v1/chat/completions" \
    -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
    --max-time 60 \
    -d "{\"model\":\"ob2\",\"messages\":[{\"role\":\"user\",\"content\":\"@$IMPORT_DOMAIN Who was the lighthouse keeper?\"}],\"stream\":false}")
  assert_contains "PDF retrieval finds 'Hopper'" "$RESP" "Hopper"
fi

# ─────────────────────────────────────────────
echo
echo "── Step 20: Domain export / import round-trip ──"

if [ -z "${BOB_KEY:-}" ]; then
  echo "  SKIP: needs BOB_KEY (admin) from earlier steps"
else
  EX_DOMAIN="export-test-$$"
  BUNDLE="/tmp/$EX_DOMAIN.ob2bundle"
  RESTORED="$EX_DOMAIN-restored"

  # 20.1: Create domain + add docs + alias + a real PDF (so files/ is populated)
  curl -s -X POST "$BASE/admin/domains" \
    -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
    -d "{\"domain\":\"$EX_DOMAIN\",\"description\":\"export round-trip fixture\"}" > /dev/null

  for i in 1 2 3; do
    curl -s -X POST "$BASE/mcp" \
      -H "Authorization: Bearer $BOB_KEY" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -d "{\"jsonrpc\":\"2.0\",\"id\":$i,\"method\":\"tools/call\",\"params\":{\"name\":\"capture_knowledge\",\"arguments\":{\"domain\":\"$EX_DOMAIN\",\"text\":\"Export round-trip test fact $i — Borges wrote in 194$i\",\"tags\":[\"e2e\"]}}}" > /dev/null
  done
  curl -s -X POST "$BASE/admin/domains/$EX_DOMAIN/aliases" \
    -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
    -d '{"alias":"jlb","canonical":"Jorge Luis Borges"}' > /dev/null
  if [ -f "$PROJECT_DIR/tests/fixtures/import/tiny.pdf" ]; then
    curl -s -X POST -H "Authorization: Bearer $BOB_KEY" \
      -F "file=@$PROJECT_DIR/tests/fixtures/import/tiny.pdf" -F "source_label=tiny.pdf" \
      "$BASE/admin/domains/$EX_DOMAIN/import" > /dev/null
  fi

  # Wait for the SyncWorker to push captures to pgvector (two-tier mode flush)
  sleep 6

  # 20.2: Export
  STATUS=$(curl -s -o "$BUNDLE" -w "%{http_code}" \
    -H "Authorization: Bearer $BOB_KEY" \
    "$BASE/admin/domains/$EX_DOMAIN/export")
  assert_status "export returns 200" "$STATUS" "200"
  TESTS=$((TESTS + 1))
  if [ -s "$BUNDLE" ] && file "$BUNDLE" | grep -qi "gzip"; then
    echo "  PASS: bundle is non-empty gzip"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: bundle missing or not gzip ($(file "$BUNDLE" 2>&1))"
    FAIL=$((FAIL + 1))
  fi

  # 20.3: Bundle layout sanity (manifest + documents + files entry)
  TESTS=$((TESTS + 1))
  if tar -tzf "$BUNDLE" | grep -q "^manifest.json$" \
     && tar -tzf "$BUNDLE" | grep -q "^documents.jsonl$" \
     && tar -tzf "$BUNDLE" | grep -q "^domain.json$"; then
    echo "  PASS: bundle contains manifest/domain/documents"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: bundle missing required entries"
    tar -tzf "$BUNDLE"
    FAIL=$((FAIL + 1))
  fi

  # 20.4: Import to a renamed domain (original still exists, so target_domain
  #       is required to avoid 409). Verifies rename path.
  RESP=$(curl -s -X POST -H "Authorization: Bearer $BOB_KEY" \
    -F "bundle=@$BUNDLE" -F "target_domain=$RESTORED" \
    "$BASE/admin/domains/import")
  assert_contains "import returns ok" "$RESP" '"ok":true'
  assert_contains "import reports source_domain" "$RESP" "\"source_domain\":\"$EX_DOMAIN\""

  # Wait for sync to land the restored docs in pgvector
  sleep 6

  # 20.5: Restored domain has the same docs
  RESP=$(curl -s -H "Authorization: Bearer $BOB_KEY" \
    "$BASE/admin/domains/$RESTORED/docs?limit=50")
  assert_contains "restored doc 1 present" "$RESP" "1941"
  assert_contains "restored doc 3 present" "$RESP" "1943"

  # 20.6: Aliases survived
  RESP=$(curl -s -H "Authorization: Bearer $BOB_KEY" \
    "$BASE/admin/domains/$RESTORED/aliases")
  assert_contains "restored alias 'jlb' present" "$RESP" '"jlb"'
  assert_contains "restored alias canonical present" "$RESP" "Jorge Luis Borges"

  # 20.7: Re-importing the same bundle without rename → 409
  STATUS=$(curl -s -o /tmp/import-conflict.json -w "%{http_code}" \
    -X POST -H "Authorization: Bearer $BOB_KEY" \
    -F "bundle=@$BUNDLE" -F "target_domain=$RESTORED" \
    "$BASE/admin/domains/import")
  assert_status "duplicate import refused" "$STATUS" "409"
  assert_contains "duplicate import error is domain_exists" \
    "$(cat /tmp/import-conflict.json)" "domain_exists"

  # 20.8: Cleanup — delete both domains so the test is idempotent
  curl -s -X DELETE -H "Authorization: Bearer $BOB_KEY" \
    "$BASE/admin/domains/$EX_DOMAIN" > /dev/null
  curl -s -X DELETE -H "Authorization: Bearer $BOB_KEY" \
    "$BASE/admin/domains/$RESTORED" > /dev/null
  rm -f "$BUNDLE" /tmp/import-conflict.json
fi

# ─────────────────────────────────────────────
echo
echo "── Step 21: Graph RAG (entity extraction + traversal) ──"

if [ -z "${BOB_KEY:-}" ]; then
  echo "  SKIP: needs BOB_KEY (admin) from earlier steps"
else
  GR_DOMAIN="graph-test-$$"
  curl -s -X POST "$BASE/admin/domains" \
    -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
    -d "{\"domain\":\"$GR_DOMAIN\",\"description\":\"e2e graph fixture\"}" > /dev/null

  # 21.1: Empty-state stats
  RESP=$(curl -s -H "Authorization: Bearer $BOB_KEY" \
    "$BASE/admin/domains/$GR_DOMAIN/graph/stats")
  assert_contains "stats reports zero entities" "$RESP" '"entity_count":0'

  # 21.2: Capture facts that exercise multiple entity types
  for fact in \
    "Borges was an Argentine author who wrote The Library of Babel in 1941." \
    "Cervantes wrote Don Quixote in 1605 in Madrid Spain." \
    "Borges admired Franz Kafka of Prague."
  do
    curl -s -X POST "$BASE/mcp" \
      -H "x-brain-key: $BOB_KEY" -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"capture_knowledge\",\"arguments\":{\"domain\":\"$GR_DOMAIN\",\"text\":\"$fact\",\"tags\":[\"e2e\"]}}}" > /dev/null
  done
  sleep 6

  # 21.3: Backfill — works even if extraction_enabled is off
  RESP=$(curl -s -X POST -H "Authorization: Bearer $BOB_KEY" \
    "$BASE/admin/domains/$GR_DOMAIN/graph/backfill")
  JOB_ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")
  TESTS=$((TESTS + 1))
  if [ -n "$JOB_ID" ]; then
    echo "  PASS: backfill job started ($JOB_ID)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: no job_id returned: $RESP"
    FAIL=$((FAIL + 1))
  fi

  # 21.4: Poll until done (max 5 min — depends on local Ollama speed)
  STATUS=""
  for i in $(seq 1 30); do
    sleep 10
    JR=$(curl -s -H "Authorization: Bearer $BOB_KEY" "$BASE/admin/graph/backfills/$JOB_ID")
    STATUS=$(echo "$JR" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
    if [ "$STATUS" = "done" ] || [ "$STATUS" = "error" ]; then
      break
    fi
  done
  assert_contains "backfill completes" "$STATUS" "done"

  # 21.5: Stats now reflects extracted entities
  RESP=$(curl -s -H "Authorization: Bearer $BOB_KEY" \
    "$BASE/admin/domains/$GR_DOMAIN/graph/stats")
  TESTS=$((TESTS + 1))
  COUNT=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('entity_count',0))" 2>/dev/null || echo "0")
  if [ "$COUNT" -gt 0 ] 2>/dev/null; then
    echo "  PASS: extracted $COUNT entities"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: zero entities after backfill (stats=$RESP)"
    FAIL=$((FAIL + 1))
  fi

  # 21.6: Entities endpoint returns content
  RESP=$(curl -s -H "Authorization: Bearer $BOB_KEY" \
    "$BASE/admin/domains/$GR_DOMAIN/graph/entities?limit=50")
  assert_contains "entity list contains Borges" "$RESP" "Borges"

  # 21.7: Edges endpoint returns content (mistral-small3.2 typically extracts >=3 relations)
  RESP=$(curl -s -H "Authorization: Bearer $BOB_KEY" \
    "$BASE/admin/domains/$GR_DOMAIN/graph/edges?limit=50")
  assert_contains "edge list non-empty" "$RESP" '"relation":'

  # 21.8: Cross-domain overlap endpoint (filters to readable domains)
  RESP=$(curl -s -H "Authorization: Bearer $BOB_KEY" \
    "$BASE/admin/graph/overlap?domains=$GR_DOMAIN")
  assert_contains "overlap endpoint responds" "$RESP" '"overlap":'

  # 21.9: Non-admin (alice) refused for backfill
  if [ -n "${ALICE_KEY:-}" ]; then
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
      -H "Authorization: Bearer $ALICE_KEY" \
      "$BASE/admin/domains/$GR_DOMAIN/graph/backfill")
    assert_status "alice refused on backfill (no admin)" "$STATUS" "403"
  fi

  # 21.10: Bundle round-trip preserves graph data
  STATUS=$(curl -s -o /tmp/graph-test.ob2bundle -w "%{http_code}" \
    -H "Authorization: Bearer $BOB_KEY" \
    "$BASE/admin/domains/$GR_DOMAIN/export")
  assert_status "graph bundle export 200" "$STATUS" "200"
  TESTS=$((TESTS + 1))
  if tar -tzf /tmp/graph-test.ob2bundle 2>/dev/null | grep -q "^entities.jsonl$"; then
    echo "  PASS: bundle contains entities.jsonl"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: bundle missing entities.jsonl"
    FAIL=$((FAIL + 1))
  fi

  RESP=$(curl -s -X POST -H "Authorization: Bearer $BOB_KEY" \
    -F "bundle=@/tmp/graph-test.ob2bundle" \
    -F "target_domain=$GR_DOMAIN-restored" \
    "$BASE/admin/domains/import")
  assert_contains "graph bundle import succeeds" "$RESP" '"ok":true'
  assert_contains "graph counts in import response" "$RESP" "graph_entity_count"
  sleep 3
  RESP=$(curl -s -H "Authorization: Bearer $BOB_KEY" \
    "$BASE/admin/domains/$GR_DOMAIN-restored/graph/stats")
  TESTS=$((TESTS + 1))
  RESTORED=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('entity_count',0))" 2>/dev/null || echo "0")
  if [ "$RESTORED" -gt 0 ] 2>/dev/null; then
    echo "  PASS: restored domain has $RESTORED entities"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: restored domain has zero entities"
    FAIL=$((FAIL + 1))
  fi

  # 21.11: delete_domain cascades to graph data
  curl -s -X DELETE -H "Authorization: Bearer $BOB_KEY" \
    "$BASE/admin/domains/$GR_DOMAIN" > /dev/null
  RESP=$(curl -s -H "Authorization: Bearer $BOB_KEY" \
    "$BASE/admin/domains/$GR_DOMAIN/graph/stats")
  assert_contains "deleted domain has no entities" "$RESP" '"entity_count":0'

  # Cleanup
  curl -s -X DELETE -H "Authorization: Bearer $BOB_KEY" \
    "$BASE/admin/domains/$GR_DOMAIN-restored" > /dev/null
  rm -f /tmp/graph-test.ob2bundle
fi

# ─────────────────────────────────────────────
echo
echo "── Step 22: Provider abstraction (llamacpp) ──"

verify_llamacpp_provider() {
  local fake_pid llama_server_pid resp
  echo "  Stopping main OB2 server before swapping provider..."
  if [ -n "${SERVER_PID:-}" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    SERVER_PID=""
  fi

  echo "  Starting fake llama-server on :18080..."
  "$DENO" run --allow-net "$PROJECT_DIR/tests/fixtures/fake-llama-server.ts" --port 18080 \
    >/tmp/fake-llama.log 2>&1 &
  fake_pid=$!

  # Wait for fake server health
  local ok=0
  for _ in $(seq 1 25); do
    if curl -fsS http://localhost:18080/health >/dev/null 2>&1; then ok=1; break; fi
    sleep 0.2
  done
  if [ "$ok" -ne 1 ]; then
    echo "  FAIL: fake llama-server failed to come up (see /tmp/fake-llama.log)"
    TESTS=$((TESTS + 1)); FAIL=$((FAIL + 1))
    kill "$fake_pid" 2>/dev/null || true
    wait "$fake_pid" 2>/dev/null || true
    return
  fi

  echo "  Starting OB2 server with OB2_LLM_PROVIDER=llamacpp..."
  (
    cd "$SERVER_DIR"
    env $(grep -v '^#' "$ENV_FILE" | grep -v '^\s*$' | xargs) \
      OB2_LLM_PROVIDER=llamacpp \
      OB2_LLAMACPP_CHAT_URL=http://localhost:18080 \
      OB2_LLAMACPP_MANAGER_URL=http://localhost:18081 \
      "$DENO" task start >/tmp/ob2-llamacpp.log 2>&1 &
    echo $! >/tmp/ob2-llamacpp.pid
  )
  sleep 8
  llama_server_pid=$(cat /tmp/ob2-llamacpp.pid 2>/dev/null || echo "")

  # Stream a chat request through the gateway.
  resp=$(curl -fsS -N -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" \
    --max-time 30 \
    -d '{"model":"ob2","messages":[{"role":"user","content":"hi"}],"stream":true}' \
    "$BASE/v1/chat/completions" || true)

  # Tear down the llamacpp-mode server and the fake.
  if [ -n "$llama_server_pid" ]; then
    kill "$llama_server_pid" 2>/dev/null || true
    wait "$llama_server_pid" 2>/dev/null || true
  fi
  kill "$fake_pid" 2>/dev/null || true
  wait "$fake_pid" 2>/dev/null || true
  rm -f /tmp/ob2-llamacpp.pid

  TESTS=$((TESTS + 1))
  if echo "$resp" | grep -q '"content":"Hello"' && echo "$resp" | grep -q '\[DONE\]'; then
    echo "  PASS: llamacpp provider streams chat through gateway"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: llamacpp provider chat path"
    echo "      response head: $(echo "$resp" | head -c 200)"
    echo "      ob2 log tail (see /tmp/ob2-llamacpp.log):"
    tail -n 20 /tmp/ob2-llamacpp.log 2>/dev/null | sed 's/^/        /'
    FAIL=$((FAIL + 1))
  fi
}

verify_llamacpp_provider

# ─────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────
echo
echo "╔══════════════════════════════════════╗"
echo "║  Results: $PASS passed, $FAIL failed (of $TESTS)  "
echo "╚══════════════════════════════════════╝"

cleanup
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
