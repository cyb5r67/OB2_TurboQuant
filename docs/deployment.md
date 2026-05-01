# OB2 Deployment Guide

## Quick Start (Docker — recommended)

```bash
cd /path/to/OB2
export OB2_BRAIN_KEY=your-secure-key-at-least-32-chars
scripts/docker-start.sh

# Optional: include Open WebUI chat surface
scripts/docker-start.sh --with-chat

# Force rebuild after code changes
scripts/docker-start.sh --build
scripts/docker-start.sh --with-chat --build
```

Three containers in Docker Desktop:

| Container | Port | Purpose |
|---|---|---|
| `ob2-server` | 7600 (main), 7601 (Open WebUI proxy) | App server + embeddings |
| `ob2-postgres` | 5433 | pgvector query store |
| `ob2-pgadmin` | 5051 | Database admin UI (login: `admin@ob2.local` / `$OB2_PG_PASSWORD`) |

With `--with-chat`, a fourth container `ob2-openwebui` starts (internal port 8080, reached through the OB2 proxy on 7601).

Verify:
```bash
curl http://localhost:7600/health
# {"status":"ok","server":true,"sidecar":true,"backend":"two-tier"}

open http://localhost:7600/dashboard
# First login: username _admin, password = OB2_BRAIN_KEY
# Create a real admin user under the Users tab, then switch to that user.
```

## Script Reference

| Script | Options | What it does |
|---|---|---|
| `scripts/docker-start.sh` | `--with-chat`, `--with-llamacpp`, `--build` | Starts Docker stack; waits for health. `--with-llamacpp` auto-generates `OB2_LLAMACPP_MANAGER_TOKEN` and sets `OB2_LLM_PROVIDER=llamacpp` in `.env`. |
| `scripts/docker-stop.sh` | `--with-chat`, `--with-llamacpp` | Stops containers. Pass the same profile flags used at start. |
| `scripts/docker-restart.sh` | `--with-chat`, `--with-llamacpp`, `--build` | Stop then start |
| `scripts/start.sh` | `--with-postgres`, `--backend sqlite\|pgvector` | Native server (no Docker for server) |
| `scripts/stop.sh` | `--with-postgres` | Stop native server |
| `scripts/restart.sh` | (passes args through) | Stop then start native |

## Environment Variables

Set in `.env` (or export before running scripts). Docker Compose reads the `.env` file automatically.

### Required

| Variable | Default | Description |
|---|---|---|
| `OB2_BRAIN_KEY` | **(required)** | Bootstrap auth credential + signing seed |

### Server

| Variable | Default | Description |
|---|---|---|
| `OB2_PORT` | `7600` | Main HTTP listen port |
| `OB2_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` in Docker) |
| `OB2_SESSION_SECRET` | *(auto-generated)* | HMAC key for session cookies, SSO tokens, and signed file-download URLs. Set to a stable secret to persist sessions across restarts. |
| `OB2_PUBLIC_URL` | *(empty)* | Public HTTPS URL (e.g., `https://ob2.example.com`). Enables HSTS, unconditional cookie `Secure`, and SMTP link building. |
| `OB2_TRUST_PROXY` | `false` | Set `true` only when a reverse proxy strips `X-Forwarded-For` before adding its own. |
| `OB2_USERS_FILE` | `../users.json` | Path to users + ACL store. In Docker: `/data/users.json`. |
| `OB2_RUNTIME_CONFIG_PATH` | `../config.yaml` | Hot-reloadable runtime config. In Docker: `/data/config.yaml`. |

### Storage

| Variable | Default | Description |
|---|---|---|
| `OB2_STORAGE_BACKEND` | `two-tier` | `sqlite`, `pgvector`, or `two-tier` |
| `OB2_SQLITE_PATH` | `./ob2.db` | SQLite file. In Docker: `/data/ob2.db`. |
| `OB2_PG_URL` | *(empty)* | Postgres connection string. Required for `pgvector` and `two-tier` backends. |
| `OB2_PG_PASSWORD` | `ob2secret` | Used by Docker Compose to set the Postgres password. |
| `OB2_PG_PORT` | `5433` | Host-side Postgres port (avoids conflict with other Postgres instances). |

