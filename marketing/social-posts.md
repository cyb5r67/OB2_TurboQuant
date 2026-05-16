# OB2 TurboQuant — Social Media Posts

---

## LinkedIn

### Post 1: Launch — TurboQuant

**Run a 35B LLM on a consumer GPU. With KV-cache compressed to 3 bits. Fully local. $0/query.**

We just shipped OB2 TurboQuant — and the headline feature is Google DeepMind's TurboQuant KV-cache compression algorithm baked directly into our llama.cpp fork.

What TurboQuant means in practice:
- A 20 GB Qwen3.6-35B-A3B GGUF model runs entirely on a single RTX GPU
- The context window (conversation history + retrieved documents) is compressed to ~3 bits per value — negligible accuracy loss
- Follow-up messages in a conversation process only new tokens (`--cache-prompt`), not the whole history from scratch

Combined with OB2's RAG pipeline:
- Documents indexed in your pgvector knowledge base
- Hybrid semantic + TF-IDF + Knowledge Graph retrieval
- Answers with clickable citations to original files

Pull any GGUF from HuggingFace in the dashboard UI. No CLI. No `docker exec`. Progress bar shows download in human-readable GB/s.

Apache-2.0. Runs in Docker. Nothing leaves your network.

#AI #LLM #RAG #Privacy #OpenSource #LocalAI

---

### Post 2: Knowledge Graph

**What if your RAG system knew that "NIST SP 800-53" is related to "AC-2" and "IA-5" — and used that to find better answers?**

OB2 TurboQuant now ships a Knowledge Graph. Every document you ingest feeds an async entity extractor that pulls:
- Named entities: people, orgs, places, products, events, concepts
- Relationships between them

When you ask a question, retrieval is graph-augmented: chunks near mentioned entities in the relationship graph get boosted alongside standard semantic ranking.

The result: answers that are contextually richer, not just lexically similar to your query.

From the Graph tab you can:
✓ Explore the entity graph interactively (Cytoscape.js)
✓ Click any node to see which documents mention it
✓ Export to GEXF for Gephi
✓ Run backfill on existing documents (resumes if interrupted)

#AI #KnowledgeGraph #RAG #EntityExtraction #OpenSource

---

### Post 3: GGUF model management

**You shouldn't need a terminal to swap your local LLM.**

OB2 TurboQuant's dashboard LLMs tab now gives you full GGUF model management:

- Pull from HuggingFace: type a repo + filename, watch the download progress
- Load: one click, button shows "Loading…" during startup
- Loaded model card: filename, port, how long ago it loaded
- Restart with new settings: adjust context size and GPU layers from the UI
- Unload: free VRAM instantly
- Default model: dropdown of installed GGUFs, auto-loaded on restart

No CLI. No `docker exec`. No editing config files.

The manager health check timeout is configurable for large models — loading 20 GB into GPU VRAM takes time.

---

### Post 4: Five providers, one interface

**Your RAG pipeline shouldn't be locked to one LLM vendor.**

OB2 TurboQuant supports five providers, all switchable from the dashboard Config tab — no restart required:

🖥️ **llamacpp** — TurboQuant GGUF. Fully local. Recommended.
🦙 **Ollama** — any model on a local Ollama instance
🤖 **OpenAI** — GPT-4.1, o3, or any OpenAI-compatible endpoint
🧠 **Anthropic** — Claude Opus 4.7 / Sonnet 4.6 / Haiku 4.5
💎 **Gemini** — Gemini 2.5 Pro / 2.0 Flash

Chat and classification can run on different providers. Common pattern: 35B llamacpp model for chat, small Ollama model for fast query routing.

Same retrieval pipeline regardless of which LLM is active.

---

### Post 5: Agent domain management

**Claude Code can now create and manage OB2 knowledge domains without touching the dashboard.**

New in OB2 TurboQuant: three MCP tools that give AI agents full domain lifecycle control:

🟢 `create_domain` — agent creates a new knowledge area on the fly, no human intervention needed

🔴 `delete_doc` — remove a specific document, with a mandatory confirmation step before anything is deleted

