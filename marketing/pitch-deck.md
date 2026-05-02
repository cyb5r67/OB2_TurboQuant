# OB2 TurboQuant — Pitch Deck Outline

---

## Slide 1: The Problem

### LLMs give generic answers. Your documents are locked up.

- AI assistants don't know your specific runbooks, records, policies, or procedures
- Generic answers lead to re-discovery of solved problems, compliance errors, and slow onboarding
- Cloud RAG services exist — but they require uploading sensitive files to third parties
- Fine-tuning costs days and becomes stale the next time your docs change
- Even local LLMs are slow: loading a 20 GB model into VRAM, processing long conversation history from scratch on every turn

---

## Slide 2: Current Solutions Fall Short

| Approach | Problem |
|---|---|
| **Cloud RAG (Pinecone + OpenAI)** | Sends your documents off-premises. Per-query costs. No control. |
| **Build-your-own RAG** | Weeks of infrastructure work. You become the operator. |
| **Fine-tuning** | Days of work, GPU costs, stale in a week. |
| **Context stuffing** | Blows token limits. No relevance filtering. |
| **Local Ollama + basic RAG** | No GGUF model management. No KV cache compression. No Knowledge Graph. |

No existing solution is: fast to set up + fully local + multi-user + cites sources + runs state-of-the-art compressed inference.

---

## Slide 3: OB2 TurboQuant — Grounded Answers, Compressed Inference

OB2 TurboQuant is an open-source, self-hosted RAG platform with Google DeepMind's TurboQuant KV-cache compression built in. One command to start. Upload any document. Ask questions in plain English. Get answers that cite your sources — with clickable links to the original files. And run it all on a 35B parameter model that fits in consumer GPU VRAM.

```
                 scanned PDF
                 Word doc        upload
                 spreadsheet  ------------>  OB2 indexes it locally
                 audio recording              (OCR, transcription,
                 URL                          chunking, embedding,
                                              Knowledge Graph extraction)
                     |
                     v
    "How do I rotate a TLS certificate?"
                     |
    OB2 searches your domains (vector + TF-IDF + graph rerank)
    -> grounds the answer via TurboQuant-compressed llama-server
    -> cites source
                     |
    "1. Generate CSR...  [Source: tls-procedures.pdf -- click to view]"
```

---

## Slide 4: Key Capabilities

**TurboQuant KV-cache compression**
- Google DeepMind's 2026 algorithm compresses the KV cache to ~3 bits per value
- Up to 8x faster inference on H100/RTX hardware vs uncompressed fp16 KV cache
- Run a 35B MoE model (Qwen3.6-35B-A3B) in 20 GB VRAM — what previously required 40+ GB
- Combined with `--cache-prompt`: subsequent conversation turns reuse the KV cache, processing only new tokens

**Any GGUF model, from the dashboard**
- Pull any model from HuggingFace directly in the dashboard UI — no CLI required
- Load/unload models, adjust context size, GPU layers, and parallel slots from the UI
- Progress bar shows download status in human-readable GB/s
- Model switch is instant — unload one, load another

**Knowledge Graph**
- Async entity/relationship extraction from every ingested document
- Per-domain graph: entities (PERSON, ORG, PLACE, PRODUCT, EVENT, CONCEPT) + relationships
- Graph-augmented retrieval reranking: answers boosted by entity connections, not just cosine similarity
- Full-screen interactive Cytoscape.js visualization + GEXF export for Gephi
- Backfill existing documents; new documents extracted automatically on capture

**Any file format in**
- PDF (including scanned via OCR), DOCX, PPTX, XLSX, HTML, Markdown, CSV, JSON, audio (Whisper), images, ZIP archives, URLs, YouTube transcripts

**Any LLM provider**
- llamacpp (TurboQuant GGUF) — recommended for local inference
- Ollama — any model on a local Ollama instance
- OpenAI, Anthropic, Gemini — cloud providers via the same interface
- Switch providers from the dashboard Config tab, no restart required

**Accurate, cited answers**
- Multi-domain retrieval: one pgvector scan across all domains you can access
- Hybrid TF-IDF + semantic + graph reranking
- Source citations with signed download links (work for 24 hours, no login required)

**Multi-user, role-aware**
- Per-domain ACL: read / write / admin
- Argon2id passwords + session cookies for humans; 128-bit API keys for machines
- Email invite flow, password reset, zero-admin safety rail

**Works with existing AI tools**
- MCP tools for Claude Code / Cursor
- OpenAI-compatible API for any client

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
     +----+----+
     |         |
  Retrieval    LLM provider dispatch
  sidecar      (ollama / llamacpp /
  (Python/     openai / anthropic /
   Rust)       gemini)
     |              |
  Two-tier     ob2-llamacpp
  storage      - ob2-llamacpp-manager
  - SQLite       (control plane :8081)
    write      - llama-server
    cache        (TurboQuant fork)
  - pgvector     (chat :8080)
    HNSW         --cache-type-k turbo3
  Knowledge      --cache-type-v turbo3
  Graph          --cache-prompt
  tables