### LLM

#### Provider selection

| Variable | Default | Description |
|---|---|---|
| `OB2_LLM_PROVIDER` | `ollama` | Active LLM provider for chat: `ollama` or `llamacpp`. Hot-reloaded — switching takes effect on the next request. |
| `OB2_LLM_CLASSIFIER_PROVIDER` | `""` (= same as main) | Optional override: run classification on a different provider than chat. E.g. `provider=llamacpp` + `classifier_provider=ollama` runs chat on llama-server while classifying on a small Ollama model. |
| `OB2_AUTO_ROUTE` | `false` | Enable classifier-based auto-routing (opt-in). |

#### Ollama

| Variable | Default | Description |
|---|---|---|
| `OB2_OLLAMA_URL` | `http://localhost:11434` | Ollama API base URL. In Docker: `http://host.docker.internal:11434`. |
| `OB2_OLLAMA_MODEL` | `gemma3:4b` | Model for response synthesis. Any model pulled in Ollama works. |
| `OB2_CLASSIFIER_MODEL` | *(same as OLLAMA_MODEL)* | Model for query classification (Ollama-only knob; honored when the resolved classifier provider is Ollama). |
| `OB2_OLLAMA_KEEP_ALIVE` | `24h` | How long Ollama keeps a model resident after a chat request. |

#### llama.cpp / turboquant_plus

| Variable | Default | Description |
|---|---|---|
| `OB2_LLAMACPP_MANAGER_URL` | `http://localhost:8081` | Manager service control plane URL. In containerized mode: `http://ob2-llamacpp:8081`. In host mode: `http://host.docker.internal:8081`. |
| `OB2_LLAMACPP_CHAT_URL` | `http://localhost:8080` | `llama-server` OpenAI-compatible chat endpoint. |
| `OB2_LLAMACPP_MANAGER_TOKEN` | *(required)* | Bearer token for manager auth. Auto-generated to `.env` by `scripts/docker-start.sh --with-llamacpp`; for host mode set it manually. |
| `OB2_LLAMACPP_MODELS_DIR` | `/data/llamacpp/models` | Directory the manager scans for `.gguf` files. |
| `OB2_LLAMACPP_DEFAULT_MODEL` | `""` | Optional filename to auto-load on manager boot. Leave empty for "no auto-load". |
| `OB2_LLAMACPP_CTX_SIZE` | `8192` | Default context window size on `/v1/load`. |
| `OB2_LLAMACPP_GPU_LAYERS` | `-1` | Default GPU layer offload. `-1`=all, `0`=CPU only. |
| `OB2_LLAMACPP_PARALLEL_SLOTS` | `1` | Concurrent generation slots for `llama-server`. |
| `OB2_LLAMACPP_CACHE_TYPE_K` | `turbo3` | KV-cache key quantization type passed to `llama-server --cache-type-k`. |
| `OB2_LLAMACPP_CACHE_TYPE_V` | `turbo3` | KV-cache value quantization type passed to `llama-server --cache-type-v`. |
| `OB2_HF_TOKEN` | *(unset)* | Optional HuggingFace token for gated repo pulls (forwarded as `Authorization: Bearer` to `huggingface.co`). |
| `OB2_LLAMA_SERVER_BIN` | `/usr/local/bin/llama-server` | Path the manager uses to spawn `llama-server`. Containerized mode uses the bundled binary; host mode points at `llama-server.exe` or `./llama-server`. |

### Retrieval Sidecar

