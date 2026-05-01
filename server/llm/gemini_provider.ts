// Gemini provider — chat-only, raw fetch, talks to Google's Generative
// Language API directly.
//
// Endpoint shapes:
//   POST /v1beta/models/{model}:generateContent       (non-streaming)
//   POST /v1beta/models/{model}:streamGenerateContent?alt=sse  (streaming)
//
// Wire format differs from OpenAI in three ways that matter:
//   1. Messages are `contents`, with role "user" or "model" (not "assistant").
//      A leading system message becomes top-level `system_instruction`.
//   2. Each turn's text lives inside parts: [{text: "..."}].
//   3. Streamed events are SSE wrapping a JSON candidate; each frame already
//      carries the cumulative-incremental text in candidates[0].content.parts.
//      No wrapper events like message_stop — finish_reason on the last frame
//      signals end-of-stream.
//
// API key is env-only: OB2_GEMINI_API_KEY. Sent as ?key= query parameter
// (Google's standard auth scheme for this API). Never written to runtime config.

import { getRuntime } from "../runtime_config.ts";
import {
  type Capabilities,
  type ChatChunk,
  type ChatMessage,
  type ChatOpts,
  type LoadedEntry,
  type LoadOpts,
  type ModelEntry,
  type NonStreamResult,
  NotSupported,
  type Provider,
  type PullProgress,
  type PullSpec,
} from "./provider.ts";

interface GeminiPart { text: string }
interface GeminiContent { role: "user" | "model"; parts: GeminiPart[] }

function baseUrl(): string {
  return getRuntime().gemini.base_url.replace(/\/+$/, "");
}

function model(): string {
  return getRuntime().gemini.model;
}

function apiKey(): string {
  return Deno.env.get("OB2_GEMINI_API_KEY") || "";
}

function buildBody(messages: ChatMessage[], opts: ChatOpts) {
  const systemText = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  const turns = messages.filter((m) => m.role === "user" || m.role === "assistant");
  while (turns.length > 0 && turns[0].role !== "user") turns.shift();

  const contents: GeminiContent[] = turns.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  const generationConfig: Record<string, unknown> = {};
  if (opts.temperature !== undefined) generationConfig.temperature = opts.temperature;
  if (opts.top_p !== undefined) generationConfig.topP = opts.top_p;
  if (opts.max_tokens !== undefined) generationConfig.maxOutputTokens = opts.max_tokens;

  const body: Record<string, unknown> = { contents };
  if (systemText) body.system_instruction = { parts: [{ text: systemText }] };
  if (Object.keys(generationConfig).length > 0) body.generationConfig = generationConfig;
  return body;
}

function endpoint(action: "generateContent" | "streamGenerateContent", opts: ChatOpts): string {
  const m = encodeURIComponent(opts.model ?? model());
  const key = encodeURIComponent(apiKey());
  const sse = action === "streamGenerateContent" ? "&alt=sse" : "";
  return `${baseUrl()}/v1beta/models/${m}:${action}?key=${key}${sse}`;
}

