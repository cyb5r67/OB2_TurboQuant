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

// Case 6: parser walks past a type-9 array to reach later KVs (e.g. quant_version)
{
  // Build a tiny GGUF in-memory: magic + ver=3 + 0 tensors + 3 KVs:
  //   1) general.architecture = "qwen2"
  //   2) tokenizer.ggml.tokens = ["a", "b"] (string array)
  //   3) general.quantization_version = 4 (uint32)
  const dir = await Deno.makeTempDir();
  const path = `${dir}/array-fixture.gguf`;

  // Helpers
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const u8 = (v: number) => { const b = new Uint8Array(1); new DataView(b.buffer).setUint8(0, v); chunks.push(b); };
  const u32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); chunks.push(b); };
  const u64 = (v: number | bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); chunks.push(b); };
  const str = (s: string) => { const e = enc.encode(s); u64(e.length); chunks.push(e); };

  chunks.push(enc.encode("GGUF"));
  u32(3);                                // version
  u64(0);                                // 0 tensors
  u64(3);                                // 3 KVs

  // KV 1: general.architecture = "qwen2"
  str("general.architecture");
  u32(8);                                // string type
  str("qwen2");

  // KV 2: tokenizer.ggml.tokens = ["a", "b"] (array of string)
  str("tokenizer.ggml.tokens");
  u32(9);                                // array type
  u32(8);                                // inner_type = string
  u64(2);                                // count = 2
  str("a");
  str("b");

  // KV 3: general.quantization_version = 4
  str("general.quantization_version");
  u32(4);                                // uint32 type
  u32(4);                                // value

  let total = 0;
  for (const c of chunks) total += c.length;
  const merged = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { merged.set(c, p); p += c.length; }
  await Deno.writeFile(path, merged);

  const parsed = await parseGgufHeader(path);
  assert(parsed?.arch === "qwen2", `arch === "qwen2" (got ${parsed?.arch})`);
  assert(parsed?.quant === "Q4", `quant === "Q4" (got ${parsed?.quant}) — array skip lets parser reach quant`);
  await Deno.remove(dir, { recursive: true });
}

import { pullFromUrl, isDeniedIp } from "./models.ts";

// Case 7: isDeniedIp recognizes private/metadata IPs
{
  assert(isDeniedIp("127.0.0.1"), "127.0.0.1 denied");
  assert(isDeniedIp("10.0.0.1"), "10.0.0.1 denied");
  assert(isDeniedIp("169.254.169.254"), "AWS metadata denied");
  assert(isDeniedIp("192.168.1.1"), "192.168/16 denied");
  assert(!isDeniedIp("8.8.8.8"), "8.8.8.8 allowed");
}

// Case 8: pullFromUrl streams to disk with progress
{
  Deno.env.set("OB2_LLAMACPP_ALLOW_LOCAL_PULL", "1");
  const dir = await Deno.makeTempDir();
  const body = new Uint8Array(1024 * 100); // 100 KB
  for (let i = 0; i < body.length; i++) body[i] = i & 0xff;

  // Spin up a tiny HTTP server serving the body.
  const ac = new AbortController();
  const port = 18380;
  const serverFinished = Deno.serve({
    port,
    signal: ac.signal,
    onListen: () => {},
  }, () => new Response(body, {
    status: 200,
    headers: { "Content-Length": String(body.length) },
  })).finished;

  await new Promise((r) => setTimeout(r, 100));

  const progress: { status: string; total?: number; completed?: number }[] = [];
  await pullFromUrl(`http://127.0.0.1:${port}/test.gguf`, dir, "test.gguf", (p) => progress.push(p));
  ac.abort();
  await serverFinished.catch(() => {});

  const stat = await Deno.stat(`${dir}/test.gguf`);
  assert(stat.size === body.length, `downloaded size matches (got ${stat.size})`);
  assert(progress.length >= 2, `at least 2 progress frames (got ${progress.length})`);
  assert(progress[progress.length - 1].status === "success", "terminal status=success");
  await Deno.remove(dir, { recursive: true });
}

// Case 9: pullFromUrl refuses 127.0.0.1 when not bypassed (defense)
{
  Deno.env.delete("OB2_LLAMACPP_ALLOW_LOCAL_PULL");
  const dir = await Deno.makeTempDir();
  let threw = false;
  try {
    await pullFromUrl("http://127.0.0.1:18399/x.gguf", dir, "x.gguf", () => {});
  } catch (e) {
    threw = (e as Error).message.includes("denylist");
  }
  assert(threw, "pull from 127.0.0.1 without bypass → denylist error");
  await Deno.remove(dir, { recursive: true });
}

import { pullFromHf } from "./models.ts";

// Case 10: pullFromHf builds the correct URL and forwards HF token when set
{
  Deno.env.set("OB2_LLAMACPP_ALLOW_LOCAL_PULL", "1");
  Deno.env.set("OB2_HF_TOKEN", "hf-secret-token");
  const dir = await Deno.makeTempDir();
  const body = new Uint8Array(1024);
  let receivedAuth: string | null = null;
  let receivedPath: string | null = null;

  const ac = new AbortController();
  const port = 18381;
  const serverFinished = Deno.serve({
    port,
    signal: ac.signal,
    onListen: () => {},
  }, (req) => {
    receivedAuth = req.headers.get("Authorization");
    receivedPath = new URL(req.url).pathname;
    return new Response(body, { status: 200, headers: { "Content-Length": String(body.length) } });
  }).finished;

  await new Promise((r) => setTimeout(r, 100));

  // Override the HF base URL via env so the test hits localhost:18381 instead.
  Deno.env.set("OB2_LLAMACPP_HF_BASE_URL", `http://127.0.0.1:${port}`);
  await pullFromHf("foo/bar", "model.Q4_K_M.gguf", dir, "model.Q4_K_M.gguf", () => {});
  Deno.env.delete("OB2_LLAMACPP_HF_BASE_URL");
  ac.abort();
  await serverFinished.catch(() => {});

  assert(receivedAuth === "Bearer hf-secret-token", `HF Authorization forwarded (got: ${receivedAuth})`);
  assert(receivedPath === "/foo/bar/resolve/main/model.Q4_K_M.gguf", `HF URL path correct (got: ${receivedPath})`);
  Deno.env.delete("OB2_HF_TOKEN");
  await Deno.remove(dir, { recursive: true });
}

if (failures > 0) Deno.exit(1);
console.log("\nAll models tests passed.");
