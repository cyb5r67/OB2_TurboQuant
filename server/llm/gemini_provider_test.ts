// Run with: deno run --allow-net --allow-read --allow-write --allow-env server/llm/gemini_provider_test.ts
import { geminiProvider } from "./gemini_provider.ts";
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
  "gemini:",
  "  base_url: http://gem.test",
  "  model: gemini-test",
].join("\n") + "\n");
initRuntime(tmp);

// Case 1: chatNonStream — request shape and URL
{
  Deno.env.set("OB2_GEMINI_API_KEY", "AIza-test");
  mockFetch((url, init) => {
    const u = String(url);
    assert(u.startsWith("http://gem.test/v1beta/models/gemini-test:generateContent"), "uses generateContent endpoint");
    assert(u.includes("key=AIza-test"), "API key in query string");
    const body = JSON.parse(init?.body as string);
    // System extracted to system_instruction
    assert(body.system_instruction?.parts?.[0]?.text === "be helpful", "system_instruction populated");
    // Messages converted: user → user, assistant → model
    assert(body.contents.length === 2, "system not in contents");
    assert(body.contents[0].role === "user", "first content role=user");
    assert(body.contents[1].role === "model", "assistant → model role");
    assert(body.contents[0].parts[0].text === "hi", "user text in parts[0].text");
    // Generation config: temperature/topP/maxOutputTokens
    assert(body.generationConfig.temperature === 0.5, "temperature forwarded");
    assert(body.generationConfig.maxOutputTokens === 100, "max_tokens → maxOutputTokens");

    return new Response(JSON.stringify({
      candidates: [{
        content: { role: "model", parts: [{ text: "hello back" }] },
        finishReason: "STOP",
      }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
    }), { status: 200 });
  });
  const r = await geminiProvider.chatNonStream(
    [
      { role: "system", content: "be helpful" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "earlier reply" },
    ],
    { temperature: 0.5, max_tokens: 100 },
  );
  assert(r.content === "hello back", "chatNonStream content concatenated");
  assert(r.prompt_tokens === 5, "promptTokenCount → prompt_tokens");
  assert(r.completion_tokens === 2, "candidatesTokenCount → completion_tokens");
  restoreFetch();
}

// Case 2: chatStream — Gemini SSE → ChatChunk
{
  const sse = [
    `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "Hi" }] } }] })}`,
    "",
    `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: " world" }] } }] })}`,
    "",
    `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "!" }] }, finishReason: "STOP" }] })}`,
    "",
  ].join("\n");
  mockFetch((url) => {
    const u = String(url);
    assert(u.includes(":streamGenerateContent"), "uses streamGenerateContent endpoint");
    assert(u.includes("alt=sse"), "alt=sse query param set");
    return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  });
  const stream = await geminiProvider.chatStream([{ role: "user", content: "hi" }], {});
  const reader = stream.getReader();
  const collected: ChatChunk[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    collected.push(value!);
  }
  // Expect: 'Hi', ' world', '!', terminal stop. 4 chunks total.
  assert(collected.length === 4, `4 chunks (got ${collected.length})`);
  assert(collected[0].content === "Hi", "chunk 1");
  assert(collected[1].content === " world", "chunk 2");
  assert(collected[2].content === "!", "chunk 3");
  assert(collected[3].done && collected[3].finish_reason === "stop", "terminal frame");
  restoreFetch();
}

// Case 3: MAX_TOKENS finishReason → finish_reason="length"
{
  const sse = [
    `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "x" }] }, finishReason: "MAX_TOKENS" }] })}`,
    "",
  ].join("\n");
  mockFetch(() => new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
  const stream = await geminiProvider.chatStream([{ role: "user", content: "hi" }], {});
  const reader = stream.getReader();
  const collected: ChatChunk[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    collected.push(value!);
  }
  assert(collected[collected.length - 1].finish_reason === "length", "MAX_TOKENS → 'length'");
  restoreFetch();
}

// Case 4: stream closes without finishReason → defensive terminal emitted
{
  const sse = [
    `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "hello" }] } }] })}`,
    "",
  ].join("\n");
  mockFetch(() => new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
  const stream = await geminiProvider.chatStream([{ role: "user", content: "hi" }], {});
  const reader = stream.getReader();
  const collected: ChatChunk[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    collected.push(value!);
  }
  assert(collected.length === 2, "content chunk + defensive terminal");
  assert(collected[1].done, "defensive terminal frame emitted");
  restoreFetch();
}

// Case 5: id, capabilities, NotSupported management
{
  assert(geminiProvider.id === "gemini", "id is 'gemini'");
  const caps = geminiProvider.capabilities!();
  assert(!caps.canList && !caps.canPull && !caps.canLoad, "all manage caps false (chat-only)");
  let threw = false;
  try { await geminiProvider.warmModel!("any"); } catch (e) {
    threw = (e as Error).name === "NotSupported";
  }
  assert(threw, "warmModel throws NotSupported");
}

// Case 6: HTTP error surfaces with gemini prefix
{
  mockFetch(() =>
    new Response(JSON.stringify({ error: { code: 400, message: "API key not valid" } }), { status: 400 })
  );
  let caught = "";
  try { await geminiProvider.chatNonStream([{ role: "user", content: "hi" }], {}); }
  catch (e) { caught = (e as Error).message; }
  assert(caught.startsWith("gemini 400"), "non-200 surfaces with status code");
  restoreFetch();
}

await Deno.remove(tmp);
Deno.env.delete("OB2_GEMINI_API_KEY");
if (failures > 0) Deno.exit(1);
console.log("\nAll gemini provider tests passed.");