async function chatNonStream(messages: ChatMessage[], opts: ChatOpts): Promise<NonStreamResult> {
  const resp = await fetch(endpoint("generateContent", opts), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildBody(messages, opts)),
  });
  if (!resp.ok) {
    const msg = await resp.text().catch(() => "");
    throw new Error(`gemini ${resp.status}: ${msg}`);
  }
  const j = await resp.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const parts = j.candidates?.[0]?.content?.parts ?? [];
  const content = parts.map((p) => p.text ?? "").join("");
  return {
    content,
    prompt_tokens: j.usageMetadata?.promptTokenCount ?? 0,
    completion_tokens: j.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

async function chatStream(messages: ChatMessage[], opts: ChatOpts): Promise<ReadableStream<ChatChunk>> {
  const resp = await fetch(endpoint("streamGenerateContent", opts), {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
    body: JSON.stringify(buildBody(messages, opts)),
  });
  if (!resp.ok || !resp.body) {
    const msg = await resp.text().catch(() => "");
    throw new Error(`gemini ${resp.status}: ${msg}`);
  }
  return geminiSseToChunks(resp.body);
}

/**
 * Gemini SSE → ChatChunk.
 *
 * With ?alt=sse, each frame is a `data:`-prefixed JSON candidate:
 *
 *   data: {"candidates":[{"content":{"parts":[{"text":"Hello"}],"role":"model"},"finishReason":"STOP"}],
 *          "usageMetadata":{...}}
 *
 * Frames are separated by blank lines. The last frame carries finishReason
 * (STOP / MAX_TOKENS / SAFETY / etc.); we emit a terminal chunk in response.
 * No DONE marker — stream-end is implicit when the connection closes.
 */
function geminiSseToChunks(source: ReadableStream<Uint8Array>): ReadableStream<ChatChunk> {
  const reader = source.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let closed = false;
  let terminalEmitted = false;

  const flushFrame = (controller: ReadableStreamDefaultController<ChatChunk>, payload: string) => {
    let parsed: {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    };
    try { parsed = JSON.parse(payload); } catch { return; }
    const cand = parsed.candidates?.[0];
    if (!cand) return;
    const text = (cand.content?.parts ?? []).map((p) => p.text ?? "").join("");
    if (text) controller.enqueue({ content: text, done: false });
    const reason = cand.finishReason;
    // FINISH_REASON_UNSPECIFIED (or absent) means "still going". Anything
    // else is terminal.
    if (reason && reason !== "FINISH_REASON_UNSPECIFIED") {
      controller.enqueue({
        content: "",
        done: true,
        finish_reason: reason === "MAX_TOKENS" ? "length" : "stop",
      });
      terminalEmitted = true;
    }
  };

  const drainFrame = (controller: ReadableStreamDefaultController<ChatChunk>, frame: string) => {
    const dataLines = frame.split("\n").filter((l) => l.startsWith("data:"));
    if (dataLines.length === 0) return;
    const payload = dataLines.map((l) => l.slice(5).trim()).join("\n");
    flushFrame(controller, payload);
  };

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
            // Some servers close the connection without a trailing blank
            // line after the final frame. Flush whatever's still in the
            // buffer as one last frame before signaling EOF.
            if (buf.trim()) drainFrame(controller, buf);
            buf = "";
            if (!terminalEmitted) {
              controller.enqueue({ content: "", done: true, finish_reason: "stop" });
            }
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
            drainFrame(controller, frame);
          }
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) { reader.cancel(reason); },
  });
}

const CAPS: Capabilities = {
  canList: false,
  canPull: false,
  canDelete: false,
  canLoad: false,
  canUnload: false,
  canWarm: false,
};

export const geminiProvider: Provider = {
  id: "gemini",

  activeModelLabel(): Promise<string> {
    return Promise.resolve(getRuntime().gemini.model);
  },

  chatStream,
  chatNonStream,

  capabilities(): Capabilities { return CAPS; },

  listInstalled(): Promise<ModelEntry[]> {
    throw new NotSupported("listInstalled", "gemini");
  },
  listLoaded(): Promise<LoadedEntry[]> {
    throw new NotSupported("listLoaded", "gemini");
  },
  pullModel(_spec: PullSpec, _onProgress: (p: PullProgress) => void): Promise<void> {
    throw new NotSupported("pullModel", "gemini");
  },
  loadModel(_name: string, _opts?: LoadOpts): Promise<void> {
    throw new NotSupported("loadModel", "gemini");
  },
  unloadModel(_name?: string): Promise<void> {
    throw new NotSupported("unloadModel", "gemini");
  },
  warmModel(_name: string): Promise<void> {
    throw new NotSupported("warmModel", "gemini");
  },
  deleteModel(_name: string): Promise<void> {
    throw new NotSupported("deleteModel", "gemini");
  },
};
