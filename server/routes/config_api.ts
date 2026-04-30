// Admin routes for runtime config, service connectivity tests, and aggregated metrics.
// Mounted at /admin/* alongside the existing admin.ts routes.
// All routes require global_admin.

import { Hono, type Context } from "hono";
import yaml from "npm:js-yaml@4.1.0";
import type { Config } from "../config.ts";
import type { Sidecar } from "../sidecar.ts";
import {
  bearerAuthMulti,
  type AuthContext,
} from "../users.ts";
import {
  dumpFileConfigYaml,
  getFileConfig,
  getEnvOverrides,
  getRuntime,
  validateRuntime,
  writeRuntime,
  runtimeConfigPath,
} from "../runtime_config.ts";
import { safeError } from "./_errors.ts";

type AppEnv = { Variables: { auth?: AuthContext } };

function requireGlobalAdmin(c: Context<AppEnv>): Response | null {
  const auth = c.get("auth");
  if (!auth) return c.json({ error: "not authenticated" }, 401);
  if (!auth.global_admin) return c.json({ error: "global admin required" }, 403);
  return null;
}

export function configApiRoutes(_config: Config, sidecar: Sidecar): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", bearerAuthMulti(_config));

  // ── GET /admin/whoami — return current user's auth context ──
  // No admin check: any authenticated user can query their own profile.
  // Dashboard uses this to decide which tabs to show.
  app.get("/whoami", (c) => {
    const auth = c.get("auth");
    if (!auth) return c.json({ error: "not authenticated" }, 401);
    return c.json({
      username: auth.username,
      global_admin: auth.global_admin,
      domains: auth.domains,
    });
  });

  // ── GET /admin/config — current config (file + env overrides + effective) ──
  app.get("/config", (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    return c.json({
      effective: getRuntime(),
      file: getFileConfig(),
      env_overrides: getEnvOverrides(),
      yaml: dumpFileConfigYaml(),
      path: runtimeConfigPath(),
    });
  });

  // ── PUT /admin/config — replace file contents (YAML body) ──
  app.put("/config", async (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;

    let body: string;
    try {
      body = await c.req.text();
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }

    let parsed: unknown;
    try {
      parsed = yaml.load(body);
    } catch (e) {
      return c.json({ error: `invalid YAML: ${(e as Error).message}` }, 400);
    }

    let validated: Partial<ReturnType<typeof getFileConfig>>;
    try {
      validated = validateRuntime(parsed);
    } catch (e) {
      return c.json({ error: `validation: ${(e as Error).message}` }, 400);
    }

    try {
      writeRuntime(validated);
      return c.json({ ok: true, effective: getRuntime() });
    } catch (e) {
      return c.json({ error: safeError(e, "internal server error") }, 500);
    }
  });

  // ── POST /admin/config/test-ollama — probe Ollama ──
  app.post("/config/test-ollama", async (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;

    const body = await c.req.json().catch(() => ({})) as { url?: string };
    const url = body.url || getRuntime().ollama.url;
    try {
      const t0 = performance.now();
      const resp = await fetch(`${url}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      const latency_ms = Math.round(performance.now() - t0);
      if (!resp.ok) {
        return c.json({ reachable: false, error: `HTTP ${resp.status}`, latency_ms });
      }
      const data = await resp.json() as { models?: Array<{ name: string; size: number }> };
      return c.json({
        reachable: true,
        url,
        latency_ms,
        models: (data.models ?? []).map((m) => ({ name: m.name, size: m.size })),
      });
    } catch (e) {
      return c.json({ reachable: false, url, error: (e as Error).message });
    }
  });

  // ── POST /admin/config/test-pgvector — probe Postgres via sidecar ──
  app.post("/config/test-pgvector", async (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    const body = await c.req.json().catch(() => ({})) as { url?: string };
    try {
      const r = await sidecar.call<Record<string, unknown>>("test_pgvector", { url: body.url ?? "" });
      return c.json(r);
    } catch (e) {
      return c.json({ reachable: false, error: (e as Error).message });
    }
  });

  // ── GET /admin/metrics — aggregated process stats ──
  app.get("/metrics", async (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;

    const [batcher, sync, classifier, domains] = await Promise.allSettled([
      sidecar.call("batcher_stats"),
      sidecar.call("sync_status"),
      sidecar.call("classifier_stats"),
      sidecar.call("knowledge_stats"),
    ]);

    const val = (r: PromiseSettledResult<unknown>): Record<string, unknown> =>
      r.status === "fulfilled"
        ? (r.value as Record<string, unknown>)
        : { error: String(r.reason).slice(0, 200) };

    return c.json({
      batcher: val(batcher),
      sync: val(sync),
      classifier: val(classifier),
      domains: val(domains),
    });
  });

  return app;
}