| Variable | Default | Description |
|---|---|---|
| `OB2_SIDECAR_RUNTIME` | *(empty = python)* | Set to `rust` to use the Rust sidecar. Wire-compatible drop-in. |
| `OB2_PYTHON` | `python3` | Python binary for the Python sidecar. In Docker: `/app/retrieval/.venv/bin/python`. |
| `OB2_SIDECAR_SCRIPT` | `../retrieval/sidecar.py` | Python sidecar entry point. In Docker: `/app/retrieval/sidecar.py`. |
| `OB2_RUST_SIDECAR_BIN` | `/app/sidecar-rs/ob2-sidecar` | Rust sidecar binary path. |
| `OB2_CONTEXT_ENGINE_PATH` | `/mnt/c/projects/context-engine` | Path to context-engine library. In Docker: `/app/context-engine`. |
| `OB2_CONTEXT_SHOW_UPLOADER` | *(empty = true)* | Set `false` to suppress uploader name from LLM context annotations without removing `_ob2_uploaded_by` from stored docs. |

### Embedder (runtime-tunable via config.yaml or admin UI)

| Variable | Default | Description |
|---|---|---|
| `OB2_EMBEDDING_MODEL` | `all-MiniLM-L6-v2` | sentence-transformers model name |
| `OB2_EMBEDDING_DIM` | `384` | Embedding dimension (must match model) |
| `OB2_BATCH_FLUSH_MS` | `100` | Embed batcher flush interval (ms) |
| `OB2_BATCH_MAX_SIZE` | `32` | Max docs per embed batch |

**`context` section** (hot-reloadable in `config.yaml`):

| Key | Default | Description |
|---|---|---|
| `context.show_uploader_in_context` | `true` | Include `uploaded by <user>` in multi-domain LLM source annotations. Set `false` to suppress without deleting stored provenance data. |

### Sync (runtime-tunable)

| Variable | Default | Description |
|---|---|---|
| `OB2_SYNC_INTERVAL_SEC` | `5` | Two-tier sync frequency |
| `OB2_SYNC_BATCH_SIZE` | `256` | Max docs per sync batch |

### Retrieval (runtime-tunable)

| Variable | Default | Description |
|---|---|---|
| `OB2_RETRIEVAL_TOP_K` | `5` | Default top-k for semantic search |
| `OB2_HYBRID_ALPHA` | `0.65` | TF-IDF / embedding blend (0 = pure TF-IDF, 1 = pure embedding) |
| `OB2_TOTAL_TOKEN_BUDGET` | `2048` | Token budget for context compression |

### Ingestion

| Variable | Default | Description |
|---|---|---|
| `OB2_IMPORT_MAX_BYTES` | `262144000` (250 MB) | Maximum upload size. Requests larger than this are rejected. |
| `OB2_IMPORT_SYNC_THRESHOLD_BYTES` | `26214400` (25 MB) | Files below this size are processed synchronously; above goes async. |
| `OB2_IMPORT_SYNC_TIMEOUT_SEC` | `60` | Timeout for synchronous ingest path. |
| `OB2_IMPORT_MCP_TIMEOUT_SEC` | `600` | Timeout for `capture_file` MCP tool. |
| `OB2_IMPORT_URL_DENYLIST` | RFC-1918 + loopback + link-local | Comma-separated CIDR blocks blocked for URL ingestion (SSRF defense). |
| `OB2_WHISPER_MODEL` | `base.en` | Whisper model for audio transcription. |
| `OB2_WHISPER_DEVICE` | `cpu` | Whisper inference device (`cpu` or `cuda`). |
| `OB2_OCR_LANGUAGE` | `eng` | Tesseract OCR language code (e.g., `eng`, `fra`, `deu+eng`). |

### SMTP / Email (runtime-tunable)

| Variable | Default | Description |
|---|---|---|
| `OB2_SMTP_DRIVER` | *(empty = disabled)* | `smtp` to enable, `log` to log-only |
| `OB2_SMTP_HOST` | *(empty)* | SMTP server hostname |
| `OB2_SMTP_PORT` | *(empty)* | SMTP port (typically 587 for STARTTLS, 465 for TLS) |
| `OB2_SMTP_USER` | *(empty)* | SMTP username |
| `OB2_SMTP_PASS` | *(empty)* | SMTP password |
| `OB2_SMTP_SECURE` | *(empty)* | `starttls`, `tls`, or `none` |
| `OB2_SMTP_FROM` | *(empty)* | From address (e.g., `OB2 <noreply@example.com>`) |

