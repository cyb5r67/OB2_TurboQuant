# Domain Management GUI — Design Spec

**Date:** 2026-04-22
**Status:** Approved

## Overview

Add full domain management to the OB2 dashboard Domains tab. Currently domains are read-only in the GUI (list + delete + aliases). This spec adds: create domain, browse and delete individual docs, inline alias management, per-domain user visibility, and domain descriptions — all surfaced through a tabbed modal consistent with the existing Edit User flow.

---

## Scope

Five features, all delivered together:

| Feature | Where |
|---|---|
| Create domain (name + description) | New "+ Create Domain" modal |
| Browse & delete individual docs | Manage modal → Docs tab |
| Domain description / metadata | Manage modal → Settings tab; description column in table |
| Inline alias management | Manage modal → Aliases tab (replaces the separate section below the table) |
| See which users have access | Manage modal → Users tab |

---

## UI Changes

### Domains Table (enhanced)

- Add **"+ Create Domain"** button in the table header (right-aligned).
- Add **Description** column between Domain and Docs. Shows description text if set, otherwise muted "no description".
- Rename existing **"Aliases"** button to **"Manage"** — opens the Manage modal.
- **Delete** button removed from the table row. Deletion moves to the Settings tab inside the modal (keeps the table cleaner and adds a natural confirmation step).

### Create Domain Modal

Opened via "+ Create Domain" button.

Fields:
- **Domain name** — text input with `@` prefix label. Validated: lowercase letters, numbers, hyphens only. Required.
- **Description** — text input. Optional.

On submit: `POST /admin/domains` with `{domain, description}`. On success: close modal, reload domains table, show success toast.

Validation errors shown inline below the domain name field.

### Manage Domain Modal

Opened via the **Manage** button on any domain row. Header shows `@domainname · N docs · description`.

Four tabs: **Docs**, **Aliases**, **Users**, **Settings**.

#### Docs Tab

- Search input at the top — client-side filter on visible text.
- Table: truncated document text (first ~120 chars), date added, **Delete** button per row.
- Delete triggers a confirmation step (inline row highlight + confirm/cancel buttons — no nested modal).
- Calls `DELETE /admin/domains/:domain/docs/:id` on confirm.
- Reload doc list after deletion; update doc count in table row.

#### Aliases Tab

Moves the existing alias manager (currently rendered below the domains table) into this tab. No functional changes — same form (domain pre-selected), same alias list table, same API calls.

#### Users Tab

Read-only list of users with access to this domain. Derived from the existing `GET /admin/users` response — filter to users whose `domains` map includes this domain, plus all global admins.

Columns: Username, Permission (badge: read / write / admin / global admin).

Footer note: "To change permissions, edit the user from the Users tab."

No new API endpoint required — data already available.

#### Settings Tab

- **Description** field — pre-filled, editable text input. Save button calls `PATCH /admin/domains/:domain` with `{description}`.
- Horizontal rule separator.
- **Danger zone** — "Delete this domain…" button. Opens existing delete confirmation modal. On confirm: calls `DELETE /admin/domains/:domain`, closes manage modal, reloads table.

---

## Backend Changes

### New: `POST /admin/domains`

**Auth:** global admin only.

**Body:** `{ domain: string, description?: string }`

**Behavior:** Validates domain name (regex: `^[a-z0-9-]+$`, max 64 chars). Calls `capture_knowledge` sidecar command with a system-tagged seed document:

```json
{
  "domain": "<domain>",
  "text": "<description or empty string>",
  "metadata": { "_ob2_system": true, "_ob2_type": "domain_init", "description": "<description>" }
}
```

This establishes the domain in both SQLite and pgvector without requiring schema changes. The seed doc is filterable by `_ob2_system: true` metadata so the Docs tab can exclude it from the browsable list.

**Returns:** `{ ok: true, domain }` or `{ error }`.

### New: `GET /admin/domains/:domain/docs`

**Auth:** read permission on domain.

**Query params:** `limit` (default 100), `offset` (default 0).

**Behavior:** Calls a new sidecar command `list_docs` with `{ domain, limit, offset }`. The sidecar queries SQLite and returns docs for the domain, excluding entries where `metadata->>'_ob2_system' = 'true'`, ordered by `created_at DESC`.

New sidecar command (`retrieval/sidecar.py`):
```python
# list_docs: returns paginated docs for a domain, excluding system docs
def handle_list_docs(domain, limit=100, offset=0):
    rows = db.execute(
        "SELECT doc_id, text, created_at, metadata FROM docs "
        "WHERE domain=? AND json_extract(metadata,'$._ob2_system') IS NULL "
        "ORDER BY created_at DESC LIMIT ? OFFSET ?",
        [domain, limit, offset]
    )
    total = db.execute(
        "SELECT COUNT(*) FROM docs WHERE domain=? AND json_extract(metadata,'$._ob2_system') IS NULL",
        [domain]
    ).fetchone()[0]
    return {"docs": [...], "total": total}
```

**Returns:**
```json
{
  "docs": [
    { "doc_id": "...", "text": "...", "created_at": "...", "metadata": {} }
  ],
  "total": 42
}
```

### New: `PATCH /admin/domains/:domain`

**Auth:** admin permission on domain or global admin.

**Body:** `{ description: string }`

**Behavior:** Calls a new sidecar command `set_domain_description` with `{ domain, description }`. The sidecar finds the seed doc (`_ob2_system: true, _ob2_type: "domain_init"`) via SQLite, updates its `metadata` JSON in-place, and re-syncs it to pgvector by clearing `synced_at`. If no seed doc exists (domain pre-dates this feature), creates one via `capture_knowledge` with the system metadata tags.

**Returns:** `{ ok: true }`.

### Modified: `GET /admin/domains`

Add `description` field to each domain entry in the response, derived from the seed doc's metadata if present. Empty string if not set.

---

## Description Storage

Descriptions are stored as metadata on a hidden seed document in the existing `docs` table — no schema changes needed. The seed doc is identified by `metadata->>'_ob2_system' = 'true'` and `metadata->>'_ob2_type' = 'domain_init'`. Only one seed doc per domain. The `GET /admin/domains/:domain/docs` endpoint excludes seed docs from results.

---

## Removed

- The standalone **Aliases** section below the domains table (HTML + JS) is removed. Alias management moves entirely into the Manage modal Aliases tab.

---

## Error Handling

- Domain name already exists on `POST /admin/domains`: return 409, show inline error.
- Domain name invalid format: validate client-side before submit, also validated server-side.
- Doc list empty: show muted "No documents in this domain." message.
- Users tab: if `/admin/users` fails, show muted "Could not load users." — non-fatal.
- All destructive actions (doc delete, domain delete) require explicit confirmation before API call.

---

## Files Changed

| File | Change |
|---|---|
| `server/routes/admin.ts` | Add `POST /admin/domains`, `GET /admin/domains/:domain/docs`, `PATCH /admin/domains/:domain`; modify `GET /admin/domains` to include `description` field |
| `server/static/dashboard.js` | Add `createDomain`, `openManageDomain`, `loadDomainDocs`, `deleteDomainDoc`, `saveDomainDescription` functions; add new `data-action` cases; remove standalone alias section wiring |
| `server/static/dashboard.html` | Add "+ Create Domain" button; add description column; remove standalone aliases section |
| `retrieval/sidecar.py` | Add `list_docs` and `set_domain_description` sidecar commands |
