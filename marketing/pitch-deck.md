# OB2 — Pitch Deck Outline

---

## Slide 1: The Problem

### LLMs give generic answers. Your documents are locked up.

- AI assistants don't know your specific runbooks, records, policies, or procedures
- Generic answers lead to re-discovery of solved problems, compliance errors, and slow onboarding
- Cloud RAG services exist — but they require uploading sensitive files to third parties
- Fine-tuning costs days and becomes stale the next time your docs change

---

## Slide 2: Current Solutions Fall Short

| Approach | Problem |
|---|---|
| **Cloud RAG (Pinecone + OpenAI)** | Sends your documents off-premises. Per-query costs. No control. |
| **Build-your-own RAG** | Weeks of infrastructure work. You become the operator. |
| **Fine-tuning** | Days of work, GPU costs, stale in a week. |
| **Context stuffing** | Blows token limits. No relevance filtering. |

No existing solution is: fast to set up + fully local + multi-user + cites sources with clickable links.

---

## Slide 3: OB2 — Grounded Answers from Your Own Documents

OB2 is an open-source, self-hosted RAG platform. One command to start. Upload any document. Ask questions in plain English. Get answers that cite your sources — with clickable links to the original files.

```
                 scanned PDF
                 Word doc        upload
                 spreadsheet  ------------>  OB2 indexes it locally
                 audio recording              (OCR, transcription,
                 URL                          chunking, embedding)
                     |
                     v
    "How do I rotate a TLS certificate?"
                     |
    OB2 searches your domains -> grounds the answer -> cites source
                     |
    "1. Generate CSR...  [Source: tls-procedures.pdf -- click to view]"
```

---

## Slide 4: Key Capabilities

**Any format in**
- PDF (including scanned via OCR), DOCX, PPTX, XLSX, HTML, Markdown, CSV, JSON, audio (Whisper), images, ZIP archives, URLs, YouTube transcripts

**Accurate, cited answers**
- Multi-domain retrieval: one pgvector scan across all domains you can access
- Hybrid TF-IDF + semantic ranking
- Source citations with signed download links (work for 24 hours, no login required)

**Multi-user, role-aware**
- Per-domain ACL: read / write / admin
- Argon2id passwords + session cookies for humans; 128-bit API keys for machines
- Email invite flow, password reset, zero-admin safety rail

**Full chat surface (optional)**
- Open WebUI integrated via SSO — one click from the dashboard
- Per-user domain ACL applies inside chat
- Responses include clickable source links

**Works with existing AI tools**
- MCP tools for Claude Code / Cursor
- OpenAI-compatible API for any client
- CLI importers for bulk loads

---

## Slide 5: How It Works — Architecture

```
  Users / AI tools
  (browser, Claude Code, Cursor)
          |
  ob2-server (Deno + Hono)
  Port 7600 (API + dashboard)
  Port 7601 (Open WebUI proxy + SSO)
          |
  Retrieval sidecar (Python or Rust)
  - MarkItDown + OCR conversion
  - 384-dim embeddings (all-MiniLM-L6-v2)
  - CUDA / MPS / CPU auto-detect
          |
  Two-tier storage
  - SQLite write cache (151 µs/insert)
  - pgvector HNSW (2.3 ms query)
          |
  Ollama on host
  (any model; default gemma3:4b)
```

Runs entirely in Docker. Three containers plus host Ollama. One command to start.

---

## Slide 6: Who It's For

**Military veterans**
Digitized service records, DD214s, medical files. OCR built in. Nothing leaves your laptop.

**Researchers**
Hundreds of PDFs. Ask "which paper introduced method X?" and get a citation with a link to the PDF.

**Security teams**
Runbooks, playbooks, incident procedures. Ask @netsec from Claude Code. Get your team's actual procedure, not a generic internet answer.

**Legal and compliance teams**
Case files, contracts, deposition transcripts. No cloud risk. Per-domain ACL keeps client files isolated.

**School districts and government agencies**
Policy documents, curriculum, regulations. Multi-user with role-based access. Data sovereignty by design.

---

## Slide 7: Security by Design

```
  Threat               Defense
  ─────────────────    ─────────────────────────────────────
  Password theft        argon2id (64 MiB, 3 iter)
  Session hijack        HMAC-SHA256 signed cookies, httpOnly
  SSRF via URL          DNS-resolve + RFC-1918 CIDR denylist
  ZIP bombs             250 MB uncompressed cap
  File type spoofing    Magic-byte sniffing on every upload
  Path traversal (MCP)  realpath() + /data boundary check
  Header injection      Strip all forwarded headers at proxy
  Citation abuse        24-hour HMAC-signed download URLs
  Clickjacking          X-Frame-Options: DENY
  XSS via scripts       CSP: script-src 'self'
  Bootstrap key leak    Brain key auto-retires when real admins exist
```

Runs behind a reverse proxy. HSTS and cookie Secure flag engage automatically when `OB2_PUBLIC_URL` is HTTPS.

---

## Slide 8: Performance

**Storage**
- SQLite write cache: 151 µs/insert
- pgvector HNSW query: 2.3 ms
- Two-tier sync: background, every 5 s

**Opt-in Rust sidecar (OB2_SIDECAR_RUNTIME=rust)**

Measured on RTX 5090:

| Metric | Python | Rust | Delta |
|---|---|---|---|
| Cold start | 4.63 s | 0.36 s | 12.9x faster |
| RSS warm | 1,396 MB | 687 MB | 2x smaller |
| Throughput (16 concurrent) | 281 caps/sec | 1,124 caps/sec | 4x |

Same JSON-RPC wire protocol. No data migration. Toggle with one env var.

---

## Slide 9: Deployment

```bash
# Start (three containers: ob2-server + pgvector + pgAdmin)
scripts/docker-start.sh

# With Open WebUI chat
scripts/docker-start.sh --with-chat

# Open dashboard
http://localhost:7600/dashboard
```

**Volumes:**
- `ob2_data` — documents, users, config, original uploaded files
- `ob2_pgdata` — Postgres/pgvector
- `ob2_openwebui_data` — Open WebUI state

**Storage backend:** SQLite (dev) or pgvector (production) or two-tier (default).
**LLM:** any Ollama model, hot-swappable from the Config tab.
**Sidecar:** Python or Rust, toggle via env var, no restart required for storage.

---

## Slide 10: Open Source, Apache-2.0

- Self-hostable — no vendor lock-in, no SaaS dependency
- Modify it, white-label it, integrate it
- Full documentation: architecture, API reference, deployment, security guide, user guide
- 19-step E2E test suite; golden-fixture parity suite locks Rust/Python sidecar byte-identical in CI

---

## Slide 11: What's Next

**Shipped and available now:**
- Multi-format ingestion (all formats listed above)
- Multi-user + per-domain ACL
- Open WebUI integration with SSO
- Signed citation URLs
- Async job queue for large files
- Email invite + password-reset flows
- Rust sidecar (opt-in)

**On the roadmap:**
- Webhook ingestion (GitHub, Slack, PagerDuty)
- Embedding model hot-swap (upgrade model without re-import)
- Agent memory (long-running sessions with cross-domain recall)
- Federated OB2 (cross-instance queries with access control)
- Persistent audit log

---

## Slide 12: Contact

**OB2** — open-source, Apache-2.0

For demos, enterprise licensing, or integration questions:

usfarm73@gmail.com

`docs/deployment.md` — full installation guide
`docs/user-guide.md` — end-user documentation
