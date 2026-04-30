# OB2 Process Flows

All flows are sidecar-runtime-agnostic. The Deno server speaks the same JSON-RPC to both the Python sidecar (default) and the Rust sidecar (`OB2_SIDECAR_RUNTIME=rust`).

## 1. Capture via MCP `capture_knowledge`

```
MCP client (Claude Code / Cursor)
      |
      | POST /mcp  {tool: "capture_knowledge", domain, text}
      | header: x-brain-key: ob2_...
      v
Auth middleware
      |
      +-- user API key -> UserRecord -> check "write" on domain
      +-- brain key (bootstrap) -> global admin
      |
      v (403 if no write permission)
      |
Generate doc_id (UUID)
      |
      v
EmbedBatcher.embed(text)          (buffers up to 32 docs or 100 ms)
      |
      v
GPU batch encode                  (CUDA / MPS / CPU auto-detect)
all-MiniLM-L6-v2, 384-dim
      |
      v
StorageBackend.upsert_doc         (two-tier: SQLite, 151 µs)
synced_at = NULL                  (marks pending for SyncWorker)
      |
      v
Return immediately to client      "Captured to @domain as doc <id>
                                   at <ISO-8601>. Domain has N doc(s)."
      |
      v (background)
SyncWorker (every 5 s)
      |
      v
Batch upsert to pgvector          (HNSW index, cosine)
      |
      v
mark_synced in SQLite
```

## 2. File Ingestion via Dashboard Upload

### Sync path (small files, < 25 MB; Office files)

```
User drag-drops file onto Domains tab
      |
      v
POST /admin/domains/:domain/import   (multipart/form-data)
      |
      v
magic-byte sniffer                   detect true type (PDF, DOCX, PNG, MP3, …)
      |
      v
ZIP-bomb check                       reject if > OB2_IMPORT_MAX_BYTES (250 MB)
      |
      v
Persist original bytes               /data/imports/<domain>/<file_id>.<ext>
      |                              (ob2_data volume, served later as original)
      v
import/runner.ts dispatch()          sync path: convert + capture inline
      |
      v
Python sidecar: method_convert_to_markdown
      |                     (MarkItDown + OCR fallback for scanned PDFs:
      |                      ocrmypdf --rotate-pages --deskew --clean
      |                               --oversample 300 tessdata_best)
      v
Markdown chunker (header-aware, overlap)
      |
      v
EmbedBatcher -> GPU -> upsert_docs_batch
      |                metadata includes _ob2_import_file_id, _ob2_import_filename
      v
HTTP 200  {ok: true, chunks_captured: N, file_id: "...", async: false}
Dashboard updates doc count
```

### Async path (large files, audio, ZIP archives)

```
POST /admin/domains/:domain/import   (same endpoint)
      |
      v
Sniffer + size check -> async dispatch
      |
      v
Job created in import/jobs.ts        id = UUID
Persisted to /data/import-jobs.json  (survives server restart)
      |
      v
HTTP 202  {ok: true, async: true, job_id: "..."}
      |
      v (background worker)
Same convert -> chunk -> embed -> upsert pipeline
      |
Dashboard polls GET /admin/domains/:domain/import/jobs/:id
with exponential backoff until status = "done" or "error"
```

### URL ingestion

```
POST /admin/domains/:domain/import/url   {url: "https://..."}
      |
      v
URL fetcher:
  1. DNS-resolve the hostname
  2. Check resolved IPs against SSRF denylist (127.0.0.0/8, RFC-1918, link-local, …)
  3. Reject bare IP addresses
      |
      v (403 if blocked)
      |
Fetch content, detect MIME type
      |
      v
Same convert -> chunk -> embed -> upsert pipeline
```

## 3. Chat Flow with Clickable Citation

