// Streaming-format → ChatChunk parsers shared across providers.
//
// Each function takes the upstream byte stream and returns a ReadableStream of
// normalized ChatChunk frames. Providers are responsible for opening the HTTP
// connection (so they can attach auth headers, request bodies, etc.) and
// piping `resp.body` through the right parser here.

import type { ChatChunk } from "./provider.ts";

/**
 * Parse an OpenAI-style Server-Sent Events stream into ChatChunk frames.
 *
 * Wire format (also produced by llama-server, vLLM, Groq, Together, OpenRouter,
 * and any other "OpenAI-compatible" endpoint):
 *
 *     data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}
 *
 *     data: {"choices":[{"delta":{},"finish_reason":"stop"}]}
 *
 *     data: [DONE]
 *
 * Frames are blank-line-separated. Role-only deltas (no content, no finish)
 * are suppressed so callers don't have to filter them. The terminal frame is
 * emitted with done=true; if it carries trailing content the parser emits two
 * chunks (content, then done).
 */
export function openAiSseToChunks(source: ReadableStream<Uint8Array>): ReadableStream<ChatChunk> {
  const reader = source.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let closed = false;

  return new ReadableStream<ChatChunk>({
    async pull(controller) {
      if (closed) {
        controller.close();
        return;
      }
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            closed = true;
            controller.close();
            return;
          }
          buf += dec.decode(value, { stream: true })
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n");

          let sep: number;
          while ((sep = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            const dataLines = frame.split("\n").filter((l) => l.startsWith("data:"));
            if (dataLines.length === 0) continue;
            const payload = dataLines.map((l) => l.slice(5).trim()).join("\n");
            if (payload === "[DONE]") {
              closed = true;
              controller.close();
              return;
            }
            let parsed: { choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }> };
            try { parsed = JSON.parse(payload); } catch { continue; }
            const choice = parsed.choices?.[0];
            if (!choice) continue;
            const content = choice.delta?.content ?? "";
            const finish = choice.finish_reason;
            if (finish) {
              if (content) controller.enqueue({ content, done: false });
              controller.enqueue({
                content: "",
                done: true,
                finish_reason: finish === "length" ? "length" : "stop",
              });
              closed = true;
              controller.close();
              return;
            }
            if (content) controller.enqueue({ content, done: false });
          }
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) { reader.cancel(reason); },
  });
}
