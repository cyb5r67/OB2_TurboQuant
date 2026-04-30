# OB2: A Fully Local RAG Platform That Reads Your Documents, Cites Its Sources, and Runs on Your Hardware

*We built OB2 after learning the hard way that there was no good middle ground between "send your files to OpenAI" and "build it yourself." Here's the full story — and what OB2 can do today.*

---

## The problem with cloud RAG

The promise of retrieval-augmented generation is simple: give an LLM access to your specific documents, and it will stop hallucinating generic answers and start citing your actual knowledge.

The problem is how most RAG products deliver it. They require you to upload your files to their servers. You pay per query. When you stop paying, you lose access to your indexed knowledge. And if your documents contain anything sensitive — medical records, legal filings, classified procedures, proprietary research — you've just shipped them to someone else's infrastructure.

We ran into this with our own internal knowledge bases. We had runbooks, CSV exports of infrastructure inventories, wiki pages, hundreds of PDFs. We wanted to ask questions of all of it without sending any of it to a cloud API.

We also tried an alternative: injecting knowledge directly into LLM weights (no retrieval at all). We spent a week rigorously testing whether you could insert facts into a model's FFN layers and have it "just know" your domain. The results were unambiguous: weight injection only activates when the query matches the internal template `"The {relation} of {entity} is"`. One out of ten natural-language paraphrases hit. Zero out of six procedural rule queries activated. The full spike findings are in the repo — it's a useful cautionary tale about testing assumptions before building.

So we built OB2: honest RAG, done right, running entirely on your hardware.

---

## What OB2 does

At its core, OB2 does three things:

1. **Ingests** documents in any format and indexes them as a searchable vector store.
2. **Retrieves** relevant chunks when you ask a question, across all the domains you have access to.
3. **Grounds** the LLM's response in those chunks, and tells you exactly which document each part of the answer came from — with a clickable link to the original file.

The clickable citation part is worth dwelling on. It is not enough to say "according to document X." OB2 signs a download URL for every source it uses. Click the link in the chat response and you get the original file — the actual PDF or Word document. The links work for 24 hours without requiring you to be logged into OB2. You can share them with a colleague.

---

## The ingestion pipeline: every format, no compromises

The most recent wave of development focused on making OB2 genuinely useful for real-world document collections.

**PDFs** — text-layer PDFs work out of the box. Scanned PDFs (common for older government documents, signed contracts, photocopied forms) now automatically trigger OCR via `ocrmypdf` with the high-quality Tesseract LSTM model. The pipeline deskews, cleans, rotates, and upsamples at 300 DPI before extracting text. A DD214 scanned at 150 DPI on a slightly tilted scanner comes out readable.

**Office documents** — DOCX, PPTX, XLSX. MarkItDown extracts the content; the chunker splits on document structure.

**Audio** — MP3, WAV, OGG, and other formats are transcribed via Whisper before chunking. Import a meeting recording, a voice memo, or a podcast episode.

**Archives** — ZIP files are extracted and each contained file is processed individually.

**URLs** — paste a URL and OB2 fetches and indexes the page. SSRF defense is built in: private network addresses, loopback, and link-local ranges are blocked before any fetch happens.

All of this is available both from the web dashboard (drag and drop) and from the `capture_file` MCP tool. Large files and audio queue an async job; the dashboard polls with exponential backoff and shows progress.

---

## Multi-user, per-domain access control

OB2 is not a single-user tool. It ships with a full multi-user system:

- Each user has a username, argon2id-hashed password, HMAC-signed session cookie, and a 128-bit API key.
- Each user has per-domain permissions: read, write, or admin, on each domain separately.
- Global admins can manage users, domains, and configuration.
- New users can be invited by email (single-use 7-day invite link) or provisioned directly.
- The brain-key bootstrap closes automatically the moment any real global admin exists — no "still using the test key in production" accidents.

The same ACL applies whether you authenticate via the dashboard (session cookie) or an API key (MCP client, Claude Code, Cursor). There is no separate "admin API" with different rules.

