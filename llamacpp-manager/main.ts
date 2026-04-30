// ob2-llamacpp-manager — supervises a single llama-server process and
// exposes the control-plane HTTP API documented in
// docs/superpowers/specs/2026-04-30-llamacpp-provider-design.md §3.
//
// Boot:
//   1. Read env (manager port, models dir, etc.).
//   2. Set up Hono routes (added in later tasks).
//   3. If <models_dir>/.last_loaded.json exists, restore the previous load.
//   4. Listen on the manager port.

import { Hono } from "hono";
import { bearerAuth } from "./auth.ts";
import { scan } from "./models.ts";

const VERSION = "0.1.0-phase2";
const STARTED_AT = Date.now();

const managerPort = Number(Deno.env.get("OB2_LLAMACPP_MANAGER_PORT") || "8081");
const modelsDir = Deno.env.get("OB2_LLAMACPP_MODELS_DIR") || "/data/llamacpp/models";

const app = new Hono();

// /healthz — no auth required (used by Docker healthcheck).
app.get("/healthz", (c) =>
  c.json({
    ok: true,
    version: VERSION,
    uptime_sec: Math.floor((Date.now() - STARTED_AT) / 1000),
    llama_server: { running: false }, // populated by Task 4
  }));

// All other routes require auth.
app.use("/v1/*", bearerAuth());

// Routes added in Tasks 2, 4, 5–8 register themselves here.

app.get("/v1/models", async (c) => {
  // loadedFilename comes from state (Task 3); for this task it's always null.
  const loadedFilename: string | null = null;
  const models = await scan(modelsDir, loadedFilename);
  return c.json({ models, loaded: null });
});

console.log(`ob2-llamacpp-manager v${VERSION} listening on :${managerPort}`);
Deno.serve({ port: managerPort }, app.fetch);
