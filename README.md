# OB2 — Self-Hosted Personal RAG Platform

OB2 is a fully self-hosted retrieval-augmented generation platform. Upload documents in any format, ask questions of a local LLM, and get answers grounded in your own knowledge base with clickable source citations. Everything runs on your hardware — no cloud, no per-query costs, no data exfiltration.

```
  User uploads PDF / DOCX / audio / URL
          |
          v
  OB2 converts, OCRs, chunks, embeds
          |
          v
  User asks: "how do I rotate a TLS cert?"
          |
  OB2 retrieves relevant chunks (all assigned domains, one pgvector scan)
  Injects as grounded context -> Ollama -> answer with signed citation links
```

## What's New (since 2026-04-18)

- **LLM provider switch in dashboard** — flip between Ollama and llama-server (turboquant_plus) via the Config tab without restarting. The LLMs tab adapts its controls to the active provider; pull GGUFs from URL or HuggingFace, load/unload, and delete from the UI. Containerized via `scripts/docker-start.sh --with-llamacpp`, or run `llama-server` on Windows/Mac with the prebuilt binaries (see `docs/llamacpp-host-setup.md`).
- **Multi-format ingestion** — PDFs (text + OCR for scanned), DOCX, PPTX, XLSX, HTML, Markdown, CSV, JSON, audio (Whisper), images, ZIP archives, HTTP URLs, YouTube transcripts — all via MarkItDown + ocrmypdf
- **Original file persistence + signed download URLs** — every uploaded file stored at `/data/imports/<domain>/<file_id>`; chat citations are clickable links with 24-hour HMAC-signed tokens (no session cookie needed)
- **Multi-domain retrieval** — prefix-less chats search every domain the caller can read in one pgvector scan, ranked together by cosine similarity
- **Open WebUI chat surface** — optional (`--with-chat`); SSO via OB2's reverse proxy on port 7601; per-user impersonation so domain ACL applies inside chat
- **Upload provenance** — every captured document is stamped with `_ob2_uploaded_by: "<username>"`. The uploader's name appears in the dashboard's domain docs table and in multi-domain chat context annotations (`uploaded by alice`). Toggle off via `context.show_uploader_in_context: false` in the Config tab without removing stored data.
- **Full-screen graph explorer** — `/graph` opens a full-screen Cytoscape.js view with per-type filters, live search, node-click side panel, and a "Run Layout" button for better node placement. The dashboard Graph tab gains "Open full-screen ↗" and "Export GEXF ↓" buttons.
- **Multi-user system** — `users.json`-backed user store with argon2id passwords, HMAC-signed session cookies, per-domain ACL (read/write/admin), API keys, global_admin flag
- **Domain management** — admin UI for creating/managing domains with descriptions, doc browsers, per-domain alias management, per-user domain assignment
- **Async ingestion job queue** — large files, audio, and ZIPs queue async with disk persistence; dashboard polls with exponential backoff
- **Email invite + password-reset flows** — single-use tokens, 7-day invite TTL, 1-hour reset TTL
- **Security hardening** — magic-byte sniffing, SSRF denylist, `/data` path realpath check, ZIP-bomb size cap, header-injection strip on the Open WebUI proxy, signed file-download URLs, CSP/HSTS, per-IP rate limiting

## Quick Start

```bash
cd /path/to/OB2
export OB2_BRAIN_KEY=your-secure-key

# Standard stack (server + pgvector + pgAdmin)
scripts/docker-start.sh

# With Open WebUI chat surface
scripts/docker-start.sh --with-chat

# Force rebuild after code changes
scripts/docker-start.sh --build
```

**Ports:**

| URL | What |
|---|---|
| `http://localhost:7600/dashboard` | Web dashboard |
| `http://localhost:7600` | Main API (MCP, /v1, /admin) |
| `http://localhost:7601` | Open WebUI chat (if `--with-chat`) |
| `http://localhost:5051` | pgAdmin (database) |

**First login:** username `_admin`, password = your `OB2_BRAIN_KEY`. Create a real admin user under the Users tab, then switch to that user.

## Feature Overview

- **Ingestion**: drag-drop upload in dashboard, paste URL, `capture_file` MCP tool, or CLI importers (`csv`, `docs`, `pdf`, `wiki`)
- **Retrieval**: hybrid TF-IDF + semantic search (configurable `OB2_HYBRID_ALPHA`), multi-domain in one scan, single-domain with `@domain` prefix
- **Generation**: local Ollama (any model; default `gemma3:4b`), grounded context injection, streaming SSE
- **Storage**: two-tier default (SQLite write cache → pgvector HNSW), or standalone `sqlite` / `pgvector`
- **Auth**: argon2id passwords + HMAC session cookies for humans; 128-bit API keys for machines; per-domain ACL for both; brain-key bootstrap + close-down
- **Upload provenance**: every doc carries `_ob2_uploaded_by` in its metadata; shown in the dashboard and optionally in LLM source annotations
- **Knowledge Graph**: entity extraction into a per-domain graph (Graph RAG); dashboard Graph tab shows an interactive preview with "Open full-screen ↗" (`/graph` — Cytoscape.js, per-type filters, live search, node-click side panel) and "Export GEXF ↓" (Gephi-compatible export via `GET /admin/domains/:domain/graph/export.gexf`)
- **Sidecar**: Python (default, sentence-transformers + torch) or Rust (`OB2_SIDECAR_RUNTIME=rust`, ORT 1.24.4 CUDA 13, Blackwell-ready — 4x throughput, 13x faster cold start, 2x less RAM)

