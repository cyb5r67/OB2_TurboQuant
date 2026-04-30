// OB2 server entry — wires auth, sidecar, and three route prefixes.

import { Hono } from "hono";
import { loadConfig } from "./config.ts";
import { Sidecar } from "./sidecar.ts";
import { initUsers } from "./users.ts";
import { initRuntime } from "./runtime_config.ts";
import { initSessions } from "./auth/sessions.ts";
import { initOpenwebuiSso } from "./auth/openwebui-sso.ts";
import { initFileSigning } from "./auth/file_signing.ts";
import { initJobs } from "./import/jobs.ts";
import { initMailer } from "./mail/mailer.ts";
import { sweepExpired } from "./auth/reset-tokens.ts";
import { authRoutes } from "./routes/auth.ts";
import { mcpRoutes } from "./routes/mcp.ts";
import { gatewayRoutes } from "./routes/gateway.ts";
import { adminRoutes } from "./routes/admin.ts";
import { configApiRoutes } from "./routes/config_api.ts";
import { openwebuiProxyApp } from "./proxy/openwebui.ts";
import { ensureOpenWebuiConnectionPublic, syncOpenWebuiRoles } from "./openwebui_sync.ts";

const config = loadConfig();

initRuntime(config.runtimeConfigPath);
initMailer();
await initOpenwebuiSso();
await initFileSigning();
await initJobs();

