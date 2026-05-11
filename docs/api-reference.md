# OB2 API Reference

The HTTP surface is served by the Deno server on port 7600. The retrieval sidecar (Python default or Rust opt-in) is wire-compatible — every method, argument shape, and response shape is the same between runtimes, locked by the golden-fixture suite in `tests/sidecar-golden/`.

## Authentication

| Credential | Where used | How sent |
|---|---|---|
| **Password + session cookie** | Dashboard (`/dashboard`) | `POST /auth/login` sets `ob2_session` httpOnly cookie; browser sends automatically |
| **API key** (`ob2_` + 32 hex) | MCP, gateway, admin API, CLI | `x-brain-key: <key>` on `/mcp`, `Authorization: Bearer <key>` elsewhere |
| **Open WebUI service token** | Open WebUI -> `/v1` calls | `Authorization: Bearer <OB2_OPENWEBUI_SERVICE_TOKEN>` + `X-OpenWebUI-User-Name: <username>` |

Both cookie and Bearer token resolve to the same `UserRecord` and honor identical per-domain ACL rules.

### Bootstrap login

When `users.json` is empty, sign in as username `_admin` with `OB2_BRAIN_KEY` as the password. The moment any enabled non-`_admin` global admin exists, the brain key stops authenticating everywhere.

### Permissions

| Level | What the user can do |
|---|---|
| `read` | Search, chat |
| `write` | Capture, import (implies read) |
| `admin` | Delete docs, manage aliases (implies write) |
| `global_admin` | Everything + user management |

---

## Session + Auth Routes (`/auth`)

### `POST /auth/login`

```bash
curl -sc cookies.jar -X POST http://localhost:7600/auth/login \
  -H 'content-type: application/json' \
  -d '{"username":"alice","password":"..."}'
```

**Response (200):** Sets `ob2_session` cookie. Body: `{"ok":true,"username":"alice","global_admin":false,"domains":{...}}`.
**Response (401):** `{"error":"invalid credentials"}` — same for unknown user and wrong password.

### `POST /auth/logout`

Revokes session and clears cookie. Always `200`.

### `GET /auth/me`

Returns `{username, global_admin, domains}` for the authenticated caller. Cookie or Bearer token works.

```bash
curl -sb cookies.jar http://localhost:7600/auth/me
# or
curl -H "Authorization: Bearer ob2_..." http://localhost:7600/auth/me
```

### `POST /auth/change-password`

**Body:** `{"current":"...","next":"..."}`

On success: issues fresh session cookie, revokes all other sessions for this user. Returns 400 (not 401) on wrong current password — caller stays signed in.

### `POST /auth/rotate-key`

Issues a new API key. Old key invalidated immediately. **Response:** `{"ok":true,"key":"ob2_<full_key_shown_once>"}`.

### `GET /auth/openwebui-handoff`

Requires valid OB2 session cookie. Issues a 1-minute HMAC-signed SSO token and redirects the browser to `:7601/?sso=<token>`. The proxy at 7601 consumes the token and issues a 12-hour SSO cookie. Only available when `OB2_OPENWEBUI_ENABLED=true`.

### `POST /auth/forgot-password`

**Body:** `{"email":"alice@example.com"}`

Sends a password-reset link (1-hour TTL) if the email matches an account. Always responds the same way (anti-enumeration). Rate limit: 5 / 15 min per IP, 3 / hour per target email.

### `POST /auth/reset-password`

**Body:** `{"token":"...","password":"..."}`

Consumes the single-use reset token; sets the new password; revokes all sessions. Rate limit: 10 / hour per token.

### `POST /auth/accept-invite`

**Body:** `{"token":"...","password":"..."}`

Activates an invited user account (sets password, issues session cookie). Token TTL: 7 days, single-use.

---

## MCP Tools (`/mcp`)

Accessible via any MCP-compatible client. Uses `StreamableHTTPTransport` — `POST /mcp` with JSON-RPC body. Auth via `x-brain-key` header.

### `capture_knowledge`

Save a fact, rule, or note to a domain.

**Input:**

