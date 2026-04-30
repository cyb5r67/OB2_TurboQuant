# OB2 Security Guide

Operator-facing threat model and hardening reference. Read this before exposing OB2 to the internet. For onboarding and everyday dashboard work, see `docs/user-guide.md`.

## 1. Threat Model

OB2 is designed to be reachable from the public internet **only** through a reverse proxy that terminates TLS and provides coarse-grained rate limiting. Direct exposure of `:7600` or `:7601` is not supported.

Working assumptions:

- **Remote attackers are well-resourced.** They can send arbitrary HTTP, script requests in parallel, and run credential-stuffing or token-guessing attacks.
- **Local operators are fully trusted.** Anyone who can `docker exec`, read `users.json` off disk, or set env vars already wins — those are intentional escape hatches.
- **The reverse proxy is trusted.** HSTS, secure-cookie, and forwarded-IP logic assume the proxy terminates TLS and rewrites `X-Forwarded-*` correctly.

## 2. Identity and Credentials

### Passwords

Hashed with **argon2id** (64 MiB memory, 3 iterations, 1 parallelism) via `hash-wasm`. Only the hash is stored in `users.json`. Comparisons go through the argon2 verifier (constant-time against the stored hash). Minimum length: 8 characters.

### Sessions

HMAC-SHA256-signed tokens, stored as the `ob2_session` cookie:

- `HttpOnly` — JS cannot read the cookie
- `SameSite=Lax` — top-level navigations allowed; cross-site POSTs blocked
- `Secure` — set when `OB2_PUBLIC_URL` starts with `https://`
- 12-hour TTL; in-memory; revoked on logout and on password change

The signing secret is `OB2_SESSION_SECRET`. If unset, a random ephemeral secret is generated at boot (restart logs everyone out). Set `OB2_SESSION_SECRET` to a persistent value in production.

### API Keys

Format: `ob2_` + 32 random hex characters (128 bits of entropy). Generated server-side at user creation or key rotation. Listings mask all but the last 4 characters; the full key is shown **once** at creation. Old keys are invalidated immediately on rotation.

### Reset and Invite Tokens

Random 32-byte tokens; only the **SHA-256 hash** is stored at rest. TTLs: 1 hour for password resets, 7 days for invites. Single-use — consumed on first successful submit.

## 3. Per-Domain ACL

Every user has a map of `{domain: permission_level}`. Permission levels are:

```
read   ->  search, chat
write  ->  capture, import (implies read)
admin  ->  delete docs, manage aliases (implies write)
global_admin  ->  all domains + user management + config
```

Enforced at every auth check via `hasPermission(auth, domain, required)`. Returning `403` exposes why: `"needs read on @netsec"`. There is no implicit access — an unlisted domain returns 403 even for global reads. Global admins bypass per-domain checks.

### Service Token + Impersonation

When `Authorization: Bearer` matches `OB2_OPENWEBUI_SERVICE_TOKEN`:

- **With `X-OpenWebUI-User-Name: <username>`** and that username resolves to an enabled user → the request runs as that user with their per-domain ACL applied.
- **Without the header** → `service_only` context: can call `/v1/models`, cannot call `/v1/chat/completions`.
- **Per-user API keys ignore the impersonation header entirely** — only the service token triggers the impersonation path.

This means Open WebUI can chat on behalf of its signed-in user, but the per-domain ACL is still the per-user ACL, not a blanket service grant.

## 4. Brain-Key Bootstrap and Retirement

`OB2_BRAIN_KEY` is a bootstrap credential, not a long-lived one.

**The moment any enabled non-`_admin` global admin exists in `users.json`, the brain key stops working everywhere:**

- `POST /auth/login` as `_admin` → 403
- `Authorization: Bearer <OB2_BRAIN_KEY>` on `/admin/*` → 401
- `x-brain-key: <OB2_BRAIN_KEY>` on `/mcp` → 401

