# llama.cpp Provider — Phase 3: Dashboard Provider-Awareness Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OB2_TurboQuant's dashboard fully provider-aware — operators can flip the LLM provider via a Config-tab radio, see the active model in the status header, and manage llama.cpp models (load/unload/pull/delete) through the LLMs tab without dropping to curl. Phase 1 deferred `admin.ts` refactoring to this phase; Phase 3 also lands provider-aware admin endpoints behind `/admin/llm/*`.

**Architecture:** Backend adds a new `/admin/llm/*` route surface alongside the existing `/admin/ollama/*` routes (spec-mandated: Ollama path stays bit-for-bit unchanged for today's deployments). Existing Ollama-specific routes gain a soft gate: when `OB2_LLM_PROVIDER=llamacpp`, they return 503 with a "switch to /admin/llm/* or change OB2_LLM_PROVIDER" message. The dashboard reads `/admin/llm/capabilities` once on page load and switches the LLMs tab into one of two modes (Ollama-classic vs llamacpp). Status header gets a small provider badge. Config tab gets a provider radio and a Classifier section that resolves the cross-provider matrix.

**Tech Stack:** Deno + Hono (existing OB2 server), vanilla JavaScript dashboard (no new frontend frameworks), one-shot test scripts via the local `assert()` pattern.

**Spec:** `docs/superpowers/specs/2026-04-30-llamacpp-provider-design.md` — Section 6 (Dashboard / UI changes), plus the Phase 1 carryover noted at the bottom of the spec ("`admin.ts` is provider-unaware — refactor in Phase 3").

**Predecessor plans:**
- Phase 1: `docs/superpowers/plans/2026-04-30-llamacpp-phase1-provider-abstraction.md` (merged on `feat/llamacpp-phase1`)
- Phase 2: `docs/superpowers/plans/2026-04-30-llamacpp-phase2-manager-and-docker.md` (merged on `feat/llamacpp-phase2`)

Phase 3 builds on top of Phase 2's HEAD. Branch off `feat/llamacpp-phase2` into `feat/llamacpp-phase3`.

---

## File Structure

### Created

| File | Responsibility |
|---|---|
| `server/routes/admin_llm.ts` | New file holding the `/admin/llm/*` route handlers. Keeps `admin.ts` from growing past its already-large 1407 lines. Exports `adminLlmRoutes(config, sidecar)` returning a Hono sub-app. |
| `server/routes/admin_llm_test.ts` | One-shot test for the new routes. Mocks the active provider and asserts route shapes / capability gating. |

### Modified

| File | Change |
|---|---|
| `server/routes/admin.ts` | Mount the new `admin_llm` sub-app. Add a soft 503 gate to existing `/admin/ollama/*` routes when `OB2_LLM_PROVIDER` is `llamacpp` (the operator should hit `/admin/llm/*` instead). |
| `server/static/dashboard.html` | Add the provider-badge `<span>` to the header. Add a Provider-switch panel + llamacpp settings panel + Classifier section to the Config tab. The LLMs tab's existing Ollama markup stays; new llamacpp markup is added in a sibling div hidden by default. |
| `server/static/dashboard.js` | Read `/admin/llm/capabilities` once on page load, store the active provider's id, and toggle the right LLMs-tab markup. Add handlers for the new buttons (load/unload/pull/delete in llamacpp mode; provider-radio, settings-panel, classifier-radio in Config tab). |
| `server/llm/provider.ts` | Remove the `NotImplementedInPhase1` class (no longer thrown anywhere after Phase 2 wired the manager). Pure cleanup, doesn't affect runtime. |
| `tests/fixtures/fake-llama-server.ts` | Delete. The Phase 1 fake is superseded by Phase 2's `tests/fixtures/stub-llama-server.ts` plus Step 23's manager smoke. (If `tests/e2e.sh` Step 22 still references it, that's stale — the existing Step 22 covers the chat path and Step 23 covers the manager path; we keep the Step 22 use of fake-llama-server to validate the gateway-to-llamacpp-direct path without requiring a manager. Decision: keep the fixture, document its narrow purpose in the file header.) |

### NOT touched in Phase 3

- `server/runtime_config.ts` — config schema is final from Phase 1.
- `server/llm/{provider,ollama_provider,llamacpp_provider,openai_sse}.ts` (other than the `NotImplementedInPhase1` removal in `provider.ts`) — chat/management contracts are stable.
- `llamacpp-manager/` — the manager's API is locked from Phase 2.
- `docker/Dockerfile.llamacpp`, `docker/docker-compose.yml`, `scripts/docker-start.sh` — deployment is final from Phase 2.

---

## Group A — Backend (Tasks 1–4)

End-of-group capability: `curl -H 'Authorization: Bearer <key>' /admin/llm/capabilities` returns capability flags; `/admin/llm/active`, `/admin/llm/load`, `/admin/llm/unload`, `/admin/llm/restart`, `/admin/llm/pull` all work end-to-end against either provider; existing `/admin/ollama/*` routes 503 cleanly when provider is llamacpp.

---

### Task 1: `GET /admin/llm/capabilities` and `GET /admin/llm/active`

**Files:**
- Create: `server/routes/admin_llm.ts`
- Create: `server/routes/admin_llm_test.ts`
- Modify: `server/routes/admin.ts` (mount the sub-app)

#### Step 1: Write the failing test

Create `server/routes/admin_llm_test.ts`:

```ts
// Run with: cd /mnt/c/projects/OB2_TurboQuant && deno run --allow-read --allow-write --allow-env --allow-net server/routes/admin_llm_test.ts
import { Hono } from "hono";
import { adminLlmRoutes } from "./admin_llm.ts";
import { initRuntime } from "../runtime_config.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; }
  else { console.log("PASS:", msg); }
}

// Set up runtime config so getProvider() returns ollama by default.
const tmp = await Deno.makeTempFile({ suffix: ".yaml" });
await Deno.writeTextFile(tmp, "ollama:\n  url: http://localhost:11434\n  model: gemma3:4b\n");
initRuntime(tmp);

const app = new Hono();
// adminLlmRoutes returns a sub-app; mount it under /admin/llm.
app.route("/admin/llm", adminLlmRoutes());

// Case 1: GET /admin/llm/capabilities returns the Ollama caps
{
  const r = await app.request("/admin/llm/capabilities");
  assert(r.status === 200, `caps 200 (got ${r.status})`);
  const j = await r.json() as { provider: string; capabilities: Record<string, boolean> };
  assert(j.provider === "ollama", `provider=ollama (got ${j.provider})`);
  assert(j.capabilities.canList === true, "ollama canList=true");
  assert(j.capabilities.canWarm === true, "ollama canWarm=true");
  assert(j.capabilities.canLoad === false, "ollama canLoad=false");
}

// Case 2: switch to llamacpp, capabilities flip
{
  await Deno.writeTextFile(tmp, "llm:\n  provider: llamacpp\nllamacpp:\n  manager_url: http://lc:8081\n  chat_url: http://lc:8080\n");
  initRuntime(tmp);
  const r = await app.request("/admin/llm/capabilities");
  const j = await r.json() as { provider: string; capabilities: Record<string, boolean> };
  assert(j.provider === "llamacpp", "provider=llamacpp");
  assert(j.capabilities.canLoad === true, "llamacpp canLoad=true");
  assert(j.capabilities.canWarm === false, "llamacpp canWarm=false");
}

// Case 3: GET /admin/llm/active returns provider id + active model label
// Mock fetch so the llamacpp /healthz lookup returns a known value.
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request) => {
  const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
  if (url === "http://lc:8081/healthz") {
    return Promise.resolve(new Response(JSON.stringify({
      ok: true, llama_server: { running: true, model: "qwen.gguf", port: 8080 },
    }), { status: 200 }));
  }
  return Promise.resolve(new Response("404", { status: 404 }));
}) as typeof fetch;

{
  const r = await app.request("/admin/llm/active");
  const j = await r.json() as { provider: string; model: string };
  assert(j.provider === "llamacpp", "active.provider=llamacpp");
  assert(j.model === "qwen.gguf", `active.model=qwen.gguf (got ${j.model})`);
}

globalThis.fetch = realFetch;
await Deno.remove(tmp);
if (failures > 0) Deno.exit(1);
console.log("\nAll admin_llm tests passed.");
```

#### Step 2: Run, verify it fails

Run:
```
cd /mnt/c/projects/OB2_TurboQuant && /home/john/.deno/bin/deno run --allow-read --allow-write --allow-env --allow-net server/routes/admin_llm_test.ts
```
Expected: FAIL — module not found.

#### Step 3: Write `server/routes/admin_llm.ts`

```ts
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
```

#### Step 4: Mount the sub-app in `admin.ts`

Read `server/routes/admin.ts` to find where the Hono app is constructed and routes are registered. Add ONE line near the top of the route registration block:

```ts
import { adminLlmRoutes } from "./admin_llm.ts";
// … existing code …
app.route("/llm", adminLlmRoutes());
```

The `/admin` prefix comes from how `admin.ts` is itself mounted in `server/index.ts` — verify by checking the existing `/admin/ollama/...` route paths inside `admin.ts` (they're declared as `/ollama/...` and become `/admin/ollama/...` after mounting). So inside `admin.ts`, the new mount is `app.route("/llm", adminLlmRoutes());`.

#### Step 5: Run, verify it passes

```
cd /mnt/c/projects/OB2_TurboQuant && /home/john/.deno/bin/deno run --allow-read --allow-write --allow-env --allow-net server/routes/admin_llm_test.ts
```
Expected: 8 PASS lines (case 1: 4, case 2: 3, case 3: 2 — actually 4+3+2 = 9; recount the asserts when running).

#### Step 6: Commit

```bash
cd /mnt/c/projects/OB2_TurboQuant && git add server/routes/admin_llm.ts server/routes/admin_llm_test.ts server/routes/admin.ts
git commit -m "feat(admin): GET /admin/llm/{capabilities,active}"
```

---

### Task 2: `POST /admin/llm/load`, `/admin/llm/unload`, `/admin/llm/restart`

**Files:**
- Modify: `server/routes/admin_llm.ts`
- Modify: `server/routes/admin_llm_test.ts`

These three routes proxy to the active provider's `loadModel`, `unloadModel`, and (llamacpp-only) the manager's `/v1/restart`. All three require `global_admin` (we'll wire the auth middleware once Task 4 imports the user-auth helpers).

#### Step 1: Append failing test cases

Add BEFORE the final `if (failures > 0)`:

```ts
// Case 4: POST /admin/llm/load forwards to provider.loadModel (llamacpp)
{
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    if (url === "http://lc:8081/v1/load") {
      const body = JSON.parse(init?.body as string);
      assert(body.filename === "qwen.gguf", "filename forwarded to manager");
      assert(body.ctx_size === 8192, "ctx_size forwarded");
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }
    return Promise.resolve(new Response("404", { status: 404 }));
  }) as typeof fetch;
  const r = await app.request("/admin/llm/load", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: "qwen.gguf", ctx_size: 8192 }),
  });
  assert(r.status === 200, `load 200 (got ${r.status})`);
}

// Case 5: POST /admin/llm/unload forwards to provider.unloadModel
{
  let unloadCalled = false;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    if (url === "http://lc:8081/v1/unload") {
      unloadCalled = true;
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }
    return Promise.resolve(new Response("404", { status: 404 }));
  }) as typeof fetch;
  const r = await app.request("/admin/llm/unload", { method: "POST" });
  assert(r.status === 200, `unload 200 (got ${r.status})`);
  assert(unloadCalled, "unload reached the manager");
}

// Case 6: POST /admin/llm/restart against llamacpp hits manager /v1/restart
{
  let restartBody: Record<string, unknown> | null = null;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    if (url === "http://lc:8081/v1/restart") {
      restartBody = JSON.parse(init?.body as string);
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }
    return Promise.resolve(new Response("404", { status: 404 }));
  }) as typeof fetch;
  const r = await app.request("/admin/llm/restart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ctx_size: 4096 }),
  });
  assert(r.status === 200, `restart 200 (got ${r.status})`);
  assert(restartBody?.ctx_size === 4096, "restart override forwarded");
}

// Case 7: POST /admin/llm/load against Ollama returns 501 (Ollama doesn't load explicitly)
{
  await Deno.writeTextFile(tmp, "ollama:\n  url: http://localhost:11434\n  model: gemma3:4b\n");
  initRuntime(tmp);
  const r = await app.request("/admin/llm/load", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: "any" }),
  });
  assert(r.status === 501, `Ollama load → 501 (got ${r.status})`);
}
```

#### Step 2: Run, verify cases fail

The new test cases will fail because the routes don't exist yet.

#### Step 3: Add the routes to `admin_llm.ts`

After the `/active` handler in `admin_llm.ts`, add:

```ts
  // POST /admin/llm/load — load a model on the active provider.
  // Llamacpp: proxies to manager /v1/load. Ollama: NotSupported (501).
  app.post("/load", async (c) => {
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
      const msg = (e as Error).message;
      const status = msg.includes("not_found") ? 404 : msg.includes("manager_unreachable") ? 502 : 500;
      return c.json({ error: { type: "load_failed", message: msg } }, status);
    }
  });

  // POST /admin/llm/unload — unload the current model.
  app.post("/unload", async (c) => {
    const p = getProvider();
    if (!p.unloadModel) return c.json({ error: { type: "not_supported", message: `${p.id} does not support unload` } }, 501);
    const body = await c.req.json().catch(() => ({})) as { name?: unknown };
    const name = typeof body.name === "string" ? body.name : undefined;
    try {
      await p.unloadModel(name);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: { type: "unload_failed", message: (e as Error).message } }, 500);
    }
  });

  // POST /admin/llm/restart — llamacpp-only, hits manager /v1/restart with overrides.
  app.post("/restart", async (c) => {
    const p = getProvider();
    if (p.id !== "llamacpp") {
      return c.json({ error: { type: "not_supported", message: "restart is llamacpp-only" } }, 501);
    }
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    // Direct fetch to manager — we don't expose this through Provider since
    // it's a llamacpp-only operation that doesn't have an Ollama analog.
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
```

#### Step 4: Run, verify all pass

Expected: 13 PASS (cases 1-7 across all assertions). Use `cd /mnt/c/projects/OB2_TurboQuant && /home/john/.deno/bin/deno run --allow-read --allow-write --allow-env --allow-net server/routes/admin_llm_test.ts`.

#### Step 5: Commit

```bash
cd /mnt/c/projects/OB2_TurboQuant && git add server/routes/admin_llm.ts server/routes/admin_llm_test.ts
git commit -m "feat(admin): POST /admin/llm/{load,unload,restart}"
```

---

### Task 3: `POST /admin/llm/pull` (NDJSON streaming, provider-aware)

**Files:**
- Modify: `server/routes/admin_llm.ts`
- Modify: `server/routes/admin_llm_test.ts`

The pull route is the only route where Ollama and llamacpp paths diverge in shape: Ollama pulls by name (e.g. `gemma3:4b`); llamacpp pulls by URL or HF spec. The route accepts a discriminated body:

- `{source: "ollama", name: "gemma3:4b"}` — only when provider is ollama.
- `{source: "url", url: "https://..."}` — llamacpp only.
- `{source: "hf", repo: "owner/repo", file: "model.gguf"}` — llamacpp only.

The body's `source` is validated against the active provider; invalid combos return 400. Output is NDJSON (one progress frame per line); the dashboard streams it into the existing pull-progress UI.

#### Step 1: Append a failing test case

```ts
// Case 8: POST /admin/llm/pull (llamacpp, source=hf) streams NDJSON
{
  await Deno.writeTextFile(tmp, "llm:\n  provider: llamacpp\nllamacpp:\n  manager_url: http://lc:8081\n");
  initRuntime(tmp);
  const ndjson = [
    '{"status":"starting"}',
    '{"status":"downloading","total":1000,"completed":500}',
    '{"status":"success","filename":"model.gguf"}',
  ].join("\n") + "\n";
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    if (url === "http://lc:8081/v1/pull") {
      return Promise.resolve(new Response(ndjson, {
        status: 200, headers: { "Content-Type": "application/x-ndjson" },
      }));
    }
    return Promise.resolve(new Response("404", { status: 404 }));
  }) as typeof fetch;
  const r = await app.request("/admin/llm/pull", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "hf", repo: "owner/repo", file: "model.gguf" }),
  });
  assert(r.status === 200, `pull 200 (got ${r.status})`);
  const text = await r.text();
  assert(text.includes('"starting"'), "starting frame");
  assert(text.includes('"success"'), "success frame");
}

// Case 9: pull with mismatched source/provider returns 400
{
  // provider is still llamacpp from Case 8
  const r = await app.request("/admin/llm/pull", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "ollama", name: "gemma3:4b" }),
  });
  assert(r.status === 400, `mismatched source → 400 (got ${r.status})`);
}
```

#### Step 2: Run, verify it fails

#### Step 3: Add `/pull` to `admin_llm.ts`

```ts
  // POST /admin/llm/pull — provider-aware pull. Streams NDJSON.
  app.post("/pull", async (c) => {
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
```

#### Step 4: Run, verify all pass

Expected: ~16 PASS lines.

#### Step 5: Commit

```bash
cd /mnt/c/projects/OB2_TurboQuant && git add server/routes/admin_llm.ts server/routes/admin_llm_test.ts
git commit -m "feat(admin): POST /admin/llm/pull (provider-aware NDJSON)"
```

---

### Task 4: Soft-503 gate on `/admin/ollama/*` when `provider == llamacpp`

**Files:**
- Modify: `server/routes/admin.ts`

The existing `/admin/ollama/*` routes stay for ollama-mode operators. When `OB2_LLM_PROVIDER=llamacpp`, calling them is a configuration mistake — the dashboard should be using `/admin/llm/*` instead. The route returns 503 with a clear message rather than silently hitting Ollama (which is probably unreachable anyway in llamacpp mode).

#### Step 1: Find the Ollama route block in `admin.ts`

```bash
cd /mnt/c/projects/OB2_TurboQuant && grep -n '"/ollama' server/routes/admin.ts
```
Expected: lines around 1076 (`GET /ollama/models`), 1114 (`POST /ollama/model`), 1177 (`DELETE /ollama/models/:name`), 1199 (`POST /ollama/pull`), 1220 (`GET /ollama/pull/:job_id`), 1229 (`POST /ollama/pull/:job_id/cancel`).

#### Step 2: Add a route-level gate

Right BEFORE the first `app.get("/ollama/models", ...)` handler in `admin.ts`, insert a sub-app or middleware that gates all `/ollama/*` routes. The cleanest pattern is to add this just inside the route block:

```ts
import { getRuntime } from "../runtime_config.ts";  // already imported elsewhere — check first

// Gate the existing Ollama-specific endpoints when the active provider isn't Ollama.
// Operators in llamacpp mode should use /admin/llm/* instead.
app.use("/ollama/*", async (c, next) => {
  const provider = getRuntime().llm.provider;
  if (provider !== "ollama") {
    return c.json({
      error: {
        type: "wrong_provider",
        message: `Active LLM provider is ${provider}; use /admin/llm/* instead, or set OB2_LLM_PROVIDER=ollama`,
      },
    }, 503);
  }
  await next();
});
```

#### Step 3: Smoke

```bash
# Start a config that has provider=llamacpp set
echo "
llm:
  provider: llamacpp
ollama:
  url: http://localhost:11434
  model: gemma3:4b
" > /tmp/llamacpp-config.yaml

# Manually start the OB2 server pointing at this config and:
# curl http://localhost:7600/admin/ollama/models  → should return 503 with the wrong_provider message
```

If you don't have a full server running available, this is verified via the integration test in Task 1 by adding one more case. Append to `admin_llm_test.ts`:

```ts
// Note: this test asserts admin.ts's /ollama/* gate. We have to import the
// admin module's route registration here to exercise the gate. For Phase 3
// scope, a manual smoke is sufficient — the gate is one app.use line and is
// straightforward.
```

(For Phase 3, manual smoke is acceptable — wiring an integration test for the full admin.ts is out of scope. The gate is one line of behavior.)

#### Step 4: Commit

```bash
cd /mnt/c/projects/OB2_TurboQuant && git add server/routes/admin.ts
git commit -m "feat(admin): gate /admin/ollama/* with 503 when OB2_LLM_PROVIDER!=ollama"
```

---

## Group B — Frontend (Tasks 5–9)

End-of-group capability: dashboard renders provider-aware UI everywhere it matters; operators can perform every llamacpp action through the UI without curl.

---

### Task 5: Status header provider badge

**Files:**
- Modify: `server/static/dashboard.html`
- Modify: `server/static/dashboard.js`

The header currently shows `OB2 v…  •  user@…  •  status`. Add `LLM: <provider> (<active model>)` between user and status. Click the badge to jump to the LLM section of the Config tab.

#### Step 1: Add the badge element to `dashboard.html`

Find the header strip (look for the line with `•` separators in the body header). Add a new span:

```html
<span id="llm-badge" class="header-meta" style="cursor:pointer" title="Click to manage LLM provider">
  LLM: <span id="llm-badge-provider">…</span>
  <span id="llm-badge-model" style="opacity:0.7"></span>
</span>
```

The exact insertion point depends on the existing markup — pick a location consistent with the other status badges.

#### Step 2: Populate the badge in `dashboard.js`

Add a helper near the top-of-file initialization block:

```js
async function refreshLlmBadge() {
  try {
    const r = await fetch('/admin/llm/active', { headers: authHeaders() });
    if (!r.ok) return;
    const j = await r.json();
    document.getElementById('llm-badge-provider').textContent = j.provider || '?';
    document.getElementById('llm-badge-model').textContent = j.model ? `(${j.model})` : '';
  } catch { /* swallow — badge stays stale */ }
}
```

Wire it into the existing page-init flow (find where other "refresh on load" calls are made, e.g. `refreshDomains()` or similar). Add `refreshLlmBadge();` next to them. Also refresh on tab switch to "config" or "llms" so model changes show up.

#### Step 3: Wire the click-to-jump

```js
document.getElementById('llm-badge').addEventListener('click', () => {
  switchTab('config');
  // Scroll into view to the LLM section once Task 7 lands. For now just switch tabs.
});
```

#### Step 4: Manual smoke

Start the OB2 server and load the dashboard. Confirm the badge displays `LLM: ollama (gemma3:4b)` (or whatever is configured). Click → Config tab opens.

#### Step 5: Commit

```bash
cd /mnt/c/projects/OB2_TurboQuant && git add server/static/dashboard.html server/static/dashboard.js
git commit -m "feat(dashboard): provider badge in status header"
```

---

### Task 6: Provider radio + llamacpp settings panel in Config tab

**Files:**
- Modify: `server/static/dashboard.html`
- Modify: `server/static/dashboard.js`

The Config tab today renders a YAML-editing surface and individual fields for `ollama.url`, `ollama.model`, etc. Phase 3 adds:
- A radio at the top of the LLM section: ( ) Ollama  ( ) llama-server.
- When llama-server is selected, show a settings panel with `manager_url`, `chat_url`, `models_dir` (read-only), `default_model` (dropdown populated from `/admin/llm/capabilities`'s side effects later — for now a free-text input), `ctx_size`, `gpu_layers`, `parallel_slots`.
- Saving the form writes to `runtime_config.yaml` via the existing PUT `/admin/config` endpoint (which already accepts `llm.*` and `llamacpp.*` since Phase 1).

#### Step 1: Add HTML to `dashboard.html`

Find the `<section id="tab-config">` block. Inside it, near the top of the LLM-related controls, insert:

```html
<fieldset id="llm-provider-fieldset" style="margin-bottom:1rem">
  <legend>LLM Provider</legend>
  <label><input type="radio" name="llm-provider" value="ollama"> Ollama</label>
  <label><input type="radio" name="llm-provider" value="llamacpp"> llama-server</label>
  <p style="font-size:0.85em;color:var(--muted);margin:0.25rem 0">
    Active provider determines which backend serves chat completions. Switching takes effect on the next request.
  </p>
</fieldset>

<fieldset id="llamacpp-settings" style="display:none;margin-bottom:1rem">
  <legend>llama-server settings</legend>
  <label>Manager URL: <input id="lc-manager-url" type="text" style="width:30em"></label><br>
  <label>Chat URL: <input id="lc-chat-url" type="text" style="width:30em"></label><br>
  <label>Models dir (read-only): <input id="lc-models-dir" type="text" readonly style="width:30em"></label><br>
  <label>Default model: <input id="lc-default-model" type="text" placeholder="e.g. qwen2.5-7b-instruct.Q4_K_M.gguf" style="width:30em"></label><br>
  <label>Context size: <input id="lc-ctx-size" type="number" min="512"></label><br>
  <label>GPU layers (-1 = all): <input id="lc-gpu-layers" type="number" min="-1"></label><br>
  <label>Parallel slots: <input id="lc-parallel-slots" type="number" min="1"></label><br>
  <button id="lc-save" type="button">Save llama-server settings</button>
</fieldset>
```

#### Step 2: Wire the JS

In `dashboard.js`, add a function to populate the form from the current runtime config and another to save:

```js
async function loadProviderSettings() {
  const r = await fetch('/admin/config', { headers: authHeaders() });
  if (!r.ok) return;
  const cfg = await r.json();
  const provider = cfg.llm?.provider || 'ollama';
  // Set the radio.
  for (const radio of document.querySelectorAll('input[name="llm-provider"]')) {
    radio.checked = radio.value === provider;
  }
  // Toggle the settings panel.
  document.getElementById('llamacpp-settings').style.display = provider === 'llamacpp' ? '' : 'none';
  // Populate llamacpp settings.
  const lc = cfg.llamacpp || {};
  document.getElementById('lc-manager-url').value = lc.manager_url || '';
  document.getElementById('lc-chat-url').value = lc.chat_url || '';
  document.getElementById('lc-models-dir').value = lc.models_dir || '';
  document.getElementById('lc-default-model').value = lc.default_model || '';
  document.getElementById('lc-ctx-size').value = lc.ctx_size ?? 8192;
  document.getElementById('lc-gpu-layers').value = lc.gpu_layers ?? -1;
  document.getElementById('lc-parallel-slots').value = lc.parallel_slots ?? 1;
}

// Radio change → flip the panel + save provider.
for (const radio of document.querySelectorAll('input[name="llm-provider"]')) {
  radio.addEventListener('change', async () => {
    const v = document.querySelector('input[name="llm-provider"]:checked').value;
    document.getElementById('llamacpp-settings').style.display = v === 'llamacpp' ? '' : 'none';
    // Patch the runtime config: only the provider field.
    await fetch('/admin/config', {
      method: 'PUT',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ llm: { provider: v } }),
    });
    refreshLlmBadge();
  });
}

