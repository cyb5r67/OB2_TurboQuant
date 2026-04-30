// Run with: cd llamacpp-manager && deno run --allow-read --allow-write --allow-env --allow-net --allow-run process_test.ts
import { LlamaSupervisor, type SpawnOpts } from "./process.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; }
  else { console.log("PASS:", msg); }
}

const REPO_ROOT = new URL("../", import.meta.url).pathname;
const STUB = `${REPO_ROOT}tests/fixtures/stub-llama-server.ts`;

// Use the Deno binary itself with `run` to "execute" the stub server.
const supervisor = new LlamaSupervisor({
  binary: "/home/john/.deno/bin/deno",
  preArgs: ["run", "--allow-net", STUB],
  modelsDir: "/tmp",
  chatPort: 18299,
});

// Case 1: getState() before any spawn → not running
{
  const s = supervisor.getState();
  assert(!s.running, "initial state: not running");
}

// Case 2: spawn and wait for health
{
  const opts: SpawnOpts = { filename: "fake.gguf", ctx_size: 4096, gpu_layers: -1, parallel_slots: 1 };
  await supervisor.spawn(opts);
  await supervisor.awaitHealth(15_000);
  const s = supervisor.getState();
  assert(s.running, "after spawn: running");
  assert(s.model === "fake.gguf", "state.model echoes filename");
  assert(s.port === 18299, "state.port set");
  assert(typeof s.pid === "number" && s.pid > 0, "state.pid set");
}

// Case 3: kill stops the process
{
  await supervisor.kill();
  await new Promise((r) => setTimeout(r, 500));
  const s = supervisor.getState();
  assert(!s.running, "after kill: not running");
}

// Case 4: spawn again (reusing the same supervisor) → works (port released)
{
  const opts: SpawnOpts = { filename: "second.gguf", ctx_size: 2048, gpu_layers: 0, parallel_slots: 1 };
  await supervisor.spawn(opts);
  await supervisor.awaitHealth(15_000);
  const s = supervisor.getState();
  assert(s.running, "second spawn works");
  assert(s.model === "second.gguf", "second model name");
  await supervisor.kill();
  await new Promise((r) => setTimeout(r, 500));
}

// Case 5: awaitHealth times out cleanly when the spawned process never serves /health
{
  const bad = new LlamaSupervisor({
    binary: "/bin/sleep",
    preArgs: [],
    modelsDir: "/tmp",
    chatPort: 18298,
  });
  await bad.spawn({ filename: "fake.gguf", ctx_size: 4096, gpu_layers: -1, parallel_slots: 1 });
  let threw = false;
  try { await bad.awaitHealth(2_000); }
  catch { threw = true; }
  assert(threw, "awaitHealth times out (sleep doesn't serve health)");
  await bad.kill();
}

if (failures > 0) Deno.exit(1);
console.log("\nAll process tests passed.");
