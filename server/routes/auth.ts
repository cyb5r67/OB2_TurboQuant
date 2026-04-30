// Authentication routes for the dashboard (password + session cookies).
//
// Routes:
//   POST /auth/login            → {username, password}          → Set-Cookie: ob2_session
//   POST /auth/logout           → clears cookie + revokes session
//   GET  /auth/me               → returns current auth context
//   POST /auth/change-password  → {current, next} (must be authenticated)
//   POST /auth/rotate-key       → issues new API key (must be authenticated)
//
// API keys and session cookies are interchangeable for everything else — these
// routes exist so humans can acquire a session from a password.
//
// The brain-key bootstrap path: if OB2_USERS_FILE is empty and the caller
// POSTs /auth/login with username="_admin" and password = the OB2_BRAIN_KEY
// value, we mint a session for the virtual _admin user. This lets first-time
// operators log into the dashboard with the shipped credentials before
// creating real users.

import { Hono, type Context } from "hono";
import type { Config } from "../config.ts";
import {
  bearerAuthMulti,
  type AuthContext,
  verifyPassword,
  setPassword,
  rotateApiKey,
  listUsers,
  hasRealGlobalAdmin,
  findUserByEmail,
  setEmail,
  isValidEmail,
} from "../users.ts";
import {
  createSession,
  revokeSession,
  revokeUserSessions,
  buildCookie,
  clearCookie,
  SESSION_COOKIE_NAME,
} from "../auth/sessions.ts";
import { validatePasswordStrength } from "../auth/passwords.ts";
import { getMailer } from "../mail/mailer.ts";
import { renderResetEmail } from "../mail/templates.ts";
import { generateToken, consumeToken, peekToken, revokeUserTokens } from "../auth/reset-tokens.ts";
import { check as rateLimit, clientIp } from "../auth/rate-limit.ts";
import { getRuntime } from "../runtime_config.ts";

type AppEnv = { Variables: { auth?: AuthContext } };

const SESSION_TTL_SEC = 12 * 60 * 60;