```
User sends: "how do I check certificate expiry?"
in Open WebUI (no @domain prefix, model = "ob2")
      |
      v
Open WebUI -> POST :7600/v1/chat/completions
  Authorization: Bearer <OB2_OPENWEBUI_SERVICE_TOKEN>
  X-OpenWebUI-User-Name: alice
  {model: "ob2", messages: [{role:"user", content:"how do I..."}]}
      |
      v
Auth middleware:
  service token match + X-OpenWebUI-User-Name header
  -> impersonate "alice" -> her per-domain ACL applies
      |
      v
resolveDomain():  no @prefix -> domain = null
      |
      v
sidecar.buildMultiContext(
  domains = all domains alice has "read" on,
  query = "how do I check certificate expiry?",
  budget = 6000 tokens
)
      |
      v
Python sidecar: method_build_multi_context
  Single pgvector scan across all assigned domains
  Ranks chunks together by cosine similarity
  Compresses to token budget
      |
      v
augmentWithContext():
  Assembles system prompt with sources block
  Each source includes domain, date, content snippet
  Signs a download URL for each file-backed chunk:
    /admin/domains/<domain>/imports/<file_id>?t=<HMAC>&exp=<unix>
  (24-hour TTL, usable without an OB2 session cookie)
      |
      v
POST http://host.docker.internal:11434/api/chat
  (Ollama, gemma3:4b or configured model)
  Stream NDJSON -> transform to OpenAI SSE
      |
      v
LLM response with [Source: domain — date] citations
Each source citation footer contains the signed download URL
      |
      v
Open WebUI renders response; user clicks source link
-> browser fetches /admin/domains/:domain/imports/:file_id?t=...
-> server verifies HMAC, serves original file
```

## 4. Open WebUI SSO Flow

```
User is logged into OB2 dashboard at :7600
      |
      v
User clicks "Chat" tab (or the Chat link)
      |
      v
Browser: GET :7600/auth/openwebui-handoff
  (requires valid OB2 session cookie)
      |
      v
Server: sign 1-minute HMAC handoff token
  payload: {u: "alice", e: "alice@example.com", exp: now + 60s}
  signed with OB2_SESSION_SECRET
      |
      v
Server: 302 redirect to :7601/?sso=<token>
      |
      v
Proxy listener (port 7601, proxy/openwebui.ts):
  1. Extract sso= query param
  2. Verify HMAC signature + expiry (rejects replays after 1 min)
  3. Issue 12-hour SSO cookie (ob2_sso) on :7601 origin
  4. Strip all client-supplied X-Forwarded-* and X-OB2-* headers
  5. Inject X-Forwarded-Email: alice@example.com on every upstream req
  6. Redirect to :7601/
      |
      v
ob2-openwebui:8080 (Open WebUI):
  WEBUI_AUTH_TRUSTED_EMAIL_HEADER=X-Forwarded-Email
  DEFAULT_USER_ROLE=user
  BYPASS_MODEL_ACCESS_CONTROL=true
  -> auto-signs in as alice (or creates account on first visit)
      |
      v
Open WebUI loads; user sees the OB2 model in model selector
User chats -> requests flow back through :7600/v1 as shown in flow 3
```

## 5. Bootstrap + Close-Down

```
First boot (users.json empty or absent):
      |
      v
POST /auth/login  {username: "_admin", password: <OB2_BRAIN_KEY>}
      |
      v
Synthetic _admin session: global_admin=true, no real UserRecord
      |
      v
Admin creates real global admin user via Users tab
Sets their password
      |
      v
Real global admin exists -> brain-key gate closes:
  - POST /auth/login as "_admin" -> 403
  - Authorization: Bearer <OB2_BRAIN_KEY> on /admin/* -> 401
  - x-brain-key: <OB2_BRAIN_KEY> on /mcp -> 401
  - Any live _admin browser sessions evicted immediately

Gate is auto-reversible:
  If every enabled non-_admin global admin is removed from
  users.json, the brain key re-opens for re-bootstrap.

Break-glass (locked out):
  docker exec -it ob2-server \
    /app/.deno/bin/deno run --allow-read --allow-write --allow-env \
    /app/server/scripts/reset-admin.ts <username> \
    --password '<temp>' --promote
  (edits users.json in place; server hot-reloads on mtime change)
```