## Documentation

| Doc | Purpose |
|---|---|
| [docs/user-guide.md](docs/user-guide.md) | End-user guide: signing in, uploading files, asking questions, reading citations, managing your profile |
| [docs/architecture.md](docs/architecture.md) | System architecture, all containers, ingestion pipeline, auth flow, multi-domain retrieval, ASCII diagrams |
| [docs/process-flows.md](docs/process-flows.md) | ASCII sequence diagrams for every major flow (capture, ingest, chat with citation, SSO, bootstrap, sync) |
| [docs/api-reference.md](docs/api-reference.md) | Every HTTP endpoint, MCP tool, and CLI command with `curl` examples |
| [docs/deployment.md](docs/deployment.md) | Full env-var table, volume layout, scripts, Open WebUI setup, storage/LLM switching |
| [docs/security.md](docs/security.md) | Threat model, credential handling, SSRF defense, signed URLs, CSP, rate limits, deployment checklist |

## Stack

| Layer | Technology |
|---|---|
| Server | Deno + Hono, two listeners (:7600 main + :7601 Open WebUI proxy) |
| Ingestion | MarkItDown + ocrmypdf (tessdata_best, LSTM) + Whisper |
| Retrieval (default) | Python sidecar + sentence-transformers, hybrid TF-IDF + semantic |
| Retrieval (opt-in) | Rust sidecar — ONNX Runtime 1.24.4 CUDA 13, same JSON-RPC |
| Embeddings | `all-MiniLM-L6-v2` (384-dim), CUDA/MPS/CPU auto-detect, auto-batching |
| Storage | Two-tier: SQLite write cache (151 µs/insert) → pgvector HNSW (2.3 ms query) |
| Generation | Ollama (any model) via `host.docker.internal` |
| Auth | Argon2id + HMAC session cookies (humans), 128-bit API keys (machines), per-domain ACL |
| Chat UI | Open WebUI (optional, `--with-chat`) — SSO + per-user impersonation |
| Infrastructure | Docker Compose, NVIDIA GPU passthrough |

## Project Structure

```
OB2/
├── server/              Deno + Hono server
│   ├── index.ts           Entry, two listeners, sidecar spawn
│   ├── config.ts          Env var parsing
│   ├── users.ts           UserRecord, ACL, auth middleware
│   ├── auth/              passwords, sessions, file_signing, openwebui-sso,
│   │                      rate-limit, reset-tokens
│   ├── routes/            auth, mcp, gateway, admin, classifier, config_api
│   ├── proxy/             openwebui.ts (port 7601)
│   ├── import/            runner, jobs, sniffer, url_fetcher, chunker
│   ├── mail/              mailer, templates
│   ├── scripts/           reset-admin.ts, openwebui-init.ts
│   └── static/            dashboard.html, dashboard.js
├── retrieval/           Python sidecar (default)
│   ├── sidecar.py
│   ├── embed_batcher.py
│   ├── markitdown_converter.py
│   └── storage/           backend, sqlite_vec, pg_vector, two_tier
├── sidecar-rs/          Rust sidecar (OB2_SIDECAR_RUNTIME=rust)
│   └── crates/            ob2-sidecar, ob2-embedder, ob2-storage,
│                          ob2-retriever, ob2-context
├── cli/                 CLI importers: csv, docs, pdf, wiki; migrate
├── Dockerfile
├── docker/
│   ├── docker-compose.yml  ob2-server + pgvector + pgAdmin + Open WebUI
│   └── init.sql
├── scripts/             docker-start/stop/restart (--with-chat, --build)
├── tests/               e2e.sh, mcp_runner.py, sidecar-golden/
└── docs/                architecture, process-flows, api-reference,
                         deployment, security, user-guide
```

## Rust Sidecar Performance (RTX 5090)

| Metric | Python (torch CUDA) | Rust (ORT 1.24.4 CUDA 13) | Delta |
|---|--:|--:|--:|
| Cold start | 4.63 s | 0.36 s | **12.9x faster** |
| RSS warm | 1,396 MB | 687 MB | **2.0x smaller** |
| Capture avg | 23 ms | 11 ms | 2.1x |
| Retrieve avg | 31 ms | 10 ms | 3.3x |
| Throughput (16 concurrent) | 281 caps/sec | 1,124 caps/sec | **4.0x** |

Wire-compatible drop-in — the Deno server cannot tell the difference. Toggle with `OB2_SIDECAR_RUNTIME=rust`. Default stays `python`.

## License

Apache-2.0