document.getElementById('lc-save').addEventListener('click', async () => {
  const payload = {
    llamacpp: {
      manager_url: document.getElementById('lc-manager-url').value,
      chat_url: document.getElementById('lc-chat-url').value,
      default_model: document.getElementById('lc-default-model').value,
      ctx_size: Number(document.getElementById('lc-ctx-size').value),
      gpu_layers: Number(document.getElementById('lc-gpu-layers').value),
      parallel_slots: Number(document.getElementById('lc-parallel-slots').value),
    },
  };
  const r = await fetch('/admin/config', {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    alert('Save failed: ' + await r.text());
  } else {
    alert('Saved.');
    refreshLlmBadge();
  }
});

// Call on tab switch into Config:
const origSwitchTab = window.switchTab;
window.switchTab = function(name) {
  origSwitchTab(name);
  if (name === 'config') loadProviderSettings();
};
```

The `authHeaders()` helper already exists in `dashboard.js` (used by other admin calls). Verify by `grep -n "authHeaders" server/static/dashboard.js`.

#### Step 3: Manual smoke

Start the server, load the dashboard, switch to Config. The provider radio should reflect the current setting. Click llama-server → settings panel appears. Edit ctx_size, save, refresh page → values persist.

#### Step 4: Commit

```bash
cd /mnt/c/projects/OB2_TurboQuant && git add server/static/dashboard.html server/static/dashboard.js
git commit -m "feat(dashboard): provider radio + llamacpp settings panel in Config tab"
```

---

### Task 7: Classifier section in Config tab

**Files:**
- Modify: `server/static/dashboard.html`
- Modify: `server/static/dashboard.js`

The Classifier section (spec §6c) shows the resolved cross-provider matrix in plain language. The radio offers three values: `same as chat`, `ollama`, `llamacpp`. The classifier-model dropdown only appears when the resolved classifier provider is Ollama.

#### Step 1: Add HTML

Inside the Config tab, AFTER the llamacpp-settings fieldset, add:

```html
<fieldset id="classifier-fieldset" style="margin-bottom:1rem">
  <legend>Classifier (used for query routing)</legend>
  <label>Classifier provider:</label>
  <label><input type="radio" name="classifier-provider" value=""> Same as chat provider</label>
  <label><input type="radio" name="classifier-provider" value="ollama"> Ollama</label>
  <label><input type="radio" name="classifier-provider" value="llamacpp"> llama-server</label>

  <p style="margin-top:0.5rem"><strong>Current effective configuration:</strong></p>
  <ul id="classifier-effective" style="font-family:monospace;font-size:0.9em">
    <li>Chat:        <span id="cls-chat">…</span></li>
    <li>Classifier:  <span id="cls-classifier">…</span></li>
  </ul>

  <p id="classifier-model-row" style="display:none">
    <label>Classifier model (Ollama only):
      <input id="classifier-model-input" type="text" placeholder="qwen2.5:0.5b" style="width:20em">
    </label>
  </p>
  <p id="classifier-llamacpp-note" style="display:none;font-style:italic;color:var(--muted)">
    When the classifier provider is llama-server, the loaded chat model is reused — there is no separate classifier model because llama-server holds one model at a time.
  </p>
  <button id="classifier-save" type="button">Save classifier settings</button>
</fieldset>
```

#### Step 2: Wire the JS

```js
function refreshClassifierEffective(cfg) {
  const chatProvider = cfg.llm?.provider || 'ollama';
  const cls = cfg.llm?.classifier_provider || '';
  const effective = cls === '' ? chatProvider : cls;
  const ollamaModel = cfg.ollama?.classifier_model || cfg.ollama?.model || '?';

  document.getElementById('cls-chat').textContent =
    chatProvider === 'ollama' ? `Ollama → ${cfg.ollama?.model || '?'}` : `llama-server → ${cfg.llamacpp?.default_model || '(loaded model)'}`;
  document.getElementById('cls-classifier').textContent =
    effective === 'ollama' ? `Ollama → ${ollamaModel}` : `llama-server → ${cfg.llamacpp?.default_model || '(loaded model)'}`;

  // Show classifier-model input only when the resolved classifier is Ollama
  document.getElementById('classifier-model-row').style.display = effective === 'ollama' ? '' : 'none';
  document.getElementById('classifier-llamacpp-note').style.display = effective === 'llamacpp' ? '' : 'none';
}

async function loadClassifierSettings() {
  const r = await fetch('/admin/config', { headers: authHeaders() });
  if (!r.ok) return;
  const cfg = await r.json();
  const cls = cfg.llm?.classifier_provider || '';
  for (const radio of document.querySelectorAll('input[name="classifier-provider"]')) {
    radio.checked = radio.value === cls;
  }
  document.getElementById('classifier-model-input').value = cfg.ollama?.classifier_model || '';
  refreshClassifierEffective(cfg);
}

for (const radio of document.querySelectorAll('input[name="classifier-provider"]')) {
  radio.addEventListener('change', async () => {
    const v = document.querySelector('input[name="classifier-provider"]:checked').value;
    await fetch('/admin/config', {
      method: 'PUT',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ llm: { classifier_provider: v } }),
    });
    loadClassifierSettings();
  });
}

