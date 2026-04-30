# Email-Based Recovery & Onboarding — Design

**Status:** Spec 2 of 2.
**Date:** 2026-04-18
**Depends on:** Spec 1 (`2026-04-18-close-admin-bootstrap-design.md`) — already shipped.

## Problem

Spec 1 closed the `OB2_BRAIN_KEY` bootstrap path once a real global admin exists. This solved the standing attack surface but left a usability gap: a user who forgets their password has only two recovery paths — another global admin resets them via the Users tab, or the shell break-glass script runs on disk. Neither path self-serves, and the shell script requires container access.

The standard web-app recovery flow (forgot-password → email → reset-link → set new password) is missing. So is admin-driven onboarding (create a user, the user sets their own password via an invite link).

## Goal

Add email-based password recovery and invite-based onboarding. Users self-serve with a "Forgot password?" link. Admins create users without knowing or typing the initial password. The shell script from Spec 1 stays as the last-resort path when both email infrastructure and peer admins are unavailable.

## Non-goals

- Provider-specific HTTP APIs (Sendgrid, SES, Mailgun). SMTP only in this spec. The code ships behind a `Mailer` interface so adding an API driver later is a new file + new config enum value — zero retrofit.
- Email-address verification (send-and-click before an address is usable). Admin-set emails are trusted; user-edited emails (via Profile) are trusted on save. A verification layer can be added in a future spec if needed.
- Outbound email for notifications other than recovery/invite.
- Analytics / click tracking on email links.
- Queued retry for transient SMTP failures. Sync send only; failure path is documented per-endpoint.
- Multi-language templates. English only.
- SPF/DKIM/DMARC configuration — that's up to the operator's SMTP provider.

## Core invariants

- **Anti-enumeration on `POST /auth/forgot-password`.** The endpoint always returns `200 {ok: true}` regardless of whether the email matches a user. Timing is not smoothed (acceptable — the email existence check is a cheap in-memory scan, not a network call).
- **Single-use tokens.** Every reset/invite token is deleted the moment it's consumed. Reuse attempts return 401.
- **Hashed at rest.** Only `sha256(plaintext)` is stored. The plaintext exists only in the URL that was emailed to the user.
- **Password change or user revoke invalidates all outstanding tokens for that user.**
- **Public URL is required for email.** `OB2_PUBLIC_URL` must be set when SMTP is configured, else the email endpoints 500 with a clear error. Non-email flows are unaffected.
- **SMTP is optional.** If `OB2_SMTP_HOST` is unset, the email endpoints return 503 `"email recovery not configured"`. Everything else in OB2 works unchanged.

## Scope

### 1. Module layout

```
server/
  mail/
    mailer.ts         ← Mailer interface + factory dispatch
    smtp.ts           ← SmtpMailer (denomailer)
    log.ts            ← LogMailer (test-only, writes to stdout/log)
    templates.ts      ← renderInviteEmail, renderResetEmail — text+HTML+subject
  auth/
    reset-tokens.ts   ← generate/consume/revoke/sweep
    rate-limit.ts     ← generic in-memory limiter
```

Plus modifications:
- `server/config.ts` — new SMTP + public-URL fields.
- `server/routes/auth.ts` — three new endpoints.
- `server/routes/admin.ts` — invite endpoint + SMTP test endpoint + create-user flow extension.
- `server/users.ts` — optional `email` field + validation.
- `server/static/dashboard.html` — forgot-password link, reset form, email card, admin create-user radio, SMTP config section.

### 2. Mailer interface

```ts
// server/mail/mailer.ts
export interface Mailer {
  send(msg: { to: string; subject: string; text: string; html: string }): Promise<void>;
  isConfigured(): boolean;
}

export function createMailer(config: Config): Mailer | null {
  const driver = config.smtpDriver; // "smtp" | "log" | undefined
  if (driver === "log") return new LogMailer();
  if (config.smtpHost) return new SmtpMailer(config);
  return null;
}
```

Callers (`authRoutes`, `adminRoutes`) guard email-flow behavior on `mailer?.isConfigured() === true`.

### 3. SMTP driver (`server/mail/smtp.ts`)