// Open WebUI boot-time sync: connection config + role reconciliation.
// Runs after initJobs() so users.ts is warm. We wait briefly for ob2-openwebui
// to be ready before writing (it may still be starting when ob2-server boots).
if (config.openwebuiEnabled) {
  (async () => {
    // Poll ob2-openwebui's /health — up to 30 × 2 s = 60 s.
    const upstream = config.openwebuiUpstream;
    for (let i = 0; i < 30; i++) {
      try {
        const r = await fetch(`${upstream}/health`);
        if (r.ok) break;
      } catch { /* not ready yet */ }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    await ensureOpenWebuiConnectionPublic(config);
    const syncStats = await syncOpenWebuiRoles();
    console.log(`openwebui sync: ${syncStats.synced} role(s) updated, ${syncStats.skipped} skipped`);
  })();
}

// Periodic token sweep — every 10 minutes. Cheap: in-memory filter + atomic
// write only if something was removed.
setInterval(() => {
  sweepExpired().catch((e) => console.error(`sweepExpired failed: ${e}`));
}, 10 * 60 * 1000);
initUsers(config);
await initSessions();
const sidecar = new Sidecar(config);
await sidecar.start();

const app = new Hono();

// HTTPS enforcement: when OB2_PUBLIC_URL is https, refuse http traffic.
// Redirect GET/HEAD to the https variant; hard-reject other methods.
app.use("*", async (c, next) => {
  const publicUrl = Deno.env.get("OB2_PUBLIC_URL") || "";
  if (!publicUrl.startsWith("https://")) {
    await next();
    return;
  }
  const xfp = c.req.header("x-forwarded-proto");
  const scheme = xfp || new URL(c.req.url).protocol.replace(":", "");
  if (scheme === "https") {
    await next();
    return;
  }
  if (c.req.method === "GET" || c.req.method === "HEAD") {
    const qs = c.req.url.includes("?") ? "?" + c.req.url.split("?", 2)[1] : "";
    return c.redirect(`${publicUrl}${c.req.path}${qs}`, 301);
  }
  return c.json({ error: "HTTPS required" }, 400);
});

// Security headers — applied to every response (including 404s). All inline
// JS was extracted to static/dashboard.js in Task A5, so script-src no longer
// needs 'unsafe-inline'. (style-src still allows 'unsafe-inline' because the
// dashboard's inline CSS block and a few style="..." attributes remain.)
app.use("*", async (c, next) => {
  await next();
  c.res.headers.set(
    "Content-Security-Policy",
    "default-src 'self'; " +
      "script-src 'self'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; " +
      "connect-src 'self'; " +
      "frame-ancestors 'none'; " +
      "base-uri 'self'; " +
      "form-action 'self'",
  );
  c.res.headers.set("X-Frame-Options", "DENY");
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  c.res.headers.set(
    "Permissions-Policy",
    "geolocation=(), microphone=(), camera=()",
  );
  // HSTS only over HTTPS — trust x-forwarded-proto if the proxy sets it.
  const xfp = c.req.header("x-forwarded-proto");
  const proto = xfp === "https" ? "https" : new URL(c.req.url).protocol;
  if (proto === "https" || proto === "https:") {
    c.res.headers.set(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains",
    );
  }
});

app.get("/health", async (c) => {
  let sidecarOk = false;
  try {
    const pong = await sidecar.call<{ pong: boolean }>("ping");
    sidecarOk = pong?.pong === true;
  } catch {
    sidecarOk = false;
  }
  return c.json({
    status: "ok",
    server: true,
    sidecar: sidecarOk,
    backend: config.storageBackend,
  });
});

app.route("/auth", authRoutes(config));
app.route("/mcp", mcpRoutes(config, sidecar));
app.route("/v1", gatewayRoutes(config, sidecar));
app.route("/admin", adminRoutes(config, sidecar));
// Config + metrics also under /admin (mounted after adminRoutes so its catch-all doesn't hijack)
app.route("/admin", configApiRoutes(config, sidecar));

// Dashboard — static HTML, no auth (auth is handled by the JS login form).
// Served no-store so updates don't get stuck behind browser cache after a
// code deploy; the files are small and come from the same origin anyway.
app.get("/dashboard", async (c) => {
  const html = await Deno.readTextFile(new URL("./static/dashboard.html", import.meta.url).pathname);
  c.header("Cache-Control", "no-store, must-revalidate");
  return c.html(html);
});

// Dashboard JS — extracted from inline <script> blocks so the CSP can forbid
// 'unsafe-inline' on script-src. Served as a sibling of /dashboard so the
// <script src="dashboard.js"> tag resolves correctly.
app.get("/dashboard.js", async (c) => {
  const js = await Deno.readTextFile(new URL("./static/dashboard.js", import.meta.url).pathname);
  c.header("Content-Type", "application/javascript; charset=utf-8");
  c.header("Cache-Control", "no-store, must-revalidate");
  return c.body(js);
});

// Full-screen graph explorer (same auth-in-JS pattern as /dashboard).
app.get("/graph", async (c) => {
  const html = await Deno.readTextFile(new URL("./static/graph.html", import.meta.url).pathname);
  c.header("Cache-Control", "no-store, must-revalidate");
  return c.html(html);
});
app.get("/graph.js", async (c) => {
  const js = await Deno.readTextFile(new URL("./static/graph.js", import.meta.url).pathname);
  c.header("Content-Type", "application/javascript; charset=utf-8");
  c.header("Cache-Control", "no-store, must-revalidate");
  return c.body(js);
});

// Vendored static assets (cytoscape.js for the LLMs/Graph viz). One file at
// a time so we don't accidentally expose anything else under server/static/.
app.get("/vendor/cytoscape.min.js", async (c) => {
  const js = await Deno.readTextFile(new URL("./static/vendor/cytoscape.min.js", import.meta.url).pathname);
  c.header("Content-Type", "application/javascript; charset=utf-8");
  c.header("Cache-Control", "public, max-age=86400");
  return c.body(js);
});
app.get("/vendor/cytoscape-euler.min.js", async (c) => {
  const js = await Deno.readTextFile(new URL("./static/vendor/cytoscape-euler.min.js", import.meta.url).pathname);
  c.header("Content-Type", "application/javascript; charset=utf-8");
  c.header("Cache-Control", "public, max-age=86400");
  return c.body(js);
});

// Friendly root redirect so http://localhost:7600 just works
app.get("/", (c) => c.redirect("/dashboard"));

app.notFound((c) => c.json({ error: "not_found" }, 404));

console.log(`OB2 listening on http://${config.host}:${config.port}`);
console.log(`  /health     liveness`);
console.log(`  /mcp/*      MCP tools`);
console.log(`  /v1/*       OpenAI-compat gateway`);
console.log(`  /admin/*    admin HTTP`);
console.log(`  /dashboard  web dashboard`);
console.log(`  storage:    ${config.storageBackend}`);

Deno.serve({ hostname: config.host, port: config.port }, app.fetch);

// Open WebUI proxy listener. Bound to a separate port so Open WebUI's HTML
// asset paths (which it emits as absolute /_app/..., /static/..., etc.) work
// without URL rewriting. SSO is handed off via signed token through the
// dashboard's /auth/openwebui-handoff endpoint.
if (config.openwebuiEnabled) {
  const proxyPort = parseInt(Deno.env.get("OB2_OPENWEBUI_PROXY_PORT") ?? "7601", 10);
  Deno.serve(
    { hostname: config.host, port: proxyPort },
    openwebuiProxyApp(config).fetch,
  );
  console.log(`  Open WebUI proxy at http://${config.host}:${proxyPort}`);
}
