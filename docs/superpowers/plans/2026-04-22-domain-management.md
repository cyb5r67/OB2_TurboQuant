# Domain Management GUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add full domain management to the OB2 dashboard — create domains, browse/delete individual docs, manage aliases inline, view per-domain users, and edit domain descriptions — all via tabbed modals consistent with the existing UI.

**Architecture:** Two new sidecar RPC commands (`create_domain`, `list_docs`, `set_domain_description`) expose domain metadata via a deterministic seed doc stored in the existing `docs` table with `_ob2_system: true` metadata. Three new admin API routes (`POST /admin/domains`, `GET /admin/domains/:domain/docs`, `PATCH /admin/domains/:domain`) connect the sidecar to the frontend. The dashboard Domains tab gains a Create modal and a tabbed Manage modal (Docs / Aliases / Users / Settings); the standalone Aliases section below the table is removed.

**Tech Stack:** Python (sidecar), Deno/TypeScript + Hono (admin API), Vanilla JS + HTML (dashboard). No schema changes. Docker restart required after sidecar/server changes.

---

## File Map

| File | Change |
|---|---|
| `retrieval/sidecar.py` | Add `method_create_domain`, `method_list_docs`, `method_set_domain_description`, `_get_domain_description`; update `method_knowledge_stats` |
| `server/routes/admin.ts` | Add `POST /domains`, `GET /domains/:domain/docs`, `PATCH /domains/:domain`; `GET /domains` already delegates to sidecar so picks up description automatically |
| `server/static/dashboard.html` | Remove standalone Aliases section from Domains tab |
| `server/static/dashboard.js` | Replace `LOADERS.domains`; add `openCreateDomainModal`, `submitCreateDomain`, `openManageDomain`, `switchManageTab`, `loadManageDocs`, `confirmDeleteDomainDoc`, `cancelDeleteDomainDoc`, `executeDeleteDomainDoc`, `loadManageAliases`, `addManageAlias`, `loadManageUsers`, `renderManageSettings`, `saveDomainDescription`, `deleteCurrentDomain`; update event delegation; remove old alias wiring |

---

## Task 1: Sidecar — helper + `create_domain` RPC command

**Files:**
- Modify: `retrieval/sidecar.py`

- [ ] **Step 1: Add `_get_domain_description` helper and `method_create_domain` to sidecar.py**

Add the following after the `method_delete_domain` function (around line 399):

```python
def _get_domain_description(domain: str) -> str:
    """Return description stored in the domain's seed doc, or empty string."""
    seed_doc_id = f"_ob2_domain_{domain}"
    doc = _backend.get_doc(domain, seed_doc_id)
    if doc and isinstance(doc.metadata, dict):
        return doc.metadata.get("description") or ""
    return ""


def method_create_domain(params: dict) -> dict:
    """Create a domain by upserting a hidden seed doc with system metadata.

    Uses a deterministic doc_id so calling again with the same domain is
    idempotent (it just overwrites the seed doc).
    """
    import re as _re
    domain = params["domain"]
    description = params.get("description") or ""

    if not _re.match(r'^[a-z0-9-]+$', domain) or len(domain) > 64:
        raise ValueError(f"invalid domain name: {domain!r}")

    seed_doc_id = f"_ob2_domain_{domain}"
    text = description or f"Domain: {domain}"
    vec = embed(text)

    _backend.upsert_doc(
        domain=domain,
        doc_id=seed_doc_id,
        text=text,
        embedding=vec,
        metadata={"_ob2_system": True, "_ob2_type": "domain_init", "description": description},
        source_hash="",
    )
    with _engine_lock:
        _engines.pop(domain, None)
        _hydrated_domains.discard(domain)

    return {"ok": True, "domain": domain}
```

- [ ] **Step 2: Register `create_domain` in the METHODS dict**

In the `METHODS` dict (around line 523), add:

```python
    "create_domain": method_create_domain,
```

- [ ] **Step 3: Smoke-test via JSON-RPC in the running container**

```bash
docker exec ob2-server sh -c 'echo "{\"jsonrpc\":\"2.0\",\"method\":\"create_domain\",\"params\":{\"domain\":\"plan-test\",\"description\":\"Created by plan test\"},\"id\":1}" | /app/retrieval/.venv/bin/python /app/retrieval/sidecar.py'
```

Expected: line starting with `{"jsonrpc":"2.0","id":1,"result":{"ok":true,"domain":"plan-test"}}`

- [ ] **Step 4: Commit**

```bash
git add retrieval/sidecar.py
git commit -m "feat(sidecar): add create_domain RPC command + _get_domain_description helper"
```

---

## Task 2: Sidecar — `list_docs` RPC command

**Files:**
- Modify: `retrieval/sidecar.py`

- [ ] **Step 1: Add `method_list_docs` after `method_create_domain`**

