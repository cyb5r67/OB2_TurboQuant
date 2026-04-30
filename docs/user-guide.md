# OB2 User Guide

This guide is written for people using OB2's web dashboard — not for server operators. If you need to install OB2 or configure it, start with `docs/deployment.md`.

## What OB2 Does

OB2 stores your documents and knowledge so you can ask questions about them in plain English and get accurate, cited answers. You upload files, OB2 reads them and indexes them, and you or your team can query them through a chat interface or AI coding tools like Claude Code.

Your data never leaves your server. There are no per-query costs. The AI model runs locally.

---

## Signing In

Open the OB2 dashboard in your browser (typically `http://localhost:7600/dashboard` or the URL your administrator gave you).

Enter your **username** and **password**, then click **Sign in**.

If this is a fresh installation with no users yet, you can sign in as `_admin` with the server's brain key (ask your administrator). This is a temporary bootstrap account — you'll want to create a real user account as soon as possible.

---

## The Dashboard Tabs

After signing in you'll see a row of tabs. Which tabs appear depends on your role.

| Tab | Who sees it | What it's for |
|---|---|---|
| **Overview** | Everyone | Health status, domain count, doc count |
| **Domains** | Everyone | Upload files, browse documents, paste URLs, manage your knowledge domains |
| **Users** | Admins only | Create accounts, assign permissions, send invites |
| **Services** | Admins only | Test Ollama and database connections |
| **Config** | Admins only | Edit runtime settings |
| **Processes** | Admins only | View background task stats |
| **Chat** | Everyone (when enabled) | Link to the Open WebUI chat interface |
| **Profile** | Everyone | Change your password, rotate your API key |

If you are a regular user (not an admin), you will see Overview, Domains, Chat, and Profile. The Domains tab shows only the domains you have been granted access to.

---

## Uploading a Document

1. Click the **Domains** tab.
2. Find the domain you want to add documents to (e.g., `@runbooks`).
3. Drag and drop a file onto the upload zone, or click **Browse** to select one.
4. For small files (under 25 MB), the upload processes immediately and the doc count updates when done.
5. For large files, audio, and ZIP archives, the upload queues a background job. A progress indicator shows when it finishes.

**Supported file types:** PDF (including scanned PDFs — OCR runs automatically), Word documents (DOCX), PowerPoint (PPTX), Excel (XLSX), HTML pages, Markdown, CSV, JSON, XML, images (PNG, JPEG, TIFF), audio (MP3, WAV, and others), ZIP archives containing any of the above.

**Pasting a URL:** Instead of uploading a file, you can paste a URL into the URL field and click **Import**. OB2 fetches the page or document and indexes it. Note that only public URLs work — internal network addresses are blocked for security reasons.

Once indexed, your documents show up in the doc browser inside the Domains tab. Click the document name to see its chunks, or the download icon to retrieve the original file.

---

## Asking Questions

### Through Open WebUI (chat)

If your administrator has enabled the chat surface, click the **Chat** tab. This takes you to a chat interface where you can ask questions in natural language.

Type your question and press send. OB2 searches your knowledge base for relevant content, builds the answer from what it finds, and shows you the sources it used.

Click any **source link** in the answer to download and view the original document.

### Through Claude Code or Cursor

If you have an API key (see Profile), you can configure Claude Code or Cursor to talk to OB2 directly. Ask questions like:

```
@runbooks how do I handle a SEV0 incident?
@netsec what is the certificate rotation procedure?
```

The `@domain` prefix tells OB2 to search that specific domain. Without a prefix, OB2 searches all domains you have access to and combines the results.

---

## Reading Citations

Every answer OB2 provides includes citations that identify where the information came from. A citation looks like:

```
[Source: runbooks — 2026-04-22]
```

In the chat interface, this is a clickable link. Clicking it downloads or opens the original document that the answer was drawn from.

Citations are time-limited links (valid for 24 hours). If a link has expired, sign into the dashboard and navigate to the document through the Domains tab instead.

---

## Your Profile

Click the **Profile** tab to manage your own credentials.

### Changing Your Password

1. Fill in **Current password**, **New password**, and **Confirm new password**.
2. Click **Update password**.

On success, you stay signed in with a fresh session. All your other browser sessions (other devices) are signed out for security.

If the current password is wrong, a red message appears and you stay signed in — you are not logged out.

### Rotating Your API Key

Your API key is used by machine clients like Claude Code. To rotate it:

1. Click **Rotate API key**.
2. Confirm in the dialog.
3. Copy the new key from the one-time reveal — it will not be shown again.

The old key stops working immediately. Update any Claude Code settings, CLI scripts, or environment variables before closing the dialog.

---

## Invitations (How You Might Have Joined)