### Open WebUI

| Variable | Default | Description |
|---|---|---|
| `OB2_OPENWEBUI_ENABLED` | `false` | Enable Open WebUI integration |
| `OB2_OPENWEBUI_UPSTREAM` | `http://ob2-openwebui:8080` | Internal Open WebUI URL |
| `OB2_OPENWEBUI_SERVICE_TOKEN` | *(empty)* | Shared service token. Generate once with `server/scripts/openwebui-init.ts`. |
| `OB2_OPENWEBUI_PROXY_PORT` | `7601` | Host port for the Open WebUI reverse proxy |
| `OB2_OPENWEBUI_PUBLIC_URL` | *(empty)* | Public URL for Open WebUI (used in CORS and redirect config) |

## Volumes

| Volume | Mount point | Contents |
|---|---|---|
| `ob2_data` | `/data` in `ob2-server` | `ob2.db`, `users.json`, `config.yaml`, `import-jobs.json`, `imports/<domain>/` |
| `ob2_pgdata` | Postgres data dir | All Postgres data |
| `ob2_openwebui_data` | `/app/backend/data` in `ob2-openwebui` | Open WebUI state, model configs |

The `imports/<domain>/` subdirectory stores original uploaded files keyed by UUID. These are served by the `/admin/domains/:domain/imports/:file_id` endpoint.

## Enabling Open WebUI

1. Generate a service token (one-time):

```bash
deno run --allow-env --allow-write server/scripts/openwebui-init.ts
# Writes OB2_OPENWEBUI_SERVICE_TOKEN to .env
```

2. Add to `.env`:
```bash
OB2_OPENWEBUI_ENABLED=true
OB2_OPENWEBUI_SERVICE_TOKEN=<generated-token>
OB2_OPENWEBUI_PUBLIC_URL=http://localhost:7601   # or your public URL
```

3. Start with `--with-chat`:
```bash
scripts/docker-start.sh --with-chat
```

4. Open the dashboard → Chat tab → "Open Chat". The browser completes the SSO handoff automatically.

Open WebUI chat calls `/v1/chat/completions` on `ob2-server` using the service token + user identity header. Per-user domain ACL applies to every chat query.

## Switching Storage Backend

```bash
# From two-tier to sqlite only (dev mode)
OB2_STORAGE_BACKEND=sqlite scripts/docker-start.sh --build

# From sqlite to pgvector directly (no write cache)
OB2_STORAGE_BACKEND=pgvector OB2_PG_URL=postgres://... scripts/start.sh

# Migrate existing data
python -m cli.migrate \
  --from sqlite:/data/ob2.db \
  --to postgres://ob2:secret@localhost:5433/ob2 \
  --dim 384 --batch 256
```

## Switching LLM Model

Edit via Config tab (hot-reload, no restart needed) or set env var:

```bash
OB2_OLLAMA_MODEL=llama3.2:3b scripts/docker-start.sh
```

Any model pulled in Ollama works. The model must be capable of following citation instructions in the system prompt.

## Switching LLM Provider

Two providers are supported: `ollama` (default) and `llamacpp` (llama.cpp / turboquant_plus). Pick at runtime:

```bash
# Containerized llama.cpp (auto-generates manager token, sets provider=llamacpp)
scripts/docker-start.sh --with-llamacpp

# Or by hand:
OB2_LLM_PROVIDER=llamacpp scripts/docker-start.sh --with-llamacpp

# Or via the dashboard's Config tab → "LLM Provider" radio (hot-reloaded; no restart)
```

For host-mode (Windows / macOS prebuilt binaries), see `docs/llamacpp-host-setup.md`. For the full architecture (provider abstraction, manager service, chat data plane, control plane), see `docs/llamacpp-architecture.md`.

