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

// Inject a global-admin auth context for the test app — production routes are
// gated by requireGlobalAdmin(c), but the test harness has no bearerAuthMulti
// in front of it, so we synthesize the same `c.get("auth")` value here.
const app = new Hono();
app.use("*", async (c, next) => {
  c.set("auth", { username: "test-admin", global_admin: true, domains: {} });
  await next();
});
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
      restartBody = JSON.parse(init?.body as string) as Record<string, unknown>;
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
  const rb = restartBody as Record<string, unknown> | null;
  assert(rb?.ctx_size === 4096, "restart override forwarded");
}

// Case 7: POST /admin/llm/load against Ollama returns 501
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

globalThis.fetch = realFetch;
await Deno.remove(tmp);
if (failures > 0) Deno.exit(1);
console.log("\nAll admin_llm tests passed.");