If an administrator sent you an invite email:

1. Click the link in the email.
2. Set your password on the form that appears.
3. You are signed in automatically.

Invite links expire in 7 days and work only once.

If the invite link expired, ask your administrator to resend it. Resending issues a fresh link.

---

## Forgot Your Password?

On the sign-in page, click **Forgot password?** and enter your email address. If the email matches your account, you will receive a reset link (valid for 1 hour). Click the link, set a new password, and you will be signed in.

The server always responds the same way whether or not the email matched an account. This prevents someone from discovering which email addresses are registered.

If you do not receive the email within a few minutes, check your spam folder. If email is not configured on your OB2 instance, ask your administrator to reset your password via the Users tab.

---

## Your Domains

Each piece of knowledge in OB2 belongs to a **domain** — a named collection like `@runbooks`, `@netsec`, or `@onboarding`. Think of domains as folders, each with its own access control.

You can only see and query the domains your administrator has granted you access to. If you need access to a domain that isn't showing up in your Domains tab, ask an admin to add you.

**What the permissions mean:**

| Level | What you can do |
|---|---|
| Read | Search and chat within the domain |
| Write | Upload files and capture new knowledge (includes Read) |
| Admin | Delete documents, manage aliases (includes Write) |

**Domains are shared, not personal.** A domain is one collection used by
every user who has access to it. There is no "my @netsec" vs "your @netsec"
— it's the same store. So if an admin **deletes** a domain (Manage @domain
→ Settings → Danger zone → Delete), every user who could read it sees it
disappear at the same instant. Documents, aliases, descriptions, and graph
data all go.

A few things deletion does **not** clean up:

- User permission entries (`"<domain>": "read"`) in the user store stay
  pointing at the now-empty name. Harmless — they just match nothing.
- Original uploaded files under `/data/imports/<domain>/` remain on disk
  until removed manually. Citation download links return 404 once the
  domain is gone.
- Open WebUI chat history is per-user and untouched. Old chats that
  quoted the deleted domain still show with their original text.

If you want a clean restorable archive *before* deletion, use **Manage @domain
→ Settings → Backup → Export @&lt;domain&gt; as .ob2bundle** first.

---

## Exploring Your Knowledge Graph

(Global admins only.) The **Graph** tab visualises your knowledge as a
network of named entities and the relationships between them. Two views:

- **Per-domain** — pick a domain from the dropdown, see every entity that's
  been extracted from its documents. Nodes are coloured by type
  (PERSON / ORG / PLACE / PRODUCT / EVENT / CONCEPT / OTHER) and sized by
  how often they're mentioned. Click any entity to see the doc snippets
  that mention it.
- **Cross-domain overlap** — surfaces entities whose name and type appear
  in two or more domains you can read. Useful for finding people, projects,
  or concepts that span seemingly unrelated areas of your knowledge.

### Full-screen explorer

Click **Open full-screen ↗** in the Graph tab toolbar to open `/graph` in a
new browser tab — a full-window Cytoscape.js canvas with more room to explore:

- **Type filters** — toggle entity types on/off with the checkboxes in the toolbar
- **Search** — type in the search box to narrow visible nodes by name in real time
- **Run Layout** — re-runs the force-directed layout with higher iteration count for better node separation
- **Click any node** — side panel shows entity name, type, mention count, and the doc snippets that mention it
- **Export GEXF ↓** — downloads a Gephi-compatible `.gexf` file of the current domain's graph for advanced layout algorithms, community detection, and publishing

The **Export GEXF ↓** button is also available directly in the dashboard Graph tab toolbar without opening the full-screen view.

### Turning on extraction

Graph data is built by an async LLM pass over each captured doc — it is
**off by default** so existing setups keep working. Two flags govern it,
both edited in the **Config** tab YAML (or via env vars):

```yaml
graph:
  enabled: true             # use the graph for retrieval reranking during chat
  extraction_enabled: true  # extract entities/relationships during ingest
  extraction_model: ""      # empty → reuses the chat model from ollama.model
  rerank_alpha: 0.3         # how much weight to give graph-boosted hits
```

When `extraction_enabled` is true, every new capture queues a one-shot
LLM call (the active chat model unless `extraction_model` overrides). The
queue runs in the background, so capture latency is unchanged.

When `enabled` is true, the chat retrieval pipeline expands each top vector
hit by 1 hop along entity edges, boosts the resulting docs, and re-sorts
before context compression. This adds ~5–25 ms to a chat request when the
domain has been extracted, and 0 ms otherwise.

### Backfilling existing docs

For docs captured before extraction was on, click **Backfill** in the
Graph tab. A progress line appears showing percent complete; the worker
processes one doc at a time. Cancel safely at any point — already-extracted
docs aren't re-processed unless you backfill again.