document.getElementById('classifier-save').addEventListener('click', async () => {
  const v = document.getElementById('classifier-model-input').value;
  await fetch('/admin/config', {
    method: 'PUT',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ollama: { classifier_model: v } }),
  });
  loadClassifierSettings();
});

// Hook into the Config-tab init flow we already wrote in Task 6:
const origLoadProvider = window.loadProviderSettings;
window.loadProviderSettings = async function() {
  await origLoadProvider();
  await loadClassifierSettings();
};
```

#### Step 3: Manual smoke

Switch provider to llamacpp, classifier provider to "Same as chat" → effective shows "llama-server" for both, classifier-model-row hidden. Switch classifier to Ollama → effective shows "llama-server" for chat, "Ollama" for classifier, classifier-model-row appears.

#### Step 4: Commit

```bash
cd /mnt/c/projects/OB2_TurboQuant && git add server/static/dashboard.html server/static/dashboard.js
git commit -m "feat(dashboard): Classifier section with cross-provider effective config"
```

---

### Task 8: LLMs tab — capability-driven dual mode (read path)

**Files:**
- Modify: `server/static/dashboard.html`
- Modify: `server/static/dashboard.js`

The existing LLMs tab renders an Ollama-shape table (installed models, active model, env-pinned). Phase 3 keeps that markup as the "Ollama mode" and adds a sibling "llama-server mode" panel hidden by default. The mode is chosen from `/admin/llm/capabilities`.

This task only adds the read paths (list + active model + capability badges). Tasks 9 add the write paths (load/unload/pull/delete).

#### Step 1: Add HTML

Inside `<section id="tab-llms">`, AFTER the existing Ollama-mode markup, insert a sibling block:

```html
<div id="llms-llamacpp-mode" style="display:none">
  <h3>llama.cpp / turboquant_plus</h3>

  <div id="llamacpp-loaded" style="margin-bottom:1rem;padding:0.5rem;background:var(--panel);border:1px solid var(--border)">
    <strong>Loaded model:</strong>
    <span id="lc-loaded-model">…</span>
    <button id="lc-restart-btn" data-action="restart" style="margin-left:1rem">Restart with new settings</button>
    <button id="lc-unload-btn" data-action="unload">Unload</button>
  </div>

  <h4>Available .gguf files in models dir</h4>
  <table id="llamacpp-models-table">
    <thead>
      <tr><th>Filename</th><th>Size</th><th>Quant</th><th>Actions</th></tr>
    </thead>
    <tbody></tbody>
  </table>

  <p>
    <button id="lc-pull-url-btn" data-action="pull-url">+ Pull from URL</button>
    <button id="lc-pull-hf-btn" data-action="pull-hf">+ Pull from HuggingFace</button>
  </p>
