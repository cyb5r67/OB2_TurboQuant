# OB2 TurboQuant: Local RAG with Google DeepMind's KV-Cache Compression, Knowledge Graph, and Full GGUF Model Management

*We built OB2 after learning the hard way that there was no good middle ground between "send your files to OpenAI" and "build it yourself." Since then, we've added TurboQuant KV-cache compression, a Knowledge Graph, full GGUF model management from the dashboard, and support for every major LLM provider. Here's what OB2 TurboQuant can do today.*

---

## The problem with cloud RAG

The promise of retrieval-augmented generation is simple: give an LLM access to your specific documents, and it will stop hallucinating generic answers and start citing your actual knowledge.

The problem is how most RAG products deliver it. They require you to upload your files to their servers. You pay per query. When you stop paying, you lose access to your indexed knowledge. And if your documents contain anything sensitive — medical records, legal filings, classified procedures, proprietary research — you've just shipped them to someone else's infrastructure.

We also tried an alternative: injecting knowledge directly into LLM weights. We spent a week rigorously testing whether you could insert facts into a model's FFN layers and have it "just know" your domain. The results were unambiguous: weight injection only activates when the query matches the internal template `"The {relation} of {entity} is"`. One out of ten natural-language paraphrases hit. Zero out of six procedural rule queries activated. The full spike findings are in the repo.

So we built OB2: honest RAG, done right, running entirely on your hardware. And then we kept building.

---

## TurboQuant: fitting a 35B model on a consumer GPU

The biggest addition in this cycle is TurboQuant — a 2026 KV-cache compression algorithm from Google DeepMind, integrated into our custom llama.cpp fork.

Here's why it matters. When an LLM processes a conversation, it builds a Key/Value cache that stores the attention state for every token seen so far. In a long conversation with retrieved document context, this cache grows large and becomes the bottleneck: VRAM usage, bandwidth, inference speed. Standard approaches use fp16 KV entries. TurboQuant compresses them to approximately 3 bits per value with negligible accuracy loss.

The practical effects on an RTX 5090 with 32 GB VRAM running Qwen3.6-35B-A3B (a 20 GB Q4_K_M GGUF):

- **The model fits on the GPU entirely** — all 35 billion parameters on-card
- **8192-token context** with room to spare in VRAM
- **Follow-up messages are fast** — combined with `--cache-prompt`, subsequent turns in a conversation only process new tokens. The system prompt and prior conversation history are read from the compressed KV cache

TurboQuant applies to the KV cache only — not to model weights. Any GGUF model benefits automatically when loaded via OB2. The TurboQuant quantization levels are configurable: `turbo2_0`, `turbo3_0` (default), `turbo4_0`. Higher levels compress more but introduce more loss.

---

## Full GGUF model management from the dashboard

Earlier versions of OB2 assumed you already had a model running in Ollama. That's fine for prototyping, but it hides the model selection problem. We've replaced it with a full GGUF management UI in the dashboard LLMs tab.

From the dashboard you can now:

- **Pull from HuggingFace** — enter a repo and filename, watch the download progress in human-readable GB/s. No CLI, no `docker exec`.
- **Pull from a URL** — any direct GGUF download link works.
- **Load a model** — one click. The loading spinner shows "Loading…" while llama-server starts. The loaded model card shows the port and how long ago it was loaded.
- **Restart with new settings** — adjust context size, GPU layers, and parallel slots without reloading the page.
- **Unload** — frees GPU VRAM immediately.
- **Set a default model** — select from a dropdown of installed GGUFs. The default loads automatically on container restart.

The manager health check timeout is now configurable (`OB2_LLAMACPP_HEALTH_TIMEOUT_MS`, default 5 minutes) because loading a 20 GB model into VRAM on a cold GPU takes time.

---

## Knowledge Graph: entity extraction and graph-augmented retrieval

Every document you ingest can now feed a Knowledge Graph. When `graph.extraction_enabled: true` is set, an async worker calls the active LLM to extract named entities (PERSON, ORG, PLACE, PRODUCT, EVENT, CONCEPT) and their relationships from each document chunk.

The graph augments retrieval: when a query mentions known entities, chunks near those entities in the relationship graph are boosted alongside the standard cosine-similarity ranking. This surfaces answers that are semantically adjacent but not textually similar to the query.

From the Graph tab you can:

- View an interactive Cytoscape.js visualization of your domain's entity graph
- Click any node to see which document chunks mention that entity
- Filter by entity type
- Run a backfill to extract entities from documents already in the store — with resume support (interrupted backfills pick up where they left off) and a **Force re-extract all** option for when you change the extraction model
- Export the graph as GEXF for Gephi

The extraction pipeline is provider-aware: when using the llamacpp provider, entity extraction routes through llama-server's OpenAI-compatible endpoint. Qwen3's thinking mode (chain-of-thought reasoning output) is handled transparently — the pipeline suppresses it via `/no_think` and gracefully extracts the JSON answer even when thinking mode partially fires.

---

## The ingestion pipeline: every format, no compromises