## 6. Two-Tier Sync (SyncWorker)

```
SyncWorker thread (daemon, background)
      |
      +-----> [Stop signal?] ---yes---> final drain attempt -> stop
      |
      no
      |
      v
list_unsynced(limit=256) from SQLite
      |
      +-- no pending -> sleep 5 s -> loop
      |
      yes
      |
      v
Group by domain
      |
      v
pgvector.upsert_docs_batch per domain    (HNSW UPSERT)
      |
      +-- success ->
      |     mark_synced in SQLite
      |     log "synced N docs in X ms"
      |     sleep 5 s -> loop
      |
      +-- failure ->
            log "pgvector unreachable, N pending"
            exponential backoff (1 s -> 2 s -> ... -> 60 s cap)
            loop

Reads always try pgvector first; fall back to SQLite if unreachable.
Admin /admin/sync-status shows pending_docs, last_sync_at,
last_sync_docs, last_sync_ms, pgvector_reachable.
```

## 7. Invite and Password-Reset Flow

```
Admin: Users tab -> Create user -> "Send invite email"
      |
      v
Server generates user record (API key, no password)
Generates single-use invite token (32 random bytes; SHA-256 stored)
Sends email with link (7-day TTL)
If SMTP fails, returns invite URL in response body for manual sharing
      |
      v
User clicks link -> POST /auth/accept-invite {token, password}
Server verifies token (hash match + not expired + not used)
Sets password (argon2id hash stored)
Issues session cookie -> user signed in
      |
---
      |
User: sign-in page -> "Forgot password?" -> enter email
      |
      v
POST /auth/forgot-password {email}
Server always responds the same way (anti-enumeration)
If email matches an enabled user, sends reset link (1-hour TTL)
      |
      v
User clicks link -> POST /auth/reset-password {token, password}
Old sessions revoked, new password set
```

## 8. Domain Backup (Export / Import)

**Export** — admin downloads a domain as a single `.ob2bundle` (gzip tar):

```
Dashboard: Manage @domain -> Settings tab -> "Export @domain as .ob2bundle"
      |
      v
GET /admin/domains/:domain/export   (admin perm on the domain)
      |
      v
admin.ts allocates /tmp/ob2-export-<uuid>.ob2bundle
      |
      v
sidecar.call("export_domain", {domain, out_path})  [JSON-RPC]
      |
      v
Python sidecar:
  1. read description from seed doc
  2. _backend.list_aliases(domain)
  3. _backend.list_docs(domain, limit=1_000_000)  [skip _ob2_system]
  4. for each doc: pack embedding (float32 LE) -> base64
  5. walk /data/imports/<domain>/ for original files
  6. tarfile.open(out_path, "w:gz"):
        manifest.json, domain.json, documents.jsonl, files/...
      |
      v
admin.ts opens the temp file, streams it as the HTTP body.
Browser sees Content-Disposition: attachment and saves the bundle.
The temp file is unlinked when the stream closes.
```

**Import** — global admin restores a bundle, optionally under a new name:

```
Dashboard: Domains tab -> "Import Domain..." -> pick file -> (optional) target
      |
      v
POST /admin/domains/import   multipart: bundle=<file>  target_domain=<opt>
                              (global admin only)
      |
      v
admin.ts saves the upload to /tmp/ob2-import-<uuid>.ob2bundle
      |
      v
sidecar.call("import_domain", {in_path, target_domain?})
      |
      v
Python sidecar:
  1. tarfile.open(in_path, "r:gz")
  2. validate manifest:
       format == "ob2-domain-bundle"
       version == 1
       embedding_model == EMBEDDING_MODEL    (else 400)
       embedding_dim   == EMBEDDING_DIM      (else 400)
  3. refuse if target domain has any doc, alias, or seed       (else 409)
  4. upsert seed doc (with description) so the domain exists
  5. stream documents.jsonl in 256-doc batches:
        unpack base64 -> float32 -> DocRecord
        regenerate doc_id (originals collide on the global UNIQUE
        constraint), stash original under metadata._ob2_orig_doc_id
        upsert_docs_batch -> SQLite (Tier 1)
  6. upsert each alias from domain.json
  7. extract files/ into /data/imports/<target_domain>/
      |
      v
SyncWorker pushes the new docs to pgvector on its next 5 s tick.
admin.ts unlinks /tmp/ob2-import-<uuid>.ob2bundle and returns
counts to the dashboard.
```

