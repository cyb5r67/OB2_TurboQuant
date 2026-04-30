# User Management — Filling the Gaps

**Date:** 2026-04-24
**Status:** Draft for review

## Background

OB2 already has most of a user management system: a typed user model with per-domain permissions (`UserRecord.domains: { [domain]: 'read' | 'write' | 'admin' }`), a global-admin flag, password + API-key auth, an SMTP-backed invite flow with 7-day single-use tokens, an accept-invite landing page that auto-logs the new user in, and a Users tab in the dashboard with create / edit / set-password / revoke / raw-JSON-editor affordances. Permission checks (`hasPermission`) gate every data route — capture, search, chat — at the API layer.

What is missing is consistency in the GUI for non-admin users, plus one missing button:

1. `GET /admin/domains` returns every domain regardless of caller, so non-admins see domain names they have no access to. Clicking "Manage" then 403s on the inner endpoints.
2. The chat classifier auto-routes among all domains, so a non-admin's query can be routed to a domain they cannot read, producing a 403 surprise.
3. The backend has `POST /admin/users/:username/invite` for resending invites but the GUI has no button for it.
4. The Manage Domain modal exposes admin-only controls (Settings, Delete domain, write-aliases, doc-delete) to any caller and lets them click through to a server-side 403.
5. When SMTP fails or is unconfigured, the backend already returns the invite URL for out-of-band sharing, but the GUI does not surface the URL prominently.

This spec closes those five gaps without changing the user model, storage, sidecar, or auth flow.

## Goals

- A non-admin's view of OB2 is internally consistent: the domains they see in the GUI are the domains they can actually use.
- An admin can resend an invite to an existing user with one click.
- Every successful invite send leaves the admin with a copy-link fallback in case the email is lost.

## Non-goals

- New user model fields, audit logging, role groups, or RBAC overhaul.
- A "request access to a domain" workflow.
- Bulk invite, last-login tracking, password policy changes.
- Any change to how domains are stored or to the sidecar.
- Hiding domain *names* from non-admins. Domains remain discoverable by name; only their *actions* are gated.

## Design

### API changes

Three changes; no breaking changes.

**1. `GET /admin/domains` decorates entries with caller's effective permission.**

