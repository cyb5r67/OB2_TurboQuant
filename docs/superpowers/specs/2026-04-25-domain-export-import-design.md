# Domain Export / Import Design

**Status:** approved 2026-04-25
**Author:** Claude (Opus 4.7) for usfarm73@gmail.com
**Goal:** Let an admin back up a domain to a single portable file, then restore it (or move it to another OB2 instance) without losing docs, embeddings, aliases, or original uploaded files.

## Motivation

Today the only way to clean up a finished project's domain is `DELETE /admin/domains/:domain`, which is irreversible. Operators want to archive `@john-ob2-prod` after the project ships and possibly restore it months later for reference. They also want a portable artefact that can be moved between OB2 deployments.

A SQL dump won't do — pgvector and sqlite_vec have different schemas, and operators don't necessarily have shell access to the underlying database. The platform already abstracts both behind a `StorageBackend`, so a JSON-shaped bundle that round-trips through that abstraction is both simpler for the user and decoupled from schema drift.

## Bundle format: `.ob2bundle` (gzip-compressed tar)

Filename convention: `<domain>-YYYYMMDD-HHMM.ob2bundle`

```
manifest.json     bundle metadata (version, embedding model, doc/file/alias counts, exported_at)
domain.json       description + alias list
documents.jsonl   one row per doc: doc_id, text, tags, source, created_at, metadata, embedding (b64 float32)
files/<file_id>.<ext>   original uploaded artefacts (PDFs, images, audio, etc.)
```

### `manifest.json` shape

```json
{
  "format": "ob2-domain-bundle",
  "version": 1,
  "domain": "john-ob2-prod",
  "embedding_model": "all-MiniLM-L6-v2",
  "embedding_dim": 384,
  "exported_at": "2026-04-25T15:42:00Z",
  "doc_count": 117,
  "alias_count": 4,
  "file_count": 9,
  "ob2_version": "<git short sha or build tag>"
}
```

### `documents.jsonl` row shape

```json
{
  "doc_id": "...",
  "text": "...",
  "tags": ["..."],
  "source": "user|import|...",
  "created_at": "2026-04-19T...Z",
  "metadata": {...},
  "embedding_b64": "<base64-encoded float32[D]>"
}
```

Embeddings are packed as raw little-endian float32 then base64. The dimension is implied by `manifest.embedding_dim`.

System docs (those with `metadata._ob2_system == true`) are excluded from `documents.jsonl` because they're regenerated on `create_domain`. The seed doc on the importing side gets re-created with the description from `domain.json`.

## API

### Export

```
GET /admin/domains/:domain/export
  → 200 application/octet-stream
    Content-Disposition: attachment; filename="<domain>-<ts>.ob2bundle"
```

Streams the gzip-tar to the response. Admin permission on the domain required. The Deno handler streams JSON-RPC chunks from the sidecar into the HTTP body — never holds the full bundle in memory.

### Import

```
POST /admin/domains/import
  multipart/form-data:
    bundle: <file>
    target_domain: <optional override>   # default: read from manifest
```

Returns `201` with `{domain, doc_count, alias_count, file_count}` on success.
Returns `409 conflict` if the target domain already exists.
Returns `400 bundle_invalid` for malformed bundles, version mismatches, or embedding-model mismatches.

Global-admin permission required (creating arbitrary domains is an admin-only action).

## Conflict + version handling

| Condition | Behaviour |
|---|---|
| Target domain already exists | Refuse with 409. Operator must clear it first or supply `target_domain=` to a fresh name. |
| `manifest.version` unknown | Refuse with 400 + `unsupported_bundle_version`. |
| `manifest.embedding_model` mismatches local model | Refuse with 400 + `embedding_model_mismatch`. Re-embedding on import is a separate, larger feature. |
| `manifest.embedding_dim` mismatches local dim | Refuse with 400 + `embedding_dim_mismatch`. |
| Tarball missing required files | Refuse with 400 + `bundle_invalid`. |