Any live `_admin` browser sessions are evicted immediately — no "still logged in" window.

**Auto-reversible.** If every enabled non-`_admin` global admin is removed or disabled from `users.json`, the brain key re-opens for re-bootstrap. This prevents permanent lockout from a misconfigured user file.

**Break-glass:** If you lose the sole global admin password:

```bash
docker exec -it ob2-server \
  /app/.deno/bin/deno run --allow-read --allow-write --allow-env \
  /app/server/scripts/reset-admin.ts <username> \
  --password '<temp-password>' --promote
```

The script edits `users.json` in place; the server hot-reloads on mtime change. Run this once in staging before go-live.

## 5. Open WebUI SSO Chain

The dashboard's Chat link triggers a trusted-header SSO flow:

1. `GET /auth/openwebui-handoff` issues a 1-minute HMAC-signed handoff token (signed with `OB2_SESSION_SECRET`).
2. The browser is redirected to `:7601/?sso=<token>`.
3. The proxy (`proxy/openwebui.ts`) verifies the token, issues a 12-hour SSO cookie (`ob2_sso`) on the `:7601` origin, then **strips all client-supplied forwarded and OB2 headers** (preventing header injection from a hostile page).
4. On every subsequent proxied request, the proxy injects `X-Forwarded-Email: <email>` before forwarding to Open WebUI.
5. Open WebUI trusts `X-Forwarded-Email` because it is configured with `WEBUI_AUTH_TRUSTED_EMAIL_HEADER=X-Forwarded-Email` and sits behind the proxy only.

**Injection surface:** The header strip happens unconditionally at the proxy boundary. A malicious request to `:7601` carrying a fake `X-Forwarded-Email` header is overwritten with the authenticated cookie value, not passed through.

## 6. SSRF Defense

URL ingestion (`POST /admin/domains/:domain/import/url` and `capture_file` for HTTPS paths) blocks requests to internal networks:

1. Resolve the hostname to IP addresses via DNS.
2. Check each resolved IP against the CIDR denylist (`OB2_IMPORT_URL_DENYLIST`, default: `127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, ::1/128, fc00::/7`).
3. Reject **bare IP addresses** unconditionally (no DNS to check, too easy to bypass).
4. Return 403 if any resolved IP is in the denylist.

The denylist covers loopback, all RFC-1918 private ranges, link-local (AWS metadata endpoint), and IPv6 private ranges. Override with `OB2_IMPORT_URL_DENYLIST` to add custom CIDR blocks.

## 7. Magic-Byte Sniffing on Uploads

`import/sniffer.ts` reads the first bytes of every uploaded file and determines the true type regardless of the filename or `Content-Type` header. Detected types: PDF, ZIP, DOCX/PPTX/XLSX (all ZIP-wrapped Office), PNG, JPEG, TIFF, MP3, WAV, OGG, FLAC, WebM, MP4. Unknown types are processed as generic binary and handed to MarkItDown, which may produce an empty conversion.

**ZIP bomb protection:** Total uncompressed size is bounded by `OB2_IMPORT_MAX_BYTES` (default 250 MB). ZIP archives are extracted with a running byte counter; extraction stops and the job fails if the limit is exceeded.

## 8. `/data` Path Realpath Check

The `capture_file` MCP tool accepts a server-side path. Before passing it to the sidecar:

1. `Deno.realPath()` resolves symlinks.
2. The resolved path is checked to confirm it starts with `/data`.
3. Paths outside `/data` are rejected with `path_outside_volume` before any file is read.

This prevents path traversal attacks that use `../../etc/passwd` or symlinks pointing outside the volume.

## 9. Header Injection Strip (Open WebUI Proxy)

The proxy at `:7601` strips all of the following headers from incoming requests before forwarding to Open WebUI, then injects the correct values:

- `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Forwarded-Email`
- `X-OB2-*` (any OB2-internal header)
- `X-Real-IP`