```python
def method_list_docs(params: dict) -> dict:
    """List user docs in a domain (excludes system seed docs), newest first.

    Fetches up to 10 000 docs from the backend and filters _ob2_system entries
    in Python — fine for admin UI use where domains rarely exceed hundreds of docs.
    """
    domain = params["domain"]
    limit = int(params.get("limit", 100))
    offset = int(params.get("offset", 0))

    all_docs = _backend.list_docs(domain, limit=10_000)
    user_docs = [
        d for d in all_docs
        if not (isinstance(d.metadata, dict) and d.metadata.get("_ob2_system"))
    ]
    page = user_docs[offset:offset + limit]

    return {
        "docs": [
            {"doc_id": d.doc_id, "text": d.text, "metadata": d.metadata}
            for d in page
        ],
        "total": len(user_docs),
    }
```

- [ ] **Step 2: Register in METHODS**

```python
    "list_docs": method_list_docs,
```

- [ ] **Step 3: Smoke-test**

```bash
docker exec ob2-server sh -c 'echo "{\"jsonrpc\":\"2.0\",\"method\":\"list_docs\",\"params\":{\"domain\":\"test\"},\"id\":1}" | /app/retrieval/.venv/bin/python /app/retrieval/sidecar.py'
```

Expected: JSON with `"docs":[...]` and `"total":N` where system seed docs are absent.

- [ ] **Step 4: Commit**

```bash
git add retrieval/sidecar.py
git commit -m "feat(sidecar): add list_docs RPC command"
```

---

## Task 3: Sidecar — `set_domain_description` RPC command

**Files:**
- Modify: `retrieval/sidecar.py`

- [ ] **Step 1: Add `method_set_domain_description` after `method_list_docs`**

```python
def method_set_domain_description(params: dict) -> dict:
    """Update (or create) the description stored in a domain's seed doc."""
    domain = params["domain"]
    description = params.get("description") or ""

    seed_doc_id = f"_ob2_domain_{domain}"
    text = description or f"Domain: {domain}"
    vec = embed(text)

    _backend.upsert_doc(
        domain=domain,
        doc_id=seed_doc_id,
        text=text,
        embedding=vec,
        metadata={"_ob2_system": True, "_ob2_type": "domain_init", "description": description},
        source_hash="",
    )
    return {"ok": True, "domain": domain, "description": description}
```

- [ ] **Step 2: Register in METHODS**

```python
    "set_domain_description": method_set_domain_description,
```

- [ ] **Step 3: Smoke-test**

```bash
docker exec ob2-server sh -c 'echo "{\"jsonrpc\":\"2.0\",\"method\":\"set_domain_description\",\"params\":{\"domain\":\"test\",\"description\":\"Testing OB2 platform\"},\"id\":1}" | /app/retrieval/.venv/bin/python /app/retrieval/sidecar.py'
```

Expected: `{"jsonrpc":"2.0","id":1,"result":{"ok":true,"domain":"test","description":"Testing OB2 platform"}}`

- [ ] **Step 4: Commit**

```bash
git add retrieval/sidecar.py
git commit -m "feat(sidecar): add set_domain_description RPC command"
```

---

## Task 4: Sidecar — update `method_knowledge_stats` to include description and correct doc_count

**Files:**
- Modify: `retrieval/sidecar.py`

- [ ] **Step 1: Replace `method_knowledge_stats` with the updated version**

Find the existing `method_knowledge_stats` function and replace it entirely:

```python
def method_knowledge_stats(params: dict) -> dict:
    domain = params.get("domain")
    if domain is None:
        domains = _backend.list_domains()
        result = []
        for d in domains:
            stats = _backend.domain_stats(d)
            has_seed = _backend.get_doc(d, f"_ob2_domain_{d}") is not None
            result.append({
                "domain": d,
                "doc_count": max(0, stats.doc_count - (1 if has_seed else 0)),
                "description": _get_domain_description(d),
            })
        return {"domains": result}
    stats = _backend.domain_stats(domain)
    has_seed = _backend.get_doc(domain, f"_ob2_domain_{domain}") is not None
    return {
        "domain": domain,
        "doc_count": max(0, stats.doc_count - (1 if has_seed else 0)),
        "total_bytes": stats.total_bytes,
        "oldest_at": stats.oldest_at,
        "newest_at": stats.newest_at,
        "exists": stats.doc_count > 0,
        "description": _get_domain_description(domain),
    }
```

- [ ] **Step 2: Verify existing domains still list correctly**

```bash
curl -s -X POST http://localhost:7600/admin/domains \
  -H "Authorization: Bearer ob2_0be9cd14b1194ad6ee3adedfb4007edf" \
  -H "Content-Type: application/json" | python3 -m json.tool
```

Wait — this tests the admin HTTP route, which requires the server to have restarted with the new sidecar. We'll test this properly in Task 5 after rebuilding. For now just confirm the sidecar method runs:

```bash
docker exec ob2-server sh -c 'echo "{\"jsonrpc\":\"2.0\",\"method\":\"knowledge_stats\",\"params\":{},\"id\":1}" | /app/retrieval/.venv/bin/python /app/retrieval/sidecar.py 2>/dev/null'
```

Expected: JSON with `"domains":[...]` where each entry has a `"description"` field.

- [ ] **Step 3: Commit**

```bash
git add retrieval/sidecar.py
git commit -m "feat(sidecar): include description in knowledge_stats, subtract seed doc from doc_count"
```

---

## Task 5: Admin API — `POST /admin/domains` (create domain)

**Files:**
- Modify: `server/routes/admin.ts`

