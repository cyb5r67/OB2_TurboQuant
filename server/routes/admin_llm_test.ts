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

globalThis.fetch = realFetch;
await Deno.remove(tmp);
if (failures > 0) Deno.exit(1);
console.log("\nAll admin_llm tests passed.");
