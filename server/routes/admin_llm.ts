// Provider-aware admin endpoints. Mounted at /admin/llm/* by server/routes/admin.ts.
//
// These routes wrap getProvider() so the dashboard can ignore which backend is
// active. The existing /admin/ollama/* routes stay (Ollama-only) and gain a
// soft 503 gate when OB2_LLM_PROVIDER=llamacpp — operators are pointed at
// /admin/llm/* instead.

import { Hono } from "hono";
import type { Context } from "hono";
import { getProvider } from "../llm/provider.ts";
import type { AuthContext } from "../users.ts";

type AppEnv = { Variables: { auth?: AuthContext } };

// Mirrors the private requireGlobalAdmin helpers in admin.ts and config_api.ts.
// Mutating /admin/llm/* routes are destructive operations and must be gated.
function requireGlobalAdmin(c: Context<AppEnv>): Response | null {
  const auth = c.get("auth");
  if (!auth) return c.json({ error: "not authenticated" }, 401);
  if (!auth.global_admin) return c.json({ error: "global admin required" }, 403);
  return null;
}

export function adminLlmRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // GET /admin/llm/capabilities — capability flags for the active provider.
  // Dashboard reads this once on page load to decide which controls to render.
  app.get("/capabilities", (c) => {
    const p = getProvider();
    const caps = p.capabilities ? p.capabilities() : {
      canList: false, canPull: false, canDelete: false,
      canLoad: false, canUnload: false, canWarm: false,
    };
    return c.json({ provider: p.id, capabilities: caps });
  });

  // GET /admin/llm/active — provider id + active model label.
  // Powers the status-header badge.
  app.get("/active", async (c) => {
    const p = getProvider();
    let model = "(unknown)";
    try { model = await p.activeModelLabel(); }
    catch (e) { model = `(error: ${(e as Error).message})`; }
    return c.json({ provider: p.id, model });
  });

  // GET /admin/llm/loaded — details of the currently loaded model (port, started_at).
  // Only meaningful for llamacpp; other providers return { loaded: null }.
  app.get("/loaded", async (c) => {
    const p = getProvider();
    if (!p.listLoaded) return c.json({ loaded: null });
    try {
      const entries = await p.listLoaded();
      const first = entries[0] ?? null;
      if (!first) return c.json({ loaded: null });
      return c.json({ loaded: { filename: first.name, ...(first.details as Record<string, unknown>) } });
    } catch {
      return c.json({ loaded: null });
    }
  });

  // POST /admin/llm/load — load a model on the active provider.
  // Llamacpp: proxies to manager /v1/load. Ollama: NotSupported (501).
  app.post("/load", async (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    const p = getProvider();
    if (!p.loadModel) return c.json({ error: { type: "not_supported", message: `${p.id} does not support load` } }, 501);
    const body = await c.req.json().catch(() => null) as { filename?: unknown; ctx_size?: unknown; gpu_layers?: unknown; parallel_slots?: unknown } | null;
    if (!body || typeof body.filename !== "string") {
      return c.json({ error: { type: "invalid_request_error", message: "filename required" } }, 400);
    }
    try {
      await p.loadModel(body.filename, {
        ctx_size: typeof body.ctx_size === "number" ? body.ctx_size : undefined,
        gpu_layers: typeof body.gpu_layers === "number" ? body.gpu_layers : undefined,
        parallel_slots: typeof body.parallel_slots === "number" ? body.parallel_slots : undefined,
      });
      return c.json({ ok: true });
    } catch (e) {
      const err = e as Error;
      if (err.name === "NotSupported") {
        return c.json({ error: { type: "not_supported", message: err.message } }, 501);
      }
      const msg = err.message;
      const status = msg.includes("not_found") ? 404 : msg.includes("manager_unreachable") ? 502 : 500;
      return c.json({ error: { type: "load_failed", message: msg } }, status);
    }
  });

  // POST /admin/llm/unload — unload the current model.
  app.post("/unload", async (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    const p = getProvider();
    if (!p.unloadModel) return c.json({ error: { type: "not_supported", message: `${p.id} does not support unload` } }, 501);
    const body = await c.req.json().catch(() => ({})) as { name?: unknown };
    const name = typeof body.name === "string" ? body.name : undefined;
    try {
      await p.unloadModel(name);
      return c.json({ ok: true });
    } catch (e) {
      const err = e as Error;
      if (err.name === "NotSupported") {
        return c.json({ error: { type: "not_supported", message: err.message } }, 501);
      }
      return c.json({ error: { type: "unload_failed", message: err.message } }, 500);
    }
  });

  // POST /admin/llm/pull — provider-aware pull. Streams NDJSON.
  app.post("/pull", async (c) => {
    const adminCheck = requireGlobalAdmin(c);
    if (adminCheck) return adminCheck;

    const p = getProvider();
    if (!p.pullModel) return c.json({ error: { type: "not_supported", message: `${p.id} does not support pull` } }, 501);
    const body = await c.req.json().catch(() => null) as
      | { source: "ollama"; name: string }
      | { source: "url"; url: string }
      | { source: "hf"; repo: string; file: string }
      | null;
    if (!body || typeof (body as { source?: unknown }).source !== "string") {
      return c.json({ error: { type: "invalid_request_error", message: "source required" } }, 400);
    }
    // Reject mismatched source/provider combinations.
    if (body.source === "ollama" && p.id !== "ollama") {
      return c.json({ error: { type: "invalid_request_error", message: "source=ollama requires OB2_LLM_PROVIDER=ollama" } }, 400);
    }
    if ((body.source === "url" || body.source === "hf") && p.id !== "llamacpp") {
      return c.json({ error: { type: "invalid_request_error", message: "source=url/hf requires OB2_LLM_PROVIDER=llamacpp" } }, 400);
    }

    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const emit = (frame: Record<string, unknown>) => {
          try { controller.enqueue(enc.encode(JSON.stringify(frame) + "\n")); } catch { /* downstream cancelled */ }
        };
        try {
          await p.pullModel!(body, (frame) => emit(frame as unknown as Record<string, unknown>));
        } catch (e) {
          emit({ status: "error", message: (e as Error).message });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" },
    });
  });

  // GET /admin/llm/models — provider-aware list of installed models.
  // For Ollama this returns Ollama's registry-installed models; for llamacpp
  // it returns the GGUF files in the manager's models_dir.
  app.get("/models", async (c) => {
    const p = getProvider();
    if (!p.listInstalled) return c.json({ models: [] });
    try {
      const models = await p.listInstalled();
      return c.json({ models });
    } catch (e) {
      return c.json({ error: { type: "list_failed", message: (e as Error).message } }, 500);
    }
  });

  // DELETE /admin/llm/models/:filename — delete a GGUF / Ollama model.
  // Refused if loaded (manager returns 409, surface that).
  app.delete("/models/:filename", async (c) => {
    const adminCheck = requireGlobalAdmin(c);
    if (adminCheck) return adminCheck;
    const p = getProvider();
    if (!p.deleteModel) return c.json({ error: { type: "not_supported", message: `${p.id} does not support delete` } }, 501);
    const filename = c.req.param("filename");
    if (!filename) return c.json({ error: { type: "invalid_request_error", message: "filename required" } }, 400);
    try {
      await p.deleteModel(filename);
      return c.json({ ok: true });
    } catch (e) {
      const msg = (e as Error).message;
      const status = msg.includes("in_use") ? 409 : msg.includes("not_found") ? 404 : 500;
      return c.json({ error: { type: "delete_failed", message: msg } }, status);
    }
  });

  // POST /admin/llm/restart — llamacpp-only, hits manager /v1/restart with overrides.
  app.post("/restart", async (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    const p = getProvider();
    if (p.id !== "llamacpp") {
      return c.json({ error: { type: "not_supported", message: "restart is llamacpp-only" } }, 501);
    }
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    const { getRuntime } = await import("../runtime_config.ts");
    const url = getRuntime().llamacpp.manager_url.replace(/\/+$/, "") + "/v1/restart";
    const token = Deno.env.get("OB2_LLAMACPP_MANAGER_TOKEN") || "";
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        return c.json({ error: { type: "restart_failed", message: await r.text().catch(() => "") } }, r.status);
      }
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: { type: "manager_unreachable", message: (e as Error).message } }, 502);
    }
  });

  return app;
}
