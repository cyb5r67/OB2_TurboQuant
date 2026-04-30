// Run with: deno run --allow-net --allow-read --allow-write --allow-env server/llm/llamacpp_provider_test.ts
import { llamacppProvider } from "./llamacpp_provider.ts";
import { initRuntime } from "../runtime_config.ts";
import { NotImplementedInPhase1 } from "./provider.ts";
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

// Case 3: id, capabilities, NotImplementedInPhase1 stubs
{
  assert(llamacppProvider.id === "llamacpp", "id is 'llamacpp'");
  const caps = llamacppProvider.capabilities!();
  assert(caps.canList && caps.canPull && caps.canDelete && caps.canLoad && caps.canUnload, "all manage caps true");
  assert(caps.canWarm === false, "canWarm false");

  let threw = false;
  try { await llamacppProvider.listInstalled!(); } catch (e) { threw = e instanceof NotImplementedInPhase1; }
  assert(threw, "listInstalled throws NotImplementedInPhase1");

  threw = false;
  try { await llamacppProvider.loadModel!("foo.gguf"); } catch (e) { threw = e instanceof NotImplementedInPhase1; }
  assert(threw, "loadModel throws NotImplementedInPhase1");
}

// Case 4: activeModelLabel — Phase 1 has no manager, so returns a placeholder
{
  const label = await llamacppProvider.activeModelLabel();
  assert(label === "(llamacpp; manager unreachable in Phase 1)", `label fallback: "${label}"`);
}

await Deno.remove(tmp);
if (failures > 0) Deno.exit(1);
console.log("\nAll llamacpp_provider tests passed.");
