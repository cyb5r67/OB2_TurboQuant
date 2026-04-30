// Run with: cd llamacpp-manager && deno run --allow-read --allow-write --allow-env models_test.ts
import { scan, parseGgufHeader, type ModelInfo } from "./models.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; }
  else { console.log("PASS:", msg); }
}

const REPO_ROOT = new URL("../", import.meta.url).pathname;
const FIXTURE = `${REPO_ROOT}tests/fixtures/sample.gguf`;

// Case 1: parseGgufHeader on the fixture
{
  const parsed = await parseGgufHeader(FIXTURE);
  assert(parsed !== null, "parsed != null");
  assert(parsed?.arch === "llama", `arch === "llama" (got ${parsed?.arch})`);
}

// Case 2: parseGgufHeader on a non-GGUF file returns null
{
  const tmp = await Deno.makeTempFile({ suffix: ".gguf" });
  await Deno.writeTextFile(tmp, "not a gguf");
  const parsed = await parseGgufHeader(tmp);
  assert(parsed === null, "non-GGUF → null");
  await Deno.remove(tmp);
}

// Case 3: scan returns ModelInfo with parsed set, is_loaded=false (no loaded state in this test)
{
  const dir = await Deno.makeTempDir();
  await Deno.copyFile(FIXTURE, `${dir}/sample.gguf`);
  const out: ModelInfo[] = await scan(dir, null);
  assert(out.length === 1, `1 model (got ${out.length})`);
  assert(out[0].filename === "sample.gguf", "filename matches");
  assert(out[0].size_bytes > 0, "size_bytes > 0");
  assert(out[0].parsed?.arch === "llama", "scan.parsed.arch === llama");
  assert(out[0].is_loaded === false, "is_loaded false when no loaded state");
  await Deno.remove(dir, { recursive: true });
}

// Case 4: scan with loaded state marks the matching file
{
  const dir = await Deno.makeTempDir();
  await Deno.copyFile(FIXTURE, `${dir}/sample.gguf`);
  const out = await scan(dir, "sample.gguf");
  assert(out[0].is_loaded === true, "is_loaded true when filename matches loaded");
  await Deno.remove(dir, { recursive: true });
}

// Case 5: scan ignores non-.gguf files
{
  const dir = await Deno.makeTempDir();
  await Deno.copyFile(FIXTURE, `${dir}/sample.gguf`);
  await Deno.writeTextFile(`${dir}/README.md`, "ignore me");
  const out = await scan(dir, null);
  assert(out.length === 1, "non-.gguf files ignored");
  await Deno.remove(dir, { recursive: true });
}

if (failures > 0) Deno.exit(1);
console.log("\nAll models tests passed.");
