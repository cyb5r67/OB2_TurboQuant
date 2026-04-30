// Run with: cd llamacpp-manager && deno run --allow-read --allow-write --allow-env state_test.ts
import { readLoaded, writeLoaded, clearLoaded, type LoadedState } from "./state.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; }
  else { console.log("PASS:", msg); }
}

const dir = await Deno.makeTempDir();

// Case 1: read missing file → null
assert(await readLoaded(dir) === null, "missing file → null");

// Case 2: write then read round-trip
{
  const s: LoadedState = {
    filename: "qwen.gguf",
    ctx_size: 4096,
    gpu_layers: -1,
    parallel_slots: 1,
    started_at: "2026-04-30T12:00:00.000Z",
    port: 8080,
  };
  await writeLoaded(dir, s);
  const back = await readLoaded(dir);
  assert(back?.filename === "qwen.gguf", "filename round-trip");
  assert(back?.ctx_size === 4096, "ctx_size round-trip");
  assert(back?.port === 8080, "port round-trip");
}

// Case 3: clearLoaded removes the file
{
  await clearLoaded(dir);
  assert(await readLoaded(dir) === null, "after clearLoaded, readLoaded → null");
}

// Case 4: clearLoaded on already-clear state is idempotent
{
  await clearLoaded(dir);
  assert(await readLoaded(dir) === null, "clearLoaded is idempotent");
}

// Case 5: readLoaded tolerates malformed JSON (returns null, doesn't throw)
{
  await Deno.writeTextFile(`${dir}/.last_loaded.json`, "{this-is-not-json");
  assert(await readLoaded(dir) === null, "malformed JSON → null");
  await Deno.remove(`${dir}/.last_loaded.json`);
}

await Deno.remove(dir, { recursive: true });
if (failures > 0) Deno.exit(1);
console.log("\nAll state tests passed.");