## UI

- **Manage → Settings tab** — new "Backup" section above Danger zone with two buttons:
  - **Export domain** → triggers download of `<domain>-<ts>.ob2bundle`.
  - (`Delete @domain…` button stays where it is.)
- **Domains page header** — new **Import domain…** button next to the existing "+ New domain" button. Opens a modal with a file picker and an optional target-domain override input. Shows the manifest preview (doc/alias/file counts, source domain, export time, embedding model) before confirming. Visible only to global admins.

## Implementation notes

### Sidecar (`retrieval/sidecar.py`)

Two new JSON-RPC methods. Because the bundle is binary and JSON-RPC is line-delimited JSON, the bytes are exchanged via the host filesystem (sidecar writes to or reads from a temp path provided by the Deno layer). This avoids base64-bloating multi-MB bundles through a JSON pipe.

```python
def method_export_domain(params):
    """Write a .ob2bundle to params['out_path']. Returns counts + bytes_written."""

def method_import_domain(params):
    """Read params['in_path']; restore. Optional 'target_domain' override.
    Returns {domain, doc_count, alias_count, file_count}."""
```

Implementation pattern: `tarfile.open(out_path, "w:gz")` for export, `tarfile.open(in_path, "r:gz")` for import. Stream documents through `_backend.list_docs` (page by page) and `_backend.upsert_docs_batch` for restore.

Files live at `/data/imports/<domain>/<file_id>.<ext>` on the server side. Export walks that directory; import recreates it.

### Server (`server/routes/admin.ts`)

```
GET /admin/domains/:domain/export
  → spool sidecar's tarball into a /tmp/<uuid>.ob2bundle
  → stream that file back as the HTTP response
  → unlink the temp file in `finally`

POST /admin/domains/import
  → multipart parse → save bundle to /tmp/<uuid>.ob2bundle
  → call sidecar import_domain
  → unlink the temp file in `finally`
```

Both endpoints set `Cache-Control: no-store`. The export endpoint uses `Content-Disposition: attachment; filename="..."` so the browser downloads rather than renders.

### Dashboard (`server/static/dashboard.js`)

- `exportCurrentDomain()` — `window.location.href = '/admin/domains/<x>/export'` after attaching the session bearer (existing `api()` helper handles cookie-based session auth).
- `openImportDomainModal()` — file picker + optional rename input + preview after upload of manifest only (a HEAD-of-bundle peek isn't worth the extra endpoint; just show the spinner and let the server reject early if invalid).

## Testing

E2E round-trip in `tests/e2e.sh`:

1. Create `@export-test` with description.
2. Capture three text docs and one alias.
3. Upload a small PDF via the import endpoint (uses MarkItDown path → file persisted under `/data/imports/`).
4. `GET /admin/domains/export-test/export` → save bundle to `/tmp/export-test.ob2bundle`. Assert non-empty response + correct `Content-Disposition`.
5. `DELETE /admin/domains/export-test` to wipe.
6. `POST /admin/domains/import` with the bundle → expect 201 + counts.
7. List docs → expect three. List aliases → expect one. Download the original PDF via signed URL → expect bytes match what was uploaded.
8. Negative: try to import the same bundle again → expect 409.
9. Negative: corrupt one byte in `manifest.json` inside the tarball → import → expect 400.

Existing patterns in `tests/e2e.sh` (curl + jq) suffice; no new test framework needed.

## Out of scope (future work)

- **Re-embedding on import.** When the local model differs, importer would re-run sentence-transformers on every doc. Needs progress reporting, batched embedding, and a flag in the import call. Track separately if the use case ever materialises.
- **Merge mode.** Importing into an existing domain (de-duplicating by content hash) is conceptually fine but multiplies the failure modes. Ship "must be empty" first.
- **Encryption / signed bundles.** Exports today are plain tarballs. If operators ship them through untrusted channels, add detached signatures or symmetric encryption with a passphrase prompt.