- [ ] **Step 1: Add the route**

In `server/routes/admin.ts`, add the following route **before** the existing `GET /domains/:domain/stats` route (after the comment block at the top of `adminRoutes`):

```typescript
  // POST /admin/domains — create a new domain (global admin only)
  app.post("/domains", async (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    let body: { domain?: string; description?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const domain = (body.domain || "").trim().toLowerCase();
    if (!domain) return c.json({ error: "domain required" }, 400);
    if (!/^[a-z0-9-]+$/.test(domain) || domain.length > 64) {
      return c.json({
        error: "domain must be lowercase letters, numbers, and hyphens only (max 64 chars)",
      }, 400);
    }
    try {
      // Reject if domain already has user docs
      const stats = await sidecar.call<DomainStatsResult>("knowledge_stats", { domain });
      if (stats.exists) {
        return c.json({ error: `domain @${domain} already exists` }, 409);
      }
      await sidecar.call("create_domain", { domain, description: body.description || "" });
      return c.json({ ok: true, domain }, 201);
    } catch (err) {
      return c.json({ error: safeError(err, "internal server error") }, 500);
    }
  });
```

- [ ] **Step 2: Rebuild and restart the stack**

```bash
docker compose -f docker/docker-compose.yml build ob2-server && \
docker compose -f docker/docker-compose.yml up -d
```

Wait ~15s for the server health check to pass:

```bash
docker compose -f docker/docker-compose.yml ps
```

Expected: `ob2-server` status shows `(healthy)`.

- [ ] **Step 3: Test create domain**

```bash
curl -s -X POST http://localhost:7600/admin/domains \
  -H "Authorization: Bearer ob2_0be9cd14b1194ad6ee3adedfb4007edf" \
  -H "Content-Type: application/json" \
  -d '{"domain":"newdomain","description":"Created via API test"}' | python3 -m json.tool
```

Expected:
```json
{
  "ok": true,
  "domain": "newdomain"
}
```

- [ ] **Step 4: Test duplicate rejection**

```bash
curl -s -X POST http://localhost:7600/admin/domains \
  -H "Authorization: Bearer ob2_0be9cd14b1194ad6ee3adedfb4007edf" \
  -H "Content-Type: application/json" \
  -d '{"domain":"test"}' | python3 -m json.tool
```

Expected: `{"error": "domain @test already exists"}` with HTTP 409.

- [ ] **Step 5: Test invalid name**

```bash
curl -s -X POST http://localhost:7600/admin/domains \
  -H "Authorization: Bearer ob2_0be9cd14b1194ad6ee3adedfb4007edf" \
  -H "Content-Type: application/json" \
  -d '{"domain":"My Domain!"}' | python3 -m json.tool
```

Expected: `{"error": "domain must be lowercase letters..."}` with HTTP 400.

- [ ] **Step 6: Commit**

```bash
git add server/routes/admin.ts
git commit -m "feat(api): POST /admin/domains — create domain endpoint"
```

---

## Task 6: Admin API — `GET /admin/domains/:domain/docs`

**Files:**
- Modify: `server/routes/admin.ts`

- [ ] **Step 1: Add the route**

Add after the existing `GET /domains/:domain/aliases` route in `admin.ts`:

```typescript
  // GET /admin/domains/:domain/docs — list user docs (excludes system docs)
  app.get("/domains/:domain/docs", async (c) => {
    const domain = c.req.param("domain");
    const denied = requirePerm(c, domain, "read");
    if (denied) return denied;
    const limit = Math.min(200, Number(c.req.query("limit") || "100"));
    const offset = Number(c.req.query("offset") || "0");
    try {
      const r = await sidecar.call<{
        docs: Array<{ doc_id: string; text: string; metadata: Record<string, unknown> }>;
        total: number;
      }>("list_docs", { domain, limit, offset });
      return c.json(r);
    } catch (err) {
      return c.json({ error: safeError(err, "internal server error") }, 500);
    }
  });
```

- [ ] **Step 2: Rebuild and restart**

```bash
docker compose -f docker/docker-compose.yml build ob2-server && \
docker compose -f docker/docker-compose.yml up -d && \
sleep 20 && docker compose -f docker/docker-compose.yml ps
```

- [ ] **Step 3: Test**

```bash
curl -s "http://localhost:7600/admin/domains/test/docs" \
  -H "Authorization: Bearer ob2_0be9cd14b1194ad6ee3adedfb4007edf" | python3 -m json.tool
```

Expected: `{"docs":[{"doc_id":"...","text":"...","metadata":{...}},...], "total": N}` — seed docs (`_ob2_system: true`) must NOT appear in the list.

- [ ] **Step 4: Commit**

```bash
git add server/routes/admin.ts
git commit -m "feat(api): GET /admin/domains/:domain/docs — list docs endpoint"
```

---

## Task 7: Admin API — `PATCH /admin/domains/:domain` (update description)

**Files:**
- Modify: `server/routes/admin.ts`

- [ ] **Step 1: Add the route**

Add after the existing `DELETE /domains/:domain` route:

```typescript
  // PATCH /admin/domains/:domain — update domain description
  app.patch("/domains/:domain", async (c) => {
    const domain = c.req.param("domain");
    const denied = requirePerm(c, domain, "admin");
    if (denied) return denied;
    let body: { description?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const description = typeof body.description === "string" ? body.description : "";
    try {
      await sidecar.call("set_domain_description", { domain, description });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: safeError(err, "internal server error") }, 500);
    }
  });
```

- [ ] **Step 2: Rebuild and restart**

```bash
docker compose -f docker/docker-compose.yml build ob2-server && \
docker compose -f docker/docker-compose.yml up -d && \
sleep 20 && docker compose -f docker/docker-compose.yml ps
```

- [ ] **Step 3: Test PATCH**

```bash
curl -s -X PATCH http://localhost:7600/admin/domains/test \
  -H "Authorization: Bearer ob2_0be9cd14b1194ad6ee3adedfb4007edf" \
  -H "Content-Type: application/json" \
  -d '{"description":"OB2 platform test domain"}' | python3 -m json.tool
```

Expected: `{"ok": true}`

- [ ] **Step 4: Verify description appears in domains list**

```bash
curl -s http://localhost:7600/admin/domains \
  -H "Authorization: Bearer ob2_0be9cd14b1194ad6ee3adedfb4007edf" | python3 -m json.tool
```

Expected: `"domains":[...]` where the `test` entry has `"description":"OB2 platform test domain"`.

- [ ] **Step 5: Commit**

```bash
git add server/routes/admin.ts
git commit -m "feat(api): PATCH /admin/domains/:domain — update description endpoint"
```

---

## Task 8: Dashboard HTML — remove standalone Aliases section

**Files:**
- Modify: `server/static/dashboard.html`

- [ ] **Step 1: Replace the Domains tab section**

Find this block in `dashboard.html` (around line 159–172):

```html
  <!-- ========== DOMAINS ========== -->
  <section id="tab-domains" class="tab">
    <h2>Domains</h2>
    <div id="domains-container"></div>

    <h2 style="margin-top: 1.5rem">Aliases</h2>
    <div class="form-row">
      <select id="alias-domain"><option value="">Select domain...</option></select>
      <input id="alias-name" placeholder="Alias" style="width:140px">
      <input id="alias-canonical" placeholder="Canonical" style="width:180px">
      <button data-action="add-alias">Add alias</button>
    </div>
    <div id="aliases-container" style="margin-top: 0.75rem"></div>
  </section>
```

Replace with:

```html
  <!-- ========== DOMAINS ========== -->
  <section id="tab-domains" class="tab">
    <h2>Domains</h2>
    <div id="domains-container"></div>
  </section>
```

- [ ] **Step 2: Commit**

```bash
git add server/static/dashboard.html
git commit -m "feat(dashboard): remove standalone aliases section from domains tab"
```

---

## Task 9: Dashboard JS — replace `LOADERS.domains`

**Files:**
- Modify: `server/static/dashboard.js`

- [ ] **Step 1: Replace the existing `LOADERS.domains` function**

Find the existing `LOADERS.domains = async () => { ... };` block (lines 323–348) and replace it entirely:

```javascript
LOADERS.domains = async () => {
  try {
    const d = await api('/admin/domains');
    const domains = d.domains || [];

    const headerHtml = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem">
      <span style="color:var(--muted);font-size:0.85rem">${domains.length} domain${domains.length !== 1 ? 's' : ''}</span>
      <button class="small" data-action="open-create-domain">+ Create Domain</button>
    </div>`;

    if (!domains.length) {
      document.getElementById('domains-container').innerHTML =
        headerHtml + '<div class="card" style="color:var(--muted)">No domains yet. Click <strong>+ Create Domain</strong> or use <code>capture_knowledge</code>.</div>';
      return;
    }

    let html = headerHtml + '<table><tr><th>Domain</th><th>Description</th><th>Docs</th><th>Actions</th></tr>';
    for (const dom of domains) {
      const desc = dom.description
        ? `<span style="color:var(--muted);font-size:0.85rem">${escapeHtml(dom.description)}</span>`
        : `<span style="color:var(--muted);font-size:0.78rem;font-style:italic">no description</span>`;
      html += `<tr>
        <td class="mono">@${escapeHtml(dom.domain)}</td>
        <td>${desc}</td>
        <td>${dom.doc_count}</td>
        <td>
          <button class="small secondary"
            data-action="open-manage-domain"
            data-domain="${escapeAttr(dom.domain)}"
            data-doc-count="${dom.doc_count}"
            data-description="${escapeAttr(dom.description || '')}">Manage</button>
        </td>
      </tr>`;
    }
    html += '</table>';
    document.getElementById('domains-container').innerHTML = html;
  } catch (e) { showError(e); }
};
```

- [ ] **Step 2: Remove now-dead functions**

Delete the following functions entirely from `dashboard.js` (they referenced the standalone alias section):
- `loadAliases(domain)` (lines 350–362)
- `addAlias()` (lines 364–376)

- [ ] **Step 3: Verify the page loads without errors**

Rebuild and restart the stack:
```bash
docker compose -f docker/docker-compose.yml build ob2-server && \
docker compose -f docker/docker-compose.yml up -d
```

Open http://localhost:7600/dashboard in a browser, log in as admin, navigate to the Domains tab. Expected: description column visible, "+ Create Domain" button in the header, Manage button per row, no Aliases section below the table.

- [ ] **Step 4: Commit**

```bash
git add server/static/dashboard.js
git commit -m "feat(dashboard): update LOADERS.domains — description column, Manage button, Create button"
```

---

## Task 10: Dashboard JS — Create Domain modal

**Files:**
- Modify: `server/static/dashboard.js`

- [ ] **Step 1: Add `openCreateDomainModal` and `submitCreateDomain` after `LOADERS.domains`**

```javascript
function openCreateDomainModal() {
  openModal(`
    <h3>Create Domain</h3>
    <div style="margin-bottom:0.5rem">
      <label style="font-size:0.85rem;color:var(--muted);display:block;margin-bottom:0.3rem">Domain name</label>
      <div style="display:flex;align-items:center;gap:0.25rem">
        <span style="color:var(--muted);font-family:'JetBrains Mono',ui-monospace,monospace">@</span>
        <input id="create-domain-name" type="text" placeholder="e.g. infra, security, hr"
               autocomplete="off" autocapitalize="none" spellcheck="false" style="flex:1">
      </div>
      <div id="create-domain-name-error" style="color:var(--red);font-size:0.8rem;margin-top:0.2rem;display:none"></div>
      <div style="color:var(--muted);font-size:0.75rem;margin-top:0.2rem">lowercase letters, numbers, and hyphens only</div>
    </div>
    <div style="margin-bottom:0.75rem">
      <label style="font-size:0.85rem;color:var(--muted);display:block;margin-bottom:0.3rem">Description <span style="color:var(--muted)">(optional)</span></label>
      <input id="create-domain-desc" type="text" placeholder="What is this domain for?" style="width:100%">
    </div>
    <div class="modal-actions">
      <button class="secondary" data-action="close-modal">Cancel</button>
      <button data-action="submit-create-domain">Create</button>
    </div>
  `);
  document.getElementById('create-domain-name').focus();
}