OB2's ingestion handles the full range of real-world document formats:

**PDFs** — text-layer PDFs work out of the box. Scanned PDFs trigger OCR via `ocrmypdf` with the high-quality Tesseract LSTM model. The pipeline deskews, cleans, rotates, and upsamples at 300 DPI.

**Office documents** — DOCX, PPTX, XLSX. MarkItDown extracts content; the chunker splits on document structure.

**Audio** — MP3, WAV, OGG, and other formats transcribed via Whisper before chunking.

**Archives** — ZIP files extracted and each contained file processed individually.

**URLs** — paste a URL and OB2 fetches and indexes the page. SSRF defense built in.

All ingestion is available from the dashboard (drag and drop) and from the `capture_file` MCP tool.

---

## Any LLM provider, same interface

OB2 now supports five LLM providers, all switchable from the dashboard Config tab with no restart:

- **llamacpp** — TurboQuant-enabled llama-server. Any GGUF model. Recommended for fully local inference.
- **Ollama** — any model on a local Ollama instance. Default for operators who already use Ollama.
- **OpenAI** — GPT-4o, GPT-4.1, o3, or any OpenAI-compatible endpoint.
- **Anthropic** — Claude Opus 4.7, Sonnet 4.6, Haiku 4.5, and future releases.
- **Gemini** — Gemini 2.0 Flash, Gemini 2.5 Pro.

Chat and classification can run on different providers. A common pattern: chat on llama-server (one large model loaded), classification on Ollama (a small fast model for domain routing).

The same retrieval pipeline — chunking, embedding, pgvector HNSW, graph reranking — applies regardless of which LLM receives the augmented context.

---

## Retrieval: what's new

A few important fixes in the retrieval pipeline:

**Token budget bug fixed.** The gateway previously hardcoded 6000 tokens of context to the LLM regardless of configuration — 3x the configured default. This inflated prefill time on every request. The gateway now reads from `retrieval.total_token_budget` in runtime config (default: 2048). Measured effect: meaningful prefill time reduction on first message.

**Retrieval timing visible in logs.** Each chat request logs `retrieval took Xms, chunks=N` so operators can distinguish retrieval latency from LLM inference latency. On a warm system: 8–14 ms.

**General knowledge fallback.** The system prompt now allows the model to answer from general knowledge when retrieved documents don't contain the answer. Previously, the model would say "I don't know" even for questions unrelated to your domain. Now it uses the knowledge base when relevant and falls back gracefully when not.

---

## Multi-user, per-domain access control

OB2 is not a single-user tool. It ships with a full multi-user system:

- Per-domain permissions: read, write, or admin on each domain separately
- Argon2id-hashed passwords + HMAC-signed session cookies
- 128-bit API keys for machine clients
- Email invite flow, password reset, zero-admin safety rail
- Service-token impersonation for Open WebUI (per-user ACL applies in chat)

The same ACL applies whether you authenticate via the dashboard, an API key, or Claude Code's MCP tools.

---

## Under the hood

**Two-tier storage:** writes go to SQLite first (151 µs/insert). A background SyncWorker pushes everything to pgvector every five seconds for HNSW-indexed queries (2.3 ms). If pgvector is unreachable, sync backs off and retries; queries fall back to SQLite.

**Two sidecar runtimes:** Python (sentence-transformers + PyTorch) is the default. The Rust sidecar (`OB2_SIDECAR_RUNTIME=rust`) uses ONNX Runtime 1.24.4 with CUDA 13 support (including Blackwell sm_120 kernels). On RTX 5090: 4x concurrent throughput, 13x faster cold start, 2x less RAM. Both share the same storage — switch with one env var, no data migration.

**Security:** CSP, HSTS, X-Frame-Options, SSRF denylist, argon2id, signed download tokens.

---

## Who is OB2 TurboQuant for?

Anyone who needs accurate, cited answers from their own documents, with fast local inference they control:

- A military veteran querying a 40-year archive of service records and VA correspondence
- A security team that maintains runbooks in markdown and wants "ask our runbooks" in Claude Code — with entity graph showing how incidents relate to systems
- A legal team ingesting case files, deposition transcripts, and contract histories — with entities like parties, dates, and locations extracted automatically
- A researcher with 500 PDFs who needs "which of these papers cites method X" — with graph reranking finding related work by entity overlap
- Any organization that needs to run a 35B parameter model on a consumer GPU and get fast responses in long conversations

OB2 TurboQuant is Apache-2.0. It runs in Docker. It does not require a cloud account.

```bash
git clone <repo> && cd OB2_TurboQuant
cp .env.example .env  # set OB2_BRAIN_KEY

docker compose -f docker/docker-compose.yml --env-file .env \
  --profile llamacpp --profile openwebui up -d

# Dashboard: http://localhost:7600/dashboard
# Pull a GGUF from the LLMs tab
# Enable graph extraction in Config tab
# Start chatting at http://localhost:7601
```

---

*The best RAG implementation is the one that stays on your hardware, reads your actual documents, compresses your context window to fit more in VRAM, and tells you exactly where it got every answer.*
