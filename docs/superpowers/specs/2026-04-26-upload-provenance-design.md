# Upload Provenance

**Date:** 2026-04-26
**Status:** Implemented — shipped 2026-04-26

## Background

OB2 is a multi-user platform. Every user who has write access to a domain can capture documents into it, but there is currently no record of who did so. Admins have no way to answer "who added this?" and the LLM cannot answer "who told you that?" — even though the uploader's identity is implicit in every authenticated capture request.

This spec adds uploader identity to every captured document: stored in the existing `_ob2_*` metadata slot, surfaced in the dashboard docs table, and optionally included in the LLM source block annotations so the model can cite provenance in its answers.

## Goals

- Every document captured after this change carries `_ob2_uploaded_by: "<username>"` in its metadata.
- The dashboard docs table shows an "Uploaded by" column.
- The LLM context includes the uploader in the per-source annotations (`Saved on …; uploaded by john.`) so the model can answer provenance questions.
- A runtime config toggle (`context.show_uploader_in_context`, default `true`) lets an admin suppress uploader from LLM context without touching the stored data.
- No schema migration. Old docs without `_ob2_uploaded_by` display `—` in the dashboard and are unaffected in context.

## Non-goals

- Per-document access control based on uploader.
- Editing or re-attributing uploader after the fact.
- Tracking uploader for admin API calls made outside the normal user-authenticated flow.
- Showing uploader in the graph tab or entity extraction pipeline.

## Data model

No schema change. `_ob2_uploaded_by` is added to the existing `metadata` JSON column in the `docs` table, alongside the existing `_ob2_import_source`, `_ob2_import_filename`, etc. fields.

```
metadata = {
  "source": "user",
  "tags": [],
  "_ob2_uploaded_by": "john",     ← new
  "_ob2_import_source": "report.pdf",
  ...
}
```

In single-key mode (no `users.json`), the capture call carries no username; the field is simply omitted.

## Ingestion paths

All three paths converge on stamping `_ob2_uploaded_by` before the sidecar call:

### 1. `capture_knowledge` MCP tool (`server/routes/mcp.ts`)

The tool handler already calls `getAuth()` to obtain the caller's `AuthContext`. Pass `_ob2_uploaded_by` in the `metadata` argument of the `sidecar.call("capture", …)` invocation:

```ts
metadata: auth ? { _ob2_uploaded_by: auth.username } : {},
```

### 2. `dispatch()` pipeline (`server/import/runner.ts`)

Used by `capture_file` (MCP), admin file upload, and admin URL ingest. Add `uploaded_by?: string` to `IngestRequest`. `captureChunks()` stamps `_ob2_uploaded_by` on every chunk's metadata when present.

### 3. Admin HTTP routes (`server/routes/admin.ts`)

Both `POST /admin/domains/:domain/import` (file) and `POST /admin/domains/:domain/import/url` (URL) already have `c.get("auth")`. Pass `uploaded_by: c.get("auth")?.username` in the `IngestRequest` to `dispatch()`.

For the MCP `capture_file` tool, `getAuth()` provides the username; it is threaded into `dispatch()` the same way.

## LLM context annotations

OB2 has two context-building paths:

- **Multi-domain** (`method_build_multi_context`): formats each hit as a numbered `[N] source=@domain` block with a `suffix_parts` footer that already includes "Saved on" and "from origin". This is where uploader annotation is added.
- **Single-domain** (`method_build_context`): delegates to the context engine which returns plain compressed text with no per-source headers or footers. No change needed here.

Note: `_ob2_uploaded_by` is included in `retrieved_docs` for both single-domain and multi-domain paths (after hydrating the context engine `Document` with full metadata). The `show_uploader_in_context` param is passed to both `build_context` and `build_multi_context` from the gateway.

When `show_uploader_in_context` is `true` and `_ob2_uploaded_by` is present in the doc's metadata, append it to `suffix_parts` in `method_build_multi_context`:

```
[1] source=@domain
My favorite color is blue.
  (Saved on 2026-04-25; uploaded by john.)
```

The gateway (`server/routes/gateway.ts`) reads the runtime config and passes `show_uploader_in_context` as a param on every `build_multi_context` sidecar call. The `build_context` (single-domain) call does not receive this param since it has no annotation layer.

## Runtime config toggle

Add `context.show_uploader_in_context: boolean` (default `true`) to `RuntimeConfig` in `server/runtime_config.ts`, following the exact pattern of `graph.enabled`:

- New `ContextConfig` interface with a single `show_uploader_in_context` field.
- Add `"context.show_uploader_in_context": "OB2_CONTEXT_SHOW_UPLOADER"` to `ENV_KEYS`.
- Add to `DEFAULTS`.
- Surface in the Config tab of the dashboard with a checkbox, same pattern as the Graph section.
- Add `OB2_CONTEXT_SHOW_UPLOADER` to `docker/docker-compose.yml` and `.env.example`.

## Dashboard

The `GET /admin/domains/:domain/docs` endpoint already returns full metadata. In the dashboard's domain docs table (`dashboard.html`), add an "Uploaded by" column that reads `metadata._ob2_uploaded_by`. Docs without the field display `—`. No backend change required.

## Sidecar protocol change

`build_context` gains an optional boolean param `show_uploader_in_context` (default `true`). The gateway always passes the explicit value from runtime config. The sidecar treats absence as `true` for backwards compatibility with any callers that do not yet pass the param.

## Sequence

1. User calls `capture_knowledge` or uploads a file via the dashboard.
2. The route resolves `auth.username` and stamps `_ob2_uploaded_by` into metadata before/during the sidecar call.
3. The sidecar stores the doc with the metadata field.
4. On a subsequent chat query, the gateway calls `build_context` with `show_uploader_in_context` from runtime config.
5. The sidecar includes `uploaded by <username>` in the suffix when the flag is on and the field is present.
6. In the dashboard docs table, the "Uploaded by" column reads the stored metadata field.
