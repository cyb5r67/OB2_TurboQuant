// Run with: deno run --allow-net --allow-read --allow-write --allow-env server/llm/ollama_provider_test.ts
import { ollamaProvider } from "./ollama_provider.ts";
import { initRuntime } from "../runtime_config.ts";
import type { ChatChunk } from "./provider.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; }
  else { console.log("PASS:", msg); }
}

// Mock fetch — Ollama emits NDJSON.
const realFetch = globalThis.fetch;
function mockFetch(handler: (input: string | URL, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(typeof input === "string" || input instanceof URL ? input : input.url, init))
  ) as typeof fetch;
}
function restoreFetch() { globalThis.fetch = realFetch; }

// Set up a minimal config file so getRuntime() works.
const tmp = await Deno.makeTempFile({ suffix: ".yaml" });
await Deno.writeTextFile(tmp, "ollama:\n  url: http://localhost:11434\n  model: gemma3:4b\n");
initRuntime(tmp);

// Case 1: chatNonStream
{
  mockFetch((url, init) => {
    if (String(url).endsWith("/api/chat")) {
      const body = JSON.parse(init?.body as string);
      assert(body.model === "gemma3:4b", "uses configured model");
      assert(body.stream === false, "non-stream flag set");
      return new Response(JSON.stringify({
        message: { content: "hello there" },
        prompt_eval_count: 4,
        eval_count: 2,
      }), { status: 200 });
    }
    throw new Error("unexpected url " + url);
  });
  const r = await ollamaProvider.chatNonStream(
    [{ role: "user", content: "hi" }],
    { temperature: 0.5 },
  );
  assert(r.content === "hello there", "chatNonStream content");
  assert(r.prompt_tokens === 4, "prompt_tokens parsed");
  assert(r.completion_tokens === 2, "completion_tokens parsed");
  restoreFetch();
}

// Case 2: chatStream parses NDJSON to ChatChunk
{
  const ndjson = [
    '{"model":"gemma3:4b","created_at":"...","message":{"role":"assistant","content":"Hi"},"done":false}',
    '{"model":"gemma3:4b","created_at":"...","message":{"role":"assistant","content":" you"},"done":false}',
    '{"model":"gemma3:4b","created_at":"...","done":true,"done_reason":"stop"}',
  ].join("\n") + "\n";

  mockFetch((url, init) => {
    if (String(url).endsWith("/api/chat")) {
      const body = JSON.parse(init?.body as string);
      assert(body.stream === true, "stream flag set on stream call");
      return new Response(ndjson, { status: 200 });
    }
    throw new Error("unexpected url " + url);
  });

  const stream = await ollamaProvider.chatStream(
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
  assert(collected.length === 3, `3 chunks (got ${collected.length})`);
  assert(collected[0].content === "Hi" && !collected[0].done, "chunk 1 = 'Hi'");
  assert(collected[1].content === " you" && !collected[1].done, "chunk 2 = ' you'");
  assert(collected[2].done && collected[2].finish_reason === "stop", "chunk 3 = done/stop");
  restoreFetch();
}

// Case 3: id and capabilities
{
  assert(ollamaProvider.id === "ollama", "id is 'ollama'");
  const caps = ollamaProvider.capabilities!();
  assert(caps.canList && caps.canPull && caps.canDelete && caps.canLoad === false, "capabilities flags");
  // Note: Ollama doesn't support an explicit "load" — pull+warm is the equivalent.
  // canWarm is true for Ollama; canLoad is false (loadModel throws NotSupported).
  assert(caps.canWarm === true, "canWarm true for Ollama");
  assert(caps.canUnload === true, "canUnload true for Ollama");
}

// Case 4: activeModelLabel reflects config
{
  const label = await ollamaProvider.activeModelLabel();
  assert(label === "gemma3:4b", `activeModelLabel: got "${label}"`);
}

await Deno.remove(tmp);
if (failures > 0) Deno.exit(1);
console.log("\nAll ollama_provider tests passed.");
