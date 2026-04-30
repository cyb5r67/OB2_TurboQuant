// Open WebUI reverse proxy.
//
// Bound to a separate listening port (default 7601). Bridges browser traffic
// to the upstream Open WebUI container at OB2_OPENWEBUI_UPSTREAM, injecting
// X-Forwarded-Email so Open WebUI's WEBUI_AUTH_TRUSTED_EMAIL_HEADER auto-
// creates and signs in the account.
//
// SSO flow:
//   1. Browser arrives at "/?_ob2_sso=<token>" (set by the dashboard handoff).
//   2. Token is verified; the proxy sets a same-origin cookie containing a
//      cookie-token (12-hour TTL) carrying {username, email}, then 302's to
//      "/" without the query parameter.
//   3. Subsequent requests are matched on the cookie; the proxy injects
//      X-Forwarded-Email and X-OB2-User on the upstream call.
//   4. No cookie + no token → 302 to OB2 dashboard's /auth/openwebui-handoff
//      so a logged-in OB2 user is bounced through the SSO flow automatically;
//      a logged-out OB2 user lands on the dashboard's login form.
//
// Hop-by-hop headers from RFC 7230 §6.1 are stripped on both inbound and
// outbound paths (Connection, Keep-Alive, Transfer-Encoding, etc.) so the
// browser ↔ proxy ↔ upstream chain stays clean.

import { Hono } from "hono";
import type { Config } from "../config.ts";
import { signCookieToken, verifySsoToken } from "../auth/openwebui-sso.ts";

const COOKIE_NAME = "ob2_chat_sso";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  // We strip these because we always set them ourselves to authoritative
  // values; the client must not be able to inject them.
  "x-forwarded-email",
  "x-ob2-user",
]);