async function submitCreateDomain() {
  const name = document.getElementById('create-domain-name').value.trim().toLowerCase();
  const desc = document.getElementById('create-domain-desc').value.trim();
  const errEl = document.getElementById('create-domain-name-error');
  errEl.style.display = 'none';

  if (!name) {
    errEl.textContent = 'Domain name is required.';
    errEl.style.display = 'block';
    return;
  }
  if (!/^[a-z0-9-]+$/.test(name) || name.length > 64) {
    errEl.textContent = 'Use lowercase letters, numbers, and hyphens only (max 64 chars).';
    errEl.style.display = 'block';
    return;
  }
  try {
    await api('/admin/domains', { method: 'POST', body: JSON.stringify({ domain: name, description: desc }) });
    closeModal();
    showSuccess(`@${name} created`);
    LOADERS.domains();
  } catch (e) {
    errEl.textContent = e.message || 'Failed to create domain.';
    errEl.style.display = 'block';
  }
}
```

- [ ] **Step 2: Wire actions in the global event delegation switch**

In the `document.addEventListener('click', ...)` switch statement, under `// ── Domains ──`, add:

```javascript
    case 'open-create-domain': return openCreateDomainModal();
    case 'submit-create-domain': return submitCreateDomain();
```

Also remove the now-dead cases:
```javascript
    case 'add-alias': return addAlias();
    case 'load-aliases': return loadAliases(el.dataset.domain);
```

- [ ] **Step 3: Test in browser**

Rebuild:
```bash
docker compose -f docker/docker-compose.yml build ob2-server && docker compose -f docker/docker-compose.yml up -d
```

Open http://localhost:7600/dashboard → Domains tab → click "+ Create Domain". Fill in a name and description, click Create. Expected: modal closes, success toast, new domain appears in table with description.

Test validation: try submitting with empty name (should show error), try "My Domain!" (should show error), try a name that already exists (should show server error).

- [ ] **Step 4: Commit**

```bash
git add server/static/dashboard.js
git commit -m "feat(dashboard): Create Domain modal"
```

---

## Task 11: Dashboard JS — Manage Domain modal framework + Docs tab

**Files:**
- Modify: `server/static/dashboard.js`

- [ ] **Step 1: Add the modal state variable and `openManageDomain` + `switchManageTab`**

Add after `submitCreateDomain`:

```javascript
let _manageDomain = null; // { domain, docCount, description }

async function openManageDomain(domain, docCount, description) {
  _manageDomain = { domain, docCount: Number(docCount), description };
  openModal(`
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.75rem">
      <div>
        <span style="font-weight:bold;font-family:'JetBrains Mono',ui-monospace,monospace">@${escapeHtml(domain)}</span>
        <span style="color:var(--muted);font-size:0.85rem;margin-left:0.5rem" id="manage-domain-doc-count">· ${Number(docCount)} doc${Number(docCount) !== 1 ? 's' : ''}</span>
        ${description ? `<span style="color:var(--muted);font-size:0.85rem"> · ${escapeHtml(description)}</span>` : ''}
      </div>
    </div>
    <div style="display:flex;gap:0;border-bottom:1px solid var(--border);margin-bottom:0.75rem" id="manage-tabs">
      <button class="manage-tab-btn" data-action="switch-manage-tab" data-tab="docs">Docs</button>
      <button class="manage-tab-btn" data-action="switch-manage-tab" data-tab="aliases">Aliases</button>
      <button class="manage-tab-btn" data-action="switch-manage-tab" data-tab="users">Users</button>
      <button class="manage-tab-btn" data-action="switch-manage-tab" data-tab="settings">Settings</button>
    </div>
    <div id="manage-tab-content" style="min-height:120px"></div>
    <div class="modal-actions">
      <button class="secondary" data-action="close-modal">Close</button>
    </div>
  `);

  // Inject tab button styles inline (avoids needing CSS changes)
  for (const btn of document.querySelectorAll('.manage-tab-btn')) {
    Object.assign(btn.style, {
      padding: '6px 16px', border: 'none', background: 'none',
      color: 'var(--muted)', borderBottom: '2px solid transparent',
      cursor: 'pointer', fontSize: '0.85rem',
    });
  }
  switchManageTab('docs');
}

function switchManageTab(tab) {
  for (const btn of document.querySelectorAll('#manage-tabs .manage-tab-btn')) {
    const active = btn.dataset.tab === tab;
    btn.style.color = active ? 'var(--fg)' : 'var(--muted)';
    btn.style.borderBottom = active ? '2px solid var(--accent)' : '2px solid transparent';
  }
  const content = document.getElementById('manage-tab-content');
  if (!content) return;
  content.innerHTML = '<div style="color:var(--muted);font-size:0.85rem">Loading…</div>';
  if (tab === 'docs') loadManageDocs();
  else if (tab === 'aliases') loadManageAliases();
  else if (tab === 'users') loadManageUsers();
  else if (tab === 'settings') renderManageSettings();
}
```

- [ ] **Step 2: Add `loadManageDocs`, `confirmDeleteDomainDoc`, `cancelDeleteDomainDoc`, `executeDeleteDomainDoc`**

```javascript
async function loadManageDocs() {
  const { domain } = _manageDomain;
  const content = document.getElementById('manage-tab-content');
  try {
    const d = await api(`/admin/domains/${encodeURIComponent(domain)}/docs?limit=200`);
    const docs = d.docs || [];

    if (!docs.length) {
      content.innerHTML = `<div style="color:var(--muted);font-size:0.85rem">No documents in this domain.</div>`;
      return;
    }

    let html = `<input type="text" id="manage-doc-search" placeholder="Search documents…"
                  style="width:100%;box-sizing:border-box;margin-bottom:0.5rem">`;
    html += `<div id="manage-docs-list"><table style="width:100%">
      <tr><th style="text-align:left;padding:4px 6px">Document</th><th></th></tr>`;
    for (const doc of docs) {
      const preview = doc.text.slice(0, 120) + (doc.text.length > 120 ? '…' : '');
      html += `<tr data-doc-id="${escapeAttr(doc.doc_id)}">
        <td style="padding:4px 6px;max-width:360px;word-break:break-word">${escapeHtml(preview)}</td>
        <td style="padding:4px 6px;white-space:nowrap">
          <button class="small danger" data-action="confirm-delete-domain-doc"
            data-doc-id="${escapeAttr(doc.doc_id)}">Delete</button>
        </td>
      </tr>`;
    }
    html += `</table></div>`;
    content.innerHTML = html;

    document.getElementById('manage-doc-search').addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      for (const row of document.querySelectorAll('#manage-docs-list tr[data-doc-id]')) {
        const text = row.querySelector('td')?.textContent?.toLowerCase() || '';
        row.style.display = text.includes(q) ? '' : 'none';
      }
    });
  } catch (e) {
    content.innerHTML = `<div style="color:var(--red)">${escapeHtml(String(e.message || e))}</div>`;
  }
}

function confirmDeleteDomainDoc(docId) {
  const row = document.querySelector(`#manage-docs-list tr[data-doc-id="${CSS.escape(docId)}"]`);
  if (!row) return;
  row.style.background = 'rgba(239,68,68,0.08)';
  row.querySelector('td:last-child').innerHTML = `
    <button class="small secondary" data-action="cancel-delete-domain-doc"
      data-doc-id="${escapeAttr(docId)}">Cancel</button>
    <button class="small danger" data-action="execute-delete-domain-doc"
      data-doc-id="${escapeAttr(docId)}">Confirm</button>`;
}

function cancelDeleteDomainDoc(docId) {
  const row = document.querySelector(`#manage-docs-list tr[data-doc-id="${CSS.escape(docId)}"]`);
  if (!row) return;
  row.style.background = '';
  row.querySelector('td:last-child').innerHTML =
    `<button class="small danger" data-action="confirm-delete-domain-doc"
      data-doc-id="${escapeAttr(docId)}">Delete</button>`;
}

