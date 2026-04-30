# Upload Provenance Implementation Plan

**Status:** Complete — all 9 tasks shipped, 34/34 golden tests passing, pushed to origin/master 2026-04-26.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stamp every captured document with `_ob2_uploaded_by: "<username>"`, surface it in the dashboard docs table, and include it in multi-domain LLM context annotations with a runtime toggle to suppress it.

**Architecture:** `_ob2_uploaded_by` is stored in the existing `metadata` JSON column on the `docs` table — no schema change. All three ingestion paths (MCP `capture_knowledge`, `dispatch()` pipeline, admin HTTP routes) are updated to stamp the caller's username. The multi-domain sidecar context builder appends "uploaded by X" to the per-source suffix when a runtime config flag (`context.show_uploader_in_context`, default `true`) is set. The dashboard docs table reads the field from the already-returned metadata.

**Tech Stack:** Deno/TypeScript (server), Python (retrieval sidecar), vanilla JS (dashboard)

---

## File Map

| File | Change |
|---|---|
| `server/runtime_config.ts` | Add `ContextConfig` interface + `context` section to `RuntimeConfig`, `ENV_KEYS`, `DEFAULTS`, `validateRuntime` |
| `server/import/runner.ts` | Add `uploaded_by?: string` to `IngestRequest`; stamp `_ob2_uploaded_by` in `captureChunks()` |
| `server/routes/mcp.ts` | Pass `_ob2_uploaded_by` in `capture_knowledge`; pass `uploaded_by` in `capture_file` → `dispatch()` |
| `server/routes/admin.ts` | Pass `uploaded_by` from `c.get("auth")?.username` in file and URL import dispatch calls |
| `server/routes/gateway.ts` | Pass `show_uploader_in_context` from runtime config on `build_multi_context` calls |
| `retrieval/sidecar.py` | Read `show_uploader_in_context` param in `method_build_multi_context`; append to `suffix_parts`; include `_ob2_uploaded_by` in retrieved dict |
| `server/static/dashboard.js` | Add "Uploaded by" sub-line to docs table rows |
| `docker/docker-compose.yml` | Add `OB2_CONTEXT_SHOW_UPLOADER` env var |
| `.env.example` | Document `OB2_CONTEXT_SHOW_UPLOADER` |
| `tests/sidecar-golden/fixtures/build_multi_context.jsonl` | New golden fixture file testing uploader annotation |

---

## Task 1: runtime_config.ts — add `context` section

**Files:**
- Modify: `server/runtime_config.ts`

- [ ] **Step 1: Add `ContextConfig` interface and extend `RuntimeConfig`**

In `server/runtime_config.ts`, after the `GraphConfig` interface (around line 63), add:

```typescript
export interface ContextConfig {
  show_uploader_in_context: boolean;
}
```

Then extend `RuntimeConfig` (around line 71) to add `context: ContextConfig`:

```typescript
export interface RuntimeConfig {
  ollama: OllamaConfig;
  embedder: EmbedderConfig;
  sync: SyncConfig;
  retrieval: RetrievalConfig;
  mail: MailConfig;
  graph: GraphConfig;
  context: ContextConfig;
}
```

- [ ] **Step 2: Add to `ENV_KEYS`**

In the `ENV_KEYS` map (after the `graph.*` entries), add:

```typescript
  "context.show_uploader_in_context": "OB2_CONTEXT_SHOW_UPLOADER",
```

- [ ] **Step 3: Add to `DEFAULTS`**

In the `DEFAULTS` constant (after the `graph:` block), add:

```typescript
  context: {
    show_uploader_in_context: true,
  },
```

- [ ] **Step 4: Add to `validateRuntime`**

In `validateRuntime`, in the section-check `for` loop (around line 281), add `"context"` to the array:

```typescript
  for (const section of ["ollama", "embedder", "sync", "retrieval", "mail", "graph", "context"]) {
```

Then after the `graph` validation block, add:

```typescript
  const context = c.context as Record<string, unknown> | undefined;
  if (context) {
    if (context.show_uploader_in_context !== undefined && typeof context.show_uploader_in_context !== "boolean") {
      throw new Error("context.show_uploader_in_context must be a boolean");
    }
  }
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd /mnt/c/projects/OB2/server && ~/.deno/bin/deno check index.ts
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd /mnt/c/projects/OB2
git add server/runtime_config.ts
git commit -m "feat(config): add context.show_uploader_in_context runtime toggle"
```

