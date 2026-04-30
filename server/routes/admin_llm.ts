// Provider-aware admin endpoints. Mounted at /admin/llm/* by server/routes/admin.ts.
//
// These routes wrap getProvider() so the dashboard can ignore which backend is
// active. The existing /admin/ollama/* routes stay (Ollama-only) and gain a
// soft 503 gate when OB2_LLM_PROVIDER=llamacpp — operators are pointed at
// /admin/llm/* instead.

import { Hono } from "hono";
import { getProvider } from "../llm/provider.ts";

export function adminLlmRoutes(): Hono {
  const app = new Hono();

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

  return app;
}