| Param | Type | Required | Description |
|---|---|---|---|
| `domain` | string | yes | Domain name |
| `text` | string | yes | Content to capture |
| `tags` | string[] | no | Topical tags |
| `source` | string | no | Origin label (default: `user`) |

**Response:** `"Captured to @netsec as doc <id> at <ISO-8601>. Domain now has N document(s)."`

**Permission required:** `write` on domain.

### `search_knowledge`

Semantic search within a domain.

**Input:**

| Param | Type | Required | Description |
|---|---|---|---|
| `domain` | string | yes | Domain to search |
| `query` | string | yes | Natural-language query |
| `top_k` | number | no | Result count (default: 5) |

**Response:** Ranked hits with content, score, tags, source, doc_id, `created_at` (ISO-8601).

**Permission required:** `read` on domain.

### `knowledge_stats`

Report document counts.

**Input:** `domain` (optional) — omit for all domains the caller can read.

**Permission required:** `read` on domain(s) queried.

### `chat_knowledge`

Full RAG in one call: retrieve → compress → Ollama → synthesized answer.

**Input:**

| Param | Type | Required | Description |
|---|---|---|---|
| `domain` | string | yes | Domain to query |
| `question` | string | yes | Natural-language question |

**Response:** Synthesized answer with `[Source: domain — date]` citations.

**Permission required:** `read` on domain.

### `capture_file`

Convert a local file or URL to Markdown and capture all chunks into a domain.

**Input:**

| Param | Type | Required | Description |
|---|---|---|---|
| `domain` | string | yes | Domain to capture into |
| `path_or_url` | string | yes | Absolute path on the server's `/data` volume or `https://` URL |
| `tags` | string[] | no | Tags to apply to all chunks |
| `source` | string | no | Origin label |

**Path restriction:** The path must resolve under `/data` (realpath check). Paths outside `/data` return an error.

**URL SSRF protection:** Same denylist as dashboard URL ingestion (RFC-1918, loopback, link-local, bare IPs blocked).

**Permission required:** `write` on domain.

---

## OpenAI-Compatible Gateway (`/v1`)

### `GET /v1/models`

Returns the single model `ob2` (multi-domain retrieval; use `@domain` prefix in messages to pin to one domain). Service tokens can call this endpoint.

```bash
curl -H "Authorization: Bearer ob2_..." http://localhost:7600/v1/models
```

**Response:**
```json
{
  "object": "list",
  "data": [
    {"id": "ob2", "object": "model", "created": 1776362154, "owned_by": "ob2"}
  ]
}
```

### `POST /v1/chat/completions`

OpenAI-compatible chat with optional domain retrieval.

**Domain resolution:**

1. `@domain` prefix in the last user message → single-domain retrieval
2. No prefix → multi-domain retrieval across all domains caller can read (one pgvector scan)
3. No prefix, no knowledge → pass-through to Ollama

**Service-token + impersonation:**

When `Authorization: Bearer <OB2_OPENWEBUI_SERVICE_TOKEN>` and `X-OpenWebUI-User-Name: <username>` are both present, the call runs as the named user (their ACL applies). Without the name header the call is `service_only` — can list models, cannot chat.

**Request:**
```bash
curl -s http://localhost:7600/v1/chat/completions \
  -H "Authorization: Bearer ob2_..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "ob2",
    "messages": [{"role": "user", "content": "@netsec how do I check TLS expiry?"}],
    "stream": false
  }'
```

**Response:**
```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Use `openssl x509 -noout -enddate`...\n\n---\n[Source: netsec — 2026-04-22](http://localhost:7600/admin/domains/netsec/imports/<file_id>?t=<hmac>&exp=<unix>)"
    },
    "finish_reason": "stop"
  }],
  "usage": {"prompt_tokens": 138, "completion_tokens": 27, "total_tokens": 165}
}
```

