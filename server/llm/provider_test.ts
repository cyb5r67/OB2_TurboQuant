// Run with: deno run --allow-read --allow-write --allow-env server/llm/provider_test.ts
import { getProvider, getClassifierProvider } from "./provider.ts";
import { initRuntime } from "../runtime_config.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; }
  else { console.log("PASS:", msg); }
}

const tmp = await Deno.makeTempFile({ suffix: ".yaml" });

// Default → ollama
await Deno.writeTextFile(tmp, "ollama:\n  url: http://x:11434\n");
initRuntime(tmp);
assert(getProvider().id === "ollama", "default provider is ollama");
assert(getClassifierProvider().id === "ollama", "classifier provider defaults to ollama (same as main)");

// Switch main → llamacpp
await Deno.writeTextFile(tmp, "llm:\n  provider: llamacpp\n");
initRuntime(tmp);
assert(getProvider().id === "llamacpp", "switched provider is llamacpp");
assert(getClassifierProvider().id === "llamacpp", "classifier follows main provider when classifier_provider is empty");

// Cross-provider classifier
await Deno.writeTextFile(tmp, "llm:\n  provider: llamacpp\n  classifier_provider: ollama\n");
initRuntime(tmp);
assert(getProvider().id === "llamacpp", "main provider still llamacpp");
assert(getClassifierProvider().id === "ollama", "classifier_provider override honored");

await Deno.remove(tmp);
if (failures > 0) Deno.exit(1);
console.log("\nAll provider factory tests passed.");
