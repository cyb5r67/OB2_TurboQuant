# OB2 Social Media Posts

---

## LinkedIn

### Post 1: Launch

**Your documents. Your hardware. Answers that cite their sources.**

We just shipped a major update to OB2 — a fully self-hosted RAG platform.

What it does now:
- Uploads any format: PDFs (including scanned docs — OCR built in), Word, PowerPoint, audio files, ZIP archives, URLs
- Answers questions grounded in your documents, with clickable links to the original files
- Multi-user with per-domain access control: your team's medical records don't mix with their HR files
- Optional Open WebUI chat interface — one flag, SSO from the dashboard
- Runs entirely on your hardware. Nothing leaves your network. $0/query.

The clickable citations are the part I'm most proud of. Every answer includes a link to the original document that justified it. Works for 24 hours without requiring a login. Click to see the actual PDF or Word doc.

If you work with sensitive documents — legal filings, service records, clinical protocols, financial data — this is what self-hosted RAG actually looks like.

Apache-2.0. Five minutes to start. Link in comments.

#AI #RAG #Privacy #OpenSource #DocumentManagement

---

### Post 2: Ingestion

**Your DD214 doesn't belong to OpenAI.**

Veterans have mountains of paperwork: DD214s, service treatment records, VA correspondence. All of it relevant when filing a claim or an appeal. Most of it scanned at weird angles on someone's home printer.

OB2 reads scanned PDFs. It OCRs them with the Tesseract LSTM model at 300 DPI — deskew, rotation correction, the works. Then it indexes them locally so you can ask questions:

"Which letters from the VA reference my hearing loss claim?"
"What was my unit during my 2004 deployment?"

Answers with citations. Click to see the original document. Nothing sent to any server you don't control.

This is a real use case for a real population of people. OCR and original file storage existed in OB2 for this reason.

---

### Post 3: Multi-user access control

**Multi-user RAG that actually respects access boundaries.**

The problem with "just give everyone access to the knowledge base" is that not all knowledge belongs to everyone.

OB2's per-domain ACL:
- Legal team gets read access to @legal-matter-2024
- HR gets write access to @hr-policy
- Security gets admin on @netsec
- Everyone can search @company-handbook

Same ACL whether you're using the dashboard, Claude Code, or any OpenAI-compatible client.

New user? Send an invite link (7-day expiry, single-use). They set their password, they're in. Their access is exactly what you granted.

This is the boring security infrastructure that makes a knowledge platform trustworthy.

---

### Post 4: OB2 vs cloud RAG

**OB2 vs cloud RAG — what you're actually choosing between:**

Cloud RAG:
- Upload your documents to their servers
- Pay per embedding, per query
- Lose access when you stop paying
- Hope they don't breach

OB2:
- Documents stay on your hardware
- $0 per query (local Ollama + local GPU)
- You own the data, the index, and the model
- Apache-2.0, fork it if you want

For documents you'd be uncomfortable sending to a third party — medical records, legal files, classified procedures, financial data — OB2 is the option that doesn't require you to trust someone else.

Five minutes to start: `scripts/docker-start.sh --with-chat`

---

## Twitter / X

### Tweet 1: Hook

Just shipped: OB2 can now ingest scanned PDFs (OCR built in), audio files (Whisper transcription), Word/Excel/PowerPoint, ZIPs, URLs.

You ask a question, it cites the source with a clickable link to the original file.

Everything on your hardware. $0/query. Apache-2.0.

---

### Tweet 2: Citation links

The new feature in OB2 I'm most excited about: clickable citation links in every chat response.

Not "according to document X." An actual link to the original PDF or Word file. Works for 24 hours without requiring a login.

You can share a source link with a colleague. They click it, they see the document.

---

### Tweet 3: DD214

Your DD214 doesn't belong to OpenAI.

OB2 reads scanned PDFs. OCR built in. Runs on your laptop. Nothing leaves your network.

Veterans have decades of paperwork to query. This is the use case that made us build proper OCR support.

---

### Tweet 4: Multi-user

Multi-user RAG finally done right:

- Per-domain ACL (read/write/admin per user per domain)
- argon2id passwords + HMAC session cookies
- 128-bit API keys for machine clients
- Brain key retires automatically when real admins exist
- Email invite + password reset flows

Same rules whether you auth via browser session or API key.

---

### Tweet 5: Open WebUI

OB2 now ships with an optional Open WebUI chat surface:

```
scripts/docker-start.sh --with-chat
```

SSO from the OB2 dashboard. Per-user domain ACL applies inside chat. Responses include clickable source links.

Chat queries search every domain you can read — one pgvector scan, ranked together.

---

### Tweet 6: Rust sidecar

OB2's retrieval runs in Python (default) or Rust (opt-in, `OB2_SIDECAR_RUNTIME=rust`).

Same JSON-RPC. Same storage. No data migration. On RTX 5090:

- 4x concurrent throughput (1,124 vs 281 caps/sec)
- 13x faster cold start (0.36s vs 4.63s)
- 2x less RAM (687MB vs 1,396MB)

Golden-fixture parity suite locks both runtimes byte-identical on every PR.

---

## Mastodon

### Post 1: Launch

OB2: self-hosted RAG platform for anyone who needs grounded answers from their own documents.

New features: multi-format ingestion (PDFs with OCR, audio with Whisper, Office, URLs, ZIP archives), clickable citation links (links to original files, 24-hour signed tokens, work without a login), multi-user + per-domain ACL, Open WebUI chat surface with SSO.

Everything on your hardware. Your documents don't leave your server.

Apache-2.0. Docker. Five minutes.

`scripts/docker-start.sh --with-chat`

### Post 2: Privacy angle

For anyone working with sensitive documents:

The premise of cloud RAG is "upload your files and we'll answer questions about them." That's fine for generic documents. For medical records, legal files, classified procedures, government forms — you want a different answer.

OB2 runs on your hardware. No API calls for embeddings. No API calls for answers. Ollama runs locally. pgvector runs in Docker. Your documents index on your GPU.

Apache-2.0. Fork it. Self-host it. Own it.

---

## Hacker News

### Title options
- "OB2: Self-hosted RAG with OCR, audio transcription, multi-user ACL, and clickable citations"
- "Show HN: OB2 — fully local RAG that reads scanned PDFs, audio files, and cites sources with clickable links"
- "Your DD214 doesn't belong to OpenAI: self-hosted RAG for sensitive documents"

### Comment-length summary

OB2 is a self-hosted RAG platform. You upload documents (PDFs including scanned ones, audio, Word/Excel, URLs, etc.), ask questions, and get answers that cite their sources with clickable links to the original files.

What's new in the last few days: full multi-format ingestion via MarkItDown + ocrmypdf, original file storage with 24-hour HMAC-signed download URLs embedded in chat responses, multi-user with per-domain ACL, Open WebUI chat surface with SSO, multi-domain retrieval (prefix-less queries search all your domains in one pgvector scan).

For anyone working with documents they can't send to OpenAI: military service records, legal files, medical records, classified procedures. Everything runs locally — Ollama for generation, sentence-transformers for embeddings, pgvector for search.

Apache-2.0. Five minutes to start with Docker. 19-step E2E test suite. Full docs in the repo.

`scripts/docker-start.sh --with-chat`
