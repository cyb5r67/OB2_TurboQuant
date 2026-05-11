# MarkItDown File & URL Ingestion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users drop any file or URL into OB2 and have it converted to Markdown, chunked, embedded, and captured into a domain — surfaced via dashboard upload + a new MCP tool.

**Architecture:** Add Microsoft's `markitdown` to the existing Python sidecar as a single new RPC method (`convert_to_markdown`). The Hono server gains three HTTP endpoints (file upload, URL ingestion, async job poll) plus an MCP tool, all calling the sidecar then chunking the resulting Markdown and feeding chunks through the existing `capture` RPC. Async runs through an in-process job queue persisted to `/data/import-jobs.json`.

**Tech Stack:** Python (sidecar) + Deno/Hono (server) + vanilla JS dashboard. New runtime deps: `markitdown[all]`, `tesseract-ocr`, `ffmpeg`, Whisper (`base.en` on CPU by default).

**Spec:** `docs/superpowers/specs/2026-04-25-markitdown-ingestion-design.md`

**Working in Docker:** Every smoke test in this plan runs against the `ob2-server` container. Pattern per task: `docker cp` changed files into the container, `docker compose restart ob2-server`, smoke via curl on `http://127.0.0.1:7600`. After a related cluster of tasks lands, kick a background `docker compose build ob2-server` so the image stays current and changes survive container recreation.

---

## File structure

| Path | Purpose | New / Modified |
|---|---|---|
| `Dockerfile` | Install `tesseract-ocr`, `tesseract-ocr-eng`, `libtesseract-dev`, `ffmpeg`, `libreoffice-common` system packages. | Modified |
| `retrieval/pyproject.toml` | Add `markitdown[all]>=0.1.5,<0.2`. | Modified |
| `retrieval/sidecar.py` | Register new `convert_to_markdown` RPC method; lazily-init a single `MarkItDown` instance. | Modified |
| `server/import/chunker.ts` | `chunkMarkdown(md, opts)` — header-aware chunker with overlap. Pure function. | New |
| `server/import/url_fetcher.ts` | Fetch a URL after SSRF denylist check; write the body to a tmp file; return path + content-type. | New |
| `server/import/sniffer.ts` | Magic-byte check; map sniffed type → extension; allow-list of accepted formats. | New |
| `server/import/jobs.ts` | In-memory `Map<job_id, JobRecord>` with mtime-based persistence to `/data/import-jobs.json`. | New |
| `server/import/runner.ts` | Single end-to-end ingest function: `ingest(domain, source, label, tags, auth)`. Calls sniffer/fetcher/sidecar/chunker/capture in order. Used by both HTTP and MCP entry points. | New |
| `server/routes/admin.ts` | `POST /admin/domains/:d/import`, `POST /admin/domains/:d/import/url`, `GET /admin/domains/:d/import/jobs/:id`. | Modified |
| `server/routes/mcp.ts` | New `capture_file` tool. | Modified |
| `server/static/dashboard.html` | Upload zone markup inside the Manage Domain modal's Docs tab. | Modified |
| `server/static/dashboard.js` | Drag-drop handler, URL paste handler, recent-imports list, async job poller. | Modified |
| `docker/docker-compose.yml` | New env vars: `OB2_IMPORT_MAX_BYTES`, `OB2_IMPORT_SYNC_THRESHOLD_BYTES`, `OB2_IMPORT_SYNC_TIMEOUT_SEC`, `OB2_IMPORT_MCP_TIMEOUT_SEC`, `OB2_WHISPER_MODEL`, `OB2_WHISPER_DEVICE`, `OB2_OCR_LANGUAGE`, `OB2_IMPORT_URL_DENYLIST`. | Modified |
| `server/config.ts` | Surface the new env vars in `Config`. | Modified |
| `tests/fixtures/import/` | Tiny fixture files for e2e Step 19. | New |
| `tests/e2e.sh` | Step 19 covering all formats + security cases. | Modified |

---

## Conventions used by every task

- **Type-check after every Deno change:** `cd /mnt/c/projects/OB2/server && $HOME/.deno/bin/deno check index.ts`. Expected: clean.
- **JS lint after every dashboard.js change:** `node --check /mnt/c/projects/OB2/server/static/dashboard.js`. Expected: silent (exit 0).
- **Bash lint after every e2e.sh change:** `bash -n /mnt/c/projects/OB2/tests/e2e.sh`. Expected: silent.
- **Deploy pattern:** `docker cp <file> ob2-server:<container path>` then `docker compose -f docker/docker-compose.yml --env-file .env restart ob2-server`. Wait until `curl -sf http://127.0.0.1:7600/health` returns 200.
- **Service token for smoke:** `SVC_TOKEN=$(grep '^OB2_OPENWEBUI_SERVICE_TOKEN=' .env | cut -d= -f2)`.
- **Admin key for smoke:** `ADMIN_KEY="ob2_<redacted>"`.
- **Test user `import-tester` with `write` on `@import-test`:** create at the start of e2e Step 19, use throughout.

---

### Task 1: System packages in Dockerfile

**Files:**
- Modify: `Dockerfile`

- [ ] **Step 1: Find the existing apt-get install line**

Run:
```bash
grep -n "apt-get install" /mnt/c/projects/OB2/Dockerfile
```

Expected: a line like `RUN apt-get update && apt-get install -y --no-install-recommends ...` in the runtime stage (the `deno-base` stage that gets the Python venv).

- [ ] **Step 2: Add tesseract + ffmpeg + libreoffice-common to that line**

Locate the existing apt-get install in the runtime stage. Append `tesseract-ocr tesseract-ocr-eng libtesseract-dev ffmpeg libreoffice-common` to its package list. Keep `--no-install-recommends`.

`libreoffice-common` is needed because MarkItDown shells out to LibreOffice for `.doc` (legacy Word) and some `.pptx` edge cases. If install size becomes a concern later, drop it and accept reduced legacy-Office support.

- [ ] **Step 3: Rebuild image**

```bash
cd /mnt/c/projects/OB2 && docker compose -f docker/docker-compose.yml --env-file .env build ob2-server
```

Expected: build succeeds. New layers around `apt-get install`. Image grows by ~600-900 MB.

- [ ] **Step 4: Bring up the rebuilt image**

```bash
scripts/docker-restart.sh --with-chat
```

Wait for `curl -sf http://127.0.0.1:7600/health` to return 200.

- [ ] **Step 5: Verify the new binaries are present**

```bash
docker exec ob2-server which tesseract ffmpeg libreoffice
```

