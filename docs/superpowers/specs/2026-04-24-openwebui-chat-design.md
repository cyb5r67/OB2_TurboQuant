# Open WebUI as OB2's Chat Surface

**Date:** 2026-04-24
**Status:** Draft for review

## Background

OB2 has a working OpenAI-compatible chat endpoint (`/v1/chat/completions`) with classifier auto-routing, retrieval injection, and per-user domain ACL. The dashboard has no built-in chat interface; users today need a third-party OpenAI-compatible client. We want a polished chat experience for logged-in users that includes per-user conversation history, custom system prompts, and other quality-of-life features without building a chat UI from scratch.

[Open WebUI](https://github.com/open-webui/open-webui) is a self-hosted ChatGPT-style web UI for Ollama and OpenAI-compatible backends. It already ships per-user chat history, custom prompts, model selection, conversation export, and more. Integrating it as OB2's chat surface saves us months of UI work.

## Goals

- A logged-in OB2 user clicks "Chat" in the dashboard nav and lands in Open WebUI, already authenticated as themselves.
- Conversations and per-user settings persist across sessions, owned by Open WebUI.
- Every chat message that hits the LLM still goes through `/v1/chat/completions`, so the classifier, retrieval, and per-domain ACL we just built keep working — *as the actual logged-in user*, not as a shared service identity.
- No new credentials for users to manage. They never paste an API key into Open WebUI.

## Non-goals

- No re-implementing chat in `dashboard.js`.
- No syncing Open WebUI's chat history back into OB2's storage.
- No restyling Open WebUI's UI to look like the dashboard. The Chat surface is allowed to look like Open WebUI; only the route there starts in OB2.
- Not exposing Ollama directly to browsers. All LLM traffic still flows through `/v1/chat/completions`.
- No OIDC. Trusted-header SSO is enough.
- No mobile app or native UI considerations beyond what Open WebUI already provides.

## Design

### Topology

A new container `ob2-openwebui` joins `docker/docker-compose.yml`. OB2's existing process binds a **second listener on port 7601** that reverse-proxies to `ob2-openwebui:8080`. The dashboard's "Chat" link sends the user through `/auth/openwebui-handoff` on the main port, which signs a one-minute SSO token and 302s the browser to `:7601` with the token in the query string. The proxy on `:7601` consumes the token, sets a 12-hour cookie scoped to the proxy origin, then injects `X-Forwarded-Email` + `X-OB2-User` on every onward request.

A second listener (rather than mounting Open WebUI under `/chat/*` on the main port) avoids URL rewriting: Open WebUI emits absolute paths like `/_app/...` and `/api/v1/...` for its own assets and APIs, and at root those paths resolve correctly. The two-port approach also keeps OB2's tight CSP intact on the dashboard origin without needing a per-path exception.

```
Browser
  │
  ├─ :7600 ─►┌──── ob2-server (main listener) ─────────────┐
  │          │  /dashboard, /admin, /v1, /mcp, /auth        │
  │          │  /auth/openwebui-handoff: signed SSO token   │
  │          │                                              │
  │          │  /v1/chat/completions — gains impersonation: │
  │          │     Bearer = OB2_OPENWEBUI_SERVICE_TOKEN     │
  │          │     AND X-OB2-User header present            │
  │          │     → ACL applies as that user               │
  │          └──────────────────────────────────────────────┘
  │
  └─ :7601 ─►┌──── ob2-server (chat-proxy listener) ───────┐
             │  Verifies SSO token / cookie                 │
             │  Bounces to dashboard if no session          │
             │  Forwards to ob2-openwebui:8080 with         │
             │     X-Forwarded-Email + X-OB2-User injected  │
             └──────────────────────────────────────────────┘
                              │
                              ▼
              ┌───── ob2-openwebui (not host-published) ──────┐
              │  Image: ghcr.io/open-webui/open-webui:main    │
              │  WEBUI_AUTH_TRUSTED_EMAIL_HEADER=X-Forwarded-Email │
              │  WEBUI_AUTH_TRUSTED_NAME_HEADER=X-OB2-User     │
              │  ENABLE_SIGNUP=false                           │
              │  OPENAI_API_BASE_URL=http://ob2-server:7600/v1 │
              │  OPENAI_API_KEY=$OB2_OPENWEBUI_SERVICE_TOKEN   │
              │  Persists per-user history + settings in      │
              │  /app/backend/data (volume: ob2_openwebui_data)│
              └────────────────────────────────────────────────┘
```

### Single sign-on flow

1. User logs into the OB2 dashboard. Session cookie set as today.
2. User clicks the new **Chat** link in the dashboard nav. Browser navigates to `/auth/openwebui-handoff` on port 7600.
3. The handoff endpoint (auth-required):
   - If the user has no email set → returns a small "Set an email to use Chat" landing page that auto-redirects to the Profile tab. (We don't silently fail the SSO; the user gets an actionable next step.)
   - Otherwise signs a one-minute HMAC token containing `{username, email, exp}` and 302s the browser to `${OB2_OPENWEBUI_PUBLIC_URL}/?_ob2_sso=<token>`.
4. The proxy listener on port 7601 sees the token in the query string, verifies the HMAC, mints a 12-hour cookie token, sets it as `ob2_chat_sso` (HttpOnly, SameSite=Lax, Path=/), and 302s to the same URL minus the token (so the secret doesn't sit in browser history).
5. Subsequent requests to port 7601 carry the cookie. The proxy verifies it on each request, strips any inbound `X-Forwarded-Email`, `X-OB2-User`, or `Authorization` header (defense against header-injection), and forwards to `ob2-openwebui:8080` with `X-Forwarded-Email: <user.email>` and `X-OB2-User: <user.username>` set from the verified payload.
6. Open WebUI's trusted-header middleware reads `X-Forwarded-Email`. First visit → auto-creates a local account keyed by that email. Subsequent visits → signs in the existing account.
7. If a request reaches port 7601 with no SSO cookie and no token → 302 to `${OB2_PUBLIC_URL}/auth/openwebui-handoff`. A logged-in OB2 user is bounced through SSO; an unauthenticated user gets the dashboard's login screen.

### Per-user OB2 API key on outbound `/v1` calls

Open WebUI is configured with a single **service token** stored in the OB2 environment as `OB2_OPENWEBUI_SERVICE_TOKEN`. The service token is a new credential type with these properties:

- Same byte shape as a user API key (`ob2_<32-hex>`).
- Stored as a hash on disk; plaintext lives only in the service environment.
- Belongs to a virtual user record `_openwebui` with `service: true`, `enabled: true`, `domains: {}`, `global_admin: false`.
- On its own, the token grants **no** access — every domain check fails. Its only purpose is the impersonation handshake below.

When `/v1/chat/completions` (and `/v1/models`) sees an inbound request:

| Bearer | `X-OB2-User` header | Behavior |
|---|---|---|
| Service token | Present, resolves to an enabled non-service user | Auth context is built from that user. Request proceeds as if they called directly. ACL applies to *them*. |
| Service token | Missing, malformed, or names a disabled/unknown user | 403 with body `{"error":{"message":"impersonation requires a valid X-OB2-User header","type":"authentication_error"}}` |
| User API key | Anything | `X-OB2-User` is ignored. Today's behavior preserved. |
| Brain key (bootstrap-still-open mode only) | Anything | Today's behavior preserved. |

The impersonation path is gated to the service token alone; user API keys cannot impersonate. Because Open WebUI is the only thing holding the service token (it lives in the container's env), the only way `X-OB2-User` ever gets on the wire is from the trusted reverse proxy.

### Reverse-proxy implementation

A new module `server/proxy/openwebui.ts` mounts under `app.all("/chat/*")`. It:

- Reads the OB2 session via the same `bearerAuthMulti` middleware used by `/admin/*`, but accepts session cookies (not just bearer tokens).
- Strips inbound trusted headers and Authorization (security).
- Sets `X-Forwarded-Email`, `X-OB2-User`, and forwards to `http://ob2-openwebui:8080` preserving method, body, and remaining headers.
- Streams responses (Open WebUI uses chunked transfer + WebSockets for live tokens). For HTTP, fetch + ReadableStream piping; for WebSocket upgrades, a dedicated handler that bridges client ↔ upstream sockets.
- Rewrites `Set-Cookie` paths so Open WebUI's session cookie is scoped to `/chat/`.

The OB2 server's existing CSP must be relaxed for `/chat/*` only — Open WebUI ships its own asset bundle with hashes/inline styles that won't pass our strict policy. The proxy emits a permissive CSP just for that path; the rest of OB2 keeps its tight policy.

### Models endpoint behavior under impersonation

`/v1/models` already lists `ob2` and `ob2-<domain>` for each domain. Under impersonation, the model list reflects the impersonated user's effective domain access (admins see all; non-admins see only their assigned domains' `ob2-<domain>` entries plus generic `ob2`). This way Open WebUI's model dropdown shows only the choices the user can actually use — same scoping principle we applied to the dashboard's Domains tab.

### Settings & history

Open WebUI owns these. Per-user chat history, custom system prompts, model defaults, conversation rename/delete/export, custom personas — all stored in `/app/backend/data` inside the container, persisted to the `ob2_openwebui_data` Docker volume. We don't touch them.

### Model availability

We pin Open WebUI's `OPENAI_API_BASE_URL` to OB2's `/v1`, so the model dropdown is populated by `/v1/models`. Today that lists `ob2` (generic) plus `ob2-<domain>` per domain. That's enough; we do not add raw `gemma3:4b` etc. to the dropdown. If you later want users to pick between Gemma sizes, the right move is to extend OB2's `/v1/models` to also list direct Ollama models — out of scope for this spec.

### Look & feel

The dashboard nav gains a "Chat" link styled like other tabs. Clicking it navigates the full window (not an iframe) to `/chat`. Open WebUI's UI takes over the viewport. A small "← Back to OB2" link is injected as a tiny corner overlay via the proxy's HTML rewrite — implemented by appending one `<a>` element with absolute positioning before `</body>` in the `/chat/` (root path) HTML response only. No deep DOM surgery.

### Logout coordination

Logging out of OB2 (`POST /auth/logout`) should also invalidate the Open WebUI session, otherwise a kiosk-mode user could stay in chat after "logging out." On `/auth/logout`, OB2 also fires a best-effort request to Open WebUI's signout endpoint (resolved against the upstream's API spec at implementation time — Open WebUI exposes `/api/v1/auths/signout` and we'll verify) carrying the impersonated session. If Open WebUI returns an error, OB2's logout still succeeds.

## Configuration

New env vars in `.env` and `docker/docker-compose.yml`:

| Var | Purpose | Default |
|---|---|---|
| `OB2_OPENWEBUI_ENABLED` | Master toggle. When `false`, the proxy listener is not bound, `/auth/openwebui-handoff` returns 503, and the dashboard hides the Chat link. | `false` |
| `OB2_OPENWEBUI_SERVICE_TOKEN` | The service-token plaintext. Generated once and persisted to `.env`. | (none — generated by `server/scripts/openwebui-init.ts` on first run) |
| `OB2_OPENWEBUI_UPSTREAM` | Upstream URL for the proxy to forward to. | `http://ob2-openwebui:8080` |
| `OB2_OPENWEBUI_PROXY_PORT` | Port the proxy listener binds. | `7601` |
| `OB2_OPENWEBUI_PUBLIC_URL` | URL the dashboard's Chat link bounces the browser to (carrying the SSO token). Must reach the proxy port. | `http://localhost:7601` |

The new compose service:

```yaml
ob2-openwebui:
  image: ghcr.io/open-webui/open-webui:main
  container_name: ob2-openwebui
  restart: unless-stopped
  environment:
    WEBUI_AUTH_TRUSTED_EMAIL_HEADER: X-Forwarded-Email
    WEBUI_AUTH_TRUSTED_NAME_HEADER: X-OB2-User
    ENABLE_SIGNUP: "false"
    OPENAI_API_BASE_URL: http://ob2-server:7600/v1
    OPENAI_API_KEY: ${OB2_OPENWEBUI_SERVICE_TOKEN}
    WEBUI_URL: ${OB2_PUBLIC_URL}/chat
  volumes:
    - ob2_openwebui_data:/app/backend/data
  depends_on:
    ob2-server:
      condition: service_healthy
```

`ob2-openwebui` does not expose ports to the host. Browsers reach it only through OB2's `/chat/*` proxy, so the trusted-header SSO can never be bypassed by hitting the container directly.

## Files touched

| File | Change |
|---|---|
| `docker/docker-compose.yml` | New `ob2-openwebui` service + volume `ob2_openwebui_data`. |
| `.env.example` | New `OB2_OPENWEBUI_*` vars documented. |
| `server/index.ts` | Conditional mount of `/chat/*` proxy when `OB2_OPENWEBUI_ENABLED=true`. |
| `server/proxy/openwebui.ts` | New. HTTP + WebSocket reverse proxy with header injection. |
| `server/users.ts` | New service-user concept: `_openwebui` virtual record, `service: true` flag on `UserRecord`, helper `resolveServiceImpersonation(token, headerUser)`. |
| `server/routes/gateway.ts` | Apply impersonation resolution at the top of `/v1/*` routes; rewrite `auth` context when service-token + `X-OB2-User` checks pass. Filter `/v1/models` by impersonated user's domains. |
| `server/routes/auth.ts` | On `POST /auth/logout`, fire-and-forget Open WebUI signout. |
| `server/static/dashboard.html` | New `Chat` link in `<nav>`, hidden by default. |
| `server/static/dashboard.js` | After login, the existing `/auth/me` response is extended with `chat_enabled: boolean` (true iff `OB2_OPENWEBUI_ENABLED=true`). The dashboard shows the Chat link iff `chat_enabled` is true. Also adds a profile-tab nudge "Set an email to use Chat" when `chat_enabled` is true and the user has no email. |
| `server/scripts/openwebui-init.ts` | New. One-shot script that generates a service token, writes it to `.env`, and exits. |
| `tests/e2e.sh` | New Step 17: feature-flag off → /chat returns 404; feature-flag on + no session → 302 to login; feature-flag on + valid session + email set → 200 with Open WebUI HTML; impersonation: service-token + X-OB2-User as alice → /v1/chat/completions sees alice's ACL; service-token without X-OB2-User → 403. |

No changes to: sidecars, retrieval, classifier (the impersonation is invisible to them — the auth context just reflects the impersonated user).

## Error handling

| Situation | Behavior |
|---|---|
| User clicks Chat without an email set | Proxy returns a small HTML page: "Set an email on your Profile to use Chat" with a link to `/dashboard#profile`. |
| User clicks Chat without a session | 302 to `/dashboard?next=/chat`; after login, dashboard JS forwards them. |
| Open WebUI container down | Proxy returns 503 with "Chat service unavailable. Try again in a moment." |
| Service token missing or empty in env | OB2 boots normally with `OB2_OPENWEBUI_ENABLED=false` forced (logged warning); Chat link hidden. |
| Inbound request to `/chat/*` carries a user-supplied `X-Forwarded-Email` or `X-OB2-User` | Headers stripped before forwarding. The proxy never trusts client-supplied trusted-header values. |
| Service token leaks (defense-in-depth) | Even with the token, an attacker cannot read any domain — the impersonation step requires a valid `X-OB2-User` for an enabled, non-service user, and the token's own ACL is empty. |
| User disabled mid-conversation | Next `/v1/chat/completions` returns 403 (`enabled: false` rejected by `_resolveAuth`). Open WebUI shows the error inline. |
| User's domain access removed mid-conversation | Same as today — `users.json` mtime hot-reload picks it up; next request 403s if no domains and no prefix. |

## Testing

**`tests/e2e.sh` Step 17 (new — Step 16 is Rust parity):**

The step requires both `ob2-server` and `ob2-openwebui` containers up. If `OB2_OPENWEBUI_ENABLED` is not `true`, all assertions SKIP cleanly.

1. **Flag off:** With `OB2_OPENWEBUI_ENABLED=false`, `GET /chat` returns 404. Confirms the proxy is not mounted by default.
2. **Flag on, no session:** With the flag on, anonymous `GET /chat` returns 302 to `/dashboard?next=/chat`.
3. **Flag on, session present, email set:** As bob (admin, has email), `GET /chat` returns 200 with HTML containing Open WebUI's marker (e.g., `<title>Open WebUI`).
4. **Flag on, session present, no email:** As a freshly-created user without an email, `GET /chat` returns 200 with the "Set an email" page (HTML body contains "Set an email").
5. **Impersonation happy path:** Direct call to `/v1/chat/completions` with `Authorization: Bearer <service-token>` + `X-OB2-User: alice`. Alice has `netsec:read`. Use a `@netsec` prefixed prompt. Assert HTTP 200 and the response references netsec content. (This is the assertion that proves the impersonation handshake works.)
6. **Impersonation no header:** Same call, no `X-OB2-User`. Assert HTTP 403 with `"authentication_error"`.
7. **Impersonation invalid user:** Same call, `X-OB2-User: nonexistent`. Assert HTTP 403.
8. **Impersonation bypass attempt:** Direct call to `/v1/chat/completions` with `Authorization: Bearer <alice's user key>` + `X-OB2-User: bob` (try to escalate). Assert: behavior is alice's, not bob's — the header is ignored when the bearer is a user key, not a service token.
9. **Models scoping under impersonation:** Service-token + `X-OB2-User: alice` → `GET /v1/models` returns only `ob2` and `ob2-netsec` (alice's only domain). Service-token + `X-OB2-User: bob` (admin) → returns full list.
10. **Header scrubbing:** Anonymous `GET /chat` with `X-Forwarded-Email: attacker@evil.com`. Assert 302 (no SSO bypass possible since no session).

**Manual smoke (browser, post-deploy):**

- Log into dashboard as bob → click Chat → land in Open WebUI logged in as bob → start a conversation → reload page → conversation still there → log out of OB2 → revisit `/chat` → redirected to login.
- Log in as alice → Chat → only the domains alice has access to appear in the model dropdown.
- Disable a user mid-session via /admin/users → their next message in Open WebUI surfaces a 403.

## Risks & open questions

- **Open WebUI version drift.** Pinning to `:main` is convenient but risky if upstream changes the trusted-header semantics. Pin to a specific tag (e.g., `:0.x.y`) and bump it deliberately.
- **WebSocket proxying in Hono.** Hono's edge-runtime focus means WebSocket upgrade handling is a known sharp edge. If the standard pattern doesn't work cleanly, we fall back to long-poll/SSE for token streaming, which Open WebUI already supports.
- **CSP relaxation under `/chat/*`.** Necessary, but it must not bleed to other paths. The proxy emits its own CSP header; the global middleware must not also emit one for that path.
- **Storage volume.** `ob2_openwebui_data` holds chat history. Backups become a thing the operator needs to think about. Not solved by this spec.