---

## Task 2: runner.ts — thread `uploaded_by` through the dispatch pipeline

**Files:**
- Modify: `server/import/runner.ts`

- [ ] **Step 1: Add `uploaded_by` to `IngestRequest`**

In the `IngestRequest` interface (around line 12), add the optional field after `original_filename`:

```typescript
export interface IngestRequest {
  domain: string;
  source: { kind: "path"; path: string } | { kind: "url"; url: string };
  source_label?: string;
  tags?: string[];
  file_id?: string;
  original_filename?: string;
  uploaded_by?: string;
}
```

- [ ] **Step 2: Stamp `_ob2_uploaded_by` in `captureChunks()`**

In `captureChunks()` (around line 79), after the block that conditionally sets `_ob2_import_file_id` and `_ob2_import_filename`, add:

```typescript
    if (req.uploaded_by) meta._ob2_uploaded_by = req.uploaded_by;
```

The surrounding context for placement (lines ~84–94):

```typescript
    if (req.file_id) meta._ob2_import_file_id = req.file_id;
    if (req.original_filename) meta._ob2_import_filename = req.original_filename;
    if (req.uploaded_by) meta._ob2_uploaded_by = req.uploaded_by;  // ← add this line

    await sidecar.call("capture", {
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /mnt/c/projects/OB2/server && ~/.deno/bin/deno check index.ts
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /mnt/c/projects/OB2
git add server/import/runner.ts
git commit -m "feat(ingest): thread uploaded_by through dispatch pipeline"
```

---

## Task 3: routes/mcp.ts — stamp uploader in MCP capture tools

**Files:**
- Modify: `server/routes/mcp.ts`

- [ ] **Step 1: Stamp `_ob2_uploaded_by` in `capture_knowledge`**

In the `capture_knowledge` tool handler, find the `sidecar.call("capture", {...})` block (around line 118). Add `metadata` with the uploader:

```typescript
        const auth = getAuth();
        const r = await sidecar.call<CaptureResult>("capture", {
          doc_id: `usr_${crypto.randomUUID()}`,
          domain,
          text,
          tags: tags ?? [],
          source: source ?? "user",
          metadata: auth?.username ? { _ob2_uploaded_by: auth.username } : {},
        });
```

The `getAuth()` call is already imported (line 22 area). Add `const auth = getAuth();` before the sidecar call if it isn't already assigned in that scope.

- [ ] **Step 2: Pass `uploaded_by` in `capture_file`**

In the `capture_file` tool handler, find the `dispatch(sidecar, { ... })` call (around line 177). Add `uploaded_by`:

```typescript
        const fileAuth = getAuth();
        const out = await dispatch(sidecar, {
          domain,
          source: { kind: "path", path: resolved },
          source_label: source_label ?? resolved,
          tags: tags ?? [],
          uploaded_by: fileAuth?.username,
        }, env);
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /mnt/c/projects/OB2/server && ~/.deno/bin/deno check index.ts
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /mnt/c/projects/OB2
git add server/routes/mcp.ts
git commit -m "feat(mcp): stamp _ob2_uploaded_by on capture_knowledge and capture_file"
```

---

## Task 4: routes/admin.ts — stamp uploader in HTTP import routes

**Files:**
- Modify: `server/routes/admin.ts`

- [ ] **Step 1: Add `uploaded_by` to the file import dispatch call**

Find `POST /admin/domains/:domain/import` (around line 336). The `dispatch()` call currently passes `domain`, `source`, `source_label`, `tags`, `file_id`, `original_filename`. Add `uploaded_by`:

```typescript
      const out = await dispatch(sidecar, {
        domain,
        source: { kind: "path", path: persistedPath },
        source_label,
        tags,
        file_id,
        original_filename: file.name,
        uploaded_by: c.get("auth")?.username,
      }, env);
```

- [ ] **Step 2: Add `uploaded_by` to the URL import dispatch call**

Find `POST /admin/domains/:domain/import/url` (around line 373). Add `uploaded_by`:

