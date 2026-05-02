# OB2 TurboQuant — Personal RAG, Fully On Your Hardware

## Your knowledge. Your hardware. Grounded answers with clickable sources.

**OB2 TurboQuant** is an open-source platform that turns your documents into a queryable knowledge base powering any local LLM — including your own GGUF models with Google DeepMind's TurboQuant KV-cache compression. Upload files in any format, ask questions in plain English, and get answers that cite the exact source — with a link to the original document.

Everything runs on your own machine. Your data never leaves.

---

### The problem

LLMs give generic answers because they don't know your specific documents, procedures, or records. Cloud RAG services exist, but they require sending your files to third parties, charge per query, and are overkill to self-host.

### How OB2 TurboQuant is different

| What | How |
|---|---|
| **Any file format** | PDF (including scanned docs — OCR built in), Word, PowerPoint, Excel, HTML, audio (transcribed), images, ZIP archives, URLs, YouTube transcripts |
| **TurboQuant KV compression** | Run any GGUF model with 3-bit KV-cache compression — up to 8x faster inference, dramatically lower VRAM requirements, negligible accuracy loss |
| **Any GGUF model** | Pull Qwen3, Mistral, Llama, or any model directly from HuggingFace in the dashboard. No Ollama required for inference. |
| **Knowledge Graph** | Async entity/relationship extraction from your documents. Graph-augmented retrieval reranks answers by traversing entity connections — more relevant results, better answers. |
| **Clickable citations** | Every answer links back to the original document. Click to download. Links work for 24 hours without requiring a login. |
| **Multi-user, per-domain ACL** | Multiple users, each with read/write/admin access on specific domains. The same ACL applies to dashboard logins and API keys. |
| **Fully local** | Ollama or llamacpp on your hardware, embeddings on your GPU, pgvector in Docker. Zero cloud dependency. $0/query. |
| **Cloud providers too** | Switch to OpenAI, Anthropic, or Gemini from the Config tab — same interface, same RAG pipeline, same citations. |
| **Open WebUI chat surface** | Optional — one flag enables a full chat UI with SSO from the OB2 dashboard. |
| **Self-service admin** | Web dashboard: pull GGUF models from HuggingFace, load/unload models, manage users, hot-reload config. No CLI required. |
| **Opt-in Rust sidecar** | 4x bulk-ingest throughput, 13x faster cold start, 2x less RAM vs the Python default — one env var to switch. |

### How it works

```
Upload:   Drop a scanned PDF on the Domains tab
          -> OCR -> chunk -> embed -> store
          -> graph extraction (async): entities + relationships indexed

Query:    Ask a question in the chat interface
          -> search all your domains (vector + TF-IDF + graph rerank)
          -> ground the LLM (TurboQuant-accelerated GGUF model)
          -> answer with source link

Cite:     Click the [Source] link in the answer
          -> download the original file
```

### Who it's for

Anyone who needs accurate answers from their own documents:

- Military veterans who want to query their service records (DD214, medical files)
- Researchers with hundreds of PDFs who need precise citations
- Security teams maintaining runbooks and incident playbooks
- Legal and compliance teams keeping documents off the cloud
- School districts managing curriculum and policy documents
- Small businesses who want "ask our handbook" without paying per query

### Key numbers

- **5-minute setup** via Docker
- **$0/query** — local GGUF via TurboQuant-enabled llama.cpp, no API costs
- **3-bit KV cache** — TurboQuant compresses context window VRAM by up to 8x
- **8-14ms retrieval** — warm pgvector HNSW query including graph reranking
- **151 µs capture latency** (SQLite write cache)
- **250 MB max upload** (configurable)
- **24-hour signed citation URLs** (no login required to view sources)
- **Apache-2.0 licensed**

### Get started

```bash
git clone <repo> && cd OB2_TurboQuant
cp .env.example .env  # set OB2_BRAIN_KEY

# Start with llamacpp + TurboQuant + chat UI
docker compose -f docker/docker-compose.yml --env-file .env \
  --profile llamacpp --profile openwebui up -d

# Dashboard: http://localhost:7600/dashboard
# Chat:      http://localhost:7601
# Pull a GGUF model from the LLMs tab, load it, and start chatting
```

Full docs at `docs/user-guide.md` (end users) and `docs/deployment.md` (operators).