This ensures a user cannot craft a request to `:7601` with a forged `X-Forwarded-Email` to impersonate another user.

## 10. Signed File Download URLs

Chat citation URLs are HMAC-SHA256-signed short-lived tokens embedded in LLM responses:

```
/admin/domains/<domain>/imports/<file_id>?t=<token>&exp=<unix_seconds>
```

Token construction: `HMAC-SHA256(OB2_SESSION_SECRET, "<domain>|<file_id>|<exp>")`.

- 24-hour TTL (configurable).
- Constant-time comparison (prevents timing attacks).
- No session cookie required — citations work from Open WebUI's cross-origin context.
- Falls back to standard session/Bearer auth for dashboard clicks.

Changing `OB2_SESSION_SECRET` invalidates all outstanding signed URLs.

## 11. HTTP Security Headers

Every response from OB2 includes:

| Header | Value |
|---|---|
| `Content-Security-Policy` | `script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; ...` |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` — **only** when `OB2_PUBLIC_URL` starts with `https://` |

**CSP caveat — `style-src` retains `'unsafe-inline'`.** The dashboard uses inline `style=` attributes for conditional per-row colors. An attacker with arbitrary style injection can deface the dashboard but cannot execute JS or access cookies. Tracked for cleanup; acceptable risk for now.

## 12. Rate Limiting

All limits are in-memory, per-process, reset on restart. Layer a reverse-proxy rate limit in front for production.

| Endpoint | Per-IP | Per-key / per-token |
|---|---|---|
| `POST /auth/login` | 10 / 15 min | 5 / 15 min per username |
| `POST /auth/forgot-password` | 5 / 15 min | 3 / 60 min per target email |
| `POST /auth/reset-password` | — | 10 / 60 min per token |

Exceeding a limit returns `429 Too Many Requests`.

## 13. Zero-Admin Rail

The raw `users.json` editor (`PUT /admin/users-raw`) and every user mutation endpoint enforce:

- You cannot remove or disable the last enabled global admin.
- You cannot save a `users.json` that contains zero enabled global admins.

This prevents an admin from accidentally locking out the entire system through the web UI. The break-glass shell script (`reset-admin.ts`) bypasses this check by design.

## 14. Public Deployment Checklist

1. **TLS terminator.** Caddy, Nginx, or Cloudflare in front of `:7600` (and `:7601` if using Open WebUI). OB2 speaks plain HTTP internally.
2. **`OB2_PUBLIC_URL=https://your-domain`.** Engages HSTS, unconditional cookie `Secure`, and HTTP→HTTPS redirect.
3. **`OB2_SESSION_SECRET`.** Set a stable, random 32+ byte value so sessions and signed URLs persist across restarts.
4. **Firewall rules.** Only 80 (redirect) + 443 reachable externally. Ports 7600, 7601, and 5433 blocked.
5. **`OB2_TRUST_PROXY=true`** only if your proxy strips client-supplied `X-Forwarded-For` before adding its own (Nginx + `real_ip`, Caddy default).
6. **Reverse-proxy rate limiting** in front of OB2's app-level limits.
7. **Break-glass smoke test.** Run `reset-admin.ts` once in staging before go-live.

## 15. Known Limitations

- **No persistent audit log.** Auth events, permission changes, and doc mutations are not recorded to disk. Deferred.
- **In-memory rate limiter resets on restart.** A restart loop resets counters. Layer proxy-level limits; don't rely solely on the app.
- **Sessions are in-memory.** Restart logs everyone out. To persist sessions, replace the backing map in `server/auth/sessions.ts` with a SQLite or Redis store.
- **No automated dependency scanning CI yet.** Run `deno check` and review Python deps manually before releases.

## 16. Reporting a Vulnerability

See `SECURITY.md` at the repository root for the disclosure contact, response SLAs, and in-scope / out-of-scope boundaries. A machine-readable pointer lives at `/.well-known/security.txt`.