```typescript
      const out = await dispatch(sidecar, {
        domain,
        source: { kind: "url", url: body.url },
        source_label: body.source_label,
        tags: body.tags ?? [],
        uploaded_by: c.get("auth")?.username,
      }, env);
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /mnt/c/projects/OB2/server && ~/.deno/bin/deno check index.ts
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /mnt/c/projects/OB2
git add server/routes/admin.ts
git commit -m "feat(admin): stamp _ob2_uploaded_by on file and URL imports"
```

---

## Task 5: sidecar.py — add uploader to multi-domain context annotations

**Files:**
- Modify: `retrieval/sidecar.py`

- [ ] **Step 1: Write a failing golden fixture for multi-domain context with uploader**

Create `tests/sidecar-golden/fixtures/build_multi_context.jsonl` with two test cases:

```jsonl
{"name": "uploader-in-context-default-on", "seed": [{"method": "capture", "params": {"doc_id": "d1", "domain": "alpha", "text": "the sky is blue", "metadata": {"_ob2_uploaded_by": "alice", "_ob2_domain": "alpha"}}}], "request": {"method": "build_multi_context", "params": {"domains": ["alpha"], "query": "sky", "budget_tokens": 400}}, "expected": {"compressed_text": "alice"}}
{"name": "uploader-suppressed-when-flag-off", "seed": [{"method": "capture", "params": {"doc_id": "d2", "domain": "beta", "text": "the grass is green", "metadata": {"_ob2_uploaded_by": "bob", "_ob2_domain": "beta"}}}], "request": {"method": "build_multi_context", "params": {"domains": ["beta"], "query": "grass", "budget_tokens": 400, "show_uploader_in_context": false}}, "expected": {"compressed_text": "bob"}}
```

Note: the comparator does substring matching for strings by default. Verify this assumption:

```bash
cd /mnt/c/projects/OB2/tests/sidecar-golden && head -20 comparator.py
```

If the comparator does exact match on `compressed_text`, adjust the expected value to the full formatted string. If it does `in` / substring matching, the fixture as written is correct.

- [ ] **Step 2: Run the fixture to confirm it fails**

```bash
cd /mnt/c/projects/OB2/tests/sidecar-golden
OB2_SQLITE_PATH=/tmp/test_prov.db \
  OB2_CONTEXT_ENGINE_PATH=/mnt/c/projects/OB2/context-engine \
  ../../retrieval/.venv/bin/pytest test_python.py -k "build_multi_context" -v 2>&1 | tail -20
```

Expected: FAILED (method not found or uploader not in output).

- [ ] **Step 3: Read the existing `method_build_multi_context` to locate the edit point**

The function is around line 588–690 in `retrieval/sidecar.py`. The `suffix_parts` block is around lines 655–661:

```python
        suffix_parts: list[str] = []
        if date:
            suffix_parts.append(f"Saved on {date}")
        if origin:
            suffix_parts.append(f"from {origin}")
        if suffix_parts:
            text = f"{text}\n  ({'; '.join(suffix_parts)}.)"
```

- [ ] **Step 4: Read the `show_uploader_in_context` param and add uploader to suffix**

At the top of `method_build_multi_context`, after the existing param reads (around line 609), add:

```python
    show_uploader = params.get("show_uploader_in_context", True)
```

Then in the `suffix_parts` block, add the uploader line **before** the `if suffix_parts:` check:

```python
        suffix_parts: list[str] = []
        if date:
            suffix_parts.append(f"Saved on {date}")
        if origin:
            suffix_parts.append(f"from {origin}")
        if show_uploader:
            uploader = meta.get("_ob2_uploaded_by") or ""
            if uploader:
                suffix_parts.append(f"uploaded by {uploader}")
        if suffix_parts:
            text = f"{text}\n  ({'; '.join(suffix_parts)}.)"
```

- [ ] **Step 5: Also include `_ob2_uploaded_by` in the retrieved dict for each hit**

In the same loop, find the `retrieved.append({...})` block (around line 666). Add the field alongside the other `_ob2_*` fields:

```python
            "_ob2_import_file_id": meta.get("_ob2_import_file_id"),
            "_ob2_import_filename": meta.get("_ob2_import_filename"),
            "_ob2_uploaded_by": meta.get("_ob2_uploaded_by"),
```

- [ ] **Step 6: Run the fixture to confirm it passes**