Backfills run at LLM speed, so a domain with 1 000 docs takes 1–3 hours
on a single GPU. You can keep using OB2 normally while it runs.

### Removing entities

Deleting a doc cascades to its mentions, and any entity whose mention count
drops to zero is removed automatically (along with its edges). Deleting a
whole domain wipes its entities, mentions, and edges.

---

## Managing the Chat LLM

(Global admins only.) The **LLMs** tab is the single place to control which
Ollama model OB2 uses for chat — every chat surface (Open WebUI, MCP,
the OpenAI-compatible gateway) reads from the same setting, so a change
takes effect immediately and everywhere.

### Active model

The card at the top shows the model OB2 is using right now: name, on-disk
size, parameter count, quantization, and whether it's currently loaded in
VRAM. If the card warns that the model is **pinned by env var**, your
`.env` is forcing it (`OB2_OLLAMA_MODEL=...`). To use the dashboard
switcher, remove that line from `.env` and run `scripts/docker-restart.sh`.

### Switching to a different model

Pick a model from the **Switch active model** dropdown and click **Apply**.
OB2:

1. Saves the choice to runtime config (so it survives restarts).
2. Unloads the previous model from VRAM.
3. Warms the new one with a tiny generate call so the next chat doesn't pay
   the load cost.

The status line under the dropdown reports progress and the final result.
Cold loads of large models (20+ GB) can take a few seconds — that's normal.

### Pulling a new model

Type a model name in the **Pull a new model** input — the same names you'd
use with `ollama pull` (e.g. `llama3.1:8b`, `qwen2.5-coder:32b-instruct`,
`tinyllama:latest`). Browse [ollama.com/library](https://ollama.com/library)
for ideas.

Click **Pull**. A progress bar appears showing percent and bytes
transferred. Multiple pulls can run at once. **Cancel** stops a pull
mid-stream — Ollama keeps the partial download so resuming is fast.

When the pull finishes, the model joins the **Installed models** table.

### Removing a model

Click **Delete** next to any installed model to free up disk space on the
Ollama host. The active model is locked — switch to another one first if
you want to delete it.

---

## Backing Up and Restoring Domains

(Global admins only.) Once a project wraps you can archive its domain to a
single file and restore it later — same install, a different one, or a fresh
machine altogether. The bundle includes every document with its embeddings,
every alias, the description, and every original uploaded file (PDFs,
images, audio, etc.), so a restore reads back identical to the original.

### Export

1. Open the **Domains** tab.
2. Click **Manage** on the domain.
3. Switch to the **Settings** tab.
4. Under **Backup**, click **Export @&lt;domain&gt; as .ob2bundle**.

Your browser downloads `<domain>-<timestamp>.ob2bundle` — a gzip tarball.
Keep it somewhere durable. Bundles are plain (not encrypted), so treat them
as you would any export of your knowledge base.

### Import

1. From the **Domains** tab, click **Import Domain…** in the top-right.
2. Choose the `.ob2bundle` file.
3. (Optional) Type a **Target domain** to restore under a different name —
   useful if you want to bring a copy alongside the original or if a domain
   with the same name already exists.
4. Click **Import**.

When the import finishes you'll see a confirmation listing how many
documents, aliases, and files were restored.

**A few rules the importer enforces:**

- The target domain must not already exist. If it does, supply a different
  **Target domain** name or delete the existing one first.
- The bundle's embedding model must match the install's embedding model
  (otherwise search would return nonsense). If they don't match, the
  importer refuses with a clear error.
- Document IDs are regenerated on import. The original ID is preserved
  inside each doc's metadata as `_ob2_orig_doc_id` for traceability.

Once restored, every chat citation, file download, and search hit works
exactly the same way as it did on the source install.

---

## Domain Aliases

Admins can create **aliases** for a domain. An alias is an alternative name that appears in search suggestions when you forget the exact domain name. For example, if `@netsec` has an alias `SSL`, typing "SSL certificate" in a chat might prompt: `"Tip: try @netsec"`.

Aliases are managed in the Domains tab under the domain's row.

---

## What "No knowledge found" Means

If a chat answer says no relevant knowledge was found, one of these is likely true:

- No documents have been uploaded to that domain yet.
- Your query uses different terminology than your documents. Try rephrasing or searching for a keyword that appears in your docs.
- You are asking about a domain you do not have access to.

---

## Next Steps

- To upload your first documents in bulk, or to configure CLI importers, see `docs/deployment.md`.
- To understand how citations and retrieval work technically, see `docs/architecture.md`.
- For all HTTP endpoints and MCP tool parameters, see `docs/api-reference.md`.
