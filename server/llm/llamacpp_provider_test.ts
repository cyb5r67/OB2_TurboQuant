// Run with: deno run --allow-net --allow-read --allow-write --allow-env server/llm/llamacpp_provider_test.ts
import { llamacppProvider } from "./llamacpp_provider.ts";
import { initRuntime } from "../runtime_config.ts";
import type { ChatChunk } from "./provider.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; }
  else { console.log("PASS:", msg); }
}

const realFetch = globalThis.fetch;
function mockFetch(handler: (input: string | URL, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(typeof input === "string" || input instanceof URL ? input : input.url, init))
  ) as typeof fetch;
}
function restoreFetch() { globalThis.fetch = realFetch; }

const tmp = await Deno.makeTempFile({ suffix: ".yaml" });
await Deno.writeTextFile(tmp, [
  "llamacpp:",
  "  chat_url: http://lc:8080",
  "  manager_url: http://lc:8081",
].join("\n") + "\n");
initRuntime(tmp);

// Case 1: chatNonStream — llama-server returns OpenAI-shaped JSON
{
  mockFetch((url, init) => {
    if (String(url) === "http://lc:8080/v1/chat/completions") {
      const body = JSON.parse(init?.body as string);
      assert(body.stream === false, "non-stream flag set");
      assert(body.messages.length === 1, "messages forwarded");
      return new Response(JSON.stringify({
        choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error("unexpected url " + url);
  });
  const r = await llamacppProvider.chatNonStream(
    [{ role: "user", content: "hi" }],
    {},
  );
  assert(r.content === "hi", "chatNonStream content");
  assert(r.prompt_tokens === 3, "prompt_tokens");
  assert(r.completion_tokens === 1, "completion_tokens");
  restoreFetch();
}

// Case 2: chatStream — llama-server emits OpenAI SSE; adapter parses into ChatChunk
{
  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Hi" }, finish_reason: null }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ delta: { content: "!" }, finish_reason: null }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  mockFetch((url, init) => {
    if (String(url) === "http://lc:8080/v1/chat/completions") {
      const body = JSON.parse(init?.body as string);
      assert(body.stream === true, "stream flag set");
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    throw new Error("unexpected url " + url);
  });

  const stream = await llamacppProvider.chatStream(
    [{ role: "user", content: "hi" }],
    {},
  );
  const reader = stream.getReader();
  const collected: ChatChunk[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    collected.push(value!);
  }
  // Role-only delta is dropped (no content). Content frames + finish frame remain.
  // Expect: 'Hi', '!', done/stop  → 3 chunks total.
  assert(collected.length === 3, `3 chunks (got ${collected.length})`);
  assert(collected[0].content === "Hi" && !collected[0].done, "chunk 1 = 'Hi'");
  assert(collected[1].content === "!" && !collected[1].done, "chunk 2 = '!'");
  assert(collected[2].done && collected[2].finish_reason === "stop", "chunk 3 = done/stop");
  restoreFetch();
}

// Case 3: id, capabilities
{
  assert(llamacppProvider.id === "llamacpp", "id is 'llamacpp'");
  const caps = llamacppProvider.capabilities!();
  assert(caps.canList && caps.canPull && caps.canDelete && caps.canLoad && caps.canUnload, "all manage caps true");
  assert(caps.canWarm === false, "canWarm false");
}

// Case 5: llama-server returns 4xx/5xx → adapter throws with status code in the message
{
  mockFetch((url) => {
    if (String(url) === "http://lc:8080/v1/chat/completions") {
      return new Response("model not loaded", { status: 503 });
    }
    throw new Error("unexpected url " + url);
  });
  let caught: Error | null = null;
  try {
    await llamacppProvider.chatNonStream([{ role: "user", content: "hi" }], {});
  } catch (e) {
    caught = e as Error;
  }
  assert(caught !== null, "chatNonStream throws on 503");
  assert(caught!.message.includes("503"), `error message includes status (got: ${caught!.message})`);
  assert(caught!.message.includes("model not loaded"), "error message includes upstream body");
  restoreFetch();
}

// Case 6: malformed mid-stream JSON in an SSE frame is silently skipped, valid frames still delivered
{
  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "A" }, finish_reason: null }] })}`,
    "",
    "data: {this-is-not-json",                           // garbled mid-stream frame
    "",
    `data: ${JSON.stringify({ choices: [{ delta: { content: "B" }, finish_reason: null }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  mockFetch((url) => {
    if (String(url) === "http://lc:8080/v1/chat/completions") {
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    throw new Error("unexpected url " + url);
  });

  const stream = await llamacppProvider.chatStream(
    [{ role: "user", content: "hi" }],
    {},
  );
  const reader = stream.getReader();
  const collected: ChatChunk[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    collected.push(value!);
  }
  assert(collected.length === 3, `3 chunks (garbled frame skipped); got ${collected.length}`);
  assert(collected[0].content === "A", "first valid chunk delivered");
  assert(collected[1].content === "B", "second valid chunk delivered (after garbled frame)");
  assert(collected[2].done && collected[2].finish_reason === "stop", "terminal chunk reached despite garbled frame");
  restoreFetch();
}

// Case 7: stream containing only role-only deltas (no content) → zero ChatChunks emitted, terminator still respected
{
  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: null }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  mockFetch((url) => {
    if (String(url) === "http://lc:8080/v1/chat/completions") {
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    throw new Error("unexpected url " + url);
  });

  const stream = await llamacppProvider.chatStream(
    [{ role: "user", content: "hi" }],
    {},
  );
  const reader = stream.getReader();
  const collected: ChatChunk[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    collected.push(value!);
  }
  assert(collected.length === 0, `role-only stream emits 0 chunks (got ${collected.length})`);
  restoreFetch();
}

// Case 8: SSE with CRLF line terminators (as some reverse proxies normalize) → parsed correctly
{
  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Hi" }, finish_reason: null }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\r\n");   // CRLF, not LF

  mockFetch((url) => {
    if (String(url) === "http://lc:8080/v1/chat/completions") {
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    throw new Error("unexpected url " + url);
  });

  const stream = await llamacppProvider.chatStream(
    [{ role: "user", content: "hi" }],
    {},
  );
  const reader = stream.getReader();
  const collected: ChatChunk[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    collected.push(value!);
  }
  assert(collected.length === 2, `CRLF stream parses as 2 chunks (content + finish); got ${collected.length}`);
  assert(collected[0].content === "Hi", "CRLF: first chunk content correct");
  assert(collected[1].done && collected[1].finish_reason === "stop", "CRLF: terminal chunk parsed");
  restoreFetch();
}

// Case 9: listInstalled hits manager and returns ModelEntry[]
{
  Deno.env.set("OB2_LLAMACPP_MANAGER_TOKEN", "test-token");
  mockFetch((url, init) => {
    if (String(url) === "http://lc:8081/v1/models") {
      assert(!!init?.headers && (init.headers as Record<string, string>)["Authorization"] === "Bearer test-token", "manager auth header");
      return new Response(JSON.stringify({
        models: [
          { filename: "qwen.gguf", size_bytes: 4_400_000_000, modified_at: "2026-04-29T12:00:00Z", parsed: { arch: "qwen2", quant: "Q4" }, is_loaded: true },
          { filename: "llama.gguf", size_bytes: 5_700_000_000, modified_at: "2026-04-28T08:00:00Z", parsed: null, is_loaded: false },
        ],
        loaded: { filename: "qwen.gguf", port: 8080, started_at: "2026-04-29T12:00:00Z" },
      }), { status: 200 });
    }
    throw new Error("unexpected url " + url);
  });
  const list = await llamacppProvider.listInstalled!();
  assert(list.length === 2, `2 models (got ${list.length})`);
  assert(list[0].name === "qwen.gguf", "first model name");
  assert(list[0].size_bytes === 4_400_000_000, "size propagates");
  restoreFetch();
}

// Case 10: loadModel POSTs to /v1/load with body
{
  let postedBody: string | null = null;
  mockFetch((url, init) => {
    if (String(url) === "http://lc:8081/v1/load") {
      postedBody = init?.body as string;
      return new Response(JSON.stringify({ ok: true, loaded: { filename: "qwen.gguf", ctx_size: 8192, gpu_layers: -1, parallel_slots: 1, port: 8080, started_at: "now" } }), { status: 200 });
    }
    throw new Error("unexpected url " + url);
  });
  await llamacppProvider.loadModel!("qwen.gguf", { ctx_size: 8192 });
  const body = JSON.parse(postedBody!) as { filename: string; ctx_size: number };
  assert(body.filename === "qwen.gguf", "filename in body");
  assert(body.ctx_size === 8192, "ctx_size in body");
  restoreFetch();
}

// Case 11: unloadModel POSTs to /v1/unload (ignores name)
{
  let url2: string | null = null;
  mockFetch((url, init) => {
    url2 = String(url);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  await llamacppProvider.unloadModel!("ignored.gguf");
  assert(url2 === "http://lc:8081/v1/unload", "POST /v1/unload");
  restoreFetch();
}

// Case 12: deleteModel DELETEs /v1/models/:filename
{
  let calledUrl: string | null = null;
  let method: string | null = null;
  mockFetch((url, init) => {
    calledUrl = String(url);
    method = init?.method ?? null;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  await llamacppProvider.deleteModel!("foo.gguf");
  assert(calledUrl === "http://lc:8081/v1/models/foo.gguf", "DELETE URL correct");
  assert(method === "DELETE", "method is DELETE");
  restoreFetch();
}

// Case 13: pullModel streams NDJSON progress
{
  const ndjson = [
    '{"status":"starting"}',
    '{"status":"downloading","total":1000,"completed":500}',
    '{"status":"success","filename":"model.gguf"}',
  ].join("\n") + "\n";
  mockFetch((url) => {
    if (String(url) === "http://lc:8081/v1/pull") {
      return new Response(ndjson, { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
    }
    throw new Error("unexpected url " + url);
  });
  const events: { status: string }[] = [];
  await llamacppProvider.pullModel!(
    { source: "hf", repo: "owner/repo", file: "model.gguf" },
    (p) => events.push(p),
  );
  assert(events.length === 3, `3 progress events (got ${events.length})`);
  assert(events[0].status === "starting", "starting frame");
  assert(events[2].status === "success", "success frame");
  restoreFetch();
}

// Case 14: activeModelLabel reads /healthz
{
  mockFetch((url) => {
    if (String(url) === "http://lc:8081/healthz") {
      return new Response(JSON.stringify({
        ok: true, version: "0.1.0", uptime_sec: 60,
        llama_server: { running: true, model: "qwen.gguf", port: 8080, pid: 12345 },
      }), { status: 200 });
    }
    throw new Error("unexpected url " + url);
  });
  const label = await llamacppProvider.activeModelLabel();
  assert(label === "qwen.gguf", `label is filename (got "${label}")`);
  restoreFetch();
}

// Case 15: activeModelLabel does not throw on manager error
{
  mockFetch(() => {
    throw new Error("ECONNREFUSED");
  });
  let threw = false;
  try { await llamacppProvider.activeModelLabel(); }
  catch { threw = true; }
  assert(!threw, "activeModelLabel does not throw on manager error");
  restoreFetch();
}

await Deno.remove(tmp);
if (failures > 0) Deno.exit(1);
console.log("\nAll llamacpp_provider tests passed.");
