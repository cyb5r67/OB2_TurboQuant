# Security Hardening for Public-Internet Exposure — Design

**Status:** Spec A of 2 (hardening). Spec B covers continuous security assurance (CI dep scan, OWASP review doc, audit log, disclosure process) and ships next.
**Date:** 2026-04-19
**Depends on:** Specs 1 + 2 already shipped (bootstrap closedown + email recovery).

## Problem

OB2 was functionally tested (59/59 e2e passing) but never security-tested. A targeted audit surfaced concrete issues that block public-internet exposure:

- **Dashboard XSS**: ~10 sites where server-returned user/domain data is interpolated into `innerHTML` without escaping. One specific case — `onclick="loadAliases('${dom.domain}')"` at `server/static/dashboard.html:689` — is straight-up stored XSS: a domain name with a single quote escapes the JS string and executes.
- **No security headers**: no CSP, no X-Frame-Options, no X-Content-Type-Options, no HSTS, no Referrer-Policy. Clickjacking, MIME sniffing, reflected-XSS amplification, mixed-content attacks all possible.
- **Overly broad Deno permissions**: `--allow-read --allow-write --allow-run` unrestricted. A compromised dependency has full filesystem + shell.
- **Error message leakage**: `c.json({ error: (err as Error).message }, 500)` returns stack traces / SMTP banner text / internal paths to clients.
- **No login rate limit**: `POST /auth/login` is freely brute-forceable.
- **`X-Forwarded-For` trust**: the rate limiter keys on the first XFF value. On direct internet exposure (no proxy normalizing it), the attacker sets the header freely.
- **LogMailer footgun**: if `OB2_SMTP_DRIVER=log` is left set in production, every password-reset URL is written to `server/data/mail-log.txt` in plaintext.
- **Cookie `Secure` flag**: only set if the request itself is HTTPS. Behind a proxy that terminates TLS on the front and talks HTTP to OB2, the cookie ships without `Secure`.

## Goal

Make OB2 safe to expose directly to the public internet (behind a TLS reverse proxy). Target: no known stored-XSS, proper defensive HTTP posture, minimized Deno permissions, rate-limited brute-force surface, no log exfil.

## Non-goals

- Audit log (Spec B).
- Dependency vulnerability scanning in CI (Spec B).
- OWASP Top 10 compliance report (Spec B).
- Responsible-disclosure policy & security.txt — **in scope for this spec as A10** because it's small and ships naturally with the other docs.

## Scope (11 items)

### A1. Dashboard XSS — escape all user-data interpolations

Every `innerHTML =` template literal in `server/static/dashboard.html` that embeds server-returned data must escape. Two escape contexts:

- **HTML text**: `&<>"'` via the existing pattern (see `server/mail/templates.ts:escapeHtml`).
- **HTML attributes**: same five chars, used inside `"…"` attribute values.
- **JS-in-attribute (`onclick="fn('${x}')"`)**: cannot be safely escaped at all — must be refactored to `addEventListener` with `dataset` for the payload.

Line 689's `onclick="loadAliases('${dom.domain}')"` is the worst case and drives the A5 refactor.

### A2. HTTP security headers

New Hono middleware in `server/index.ts` emits on every response:

- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`. Inline styles stay (dashboard uses them pervasively); inline scripts must go (A5).
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: geolocation=(), microphone=(), camera=()`
- `Strict-Transport-Security: max-age=31536000; includeSubDomains` — only when request is HTTPS (reuse `isHttps` from `server/routes/auth.ts:43-53`).

### A3. Tighten Deno permissions

`server/deno.json` tasks currently grant `--allow-net --allow-env --allow-read --allow-write --allow-run` with no paths. Scope down:

```
--allow-net               # kept broad: SMTP host is runtime-configurable
--allow-env=OB2_,HOME,HOSTNAME,USER,PATH
--allow-read=./,/data,/app
--allow-write=./data,./,/data
--allow-run=python3,/app/retrieval/.venv/bin/python,stty
```

Read can't easily be tightened further because Deno resolves remote modules via filesystem cache, and the sidecar reads script paths relative to CWD. Write is scoped to data dirs. Run is scoped to Python + `stty` (used by `reset-admin.ts` stdin prompt).

### A4. Error message sanitization

New `server/routes/_errors.ts`:

```ts
export function safeError(err: unknown, publicMsg: string): string {
  const msg = (err instanceof Error) ? err.message : String(err);
  console.error(`[server] ${publicMsg}: ${msg}`);
  return publicMsg;
}
```