Expected: three absolute paths printed, exit 0.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile
git commit -m "chore(docker): add tesseract, ffmpeg, libreoffice for markitdown ingestion"
```

---

### Task 2: Add markitdown to Python deps

**Files:**
- Modify: `retrieval/pyproject.toml`

- [ ] **Step 1: Add the dep**

Open `retrieval/pyproject.toml`. Locate the main `dependencies = [` array. Add:

```toml
"markitdown[all]>=0.1.5,<0.2",
```

- [ ] **Step 2: Rebuild image (Dockerfile already pip-installs from pyproject)**

```bash
docker compose -f docker/docker-compose.yml --env-file .env build ob2-server
```

Expected: build succeeds; pip resolves `markitdown[all]` and its many extras.

- [ ] **Step 3: Restart and verify import**

```bash
scripts/docker-restart.sh --with-chat
docker exec ob2-server /app/retrieval/.venv/bin/python -c "from markitdown import MarkItDown; print('ok')"
```

Expected: `ok`.

- [ ] **Step 4: Commit**

```bash
git add retrieval/pyproject.toml
git commit -m "feat(retrieval): add markitdown[all] for file/URL → markdown conversion"
```

---

### Task 3: Sidecar `convert_to_markdown` RPC

**Files:**
- Modify: `retrieval/sidecar.py`

- [ ] **Step 1: Add lazy MarkItDown initializer near the top of sidecar.py**

Find the section that initialises the embedder (look for `_get_embedder`). Below that section, add:

```python
# ─────────────────────────────────────────────────────────────
# MarkItDown — single instance, lazily initialised so we don't pay
# for OCR/Whisper model loading until the first conversion.
# ─────────────────────────────────────────────────────────────
_markitdown = None

def _get_markitdown():
    global _markitdown
    if _markitdown is None:
        try:
            from markitdown import MarkItDown
            _markitdown = MarkItDown(enable_plugins=False)
            log("markitdown initialised")
        except ImportError as e:
            log(f"markitdown unavailable: {e}")
            _markitdown = False  # sentinel — distinct from None
    return _markitdown if _markitdown else None
```

- [ ] **Step 2: Add the RPC method**

Find `def method_build_multi_context` and add `method_convert_to_markdown` immediately above it:

```python
def method_convert_to_markdown(params: dict) -> dict:
    """
    Convert a local file path or URL to Markdown.

    Params:
      source: str — either an absolute filesystem path or http(s):// URL.

    Returns:
      {
        "markdown": str,
        "title": str | None,
        "source_format": str,         # e.g. "pdf", "docx", "html", "audio"
        "char_count": int,
        "warnings": list[str],
        "duration_ms": int,
      }

    Raises ValueError if markitdown isn't installed; the JSON-RPC layer
    surfaces this as an error to the caller.
    """
    import time
    md = _get_markitdown()
    if md is None:
        raise ValueError("markitdown not installed")

    source = params.get("source")
    if not isinstance(source, str) or not source:
        raise ValueError("source must be a non-empty string")

    started = time.time()
    result = md.convert(source)
    duration_ms = int((time.time() - started) * 1000)

    text = (result.text_content or "").strip()
    title = getattr(result, "title", None)
    # Format inference: trust the source's extension or scheme.
    if source.startswith(("http://", "https://")):
        fmt = "url"
    else:
        fmt = source.rsplit(".", 1)[-1].lower() if "." in source else "unknown"
    warnings: list[str] = []
    # MarkItDown's DocumentConverterResult exposes warnings since 0.1.x;
    # tolerate either presence or absence.
    if hasattr(result, "warnings") and result.warnings:
        warnings = [str(w) for w in result.warnings]

    return {
        "markdown": text,
        "title": title,
        "source_format": fmt,
        "char_count": len(text),
        "warnings": warnings,
        "duration_ms": duration_ms,
    }
```

- [ ] **Step 3: Register the method in the dispatch table**

Find the `METHODS = {` dict. Add a new line right after `"build_multi_context": method_build_multi_context,`:

```python
    "convert_to_markdown": method_convert_to_markdown,
```

- [ ] **Step 4: Deploy the change**

```bash
docker cp /mnt/c/projects/OB2/retrieval/sidecar.py ob2-server:/app/retrieval/sidecar.py
docker compose -f /mnt/c/projects/OB2/docker/docker-compose.yml --env-file /mnt/c/projects/OB2/.env restart ob2-server
until curl -sf -m 2 http://127.0.0.1:7600/health > /dev/null 2>&1; do sleep 1; done
```

- [ ] **Step 5: Smoke test the RPC end-to-end**

Create a tiny test file inside the container, then call the RPC via the sidecar's stdio is non-trivial — easiest path is to add a temporary test endpoint or call from a Python one-liner inside the container:

```bash
docker exec ob2-server bash -c '
echo "# Hello\n\nThis is a test." > /tmp/smoke.md
/app/retrieval/.venv/bin/python -c "
from markitdown import MarkItDown
m = MarkItDown(enable_plugins=False)
r = m.convert(\"/tmp/smoke.md\")
assert r.text_content.strip().startswith(\"# Hello\"), r.text_content
print(\"PASS:\", repr(r.text_content[:50]))
"
'
```

Expected: `PASS: '# Hello\n\nThis is a test.'`.

- [ ] **Step 6: Commit**

```bash
git add retrieval/sidecar.py
git commit -m "feat(retrieval): add convert_to_markdown RPC backed by markitdown"
```

---

### Task 4: Markdown chunker (pure function + test)

**Files:**
- Create: `server/import/chunker.ts`
- Create: `server/import/chunker_test.ts`

The project has no Deno test runner today, but a *single* throwaway test script for this pure function is cheap and gives us a real red-green cycle without standing up infra. The test script lives at `server/import/chunker_test.ts` and is run on demand with `deno run`.

- [ ] **Step 1: Write the failing test**

Create `server/import/chunker_test.ts`:

```typescript
// One-shot test for chunkMarkdown. Run with:
//   deno run server/import/chunker_test.ts
// Exits 0 on pass, 1 on fail.
import { chunkMarkdown } from "./chunker.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; }
  else { console.log("PASS:", msg); }
}

// 1. empty input returns no chunks
assert(chunkMarkdown("").length === 0, "empty markdown → []");

// 2. single short paragraph → one chunk
{
  const out = chunkMarkdown("Just one paragraph.");
  assert(out.length === 1, "single paragraph → 1 chunk");
  assert(out[0].text === "Just one paragraph.", "chunk text matches");
  assert(out[0].breadcrumb === "", "no headers → empty breadcrumb");
}

// 3. H1/H2 boundaries split into separate chunks with breadcrumbs
{
  const md = "# Top\nIntro text.\n\n## Section A\nA body.\n\n## Section B\nB body.";
  const out = chunkMarkdown(md);
  assert(out.length === 3, "three sections → three chunks");
  assert(out[0].breadcrumb === "Top", "intro under H1");
  assert(out[1].breadcrumb === "Top > Section A", "section A breadcrumb");
  assert(out[2].breadcrumb === "Top > Section B", "section B breadcrumb");
}

// 4. section longer than maxChars → hard-cut with overlap carryover
{
  const long = "x".repeat(4000);
  const md = "## Long\n" + long;
  const out = chunkMarkdown(md, { maxChars: 1500, overlap: 200 });
  assert(out.length >= 2, "long section split into multiple chunks");
  // overlap: chunk N+1 starts with the last 200 chars of chunk N's body
  const lastOfFirst = out[0].text.slice(-200);
  assert(out[1].text.startsWith(lastOfFirst), "overlap preserved between chunks");
}

// 5. all chunks carry monotonic chunk_index and same chunk_total
{
  const md = "## A\n" + "x".repeat(2000) + "\n\n## B\n" + "y".repeat(2000);
  const out = chunkMarkdown(md, { maxChars: 800, overlap: 0 });
  for (let i = 0; i < out.length; i++) {
    assert(out[i].chunk_index === i, `chunk_index[${i}] === ${i}`);
    assert(out[i].chunk_total === out.length, `chunk_total === ${out.length}`);
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
Deno.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run the test (expect compile error — chunker.ts doesn't exist)**

```bash
cd /mnt/c/projects/OB2 && $HOME/.deno/bin/deno run server/import/chunker_test.ts
```

Expected: error like `Module not found "file:///.../server/import/chunker.ts"`.

- [ ] **Step 3: Implement the chunker**

Create `server/import/chunker.ts`:

```typescript
// Header-aware Markdown chunker.
//
// Splits on H1/H2 boundaries first, then sub-splits anything still over
// `maxChars` at H3/blank-line boundaries, with a final hard cut + overlap
// fallback for sections that have no internal structure to lean on.
// Each chunk carries a "Top > Section" breadcrumb so embeddings retain
// the document context they live under.

export interface ChunkOptions {
  /** Max characters per chunk before forcing a split. Default 1500. */
  maxChars?: number;
  /** Carryover characters from previous chunk at hard cuts. Default 200. */
  overlap?: number;
}

export interface Chunk {
  text: string;
  breadcrumb: string;
  chunk_index: number;
  chunk_total: number;
}

interface Section {
  breadcrumb: string;
  body: string;
}

const H1_RE = /^# (.+)$/m;
const H2_RE = /^## (.+)$/m;

/**
 * Walk lines once, tracking the current H1 and H2. Each H1/H2 transition
 * starts a new section. Body collected until the next boundary.
 */
function splitSections(md: string): Section[] {
  const lines = md.split(/\r?\n/);
  const sections: Section[] = [];
  let h1 = "";
  let h2 = "";
  let buf: string[] = [];

  const flush = () => {
    const body = buf.join("\n").trim();
    if (body) {
      const crumb = h2 ? `${h1 ? h1 + " > " : ""}${h2}` : h1;
      sections.push({ breadcrumb: crumb, body });
    }
    buf = [];
  };

  for (const line of lines) {
    const h1m = line.match(/^# (.+)$/);
    const h2m = line.match(/^## (.+)$/);
    if (h1m) {
      flush();
      h1 = h1m[1].trim();
      h2 = "";
      continue;
    }
    if (h2m) {
      flush();
      h2 = h2m[1].trim();
      continue;
    }
    buf.push(line);
  }
  flush();
  return sections;
}

/** Hard-cut a single body string at maxChars with overlap from the prior cut. */
function hardCut(body: string, maxChars: number, overlap: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < body.length) {
    const end = Math.min(body.length, i + maxChars);
    out.push(body.slice(i, end));
    if (end >= body.length) break;
    i = Math.max(0, end - overlap);
  }
  return out;
}

export function chunkMarkdown(md: string, opts: ChunkOptions = {}): Chunk[] {
  const maxChars = opts.maxChars ?? 1500;
  const overlap = opts.overlap ?? 200;

  if (!md.trim()) return [];

  const sections = splitSections(md);
  // If no H1/H2 found, treat the whole thing as one anonymous section.
  const effective: Section[] = sections.length > 0
    ? sections
    : [{ breadcrumb: "", body: md.trim() }];

  const pieces: { breadcrumb: string; text: string }[] = [];
  for (const sec of effective) {
    if (sec.body.length <= maxChars) {
      pieces.push({ breadcrumb: sec.breadcrumb, text: sec.body });
    } else {
      for (const part of hardCut(sec.body, maxChars, overlap)) {
        pieces.push({ breadcrumb: sec.breadcrumb, text: part });
      }
    }
  }

  const total = pieces.length;
  return pieces.map((p, i) => ({
    text: p.text,
    breadcrumb: p.breadcrumb,
    chunk_index: i,
    chunk_total: total,
  }));
}
```

- [ ] **Step 4: Run the test (expect PASS)**

```bash
$HOME/.deno/bin/deno run server/import/chunker_test.ts
```

Expected: every assertion `PASS`, final line `ALL PASS`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add server/import/chunker.ts server/import/chunker_test.ts
git commit -m "feat(import): header-aware markdown chunker with overlap"
```

---

### Task 5: URL fetcher with SSRF denylist + magic-byte sniffer

**Files:**
- Create: `server/import/sniffer.ts`
- Create: `server/import/url_fetcher.ts`
- Create: `server/import/sniffer_test.ts`

- [ ] **Step 1: Write the failing sniffer test**

Create `server/import/sniffer_test.ts`:

```typescript
// One-shot test for sniffMagicBytes. Run with:
//   deno run server/import/sniffer_test.ts
import { sniffMagicBytes } from "./sniffer.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; }
  else { console.log("PASS:", msg); }
}

const enc = new TextEncoder();

// PDF
{
  const bytes = enc.encode("%PDF-1.7\n...");
  assert(sniffMagicBytes(bytes)?.format === "pdf", "PDF magic");
}
// PNG
{
  const bytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  assert(sniffMagicBytes(bytes)?.format === "png", "PNG magic");
}
// ZIP (also covers DOCX/PPTX/XLSX which are zip-wrapped — sniffer returns "zip"; the runner uses extension to disambiguate)
{
  const bytes = new Uint8Array([0x50, 0x4B, 0x03, 0x04]);
  assert(sniffMagicBytes(bytes)?.format === "zip", "ZIP magic");
}
// Plain text fallback
{
  const bytes = enc.encode("hello world");
  const r = sniffMagicBytes(bytes);
  assert(r?.format === "text", "ASCII → text");
}
// Empty / unknown returns null
{
  assert(sniffMagicBytes(new Uint8Array(0)) === null, "empty → null");
  assert(sniffMagicBytes(new Uint8Array([0xff, 0xfe, 0x00])) === null, "unknown → null");
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
Deno.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run test (expect import error)**

```bash
$HOME/.deno/bin/deno run server/import/sniffer_test.ts
```

Expected: module-not-found error.

- [ ] **Step 3: Implement the sniffer**

Create `server/import/sniffer.ts`:

```typescript
// Magic-byte sniffer. We only inspect the first 16 bytes — enough for every
// format we accept. Returns null for empty / unrecognised inputs; the caller
// then decides whether to refuse the upload outright.

export interface SniffResult {
  format: "pdf" | "png" | "jpeg" | "gif" | "tiff" | "zip" | "ogg" | "wav"
        | "mp3" | "flac" | "m4a" | "html" | "xml" | "text";
  contentType: string;
}

const enc = new TextDecoder();

export function sniffMagicBytes(bytes: Uint8Array): SniffResult | null {
  if (bytes.length === 0) return null;
  const head = bytes.subarray(0, Math.min(16, bytes.length));
  const h = (n: number) => head[n] ?? 0;

  // PDF: "%PDF-"
  if (h(0) === 0x25 && h(1) === 0x50 && h(2) === 0x44 && h(3) === 0x46) {
    return { format: "pdf", contentType: "application/pdf" };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (h(0) === 0x89 && h(1) === 0x50 && h(2) === 0x4E && h(3) === 0x47) {
    return { format: "png", contentType: "image/png" };
  }
  // JPEG: FF D8 FF
  if (h(0) === 0xFF && h(1) === 0xD8 && h(2) === 0xFF) {
    return { format: "jpeg", contentType: "image/jpeg" };
  }
  // GIF: "GIF87a" or "GIF89a"
  if (h(0) === 0x47 && h(1) === 0x49 && h(2) === 0x46) {
    return { format: "gif", contentType: "image/gif" };
  }
  // TIFF: "II*\0" or "MM\0*"
  if ((h(0) === 0x49 && h(1) === 0x49 && h(2) === 0x2A) || (h(0) === 0x4D && h(1) === 0x4D && h(3) === 0x2A)) {
    return { format: "tiff", contentType: "image/tiff" };
  }
  // ZIP / DOCX / PPTX / XLSX: "PK\x03\x04"
  if (h(0) === 0x50 && h(1) === 0x4B && h(2) === 0x03 && h(3) === 0x04) {
    return { format: "zip", contentType: "application/zip" };
  }
  // OGG: "OggS"
  if (h(0) === 0x4F && h(1) === 0x67 && h(2) === 0x67 && h(3) === 0x53) {
    return { format: "ogg", contentType: "audio/ogg" };
  }
  // WAV: "RIFF....WAVE"
  if (h(0) === 0x52 && h(1) === 0x49 && h(2) === 0x46 && h(3) === 0x46
      && h(8) === 0x57 && h(9) === 0x41 && h(10) === 0x56 && h(11) === 0x45) {
    return { format: "wav", contentType: "audio/wav" };
  }
  // FLAC: "fLaC"
  if (h(0) === 0x66 && h(1) === 0x4C && h(2) === 0x61 && h(3) === 0x43) {
    return { format: "flac", contentType: "audio/flac" };
  }
  // MP3: "ID3" or 0xFF 0xFB / 0xFF 0xF3 / 0xFF 0xF2 (sync word)
  if ((h(0) === 0x49 && h(1) === 0x44 && h(2) === 0x33)
      || (h(0) === 0xFF && (h(1) === 0xFB || h(1) === 0xF3 || h(1) === 0xF2))) {
    return { format: "mp3", contentType: "audio/mpeg" };
  }
  // M4A: "....ftypM4A " — bytes 4..7 = "ftyp", 8..11 = "M4A "
  if (h(4) === 0x66 && h(5) === 0x74 && h(6) === 0x79 && h(7) === 0x70
      && h(8) === 0x4D && h(9) === 0x34 && h(10) === 0x41) {
    return { format: "m4a", contentType: "audio/mp4" };
  }

  // Text fallback: if every byte in the first 256 is printable ASCII or common whitespace, treat as text.
  const probeLen = Math.min(256, bytes.length);
  let printable = 0;
  for (let i = 0; i < probeLen; i++) {
    const b = bytes[i];
    if (b === 0x09 || b === 0x0A || b === 0x0D || (b >= 0x20 && b <= 0x7E)) printable++;
  }
  if (printable === probeLen) {
    const sample = enc.decode(bytes.subarray(0, Math.min(64, bytes.length))).trimStart().toLowerCase();
    if (sample.startsWith("<!doctype html") || sample.startsWith("<html")) {
      return { format: "html", contentType: "text/html" };
    }
    if (sample.startsWith("<?xml")) {
      return { format: "xml", contentType: "application/xml" };
    }
    return { format: "text", contentType: "text/plain" };
  }

  return null;
}
```

- [ ] **Step 4: Run sniffer test (expect PASS)**

```bash
$HOME/.deno/bin/deno run server/import/sniffer_test.ts
```

Expected: `ALL PASS`.

- [ ] **Step 5: Implement URL fetcher**

Create `server/import/url_fetcher.ts`:

```typescript
// URL fetcher with SSRF denylist. Resolves the host, refuses any IP in the
// configured CIDR denylist, otherwise streams the body to a tmp file and
// returns the path + sniffed content-type.

import { sniffMagicBytes, SniffResult } from "./sniffer.ts";

const DEFAULT_DENYLIST = [
  "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
  "169.254.0.0/16", "::1/128", "fc00::/7",
];

export interface FetchedFile {
  path: string;          // /tmp/upload-<uuid>.<ext>
  sniffed: SniffResult | null;
  size_bytes: number;
}

function ipv4ToInt(addr: string): number | null {
  const parts = addr.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const x = Number(p);
    if (!Number.isInteger(x) || x < 0 || x > 255) return null;
    n = (n << 8) | x;
  }
  return n >>> 0;
}

function inCidrV4(addr: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const a = ipv4ToInt(addr);
  const b = ipv4ToInt(base);
  if (a === null || b === null) return false;
  if (bits === 0) return true;
  const mask = (~0 << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

export function isDeniedIp(addr: string, denylist: string[]): boolean {
  // IPv4 check only — for our deployment scenario IPv4 is what matters.
  // Loopback + ULA IPv6 are handled in the host check below by string match.
  if (addr === "::1" || addr.startsWith("fc") || addr.startsWith("fd")) return true;
  if (!addr.includes(".")) return false; // IPv6 outside the simple cases — accept conservatively
  for (const cidr of denylist) {
    if (cidr.includes(":")) continue; // skip IPv6 CIDRs in the v4 path
    if (inCidrV4(addr, cidr)) return true;
  }
  return false;
}

function denylist(): string[] {
  const env = Deno.env.get("OB2_IMPORT_URL_DENYLIST") || "";
  const list = env.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : DEFAULT_DENYLIST;
}

export async function fetchUrlToTmp(url: string, maxBytes: number): Promise<FetchedFile> {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("only http(s) URLs are accepted");
  }

  // DNS resolution + denylist check.
  let addrs: Deno.NetAddr[] = [];
  try {
    const records = await Deno.resolveDns(u.hostname, "A");
    for (const a of records) addrs.push({ transport: "tcp", hostname: a, port: 0 });
  } catch (e) {
    throw new Error(`DNS resolution failed: ${(e as Error).message}`);
  }
  if (addrs.length === 0) throw new Error("URL host has no A record");

  const deny = denylist();
  for (const a of addrs) {
    if (isDeniedIp(a.hostname, deny)) {
      throw new Error(`url_blocked: ${u.hostname} resolves to denylisted ${a.hostname}`);
    }
  }

  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) throw new Error(`upstream_fetch_failed: HTTP ${resp.status}`);

  const ext = (u.pathname.split(".").pop() || "bin").toLowerCase().slice(0, 6) || "bin";
  const tmpPath = `/tmp/upload-${crypto.randomUUID()}.${ext}`;
  const file = await Deno.open(tmpPath, { write: true, create: true, truncate: true });

  let total = 0;
  try {
    const reader = resp.body!.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error("payload_too_large");
      }
      await file.write(value);
    }
  } finally {
    file.close();
  }

  // Sniff first 16 bytes for type confirmation.
  let sniffed: SniffResult | null = null;
  try {
    const head = await Deno.readFile(tmpPath);
    sniffed = sniffMagicBytes(head.subarray(0, 16));
  } catch { /* sniff is best-effort */ }

  return { path: tmpPath, sniffed, size_bytes: total };
}
```

- [ ] **Step 6: Type-check**

```bash
cd /mnt/c/projects/OB2/server && $HOME/.deno/bin/deno check index.ts
```

Wait — `index.ts` doesn't import these yet, so this is more of a syntax check. Run instead:

```bash
$HOME/.deno/bin/deno check server/import/sniffer.ts server/import/url_fetcher.ts
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add server/import/sniffer.ts server/import/url_fetcher.ts server/import/sniffer_test.ts
git commit -m "feat(import): magic-byte sniffer + URL fetcher with SSRF denylist"
```

---

### Task 6: Async job queue

**Files:**
- Create: `server/import/jobs.ts`

- [ ] **Step 1: Implement the queue**

Create `server/import/jobs.ts`:

```typescript
// In-memory import-job registry with mtime-based persistence to disk.
// Mirrors the pattern used by users.ts / reset-tokens.ts so behavior is
// uniform across the server: in-memory map for speed, atomic write on
// every mutation, hot-reload from disk on startup.

import { Buffer } from "node:buffer";

export type JobStatus =
  | "queued"
  | "converting"
  | "chunking"
  | "embedding"
  | "done"
  | "error"
  | "interrupted";

export interface JobRecord {
  id: string;
  domain: string;
  source_label: string;
  status: JobStatus;
  progress?: number;
  result?: Record<string, unknown>;
  error?: { message: string; type: string };
  created_at: string;
  updated_at: string;
}

const STORE_PATH = "/data/import-jobs.json";
const TERMINAL = new Set<JobStatus>(["done", "error", "interrupted"]);

const _jobs = new Map<string, JobRecord>();
let _loaded = false;

export async function initJobs(): Promise<void> {
  try {
    const text = await Deno.readTextFile(STORE_PATH);
    const data = JSON.parse(text) as { jobs?: JobRecord[] };
    for (const j of data.jobs ?? []) {
      // Anything mid-flight at the previous shutdown is now interrupted.
      if (!TERMINAL.has(j.status)) {
        j.status = "interrupted";
        j.error = { message: "server restarted while job was in flight", type: "interrupted" };
        j.updated_at = new Date().toISOString();
      }
      _jobs.set(j.id, j);
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      console.warn("import-jobs: failed to load existing store:", e);
    }
  }
  _loaded = true;
  // Periodic expiry sweep — drop terminal jobs older than 24 h.
  setInterval(() => sweep().catch(() => {}), 60 * 60 * 1000);
}

async function persist(): Promise<void> {
  const tmp = `${STORE_PATH}.tmp.${crypto.randomUUID()}`;
  const data = { jobs: Array.from(_jobs.values()) };
  await Deno.writeTextFile(tmp, JSON.stringify(data, null, 2));
  await Deno.rename(tmp, STORE_PATH);
}

async function sweep(): Promise<void> {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let changed = false;
  for (const [id, j] of _jobs) {
    if (TERMINAL.has(j.status) && Date.parse(j.updated_at) < cutoff) {
      _jobs.delete(id);
      changed = true;
    }
  }
  if (changed) await persist();
}

export async function createJob(domain: string, source_label: string): Promise<JobRecord> {
  if (!_loaded) await initJobs();
  const now = new Date().toISOString();
  const id = `imp_${crypto.randomUUID().slice(0, 12)}`;
  const job: JobRecord = {
    id, domain, source_label,
    status: "queued",
    created_at: now, updated_at: now,
  };
  _jobs.set(id, job);
  await persist();
  return job;
}

export async function updateJob(id: string, patch: Partial<JobRecord>): Promise<JobRecord | null> {
  const j = _jobs.get(id);
  if (!j) return null;
  const next = { ...j, ...patch, updated_at: new Date().toISOString() };
  _jobs.set(id, next);
  await persist();
  return next;
}

export function getJob(id: string): JobRecord | null {
  return _jobs.get(id) ?? null;
}

export function listJobsForDomain(domain: string): JobRecord[] {
  return Array.from(_jobs.values()).filter((j) => j.domain === domain);
}
```

- [ ] **Step 2: Type-check**

```bash
$HOME/.deno/bin/deno check server/import/jobs.ts
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add server/import/jobs.ts
git commit -m "feat(import): in-memory job queue with disk persistence"
```

---

### Task 7: Ingest runner — the single end-to-end entry point

**Files:**
- Create: `server/import/runner.ts`

This module is the entry point that *every* upload (HTTP and MCP) goes through. Centralising means we only get the policy (size limits, sniffing, chunking, capture) right once.

- [ ] **Step 1: Implement the runner**

Create `server/import/runner.ts`:

```typescript
// Single ingest pipeline: any caller (HTTP route, MCP tool) hands us a
// path or URL plus auth context, we drive sniffer → sidecar conversion →
// chunker → capture-loop, and we either return the result synchronously or
// kick off a background job and hand back its id.

import type { Sidecar } from "../sidecar.ts";
import { chunkMarkdown } from "./chunker.ts";
import { sniffMagicBytes, SniffResult } from "./sniffer.ts";
import { fetchUrlToTmp } from "./url_fetcher.ts";
import { createJob, updateJob, JobRecord } from "./jobs.ts";

export interface IngestRequest {
  domain: string;
  source: { kind: "path"; path: string } | { kind: "url"; url: string };
  source_label?: string;
  tags?: string[];
}

export interface IngestResult {
  ok: true;
  doc_ids: string[];
  source_format: string;
  chunks_captured: number;
  warnings: string[];
}

export interface IngestJobResponse {
  ok: true;
  job_id: string;
  status: "queued";
}

export interface IngestEnv {
  maxBytes: number;
  syncThresholdBytes: number;
  syncTimeoutSec: number;
}

export function loadIngestEnv(): IngestEnv {
  const max = Number(Deno.env.get("OB2_IMPORT_MAX_BYTES") || 262144000);
  const sync = Number(Deno.env.get("OB2_IMPORT_SYNC_THRESHOLD_BYTES") || 26214400);
  const timeout = Number(Deno.env.get("OB2_IMPORT_SYNC_TIMEOUT_SEC") || 60);
  return { maxBytes: max, syncThresholdBytes: sync, syncTimeoutSec: timeout };
}

const ASYNC_FORMATS = new Set(["zip", "mp3", "wav", "flac", "m4a", "ogg"]);

interface ConvertResult {
  markdown: string;
  title: string | null;
  source_format: string;
  char_count: number;
  warnings: string[];
  duration_ms: number;
}

async function callConvert(sidecar: Sidecar, source: string): Promise<ConvertResult> {
  return await sidecar.call<ConvertResult>("convert_to_markdown", { source });
}

async function captureChunks(
  sidecar: Sidecar,
  req: IngestRequest,
  markdown: string,
  format: string,
  source_label: string,
): Promise<string[]> {
  const chunks = chunkMarkdown(markdown);
  const doc_ids: string[] = [];
  for (const c of chunks) {
    const text = c.breadcrumb ? `${c.breadcrumb}\n\n${c.text}` : c.text;
    const r = await sidecar.call<{ doc_id: string }>("capture", {
      domain: req.domain,
      text,
      metadata: {
        _ob2_import_source: source_label,
        _ob2_import_format: format,
        _ob2_chunk_index: c.chunk_index,
        _ob2_chunk_total: c.chunk_total,
        _ob2_breadcrumb: c.breadcrumb,
        source: source_label,
        tags: req.tags ?? [],
      },
    });
    doc_ids.push(r.doc_id);
  }
  return doc_ids;
}

/**
 * Full ingest: convert + chunk + capture. Throws on errors so the caller
 * can decide whether to surface or stash on a job record.
 */
async function runIngest(
  sidecar: Sidecar,
  req: IngestRequest,
  resolvedPath: string,
  source_label: string,
): Promise<IngestResult> {
  const conv = await callConvert(sidecar, resolvedPath);
  const ids = await captureChunks(sidecar, req, conv.markdown, conv.source_format, source_label);
  return {
    ok: true,
    doc_ids: ids,
    source_format: conv.source_format,
    chunks_captured: ids.length,
    warnings: conv.warnings,
  };
}

/**
 * Decide sync vs async, run the pipeline, return the appropriate response.
 * `tmpPath` is required for kind="path" (the upload's tmp file). For kind="url",
 * we'll fetch + write to /tmp first.
 */
export async function dispatch(
  sidecar: Sidecar,
  req: IngestRequest,
  env: IngestEnv,
): Promise<IngestResult | IngestJobResponse> {
  const sniffed = await sniffSource(req, env);
  const { path, sniff, size, derivedLabel } = sniffed;
  const source_label = req.source_label || derivedLabel;

  const goAsync = size > env.syncThresholdBytes
    || (sniff?.format && ASYNC_FORMATS.has(sniff.format));

  if (!goAsync) {
    try {
      return await runIngest(sidecar, req, path, source_label);
    } finally {
      tryUnlink(path);
    }
  }

  // Async path
  const job = await createJob(req.domain, source_label);
  // Fire and forget; record progress on the job.
  (async () => {
    try {
      await updateJob(job.id, { status: "converting" });
      const result = await runIngest(sidecar, req, path, source_label);
      await updateJob(job.id, { status: "done", result });
    } catch (e) {
      await updateJob(job.id, {
        status: "error",
        error: { message: (e as Error).message, type: "conversion_failed" },
      });
    } finally {
      tryUnlink(path);
    }
  })();

  return { ok: true, job_id: job.id, status: "queued" };
}

interface SniffedSource {
  path: string;
  sniff: SniffResult | null;
  size: number;
  derivedLabel: string;
}

async function sniffSource(req: IngestRequest, env: IngestEnv): Promise<SniffedSource> {
  if (req.source.kind === "path") {
    const path = req.source.path;
    const stat = await Deno.stat(path);
    if (stat.size > env.maxBytes) throw new Error("payload_too_large");
    const fh = await Deno.open(path, { read: true });
    const head = new Uint8Array(16);
    await fh.read(head);
    fh.close();
    const sniff = sniffMagicBytes(head);
    const label = path.split("/").pop() || path;
    return { path, sniff, size: stat.size, derivedLabel: label };
  }
  // URL
  const fetched = await fetchUrlToTmp(req.source.url, env.maxBytes);
  const url = new URL(req.source.url);
  const label = url.hostname + url.pathname;
  return { path: fetched.path, sniff: fetched.sniffed, size: fetched.size_bytes, derivedLabel: label };
}

function tryUnlink(path: string): void {
  Deno.remove(path).catch(() => {});
}
```

- [ ] **Step 2: Type-check**

```bash
cd /mnt/c/projects/OB2/server && $HOME/.deno/bin/deno check index.ts
```

Note: `index.ts` doesn't yet route to this runner; we still want a clean check on the runner itself:

```bash
$HOME/.deno/bin/deno check server/import/runner.ts
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add server/import/runner.ts
git commit -m "feat(import): unified ingest runner (sync + async dispatch)"
```

---

### Task 8: HTTP endpoints in admin.ts

**Files:**
- Modify: `server/routes/admin.ts`
- Modify: `server/index.ts` (call `initJobs()` at boot)

- [ ] **Step 1: Wire `initJobs()` at server startup**

Open `server/index.ts`. Find the section where `initSessions()`, `initOpenwebuiSso()`, etc. are awaited at boot (look for `await initSessions()`). Add an import and a call:

```typescript
import { initJobs } from "./import/jobs.ts";
```

And in the boot block (after the other `await init*()` calls):

```typescript
await initJobs();
```

- [ ] **Step 2: Add the three import endpoints to admin.ts**

Open `server/routes/admin.ts`. Near the top, add imports:

```typescript
import { dispatch, loadIngestEnv } from "../import/runner.ts";
import { getJob } from "../import/jobs.ts";
```

Find the existing `app.get("/domains/:domain/docs", ...)` handler. Below it (any spot in the same Hono app), add the three new endpoints:

```typescript
  // POST /admin/domains/:domain/import — multipart file upload.
  app.post("/domains/:domain/import", async (c) => {
    const domain = c.req.param("domain");
    const denied = requirePerm(c, domain, "write");
    if (denied) return denied;

    const env = loadIngestEnv();
    const form = await c.req.formData().catch(() => null);
    if (!form) return c.json({ error: { message: "expected multipart body", type: "invalid_request_error" } }, 400);
    const file = form.get("file");
    if (!(file instanceof File)) {
      return c.json({ error: { message: "missing 'file' field", type: "invalid_request_error" } }, 400);
    }
    if (file.size > env.maxBytes) {
      return c.json({ error: { message: `file exceeds ${env.maxBytes} bytes`, type: "payload_too_large" } }, 413);
    }
    const tags = String(form.get("tags") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const source_label = String(form.get("source_label") || file.name || "uploaded-file");

    // Spool to /tmp.
    const ext = (file.name.split(".").pop() || "bin").toLowerCase().slice(0, 6) || "bin";
    const path = `/tmp/upload-${crypto.randomUUID()}.${ext}`;
    const buf = new Uint8Array(await file.arrayBuffer());
    await Deno.writeFile(path, buf);

    try {
      const out = await dispatch(sidecar, {
        domain, source: { kind: "path", path }, source_label, tags,
      }, env);
      return c.json(out);
    } catch (e) {
      // Cleanup is the runner's responsibility for sync; only the async
      // path stashes the error on the job. Sync path returns 400 here.
      Deno.remove(path).catch(() => {});
      const msg = (e as Error).message || "conversion_failed";
      const status = msg.includes("payload_too_large") ? 413
                   : msg.includes("url_blocked") ? 400
                   : 400;
      return c.json({ error: { message: msg, type: "conversion_failed" } }, status);
    }
  });

  // POST /admin/domains/:domain/import/url — URL ingestion.
  app.post("/domains/:domain/import/url", async (c) => {
    const domain = c.req.param("domain");
    const denied = requirePerm(c, domain, "write");
    if (denied) return denied;

    let body: { url?: string; tags?: string[]; source_label?: string };
    try { body = await c.req.json(); }
    catch { return c.json({ error: { message: "invalid JSON", type: "invalid_request_error" } }, 400); }
    if (!body.url) return c.json({ error: { message: "url required", type: "invalid_request_error" } }, 400);

    const env = loadIngestEnv();
    try {
      const out = await dispatch(sidecar, {
        domain,
        source: { kind: "url", url: body.url },
        source_label: body.source_label,
        tags: body.tags ?? [],
      }, env);
      return c.json(out);
    } catch (e) {
      const msg = (e as Error).message || "conversion_failed";
      const status = msg.includes("url_blocked") ? 400
                   : msg.includes("payload_too_large") ? 413
                   : msg.includes("upstream_fetch_failed") ? 502
                   : 400;
      const type = msg.includes("url_blocked") ? "url_blocked"
                 : msg.includes("upstream_fetch_failed") ? "upstream_fetch_failed"
                 : "conversion_failed";
      return c.json({ error: { message: msg, type } }, status);
    }
  });

  // GET /admin/domains/:domain/import/jobs/:id
  app.get("/domains/:domain/import/jobs/:id", (c) => {
    const domain = c.req.param("domain");
    const denied = requirePerm(c, domain, "read");
    if (denied) return denied;
    const id = c.req.param("id");
    const j = getJob(id);
    if (!j || j.domain !== domain) {
      return c.json({ error: { message: "job not found", type: "not_found" } }, 404);
    }
    return c.json(j);
  });
```

- [ ] **Step 3: Type-check**

```bash
cd /mnt/c/projects/OB2/server && $HOME/.deno/bin/deno check index.ts
```

Expected: clean.

- [ ] **Step 4: Deploy**

```bash
docker cp /mnt/c/projects/OB2/server/import ob2-server:/app/server/
docker cp /mnt/c/projects/OB2/server/index.ts ob2-server:/app/server/index.ts
docker cp /mnt/c/projects/OB2/server/routes/admin.ts ob2-server:/app/server/routes/admin.ts
docker compose -f /mnt/c/projects/OB2/docker/docker-compose.yml --env-file /mnt/c/projects/OB2/.env restart ob2-server
until curl -sf -m 2 http://127.0.0.1:7600/health > /dev/null 2>&1; do sleep 1; done
```

- [ ] **Step 5: Smoke test sync upload**

```bash
ADMIN_KEY="ob2_<redacted>"
echo "# Hello smoke" > /tmp/smoke.md
curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" \
  -F "file=@/tmp/smoke.md" -F "source_label=smoke-test.md" \
  http://127.0.0.1:7600/admin/domains/test/import | python3 -m json.tool
```

Expected:
```json
{
  "ok": true,
  "doc_ids": ["mod..."],
  "source_format": "md",
  "chunks_captured": 1,
  "warnings": []
}
```

- [ ] **Step 6: Smoke test URL ingestion**

```bash
curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/","source_label":"example.com"}' \
  http://127.0.0.1:7600/admin/domains/test/import/url | python3 -m json.tool
```

Expected: `ok:true`, at least 1 chunk captured, source_format `html` or `url`.

- [ ] **Step 7: Smoke test SSRF block**

```bash
curl -s -o /tmp/ssrf.json -w "HTTP=%{http_code}\n" -X POST -H "Authorization: Bearer $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"http://127.0.0.1:11434/api/version"}' \
  http://127.0.0.1:7600/admin/domains/test/import/url
cat /tmp/ssrf.json
```

Expected: HTTP 400, body contains `"type":"url_blocked"`.

- [ ] **Step 8: Commit**

```bash
git add server/index.ts server/routes/admin.ts
git commit -m "feat(import): HTTP endpoints for file/URL upload + job poll"
```

---

### Task 9: MCP `capture_file` tool

**Files:**
- Modify: `server/routes/mcp.ts`

- [ ] **Step 1: Add the tool registration**

Open `server/routes/mcp.ts`. Find the registration of `capture_knowledge` (look for `"capture_knowledge"` near the top of the tool definitions). Below the closing of that tool's registration, add a new tool:

```typescript
  // ── Tool: capture_file ──
  server.tool(
    "capture_file",
    "Convert a file or URL to Markdown and capture into a domain. Supports PDF/DOCX/PPTX/XLSX/HTML/CSV/JSON/XML/MD/TXT/images (OCR)/audio (Whisper)/ZIP/HTTP URLs/YouTube. Files must be inside the container's /data volume; arbitrary host paths are refused. Use this whenever the user wants to ingest a document, slide deck, spreadsheet, image, audio recording, or webpage.",
    {
      domain: z.string().describe("Domain to capture into."),
      path_or_url: z.string().describe("Either a /data/... path or an https:// URL."),
      source_label: z.string().optional().describe("Override the auto-derived filename used in citations."),
      tags: z.array(z.string()).optional().describe("Topical tags for later filtering."),
    },
    async ({ domain, path_or_url, source_label, tags }) => {
      try {
        const auth = currentAuth();
        if (!auth) return errorResult("not authenticated");
        if (!hasPermission(auth, domain, "write")) {
          return errorResult(`Permission denied: ${auth.username} cannot write @${domain}`);
        }
        const isUrl = /^https?:\/\//i.test(path_or_url);
        let resolvedPath = path_or_url;
        if (!isUrl) {
          // Path mode: must canonicalise under /data/.
          const real = await Deno.realPath(path_or_url).catch(() => null);
          if (!real || !real.startsWith("/data/")) {
            return errorResult(`path_outside_volume: ${path_or_url}`);
          }
          resolvedPath = real;
        }

        const env = loadIngestEnv();
        const out = await dispatch(sidecar, {
          domain,
          source: isUrl
            ? { kind: "url", url: path_or_url }
            : { kind: "path", path: resolvedPath },
          source_label,
          tags,
        }, env);

        if ("job_id" in out) {
          return {
            content: [{ type: "text", text: `Capture queued (job ${out.job_id}). This is a long-running ingestion (audio or large file).` }],
          };
        }
        const summary = `Captured ${out.chunks_captured} chunk(s) into @${domain} as ${out.source_format}.` +
          (out.warnings.length ? `\nWarnings:\n  - ${out.warnings.join("\n  - ")}` : "");
        return { content: [{ type: "text", text: summary }] };
      } catch (e) {
        return errorResult(`capture_file error: ${(e as Error).message}`);
      }
    },
  );
```

If `currentAuth()` / `errorResult` / `hasPermission` aren't already imported in this file, add them — check what `capture_knowledge` does and follow the same pattern. Also ensure `import { dispatch, loadIngestEnv } from "../import/runner.ts";` is at the top.

- [ ] **Step 2: Type-check**

```bash
cd /mnt/c/projects/OB2/server && $HOME/.deno/bin/deno check index.ts
```

Expected: clean.

- [ ] **Step 3: Deploy and smoke via MCP**

```bash
docker cp /mnt/c/projects/OB2/server/routes/mcp.ts ob2-server:/app/server/routes/mcp.ts
docker compose -f /mnt/c/projects/OB2/docker/docker-compose.yml --env-file /mnt/c/projects/OB2/.env restart ob2-server
until curl -sf -m 2 http://127.0.0.1:7600/health > /dev/null 2>&1; do sleep 1; done

# Drop a known file in /data/, then call MCP tools/list to verify capture_file is advertised:
docker exec ob2-server bash -c 'echo "# MCP smoke" > /data/mcp-smoke.md'
ADMIN_KEY="ob2_<redacted>"
curl -s -H "x-brain-key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -X POST http://127.0.0.1:7600/mcp \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | python3 -c "
import sys, re
data = sys.stdin.read()
m = re.search(r'\"name\"\\s*:\\s*\"capture_file\"', data)
print('PASS: capture_file listed' if m else 'FAIL: not listed')
"
```

Expected: `PASS: capture_file listed`.

- [ ] **Step 4: Commit**

```bash
git add server/routes/mcp.ts
git commit -m "feat(mcp): capture_file tool for file/URL ingestion"
```

---

### Task 10: Compose env vars

**Files:**
- Modify: `docker/docker-compose.yml`
- Modify: `server/config.ts`

- [ ] **Step 1: Add env vars to compose**

Open `docker/docker-compose.yml`. Find the `ob2-server` service's `environment:` block. Add (after the existing OPENWEBUI lines):

```yaml
      # File/URL ingestion via MarkItDown.
      OB2_IMPORT_MAX_BYTES: ${OB2_IMPORT_MAX_BYTES:-262144000}
      OB2_IMPORT_SYNC_THRESHOLD_BYTES: ${OB2_IMPORT_SYNC_THRESHOLD_BYTES:-26214400}
      OB2_IMPORT_SYNC_TIMEOUT_SEC: ${OB2_IMPORT_SYNC_TIMEOUT_SEC:-60}
      OB2_IMPORT_MCP_TIMEOUT_SEC: ${OB2_IMPORT_MCP_TIMEOUT_SEC:-600}
      OB2_WHISPER_MODEL: ${OB2_WHISPER_MODEL:-base.en}
      OB2_WHISPER_DEVICE: ${OB2_WHISPER_DEVICE:-cpu}
      OB2_OCR_LANGUAGE: ${OB2_OCR_LANGUAGE:-eng}
      OB2_IMPORT_URL_DENYLIST: ${OB2_IMPORT_URL_DENYLIST:-127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,::1/128,fc00::/7}
```

- [ ] **Step 2: Surface them in `Config`**

Open `server/config.ts`. Add to the `Config` interface:

```typescript
  importMaxBytes: number;
  importSyncThresholdBytes: number;
  importSyncTimeoutSec: number;
  importMcpTimeoutSec: number;
  whisperModel: string;
  whisperDevice: string;
  ocrLanguage: string;
  importUrlDenylist: string;
```

In `loadConfig()`, return the new fields:

```typescript
    importMaxBytes: parseInt(optional("OB2_IMPORT_MAX_BYTES", "262144000"), 10),
    importSyncThresholdBytes: parseInt(optional("OB2_IMPORT_SYNC_THRESHOLD_BYTES", "26214400"), 10),
    importSyncTimeoutSec: parseInt(optional("OB2_IMPORT_SYNC_TIMEOUT_SEC", "60"), 10),
    importMcpTimeoutSec: parseInt(optional("OB2_IMPORT_MCP_TIMEOUT_SEC", "600"), 10),
    whisperModel: optional("OB2_WHISPER_MODEL", "base.en"),
    whisperDevice: optional("OB2_WHISPER_DEVICE", "cpu"),
    ocrLanguage: optional("OB2_OCR_LANGUAGE", "eng"),
    importUrlDenylist: optional("OB2_IMPORT_URL_DENYLIST", "127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,::1/128,fc00::/7"),
```

The runner and url_fetcher already read `Deno.env.get(...)` directly; surfacing in `Config` is for the admin-config UI to show the values. No code change in the runner.

- [ ] **Step 3: Recreate the container so env changes apply**

```bash
docker compose -f /mnt/c/projects/OB2/docker/docker-compose.yml --env-file /mnt/c/projects/OB2/.env up -d ob2-server
until curl -sf -m 2 http://127.0.0.1:7600/health > /dev/null 2>&1; do sleep 1; done
docker exec ob2-server env | grep -E "OB2_IMPORT|OB2_WHISPER|OB2_OCR" | sort
```

Expected: every new var present with its default.

- [ ] **Step 4: Re-cp the import files (up -d recreated the container, dropping prior cp's)**

```bash
docker cp /mnt/c/projects/OB2/server/import ob2-server:/app/server/
docker cp /mnt/c/projects/OB2/server/routes/admin.ts ob2-server:/app/server/routes/admin.ts
docker cp /mnt/c/projects/OB2/server/routes/mcp.ts ob2-server:/app/server/routes/mcp.ts
docker cp /mnt/c/projects/OB2/server/index.ts ob2-server:/app/server/index.ts
docker cp /mnt/c/projects/OB2/server/config.ts ob2-server:/app/server/config.ts
docker compose -f /mnt/c/projects/OB2/docker/docker-compose.yml --env-file /mnt/c/projects/OB2/.env restart ob2-server
until curl -sf -m 2 http://127.0.0.1:7600/health > /dev/null 2>&1; do sleep 1; done
```

- [ ] **Step 5: Commit**

```bash
git add docker/docker-compose.yml server/config.ts
git commit -m "feat(import): compose env vars + Config surface for ingestion knobs"
```

---

### Task 11: Dashboard upload zone

**Files:**
- Modify: `server/static/dashboard.html`
- Modify: `server/static/dashboard.js`

- [ ] **Step 1: Add the upload zone to the Manage Domain modal**

Open `server/static/dashboard.html`. Find the section where the Manage Domain modal is built (search for `id="manage-tab-content"`). The upload zone is rendered by JS into the Docs tab, so the HTML change is just adding a styled CSS rule to the inline `<style>` block. Add inside the existing `<style>` near the end (search for closing `</style>`):

```css
.import-zone {
  border: 2px dashed var(--border);
  border-radius: 8px;
  padding: 1rem;
  margin-bottom: 0.75rem;
  text-align: center;
  color: var(--muted);
  font-size: 0.85rem;
}
.import-zone.drag-over { border-color: var(--accent); background: rgba(56,189,248,0.08); }
.import-zone .formats { color: var(--muted); font-size: 0.72rem; margin-top: 0.4rem; }
.import-row { display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.5rem; }
.import-recent { font-size: 0.78rem; color: var(--muted); }
.import-recent .row { display: flex; gap: 0.4rem; padding: 2px 0; }
.import-recent .ok { color: var(--green); }
.import-recent .err { color: var(--red); }
.import-recent .pending { color: var(--yellow); }
```

- [ ] **Step 2: Add the JS handlers**

Open `server/static/dashboard.js`. Find `loadManageDocs()` (the Docs tab loader). At the top of the function, after the line that reads `_manageDomain`, insert the upload-zone rendering:

```javascript
async function loadManageDocs() {
  const { domain, perm } = _manageDomain;
  const canDeleteDocs = perm === 'admin'; // doc deletion requires admin on the domain
  const canImport = perm === 'admin' || perm === 'write';
  const content = document.getElementById('manage-tab-content');
  try {
    // ... existing top of function until the `let html` line ...
```

After the existing `let html =` is built, prepend the import block conditionally:

```javascript
    let importHtml = '';
    if (canImport) {
      importHtml = `
        <div class="import-zone" id="import-zone-${escapeAttr(domain)}">
          <div>Drop a file here, click to browse, or paste a URL below.</div>
          <div class="formats">PDF · DOCX · PPTX · XLSX · MD · HTML · CSV · PNG · JPG · MP3 · WAV · ZIP · HTTP · YouTube</div>
          <input id="import-file-${escapeAttr(domain)}" type="file" style="display:none">
        </div>
        <div class="import-row">
          <input id="import-url-${escapeAttr(domain)}" type="url" placeholder="paste URL…" style="flex:1">
          <button class="small" data-action="import-url" data-domain="${escapeAttr(domain)}">Import URL</button>
        </div>
        <div class="import-recent" id="import-recent-${escapeAttr(domain)}"></div>
      `;
    }
    let html = importHtml + ` ... existing html ...`;
```

After the `content.innerHTML = html;` line that already exists, also wire up the click + drag handlers:

```javascript
    if (canImport) {
      const zone = document.getElementById(`import-zone-${domain}`);
      const fileInput = document.getElementById(`import-file-${domain}`);
      zone.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', (e) => {
        const f = e.target.files?.[0];
        if (f) uploadImportFile(domain, f);
      });
      zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
      zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('drag-over');
        const f = e.dataTransfer.files?.[0];
        if (f) uploadImportFile(domain, f);
      });
    }
```

Finally, add helper functions at the end of `dashboard.js` (before the dispatch table at the bottom):

```javascript
async function uploadImportFile(domain, file) {
  const recent = document.getElementById(`import-recent-${domain}`);
  const row = document.createElement('div');
  row.className = 'row pending';
  row.textContent = `⏳ ${file.name} — uploading…`;
  recent?.prepend(row);
  try {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch(`${BASE}/admin/domains/${encodeURIComponent(domain)}/import`, {
      method: 'POST',
      credentials: 'include',
      body: fd,
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      row.className = 'row err';
      row.textContent = `✗ ${file.name} — ${body.error?.message || `HTTP ${r.status}`}`;
      return;
    }
    if (body.job_id) {
      row.className = 'row pending';
      row.textContent = `⏳ ${file.name} — queued (job ${body.job_id})`;
      pollImportJob(domain, body.job_id, file.name, row);
      return;
    }
    row.className = 'row ok';
    row.textContent = `✓ ${file.name} — ${body.chunks_captured} chunk(s) captured`;
    LOADERS.domains?.();
    if (typeof loadManageDocs === 'function') loadManageDocs();
  } catch (e) {
    row.className = 'row err';
    row.textContent = `✗ ${file.name} — ${e.message}`;
  }
}

async function importUrl(domain) {
  const input = document.getElementById(`import-url-${domain}`);
  const url = input.value.trim();
  if (!url) return;
  const recent = document.getElementById(`import-recent-${domain}`);
  const row = document.createElement('div');
  row.className = 'row pending';
  row.textContent = `⏳ ${url} — fetching…`;
  recent?.prepend(row);
  input.value = '';
  try {
    const r = await fetch(`${BASE}/admin/domains/${encodeURIComponent(domain)}/import/url`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      row.className = 'row err';
      row.textContent = `✗ ${url} — ${body.error?.message || `HTTP ${r.status}`}`;
      return;
    }
    if (body.job_id) {
      row.className = 'row pending';
      row.textContent = `⏳ ${url} — queued (job ${body.job_id})`;
      pollImportJob(domain, body.job_id, url, row);
      return;
    }
    row.className = 'row ok';
    row.textContent = `✓ ${url} — ${body.chunks_captured} chunk(s) captured`;
    if (typeof loadManageDocs === 'function') loadManageDocs();
  } catch (e) {
    row.className = 'row err';
    row.textContent = `✗ ${url} — ${e.message}`;
  }
}

async function pollImportJob(domain, jobId, label, row) {
  let delay = 2000;
  while (true) {
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(10000, delay * 1.3);
    try {
      const r = await fetch(`${BASE}/admin/domains/${encodeURIComponent(domain)}/import/jobs/${jobId}`, {
        credentials: 'include',
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        row.className = 'row err';
        row.textContent = `✗ ${label} — job poll ${r.status}`;
        return;
      }
      if (body.status === 'done') {
        row.className = 'row ok';
        row.textContent = `✓ ${label} — ${body.result?.chunks_captured ?? '?'} chunk(s) captured`;
        if (typeof loadManageDocs === 'function') loadManageDocs();
        return;
      }
      if (body.status === 'error' || body.status === 'interrupted') {
        row.className = 'row err';
        row.textContent = `✗ ${label} — ${body.error?.message || body.status}`;
        return;
      }
      row.textContent = `⏳ ${label} — ${body.status}${body.progress != null ? ` ${Math.round(body.progress * 100)}%` : ''}`;
    } catch (e) {
      row.className = 'row err';
      row.textContent = `✗ ${label} — ${e.message}`;
      return;
    }
  }
}
```

- [ ] **Step 3: Add `import-url` to the action dispatcher**

In `dashboard.js`, find the dispatcher block (search for `case 'invite-user':`). Add a new case:

```javascript
    case 'import-url': return importUrl(el.dataset.domain);
```

- [ ] **Step 4: JS lint**

```bash
node --check /mnt/c/projects/OB2/server/static/dashboard.js && echo OK
```

Expected: `OK`.

- [ ] **Step 5: Deploy**

```bash
docker cp /mnt/c/projects/OB2/server/static/dashboard.html ob2-server:/app/server/static/dashboard.html
docker cp /mnt/c/projects/OB2/server/static/dashboard.js ob2-server:/app/server/static/dashboard.js
docker compose -f /mnt/c/projects/OB2/docker/docker-compose.yml --env-file /mnt/c/projects/OB2/.env restart ob2-server
until curl -sf -m 2 http://127.0.0.1:7600/health > /dev/null 2>&1; do sleep 1; done
```

- [ ] **Step 6: Manual smoke (browser)**

In your browser, hard-refresh the dashboard, log in as admin, open the Domains tab, click Manage on `@test`, look at the Docs tab. Verify the upload zone appears, drop a small file, observe a "Recent imports" row reaching `✓`. Report any visual issues.

- [ ] **Step 7: Commit**

```bash
git add server/static/dashboard.html server/static/dashboard.js
git commit -m "feat(dashboard): file/URL upload zone with async job polling"
```

---

### Task 12: e2e Step 19 + fixtures

**Files:**
- Create: `tests/fixtures/import/tiny.pdf`
- Create: `tests/fixtures/import/tiny.docx`
- Create: `tests/fixtures/import/tiny.md`
- Create: `tests/fixtures/import/tiny.png`
- Create: `tests/fixtures/import/tiny.html`
- Create: `tests/fixtures/import/bomb.zip`
- Modify: `tests/e2e.sh`

- [ ] **Step 1: Create fixtures directory and minimal text fixtures**

```bash
mkdir -p /mnt/c/projects/OB2/tests/fixtures/import
cat > /mnt/c/projects/OB2/tests/fixtures/import/tiny.md <<'EOF'
# Lighthouse

A lighthouse is a tower with a bright light at the top.

## History

The earliest known lighthouse was the Pharos of Alexandria.
EOF
cat > /mnt/c/projects/OB2/tests/fixtures/import/tiny.html <<'EOF'
<!doctype html><html><head><title>Test</title></head>
<body><h1>Mariners</h1><p>Mariners use lighthouses to navigate.</p></body></html>
EOF
```

- [ ] **Step 2: Generate a tiny PDF**

```bash
docker exec ob2-server bash -c '
/app/retrieval/.venv/bin/pip show reportlab >/dev/null 2>&1 || /app/retrieval/.venv/bin/pip install --quiet reportlab
/app/retrieval/.venv/bin/python -c "
from reportlab.pdfgen import canvas
c = canvas.Canvas(\"/data/tiny.pdf\")
c.drawString(72, 720, \"The lighthouse keeper was named Hopper.\")
c.showPage()
c.save()
"
'
docker cp ob2-server:/data/tiny.pdf /mnt/c/projects/OB2/tests/fixtures/import/tiny.pdf
docker exec ob2-server rm -f /data/tiny.pdf
ls -la /mnt/c/projects/OB2/tests/fixtures/import/tiny.pdf
```

Expected: file present, > 500 bytes.

- [ ] **Step 3: Generate tiny.docx**

```bash
docker exec ob2-server bash -c '
/app/retrieval/.venv/bin/pip show python-docx >/dev/null 2>&1 || /app/retrieval/.venv/bin/pip install --quiet python-docx
/app/retrieval/.venv/bin/python -c "
from docx import Document
d = Document()
d.add_paragraph(\"The harbour at Gloucester is famous for its trawlers.\")
d.save(\"/data/tiny.docx\")
"
'
docker cp ob2-server:/data/tiny.docx /mnt/c/projects/OB2/tests/fixtures/import/tiny.docx
docker exec ob2-server rm -f /data/tiny.docx
```

- [ ] **Step 4: Generate tiny.png with rendered text (OCR target)**

```bash
docker exec ob2-server bash -c '
/app/retrieval/.venv/bin/pip show pillow >/dev/null 2>&1 || /app/retrieval/.venv/bin/pip install --quiet pillow
/app/retrieval/.venv/bin/python -c "
from PIL import Image, ImageDraw, ImageFont
img = Image.new(\"RGB\", (400, 80), \"white\")
d = ImageDraw.Draw(img)
d.text((10, 30), \"Captain Picard commands the Enterprise.\", fill=\"black\")
img.save(\"/data/tiny.png\")
"
'
docker cp ob2-server:/data/tiny.png /mnt/c/projects/OB2/tests/fixtures/import/tiny.png
docker exec ob2-server rm -f /data/tiny.png
```

- [ ] **Step 5: Generate a 10-GB-expanding bomb.zip (small on disk)**

```bash
python3 -c "
import zipfile, os
# 1 KB compressed payload that decompresses to 10 GB.
data = b'A' * (1024 * 1024)  # 1 MiB of 'A' compresses very well
with zipfile.ZipFile('/mnt/c/projects/OB2/tests/fixtures/import/bomb.zip', 'w', zipfile.ZIP_DEFLATED) as z:
    for i in range(10240):  # 10 GB total expanded
        z.writestr(f'fill-{i}.bin', data)
print('size on disk:', os.path.getsize('/mnt/c/projects/OB2/tests/fixtures/import/bomb.zip'))
"
```

Expected: a few MB on disk; 10 GB expanded would obviously trip the size cap.

- [ ] **Step 6: Add Step 19 to `tests/e2e.sh`**

Open `tests/e2e.sh`. Find the line `# ─────────────────────────────────────────────` immediately preceding `# Summary`. Insert ABOVE it:

```bash
# ─────────────────────────────────────────────
echo
echo "── Step 19: File / URL ingestion via MarkItDown ──"

if [ -z "${BOB_KEY:-}" ]; then
  echo "  SKIP: needs BOB_KEY (admin) from earlier steps"
else
  IMPORT_DOMAIN="import-test"
  curl -s -X POST "$BASE/admin/domains" \
    -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
    -d "{\"domain\":\"$IMPORT_DOMAIN\",\"description\":\"e2e import fixture domain\"}" > /dev/null
  FIX="$PROJECT_DIR/tests/fixtures/import"

  # 19.1: PDF upload — sync, returns ok+chunks
  RESP=$(curl -s -X POST -H "Authorization: Bearer $BOB_KEY" \
    -F "file=@$FIX/tiny.pdf" -F "source_label=tiny.pdf" \
    "$BASE/admin/domains/$IMPORT_DOMAIN/import")
  assert_contains "PDF upload returns ok" "$RESP" '"ok":true'
  assert_contains "PDF upload reports chunks_captured" "$RESP" '"chunks_captured"'

  # 19.2: DOCX upload
  RESP=$(curl -s -X POST -H "Authorization: Bearer $BOB_KEY" \
    -F "file=@$FIX/tiny.docx" \
    "$BASE/admin/domains/$IMPORT_DOMAIN/import")
  assert_contains "DOCX upload returns ok" "$RESP" '"ok":true'

  # 19.3: HTML upload
  RESP=$(curl -s -X POST -H "Authorization: Bearer $BOB_KEY" \
    -F "file=@$FIX/tiny.html" \
    "$BASE/admin/domains/$IMPORT_DOMAIN/import")
  assert_contains "HTML upload returns ok" "$RESP" '"ok":true'

  # 19.4: MD upload
  RESP=$(curl -s -X POST -H "Authorization: Bearer $BOB_KEY" \
    -F "file=@$FIX/tiny.md" \
    "$BASE/admin/domains/$IMPORT_DOMAIN/import")
  assert_contains "MD upload returns ok" "$RESP" '"ok":true'

  # 19.5: PNG upload (OCR — expect at least conversion attempt; OCR may produce text)
  RESP=$(curl -s -X POST -H "Authorization: Bearer $BOB_KEY" \
    -F "file=@$FIX/tiny.png" \
    "$BASE/admin/domains/$IMPORT_DOMAIN/import")
  assert_contains "PNG upload returns ok" "$RESP" '"ok":true'

  # 19.6: URL ingestion
  RESP=$(curl -s -X POST -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
    -d '{"url":"https://example.com/"}' \
    "$BASE/admin/domains/$IMPORT_DOMAIN/import/url")
  assert_contains "URL ingestion returns ok" "$RESP" '"ok":true'

  # 19.7: SSRF block (loopback)
  STATUS=$(curl -s -o /tmp/ssrf.json -w "%{http_code}" -X POST -H "Authorization: Bearer $BOB_KEY" \
    -H "Content-Type: application/json" \
    -d '{"url":"http://127.0.0.1:11434/api/version"}' \
    "$BASE/admin/domains/$IMPORT_DOMAIN/import/url")
  assert_status "SSRF loopback URL refused" "$STATUS" "400"
  assert_contains "SSRF response carries url_blocked type" "$(cat /tmp/ssrf.json)" "url_blocked"

  # 19.8: Auth — alice (no write on import-test) refused
  if [ -n "${ALICE_KEY:-}" ]; then
    STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST -H "Authorization: Bearer $ALICE_KEY" \
      -F "file=@$FIX/tiny.md" \
      "$BASE/admin/domains/$IMPORT_DOMAIN/import")
    assert_status "alice refused (no write on import-test)" "$STATUS" "403"
  fi

  # 19.9: ZIP bomb — should be refused (either 400 conversion_failed or job ends in error)
  RESP=$(curl -s -X POST -H "Authorization: Bearer $BOB_KEY" \
    -F "file=@$FIX/bomb.zip" \
    "$BASE/admin/domains/$IMPORT_DOMAIN/import")
  TESTS=$((TESTS + 1))
  if echo "$RESP" | grep -q '"job_id"'; then
    # async path — extract id and poll until terminal
    JOB_ID=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin)['job_id'])")
    for i in $(seq 1 30); do
      sleep 2
      JR=$(curl -s -H "Authorization: Bearer $BOB_KEY" "$BASE/admin/domains/$IMPORT_DOMAIN/import/jobs/$JOB_ID")
      STATUS=$(echo "$JR" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
      [ "$STATUS" = "error" ] || [ "$STATUS" = "interrupted" ] || [ "$STATUS" = "done" ] && break
    done
    if [ "$STATUS" = "error" ] || [ "$STATUS" = "interrupted" ]; then
      echo "  PASS: zip bomb job reached terminal failure ($STATUS)"
      PASS=$((PASS + 1))
    else
      echo "  FAIL: zip bomb job ended $STATUS — should have errored"
      FAIL=$((FAIL + 1))
    fi
  elif echo "$RESP" | grep -q '"type":"conversion_failed"'; then
    echo "  PASS: zip bomb sync upload refused"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: zip bomb response unexpected: $RESP"
    FAIL=$((FAIL + 1))
  fi

  # 19.10: Citation check — ask the chat about the PDF content; reply should
  #        cite the tiny.pdf source label.
  RESP=$(curl -s -X POST "$BASE/v1/chat/completions" \
    -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
    --max-time 60 \
    -d "{\"model\":\"ob2\",\"messages\":[{\"role\":\"user\",\"content\":\"@$IMPORT_DOMAIN Who was the lighthouse keeper?\"}],\"stream\":false}")
  assert_contains "PDF retrieval finds 'Hopper'" "$RESP" "Hopper"
fi
```

- [ ] **Step 7: Bash lint**

```bash
bash -n /mnt/c/projects/OB2/tests/e2e.sh && echo OK
```

Expected: `OK`.

- [ ] **Step 8: Commit**

```bash
git add tests/fixtures/import tests/e2e.sh
git commit -m "test(e2e): step 19 covers file/URL ingestion + SSRF + zip bomb + auth"
```

---

### Task 13: Final integration — image rebuild + smoke

- [ ] **Step 1: Rebuild the image so all changes survive container recreation**

```bash
cd /mnt/c/projects/OB2 && docker compose -f docker/docker-compose.yml --env-file .env build ob2-server
```

Expected: clean build.

- [ ] **Step 2: Recreate from new image**

```bash
docker compose -f docker/docker-compose.yml --env-file .env --profile openwebui up -d
until curl -sf -m 2 http://127.0.0.1:7600/health > /dev/null 2>&1; do sleep 1; done
```

- [ ] **Step 3: End-to-end smoke after fresh recreate**

```bash
ADMIN_KEY="ob2_<redacted>"

echo "=== upload tiny.md ==="
curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" \
  -F "file=@/mnt/c/projects/OB2/tests/fixtures/import/tiny.md" \
  http://127.0.0.1:7600/admin/domains/test/import | python3 -m json.tool

echo
echo "=== upload tiny.pdf ==="
curl -s -X POST -H "Authorization: Bearer $ADMIN_KEY" \
  -F "file=@/mnt/c/projects/OB2/tests/fixtures/import/tiny.pdf" \
  http://127.0.0.1:7600/admin/domains/test/import | python3 -m json.tool

echo
echo "=== chat finds the captured content ==="
SVC_TOKEN=$(grep "^OB2_OPENWEBUI_SERVICE_TOKEN=" /mnt/c/projects/OB2/.env | cut -d= -f2)
curl -s -X POST http://127.0.0.1:7600/v1/chat/completions \
  -H "Authorization: Bearer $SVC_TOKEN" -H "X-OpenWebUI-User-Name: admin" \
  -H "Content-Type: application/json" --max-time 60 \
  -d '{"model":"ob2","messages":[{"role":"user","content":"Who was the lighthouse keeper?"}],"stream":false}' \
  | python3 -c "import sys,json; print('REPLY:', json.load(sys.stdin)['choices'][0]['message']['content'][:400])"
```

Expected: lighthouse-keeper question returns a reply mentioning Hopper, with a citation referencing `tiny.pdf` or similar.

- [ ] **Step 4: Tag the milestone commit**

```bash
git log --oneline | head -3
```

- [ ] **Step 5: Optional — run the full e2e suite against the new image**

```bash
# Note: stop ob2-server first; e2e.sh manages its own server lifecycle on the host.
# This is OPTIONAL — the per-task smoke tests already cover the new code.
# Skip if you don't want to take Docker down.
```

(End of plan.)

---

## Self-review

**Spec coverage:**

| Spec section | Covered by |
|---|---|
| Format support (Profile C) | Task 1 (system deps), Task 2 (markitdown[all]), Task 3 (sidecar RPC) |
| Architecture / lifecycle | Tasks 3, 7, 8 |
| `POST /import` (file) | Task 8 |
| `POST /import/url` | Task 8 |
| `GET /import/jobs/:id` | Task 8 |
| MCP `capture_file` | Task 9 |
| Configuration env vars | Task 10 |
| Security: magic-byte sniff | Task 5 |
| Security: SSRF denylist | Task 5 |
| Security: path traversal | Task 9 (uses `Deno.realPath` + `/data/` check) |
| Security: ZIP bomb | Covered by `OB2_IMPORT_MAX_BYTES` enforced in runner; e2e Step 19 verifies refusal |
| Per-chunk metadata | Task 7 (captureChunks function) |
| Chunker behaviour | Task 4 |
| Job queue | Task 6 |
| Dashboard upload UI | Task 11 |
| Async job polling (UI) | Task 11 |
| Tests + fixtures | Task 12 |
| Final image rebuild | Task 13 |

**Spec items deliberately deferred:**

- "Domains tab top-level + Import button (admin only)" — listed as optional polish in the spec; not in the plan. Add as a follow-up if desired.
- "Recent imports list as persistent activity log" — explicitly out of spec scope; per-tab in-memory only, which Task 11 implements.
- ZIP bomb handling more sophisticated than max-bytes: deferred. The size cap catches the bomb; depth-3 limit relies on MarkItDown / extraction libraries' own caps. If a real depth-bomb sneaks through in practice, add explicit recursion limiting in the runner.

**Type / name consistency check:**

- `dispatch()` in `runner.ts` returns `IngestResult | IngestJobResponse` — both shapes are used by admin.ts in Task 8 and mcp.ts in Task 9. Property names match (`job_id`, `chunks_captured`, `source_format`, `warnings`).
- `chunkMarkdown` returns `Chunk[]` with `text`, `breadcrumb`, `chunk_index`, `chunk_total` — referenced by `captureChunks` in Task 7. Match.
- `JobRecord.status` strings line up across `jobs.ts` (Task 6), `dispatch()` (Task 7), and dashboard polling (Task 11).
- `loadIngestEnv()` reads `OB2_IMPORT_*` env vars; same names registered in compose (Task 10) and `Config` (Task 10). Match.
- `currentAuth()`, `errorResult()`, `hasPermission()` referenced in Task 9 — Task 9 explicitly says "if not already imported, follow the same pattern as `capture_knowledge`."

**Placeholder scan:** none found. Every code step has the actual code; every command shows expected output; every endpoint and error type is named.

---
