// Run with: deno run --allow-net --allow-read --allow-write --allow-env server/llm/openai_provider_test.ts
import { openaiProvider } from "./openai_provider.ts";
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
  "openai:",
  "  base_url: http://oai.test/v1",
  "  model: gpt-test",
].join("\n") + "\n");
initRuntime(tmp);

// Case 1: chatNonStream — request shape, auth header, response parsing
{
  Deno.env.set("OB2_OPENAI_API_KEY", "sk-test123");
  mockFetch((url, init) => {
    if (String(url) === "http://oai.test/v1/chat/completions") {
      const headers = init?.headers as Record<string, string>;
      assert(headers["Authorization"] === "Bearer sk-test123", "auth header set when key present");
      const body = JSON.parse(init?.body as string);
      assert(body.model === "gpt-test", "uses configured model");
      assert(body.stream === false, "non-stream flag set");
      assert(body.temperature === 0.5, "temperature forwarded");
      return new Response(JSON.stringify({
        choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 1 },
      }), { status: 200 });
    }
    throw new Error("unexpected url " + url);
  });
  const r = await openaiProvider.chatNonStream(
    [{ role: "user", content: "hi" }],
    { temperature: 0.5 },
  );
  assert(r.content === "hello", "chatNonStream content");
  assert(r.prompt_tokens === 5, "prompt_tokens");
  assert(r.completion_tokens === 1, "completion_tokens");
  restoreFetch();
  Deno.env.delete("OB2_OPENAI_API_KEY");
}

// Case 2: no API key set — header omitted (for vLLM/llama-server without auth)
{
  mockFetch((url, init) => {
    if (String(url) === "http://oai.test/v1/chat/completions") {
      const headers = init?.headers as Record<string, string>;
      assert(headers["Authorization"] === undefined, "auth header omitted when key empty");
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      }), { status: 200 });
    }
    throw new Error("unexpected url " + url);
  });
  const r = await openaiProvider.chatNonStream([{ role: "user", content: "hi" }], {});
  assert(r.content === "ok", "non-auth flow works");
  restoreFetch();
}

// Case 3: chatStream — OpenAI SSE → ChatChunk via shared parser
{
  Deno.env.set("OB2_OPENAI_API_KEY", "sk-x");
  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Hi" }, finish_reason: null }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ delta: { content: " there" }, finish_reason: null }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  mockFetch((url, init) => {
    if (String(url) === "http://oai.test/v1/chat/completions") {
      const body = JSON.parse(init?.body as string);
      assert(body.stream === true, "stream flag set");
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    throw new Error("unexpected url " + url);
  });
  const stream = await openaiProvider.chatStream([{ role: "user", content: "hi" }], {});
  const reader = stream.getReader();
  const collected: ChatChunk[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    collected.push(value!);
  }
  assert(collected.length === 3, `3 chunks (got ${collected.length})`);
  assert(collected[0].content === "Hi", "chunk 1 = 'Hi'");
  assert(collected[1].content === " there", "chunk 2 = ' there'");
  assert(collected[2].done && collected[2].finish_reason === "stop", "terminal frame");
  restoreFetch();
  Deno.env.delete("OB2_OPENAI_API_KEY");
}

// Case 4: opts.model override
{
  mockFetch((url, init) => {
    const body = JSON.parse(init?.body as string);
    assert(body.model === "gpt-classifier", "opts.model overrides configured model");
    return new Response(JSON.stringify({
      choices: [{ message: { content: "x" }, finish_reason: "stop" }],
    }), { status: 200 });
  });
  await openaiProvider.chatNonStream(
    [{ role: "user", content: "hi" }],
    { model: "gpt-classifier" },
  );
  restoreFetch();
}

// Case 5: id, capabilities, NotSupported management
{
  assert(openaiProvider.id === "openai", "id is 'openai'");
  const caps = openaiProvider.capabilities!();
  assert(!caps.canList && !caps.canPull && !caps.canLoad, "all manage caps false (chat-only)");
  let threw = false;
  try { await openaiProvider.loadModel!("any"); } catch (e) {
    threw = (e as Error).name === "NotSupported";
  }
  assert(threw, "loadModel throws NotSupported");
}

// Case 6: HTTP error surfaces
{
  mockFetch(() =>
    new Response(JSON.stringify({ error: { message: "model not found" } }), { status: 404 })
  );
  let caught = "";
  try { await openaiProvider.chatNonStream([{ role: "user", content: "hi" }], {}); }
  catch (e) { caught = (e as Error).message; }
  assert(caught.startsWith("openai 404"), "non-200 surfaces with status code");
  restoreFetch();
}

await Deno.remove(tmp);
if (failures > 0) Deno.exit(1);
console.log("\nAll openai provider tests passed.");
