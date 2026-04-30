// Run with: deno run server/llm/openai_sse_test.ts
import { chatChunkStreamToOpenAiSSE } from "./openai_sse.ts";
import type { ChatChunk } from "./provider.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; }
  else { console.log("PASS:", msg); }
}

function chunksToStream(chunks: ChatChunk[]): ReadableStream<ChatChunk> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
  return out;
}

// Case 1: typical streaming completion
{
  const chunks: ChatChunk[] = [
    { content: "Hello", done: false },
    { content: " world", done: false },
    { content: "", done: true, finish_reason: "stop" },
  ];
  const sse = await collect(chatChunkStreamToOpenAiSSE("ob2", chunksToStream(chunks)));
  // Expect: 1 role-delta frame + 2 content frames + 1 finish frame + [DONE]
  const frames = sse.trim().split("\n\n");
  assert(frames.length === 5, `5 SSE frames; got ${frames.length}`);
  assert(frames[0].includes('"role":"assistant"'), "first frame is role delta");
  assert(frames[1].includes('"content":"Hello"'), "second frame is 'Hello'");
  assert(frames[2].includes('"content":" world"'), "third frame is ' world'");
  assert(frames[3].includes('"finish_reason":"stop"'), "fourth frame is finish=stop");
  assert(frames[4] === "data: [DONE]", "last frame is [DONE]");
}

// Case 2: empty content chunks are emitted as content deltas only when non-empty,
// but the role-delta and [DONE] still bracket the stream.
{
  const chunks: ChatChunk[] = [
    { content: "", done: false },
    { content: "x", done: false },
    { content: "", done: true, finish_reason: "length" },
  ];
  const sse = await collect(chatChunkStreamToOpenAiSSE("ob2", chunksToStream(chunks)));
  const frames = sse.trim().split("\n\n");
  // Expect: role-delta + 1 content frame ('x') + finish frame + [DONE]
  assert(frames.length === 4, `4 SSE frames (empty content suppressed); got ${frames.length}`);
  assert(frames[2].includes('"finish_reason":"length"'), "finish=length passes through");
}

// Case 3: each frame is `data: <json>\n\n` shape (Server-Sent Events spec)
{
  const chunks: ChatChunk[] = [
    { content: "ok", done: false },
    { content: "", done: true, finish_reason: "stop" },
  ];
  const sse = await collect(chatChunkStreamToOpenAiSSE("test-model", chunksToStream(chunks)));
  for (const line of sse.split("\n\n").filter(Boolean)) {
    assert(line.startsWith("data: "), `frame begins with 'data: ': ${line.slice(0, 20)}`);
  }
  assert(sse.includes('"model":"test-model"'), "model id propagated");
}

if (failures > 0) Deno.exit(1);
console.log("\nAll openai_sse tests passed.");
