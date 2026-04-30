# File & URL Ingestion via MarkItDown

**Date:** 2026-04-25
**Status:** Draft for review

## Background

OB2's only ingestion path today is `capture_knowledge(domain, text)` — text in, text out. Anyone with a PDF, Word doc, slide deck, spreadsheet, image, audio file, or webpage has to extract the text themselves before they can capture it. That's friction, and naive text extraction loses the structural cues (headers, lists, tables) that make embedded chunks rank well at retrieval time.

[MarkItDown](https://github.com/microsoft/markitdown) is Microsoft's actively-maintained Python library that converts essentially any common document, image, audio, or web format into clean Markdown specifically for LLM ingestion. It already covers exactly the formats we care about, ships with both a Python API and a CLI, and slots into our existing Python sidecar.

This spec adds file/URL ingestion to OB2 with one upload UI in the dashboard and one new MCP tool — both backed by the same conversion pipeline.

## Goals

- Any file a user has on disk, or any URL they can name, becomes searchable in OB2 with one action and no manual text extraction.
- Structured formats (Markdown headers, tables, slide titles) preserve their structure into per-chunk embeddings so retrieval ranks well.
- The capture path stays consistent with what already works: chunks land in the same `docs` table, with the same metadata shape, accessible to the same per-domain ACL and multi-domain search.
- Both human (dashboard) and agentic (MCP) workflows are supported.

## Non-goals

- Continuous re-sync of files (file changed on disk → auto re-ingest). One-shot ingestion only.
- Authoring or editing documents inside OB2.
- Format-specific viewers in the dashboard. We capture; the original file isn't stored.
- Streaming uploads larger than `OB2_IMPORT_MAX_BYTES` (default 250 MB).
- Batch ingestion of entire directories. Single file or single URL per call. (ZIP archives are the recursive case.)

## Format support

Shipped in the image (Profile **C** from brainstorming):

| Category | Formats |
|---|---|
| Office | PDF, DOCX, PPTX, XLSX, RTF |
| Plain / structured | TXT, MD, CSV, JSON, XML, HTML |
| Images (OCR via tesseract) | PNG, JPG, TIFF, scanned PDFs |
| Audio (transcription via Whisper) | MP3, WAV, M4A, FLAC, OGG |
| Archives | ZIP (recursive, depth-capped) |
| Web | arbitrary HTTP(S), YouTube transcript URLs, EPUB |

System-level dependencies added to the Dockerfile: `tesseract-ocr`, `tesseract-ocr-eng`, `libtesseract-dev`, `ffmpeg`. Python deps added to `retrieval/pyproject.toml`: `markitdown[all]`. Whisper model defaults to `base.en` (~150 MB) on CPU; configurable via `OB2_WHISPER_MODEL` and `OB2_WHISPER_DEVICE`. The `base.en` model on CPU avoids GPU contention with Gemma; users with spare VRAM can flip to `small.en` or `medium.en` on `cuda` via env.

## Architecture

```
                    Browser                          MCP client
                       │                                 │
       multipart upload│                                 │ JSON-RPC
                       ▼                                 ▼
    ┌─────────────────── ob2-server (Hono) ─────────────────────────┐
    │  POST /admin/domains/:domain/import        (NEW, multipart)   │
    │  POST /admin/domains/:domain/import/url    (NEW, JSON)        │
    │  GET  /admin/domains/:domain/import/jobs/:id (NEW, async)     │
    │  MCP tool capture_file(domain, path_or_url, ...)  (NEW)       │
    │                                                               │
    │  • Auth: requires `write` on the target domain                │
    │  • Streams body → /tmp/upload-<uuid>.<sniffed-ext>            │
    │  • Sniffs magic bytes; refuses mismatched payloads            │
    │  • Decides sync vs async (audio, ZIP, files >25MB → async)    │
    │  • Calls sidecar.convert_to_markdown                          │
    │  • Chunks markdown by header → each chunk → sidecar.capture   │
    │  • Returns doc_ids + warnings (sync) or job_id (async)        │
    └───────────────────────────────┬───────────────────────────────┘
                                    │ JSON-RPC over stdio
                                    ▼
    ┌─────────────────── Python sidecar ─────────────────────────────┐
    │  method_convert_to_markdown(path_or_url) → markdown + meta     │
    │     • Single MarkItDown instance, lazily initialised           │
    │     • OCR/Whisper invoked transparently for image/audio        │
    │  method_capture(...) — existing, unchanged                     │
    │  In-process job queue (Map<job_id, JobRecord>) + persisted     │
    │     to /data/import-jobs.json for restart survival             │
    └────────────────────────────────────────────────────────────────┘
```

### Per-request lifecycle

1. **Auth.** `requirePerm(domain, "write")` (existing helper).
2. **Receive.** Stream the request body (or fetch the URL) into `/tmp/upload-<uuid>.<sniffed-ext>`. Magic-byte sniff before writing more than 4 KB; refuse on mismatch.
3. **Route.** If sync-eligible (office, plain, image, HTML, non-YouTube URL, file ≤ 25 MB), block the request. Otherwise create a job and return `{job_id, status:"queued"}`.
4. **Convert.** `sidecar.call("convert_to_markdown", {source: path_or_url})` returns `{markdown, title, source_format, char_count, warnings, duration_ms}`.
5. **Chunk.** Server-side `chunkMarkdown(md, maxChars=1500, overlap=200)`:
   - Split on H1/H2 boundaries.
   - Sections > `maxChars` further split at H3 / blank-line boundaries.
   - Hard-cut at `maxChars` if needed, with `overlap` carryover.
   - Each chunk gets prepended with the H1/H2 breadcrumb so the embedding remembers its section context.
6. **Capture.** For each chunk: `sidecar.call("capture", {domain, text: chunk, metadata, source_hash})` with metadata as defined below.
7. **Cleanup.** Delete `/tmp/upload-*` in a `finally` block.
8. **Respond.** Sync: `{ok, doc_ids[], source_format, chunks_captured, warnings[]}`. Async: `{ok, job_id, status}`.

### Per-chunk metadata

```json
{
  "_ob2_import_source": "research-paper.pdf",
  "_ob2_import_format": "pdf",
  "_ob2_chunk_index": 3,
  "_ob2_chunk_total": 12,
  "_ob2_breadcrumb": "Troubleshooting > Network",
  "source": "research-paper.pdf",
  "tags": ["research", "tls"]
}
```

The `tags` array, if any, is supplied by the caller and stored verbatim. The `source` field carries the human-meaningful filename for citation labels — `[N] @domain · research-paper.pdf` will render automatically because `method_build_multi_context` already prefers `metadata.source` over the bare doc_id.

The `source` field is what surfaces in citations (`[1] @test · research-paper.pdf`) — using the existing logic in `method_build_multi_context`. No changes there.

### Async job queue

- In-memory `Map<job_id, JobRecord>` plus periodic write-through to `/data/import-jobs.json` (mtime hot-reload, same pattern as `users.json`).
- `JobRecord = { id, domain, source_label, status, progress?, result?, error?, created_at, updated_at }`. Status progresses `queued` → `converting` → `chunking` → `embedding` → `done` / `error` / `interrupted`.
- Records expire 24 h after `status` reaches a terminal state.
- On server start, any record still in a non-terminal state moves to `interrupted` (its in-flight conversion died with the previous process).
- No external queue. The OB2 use case is small enough that the in-process Map is enough; if it ever isn't, we'd swap the implementation behind the same API without changing the HTTP surface.

## API surface

### `POST /admin/domains/:domain/import`

Body: `multipart/form-data` with fields:
- `file` (required, binary) — the file to ingest.
- `tags` (optional, comma-separated) — propagated into chunk metadata.
- `source_label` (optional, string) — overrides auto-derived filename in metadata. Useful for ZIP imports where the original filename is meaningless.

Response shape (sync):
```json
{
  "ok": true,
  "doc_ids": ["modtgtbs-thlbem", "modtgtbs-thlbf2", ...],
  "source_format": "pdf",
  "chunks_captured": 12,
  "warnings": ["OCR confidence low on page 7"]
}
```

Response shape (async):
```json
{ "ok": true, "job_id": "imp_8c2a91f3", "status": "queued" }
```

### `POST /admin/domains/:domain/import/url`

JSON body: `{ url, tags?, source_label? }`. Same response shapes.

### `GET /admin/domains/:domain/import/jobs/:id`

Response:
```json
{
  "id": "imp_8c2a91f3",
  "status": "converting" | "chunking" | "embedding" | "done" | "error" | "interrupted",
  "progress": 0.38,
  "source_label": "keynote-recording.mp3",
  "result": { ... }, // present when status=="done"; same shape as the sync response
  "error": { "message": "...", "type": "..." }, // present when status=="error"
  "created_at": "2026-04-25T...",
  "updated_at": "2026-04-25T..."
}
```

### MCP `capture_file`

```jsonc
{
  "name": "capture_file",
  "description": "Convert a file or URL to Markdown and capture into a domain. Supports PDF/DOCX/PPTX/XLSX/HTML/CSV/JSON/XML/MD/TXT/images (OCR)/audio (Whisper)/ZIP/HTTP URLs/YouTube. Files must be inside the container's /data volume; arbitrary host paths are refused.",
  "inputSchema": {
    "type": "object",
    "required": ["domain", "path_or_url"],
    "properties": {
      "domain": { "type": "string" },
      "path_or_url": {
        "type": "string",
        "description": "either a /data/... path or an https:// URL"
      },
      "source_label": { "type": "string" },
      "tags": { "type": "array", "items": { "type": "string" } }
    }
  }
}
```

Auth: same as `capture_knowledge` — needs `write` on `domain`.

Path safety: a path-mode call is canonicalised with `path.realpath`; if the result does not start with `/data/`, refuse with `400 path_outside_volume`. No symlink-following outside the volume.

For long-running ingestions (audio, ZIPs), the MCP tool blocks until done — agents are typically OK with longer waits, and an MCP tool returning a job-id mid-conversation creates more friction than it solves. The MCP path uses a separate, longer ceiling (`OB2_IMPORT_MCP_TIMEOUT_SEC`, default 600) instead of `OB2_IMPORT_SYNC_TIMEOUT_SEC`. Files that exceed it surface as a `conversion_timeout` error to the calling agent, which can retry or escalate.

## Configuration

New env vars in `docker/docker-compose.yml`:

| Var | Purpose | Default |
|---|---|---|
| `OB2_IMPORT_MAX_BYTES` | Hard upload size cap (decompressed for ZIP). | `262144000` (250 MB) |
| `OB2_IMPORT_SYNC_THRESHOLD_BYTES` | Files larger than this are processed async. | `26214400` (25 MB) |
| `OB2_IMPORT_SYNC_TIMEOUT_SEC` | Max wall-clock for HTTP-sync conversion. | `60` |
| `OB2_IMPORT_MCP_TIMEOUT_SEC` | Max wall-clock for MCP `capture_file` (agents tolerate longer waits). | `600` |
| `OB2_WHISPER_MODEL` | Whisper model size. | `base.en` |
| `OB2_WHISPER_DEVICE` | `cpu` or `cuda`. | `cpu` |
| `OB2_OCR_LANGUAGE` | Tesseract language code. | `eng` |
| `OB2_IMPORT_URL_DENYLIST` | Comma-separated CIDR list to block at the URL fetcher (SSRF defense). | `127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,::1/128,fc00::/7` |

## Security

- **Magic-byte sniffing.** First 4 KB of the upload is sniffed; if the inferred type doesn't match the declared content-type or filename extension, refuse with `400 conversion_failed`. Don't trust the client.
- **Path traversal.** `capture_file` path mode resolves the input with `path.realpath`. The result must start with `/data/`. No symlinks followed outside the volume.
- **SSRF.** URL ingestion goes through the server layer's URL fetcher first (not directly to MarkItDown). DNS-resolve the host and check every returned IP against `OB2_IMPORT_URL_DENYLIST`. Refuse private/loopback/link-local. The fetched bytes are then handed to MarkItDown via a temp file rather than passing the URL itself.
- **ZIP bomb.** Recursion depth ≤ 3. Total expanded byte count ≤ `OB2_IMPORT_MAX_BYTES`, monitored mid-extraction; abort if exceeded.
- **Tmp file hygiene.** Every upload writes to `/tmp/upload-<uuid>.<ext>`. Deleted in a `finally` block. A 5-minute sweeper removes orphans older than 1 hour from `/tmp/upload-*`.
- **Original content not retained.** Only the converted markdown chunks are stored. If users need the original file, they keep it themselves.
- **Audit trail.** Each chunk's metadata records `_ob2_import_source` and `_ob2_import_format`, so an admin can later answer "where did doc X come from?".

## Error handling

| Situation | HTTP | `type` |
|---|---|---|
| Caller lacks `write` on domain | 403 | `permission_error` |
| File over `OB2_IMPORT_MAX_BYTES` | 413 | `payload_too_large` |
| Unsupported / unrecognised format | 415 | `unsupported_media_type` |
| Conversion failed (corrupt file, ZIP bomb, OCR engine refused) | 400 | `conversion_failed` |
| URL fetch upstream returned non-2xx | 502 | `upstream_fetch_failed` |
| URL resolves to denylisted IP | 400 | `url_blocked` |
| YouTube transcript unavailable | 422 | `no_transcript` |
| Whisper requested but disabled / model missing | 503 | `audio_disabled` |
| Sync conversion exceeded `OB2_IMPORT_SYNC_TIMEOUT_SEC` | 504 | `conversion_timeout` |
| Path-mode `capture_file` references outside `/data` | 400 | `path_outside_volume` |
| Job ID not found / expired | 404 | `not_found` |

Conversion *warnings* (e.g., "OCR confidence low on page 7", "PowerPoint slide 12 had no text") are not errors — they ride on the success response so users know what was lossy.

## Files touched

| File | Change |
|---|---|
| `retrieval/pyproject.toml` | Add `markitdown[all]` and pin a major version. |
| `Dockerfile` | Install `tesseract-ocr`, `tesseract-ocr-eng`, `libtesseract-dev`, `ffmpeg` system packages. |
| `retrieval/sidecar.py` | New `method_convert_to_markdown`. |
| `server/proxy/...` (no change) | — |
| `server/routes/admin.ts` | New `POST /admin/domains/:domain/import`, `POST /admin/domains/:domain/import/url`, `GET /admin/domains/:domain/import/jobs/:id`. |
| `server/routes/mcp.ts` | New `capture_file` tool. |
| `server/import/chunker.ts` | New. `chunkMarkdown(md, maxChars, overlap) → Chunk[]`. |
| `server/import/jobs.ts` | New. In-memory job queue with disk persistence to `/data/import-jobs.json`. |
| `server/import/url_fetcher.ts` | New. URL fetch with SSRF denylist. |
| `server/static/dashboard.html` | Upload zone markup in the Manage Domain modal's Docs panel. |
| `server/static/dashboard.js` | Upload handler (drag-drop + URL paste); job poller; recent-imports list. |
| `docker/docker-compose.yml` | New env vars for size limits + Whisper config. |
| `tests/fixtures/import/` | New directory with `tiny.pdf`, `tiny.docx`, `tiny.png`, `tiny.html`, `tiny.mp3`, `bomb.zip`, `nested.zip`. |
| `tests/e2e.sh` | New Step 19 covering all formats + security cases. |

## Dashboard UI

In the Manage Domain modal's Docs tab, above the existing doc list, an upload zone visible only when `effective_permission` is `write` or `admin`:

```
┌──────────────────────────────────────────────────────────────┐
│  Import file or URL                                          │
│  ┌────────────────────────────────────────────────────┐      │
│  │  Drop a file here, click to browse, or paste URL   │      │
│  │                                                    │      │
│  │  PDF · DOCX · PPTX · XLSX · MD · HTML · CSV ·     │      │
│  │  PNG · JPG · MP3 · WAV · ZIP · HTTP · YouTube     │      │
│  └────────────────────────────────────────────────────┘      │
│  [paste URL……………………………………………………] [Import]                  │
│                                                              │
│  Recent imports (this session):                              │
│   ✓ research-paper.pdf — 12 chunks captured                  │
│   ⏳ keynote-recording.mp3 — transcribing… 38%                │
│   ✗ broken.zip — corrupted archive                           │
└──────────────────────────────────────────────────────────────┘
```

Behaviour:
- Drag-drop or file-picker via a single `<input type="file">` styled as the dropzone — no third-party library.
- URL paste field calls the `/import/url` endpoint.
- Sync results show a toast and trigger an immediate refresh of the doc list below.
- Async jobs render a row in "Recent imports" with live status. JS polls the job endpoint every 2 s, backing off to 10 s after the first 30 s.
- Recent-imports list is per-tab in-memory only. A persistent activity log is out of scope here.

The Domains tab also gets a top-level **+ Import** button (admin only) that opens a modal version of the upload UI with a domain-picker — for "I have a file but haven't decided which domain yet" scenarios.

## Testing

`tests/e2e.sh` Step 19 (new). No special env preconditions beyond the standard stack — does not require the Open WebUI sidecar. Skips audio assertions cleanly if Whisper isn't present in the image.

Fixtures (`tests/fixtures/import/`):
- `tiny.pdf` — 3 pages, plain text + one table.
- `tiny.docx` — single paragraph.
- `tiny.pptx` — one slide with a heading and bullets.
- `tiny.xlsx` — 4 rows × 3 columns.
- `tiny.png` — image with rendered text "Captain Picard" (OCR target).
- `tiny.html` — minimal HTML page with one heading.
- `tiny.mp3` — ~3 s of speech.
- `bomb.zip` — 1 KB ZIP that expands to 10 GB.
- `nested.zip` — ZIPs nested 4 deep.

Assertions:
1. Upload `tiny.pdf` to `@import-test` (a fresh domain): 200, `chunks_captured ≥ 1`, `source_format=pdf`. A search for a phrase from page 2 returns the doc.
2. DOCX upload: 200, captured.
3. PPTX upload: 200, captured.
4. XLSX upload: 200, captured.
5. PNG upload (OCR): job either sync (small) or async; eventually search for "Captain Picard" returns the doc.
6. HTML upload: 200, captured.
7. URL ingestion of `https://example.com/`: 200, captured.
8. Audio upload (`tiny.mp3`): returns `job_id`; polling reaches `done`; search for transcript text returns the doc.
9. ZIP-bomb upload: 400 `conversion_failed`; no docs leaked into the domain.
10. Nested ZIP at depth 4: 400.
11. SSRF: URL `http://127.0.0.1:11434/...`: 400 `url_blocked`.
12. Path traversal: `capture_file` with `path="/etc/passwd"`: 400 `path_outside_volume`.
13. Auth: alice (no `write` on `@import-test`) tries to upload: 403.
14. Size cap: file > `OB2_IMPORT_MAX_BYTES`: 413.
15. Citation check: a successful PDF capture, then a chat query whose answer lives in the PDF, returns a citation containing the PDF filename (not the internal `doc_id`).

Manual smoke checks (browser):
- Drag a real PDF into the Manage Domain modal's upload zone. Doc list refreshes with new chunks.
- Paste a YouTube URL. Job appears in "Recent imports" with live status. Once done, a chat query on the topic returns content from the transcript.

## Risks & open questions

- **Image size growth.** `markitdown[all]` plus tesseract plus ffmpeg plus a Whisper model adds ~1.2 GB to the image. Acceptable, but worth noting at build time.
- **Whisper accuracy.** `base.en` is fast but error-prone on noisy audio or non-American-English speakers. Operators who care can flip to `medium.en` (or a multilingual model) at the cost of VRAM and time. Documented in the env-var table.
- **MarkItDown version drift.** Pin to a specific minor (e.g. `>=0.1,<0.2`); bump deliberately. New format support shows up in their releases.
- **Citation source-label collisions.** Two different PDFs both named `paper.pdf` produce identical `source` strings on their chunks. We don't deduplicate; both sets coexist. If retrieval surfaces both, the LLM will treat them as separate sources `[1]` and `[2]`. Acceptable for now; if it becomes confusing, we can append a short hash to the source label.
- **Tmp file disk pressure.** Big uploads + container with default 10 GB writable layer could hit ENOSPC if uploads run faster than they're cleaned. The 5-minute orphan sweeper plus per-request `finally` cleanup should be enough; worth monitoring on first deploy.