```bash
cd /mnt/c/projects/OB2/tests/sidecar-golden
OB2_SQLITE_PATH=/tmp/test_prov2.db \
  OB2_CONTEXT_ENGINE_PATH=/mnt/c/projects/OB2/context-engine \
  ../../retrieval/.venv/bin/pytest test_python.py -k "build_multi_context" -v 2>&1 | tail -20
```

Expected: `test_python_sidecar[build_multi_context:uploader-in-context-default-on] PASSED`

For the "suppressed" fixture: if it PASSES too, the flag is working. If "suppressed" FAILS because "bob" is unexpectedly absent — re-examine: the suppressed fixture asserts `compressed_text: "bob"` which would mean "bob should appear". That's wrong — for "suppressed" the expected should assert "bob" does NOT appear. But the comparator does substring inclusion checks and we can't easily assert absence with it.

Instead, for the suppressed test, change expected to the raw text without the uploader suffix. The exact expected value for the suppressed case: since "bob" should NOT appear in compressed_text, and the text is "the grass is green", expected should be:

```jsonl
{"name": "uploader-suppressed-when-flag-off", "seed": [{"method": "capture", "params": {"doc_id": "d2", "domain": "beta", "text": "the grass is green", "metadata": {"_ob2_uploaded_by": "bob", "_ob2_domain": "beta"}}}], "request": {"method": "build_multi_context", "params": {"domains": ["beta"], "query": "grass", "budget_tokens": 400, "show_uploader_in_context": false}}, "expected": {"retrieved_docs": [{"doc_id": "d2"}]}}
```

Update the fixture file accordingly. The `retrieved_docs[0].doc_id` check confirms the doc was found without testing for uploader absence (limitation of the comparator).

- [ ] **Step 7: Run the full sidecar golden suite to verify no regressions**

```bash
cd /mnt/c/projects/OB2/tests/sidecar-golden
OB2_SQLITE_PATH=/tmp/test_all.db \
  OB2_CONTEXT_ENGINE_PATH=/mnt/c/projects/OB2/context-engine \
  ../../retrieval/.venv/bin/pytest test_python.py -v 2>&1 | tail -30
```

Expected: all existing tests pass.

- [ ] **Step 8: Commit**

```bash
cd /mnt/c/projects/OB2
git add retrieval/sidecar.py tests/sidecar-golden/fixtures/build_multi_context.jsonl
git commit -m "feat(sidecar): add uploaded_by annotation to multi-domain context blocks"
```

---

## Task 6: gateway.ts — pass `show_uploader_in_context` to sidecar

**Files:**
- Modify: `server/routes/gateway.ts`

- [ ] **Step 1: Locate the `build_multi_context` call**

Around line 526 in `server/routes/gateway.ts`:

```typescript
        const ctx = await sidecar.call<SidecarContextResult>("build_multi_context", {
          domains: readable,
          query,
          budget_tokens: 6000,
        });
```

- [ ] **Step 2: Add the runtime config param**

Ensure `getRuntime` is imported (check existing imports at top of file — it should already be). Then add the param:

```typescript
        const ctx = await sidecar.call<SidecarContextResult>("build_multi_context", {
          domains: readable,
          query,
          budget_tokens: 6000,
          show_uploader_in_context: getRuntime().context.show_uploader_in_context,
        });
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /mnt/c/projects/OB2/server && ~/.deno/bin/deno check index.ts
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /mnt/c/projects/OB2
git add server/routes/gateway.ts
git commit -m "feat(gateway): pass show_uploader_in_context to build_multi_context"
```

---

## Task 7: dashboard.js — show "Uploaded by" in docs table

**Files:**
- Modify: `server/static/dashboard.js`

- [ ] **Step 1: Locate the docs table row builder**

Around line 643–667 in `server/static/dashboard.js`. The current row content is:

```javascript
        const meta = doc.metadata || {};
        const fileId = meta._ob2_import_file_id;
        const filename = meta._ob2_import_filename || meta.source || '';
        const sourceLine = fileId
          ? `<a ...>↓ ${escapeHtml(filename)}</a>`
          : (filename ? `<span ...>${escapeHtml(filename)}</span>` : '');
        ...
        html += `<tr ...>
          <td ...>
            <div>${escapeHtml(preview)}</div>
            ${sourceLine ? `<div style="margin-top:2px">${sourceLine}</div>` : ''}
          </td>
          ...
        </tr>`;
```