```

---

## Slide 6: TurboQuant — The Technical Edge

```
Without TurboQuant:                With TurboQuant:
KV cache = fp16                    KV cache = turbo3 (~3 bits)
35B MoE model: needs ~40 GB VRAM  35B MoE model: fits in 20 GB VRAM
Long conversation = slow           Long conversation = fast
(re-process from scratch each turn)(--cache-prompt reuses prefix KV)
```

TurboQuant is a KV-cache compression algorithm — it applies to the **context window at inference time**, not to model weights. Any GGUF model automatically benefits. The quality loss at turbo3 is negligible for conversational use.

Combined effect on RTX 5090 (32 GB VRAM):
- 35B MoE model loaded entirely on GPU
- 8192-token context window with turbo3 compression
- Subsequent conversation turns process only new tokens via `--cache-prompt`

---

## Slide 7: Who It's For

**Military veterans**
Digitized service records, DD214s, medical files. OCR built in. Nothing leaves your laptop.

**Researchers**
Hundreds of PDFs. Ask "which paper introduced method X?" and get a citation with a link to the PDF. Knowledge Graph surfaces entity connections across documents.

**Security teams**
Runbooks, playbooks, incident procedures. Ask @netsec from Claude Code. Get your team's actual procedure, not a generic internet answer. Graph reranking surfaces related entities.

**Legal and compliance teams**
Case files, contracts, deposition transcripts. No cloud risk. Per-domain ACL keeps client files isolated.

**School districts and government agencies**
Policy documents, curriculum, regulations. Multi-user with role-based access. Data sovereignty by design.

**Any organization that can't afford slow inference**
TurboQuant means faster answers, larger context, and lower VRAM costs — on hardware you already own.

---

## Slide 8: Security by Design

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

---

## Slide 9: Performance

**Retrieval**
- Warm retrieval: 8–14 ms (pgvector HNSW + graph reranking)
- First request cold start: ~1.8 s (embedding model warm-up, once per restart)
- SQLite write cache: 151 µs/insert

**Inference (RTX 5090, Qwen3.6-35B-A3B Q4_K_M, TurboQuant)**
- Model: 20 GB GGUF, all layers on GPU (32 GB VRAM)
- KV cache: turbo3 compression, 8192-token context
- First message: full prefill (system prompt + context + question)
- Follow-up messages: only new tokens prefilled (`--cache-prompt`)

**Opt-in Rust sidecar (OB2_SIDECAR_RUNTIME=rust)**

| Metric | Python | Rust | Delta |
|---|---|---|---|
| Cold start | 4.63 s | 0.36 s | 12.9x faster |
| RSS warm | 1,396 MB | 687 MB | 2x smaller |
| Throughput (16 concurrent) | 281 caps/sec | 1,124 caps/sec | 4x |

---

## Slide 10: Deployment

```bash
# Start with TurboQuant llamacpp + chat UI
docker compose -f docker/docker-compose.yml --env-file .env \
  --profile llamacpp --profile openwebui up -d

# Pull a model from the dashboard LLMs tab (e.g. Qwen3.6-35B-A3B Q4_K_M)
# Load it — model card shows port + load time
# Start chatting at http://localhost:7601
```

**Containers:**
- `ob2-server` — Deno server + Python/Rust retrieval sidecar
- `ob2-postgres` — pgvector + Knowledge Graph tables
- `ob2-pgadmin` — database admin UI (optional)
- `ob2-llamacpp` — TurboQuant llama-server + manager (profile: llamacpp)
- `ob2-openwebui` — chat surface with SSO (profile: openwebui)

**LLM provider:** switchable from dashboard Config tab — no restart required.
**Sidecar:** Python or Rust, one env var, no data migration.

---

## Slide 11: Open Source, Apache-2.0

- Self-hostable — no vendor lock-in, no SaaS dependency
- Modify it, white-label it, integrate it
- Full documentation: architecture, API reference, deployment, security guide, user guide, Mermaid system diagrams
- 19-step E2E test suite; golden-fixture parity suite locks Rust/Python sidecar byte-identical in CI

---

## Slide 12: What's Available Now vs Roadmap

**Shipped and available now:**
- TurboQuant KV-cache compression (turbo3 by default)
- llamacpp provider: pull any GGUF from HuggingFace in the dashboard
- Knowledge Graph: entity/relationship extraction + graph-augmented retrieval
- `--cache-prompt`: KV cache reuse across conversation turns
- Multi-format ingestion (all formats listed above)
- Multi-user + per-domain ACL
- Open WebUI integration with SSO
- Signed citation URLs
- Cloud providers: OpenAI, Anthropic, Gemini
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

## Slide 13: Contact

**OB2 TurboQuant** — open-source, Apache-2.0

For demos, enterprise licensing, or integration questions:

usfarm73@gmail.com

`docs/deployment.md` — full installation guide
`docs/user-guide.md` — end-user documentation
`docs/diagrams.md` — Mermaid system architecture diagrams