async function executeDeleteDomainDoc(docId) {
  const { domain } = _manageDomain;
  try {
    await api(`/admin/domains/${encodeURIComponent(domain)}/docs/${encodeURIComponent(docId)}`,
      { method: 'DELETE' });
    const row = document.querySelector(`#manage-docs-list tr[data-doc-id="${CSS.escape(docId)}"]`);
    if (row) row.remove();
    _manageDomain.docCount = Math.max(0, _manageDomain.docCount - 1);
    const countEl = document.getElementById('manage-domain-doc-count');
    if (countEl) {
      countEl.textContent = `· ${_manageDomain.docCount} doc${_manageDomain.docCount !== 1 ? 's' : ''}`;
    }
    LOADERS.domains();
  } catch (e) { showError(e); }
}
```

- [ ] **Step 3: Wire new actions in the event delegation switch**

Under `// ── Domains ──` in the click handler:

```javascript
    case 'open-manage-domain':
      return openManageDomain(el.dataset.domain, el.dataset.docCount, el.dataset.description);
    case 'switch-manage-tab': return switchManageTab(el.dataset.tab);
    case 'confirm-delete-domain-doc': return confirmDeleteDomainDoc(el.dataset.docId);
    case 'cancel-delete-domain-doc': return cancelDeleteDomainDoc(el.dataset.docId);
    case 'execute-delete-domain-doc': return executeDeleteDomainDoc(el.dataset.docId);
```

- [ ] **Step 4: Rebuild and test**

```bash
docker compose -f docker/docker-compose.yml build ob2-server && docker compose -f docker/docker-compose.yml up -d
```

Open http://localhost:7600/dashboard → Domains → Manage on @test. Expected: modal opens showing @test header, Docs tab active with list of documents. Type in search box — rows filter. Click Delete on a doc → row highlights with Cancel/Confirm. Click Cancel → row restores. Click Delete → Confirm → row disappears and doc count decrements.

- [ ] **Step 5: Commit**

```bash
git add server/static/dashboard.js
git commit -m "feat(dashboard): Manage Domain modal — framework + Docs tab"
```

---

## Task 12: Dashboard JS — Manage modal Aliases, Users, Settings tabs

**Files:**
- Modify: `server/static/dashboard.js`

- [ ] **Step 1: Add `loadManageAliases` and `addManageAlias`**

```javascript
async function loadManageAliases() {
  const { domain } = _manageDomain;
  const content = document.getElementById('manage-tab-content');
  try {
    const d = await api(`/admin/domains/${encodeURIComponent(domain)}/aliases`);
    const aliases = d.aliases || [];

    let html = `<div class="form-row" style="margin-bottom:0.75rem">
      <input id="manage-alias-name" placeholder="Alias" style="width:120px" autocomplete="off">
      <input id="manage-alias-canonical" placeholder="Canonical" style="width:160px" autocomplete="off">
      <button class="small" data-action="add-manage-alias">Add alias</button>
    </div>`;

    if (!aliases.length) {
      html += `<div id="manage-aliases-list" style="color:var(--muted);font-size:0.85rem">No aliases for @${escapeHtml(domain)}.</div>`;
    } else {
      html += `<div id="manage-aliases-list"><table style="width:100%">
        <tr><th style="text-align:left;padding:4px 6px">Alias</th><th style="text-align:left;padding:4px 6px">Canonical</th></tr>`;
      for (const a of aliases) {
        html += `<tr>
          <td class="mono" style="padding:4px 6px">${escapeHtml(a.alias)}</td>
          <td class="mono" style="padding:4px 6px">${escapeHtml(a.canonical)}</td>
        </tr>`;
      }
      html += `</table></div>`;
    }
    content.innerHTML = html;
  } catch (e) {
    content.innerHTML = `<div style="color:var(--red)">${escapeHtml(String(e.message || e))}</div>`;
  }
}

async function addManageAlias() {
  const { domain } = _manageDomain;
  const alias = document.getElementById('manage-alias-name').value.trim();
  const canonical = document.getElementById('manage-alias-canonical').value.trim();
  if (!alias || !canonical) return showError('fill alias + canonical');
  try {
    await api(`/admin/domains/${encodeURIComponent(domain)}/aliases`, {
      method: 'POST',
      body: JSON.stringify({ alias, canonical }),
    });
    document.getElementById('manage-alias-name').value = '';
    document.getElementById('manage-alias-canonical').value = '';
    showSuccess('alias added');
    loadManageAliases();
  } catch (e) { showError(e); }
}
```

- [ ] **Step 2: Add `loadManageUsers`**

```javascript
async function loadManageUsers() {
  const { domain } = _manageDomain;
  const content = document.getElementById('manage-tab-content');
  try {
    const d = await api('/admin/users');
    const users = d.users || [];
    const relevant = users.filter(u =>
      u.global_admin || (u.domains && Object.prototype.hasOwnProperty.call(u.domains, domain))
    );

    if (!relevant.length) {
      content.innerHTML = `<div style="color:var(--muted);font-size:0.85rem">No users have access to @${escapeHtml(domain)}.</div>`;
      return;
    }

    const permColor = { read: 'muted', write: 'purple', admin: 'yellow' };
    let html = `<table style="width:100%">
      <tr><th style="text-align:left;padding:4px 6px">User</th><th style="text-align:left;padding:4px 6px">Permission</th></tr>`;
    for (const u of relevant) {
      const perm = u.global_admin ? 'global admin' : u.domains[domain];
      const color = u.global_admin ? 'yellow' : (permColor[perm] || 'muted');
      html += `<tr>
        <td class="mono" style="padding:4px 6px">${escapeHtml(u.username)}</td>
        <td style="padding:4px 6px">${badge(perm, color)}</td>
      </tr>`;
    }
    html += `</table>
      <div style="color:var(--muted);font-size:0.78rem;margin-top:0.5rem">
        To change permissions, edit the user from the Users tab.
      </div>`;
    content.innerHTML = html;
  } catch (e) {
    content.innerHTML = `<div style="color:var(--muted);font-size:0.85rem">Could not load users.</div>`;
  }
}
```