---

## Chat with Open WebUI

OB2 now ships an optional full chat interface via Open WebUI, activated with a single flag:

```bash
scripts/docker-start.sh --with-chat
```

The integration is worth understanding because it's not just "Open WebUI pointed at OB2's API." OB2 runs Open WebUI's reverse proxy on port 7601. When you click the Chat tab in the OB2 dashboard, your browser gets an HMAC-signed 1-minute handoff token, completes the SSO flow through the proxy, and lands in Open WebUI already signed in as your OB2 user.

When Open WebUI makes a chat request to OB2's `/v1/chat/completions`, it sends your identity in a header. OB2 verifies this, impersonates you, and applies your exact per-domain ACL to the retrieval. If you have read access to `@netsec` and `@runbooks` but not `@finance`, then chat queries search `@netsec` and `@runbooks` and never touch `@finance` — even though you never explicitly specified domains.

Signed citation URLs in chat responses mean source links work from Open WebUI's cross-origin context without requiring a separate OB2 login.

---

## Multi-domain retrieval: one scan, ranked together

Earlier versions of OB2 required an explicit `@domain` prefix to trigger retrieval. Prefix-less queries went through a classifier that tried to guess the right domain.

The classifier is still in the codebase, but it is no longer used for chat. Instead, prefix-less queries now trigger a single pgvector scan across every domain the caller has read access to. All chunks are ranked by cosine similarity together. The LLM sees the top-k results regardless of domain, along with domain and date attribution so it can cite correctly.

If you want to pin a query to a specific domain — for precision, or to exclude irrelevant domains — `@domain` prefix still short-circuits to single-domain retrieval.

---

## Under the hood

**Two-tier storage** writes are fast because they go to SQLite first (151 µs per capture). A background SyncWorker pushes everything to pgvector every five seconds for HNSW-indexed queries (2.3 ms). If pgvector is unreachable, the sync worker backs off exponentially and retries; queries fall back to SQLite in the meantime.

**Two sidecar runtimes**: the Python sidecar (sentence-transformers + PyTorch) is the default — stable, straightforward to debug. The Rust sidecar (`OB2_SIDECAR_RUNTIME=rust`) is a wire-compatible drop-in using ONNX Runtime 1.24.4 with CUDA 13 support (including Blackwell sm_120 kernels). On RTX 5090: 4x concurrent throughput, 13x faster cold start, 2x less RAM. Both runtimes share the same storage, so you switch with one env var and no data migration.

**Security**: every response carries CSP, HSTS (when HTTPS is configured), X-Frame-Options, and Permissions-Policy headers. Uploads are magic-byte sniffed. ZIP bombs are capped at 250 MB. SSRF is blocked at the DNS layer. The Open WebUI proxy strips incoming forwarded headers before injecting the authenticated identity. File-download tokens are HMAC-SHA256 signed and compared in constant time.

---

## Who is OB2 for?

Anyone who needs accurate, cited answers from their own documents, and cannot or will not send those documents to a cloud service:

- A military veteran querying a 40-year archive of service records and VA correspondence
- A school district whose curriculum committee needs to query policies without putting student data in the cloud
- A security team that maintains runbooks in markdown and wants "ask our runbooks" in Claude Code
- A legal team ingesting case files, deposition transcripts, and contract histories
- A researcher with 500 PDFs who needs to know "which of these papers cites method X"

OB2 is Apache-2.0. It runs in Docker with one command. It does not require a GPU (CPU fallback for embeddings works fine at small scale). It does not require a cloud account.

```bash
git clone <repo> && cd OB2
export OB2_BRAIN_KEY=my-secure-key
scripts/docker-start.sh --with-chat
# Dashboard: http://localhost:7600/dashboard
# Chat:      http://localhost:7601
```

Full documentation in the `docs/` directory.

---

*The best RAG implementation is the one that stays on your hardware, reads your actual documents, and tells you exactly where it got every answer.*
