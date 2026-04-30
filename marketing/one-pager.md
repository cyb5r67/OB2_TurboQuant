# OB2 — Personal RAG, Fully On Your Hardware

## Your knowledge. Your hardware. Grounded answers with clickable sources.

**OB2** is an open-source platform that turns your documents into a queryable knowledge base powering any local LLM. Upload files in any format, ask questions in plain English, and get answers that cite the exact source — with a link to the original document.

Everything runs on your own machine. Your data never leaves.

---

### The problem

LLMs give generic answers because they don't know your specific documents, procedures, or records. Cloud RAG services exist, but they require sending your files to third parties, charge per query, and are overkill to self-host.

### How OB2 is different

| What | How |
|---|---|
| **Any file format** | PDF (including scanned docs — OCR built in), Word, PowerPoint, Excel, HTML, audio (transcribed), images, ZIP archives, URLs, YouTube transcripts |
| **Clickable citations** | Every answer links back to the original document. Click to download. Links work for 24 hours without requiring a login. |
| **Multi-user, per-domain ACL** | Multiple users, each with read/write/admin access on specific domains. The same ACL applies to dashboard logins and API keys. |
| **Fully local** | Ollama on your hardware, embeddings on your GPU, pgvector in Docker. Zero cloud dependency. $0/query. |
| **Open WebUI chat surface** | Optional — one flag enables a full chat UI with SSO from the OB2 dashboard. |
| **Self-service admin** | Web dashboard: create users, upload files, manage domains, test connections, hot-reload config. No YAML editing required for day-to-day work. |
| **Opt-in Rust sidecar** | 4x bulk-ingest throughput, 13x faster cold start, 2x less RAM vs the Python default — one env var to switch. |

### How it works

```
Upload:   Drop a scanned PDF on the Domains tab
          -> OCR -> chunk -> embed -> store

Query:    Ask a question in the chat interface
          -> search all your domains -> ground the LLM -> answer with source link

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
- **$0/query** — local Ollama, no API costs
- **151 µs capture latency** (SQLite write cache)
- **2.3 ms query latency** (pgvector HNSW index)
- **250 MB max upload** (configurable)
- **24-hour signed citation URLs** (no login required to view sources)
- **Apache-2.0 licensed**

### Get started

```bash
git clone <repo> && cd OB2
export OB2_BRAIN_KEY=my-secure-key

# Start with chat UI
scripts/docker-start.sh --with-chat

# Dashboard: http://localhost:7600/dashboard
# Chat:      http://localhost:7601
```

Full docs at `docs/user-guide.md` (end users) and `docs/deployment.md` (operators).