- [ ] **Step 3: Add `renderManageSettings`, `saveDomainDescription`, `deleteCurrentDomain`**

```javascript
function renderManageSettings() {
  const { domain, description } = _manageDomain;
  const content = document.getElementById('manage-tab-content');
  content.innerHTML = `
    <div style="margin-bottom:0.5rem">
      <label style="font-size:0.85rem;color:var(--muted);display:block;margin-bottom:0.3rem">Description</label>
      <div style="display:flex;gap:0.5rem">
        <input id="manage-desc-input" type="text" value="${escapeAttr(description)}"
               placeholder="What is this domain for?" style="flex:1">
        <button class="small" data-action="save-domain-description">Save</button>
      </div>
      <div id="manage-desc-status" style="font-size:0.8rem;margin-top:0.25rem;min-height:1rem"></div>
    </div>
    <hr style="border-color:var(--border);margin:1rem 0">
    <div style="color:var(--muted);font-size:0.85rem;margin-bottom:0.5rem">Danger zone</div>
    <button class="small danger" data-action="delete-current-domain">Delete @${escapeHtml(domain)}…</button>
  `;
}

async function saveDomainDescription() {
  const { domain } = _manageDomain;
  const desc = document.getElementById('manage-desc-input').value.trim();
  const status = document.getElementById('manage-desc-status');
  status.textContent = 'Saving…';
  status.style.color = 'var(--muted)';
  try {
    await api(`/admin/domains/${encodeURIComponent(domain)}`, {
      method: 'PATCH',
      body: JSON.stringify({ description: desc }),
    });
    _manageDomain.description = desc;
    status.textContent = '✓ Saved';
    status.style.color = 'var(--green)';
    LOADERS.domains();
  } catch (e) {
    status.textContent = String(e.message || e);
    status.style.color = 'var(--red)';
  }
}

function deleteCurrentDomain() {
  deleteDomain(_manageDomain.domain);
}
```

- [ ] **Step 4: Wire remaining actions in the event delegation switch**

Under `// ── Domains ──`:

```javascript
    case 'add-manage-alias': return addManageAlias();
    case 'save-domain-description': return saveDomainDescription();
    case 'delete-current-domain': return deleteCurrentDomain();
```

- [ ] **Step 5: Rebuild and test all tabs**

```bash
docker compose -f docker/docker-compose.yml build ob2-server && docker compose -f docker/docker-compose.yml up -d
```

Open Manage on @netsec:
- **Aliases tab**: click Aliases — alias form shows, existing aliases list. Add an alias, confirm it appears.
- **Users tab**: click Users — admin (global admin badge) and alice (read badge) visible.
- **Settings tab**: click Settings — description field pre-filled. Edit, click Save. Toast and description updates in the domain table. Click "Delete @netsec…" — delete confirmation modal opens (existing flow).

- [ ] **Step 6: Commit**

```bash
git add server/static/dashboard.js
git commit -m "feat(dashboard): Manage modal — Aliases, Users, Settings tabs"
```

---

## Task 13: Clean up test data + final verification

- [ ] **Step 1: Remove the plan-test and newdomain test domains**

```bash
curl -s -X DELETE http://localhost:7600/admin/domains/plan-test \
  -H "Authorization: Bearer ob2_0be9cd14b1194ad6ee3adedfb4007edf" | python3 -m json.tool

curl -s -X DELETE http://localhost:7600/admin/domains/newdomain \
  -H "Authorization: Bearer ob2_0be9cd14b1194ad6ee3adedfb4007edf" | python3 -m json.tool
```

- [ ] **Step 2: Confirm original 5 domains are intact**

```bash
curl -s http://localhost:7600/admin/domains \
  -H "Authorization: Bearer ob2_0be9cd14b1194ad6ee3adedfb4007edf" | python3 -m json.tool
```

Expected: `dash-test`, `docker-test`, `netsec`, `test`, `testdom` present with correct doc counts.

- [ ] **Step 3: End-to-end UI walkthrough**

1. Open http://localhost:7600/dashboard → Domains tab
2. Click **+ Create Domain** → name `e2e-test`, description `End-to-end test domain` → Create → domain appears in table
3. Click **Manage** on `@e2e-test` → Docs tab shows "No documents"
4. Open Claude Desktop → say `@e2e-test Domain management GUI is working.` (requires MCP connected)
5. Back in dashboard → Manage `@e2e-test` → Docs tab refresh → new doc appears
6. Delete the doc inline → doc count goes to 0
7. Settings tab → update description → saved
8. Settings tab → Delete domain → confirm → domain gone from table

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat: domain management GUI — create, browse docs, aliases, users, description, delete"
```