Citation URLs are HMAC-signed with a 24-hour TTL. They work without an OB2 session cookie (usable from Open WebUI's origin).

---

## Admin HTTP (`/admin`)

All admin routes require authentication. Global-admin routes are noted. On `/admin/*`, the server accepts either the session cookie or `Authorization: Bearer <key>`.

### Domain Management

#### `GET /admin/domains`

List all domains with doc counts.

```bash
curl -H "Authorization: Bearer ob2_..." http://localhost:7600/admin/domains
```

```json
{"domains": [{"domain": "netsec", "doc_count": 12, "description": "Network security procedures"}]}
```

#### `POST /admin/domains` (global admin)

Create a domain.

**Body:** `{"domain": "netsec", "description": "Network security procedures"}`

#### `PATCH /admin/domains/:domain` (admin on domain)

Update domain description.

**Body:** `{"description": "Updated description"}`

#### `DELETE /admin/domains/:domain` (admin on domain)

Delete a domain and all data scoped to it. Domains are global — there is
no per-user view of a domain — so this affects every user who could read
the domain.

**Cascades atomically across both backends** (pgvector + sqlite):

- `docs` rows + their `docs_vec` embeddings
- `entity_aliases` (alias → canonical mappings)
- `source_imports` dedup history
- `entities`, `entity_mentions`, `entity_edges` (graph data)
- The hidden `_ob2_domain_<domain>` seed doc that holds the description

**Does NOT touch:**

| | |
|---|---|
| `users.json` permission entries | `"<domain>": "read"` entries in `user.domains` stay. Harmless — point to nothing. Re-grant overwrites them. |
| `/data/imports/<domain>/<file>.<ext>` | Original uploaded PDFs / images / audio remain on disk. Citation download links return 404 once the domain is gone. |
| Open WebUI chat history | Lives in Open WebUI's per-user `webui.db`. Old chats that quoted the deleted domain still appear with their original text. |

Returns `{"ok": true, "domain": "...", "deleted_count": N}` where `N` is
the number of doc rows removed.

#### `GET /admin/domains/:domain/stats`

```json
{
  "domain": "netsec",
  "doc_count": 12,
  "total_bytes": 8432,
  "oldest_at": "2026-04-16T02:25:07+00:00",
  "newest_at": "2026-04-22T19:03:44+00:00",
  "exists": true
}
```

#### `GET /admin/domains/:domain/docs`

List documents in a domain (excludes internal system docs).

#### `DELETE /admin/domains/:domain/docs/:id` (admin on domain)

Delete a single document. Returns `{"deleted": true}` or `{"deleted": false}`.

#### `GET /admin/domains/:domain/export` (admin on domain)

Stream the domain as a `.ob2bundle` (gzip tar). Includes every user document
with its embeddings, all aliases, the description, and every original
uploaded file. Bytes flow through a `/tmp` spool because the sidecar protocol
is line-delimited JSON; the file is unlinked after the stream closes.

```bash
curl -H "Authorization: Bearer ob2_..." \
     -o backup.ob2bundle \
     http://localhost:7600/admin/domains/netsec/export
```

Response headers:

| Header | Meaning |
|---|---|
| `Content-Type` | `application/octet-stream` |
| `Content-Disposition` | `attachment; filename="<domain>-<YYYYMMDDHHMM>.ob2bundle"` |
| `X-OB2-Bundle-Doc-Count` | User documents in the bundle (system seed excluded) |
| `X-OB2-Bundle-Alias-Count` | Aliases in the bundle |
| `X-OB2-Bundle-File-Count` | Original uploaded files in the bundle |

Bundle layout:

```
manifest.json   format, version, embedding_model, embedding_dim, doc/alias/file counts, exported_at
domain.json     description + alias list
documents.jsonl one row per doc: doc_id, text, tags, source, created_at, metadata, embedding_b64
files/<id>.<ext> original uploaded artefacts, keyed by _ob2_import_file_id
```

Embeddings are packed as raw little-endian float32 then base64-encoded. The
dimension is implied by `manifest.embedding_dim`.

#### `POST /admin/domains/import` (global admin)

Restore a previously exported `.ob2bundle`. Multipart form-data:

| Field | Required | Notes |
|---|---|---|
| `bundle` | yes | The `.ob2bundle` file |
| `target_domain` | no | Restore under this name instead of the original (lowercase letters, numbers, hyphens, ≤64 chars) |

```bash
curl -X POST -H "Authorization: Bearer ob2_..." \
     -F "bundle=@backup.ob2bundle" \
     -F "target_domain=netsec-restored" \
     http://localhost:7600/admin/domains/import
```

```json
{
  "ok": true,
  "domain": "netsec-restored",
  "source_domain": "netsec",
  "doc_count": 117,
  "alias_count": 4,
  "file_count": 9
}
```

`doc_id`s are regenerated on import (the schema declares `doc_id` globally
unique). The original is preserved under each doc's metadata as
`_ob2_orig_doc_id`. File ids and the linkage between docs and uploaded
files survive intact, so signed-URL citations remain valid.

**Error responses:**

| Status | `error` field | Reason |
|---|---|---|
| 400 | `bundle_invalid` | Not a gzip tarball, missing required entries, or malformed rows |
| 400 | `unsupported_bundle_version` | `manifest.version` not understood by this build |
| 400 | `embedding_model_mismatch` | Bundle's embedding model differs from the local install |
| 400 | `embedding_dim_mismatch` | Embedding dimension differs |
| 400 | `invalid_domain_name` | `target_domain` is not lowercase letters/numbers/hyphens or exceeds 64 chars |
| 409 | `domain_exists` | Target domain already has docs, aliases, or a seed entry |
| 413 | (n/a — message in `error`) | Bundle exceeds the 1 GB cap |

The bundle cap is intentional. Re-embedding on import (the path that would
let bundles cross between embedding models) is not implemented; mismatches
hard-fail.

### LLM Management — provider-aware (`/admin/llm/*`, global admin)

The dashboard's **LLMs** tab is built on these endpoints. They dispatch through the active provider (`getProvider()`), so the same routes work for Ollama and llama.cpp. All require global admin (auth inherited from the parent `/admin/*` middleware + per-route `requireGlobalAdmin`).

#### `GET /admin/llm/capabilities`

```bash
curl -b cookies.txt http://localhost:7600/admin/llm/capabilities
```

Returns the active provider's capability map. Used by the dashboard once on page load to decide which controls to render.

```json
{
  "provider": "llamacpp",
  "capabilities": {
    "canList": true,
    "canPull": true,
    "canDelete": true,
    "canLoad": true,
    "canUnload": true,
    "canWarm": false
  }
}
```

#### `GET /admin/llm/active`

Returns the active provider id and its current model label (drives the status-header badge). For Ollama this is `runtime.ollama.model`; for llamacpp it's the manager's loaded model from `/healthz` (cached 5s in the provider).

```json
{ "provider": "llamacpp", "model": "qwen2.5-7b-instruct.Q4_K_M.gguf" }
```

Errors degrade to placeholder strings (`(not loaded)`, `(manager unreachable)`, `(manager error 500)`) — this endpoint never returns 5xx because chat must continue working through a degraded badge.

#### `GET /admin/llm/models`

```json
{
  "models": [
    {
      "name": "qwen2.5-7b-instruct.Q4_K_M.gguf",
      "size_bytes": 4400000000,
      "modified_at": "2026-04-29T12:00:00Z",
      "details": { "parsed": { "arch": "qwen2", "quant": "Q4" }, "is_loaded": true }
    }
  ]
}
```

#### `POST /admin/llm/load`

```bash
curl -b cookies.txt -X POST -H 'Content-Type: application/json' \
  -d '{"filename":"qwen2.5-7b-instruct.Q4_K_M.gguf","ctx_size":8192,"gpu_layers":-1,"parallel_slots":1}' \
  http://localhost:7600/admin/llm/load
```

llamacpp only (501 for Ollama which loads on-demand). Returns 200 on success, 404 if filename not found in `models_dir`, 502 if the manager is unreachable, 500 with `stderr_tail` on spawn failure.

#### `POST /admin/llm/unload`

Idempotent. Returns 200 even if nothing was loaded.

#### `POST /admin/llm/restart`

llamacpp only. Re-spawns the currently loaded model with optional ctx_size / gpu_layers / parallel_slots overrides.

```bash
curl -b cookies.txt -X POST -H 'Content-Type: application/json' \
  -d '{"ctx_size":4096}' http://localhost:7600/admin/llm/restart
```

400 if nothing is loaded.

#### `POST /admin/llm/pull`

Provider-aware NDJSON streaming. Body is a discriminated union:

- `{"source":"ollama","name":"gemma3:4b"}` — Ollama only (400 otherwise)
- `{"source":"url","url":"https://example.com/model.gguf"}` — llamacpp only
- `{"source":"hf","repo":"owner/repo","file":"model.Q4_K_M.gguf"}` — llamacpp only

Mismatched source/provider returns 400. Streams NDJSON progress frames; terminal frame is `{"status":"success",...}` or `{"status":"error","message":"..."}`.

```bash
curl -bN -X POST -H 'Content-Type: application/json' \
  -d '{"source":"hf","repo":"bartowski/gemma-2-2b-it-GGUF","file":"gemma-2-2b-it-Q4_K_M.gguf"}' \
  http://localhost:7600/admin/llm/pull
```

#### `DELETE /admin/llm/models/:filename`

```bash
curl -b cookies.txt -X DELETE http://localhost:7600/admin/llm/models/old-model.gguf
```

Returns 409 `in_use` if the model is currently loaded (POST `/admin/llm/unload` first), 404 if not found.

---

### LLM Management — Ollama-specific (`/admin/ollama/*`, global admin)

These predate the provider abstraction and remain for backward compatibility. **They return 503 `wrong_provider` when `OB2_LLM_PROVIDER` is not `ollama`** — operators in llamacpp mode should use `/admin/llm/*` instead.

#### `GET /admin/ollama/models`

```json
{
  "active_model": "gemma4:26b",
  "env_pinned": true,
  "env_var": "OB2_OLLAMA_MODEL",
  "ollama_url": "http://host.docker.internal:11434",
  "installed": [
    {
      "name": "gemma4:26b",
      "size_bytes": 17987581215,
      "modified_at": "2026-04-24T23:40:42Z",
      "loaded": true,
      "parameter_size": "25.8B",
      "quantization": "Q4_K_M"
    }
  ],
  "loaded": [
    {"name": "gemma4:26b", "size_vram": 18203847168, "expires_at": "2026-04-26T17:00:00Z"}
  ],
  "active_pulls": [/* in-flight pull jobs, see /pull */]
}
```

`env_pinned: true` means `OB2_OLLAMA_MODEL` is set in the container env and
overrides the runtime config. The switch endpoint refuses while pinned.

#### `POST /admin/ollama/model`

**Body:** `{"model": "llama3.1:8b"}`

Validates the model is installed, persists `ollama.model` to runtime config,
unloads the previous model (`keep_alive: 0`), then warms the new one with a
1-token generate. Returns immediately on success:

```json
{"ok": true, "warmed": true, "model": "llama3.1:8b", "previous_model": "gemma4:26b"}
```

| Status | `error` field | Reason |
|---|---|---|
| 400 | `model_not_installed` | Pull it first via `/admin/ollama/pull` |
| 409 | `model_pinned_by_env` | `OB2_OLLAMA_MODEL` is set; remove from `.env` and restart |
| 502 | (n/a — message in `error`) | Ollama unreachable or returned non-200 |

If the swap succeeds but the warmup call fails, the response includes
`warmed: false` and `warm_error`. The model is still selected — only the
"keep it hot" step failed.

#### `DELETE /admin/ollama/models/:name`

Deletes a model from disk. Refuses with 409 if `name` is the active model
(switch first). Issues a best-effort unload before delete so the file isn't
held open.

#### `POST /admin/ollama/pull`

**Body:** `{"model": "llama3.1:8b"}`

Starts a background pull job. Returns the job record with status `running`:

```json
{
  "id": "186339b0-...",
  "model": "llama3.1:8b",
  "status": "running",
  "message": "starting",
  "total_bytes": 0,
  "completed_bytes": 0,
  "percent": 0,
  "started_at": "2026-04-25T18:08:27Z",
  "finished_at": null,
  "error": null
}
```

If a pull is already running for the same model, returns the existing job
record (no duplicate spawn).

#### `GET /admin/ollama/pull/:job_id`

Polls the job. Status transitions: `pending → running → done | error |
canceled`. The dashboard polls every 1.5 s while any pull is active. Jobs
are kept in memory; a server restart clears the list (Ollama itself keeps
the partial download for resume on a second pull).

#### `POST /admin/ollama/pull/:job_id/cancel`

Aborts an in-flight pull. The job's terminal status becomes `canceled`.

### Knowledge Graph

Lightweight graph-RAG built on entity + relationship extraction. Toggles
live in the runtime config (`graph.enabled`, `graph.extraction_enabled`)
and are surfaced in the dashboard's Graph tab. All endpoints return JSON.

#### `GET /admin/domains/:domain/graph/stats` (read on domain)

```json
{
  "domain": "netsec",
  "entity_count": 142,
  "mention_count": 318,
  "edge_count": 87,
  "last_extraction_at": "2026-04-25T22:14:11+00:00"
}
```

#### `GET /admin/domains/:domain/graph/entities` (read on domain)

Query params: `limit` (default 200), `offset`, `type` (PERSON/ORG/PLACE/PRODUCT/EVENT/CONCEPT/OTHER), `q` (substring filter on name).

```json
{
  "entities": [
    {"entity_id": "...", "name": "Borges", "type": "PERSON",
     "mention_count": 7, "first_seen": "...", "last_seen": "..."}
  ]
}
```

#### `GET /admin/domains/:domain/graph/edges` (read on domain)

Query params: `src_id` (filter to edges touching this entity), `limit` (default 10000).

```json
{
  "edges": [
    {"src_id": "...", "dst_id": "...", "relation": "wrote",
     "weight": 2, "evidence_doc_id": "..."}
  ]
}
```

#### `GET /admin/domains/:domain/graph/entities/:eid/docs` (read on domain)

```json
{
  "docs": [
    {"doc_id": "...", "snippet": "first 280 chars…",
     "metadata": {...}, "created_at": "..."}
  ]
}
```

#### `POST /admin/domains/:domain/graph/backfill` (admin on domain)

Starts an async re-extraction pass over every user doc in the domain.
Returns the job record with status `pending`.

```json
{"id": "bf-...", "domain": "netsec", "status": "pending",
 "total_docs": 0, "completed_docs": 0, "percent": 0,
 "started_at": "...", "finished_at": null, "error": null}
```

#### `GET /admin/graph/backfills/:job_id` (global admin)

Polls the job. Status transitions: `pending → running → done | error | canceled`.

#### `POST /admin/graph/backfills/:job_id/cancel` (global admin)

Cooperative cancel — sets a flag the worker checks between docs.

#### `GET /admin/graph/backfills` (global admin)

Lists active and recently-finished backfills (kept in memory).

#### `GET /admin/graph/overlap?domains=a,b,c` (auth-filtered)

Cross-domain entity overlap. Requested `domains` are filtered to the
caller's readable set; entities returned are those whose `(lower(name), type)`
appears in two or more selected domains.

```json
{
  "overlap": [
    {"name": "Alice", "type": "PERSON",
     "domains": [
       {"entity_id": "...", "domain": "work", "name": "Alice", "type": "PERSON", "mention_count": 12},
       {"entity_id": "...", "domain": "personal", "name": "Alice", "type": "PERSON", "mention_count": 3}
     ]}
  ]
}
```

#### `GET /admin/domains/:domain/graph/export.gexf` (read on domain)

Downloads the domain's entity graph as a GEXF 1.3 XML file for use in Gephi or other graph tools. Fetches up to 10 000 entities and 50 000 edges. Orphaned edges (referencing a non-existent entity) are silently filtered.

**Response:** `application/xml` with `Content-Disposition: attachment; filename="<domain>-graph-<timestamp>.gexf"`

**GEXF node attributes:** `entity_type` (string), `mention_count` (integer)

**GEXF edge attributes:** `relation` (string); `weight` (float — built-in GEXF field, maps to edge co-occurrence count)

```bash
curl -H "Authorization: Bearer ob2_..." \
  "http://localhost:7600/admin/domains/netsec/graph/export.gexf" \
  -o netsec-graph.gexf
```

### Alias Management

#### `GET /admin/domains/:domain/aliases`

```json
{"aliases": [{"alias": "TLS", "canonical": "tls-certificate-check"}]}
```

#### `POST /admin/domains/:domain/aliases` (admin on domain)

**Body:** `{"alias": "TLS", "canonical": "tls-certificate-check"}`

#### `DELETE /admin/domains/:domain/aliases/:alias` (admin on domain)

### File Ingestion

#### `POST /admin/domains/:domain/import`

Upload a file. Multipart form-data, field name `file`.

```bash
curl -X POST http://localhost:7600/admin/domains/netsec/import \
  -H "Authorization: Bearer ob2_..." \
  -F "file=@report.pdf"
```

**Sync response (< 25 MB, Office formats):**
```json
{"ok": true, "chunks_captured": 14, "file_id": "<uuid>", "async": false}
```

**Async response (large, audio, ZIP):**
```json
{"ok": true, "async": true, "job_id": "<uuid>"}
```

**Permission required:** `write` on domain.

#### `POST /admin/domains/:domain/import/url`

Ingest from a URL.

```bash
curl -X POST http://localhost:7600/admin/domains/netsec/import/url \
  -H "Authorization: Bearer ob2_..." \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/runbook.html"}'
```

SSRF denylist applied (RFC-1918, loopback, link-local, bare IPs blocked).

#### `GET /admin/domains/:domain/import/jobs/:id`

Poll async job status.

```json
{"id": "<uuid>", "status": "running", "domain": "netsec", "filename": "report.pdf", "created_at": "...", "updated_at": "..."}
```

`status` values: `queued` | `running` | `done` | `error`.

#### `GET /admin/domains/:domain/imports/:file_id`

Download the original file. Two auth paths:

1. **Signed URL** (no session required): `?t=<hmac_token>&exp=<unix_seconds>` — 24-hour TTL, HMAC-SHA256 signed with `OB2_SESSION_SECRET`. Embedded in chat citations.
2. **Standard auth**: session cookie or `Authorization: Bearer` header.

```bash
# With session cookie
curl -sb cookies.jar "http://localhost:7600/admin/domains/netsec/imports/<file_id>"

# With signed URL (from chat citation)
curl "http://localhost:7600/admin/domains/netsec/imports/<file_id>?t=<token>&exp=<exp>"
```

### User Management (global admin only)

#### `GET /admin/users`

List all users (API keys masked to last 4 chars).

#### `POST /admin/users`

Create a user.

```bash
curl -X POST http://localhost:7600/admin/users \
  -H "Authorization: Bearer ob2_..." \
  -H "Content-Type: application/json" \
  -d '{
    "username": "alice",
    "domains": {"netsec": "write", "runbooks": "read"},
    "global_admin": false
  }'
```

**Response:** `{"ok": true, "username": "alice", "key": "ob2_<full_key_shown_once>", ...}`

#### `PATCH /admin/users/:username`

Update permissions or global_admin flag.

**Body:** `{"domains": {"infra": "admin"}, "global_admin": false}` — fields optional.

#### `POST /admin/users/:username/password`

Set or reset a user's password. Revokes their existing sessions.

**Body:** `{"password": "at-least-8-chars"}`

Not allowed on the `_admin` bootstrap user.

#### `DELETE /admin/users/:username`

Soft-revoke: sets `enabled: false`, invalidates API key and sessions. Record preserved for audit.

#### `POST /admin/users/:username/invite`

Send (or resend) an invite email.

```bash
curl -X POST http://localhost:7600/admin/users/alice/invite \
  -H "Authorization: Bearer ob2_..." \
  -H "Content-Type: application/json" \
  -d '{"email": "alice@example.com"}'
```

#### `GET /admin/users-raw` / `PUT /admin/users-raw`

Read and write `users.json` directly (raw JSON editor). `PUT` includes `mtime` for optimistic-concurrency check; returns 409 if the file was edited in between. The zero-global-admin rail applies: you cannot save a file that leaves no active global admin.

### Sync Status

#### `GET /admin/sync-status`

```json
{
  "pending_docs": 0,
  "last_sync_at": "2026-04-22T19:03:49+00:00",
  "last_sync_docs": 12,
  "last_sync_ms": 7.0,
  "pgvector_reachable": true
}
```

### Config

#### `GET /admin/config`

Returns the current resolved runtime config (YAML merged with env overrides).

#### `PUT /admin/config`

**Body:** YAML string. Validates and writes to `config.yaml`. Hot-reloads on next request. Returns 400 on validation error.

#### `POST /admin/test-ollama`

Tests connectivity to Ollama. Returns `{ok, latency_ms, models: [...], error?}`.

#### `POST /admin/test-pgvector`

Tests connectivity to pgvector. Returns `{ok, latency_ms, schema_version, error?}`.

#### `GET /admin/smtp-status`

Returns `{configured: boolean}`. `true` when the mailer can send AND `mail.public_url` is set (i.e., end-to-end ready for invite/reset email flows). The dashboard's Email card uses this to render the green/amber dot.

#### `GET /admin/config/mail`

Returns the current mail config with the password masked. Includes `env_locked` (per-field flag indicating env-var pinning) and `env_keys` (per-field → real env var name, so UI tooltips can name the correct `OB2_SMTP_*` / `OB2_PUBLIC_URL` variable).

#### `POST /admin/config/mail`

Body: any subset of `MailConfig` (`driver`, `host`, `port`, `user`, `pass`, `secure`, `from`, `public_url`). Validated, then overlaid onto the existing `/data/config.yaml` — other config sections (`llm`, `llamacpp`, `openai`, `anthropic`, `gemini`, `graph`, `context`, etc.) are preserved untouched. An empty or `••••` `pass` field is treated as "keep the existing password". Hot-reloads on the next outbound send; no restart needed.

#### `POST /admin/smtp/test`

Body: `{to: "you@example.com"}`. Sends a one-shot diagnostic email. Returns `{ok}` on success or `{error}` on failure (with the SMTP server's error text, e.g. `"SMTP send failed: 535: 5.7.8 ..."` for auth rejection).

Requires `mail.host` + `mail.from` (+ valid SMTP credentials if the server demands auth). **Does NOT require `mail.public_url`** — that field is only used to build invite/reset URLs, which the test send doesn't do.

---

## Health Check

### `GET /health`

No authentication required.

```bash
curl http://localhost:7600/health
```

```json
{
  "status": "ok",
  "server": true,
  "sidecar": true,
  "backend": "two-tier"
}
```

`sidecar: false` means the Python/Rust process failed to start or is not responding to JSON-RPC pings.

---

## CLI Tools

### `ob2 import csv`

```bash
python -m cli.import_cmd csv \
  --domain infra \
  --file hosts.csv \
  --schema schema.yml \
  --batch-size 256
```

`schema.yml`:
```yaml
doc_id_column: hostname
source_name: cmdb-hosts
text_template: |
    Host: {hostname}
    Role: {role}
    Datacenter: {dc}
tags_columns: [role, dc, owner]
```

### `ob2 import docs`

```bash
python -m cli.import_cmd docs \
  --domain runbooks \
  --dir ./runbooks/ \
  --recursive \
  --tags team production \
  --batch-size 256
```

### `ob2 import pdf`

```bash
python -m cli.import_cmd pdf \
  --domain docs \
  --file report.pdf \
  --tags quarterly finance
```

### `ob2 import wiki`

```bash
# Confluence HTML export
python -m cli.import_cmd wiki \
  --domain wiki \
  --export confluence-export.zip \
  --source confluence

# Notion markdown export
python -m cli.import_cmd wiki \
  --domain wiki \
  --export notion-export/ \
  --source notion
```

### `ob2 storage migrate`

```bash
python -m cli.migrate \
  --from sqlite:./ob2.db \
  --to postgres://ob2:secret@localhost:5433/ob2 \
  --dim 384 \
  --batch 256
```

Streaming migration with per-domain row-count verification.

---

## Dashboard

### `GET /dashboard`

Returns the single-page admin UI. The page is public; all data endpoints it calls are authenticated. `Cache-Control: no-store` is set to prevent stale JS.

Dashboard tabs: Overview, Domains, Users, Services, Config, Processes, Chat, Profile. See `docs/architecture.md` for the full tab description.

#### `GET /graph`

Full-screen graph explorer (no auth in the route handler — auth enforced client-side via `GET /auth/me`). Accepts optional `?domain=<name>` query parameter to pre-select a domain on load.