Bundle layout:

```
manifest.json     {format, version, domain, embedding_model, embedding_dim,
                   exported_at, doc_count, alias_count, file_count}
domain.json       {description, aliases: [{alias, canonical}, ...]}
documents.jsonl   one JSON row per document, embedding_b64 = float32 LE
files/<id>.<ext>  original uploaded artefacts, keyed by _ob2_import_file_id
```

System docs (those carrying `_ob2_system: true`) are NOT exported. They are
re-created on import from the description in `domain.json`. File ids and the
metadata link from each doc to its source file are preserved verbatim, so
signed-URL citations and the dashboard's "Download original" links continue
to work after the round-trip.

## 9. Domain Deletion (Cascade Semantics)

Domains are global, not per-user — a domain is one shared store. Deleting
it removes the data for everyone who had access in a single atomic pass.
The dashboard surfaces this only behind a confirmation modal in
**Manage @domain → Settings → Danger zone**.

```
Dashboard "Delete @domain..."   (admin perm on the domain)
      |
      v
DELETE /admin/domains/:domain
      |
      v
sidecar method_delete_domain
      |
      v
TwoTierBackend.delete_domain(domain):
  pgvector (canonical):                        sqlite (write cache):
    BEGIN                                        BEGIN
    DELETE FROM docs WHERE domain = $1           DELETE FROM docs_vec WHERE rowid IN (...)
    DELETE FROM entity_aliases WHERE ...         DELETE FROM docs WHERE domain = ?
    DELETE FROM source_imports WHERE ...         DELETE FROM entity_aliases WHERE ...
    DELETE FROM entity_mentions WHERE ...        DELETE FROM source_imports WHERE ...
    DELETE FROM entity_edges WHERE ...           DELETE FROM entity_mentions WHERE ...
    DELETE FROM entities WHERE ...               DELETE FROM entity_edges WHERE ...
    COMMIT                                       DELETE FROM entities WHERE ...
                                                 COMMIT
      |
      v
Sidecar invalidates the in-memory ContextEngine cache for that domain
so retrieval re-hydrates (now empty) on the next query.
      |
      v
{ok: true, domain, deleted_count: N}
```

**Side-effects visible to users:**

- Every user who had read on the domain sees zero docs immediately on
  next chat / search / dashboard refresh.
- `@<domain>` chat prefix in Open WebUI returns "no knowledge stored".
- Auto-route classifier no longer considers the deleted domain.

**What the cascade does NOT clean (deliberate, kept for forensics +
re-grant ergonomics):**

```
users.json                   /data/imports/<domain>/         webui.db (Open WebUI)
  user.domains                  PDFs / images / audio          per-user chat history
  ["<domain>"] entries          original bytes                 messages quoting the
  remain pointing               linger on disk;                 deleted domain still
  at nothing.                   citation downloads              show with their
  Re-grant overwrites.          return 404.                    original text.
```

For a clean, restorable archive *before* deletion, the admin can
**Manage @domain → Settings → Backup → Export @&lt;domain&gt; as .ob2bundle**
(see section 8) — that bundle round-trips the docs, aliases, files, and
graph into a single tarball.

## 10. LLM Management (Switch / Pull / Delete)

The dashboard's **LLMs** tab speaks to Ollama through a thin Deno wrapper
(`server/ollama/client.ts`). All operations target the same Ollama host the
chat gateway uses (`getRuntime().ollama.url`).

**Switch active model:**