**Cross-provider classifier** — run classification on a small fast model while chat uses a large one:

```bash
# Chat on llama-server, classify on Ollama (e.g. qwen2.5:0.5b for routing)
OB2_LLM_PROVIDER=llamacpp OB2_LLM_CLASSIFIER_PROVIDER=ollama \
  OB2_CLASSIFIER_MODEL=qwen2.5:0.5b \
  scripts/docker-start.sh --with-llamacpp
```

The dashboard's Config tab → "Classifier" section shows the resolved effective configuration.

## Upgrading from `ob2` to `ob2_turboquant`

Phase 2 renamed the Compose project (`name: ob2` → `name: ob2_turboquant`) and pinned every named volume so future renames cost nothing. **Existing operators must perform a one-time data migration** documented in `docs/upgrade-ob2-to-turboquant.md`. Fresh deployments skip this entirely.

## Switching Sidecar Runtime

```bash
# Use the Rust sidecar
OB2_SIDECAR_RUNTIME=rust scripts/docker-start.sh

# Roll back to Python
OB2_SIDECAR_RUNTIME= scripts/docker-start.sh
```

No data migration needed. Both runtimes share the same storage tier. See `docs/architecture.md` for performance numbers.

## GPU Passthrough

The Compose file requests all GPUs via `nvidia-container-toolkit`. On hosts without NVIDIA GPU, the container starts normally and falls back to CPU for embeddings.

```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: all
          capabilities: [gpu]
```

Requires `nvidia-container-toolkit` on the host (not Docker Desktop's WSL backend, which does not support GPU passthrough to Compose services in all configurations).

## Connecting MCP Clients

### Claude Code

```json
{
  "mcpServers": {
    "ob2": {
      "url": "http://127.0.0.1:7600/mcp",
      "headers": {
        "x-brain-key": "ob2_your_user_api_key_here"
      }
    }
  }
}
```

### Cursor / Continue / Aider (OpenAI-compat)

```
Base URL:  http://127.0.0.1:7600/v1
API Key:   ob2_your_user_api_key_here
Model:     ob2
```

## Running Tests

```bash
# Full E2E suite (no Docker build needed, requires running stack)
bash tests/e2e.sh

# MCP integration runner (requires OB2_MCP_KEY in .env)
python3 tests/mcp_runner.py

# Sidecar golden-fixture parity (Python)
python3 tests/sidecar-golden/test_python.py

# Sidecar golden-fixture parity (Rust)
cd sidecar-rs && cargo test --test golden
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `sidecar: false` on `/health` | Python sidecar crashed | `docker logs ob2-server` for Python import errors |
| `502` on `/v1/chat/completions` | Ollama not running | `ollama list`; `ollama pull gemma3:4b` |
| `401` on all routes | Wrong brain key | Verify `OB2_BRAIN_KEY` in `.env` |
| `403` on domain routes | User lacks permission | Check `users.json`; grant `read`/`write`/`admin` on domain |
| `403` on `_admin` login | Brain-key gate closed | A real global admin exists — sign in as that user |
| Slow embedding (~5 s/doc) | CPU fallback | Check `docker logs ob2-server` for `on cuda:0` vs `on cpu` |
| `pgvector "expected N dimensions"` | Table created with wrong dim | `DROP TABLE docs CASCADE;` in Postgres, re-run |
| Sync status shows pending > 0 | pgvector unreachable | `docker ps | grep ob2-postgres`; check `/admin/sync-status` |
| Open WebUI chat returns 403 | Service token or user header missing | Verify `OB2_OPENWEBUI_SERVICE_TOKEN` matches both sides; ensure `ENABLE_FORWARD_USER_INFO_HEADERS=true` in Open WebUI config |
| Citation links return 401 | Signed URL expired or wrong secret | Links are 24-hour HMAC tokens; regenerate citation or ensure `OB2_SESSION_SECRET` is stable across restarts |
| Dashboard shows no data | API key missing or wrong | Clear `localStorage` and re-enter key, or use password login |