Today the response is `{ domains: [{ domain, doc_count, description }, ...] }` (sidecar's `knowledge_stats` shape). After this change, each entry gains an `effective_permission` field:

```ts
type Permission = "read" | "write" | "admin";
interface DomainListEntry {
  domain: string;
  doc_count: number;
  description: string | null;
  effective_permission: Permission | null;  // NEW
}
```

The value is derived in the route handler from `c.get("auth")`:

- Global admin → `"admin"` for every entry.
- Otherwise → `auth.domains[domain] ?? null`.

No sidecar change. The list itself is still unfiltered; only the per-entry decoration is new.

**2. Classifier candidate filtering in `gateway.ts` chat path.**

Before invoking the classifier, the gateway computes the candidate set:

- Global admin → all domains (today's behavior).
- Non-admin → `Object.keys(auth.domains)`. Every assigned permission level (`read`, `write`, `admin`) implies read access, so no further filtering is needed.
- Empty candidate set → return HTTP 403 with body `{ error: { message: "You have no domain assignments. Ask an admin to assign you a domain.", type: "no_domain_access" } }` instead of invoking the classifier.

The classifier itself is unchanged; it just receives a smaller candidate list.

**3. Resend-invite endpoint — small response-shape evolution.**

`POST /admin/users/:username/invite` exists today (`server/routes/admin.ts:391`) but returns only `{ ok: true }` on success and `{ error, invite_url }` with HTTP 500 on failure. To make the GUI's copy-link modal viable the response is widened — always HTTP 200 when the user exists and has email, with body:

```ts
{
  ok: true,
  sent: boolean,            // true if email send succeeded
  url: string,              // always present, for copy-link fallback
  expires_at: string,       // ISO-8601 from generateToken
  send_error?: "smtp_not_configured" | string  // present iff sent=false
}
```

`expires_at` comes from `generateToken`'s existing `IssuedToken.expiresAt`. SMTP-not-configured no longer 400s — it returns `{ok: true, sent: false, send_error: "smtp_not_configured", url, expires_at}` so the admin can share the link out of band. User-not-found (404) and target-has-no-email (400) preserve their current error responses.

`POST /admin/users` (create-user-with-invite) gains a parallel `invite` sub-object with the same shape when `send_invite: true` is requested, replacing the current ad-hoc `invite_sent` / `invite_error` / `invite_url` top-level fields.

### GUI changes

All in `server/static/dashboard.html` and `server/static/dashboard.js`. No new pages.

**Domains tab (all viewers):**

Each domain row branches on the row's `effective_permission`:

| `effective_permission` | Row appearance | Manage modal contents |
|---|---|---|
| `"admin"` | Today's behavior | All four tabs (Docs / Aliases / Users / Settings); Delete-domain button visible. |
| `"write"` | Manage button active | Docs tab fully active; Aliases tab read-only; Users tab hidden; Settings tab hidden. |
| `"read"` | Manage button active | Docs tab read-only (no doc-delete); Aliases tab read-only; Users / Settings tabs hidden. |
| `null` | Row at opacity 0.5; "No access" badge replaces the Manage button | Modal cannot be opened. |

The "Create domain" form remains hidden for non-admins (today's behavior).

**Users tab (admins only — already gated):**

Add an **Invite** button to each user row's Actions column, between Edit and Set password. Disabled with tooltip "User has no email — set one in Edit first" when `!user.email`. Clicking calls `POST /admin/users/:username/invite` and opens the Invite-link modal (below) on response.

Inside the Edit User modal, add a secondary "Send invite link" button at the bottom, with the same gating and the same modal-open behavior. This gives admins a way to reach the action from inside the editing flow without closing the modal first.

**Invite-link modal (new):**

Triggered after every invite send — from the create-user form (when `send_invite: true`), from the row Invite button, and from the Edit-modal Send-invite-link button.

Layout:

- Heading: `Invite link for <username>`
- Status banner (chosen by the GUI from the response payload):
  - `sent: true` → green: "Email sent to `<email>`. The link below is your fallback if the email is lost."
  - `sent: false` and `send_error === "smtp_not_configured"` → amber: "SMTP is not configured. Share this link directly."
  - `sent: false` with any other `send_error` → amber: `Email send failed: <send_error>. Share this link directly.`
- Read-only text input containing the URL.
- **Copy** button (uses `navigator.clipboard.writeText`).
- TTL line: `Expires <relative time, e.g. "in 7 days">.`
- Close button.

**Profile tab (small polish, all viewers):**

Add a "Your domain access" section listing the user's `domains` map:

- Global admin → `Global admin — all domains`.
- Otherwise → comma-separated `@infra (read), @logs (read), @ops (admin)`. Empty map → "No domains assigned. Contact an administrator."

Read-only.

### Data flow

**Resend invite from Users tab row:**

1. Admin clicks Invite button.
2. `dashboard.js` calls `POST /admin/users/<u>/invite` with empty body.
3. Route handler in `admin.ts`:
   - `requireGlobalAdmin` middleware.
   - `generateToken(username, "invite")` from `reset-tokens.ts`.
   - Build URL = `${publicUrl}/dashboard?token=${plaintext}`.
   - Render template with `renderInviteEmail`.
   - Attempt `mailer.send`; capture `send_error` on failure.
   - Return `{ ok, sent, url, expires_at, send_error? }`.
4. `dashboard.js` opens the Invite-link modal with the response payload.

**Domains tab load (any caller):**

1. Tab activates → `api('GET /admin/domains')`.
2. Route handler fetches the unfiltered list from the sidecar (today's behavior), then enriches each entry by computing `effective_permission` from `c.get("auth")` + `UserRecord.domains`.
3. `dashboard.js` `renderDomainsList` branches per entry on `effective_permission` (table above).

**Chat (non-admin, classifier path):**

1. User submits chat in the Overview chat panel.
2. `gateway.ts` chat handler:
   - Computes `candidates` per the rule above.
   - If empty → 403 friendly message; rendered in the chat panel as a notice (not a red error).
   - Otherwise → call classifier with `candidates`, proceed as today.

**Accept invite (unchanged):**

The flow at `dashboard.js:140` (`maybeShowReset`) → `POST /auth/reset-password { token, new_password }` → auto-login on `kind === "invite"` is unchanged.

### Error handling

| Situation | Behavior |
|---|---|
| Invite send fails (SMTP error) | Backend returns `{ ok: true, sent: false, url, send_error }`. GUI shows amber banner in Invite-link modal. Token is still valid for 7 days. |
| SMTP not configured | Mailer's `getMailer` returns LogMailer in dev or surfaces `send_error: "smtp_not_configured"` in prod. Same modal, amber banner. |
| Invite for user without `email` | Row Invite button and modal Send-invite-link button are disabled with tooltip. Defense in depth: backend would still produce a token if called directly; that is acceptable — admin can copy the URL out of the response. |
| Non-admin opens Manage on a `null`-permission domain | UI prevents it (badge replaces button). Defense in depth: inner Docs/Aliases/Settings calls already 403 server-side. |
| Non-admin chats with zero domain assignments | Gateway returns the 403 friendly message; GUI renders it as a notice in the chat panel rather than a red error toast. |
| Caller's `domains` map mutated mid-session (admin removed access) | `_resolveAuth` re-reads `users.json` via mtime hot-reload (today's behavior). Next request 403s; nothing extra to do. |
| Token replay after acceptance | `consumeToken` is single-use (today's behavior). Replay returns 410 Gone; GUI shows "Link already used or expired" (today's behavior). |
| Zero-admin rail | Unchanged. `_wouldLeaveZeroAdmins` already gates demote / revoke / raw-save paths and raises `ZeroAdminError`. |

### Testing

The project's only automated test harness is `tests/e2e.sh` (bash + curl) and `tests/mcp_runner.py` (MCP-specific). There is no Deno unit-test runner today. To match the existing test culture, all new automated coverage lands in `tests/e2e.sh` rather than introducing a new test framework.

**`tests/e2e.sh` Step 15 (new — Steps 13–14 are already taken by email recovery and security regression; the Rust-parity step is renumbered to 16):**

1. Reuse the post-bootstrap state already established by Step 12. As admin (bob, promoted in Step 12), create a non-admin `alice` with `domains: { "infra": "read" }` via `POST /admin/users`.
2. As alice, `GET /admin/domains` → assert each entry has `effective_permission`; the `infra` entry is `"read"`; the `netsec` entry is `null`.
3. As admin, `GET /admin/domains` → assert every entry's `effective_permission` is `"admin"`.
4. With `@infra` and `@netsec` both already seeded earlier in the suite, alice issues `POST /v1/chat/completions` with a prompt whose content most closely matches the `@netsec` corpus (no explicit `@domain` prefix). Assert HTTP 200, proving the classifier did not route to `@netsec` and produce a 403.
5. PATCH alice to `domains: {}`. Alice's next `POST /v1/chat/completions` (no prefix) returns HTTP 403 with body containing `"no_domain_access"`.
6. As admin, `POST /admin/users/alice/invite` → assert response JSON contains `"ok":true`, a `url` field, and an `expires_at` field.

**Manual smoke (browser):**

- Domains tab as alice: confirm greying on unassigned rows, "No access" badge replacing Manage button, and that the Manage modal on a `read`-permission domain hides Settings / Users tabs and the Delete-domain button.
- Users tab as admin: confirm Invite button disabled when no email; confirm copy-link modal appears on every invite send (create + resend); confirm Copy button writes to clipboard.
- Profile tab as alice: confirm "Your domain access" section shows `@infra (read)`.

## Files touched

| File | Change |
|---|---|
| `server/routes/admin.ts` | Decorate `GET /admin/domains` entries with `effective_permission`. |
| `server/routes/gateway.ts` | Filter classifier candidate set; emit `no_domain_access` 403. |
| `server/static/dashboard.html` | New Invite-link modal markup; Invite button in Users-tab row; "Send invite link" button in Edit User modal; "Your domain access" section on Profile tab. |
| `server/static/dashboard.js` | Render Domains rows per `effective_permission`; gate Manage modal contents per permission level; wire Invite buttons to `POST /admin/users/:u/invite`; render Invite-link modal; render "Your domain access" on Profile tab; render `no_domain_access` chat error as a notice. |
| `tests/e2e.sh` | New Step 15. |

No changes to `server/users.ts`, `server/auth/sessions.ts`, `server/auth/reset-tokens.ts`, `server/auth/passwords.ts`, `server/mail/*`, or the sidecars.
