// Run with: deno run --allow-net --allow-read --allow-write --allow-env server/llm/anthropic_provider_test.ts
import { anthropicProvider } from "./anthropic_provider.ts";
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
  "anthropic:",
  "  base_url: http://anth.test",
  "  model: claude-test",
  "  max_tokens: 1024",
  "  api_version: '2023-06-01'",
  "  prompt_caching: true",
].join("\n") + "\n");
initRuntime(tmp);

// Case 1: chatNonStream — request shape, headers, response parsing
{
  Deno.env.set("OB2_ANTHROPIC_API_KEY", "sk-ant-test");
  mockFetch((url, init) => {
    if (String(url) === "http://anth.test/v1/messages") {
      const h = init?.headers as Record<string, string>;
      assert(h["x-api-key"] === "sk-ant-test", "x-api-key set");
      assert(h["anthropic-version"] === "2023-06-01", "anthropic-version set");
      const body = JSON.parse(init?.body as string);
      assert(body.model === "claude-test", "uses configured model");
      assert(body.max_tokens === 1024, "falls back to runtime max_tokens");
      assert(body.stream === false, "non-stream flag set");
      // System message converts to top-level system field
      assert(Array.isArray(body.system) && body.system[0].text === "be helpful", "system extracted to top-level");
      assert(body.system[0].cache_control?.type === "ephemeral", "system has cache_control when prompt_caching=true");
      // user/assistant only in messages
      assert(body.messages.length === 2, "system not in messages array");
      assert(body.messages[0].role === "user", "first message is user");
      // Leading user message gets cache_control
      assert(Array.isArray(body.messages[0].content), "leading user content wrapped as blocks");
      assert(body.messages[0].content[0].cache_control?.type === "ephemeral", "leading user block has cache_control");
      // Subsequent user/assistant turns stay as plain strings
      assert(typeof body.messages[1].content === "string", "non-leading turns stay as strings");

      return new Response(JSON.stringify({
        id: "msg_x",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "hello back" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 7, output_tokens: 3 },
      }), { status: 200 });
    }
    throw new Error("unexpected url " + url);
  });
  const r = await anthropicProvider.chatNonStream(
    [
      { role: "system", content: "be helpful" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello!" },
    ],
    {},
  );
  assert(r.content === "hello back", "chatNonStream content");
  assert(r.prompt_tokens === 7, "input_tokens → prompt_tokens");
  assert(r.completion_tokens === 3, "output_tokens → completion_tokens");
  restoreFetch();
}

// Case 2: chatStream — Anthropic SSE → ChatChunk
{
  const sse = [
    `event: message_start`,
    `data: ${JSON.stringify({ type: "message_start", message: { id: "msg_y" } })}`,
    "",
    `event: content_block_start`,
    `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}`,
    "",
    `event: content_block_delta`,
    `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } })}`,
    "",
    `event: content_block_delta`,
    `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " there" } })}`,
    "",
    `event: content_block_stop`,
    `data: ${JSON.stringify({ type: "content_block_stop", index: 0 })}`,
    "",
    `event: message_delta`,
    `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })}`,
    "",
    `event: message_stop`,
    `data: ${JSON.stringify({ type: "message_stop" })}`,
    "",
  ].join("\n");
  mockFetch((url, init) => {
    if (String(url) === "http://anth.test/v1/messages") {
      const body = JSON.parse(init?.body as string);
      assert(body.stream === true, "stream flag set");
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    throw new Error("unexpected url " + url);
  });
  const stream = await anthropicProvider.chatStream([{ role: "user", content: "hi" }], {});
  const reader = stream.getReader();
  const collected: ChatChunk[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    collected.push(value!);
  }
  // Expect: 'Hi', ' there', terminal stop. content_block_start/stop are noise.
  assert(collected.length === 3, `3 chunks (got ${collected.length})`);
  assert(collected[0].content === "Hi", "chunk 1 = 'Hi'");
  assert(collected[1].content === " there", "chunk 2 = ' there'");
  assert(collected[2].done && collected[2].finish_reason === "stop", "terminal frame stop");
  restoreFetch();
}

// Case 3: max_tokens stop_reason → finish_reason="length"
{
  const sse = [
    `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } })}`,
    "",
    `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "max_tokens" } })}`,
    "",
    `data: ${JSON.stringify({ type: "message_stop" })}`,
    "",
  ].join("\n");
  mockFetch(() => new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
  const stream = await anthropicProvider.chatStream([{ role: "user", content: "hi" }], {});
  const reader = stream.getReader();
  const collected: ChatChunk[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    collected.push(value!);
  }
  assert(collected[collected.length - 1].finish_reason === "length", "max_tokens → finish_reason='length'");
  restoreFetch();
}

// Case 4: prompt_caching=false disables cache_control on system + user
{
  await Deno.writeTextFile(tmp, [
    "anthropic:",
    "  base_url: http://anth.test",
    "  model: claude-test",
    "  max_tokens: 1024",
    "  api_version: '2023-06-01'",
    "  prompt_caching: false",
  ].join("\n") + "\n");
  initRuntime(tmp);

  mockFetch((url, init) => {
    const body = JSON.parse(init?.body as string);
    assert(typeof body.system === "string", "system is a plain string when caching off");
    assert(typeof body.messages[0].content === "string", "leading user content is a plain string when caching off");
    return new Response(JSON.stringify({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200 });
  });
  await anthropicProvider.chatNonStream(
    [{ role: "system", content: "sys" }, { role: "user", content: "u" }],
    {},
  );
  restoreFetch();
}

// Case 5: id, capabilities, NotSupported management
{
  assert(anthropicProvider.id === "anthropic", "id is 'anthropic'");
  const caps = anthropicProvider.capabilities!();
  assert(!caps.canList && !caps.canPull && !caps.canLoad, "all manage caps false (chat-only)");
  let threw = false;
  try { await anthropicProvider.pullModel!({ source: "url", url: "x" }, () => {}); } catch (e) {
    threw = (e as Error).name === "NotSupported";
  }
  assert(threw, "pullModel throws NotSupported");
}

// Case 6: HTTP error surfaces with anthropic prefix
{
  mockFetch(() =>
    new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401 })
  );
  let caught = "";
  try { await anthropicProvider.chatNonStream([{ role: "user", content: "hi" }], {}); }
  catch (e) { caught = (e as Error).message; }
  assert(caught.startsWith("anthropic 401"), "non-200 surfaces with status code");
  restoreFetch();
}

await Deno.remove(tmp);
Deno.env.delete("OB2_ANTHROPIC_API_KEY");
if (failures > 0) Deno.exit(1);
console.log("\nAll anthropic provider tests passed.");
