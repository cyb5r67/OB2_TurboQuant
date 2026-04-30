// Encodes a ChatChunk stream into the OpenAI Chat Completions SSE wire format.
//
// Provider-agnostic: gateway.ts uses this for both Ollama and llamacpp.
// Format reference: https://platform.openai.com/docs/api-reference/chat/streaming
//
// Frames produced:
//   1. role-delta:    {choices:[{delta:{role:"assistant"}}]}
//   2. content-delta: {choices:[{delta:{content:"<text>"}}]} (one per non-empty chunk)
//   3. finish-delta:  {choices:[{delta:{},finish_reason:"stop"|"length"}]}
//   4. terminator:    `data: [DONE]\n\n`

import type { ChatChunk } from "./provider.ts";

function nowId(): string {
  return `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function chatChunkStreamToOpenAiSSE(
  modelId: string,
  source: ReadableStream<ChatChunk>,
): ReadableStream<Uint8Array> {
  const id = nowId();
  const created = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      const reader = source.getReader();
      let firstChunk = true;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;

          if (firstChunk) {
            firstChunk = false;
            const role = {
              id, object: "chat.completion.chunk", created, model: modelId,
              choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
            };
            controller.enqueue(enc.encode(`data: ${JSON.stringify(role)}\n\n`));
          }

          if (value.content) {
            const payload = {
              id, object: "chat.completion.chunk", created, model: modelId,
              choices: [{ index: 0, delta: { content: value.content }, finish_reason: null }],
            };
            controller.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`));
          }

          if (value.done) {
            const finalFrame = {
              id, object: "chat.completion.chunk", created, model: modelId,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: value.finish_reason ?? "stop",
              }],
            };
            controller.enqueue(enc.encode(`data: ${JSON.stringify(finalFrame)}\n\n`));
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            break;
          }
        }
      } catch (err) {
        const errPayload = {
          error: { message: (err as Error).message, type: "upstream_error" },
        };
        controller.enqueue(enc.encode(`data: ${JSON.stringify(errPayload)}\n\n`));
      } finally {
        controller.close();
      }
    },
  });
}