Wraps [`denomailer`](https://deno.land/x/denomailer). One class: `SmtpMailer` implements `Mailer`. Constructor reads `{smtpHost, smtpPort, smtpUser, smtpPass, smtpSecure, smtpFrom}` from config. `send()` opens a connection, sends, closes. No connection pooling (volume is password-reset scale — single-digit sends per day for most deployments).

Error handling: any send failure throws with the underlying denomailer message. Callers decide whether to swallow (forgot-password, anti-enumeration) or surface (admin-invite, so the operator gets a copy-paste URL fallback).

### 4. Log driver (`server/mail/log.ts`)

Test-only. Writes `[MAIL to=alice@example.com subject="OB2 password reset" url=https://ob2.example/dashboard#reset-password?token=abc123]` to stdout and the same payload plus the full text body to a log file at `server/data/mail-log.txt`. E2E tests grep that file.

Activated via `OB2_SMTP_DRIVER=log` env var. Production uses the SMTP driver.

### 5. Templates (`server/mail/templates.ts`)

Two exported functions:

```ts
renderResetEmail(args: {
  username: string;
  url: string;
  ttlHours: number;
}): { subject: string; text: string; html: string };

renderInviteEmail(args: {
  username: string;
  url: string;
  ttlDays: number;
}): { subject: string; text: string; html: string };
```

Each returns a triple. HTML is a single inline-styled `<div>` container (max-width 480px, centered, white background) with a button-styled `<a>` link. Body text below the button, identical to the `text` part. No external resources, no tracking pixels.

Subject lines:
- Reset: `OB2 password reset`
- Invite: `You've been invited to OB2`

### 6. Reset-token module (`server/auth/reset-tokens.ts`)

**Backing file:** `server/data/reset-tokens.json`. Hot-reloaded on mtime change, same pattern as `users.json`.

**On-disk schema:**
```json
{
  "tokens": [
    {
      "token_hash": "<sha256-hex>",
      "username": "alice",
      "kind": "reset",
      "expires_at": "2026-04-18T10:00:00.000Z",
      "created_at": "2026-04-18T09:00:00.000Z"
    }
  ]
}
```

**Public API:**
```ts
interface IssuedToken { plaintext: string; expiresAt: string; }

generateToken(username: string, kind: "reset" | "invite"): Promise<IssuedToken>;
consumeToken(plaintext: string): Promise<{ username: string; kind: "reset"|"invite" } | null>;
revokeUserTokens(username: string): Promise<number>; // returns count
sweepExpired(): Promise<number>;
```

`generateToken`:
- 32 random bytes via `crypto.getRandomValues`, hex-encoded (64 chars).
- sha256 the plaintext.
- TTL: 1 hour for `reset`, 7 days for `invite`.
- Atomic write.
- Returns plaintext for the caller to embed in the URL. Plaintext is never written to disk.

`consumeToken`:
- sha256 the input.
- Look up; if not found → null.
- Check `expires_at > now`; if not → delete + null.
- Delete the record (single-use), write, return `{username, kind}`.

`revokeUserTokens`: delete all records with matching `username`. Called from:
- `auth.ts` `change-password` success path.
- `auth.ts` `reset-password` success path.
- `admin.ts` `POST /users/:name/password` success path.
- `admin.ts` `DELETE /users/:name` success path.

`sweepExpired`: run on every write, and on a 10-minute interval. Logs count swept (DEBUG level).

### 7. Config additions (`server/config.ts`)

```ts
smtpDriver: "smtp" | "log" | null;   // OB2_SMTP_DRIVER, default null (inferred from smtpHost)
smtpHost: string;                     // OB2_SMTP_HOST
smtpPort: number;                     // OB2_SMTP_PORT, default 587
smtpUser: string;                     // OB2_SMTP_USER
smtpPass: string;                     // OB2_SMTP_PASS
smtpSecure: "tls" | "starttls" | "none"; // OB2_SMTP_SECURE, default "starttls"
smtpFrom: string;                     // OB2_SMTP_FROM, e.g. "OB2 <noreply@example.com>"
publicUrl: string;                    // OB2_PUBLIC_URL, e.g. "https://ob2.example.com"
```

Runtime YAML (`config.yaml`) also accepts these under `mail:` and `app:` (publicUrl). Env wins, same as existing fields. Hot-reload works.

Startup validation:
- Warn if any `smtp*` field is set but `publicUrl` is empty.
- Warn if `publicUrl` doesn't start with `http://` or `https://`.
- Warn if `publicUrl` ends with `/`.
- No hard fails — mail just won't work, and attempts surface the error.

### 8. Rate limiter (`server/auth/rate-limit.ts`)

In-memory, per-process (resets on restart). Single exported helper:

```ts
check(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfterMs: number };
```

Backing store: `Map<string, { count: number; resetAt: number }>`. On each call, sweep expired entries (O(n) on the map; n is tiny for this use case). Thread-safety: Deno is single-threaded JS, no locks needed.

Applied to:
- `POST /auth/forgot-password`: keys `ip:<remoteAddr>` (5/15min) and `user:<username>` (3/60min). Both must pass.
- `POST /auth/reset-password`: key `token:<plaintext>` (10/60min). Stops brute-force against a leaked token.

Exceeded → 429 `{error: "rate limited", retry_after_ms}`.

### 9. Email field on `UserRecord`

Update `server/users.ts`:

```ts
export interface UserRecord {
  username: string;
  key: string;
  email?: string;                      // NEW
  password_hash?: string;
  global_admin: boolean;
  domains: Record<string, Permission>;
  created_at: string;
  enabled: boolean;
}
```

Validation: `isValidEmail(s) = /^\S+@\S+\.\S+$/.test(s) && s.length <= 254`. Format-only — no deliverability check.

Mutations that accept email:
- `createUser(username, domains, global_admin, email?)` — signature extended.
- `updateUser(username, patch)` — `UserPatch.email?: string | null`. `null` clears.
- `saveRawUsersFile` — email field passes schema if present.
- New `setEmail(username, email)` — used by `POST /auth/email` (self-serve).

Admin UI (Users tab create dialog, Edit dialog) exposes email. Profile tab exposes email for the current user.

### 10. New public endpoints

**`POST /auth/forgot-password`** — anti-enumeration.
- Body: `{email: string}`.
- Rate limit check; if exceeded, 429.
- Always returns 200 `{ok: true}` regardless of match.
- If `createMailer()` is null or `publicUrl` unset → still 200, but server logs `WARN: forgot-password attempted but email infra not configured`.
- If email matches a user with that email: `generateToken(user.username, "reset")`, `mailer.send(...)` with the URL. Send failure is swallowed (log at ERROR, still return 200).

**`POST /auth/reset-password`** — handles BOTH reset and invite tokens (§12 details the UX distinction).
- Body: `{token: string, new_password: string}`.
- Rate limit on `token:<hex>`.
- `validatePasswordStrength(new_password)`; 400 on failure.
- `consumeToken(token)` → 401 if null. Result is `{username, kind}`.
- `setPassword(username, new_password)`.
- `revokeUserSessions(username)` — kicks out any active sessions.
- `revokeUserTokens(username)` — invalidates any other outstanding tokens.
- If `kind === "invite"`: auto-login by minting a session cookie (per §12) and return `200 {ok: true, auto_signed_in: true}`.
- If `kind === "reset"`: return `200 {ok: true}` without a session. User signs in with the new password.

**`GET /auth/reset-password?token=X`** — just serves the existing dashboard HTML. The SPA detects `#reset-password?token=X` in the URL hash and renders the reset form instead of the login form. (The server doesn't do hash-routing; the query-string form is there purely so the emailed URL is clean. The dashboard JS reads `?token=X` from location.search and rewrites to `#reset-password?token=X` on load, or reads it directly.)

### 11. New authenticated endpoints

**`POST /auth/email`** — self-serve email setting.
- Authenticated (global admin OR the current user).
- Body: `{email: string | null}`.
- Validates email format (or accepts null to clear).
- Calls `setEmail(auth.username, email)`.
- Returns 200 `{ok: true, email}`.

**`POST /admin/users/:name/invite`** — admin-driven invite.
- Global-admin only.
- Preconditions: target user exists, has `email` set, mailer is configured. Else 400 with the specific reason.
- `generateToken(name, "invite")`, `mailer.send(...)` with the URL.
- Success: 200 `{ok: true}`.
- Send failure: 500 `{error: "SMTP send failed: <msg>", invite_url: "<fallback>"}` — so admin can copy the URL out-of-band. Graceful degradation.

**`POST /admin/smtp/test`** — test email.
- Global-admin only.
- Body: `{to: string}`.
- Sends a fixed "OB2 SMTP test" email to the target.
- 200 `{ok: true}` or 500 with error.

### 12. Admin create-user flow

`POST /admin/users` extended body:

```ts
{
  username: string;
  domains?: Record<string, Permission>;
  global_admin?: boolean;
  email?: string;
  send_invite?: boolean;   // NEW — default false
}
```

Behavior:
- If `send_invite: true` and `email` is unset → 400.
- If `send_invite: true` and mailer not configured → 400.
- Create user (no password yet).
- If `send_invite: true`: generate invite token, send email. On send failure, return 201 with the created user but also `{invite_error, invite_url}` so admin can share out-of-band.

**Invite-accept flow** (reset-password endpoint handles both kinds):
- User clicks invite URL → lands on reset-form UI (same as reset flow).
- Sets a password.
- `POST /auth/reset-password` with `{token, new_password}` — same endpoint, token kind is `invite` internally but from the server's perspective the logic is the same (`consumeToken` returns kind; we `setPassword` regardless).
- Server auto-login optional (nice-to-have): after setting password on an invite token, issue a session cookie so the user lands on the dashboard signed in. **In: if kind === "invite", mint a session and return `{ok: true, auto_signed_in: true}`; the UI redirects to `/` on success.**

This unifies the "reset" and "invite" UX into one form with slightly different microcopy chosen by the kind returned in an earlier GET lookup.

### 13. UI changes (`server/static/dashboard.html`)

**Login page:**
- "Forgot password?" link below the Sign In button.
- Clicking opens a tiny modal with an email input and Send button. On submit, POST `/auth/forgot-password`, close modal, show "If that email matches an account, you'll receive a reset link."

**Reset page:**
- On page load, if the URL has `?token=X` (or `#reset-password?token=X`), skip the login form and show a reset form: "Set your password" heading, new-password field + confirm field, Submit button.
- On submit, POST `/auth/reset-password`. Success → redirect to `/` (auto-signed-in if invite kind); failure → inline error.
- Token kind ("reset" vs "invite") is revealed client-side via an earlier lightweight `GET /auth/reset-token-info?token=X` → `{valid: bool, kind: "reset"|"invite", username}`. Used to swap heading text between "Welcome to OB2, set your password" (invite) and "Reset your password" (reset). Does NOT consume the token. Rate-limited.

**Profile tab:**
- New "Recovery email" card: shows current email (or "none set"), edit button, save calls `POST /auth/email`.
- Banner at the top of Profile if email is unset: "Add a recovery email so you can reset your password without an admin."

**Users tab — create dialog:**
- Extended form: optional email field, radio group:
  - ○ Set initial password now (existing behavior; shows password field)
  - ○ Send invite email (requires email + SMTP; disabled with tooltip if either missing)

**Users tab — edit dialog:**
- Email field added.
- "Send invite" button next to the email field (for any user with email but no password — useful for fixing up users created pre-email).

**Config tab:**
- New "Email (SMTP)" section below the existing runtime config YAML textarea. Fields: host, port, user, pass, secure (dropdown), from, publicUrl.
- "Send test email" button next to a test-to input → calls `POST /admin/smtp/test`.
- Status indicator: green "configured" or yellow "missing host/publicUrl" or "pass field empty" etc.

### 14. Testing

**`tests/e2e.sh` Step 13 — email flows** (uses `OB2_SMTP_DRIVER=log`):

| # | Test | Expected |
|---|---|---|
| 13.1 | Forgot-password for unknown email | 200 `{ok:true}`, no log entry |
| 13.2 | Forgot-password for user without email set | 200, no log entry |
| 13.3 | Forgot-password for valid email | 200, log contains one email with `OB2 password reset` subject + URL |
| 13.4 | Reset-password with valid token | 200, login with new password succeeds |
| 13.5 | Reset-password: reuse same token | 401 |
| 13.6 | Reset-password with expired token (simulated via direct file edit) | 401 |
| 13.7 | Forgot-password rate limit: 6th request in 15 min | 429 |
| 13.8 | Admin creates user with `send_invite:true` | 201 + invite URL in log |
| 13.9 | User follows invite URL, sets password | 200, auto-signed-in session cookie present |
| 13.10 | Reset-password revokes outstanding sessions | 401 on previous session cookie |
| 13.11 | SMTP test endpoint | 200, log has "OB2 SMTP test" subject |
| 13.12 | `/auth/email` self-serve | 200, subsequent forgot-password reaches that address |

Target: 12 assertions. Grand total target: **49 assertions** (37 from Suites 1–3 + 12 new).

### 15. Configuration docs

Add a new section to `docs/user-guide.md`:

- **Enabling email recovery** — env vars, YAML equivalents, example for Gmail SMTP, example for Sendgrid SMTP endpoint.
- **Admin invite flow** — how to create a user with invite email vs initial password.
- **Reset flow** — link from Profile, forgot-password from login page.
- **What happens when SMTP is down** — admin invite shows a fallback URL; user-facing forgot-password silently no-ops; shell script remains the final fallback.
- **Troubleshooting** — common SMTP gotchas (Gmail app-password vs account password, TLS/STARTTLS/port mismatch, DMARC rejecting the `from` address).

## Data model summary

New:
- `server/data/reset-tokens.json` — hashed tokens with TTL.
- `server/data/mail-log.txt` — only written by the log driver, for tests.

Modified:
- `users.json` — users gain optional `email`.
- `config.yaml` — new `mail:` and `app.publicUrl` sections.

Env vars: `OB2_SMTP_{HOST,PORT,USER,PASS,SECURE,FROM,DRIVER}`, `OB2_PUBLIC_URL`.

## Error handling

| Condition | Response | Logged? |
|---|---|---|
| `/auth/forgot-password`, mailer unconfigured | 200 (anti-enum) | WARN once |
| `/auth/forgot-password`, send fails | 200 (anti-enum) | ERROR |
| `/auth/forgot-password`, rate-limited | 429 | INFO |
| `/auth/reset-password`, bad token | 401 | INFO |
| `/auth/reset-password`, expired token | 401 | INFO |
| `/auth/reset-password`, weak password | 400 | INFO |
| `POST /admin/users/:name/invite`, no email | 400 | INFO |
| `POST /admin/users/:name/invite`, send fails | 500 + fallback URL | ERROR |
| `POST /admin/smtp/test`, send fails | 500 + error detail | ERROR |
| Startup: SMTP set, `publicUrl` unset | server starts normally | WARN |

## Rollback

Code + new data files. To roll back:
- Revert the commits.
- Delete `server/data/reset-tokens.json` (no longer read).
- Email fields left in `users.json` are ignored by the old code (unknown-field permissive).
- SMTP config values in env / YAML are ignored by the old code.

Zero data migration required in either direction.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Leaked reset token → password takeover | 1-hour TTL, single-use, sha256 at rest, rate-limited |
| Enumeration via forgot-password response | Uniform 200 regardless of match |
| Enumeration via response timing | Acceptable: user-lookup is in-memory and fast; no observable timing delta vs cold cache |
| SMTP credentials leak | Config is hot-reloadable; rotate in YAML or env and reload |
| Operator mis-configures `publicUrl` | Startup warning; test endpoint catches bad config before users hit it |
| Admin invite link shared publicly | 7-day TTL, single-use; admin can revoke via `revokeUserTokens` or `PATCH /admin/users/:name/invite/cancel` (not in spec — add if demand) |
| `mail-log.txt` contains plaintext URLs | Only written by the test driver; production uses SMTP and never writes to it |
| Rate-limit bypass via rotating IPs | Secondary rate limit keyed on `user:<name>` covers that |
| Token file disappears mid-flight | Tokens become invalid; user re-requests; no permanent damage |

## Open questions

None blocking. Items that can be decided during implementation if not sooner:

- Exact wording of email body copy (English). Picking sensible defaults; happy to iterate.
- Whether to log the target email address (currently: no — only username logged). Flag this at implementation time if regulatory requirements argue for audit trail.