```
Dashboard "LLMs" tab -> "Switch active model" -> pick from dropdown -> Apply
      |
      v
POST /admin/ollama/model  {model}     (global admin only)
      |
      v
1. Refuse with 409 if OB2_OLLAMA_MODEL is set in env
2. GET ollama/api/tags   -> verify model is installed (else 400)
3. writeRuntime({ollama:{...,model}})  persisted to /data/config.yaml
4. POST ollama/api/generate  {model: previous, keep_alive: 0}    [unload]
5. POST ollama/api/generate  {model: new, prompt:"ok", num_predict:1,
                              keep_alive: "24h"}                  [warmup]
      |
      v
{ok, warmed, model, previous_model}
Every subsequent /v1/chat/completions, MCP chat_knowledge, and classifier
call reads getRuntime().ollama.model and uses the new model.
```

**Pull a model (long-running, async):**

```
Dashboard "Pull a new model" -> input "llama3.1:8b" -> Pull
      |
      v
POST /admin/ollama/pull  {model}      (global admin only)
      |
      v
startPull(model):
  - allocate job_id (UUID)
  - if a pull for this model is already running, reuse its job
  - kick off background fetch:
      POST ollama/api/pull  {name: model, stream: true}
      |
      v
  Stream NDJSON frames:
    {"status":"pulling manifest"}
    {"status":"downloading","digest":"sha256:...",
     "total":4294967296,"completed":120586240}
    ...
    {"status":"success"}
  |
  v
  On every frame:
    - update job.message
    - update job.total_bytes / completed_bytes
    - recompute job.percent
  Terminal: status -> "done" | "error" | "canceled"
      |
      v
{job_id, status:"running", percent:0, ...}

Dashboard polls every 1.5 s:
  GET /admin/ollama/pull/:job_id -> {status, percent, message, ...}
  Stops polling when no jobs are running.

POST /admin/ollama/pull/:job_id/cancel
  -> AbortController fires on the underlying fetch -> job marked "canceled"
  Ollama keeps the partial download for resume on a future pull.
```

**Delete a model:**

```
Dashboard "Installed models" table -> Delete next to a non-active row
      |
      v
DELETE /admin/ollama/models/:name     (global admin only)
      |
      v
1. Refuse with 409 if name == getRuntime().ollama.model
2. POST ollama/api/generate {model:name, keep_alive:0}    [best-effort unload]
3. DELETE ollama/api/delete  {name}
```

**Env-pinned override.** Ollama settings go through OB2's runtime config
layer (`server/runtime_config.ts`). When `OB2_OLLAMA_MODEL` is non-empty in
the container env, it overrides the file value at every read — exactly the
same precedence rule the SMTP fields follow. The dashboard surfaces this
via `env_pinned: true` in `GET /admin/ollama/models`, greys out the
switcher, and shows a banner explaining how to unpin (remove the line from
`.env`, restart). The compose default is empty (`${OB2_OLLAMA_MODEL:-}`)
so users without an `.env` pin can drive everything from the dashboard.

## 11. Knowledge Graph (Extraction / Rerank / Backfill)

OB2 supports lightweight Graph RAG: an async LLM pass extracts named
entities + relationships from each captured doc, and chat retrieval
optionally expands the top vector hits along entity edges. Both are off
by default; toggle via `graph.extraction_enabled` and `graph.enabled`
in `/data/config.yaml`.

**Async extraction during capture:**

```
MCP capture_knowledge / dashboard upload
      |
      v
sidecar method_capture (or method_capture_batch)
  - embed text via sentence-transformers
  - upsert_doc into SQLite (Tier 1)
      |
      v
_enqueue_extraction_if_enabled(domain, doc_id, text)
  reads /data/config.yaml; no-op if extraction_enabled is false
      |
      v queue.Queue (one daemon worker thread inside the sidecar)
      |
method_extract_entities:
  POST {ollama.url}/api/chat   format=json, temperature=0, keep_alive=24h
  Strict prompt: 7-type closed vocab (PERSON/ORG/PLACE/PRODUCT/EVENT/CONCEPT/OTHER)
      |
      v parse JSON response
NFKC-normalize names, alias-resolve via entity_aliases
entity_id = sha1(domain|type|lower(name))[:16]   deterministic for round-trip
      |
      v
upsert_entity / upsert_mention / upsert_edge → both tiers via TwoTierBackend
stamp metadata._ob2_graph_extracted_at on the doc
```