🔴 `delete_domain` — remove an entire domain and all its contents, with a mandatory confirmation step (shows the doc count so you know exactly what's at risk)

The confirmation gate is enforced at the tool boundary, not by convention. When an agent calls a destructive tool without `confirmed: true`, it gets a plain-English description of what would be deleted and must ask the user before proceeding.

Set up a dedicated global-admin user for your agent, configure `x-brain-key` in your MCP client, and your Claude Code sessions can self-organize knowledge as they go.

#AI #ClaudeCode #MCP #RAG #LocalAI #OpenSource

---

### Post 6: OB2 vs cloud RAG (updated)

**OB2 TurboQuant vs cloud RAG — what you're actually choosing between:**

Cloud RAG:
- Upload your documents to their servers
- Pay per embedding, per query
- Lose access when you stop paying
- No control over which model processes your data

OB2 TurboQuant:
- Documents stay on your hardware
- $0 per query (TurboQuant-compressed GGUF, no API costs)
- You own the data, the index, and the model
- Knowledge Graph built from your documents
- Apache-2.0 — fork it, modify it, white-label it

For documents you'd be uncomfortable sending to a third party: medical records, legal files, classified procedures, financial data.

---

## Twitter / X

### Tweet 1: TurboQuant

Google DeepMind's TurboQuant KV-cache compression is now built into OB2.

3-bit KV cache. 35B MoE model in 20 GB VRAM. Follow-up messages process only new tokens (--cache-prompt).

Fully local. $0/query. Apache-2.0.

---

### Tweet 2: Knowledge Graph

OB2 now extracts a Knowledge Graph from every document you ingest.

Entity/relationship graph → graph-augmented retrieval reranking → better answers.

Full Cytoscape.js visualization in the dashboard. GEXF export for Gephi. Backfill with resume support.

---

### Tweet 3: GGUF from dashboard

You shouldn't need a terminal to pull a GGUF from HuggingFace.

OB2 TurboQuant's dashboard: type repo + filename, watch progress in GB/s, click Load. Model card shows port and load time.

No CLI. No docker exec. No config edits.

---

### Tweet 4: Five LLM providers

OB2 now supports 5 LLM providers, hot-swappable from the Config tab:

- llamacpp (TurboQuant GGUF) ← recommended local
- Ollama
- OpenAI
- Anthropic
- Gemini

Same RAG pipeline regardless of provider. Chat and classification can use different ones.

---

### Tweet 5: Agent domain management

OB2 now lets Claude Code create and delete knowledge domains via MCP.

`create_domain` → instant. `delete_doc` / `delete_domain` → confirmation gate: the tool tells Claude what would be deleted and requires confirmed=true. User approves before anything is destroyed.

Global-admin agent key + x-brain-key header. That's it.

---

### Tweet 6: Retrieval timing

Retrieval in OB2 TurboQuant on a warm system: 8–14 ms.

Includes: embedding the query, pgvector HNSW cosine search, TF-IDF hybrid rerank, graph rerank.

Total request latency is dominated by LLM prefill, not retrieval.

---

### Tweet 6: Qwen3 on local hardware

Qwen3.6-35B-A3B-Q4_K_M: 20 GB GGUF, 35B parameters, 3B active (MoE).

On RTX 5090 with OB2 TurboQuant:
- Full model on GPU
- turbo3 KV cache compression
- 8192 token context
- --cache-prompt for fast follow-ups

This is what local AI looks like in 2026.

---

## Mastodon

### Post 1: TurboQuant launch

OB2 TurboQuant: self-hosted RAG with Google DeepMind's KV-cache compression.

New in this release:
- TurboQuant KV cache (turbo3 default): ~3 bits per value, fits 35B MoE model in 20 GB VRAM
- --cache-prompt: KV cache reuse across conversation turns
- GGUF model management from the dashboard: pull from HuggingFace, load/unload, set defaults
- Knowledge Graph: entity extraction + graph-augmented retrieval
- 5 LLM providers: llamacpp, Ollama, OpenAI, Anthropic, Gemini

Everything on your hardware. Apache-2.0. Docker. Five minutes.

### Post 2: Knowledge Graph

For anyone doing serious document work:

OB2's Knowledge Graph extracts entities and relationships from every document chunk. Graph-augmented retrieval boosts answers near entity connections. Full visualization in the dashboard.

This is what makes "ask your documents" actually useful at scale — not just keyword matching, but understanding what entities connect across your knowledge base.

---

## Hacker News

### Title options
- "OB2 TurboQuant: self-hosted RAG with Google DeepMind KV-cache compression, Knowledge Graph, GGUF management"
- "Show HN: OB2 TurboQuant — local RAG with 3-bit KV compression, entity graph, and full GGUF model management"
- "TurboQuant: 35B LLM in 20 GB VRAM, built into a self-hosted RAG platform"

### Comment-length summary

OB2 TurboQuant is a self-hosted RAG platform with Google DeepMind's TurboQuant KV-cache compression baked in.

What's new since the last release:
- **TurboQuant** (turbo3 by default): 3-bit KV cache compression, fits 35B MoE GGUF in 20 GB VRAM
- **--cache-prompt**: conversation KV cache reuse — follow-up turns process only new tokens
- **GGUF model management**: pull from HuggingFace or URL from the dashboard UI, load/unload with one click, set defaults from a dropdown
- **Knowledge Graph**: async entity/relationship extraction from every ingested chunk, graph-augmented retrieval reranking, Cytoscape.js visualization, GEXF export, backfill with resume support
- **5 LLM providers**: llamacpp (TurboQuant), Ollama, OpenAI, Anthropic, Gemini — hot-swappable from the Config tab
- **Retrieval timing**: 8–14 ms on a warm system (pgvector HNSW + graph rerank)
- **RAG token budget fix**: gateway was hardcoding 6000 tokens regardless of config, now uses runtime config value (default 2048)

The core remains the same: ingest any format (PDF with OCR, audio with Whisper, Office, URLs, ZIP), ask questions, get answers with clickable citations to original files, multi-user per-domain ACL.

Apache-2.0. Fully local. Runs in Docker.