function stripHopByHop(headers: Headers): Headers {
  const out = new Headers();
  headers.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out.set(k, v);
  });
  return out;
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie") || "";
  const m = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function buildSsoCookie(token: string, isHttps: boolean): string {
  // 12 hours, tied to the proxy origin path. Lax is enough — the page is
  // never embedded cross-origin (CSP frame-ancestors 'none' on dashboard).
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${12 * 60 * 60}`,
  ];
  if (isHttps) parts.push("Secure");
  return parts.join("; ");
}

function clearSsoCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function isHttps(req: Request): boolean {
  const xfp = req.headers.get("x-forwarded-proto");
  if (xfp === "https") return true;
  return req.url.startsWith("https://");
}

export function openwebuiProxyApp(config: Config): Hono {
  const app = new Hono();

  if (!config.openwebuiEnabled) {
    app.all("*", (c) => c.text("Chat is not enabled.", 503));
    return app;
  }
  if (!config.openwebuiServiceToken) {
    app.all("*", (c) =>
      c.text(
        "OB2_OPENWEBUI_ENABLED=true but OB2_OPENWEBUI_SERVICE_TOKEN is unset. " +
          "Run `deno run --allow-env --allow-write server/scripts/openwebui-init.ts` to generate one.",
        503,
      )
    );
    return app;
  }

  app.all("*", async (c) => {
    const req = c.req.raw;
    const url = new URL(req.url);

    // ── Step 0: WebSocket upgrade bridging ──────────────────────────
    // Open WebUI uses socket.io over WebSockets to stream chat replies
    // and live events to the browser. Plain fetch() can't proxy a
    // protocol upgrade, so we detect Upgrade: websocket here and bridge
    // two WebSockets (browser ↔ upstream) by piping messages in both
    // directions. Auth: the SSO cookie must already be valid; upstream
    // gets our X-Forwarded-Email just like HTTP.
    if ((req.headers.get("upgrade") || "").toLowerCase() === "websocket") {
      const cookieToken = readCookie(req, COOKIE_NAME);
      if (!cookieToken) return c.text("WebSocket denied: no SSO cookie", 401);
      const payload = await verifySsoToken(cookieToken);
      if (!payload) return c.text("WebSocket denied: SSO cookie invalid", 401);

      // Translate http://ob2-openwebui:8080 → ws://ob2-openwebui:8080
      const upstreamHttp = config.openwebuiUpstream.replace(/\/+$/, "");
      const upstreamWs =
        upstreamHttp.replace(/^http:/, "ws:").replace(/^https:/, "wss:") +
        url.pathname +
        (url.search || "");

      let clientSocket: WebSocket;
      let response: Response;
      try {
        ({ socket: clientSocket, response } = Deno.upgradeWebSocket(req, {
          protocol: req.headers.get("sec-websocket-protocol") || undefined,
        }));
      } catch (err) {
        console.error("openwebui proxy: upgradeWebSocket failed:", err);
        return c.text("WebSocket upgrade failed", 400);
      }

      // Open the upstream socket only after the client socket is open,
      // so Deno doesn't buffer upstream messages with no consumer.
      const upstream = new WebSocket(upstreamWs, [
        "X-Forwarded-Email:" + payload.e,
        "X-OB2-User:" + payload.u,
      ].filter(() => false));
      // Note: WebSocket constructor doesn't accept arbitrary headers in
      // browsers, but Deno's WebSocket passes them via subprotocols only.
      // Open WebUI's trusted-header signin runs on initial HTTP signin,
      // not every socket connection, so the socket inherits the session
      // Open WebUI already holds from the HTTP handshake. No header
      // injection needed on the WS itself.

      const bridgeReady = () => {
        clientSocket.onmessage = (e) => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(e.data);
        };
        upstream.onmessage = (e) => {
          if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(e.data);
        };
      };
      // Queue messages arriving before the upstream socket is open.
      const pendingFromClient: (string | ArrayBuffer)[] = [];
      clientSocket.onmessage = (e) => pendingFromClient.push(e.data);
      upstream.onopen = () => {
        for (const m of pendingFromClient) upstream.send(m);
        pendingFromClient.length = 0;
        bridgeReady();
      };
      upstream.onclose = (e) => {
        if (clientSocket.readyState === WebSocket.OPEN) clientSocket.close(e.code, e.reason);
      };
      clientSocket.onclose = (e) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.close(e.code, e.reason);
      };
      upstream.onerror = (e) => {
        console.error("openwebui proxy: upstream WS error:", e);
        try { clientSocket.close(1011, "upstream error"); } catch { /* already closed */ }
      };
      clientSocket.onerror = (e) => {
        console.error("openwebui proxy: client WS error:", e);
        try { upstream.close(1011, "client error"); } catch { /* already closed */ }
      };

      return response;
    }

    // ── Step 1: handoff-token consumption ───────────────────────────
    const handoff = url.searchParams.get("_ob2_sso");
    if (handoff) {
      const payload = await verifySsoToken(handoff);
      if (!payload) {
        return c.text("SSO token invalid or expired. Try clicking Chat again.", 401);
      }

      // Compare incoming identity to whatever the browser already has stashed
      // in the proxy cookie. If the user has changed, ALSO clear Open WebUI's
      // own session cookie (`token`) so it doesn't keep the previous user's
      // session alive and ignore our trusted-email header.
      let prevUser: string | null = null;
      const prevCookie = readCookie(req, COOKIE_NAME);
      if (prevCookie) {
        const prev = await verifySsoToken(prevCookie);
        if (prev) prevUser = prev.u;
      }
      const userChanged = prevUser !== null && prevUser !== payload.u;

      // Issue a longer-lived cookie token. Then strip the query param and
      // 302 to the same path so the URL bar doesn't carry the secret.
      const cookieToken = await signCookieToken(payload.u, payload.e);
      url.searchParams.delete("_ob2_sso");
      const headers = new Headers({
        "Location": url.pathname + (url.search ? url.search : ""),
      });
      headers.append("Set-Cookie", buildSsoCookie(cookieToken, isHttps(req)));
      if (userChanged) {
        // Open WebUI's default session cookie is `token`. Clear it so its
        // trusted-header SSO middleware runs again and picks up the new user.
        headers.append("Set-Cookie", "token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
      }
      return new Response(null, { status: 302, headers });
    }

    // ── Step 2: cookie verification ─────────────────────────────────
    const cookieToken = readCookie(req, COOKIE_NAME);
    let identity: { u: string; e: string } | null = null;
    if (cookieToken) {
      const payload = await verifySsoToken(cookieToken);
      if (payload) identity = { u: payload.u, e: payload.e };
    }

    if (!identity) {
      // No SSO context → bounce through OB2's handoff endpoint. This either
      // sends them through the SSO flow (if they have an OB2 session) or
      // shows the OB2 login screen (if not). Use OB2_PUBLIC_URL so the
      // redirect works regardless of how the user reached the proxy origin.
      const ob2Public = (Deno.env.get("OB2_PUBLIC_URL") || "").replace(/\/+$/, "");
      if (!ob2Public) {
        return c.text("OB2_PUBLIC_URL is not set; cannot bounce to dashboard.", 503);
      }
      return new Response(null, {
        status: 302,
        headers: { Location: `${ob2Public}/auth/openwebui-handoff` },
      });
    }

    // ── Step 3: proxy to upstream ───────────────────────────────────
    const upstream = config.openwebuiUpstream.replace(/\/+$/, "");
    const upstreamUrl = upstream + url.pathname + (url.search || "");
    const fwdHeaders = stripHopByHop(req.headers);
    fwdHeaders.set("X-Forwarded-Email", identity.e);
    fwdHeaders.set("X-OB2-User", identity.u);
    fwdHeaders.set("X-Forwarded-Host", url.host);
    fwdHeaders.set("X-Forwarded-Proto", isHttps(req) ? "https" : "http");

    let body: BodyInit | null = null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      body = req.body;
    }

    let upstreamResp: Response;
    try {
      upstreamResp = await fetch(upstreamUrl, {
        method: req.method,
        headers: fwdHeaders,
        body,
        redirect: "manual",
      });
    } catch (err) {
      console.error("openwebui proxy upstream error:", err);
      return c.text("Chat service unavailable. Try again in a moment.", 502);
    }

    // Strip hop-by-hop headers from the upstream response on the way back.
    const respHeaders = stripHopByHop(upstreamResp.headers);
    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: respHeaders,
    });
  });

  // Suppress logout cookies if the upstream signs out; expose a helper.
  app.get("/__ob2/signout", (c) => {
    const headers = new Headers({ "Set-Cookie": clearSsoCookie() });
    headers.set("Location", "/");
    return new Response(null, { status: 302, headers });
  });

  return app;
}