</div>
```

#### Step 2: Wire the mode-switch JS

In `dashboard.js`, add at module scope:

```js
let _llmCaps = null;
let _llmProvider = 'ollama';

async function loadLlmCapabilities() {
  try {
    const r = await fetch('/admin/llm/capabilities', { headers: authHeaders() });
    if (!r.ok) return;
    const j = await r.json();
    _llmCaps = j.capabilities;
    _llmProvider = j.provider;
  } catch { /* leave defaults */ }
}

function applyLlmModeUi() {
  const ollamaMode = document.getElementById('tab-llms').querySelector('.ollama-mode-block') /* may not exist; treat absence as "the existing markup is the Ollama mode by default" */;
  const llamacppMode = document.getElementById('llms-llamacpp-mode');
  if (_llmProvider === 'llamacpp') {
    if (ollamaMode) ollamaMode.style.display = 'none';
    llamacppMode.style.display = '';
    refreshLlamacppPanel();
  } else {
    if (ollamaMode) ollamaMode.style.display = '';
    llamacppMode.style.display = 'none';
  }
}

async function refreshLlamacppPanel() {
  const active = await fetch('/admin/llm/active', { headers: authHeaders() }).then(r => r.json()).catch(() => ({}));
  document.getElementById('lc-loaded-model').textContent = active.model || '(unknown)';
  // The `/admin/llm/models` route is added below (this task). It fans out to
  // `getProvider().listInstalled()` which hits manager `/v1/models` for llamacpp
  // and Ollama's `/api/tags` for ollama mode.
}
```

This task also adds a new `GET /admin/llm/models` route to `server/routes/admin_llm.ts` so the dashboard can list installed models without touching the gated `/admin/ollama/*` routes. Add it next to the other route handlers in `admin_llm.ts`:

```ts
  // GET /admin/llm/models — provider-aware list of installed models.
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
```

(Add a corresponding test case to `admin_llm_test.ts`.)

Then in `dashboard.js`, finish `refreshLlamacppPanel`:

```js
async function refreshLlamacppPanel() {
  const active = await fetch('/admin/llm/active', { headers: authHeaders() }).then(r => r.json()).catch(() => ({}));
  document.getElementById('lc-loaded-model').textContent = active.model || '(unknown)';

  const list = await fetch('/admin/llm/models', { headers: authHeaders() }).then(r => r.json()).catch(() => ({ models: [] }));
  const tbody = document.querySelector('#llamacpp-models-table tbody');
  tbody.innerHTML = '';
  for (const m of (list.models || [])) {
    const tr = document.createElement('tr');
    const sizeMb = (m.size_bytes / (1024 * 1024)).toFixed(1);
    const quant = m.details?.parsed?.quant || '?';
    const isLoaded = m.details?.is_loaded || false;
    tr.innerHTML = `
      <td>${isLoaded ? '● ' : ''}${m.name}</td>
      <td>${sizeMb} MB</td>
      <td>${quant}</td>
      <td>
        ${isLoaded ? '<em>loaded</em>' : `<button data-action="load" data-filename="${m.name}">Load</button>`}
        ${isLoaded ? '' : `<button data-action="delete" data-filename="${m.name}">Delete</button>`}
      </td>
    `;
    tbody.appendChild(tr);
  }
}

// Hook into the LLMs tab init:
const origSwitchTab2 = window.switchTab;
window.switchTab = async function(name) {
  origSwitchTab2(name);
  if (name === 'llms') {
    await loadLlmCapabilities();
    applyLlmModeUi();
  }
};

// Also load caps on page init so the provider badge has them.
loadLlmCapabilities();
```

#### Step 3: Add a test case for /admin/llm/models

In `admin_llm_test.ts`, append BEFORE the final `if (failures > 0)`:

```ts
// Case 10: GET /admin/llm/models lists installed models for the active provider
{
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
    if (url === "http://lc:8081/v1/models") {
      return Promise.resolve(new Response(JSON.stringify({
        models: [
          { filename: "a.gguf", size_bytes: 100, modified_at: "2026-04-30T00:00:00Z", parsed: { arch: "llama" }, is_loaded: false },
        ],
        loaded: null,
      }), { status: 200 }));
    }
    return Promise.resolve(new Response("404", { status: 404 }));
  }) as typeof fetch;
  const r = await app.request("/admin/llm/models");
  const j = await r.json() as { models: Array<{ name: string }> };
  assert(j.models.length === 1, `1 model (got ${j.models.length})`);
  assert(j.models[0].name === "a.gguf", "model name");
}
```

#### Step 4: Run tests, manual smoke

Tests: 18 PASS expected after Case 10 lands.

Manual: switch provider to llamacpp via Config, then go to LLMs tab — should see the new panel with the loaded model placeholder + an empty (or fixture-populated) models table.

#### Step 5: Commit

```bash
cd /mnt/c/projects/OB2_TurboQuant && git add server/routes/admin_llm.ts server/routes/admin_llm_test.ts server/static/dashboard.html server/static/dashboard.js
git commit -m "feat(dashboard): LLMs-tab read mode for llamacpp (active model + GGUF list)"
```

---

### Task 9: LLMs tab — write paths (load, unload, pull, delete)

**Files:**
- Modify: `server/static/dashboard.html`
- Modify: `server/static/dashboard.js`

This task adds the modals/dialogs for: Load (with ctx_size/gpu_layers/parallel_slots overrides), Unload (one-click, confirm), Pull from URL (with progress streaming), Pull from HuggingFace (same), Delete (one-click, refused-if-loaded surfaced).

#### Step 1: Add HTML for modals

```html
<dialog id="lc-load-dialog">
  <form method="dialog">
    <h3>Load model</h3>
    <p>Filename: <strong id="load-filename"></strong></p>
    <p style="font-size:0.85em;color:var(--warn)">⚠ This swaps the loaded model. In-flight chat requests will fail.</p>
    <label>Context size: <input type="number" id="load-ctx-size" min="512"></label><br>
    <label>GPU layers: <input type="number" id="load-gpu-layers" min="-1"></label><br>
    <label>Parallel slots: <input type="number" id="load-parallel-slots" min="1"></label><br>
    <button id="lc-load-confirm" type="button">Load</button>
    <button type="button" data-action="close-dialog">Cancel</button>
  </form>
</dialog>

<dialog id="lc-pull-url-dialog">
  <form method="dialog">
    <h3>Pull from URL</h3>
    <label>URL: <input type="url" id="pull-url-input" placeholder="https://example.com/model.gguf" style="width:30em"></label><br>
    <progress id="pull-url-progress" max="100" value="0" style="display:none;width:30em"></progress>
    <pre id="pull-url-status" style="font-size:0.85em;max-height:8em;overflow:auto"></pre>
    <button id="lc-pull-url-confirm" type="button">Pull</button>
    <button type="button" data-action="close-dialog">Close</button>
  </form>
</dialog>

<dialog id="lc-pull-hf-dialog">
  <form method="dialog">
    <h3>Pull from HuggingFace</h3>
    <label>Repo: <input type="text" id="pull-hf-repo" placeholder="bartowski/gemma-2-2b-it-GGUF" style="width:30em"></label><br>
    <label>File: <input type="text" id="pull-hf-file" placeholder="gemma-2-2b-it-Q4_K_M.gguf" style="width:30em"></label><br>
    <progress id="pull-hf-progress" max="100" value="0" style="display:none;width:30em"></progress>
    <pre id="pull-hf-status" style="font-size:0.85em;max-height:8em;overflow:auto"></pre>
    <button id="lc-pull-hf-confirm" type="button">Pull</button>
    <button type="button" data-action="close-dialog">Close</button>
  </form>
</dialog>
```

#### Step 2: Wire the JS

```js
// Generic: close a dialog when the close button is clicked.
for (const btn of document.querySelectorAll('[data-action="close-dialog"]')) {
  btn.addEventListener('click', () => btn.closest('dialog').close());
}

// LLMs-tab table delegated click handler.
document.querySelector('#llamacpp-models-table').addEventListener('click', (e) => {
  const action = e.target.dataset?.action;
  const filename = e.target.dataset?.filename;
  if (!action || !filename) return;
  if (action === 'load') openLoadDialog(filename);
  if (action === 'delete') deleteModel(filename);
});

function openLoadDialog(filename) {
  document.getElementById('load-filename').textContent = filename;
  document.getElementById('load-ctx-size').value = 8192;
  document.getElementById('load-gpu-layers').value = -1;
  document.getElementById('load-parallel-slots').value = 1;
  document.getElementById('lc-load-dialog').showModal();
}

document.getElementById('lc-load-confirm').addEventListener('click', async () => {
  const filename = document.getElementById('load-filename').textContent;
  const body = {
    filename,
    ctx_size: Number(document.getElementById('load-ctx-size').value),
    gpu_layers: Number(document.getElementById('load-gpu-layers').value),
    parallel_slots: Number(document.getElementById('load-parallel-slots').value),
  };
  const r = await fetch('/admin/llm/load', {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  document.getElementById('lc-load-dialog').close();
  if (!r.ok) {
    const err = await r.json();
    alert('Load failed: ' + (err.error?.message || 'unknown'));
    return;
  }
  refreshLlamacppPanel();
  refreshLlmBadge();
});

async function deleteModel(filename) {
  if (!confirm(`Delete ${filename}? This removes the GGUF from disk.`)) return;
  const r = await fetch('/admin/llm/models/' + encodeURIComponent(filename), {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    alert('Delete failed: ' + (err.error?.message || r.status));
    return;
  }
  refreshLlamacppPanel();
}

document.getElementById('lc-unload-btn').addEventListener('click', async () => {
  if (!confirm('Unload the current model?')) return;
  const r = await fetch('/admin/llm/unload', { method: 'POST', headers: authHeaders() });
  if (!r.ok) alert('Unload failed: ' + r.status);
  refreshLlamacppPanel();
  refreshLlmBadge();
});

document.getElementById('lc-restart-btn').addEventListener('click', async () => {
  // Open the load dialog with current values; saving sends to /admin/llm/restart instead.
  alert('Use the Load button on the active model row, or POST /admin/llm/restart from curl with overrides.');
});

document.getElementById('lc-pull-url-btn').addEventListener('click', () => {
  document.getElementById('pull-url-status').textContent = '';
  document.getElementById('pull-url-progress').style.display = 'none';
  document.getElementById('pull-url-progress').value = 0;
  document.getElementById('lc-pull-url-dialog').showModal();
});

document.getElementById('lc-pull-url-confirm').addEventListener('click', async () => {
  const url = document.getElementById('pull-url-input').value;
  if (!url) return alert('URL required');
  document.getElementById('pull-url-progress').style.display = '';
  await streamPull({ source: 'url', url }, document.getElementById('pull-url-progress'), document.getElementById('pull-url-status'));
  refreshLlamacppPanel();
});

document.getElementById('lc-pull-hf-btn').addEventListener('click', () => {
  document.getElementById('pull-hf-status').textContent = '';
  document.getElementById('pull-hf-progress').style.display = 'none';
  document.getElementById('pull-hf-progress').value = 0;
  document.getElementById('lc-pull-hf-dialog').showModal();
});

document.getElementById('lc-pull-hf-confirm').addEventListener('click', async () => {
  const repo = document.getElementById('pull-hf-repo').value;
  const file = document.getElementById('pull-hf-file').value;
  if (!repo || !file) return alert('Repo and file required');
  document.getElementById('pull-hf-progress').style.display = '';
  await streamPull({ source: 'hf', repo, file }, document.getElementById('pull-hf-progress'), document.getElementById('pull-hf-status'));
  refreshLlamacppPanel();
});

async function streamPull(body, progressEl, statusEl) {
  const r = await fetch('/admin/llm/pull', {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok || !r.body) {
    statusEl.textContent = 'Pull failed: ' + r.status;
    return;
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const p = JSON.parse(line);
        statusEl.textContent += JSON.stringify(p) + '\n';
        statusEl.scrollTop = statusEl.scrollHeight;
        if (p.total && p.completed) {
          progressEl.value = (p.completed / p.total) * 100;
        }
        if (p.status === 'success') statusEl.textContent += '✓ done\n';
        if (p.status === 'error') statusEl.textContent += '✗ ' + p.message + '\n';
      } catch { /* skip malformed line */ }
    }
  }
}
```

The `DELETE /admin/llm/models/:filename` route — add to `admin_llm.ts`:

```ts
  // DELETE /admin/llm/models/:filename
  app.delete("/models/:filename", async (c) => {
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
```

(Add the corresponding test case.)

#### Step 3: Manual smoke

End-to-end: with a real manager + a fresh GGUF, click Pull from URL → progress streams → file appears in table. Click Load → it becomes the loaded model. Click Unload → loaded label clears. Click Delete on a non-loaded file → row disappears.

#### Step 4: Commit

```bash
cd /mnt/c/projects/OB2_TurboQuant && git add server/routes/admin_llm.ts server/routes/admin_llm_test.ts server/static/dashboard.html server/static/dashboard.js
git commit -m "feat(dashboard): LLMs-tab write paths (load, unload, pull, delete)"
```

---

## Group C — Cleanup (Tasks 10–12)

End-of-group capability: dead code removed, fixture purposes documented, README mentions the new dashboard provider switch.

---

### Task 10: Remove `NotImplementedInPhase1` class

**Files:**
- Modify: `server/llm/provider.ts`

The `NotImplementedInPhase1` class was thrown by Phase 1 stubs in `llamacpp_provider.ts`. Phase 2 wired the real manager calls and stopped throwing it. The class is now dead code.

#### Step 1: Verify no references remain

```bash
cd /mnt/c/projects/OB2_TurboQuant && grep -rn "NotImplementedInPhase1" server/ llamacpp-manager/ tests/
```
Expected: only the class definition in `provider.ts`. If any other file references it, do not delete — investigate first.

#### Step 2: Remove the class

In `server/llm/provider.ts`, find the `NotImplementedInPhase1` class definition and delete it (the surrounding JSDoc comment too).

#### Step 3: Verify the change compiles and tests pass

```bash
cd /mnt/c/projects/OB2_TurboQuant && /home/john/.deno/bin/deno check --config server/deno.json server/llm/provider.ts && \
  /home/john/.deno/bin/deno run server/llm/openai_sse_test.ts && \
  /home/john/.deno/bin/deno run --allow-net --allow-read --allow-write --allow-env server/llm/ollama_provider_test.ts && \
  /home/john/.deno/bin/deno run --allow-net --allow-read --allow-write --allow-env server/llm/llamacpp_provider_test.ts && \
  /home/john/.deno/bin/deno run --allow-read --allow-write --allow-env server/llm/provider_test.ts
```
Expected: all four green.

#### Step 4: Commit

```bash
cd /mnt/c/projects/OB2_TurboQuant && git add server/llm/provider.ts
git commit -m "chore(llm): remove unused NotImplementedInPhase1 class"
```

---

### Task 11: Document `tests/fixtures/fake-llama-server.ts`'s narrow purpose

**Files:**
- Modify: `tests/fixtures/fake-llama-server.ts`

Phase 1 introduced this fixture to drive `tests/e2e.sh` Step 22's gateway-to-llamacpp-direct path. Phase 2 added `tests/fixtures/stub-llama-server.ts` which is similar but used by manager tests. Both serve different purposes; the duplication is OK if labelled.

#### Step 1: Update the file header

In `tests/fixtures/fake-llama-server.ts`, replace the existing top comment with:

```ts
// Tiny stand-in for llama-server's /v1/chat/completions used by tests/e2e.sh
// Step 22 to drive the gateway-to-llamacpp chat path WITHOUT requiring the
// real ob2-llamacpp-manager. This fixture emits a fixed SSE sequence — it
// does NOT serve /health (so it can't be used by the manager's process
// supervisor; for that, see tests/fixtures/stub-llama-server.ts).
//
// Usage:
//   deno run --allow-net tests/fixtures/fake-llama-server.ts --port 18080
```

#### Step 2: Commit

```bash
cd /mnt/c/projects/OB2_TurboQuant && git add tests/fixtures/fake-llama-server.ts
git commit -m "docs(fixtures): clarify fake-llama-server vs stub-llama-server roles"
```

---

### Task 12: README update — mention the dashboard provider switch

**Files:**
- Modify: `README.md`

The README's "What's New" section should mention that operators can now swap LLM providers from the dashboard.

#### Step 1: Find and update

In `README.md`, find the "What's New" or "Features" block. Add (or place in the most-relevant section):

```markdown
- **LLM provider switch in dashboard** — flip between Ollama and llama-server (turboquant_plus) via the Config tab without restarting. The LLMs tab adapts its controls to the active provider; pull GGUFs from URL or HuggingFace, load/unload, and delete from the UI.
```

(Keep the surrounding bulleted list style — match the existing markdown.)

#### Step 2: Commit

```bash
cd /mnt/c/projects/OB2_TurboQuant && git add README.md
git commit -m "docs(README): mention dashboard provider switch"
```

---

## Final Verification

- [ ] **Step 1: Run all manager + LLM unit tests**

```bash
cd /mnt/c/projects/OB2_TurboQuant && \
  /home/john/.deno/bin/deno run --allow-env --allow-net llamacpp-manager/auth_test.ts && \
  /home/john/.deno/bin/deno run --allow-read --allow-write --allow-env --allow-net llamacpp-manager/models_test.ts && \
  /home/john/.deno/bin/deno run --allow-read --allow-write --allow-env llamacpp-manager/state_test.ts && \
  /home/john/.deno/bin/deno run --allow-read --allow-write --allow-env --allow-net --allow-run llamacpp-manager/process_test.ts && \
  /home/john/.deno/bin/deno run server/llm/openai_sse_test.ts && \
  /home/john/.deno/bin/deno run --allow-net --allow-read --allow-write --allow-env server/llm/ollama_provider_test.ts && \
  /home/john/.deno/bin/deno run --allow-net --allow-read --allow-write --allow-env server/llm/llamacpp_provider_test.ts && \
  /home/john/.deno/bin/deno run --allow-read --allow-write --allow-env server/llm/provider_test.ts && \
  /home/john/.deno/bin/deno run --allow-read --allow-write --allow-env --allow-net server/routes/admin_llm_test.ts
```
Expected: all nine green.

- [ ] **Step 2: Type-check all touched files**

```bash
cd /mnt/c/projects/OB2_TurboQuant && \
  /home/john/.deno/bin/deno check --config server/deno.json server/routes/admin_llm.ts server/routes/admin.ts server/llm/provider.ts
```
Expected: silent.

- [ ] **Step 3: Manual end-to-end smoke**

On a developer machine with the full stack:

1. `scripts/docker-start.sh --with-llamacpp`.
2. Visit `http://localhost:7600/dashboard`.
3. Status header shows `LLM: llamacpp (...)`.
4. Config tab → Provider radio reflects llamacpp; switch to Ollama → header badge updates.
5. Switch back to llamacpp.
6. LLMs tab shows the new panel; click Pull from HuggingFace, paste `bartowski/gemma-2-2b-it-GGUF` and `gemma-2-2b-it-Q4_K_M.gguf`, click Pull → progress streams; file appears in the table.
7. Click Load on the new file → confirmation dialog → Load → loaded model widget updates.
8. Send a chat through Open WebUI (`http://localhost:7601`) — it returns a streaming response from the loaded model.
9. Click Unload → loaded model clears.
10. Click Delete on the file → row disappears.
11. Switch provider back to Ollama → LLMs tab returns to its classic Ollama view.

---

## Phase 3 Done — End-of-Phase Capability

After Phase 3 lands:

- The OB2_TurboQuant dashboard is fully provider-aware. Operators can flip providers, manage llamacpp models, and see the active model in the status header — all without curl.
- `/admin/llm/*` is the canonical management surface; `/admin/ollama/*` stays for backward compatibility but is gated by the active-provider check.
- The Phase 1 carryover of `admin.ts` provider-unawareness is closed.
- Dead code (`NotImplementedInPhase1`) is removed.

The full feature is shipped.

**Future-track items the spec parked beyond Phase 3:**
- Multi-model loading inside a single `llama-server` (parallel models) — explicitly out of scope per spec §3.
- Linux host-mode for `llama-server` — Linux operators are expected to use the containerized mode.
- HuggingFace gated-repo error messaging (a deeper UX explanation when `OB2_HF_TOKEN` isn't set and the pull 401s) — lives as a follow-up.

These don't require new phases; they're discrete features that could ship as standalone PRs whenever needed.
