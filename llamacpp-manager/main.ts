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
import { LlamaSupervisor } from "./process.ts";
import { readLoaded, writeLoaded, clearLoaded } from "./state.ts";

const VERSION = "0.1.0-phase2";
const STARTED_AT = Date.now();

const managerPort = Number(Deno.env.get("OB2_LLAMACPP_MANAGER_PORT") || "8081");
const modelsDir = Deno.env.get("OB2_LLAMACPP_MODELS_DIR") || "/data/llamacpp/models";
const chatPort = Number(Deno.env.get("OB2_LLAMACPP_CHAT_PORT") || "8080");
const llamaBinary = Deno.env.get("OB2_LLAMA_SERVER_BIN") || "/usr/local/bin/llama-server";

const supervisor = new LlamaSupervisor({
  binary: llamaBinary,
  preArgs: [],
  modelsDir,
  chatPort,
});

const app = new Hono();

// /healthz — no auth required (used by Docker healthcheck).
app.get("/healthz", (c) =>
  c.json({
    ok: true,
    version: VERSION,
    uptime_sec: Math.floor((Date.now() - STARTED_AT) / 1000),
    llama_server: supervisor.getState(),
  }));

// All other routes require auth.
app.use("/v1/*", bearerAuth());

// /v1/models — refresh `loaded` from supervisor state.
app.get("/v1/models", async (c) => {
  const state = supervisor.getState();
  const loadedFilename = state.running ? state.model ?? null : null;
  const models = await scan(modelsDir, loadedFilename);
  const loaded = state.running
    ? { filename: state.model, port: state.port, started_at: state.started_at }
    : null;
  return c.json({ models, loaded });
});

interface LoadBody {
  filename?: unknown;
  ctx_size?: unknown;
  gpu_layers?: unknown;
  parallel_slots?: unknown;
}

function isSafeFilename(name: unknown): name is string {
  return typeof name === "string"
    && name.length > 0
    && name.length <= 256
    && !name.includes("/")
    && !name.includes("\\")
    && !name.includes("..")
    && name.endsWith(".gguf");
}

let loadMutex: Promise<unknown> = Promise.resolve();

app.post("/v1/load", async (c) => {
  const body = await c.req.json().catch(() => null) as LoadBody | null;
  if (!body || !isSafeFilename(body.filename)) {
    return c.json({ error: { type: "invalid_request_error", message: "filename required (.gguf, no path)" } }, 400);
  }
  const filename = body.filename;
  const stat = await Deno.stat(`${modelsDir}/${filename}`).catch(() => null);
  if (!stat || !stat.isFile) {
    return c.json({ error: { type: "not_found", message: `${filename} not found in models_dir` } }, 404);
  }
  const ctx_size = typeof body.ctx_size === "number" ? body.ctx_size : Number(Deno.env.get("OB2_LLAMACPP_CTX_SIZE") || "8192");
  const gpu_layers = typeof body.gpu_layers === "number" ? body.gpu_layers : Number(Deno.env.get("OB2_LLAMACPP_GPU_LAYERS") || "-1");
  const parallel_slots = typeof body.parallel_slots === "number" ? body.parallel_slots : Number(Deno.env.get("OB2_LLAMACPP_PARALLEL_SLOTS") || "1");

  // Serialize concurrent loads.
  const op = loadMutex.then(async () => {
    if (supervisor.getState().running) {
      await supervisor.kill();
    }
    await supervisor.spawn({ filename, ctx_size, gpu_layers, parallel_slots });
    try {
      await supervisor.awaitHealth(60_000);
    } catch (err) {
      await supervisor.kill();
      throw err;
    }
    await writeLoaded(modelsDir, {
      filename, ctx_size, gpu_layers, parallel_slots,
      port: chatPort,
      started_at: new Date().toISOString(),
    });
  });
  loadMutex = op.catch(() => {});
  try {
    await op;
  } catch (err) {
    return c.json({
      error: {
        type: "spawn_failed",
        message: (err as Error).message,
        stderr_tail: supervisor.getStderrTail().slice(-1024),
      },
    }, 500);
  }
  const state = supervisor.getState();
  return c.json({
    ok: true,
    loaded: {
      filename: state.model,
      ctx_size,
      gpu_layers,
      parallel_slots,
      port: state.port,
      started_at: state.started_at,
    },
  });
});

app.post("/v1/unload", async (c) => {
  // Same mutex as /v1/load and /v1/restart so a concurrent load doesn't see
  // its child killed underneath it (which would surface as a confusing
  // spawn_failed instead of a clean "unloaded mid-load").
  const op = loadMutex.then(async () => {
    if (supervisor.getState().running) await supervisor.kill();
    await clearLoaded(modelsDir);
  });
  loadMutex = op.catch(() => {});
  await op;
  return c.json({ ok: true });
});

interface RestartBody {
  ctx_size?: unknown;
  gpu_layers?: unknown;
  parallel_slots?: unknown;
}

app.post("/v1/restart", async (c) => {
  const cur = await readLoaded(modelsDir);
  if (!cur) {
    return c.json({ error: { type: "invalid_state", message: "nothing loaded to restart" } }, 400);
  }
  const body = await c.req.json().catch(() => ({})) as RestartBody;
  const ctx_size = typeof body.ctx_size === "number" ? body.ctx_size : cur.ctx_size;
  const gpu_layers = typeof body.gpu_layers === "number" ? body.gpu_layers : cur.gpu_layers;
  const parallel_slots = typeof body.parallel_slots === "number" ? body.parallel_slots : cur.parallel_slots;

  const op = loadMutex.then(async () => {
    if (supervisor.getState().running) await supervisor.kill();
    await supervisor.spawn({ filename: cur.filename, ctx_size, gpu_layers, parallel_slots });
    try {
      await supervisor.awaitHealth(60_000);
    } catch (err) {
      await supervisor.kill();
      throw err;
    }
    await writeLoaded(modelsDir, {
      filename: cur.filename, ctx_size, gpu_layers, parallel_slots,
      port: chatPort,
      started_at: new Date().toISOString(),
    });
  });
  loadMutex = op.catch(() => {});
  try { await op; }
  catch (err) {
    return c.json({
      error: { type: "spawn_failed", message: (err as Error).message, stderr_tail: supervisor.getStderrTail().slice(-1024) },
    }, 500);
  }
  const state = supervisor.getState();
  return c.json({
    ok: true,
    loaded: {
      filename: state.model, ctx_size, gpu_layers, parallel_slots,
      port: state.port, started_at: state.started_at,
    },
  });
});

console.log(`ob2-llamacpp-manager v${VERSION} listening on :${managerPort}`);
Deno.serve({ port: managerPort }, app.fetch);