Extraction errors (Ollama unreachable, timeout, malformed JSON) are
logged and the worker moves on. Vector RAG keeps working; the doc just
stays unextracted until the next backfill.

**Graph-augmented retrieval (rerank):**

```
/v1/chat/completions  (or @domain prefix)
      |
      v
sidecar method_build_context / method_build_multi_context
  hybrid retrieval (TF-IDF + embedding) -> top_k vector hits
      |
      v if graph.enabled
find_neighbor_docs(domain, [hit.doc_id ...], limit=20)
  one SQL JOIN: mentions x mentions on entity_id where doc_id IN (top hits)
      |
      v
boost = rerank_alpha * max(anchor_score)
each neighbor that wasn't already in the result gets the boost
re-sort, take top_k
      |
      v
pack into compressed_text (existing budget logic), return to gateway
```

Single SQL roundtrip; ~5-25 ms when enabled, 0 ms when disabled.
Multi-domain path groups anchors by source domain so traversal stays
inside the caller's readable set (entities are domain-scoped).

**Backfill (re-extract everything in a domain):**

```
Dashboard "Graph" tab -> Backfill button
      |
      v
POST /admin/domains/:domain/graph/backfill   (admin perm on domain)
      |
      v sidecar method_graph_backfill_start
allocate job_id, spawn daemon thread
list every user doc (skip _ob2_system seeds)
for each: method_extract_entities (replaces stale mentions, re-extracts)
update job.percent / job.message after each doc
      |
      v
Dashboard polls /admin/graph/backfills/:job_id every 2 s
On completion (status=done), reload the Graph tab.
Cancel via POST /admin/graph/backfills/:job_id/cancel  -> cooperative.
```

**Bundle export/import:**

`.ob2bundle` carries graph data alongside docs. Manifest gains
`graph_entity_count`, `graph_mention_count`, `graph_edge_count`. Tar
entries: `entities.jsonl`, `mentions.jsonl`, `edges.jsonl`.

On import, entity_ids are re-hashed under the target domain, mentions
are remapped via the doc_id remap built during docs.jsonl restore, edges
are remapped via the entity_id remap. `recompute_mention_counts`
resyncs `entities.mention_count` from the restored mentions. Old
bundles missing graph files are silently accepted - the domain just
imports without a graph (can be backfilled later).

## 12. MCP Test Runner (`tests/mcp_runner.py`)

```
python3 tests/mcp_runner.py
      |
      v
load_config()  reads OB2_MCP_KEY + OB2_PORT from .env
      |
      v
Open two httpx clients:
  mcp_client   (header: x-brain-key)
  admin_client (header: Authorization: Bearer)
      |
      v
run_suite()  [try/finally guarantees cleanup]

  Group 1 - Happy Path (@ob2-test-alpha)
    capture / search / stats-single / stats-all

  Group 2 - Retrieval Quality (@ob2-test-beta)
    keyword match x3 / semantic match / tagged-doc

  Group 3 - Ollama/chat (@ob2-test-gamma)
    grounded answer / off-topic (no content leak)

  Group 4 - Negative Cases (@ob2-test-error)
    bad key / missing domain / missing field / graceful chat

Cleanup (always):
  DELETE /admin/domains/@ob2-test-{alpha,beta,gamma,error}

Write tests/results.json
Print summary
Exit 0 (all pass) or 1 (any fail)
```

## 13. Upload Provenance

Every captured document carries `_ob2_uploaded_by: "<username>"` in its
metadata. This stamp flows from auth context through all ingestion paths
and surfaces in two places: the dashboard docs table and (optionally)
the LLM context annotations for multi-domain queries.