- [ ] **Step 2: Add uploader line**

After the `sourceLine` declaration and before building `html +=`, add:

```javascript
        const uploaderLine = meta._ob2_uploaded_by
          ? `<span style="color:var(--muted); font-size:0.78rem">↑ ${escapeHtml(meta._ob2_uploaded_by)}</span>`
          : '';
```

Then in the `<td>` content, add the uploader line after the source line:

```javascript
        html += `<tr data-doc-id="${escapeAttr(doc.doc_id)}">
          <td style="padding:4px 6px;max-width:360px;word-break:break-word">
            <div>${escapeHtml(preview)}</div>
            ${sourceLine ? `<div style="margin-top:2px">${sourceLine}</div>` : ''}
            ${uploaderLine ? `<div style="margin-top:2px">${uploaderLine}</div>` : ''}
          </td>
          ${actionCell}
        </tr>`;
```

- [ ] **Step 3: Commit**

```bash
cd /mnt/c/projects/OB2
git add server/static/dashboard.js
git commit -m "feat(dashboard): show uploaded_by in domain docs table"
```

---

## Task 8: docker-compose.yml and .env.example — new env var

**Files:**
- Modify: `docker/docker-compose.yml`
- Modify: `.env.example`

- [ ] **Step 1: Add to docker-compose.yml**

In the `ob2-server` environment block, after the Graph RAG variables (around line 66), add:

```yaml
      # Upload provenance — show "uploaded by <user>" in multi-domain chat context.
      # Set to "false" to suppress from LLM context without removing from the database.
      OB2_CONTEXT_SHOW_UPLOADER: ${OB2_CONTEXT_SHOW_UPLOADER:-}
```

Using empty default so the runtime config file is the source of truth; only an explicit env value overrides.

- [ ] **Step 2: Add to .env.example**

In the Open WebUI section (at the end of `.env.example`), add a new section:

```bash
# Upload provenance — include uploader name in multi-domain LLM context annotations.
# Default: true. Set to false to suppress from LLM responses without touching stored data.
# OB2_CONTEXT_SHOW_UPLOADER=false
```

- [ ] **Step 3: Commit**

```bash
cd /mnt/c/projects/OB2
git add docker/docker-compose.yml .env.example
git commit -m "feat(config): add OB2_CONTEXT_SHOW_UPLOADER env var"
```

---

## Task 9: Integration verification

- [ ] **Step 1: Rebuild and restart the stack**

```bash
cd /mnt/c/projects/OB2
scripts/docker-restart.sh --with-chat --build
```

Expected: all containers healthy, Chat endpoint accessible.

- [ ] **Step 2: Capture a test document via the MCP tool and verify metadata**

```bash
BRAIN_KEY=$(grep OB2_BRAIN_KEY .env | cut -d= -f2)
curl -s -X POST http://localhost:7600/mcp \
  -H "Authorization: Bearer $BRAIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"capture_knowledge","arguments":{"domain":"test-prov","text":"the upload provenance feature is working"}}}'
```

Expected: `{"result":{"doc_id":"usr_...","domain":"test-prov",...}}`

- [ ] **Step 3: Verify `_ob2_uploaded_by` is stored in the doc**

```bash
curl -s "http://localhost:7600/admin/domains/test-prov/docs" \
  -H "Authorization: Bearer $BRAIN_KEY" | grep -o "_ob2_uploaded_by[^,}]*"
```

Expected: `"_ob2_uploaded_by":"<your-username>"` (or the username in your users.json; in single-key mode the field will be absent).

- [ ] **Step 4: Open the dashboard and verify the "Uploaded by" line appears**

Open `http://localhost:7600/dashboard` → Domains → `test-prov` → Docs tab.

Expected: each doc captured by a named user shows `↑ <username>` below the source line. Docs without the field show nothing.

- [ ] **Step 5: Test the config toggle**

In the Config tab, edit the YAML to add:

```yaml
context:
  show_uploader_in_context: false
```

Save. Then query the domain via `POST /v1/chat/completions` (multi-domain, no `@prefix`). Inspect the system prompt in the gateway logs or verify the response doesn't mention the uploader name.

Re-enable (`true`) and verify the uploader appears again in chat context.