function isHttps(c: Context<AppEnv>): boolean {
  // Trust X-Forwarded-Proto from the reverse proxy layer if present;
  // otherwise use the URL's own scheme.
  const xfp = c.req.header("x-forwarded-proto");
  if (xfp === "https") return true;
  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function authRoutes(config: Config): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // ── GET /auth/status ── (public, no auth)
  // Lets unauthenticated clients (the login page in particular) render
  // truthful hint text. Exposes only a boolean — no secrets.
  app.get("/status", (c) => {
    return c.json({ bootstrap_available: !hasRealGlobalAdmin() });
  });

  // ── POST /auth/login ──
  app.post("/login", async (c) => {
    let body: { username?: string; password?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const username = (body.username || "").trim();
    const password = body.password || "";
    if (!username || !password) {
      return c.json({ error: "username and password required" }, 400);
    }

    // Rate-limit before touching user state. Per-IP and per-username — both
    // must pass. Applies to every attempt regardless of outcome so brute-force
    // timing is flat.
    const ip = clientIp(c, config.trustProxy);
    const ipCheck = rateLimit(`ip:${ip}:login`, 10, 15 * 60 * 1000);
    if (!ipCheck.allowed) {
      return c.json({ error: "rate limited" }, 429);
    }
    const userCheck = rateLimit(`user:${username || "_none"}:login`, 5, 15 * 60 * 1000);
    if (!userCheck.allowed) {
      return c.json({ error: "rate limited" }, 429);
    }

    // Bootstrap: allow "_admin" + OB2_BRAIN_KEY ONLY when no real global
    // admin exists yet. Once a real global admin is provisioned, this path
    // closes. See docs/superpowers/specs/2026-04-18-close-admin-bootstrap-design.md
    if (username === "_admin") {
      if (password !== config.brainKey) {
        return c.json({ error: "invalid credentials" }, 401);
      }
      if (hasRealGlobalAdmin()) {
        return c.json({
          error:
            "bootstrap _admin is disabled because a real global admin exists. Sign in as that user instead.",
        }, 403);
      }
      const { token } = await createSession("_admin");
      const cookie = buildCookie(token, SESSION_TTL_SEC, isHttps(c));
      c.header("Set-Cookie", cookie);
      return c.json({
        ok: true,
        username: "_admin",
        global_admin: true,
        bootstrap: true,
      });
    }

    // Regular user + password verification
    const user = await verifyPassword(username, password);
    if (!user) {
      // Same error for unknown user + bad password to avoid enumeration
      return c.json({ error: "invalid credentials" }, 401);
    }

    const { token } = await createSession(user.username);
    const cookie = buildCookie(token, SESSION_TTL_SEC, isHttps(c));
    c.header("Set-Cookie", cookie);
    return c.json({
      ok: true,
      username: user.username,
      global_admin: user.global_admin,
      domains: user.domains,
    });
  });

  // ── POST /auth/forgot-password ── (public, anti-enumeration)
  app.post("/forgot-password", async (c) => {
    let body: { email?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const email = (body.email || "").trim().toLowerCase();
    if (!email) {
      return c.json({ error: "email required" }, 400);
    }
    // Rate-limit by IP and by target email
    const ip = clientIp(c, config.trustProxy);
    const ipCheck = rateLimit(`ip:${ip}`, 5, 15 * 60 * 1000);
    if (!ipCheck.allowed) {
      return c.json({ error: "rate limited" }, 429);
    }
    const userCheck = rateLimit(`user:${email}`, 3, 60 * 60 * 1000);
    if (!userCheck.allowed) {
      return c.json({ error: "rate limited" }, 429);
    }

    // Anti-enumeration: always 200.
    const mailer = getMailer();
    const publicUrl = getRuntime().mail.public_url;
    const user = findUserByEmail(email);
    if (user && user.email && mailer?.isConfigured() && publicUrl) {
      try {
        const { plaintext } = await generateToken(user.username, "reset");
        const url = `${publicUrl}/dashboard?token=${plaintext}`;
        const { subject, text, html } = renderResetEmail({
          username: user.username,
          url,
          ttlHours: 1,
        });
        await mailer.send({ to: user.email, subject, text, html });
      } catch (e) {
        console.error(`forgot-password: send failed for ${user.username}: ${(e as Error).message}`);
      }
    } else if (!mailer?.isConfigured() || !publicUrl) {
      console.warn(
        "forgot-password attempted but email infra not configured (mailer or public_url missing)",
      );
    }
    return c.json({ ok: true });
  });

  // ── POST /auth/reset-password ── (public)
  app.post("/reset-password", async (c) => {
    let body: { token?: string; new_password?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const token = (body.token || "").trim();
    const newPassword = body.new_password || "";
    if (!token) return c.json({ error: "token required" }, 400);

    // Rate-limit per token
    const tokenCheck = rateLimit(`token:${token}`, 10, 60 * 60 * 1000);
    if (!tokenCheck.allowed) {
      return c.json({ error: "rate limited" }, 429);
    }

    const err = validatePasswordStrength(newPassword);
    if (err) return c.json({ error: err }, 400);

    const result = await consumeToken(token);
    if (!result) return c.json({ error: "invalid or expired token" }, 401);

    try {
      await setPassword(result.username, newPassword);
      revokeUserSessions(result.username);
      await revokeUserTokens(result.username);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }

    if (result.kind === "invite") {
      // Auto-login for invite flow.
      const { token: sessionToken } = await createSession(result.username);
      c.header("Set-Cookie", buildCookie(sessionToken, SESSION_TTL_SEC, isHttps(c)));
      return c.json({ ok: true, auto_signed_in: true, username: result.username });
    }
    return c.json({ ok: true });
  });

  // ── GET /auth/reset-token-info ── (public, non-destructive)
  app.get("/reset-token-info", async (c) => {
    const token = c.req.query("token")?.trim() || "";
    if (!token) return c.json({ valid: false });
    // Light rate-limit so scanners don't hammer this.
    const ip = clientIp(c, config.trustProxy);
    const ipCheck = rateLimit(`info:${ip}`, 30, 5 * 60 * 1000);
    if (!ipCheck.allowed) {
      return c.json({ valid: false, rate_limited: true });
    }
    const info = await peekToken(token);
    if (!info) return c.json({ valid: false });
    return c.json({ valid: true, kind: info.kind, username: info.username });
  });

  // ── POST /auth/logout ──
  app.post("/logout", (c) => {
    const cookieHeader = c.req.header("cookie") || "";
    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`));
    if (match) revokeSession(decodeURIComponent(match[1]));
    c.header("Set-Cookie", clearCookie(isHttps(c)));
    return c.json({ ok: true });
  });

  // Authenticated routes below — use standard middleware
  const authed = new Hono<AppEnv>();
  authed.use("*", bearerAuthMulti(config));

  // ── GET /auth/me ──
  authed.get("/me", (c) => {
    const auth = c.get("auth");
    if (!auth) return c.json({ error: "not authenticated" }, 401);
    return c.json({
      username: auth.username,
      email: auth.email,
      global_admin: auth.global_admin,
      domains: auth.domains,
      // Feature flags so the dashboard can show/hide entry points.
      chat_enabled: !!(config.openwebuiEnabled && config.openwebuiServiceToken),
    });
  });

  // ── GET /auth/openwebui-handoff ──
  // Single-sign-on bridge to the Open WebUI proxy port. Browser hits this
  // (with the OB2 session cookie), we sign a one-minute handoff token, and
  // 302 the user to the Open WebUI public URL with the token in the query
  // string. The proxy on that port consumes the token and sets its own
  // longer-lived cookie. Email is required — the trusted-header SSO keys
  // every Open WebUI account by email.
  authed.get("/openwebui-handoff", async (c) => {
    const auth = c.get("auth");
    if (!auth) return c.json({ error: "not authenticated" }, 401);
    if (!config.openwebuiEnabled || !config.openwebuiServiceToken) {
      return c.json({ error: "chat is not enabled" }, 503);
    }
    if (!auth.email) {
      // Render a small landing page rather than redirecting; gives the user
      // an actionable next step instead of dropping them on the chat origin.
      const html = `<!doctype html><html><head><meta charset="utf-8">
<title>Set an email to use Chat</title>
<meta http-equiv="refresh" content="3; url=/dashboard#profile">
<style>body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;
max-width:520px;margin:6rem auto;padding:2rem;border:1px solid #334155;
border-radius:8px}a{color:#38bdf8}</style></head><body>
<h1 style="margin-top:0">Set an email to use Chat</h1>
<p>Open WebUI keys each account by email address. Add one on your profile,
then click Chat again.</p>
<p><a href="/dashboard#profile">Go to your profile →</a></p>
</body></html>`;
      return c.html(html, 400);
    }
    const { signHandoffToken } = await import("../auth/openwebui-sso.ts");
    const token = await signHandoffToken(auth.username, auth.email);
    const publicUrl = (Deno.env.get("OB2_OPENWEBUI_PUBLIC_URL") || "").replace(/\/+$/, "");
    if (!publicUrl) {
      return c.json({ error: "OB2_OPENWEBUI_PUBLIC_URL is not set" }, 503);
    }
    return c.redirect(`${publicUrl}/?_ob2_sso=${encodeURIComponent(token)}`, 302);
  });

  // ── POST /auth/email ── (authenticated — user sets their own email)
  authed.post("/email", async (c) => {
    const auth = c.get("auth");
    if (!auth) return c.json({ error: "not authenticated" }, 401);
    if (auth.username === "_admin") {
      return c.json({ error: "bootstrap admin cannot set email" }, 400);
    }
    let body: { email?: string | null };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const email = body.email === null ? null : (body.email || "").trim();
    if (email !== null && !isValidEmail(email)) {
      return c.json({ error: "invalid email format" }, 400);
    }
    try {
      setEmail(auth.username, email);
      return c.json({ ok: true, email });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // ── POST /auth/change-password ──
  authed.post("/change-password", async (c) => {
    const auth = c.get("auth");
    if (!auth) return c.json({ error: "not authenticated" }, 401);

    // The synthetic _admin user (brain-key) cannot have a password
    if (auth.username === "_admin") {
      return c.json({
        error: "bootstrap admin cannot set a password. Create a real user account first.",
      }, 400);
    }

    let body: { current?: string; next?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const next = body.next || "";
    const err = validatePasswordStrength(next);
    if (err) return c.json({ error: err }, 400);

    // If user already has a password, require the current one.
    // Use 400 (validation error) not 401 — the session is valid; only the body is wrong.
    // Returning 401 would make the browser client treat it as a session timeout and log out.
    const users = listUsers();
    const me = users.find((u) => u.username === auth.username);
    if (me) {
      const hasExisting = !!(me as { password_hash?: string }).password_hash;
      if (hasExisting) {
        const current = body.current || "";
        const ok = await verifyPassword(auth.username, current);
        if (!ok) return c.json({ error: "current password incorrect" }, 400);
      }
    }

    try {
      await setPassword(auth.username, next);
      // Invalidate all other sessions so device resets work
      revokeUserSessions(auth.username);
      // Invalidate any outstanding reset/invite tokens now that the password
      // has changed via an authenticated path.
      await revokeUserTokens(auth.username);
      // Re-issue a fresh cookie so current browser stays logged in
      const { token } = await createSession(auth.username);
      c.header("Set-Cookie", buildCookie(token, SESSION_TTL_SEC, isHttps(c)));
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // ── POST /auth/rotate-key ──
  authed.post("/rotate-key", (c) => {
    const auth = c.get("auth");
    if (!auth) return c.json({ error: "not authenticated" }, 401);
    if (auth.username === "_admin") {
      return c.json({
        error: "bootstrap admin doesn't have an API key. Create a real user account first.",
      }, 400);
    }
    try {
      const newKey = rotateApiKey(auth.username);
      return c.json({ ok: true, key: newKey });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  app.route("/", authed);
  return app;
}