```
Caller authenticates (API key / session cookie / service token)
      |
      +---> capture_knowledge (MCP)
      |         getAuth().username -> metadata._ob2_uploaded_by
      |
      +---> capture_file (MCP)  or  POST /admin/domains/:d/import  (file/URL)
      |         getAuth()?.username / c.get("auth")?.username
      |         -> IngestRequest.uploaded_by
      |         -> captureChunks() stamps all derived chunks
      |
      v
StorageBackend: docs.metadata JSON
  { "source": "user", "_ob2_uploaded_by": "alice", ... }
      |
      +---> Dashboard (GET /admin/domains/:domain/docs)
      |       metadata._ob2_uploaded_by rendered as "↑ alice"
      |       below each doc's source line in the Domains tab
      |
      +---> Multi-domain chat (method_build_multi_context)
              show_uploader_in_context: true (default, from runtime config)
                  |
                  v
              [1] source=@domain
              The sky is blue.
                (Saved on 2026-04-26; uploaded by alice.)
                  |
              LLM can answer: "Who told you that? Alice did."

              show_uploader_in_context: false
                  |
                  v
              Annotation omitted; _ob2_uploaded_by still stored in DB.
              Toggle via Config tab or OB2_CONTEXT_SHOW_UPLOADER env var.
```

**Single-key mode:** when `users.json` is absent, all captures are attributed
to `_admin`.

**Single-domain queries** (`@domain` prefix): the per-source annotation
format is not used in the single-domain context engine path; uploader
attribution is available in `retrieved_docs` metadata but does not appear
in the compressed text block.

## 14. Full-Screen Graph Explorer

A standalone full-screen page (`/graph`) served by OB2 with a larger Cytoscape.js canvas, per-type filters, live search, and GEXF export. Reached from the dashboard Graph tab via "Open full-screen ↗".

**Opening the explorer:**

```
Dashboard Graph tab → "Open full-screen ↗"
      |
      v
Browser opens /graph?domain=<selected-domain> in a new tab
      |
      v
graph.js boot():
  GET /auth/me  {credentials: 'include'}
      |
      +-- 401 → redirect to /dashboard (not authenticated)
      |
      +-- 200 → initPage()
            |
            v
      GET /admin/domains  {credentials: 'include'}
      Populate domain dropdown (readable domains only)
      Pre-select domain from ?domain= query param
      Render per-type checkboxes (all checked by default)
            |
            v
      loadGraph(domain)
        GET /admin/domains/:domain/graph/entities?limit=500
        GET /admin/domains/:domain/graph/edges?limit=2000
        (parallel)
            |
            v
      applyFilters()
        Filter entities by checked types + search text
        Filter edges to those whose endpoints survive
            |
            v
      buildCytoscape(entities, edges)
        cytoscape({ layout: 'cose', numIter: 500, ... })
        Graph renders; node positions computed synchronously
```

**Interactions:**

```
Type checkbox toggled / search text entered
      |
      v
applyFilters() — re-filters rawEntities/rawEdges in memory,
rebuilds Cytoscape instance (no re-fetch)
      |
      v
Graph re-renders with filtered node/edge set

"Run Layout" clicked
      |
      v
cy.layout({ name: 'cose', numIter: 2000 }).run()
Higher iteration count → better node separation

Node clicked
      |
      v
GET /admin/domains/:domain/graph/entities/:eid/docs?limit=20
Side panel shows entity name, type, mention count,
and doc snippets that mention this entity
```

**GEXF export:**

```
"Export GEXF ↓" clicked (in /graph or dashboard Graph tab)
      |
      v
Browser fetches GET /admin/domains/:domain/graph/export.gexf
      |
      v
admin.ts:
  list_entities(domain, limit=10000)  (sidecar)
  list_edges(domain, limit=50000)     (sidecar — parallel)
      |
      v
buildGexf(): generates GEXF 1.3 XML
  — nodes: entity_id, name, entity_type, mention_count
  — edges: src_id, dst_id, relation, weight
  — orphaned edges filtered (both endpoints must exist)
      |
      v
Content-Disposition: attachment; filename="<domain>-graph-<ts>.gexf"
Browser saves file → open in Gephi for advanced layout / analysis
```