Replace every `c.json({ error: (err as Error).message }, 500)` with `c.json({ error: safeError(err, "internal server error") }, 500)` across `server/routes/*.ts`. Validation errors, rate-limit, and other intentionally-public messages stay unchanged (they don't leak internal state).

### A5. Extract inline scripts → `server/static/dashboard.js`

Every `<script>…</script>` block and every `onclick=`/`onchange=`/`ontoggle=` attribute moves to an external `dashboard.js`. This lets CSP drop `'unsafe-inline'` from `script-src`. Handlers become `addEventListener` with data attributes (e.g., `<button data-domain="foo">` → `btn.addEventListener('click', () => loadAliases(btn.dataset.domain))`).

Large mechanical refactor (~800 LOC moved) but unavoidable for strict CSP.

### A6. LogMailer production guard

`server/mail/log.ts` refuses to `send()` if `OB2_PUBLIC_URL` starts with `https://` AND the host isn't one of `localhost`, `127.0.0.1`, or any RFC-1918 address. Throws a clear "LogMailer cannot run in production — set OB2_SMTP_DRIVER=smtp" error.

### A7. Login rate limit

`POST /auth/login` gains:
- Per-IP: 10 attempts / 15 min
- Per-username: 5 attempts / 15 min

Both must pass or the response is 429. Applies to every login regardless of success/failure to make the limit harder to probe.

### A8. X-Forwarded-For trust boundary

New `trustProxy: boolean` on `Config` (env `OB2_TRUST_PROXY`, default `false`). New helper `clientIp(c, trustProxy)` in `server/auth/rate-limit.ts` returns:

- If `trustProxy === true`: `c.req.header("x-forwarded-for")?.split(",")[0].trim() || directIp`
- Else: `directIp` (via Hono's context)

All rate-limit keyings migrate to the helper. Docs tell operators to set `OB2_TRUST_PROXY=true` only when actually behind a proxy that strips client-supplied XFF.

### A9. Cookie `Secure` + HTTPS enforcement

Two changes in `server/auth/sessions.ts` + `server/index.ts`:

- `buildCookie` sets `Secure` if `OB2_PUBLIC_URL` starts with `https://`, regardless of per-request scheme. Removes the "HTTPS at proxy, HTTP on wire" gap.
- New middleware in `server/index.ts`: if `publicUrl` is https and the incoming request scheme is http, redirect GET 301, reject other methods with 400. Prevents accidental cookie-over-HTTP.

### A10. Documentation + security.txt

- **New `docs/security.md`**: threat model, credential handling, known limitations, deploy-publicly checklist, how to report a vulnerability.
- **New `SECURITY.md`** at repo root: disclosure process + response SLA.
- **New `server/static/.well-known/security.txt`**: RFC 9116 format.
- **Extend `docs/user-guide.md`**: new "Deploying publicly: hardening checklist" section.

### A11. E2E Step 14 — security regression tests

10 new assertions in `tests/e2e.sh`:

| # | Test | Expected |
|---|---|---|
| 14.1 | `curl -I /dashboard` has `Content-Security-Policy` | present |
| 14.2 | Has `X-Frame-Options: DENY` | present |
| 14.3 | Has `X-Content-Type-Options: nosniff` | present |
| 14.4 | Has `Referrer-Policy` | present |
| 14.5 | 15× `POST /auth/login` with wrong password | 429 by attempt #11 |
| 14.6 | Deliberately-triggered 500 response body | no `Error:` prefix, no file paths |
| 14.7 | Dashboard HTML contains NO `onclick=` attribute | (verifies A5) |
| 14.8 | LogMailer refuses to send when public_url is https://example.com | explicit 500 from mail send |
| 14.9 | Login rate limit recovers after window | attempt #11 at T+15min succeeds |
| 14.10 | Session cookie when publicUrl=https:// has `Secure` regardless of request scheme | present |

Target: **59 + 10 = 69 assertions** (Suite 5).

## Data model / config

- New env var: `OB2_TRUST_PROXY` (bool, default false).
- `Config.trustProxy` added.
- `runtime_config.ts` unchanged.

## Rollback

Every change is code / docs / config. Revert the branch → pre-hardening posture restored. No data migration.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| CSP breaks the dashboard by blocking inline scripts | A5 extracts all inline JS before enabling strict script-src |
| A3 Deno permission scope blocks a legitimate subprocess | `stty` + python paths explicitly allowed; test via reset-admin.ts |
| A7 rate limit locks out a legitimate admin during a typo flurry | 5/15min is generous; 429 message tells operator how long to wait |
| A9 https-enforce middleware breaks local dev (localhost publicUrl) | only fires when publicUrl starts with https://; localhost deploys are unaffected |
| A6 LogMailer guard false-positives on a private-IP public_url | RFC-1918 range explicitly exempted; operator using `https://10.0.0.5/` still has LogMailer work |
| Error sanitization (A4) hides legitimate diagnostics | full message still logged to stderr; client gets generic text |

## Open questions

None. Spec B handles the continuous-assurance work — dep scanning, audit log, OWASP compliance doc — separately.
