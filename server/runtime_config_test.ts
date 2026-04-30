// server/runtime_config_test.ts
// Run with: deno run --allow-read --allow-write --allow-env server/runtime_config_test.ts
import {
  initRuntime,
  getRuntime,
  validateRuntime,
} from "./runtime_config.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; }
  else { console.log("PASS:", msg); }
}

const tmp = await Deno.makeTempFile({ suffix: ".yaml" });
await Deno.writeTextFile(tmp, [
  "llm:",
  "  provider: llamacpp",
  "  classifier_provider: ollama",
  "llamacpp:",
  "  manager_url: http://m:8081",
  "  chat_url: http://m:8080",
  "  models_dir: /tmp/models",
  "  default_model: foo.gguf",
  "  ctx_size: 4096",
  "  gpu_layers: 32",
  "  parallel_slots: 2",
].join("\n"));
initRuntime(tmp);
const rt = getRuntime();

assert(rt.llm.provider === "llamacpp", "llm.provider read from YAML");
assert(rt.llm.classifier_provider === "ollama", "llm.classifier_provider read from YAML");
assert(rt.llamacpp.manager_url === "http://m:8081", "llamacpp.manager_url read");
assert(rt.llamacpp.ctx_size === 4096, "llamacpp.ctx_size coerced to number");
assert(rt.llamacpp.gpu_layers === 32, "llamacpp.gpu_layers coerced to number");

// Defaults applied when section absent
const tmp2 = await Deno.makeTempFile({ suffix: ".yaml" });
await Deno.writeTextFile(tmp2, "ollama:\n  url: http://x:11434\n");
initRuntime(tmp2);
const rt2 = getRuntime();
assert(rt2.llm.provider === "ollama", "llm.provider defaults to ollama when section absent");
assert(rt2.llamacpp.ctx_size === 8192, "llamacpp.ctx_size default");
assert(rt2.llamacpp.gpu_layers === -1, "llamacpp.gpu_layers default");
assert(rt2.llamacpp.parallel_slots === 1, "llamacpp.parallel_slots default");

// Env override
Deno.env.set("OB2_LLM_PROVIDER", "llamacpp");
Deno.env.set("OB2_LLAMACPP_CTX_SIZE", "16384");
initRuntime(tmp2);
const rt3 = getRuntime();
assert(rt3.llm.provider === "llamacpp", "OB2_LLM_PROVIDER overrides file");
assert(rt3.llamacpp.ctx_size === 16384, "OB2_LLAMACPP_CTX_SIZE overrides file");
Deno.env.delete("OB2_LLM_PROVIDER");
Deno.env.delete("OB2_LLAMACPP_CTX_SIZE");

// Validation rejects bad values
let threw = false;
try { validateRuntime({ llm: { provider: "anthropic" } }); }
catch { threw = true; }
assert(threw, "validateRuntime rejects unknown llm.provider");

threw = false;
try { validateRuntime({ llamacpp: { gpu_layers: -2 } }); }
catch { threw = true; }
assert(threw, "validateRuntime rejects gpu_layers < -1");

threw = false;
try { validateRuntime({ llamacpp: { ctx_size: 0 } }); }
catch { threw = true; }
assert(threw, "validateRuntime rejects ctx_size <= 0");

threw = false;
try { validateRuntime({ llamacpp: { manager_url: "ftp://x" } }); }
catch { threw = true; }
assert(threw, "validateRuntime rejects non-http manager_url");

await Deno.remove(tmp);
await Deno.remove(tmp2);
if (failures > 0) Deno.exit(1);
console.log(`\nAll runtime_config tests passed.`);
