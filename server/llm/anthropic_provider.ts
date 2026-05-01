// Anthropic provider — chat-only, raw fetch (no SDK).
//
// Talks to /v1/messages directly. The wire format differs from OpenAI's
// /v1/chat/completions in three ways that matter here:
//
//   1. `system` is a top-level field, not a message — we extract it from
//      ChatMessage[] before forwarding.
//   2. SSE events are typed (`message_start`, `content_block_delta`, etc.)
//      and the text lives at `delta.text` on a `text_delta`-shaped delta.
//   3. `max_tokens` is required on every call (Anthropic has no default).
//      We fall back to runtime config's anthropic.max_tokens when the caller
//      doesn't pass one.
//
// Prompt caching is wired from the start: when runtime.anthropic.prompt_caching
// is true (default), we mark the system message and the leading user message
// with cache_control: {type: "ephemeral"}. That covers the RAG-context-heavy
// gateway path — system stays the same across turns of a domain, and the
// first user turn often carries the bulky retrieved-doc preamble. Two
// breakpoints; the API allows up to four.
//
// API key is env-only: OB2_ANTHROPIC_API_KEY. Never written to runtime config.

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

interface CacheControl { type: "ephemeral"; ttl?: "5m" | "1h" }
interface AnthropicTextBlock { type: "text"; text: string; cache_control?: CacheControl }
interface AnthropicMessage { role: "user" | "assistant"; content: string | AnthropicTextBlock[] }

function baseUrl(): string {
  return getRuntime().anthropic.base_url.replace(/\/+$/, "");
}

function model(): string {
  return getRuntime().anthropic.model;
}

function apiKey(): string {
  return Deno.env.get("OB2_ANTHROPIC_API_KEY") || "";
}

function headers(): Record<string, string> {
  const rt = getRuntime().anthropic;
  return {
    "Content-Type": "application/json",
    "x-api-key": apiKey(),
    "anthropic-version": rt.api_version,
  };
}

/**
 * Convert our flat ChatMessage[] into the Anthropic request shape.
 * Splits system messages out to the top-level `system` field, drops `tool`
 * messages (Anthropic uses tool_use/tool_result content blocks; we don't
 * surface those through this provider), and applies cache_control to the
 * system block and leading user turn when prompt caching is enabled.
 */
function buildBody(messages: ChatMessage[], opts: ChatOpts, stream: boolean) {
  const rt = getRuntime().anthropic;
  const cache = rt.prompt_caching;

  // Concatenate consecutive system messages with a blank line between them —
  // matches how operators typically split system prompts across blocks.
  const systemText = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");

  const turns = messages.filter((m) => m.role === "user" || m.role === "assistant");

  // Anthropic requires the first message to be `user`. If our caller somehow
  // hands us a leading assistant turn (shouldn't happen via the gateway, but
  // defensive), drop it rather than 400ing the API.
  while (turns.length > 0 && turns[0].role !== "user") turns.shift();

  let leadingUserSeen = false;
  const anthropicMessages: AnthropicMessage[] = turns.map((m) => {
    const role = m.role as "user" | "assistant";
    // Cache the leading user turn's content block (RAG-context-heavy in the
    // gateway path). All other turns stay as plain strings — small/varying.
    if (cache && role === "user" && !leadingUserSeen) {
      leadingUserSeen = true;
      return {
        role,
        content: [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }],
      };
    }
    return { role, content: m.content };
  });

  const body: Record<string, unknown> = {
    model: opts.model ?? model(),
    max_tokens: opts.max_tokens ?? rt.max_tokens,
    messages: anthropicMessages,
    stream,
  };

  if (systemText) {
    body.system = cache
      ? [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }]
      : systemText;
  }

  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.top_p !== undefined) body.top_p = opts.top_p;

  return body;
}

async function chatNonStream(messages: ChatMessage[], opts: ChatOpts): Promise<NonStreamResult> {
  const resp = await fetch(`${baseUrl()}/v1/messages`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(buildBody(messages, opts, false)),
  });
  if (!resp.ok) {
    const msg = await resp.text().catch(() => "");
    throw new Error(`anthropic ${resp.status}: ${msg}`);
  }
  const j = await resp.json() as {
    content: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  // Concatenate every text-typed block — defensive against thinking blocks
  // sneaking in (chat-only flow doesn't enable thinking, but if a future
  // config does, we want to skip thinking content rather than crash).
  const content = j.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text!)
    .join("");
  return {
    content,
    prompt_tokens: j.usage?.input_tokens ?? 0,
    completion_tokens: j.usage?.output_tokens ?? 0,
  };
}

async function chatStream(messages: ChatMessage[], opts: ChatOpts): Promise<ReadableStream<ChatChunk>> {
  const resp = await fetch(`${baseUrl()}/v1/messages`, {
    method: "POST",
    headers: { ...headers(), "Accept": "text/event-stream" },
    body: JSON.stringify(buildBody(messages, opts, true)),
  });
  if (!resp.ok || !resp.body) {
    const msg = await resp.text().catch(() => "");
    throw new Error(`anthropic ${resp.status}: ${msg}`);
  }
  return anthropicSseToChunks(resp.body);
}

/**
 * Anthropic SSE → ChatChunk.
 *
 * The wire format is standard SSE (data:-prefixed JSON, blank-line frame
 * separators) but the payload shape differs from OpenAI:
 *
 *   data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}
 *   data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}
 *   data: {"type":"message_stop"}
 *
 * We forward only `text_delta` payloads as content chunks. The terminal
 * frame is emitted on `message_delta` (which carries stop_reason) so callers
 * get a `done: true` chunk before the stream closes on `message_stop`.
 */
function anthropicSseToChunks(source: ReadableStream<Uint8Array>): ReadableStream<ChatChunk> {
  const reader = source.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let closed = false;
  let terminalEmitted = false;

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
            let parsed: {
              type: string;
              delta?: { type?: string; text?: string; stop_reason?: string };
            };
            try { parsed = JSON.parse(payload); } catch { continue; }

            if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
              const text = parsed.delta.text ?? "";
              if (text) controller.enqueue({ content: text, done: false });
            } else if (parsed.type === "message_delta" && parsed.delta?.stop_reason) {
              const reason = parsed.delta.stop_reason;
              controller.enqueue({
                content: "",
                done: true,
                finish_reason: reason === "max_tokens" ? "length" : "stop",
              });
              terminalEmitted = true;
            } else if (parsed.type === "message_stop") {
              if (!terminalEmitted) {
                // Defensive: emit a terminal frame even if message_delta was
                // somehow missing, so consumers always see done=true.
                controller.enqueue({ content: "", done: true, finish_reason: "stop" });
              }
              closed = true;
              controller.close();
              return;
            }
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

export const anthropicProvider: Provider = {
  id: "anthropic",

  activeModelLabel(): Promise<string> {
    return Promise.resolve(getRuntime().anthropic.model);
  },

  chatStream,
  chatNonStream,

  capabilities(): Capabilities { return CAPS; },

  listInstalled(): Promise<ModelEntry[]> {
    throw new NotSupported("listInstalled", "anthropic");
  },
  listLoaded(): Promise<LoadedEntry[]> {
    throw new NotSupported("listLoaded", "anthropic");
  },
  pullModel(_spec: PullSpec, _onProgress: (p: PullProgress) => void): Promise<void> {
    throw new NotSupported("pullModel", "anthropic");
  },
  loadModel(_name: string, _opts?: LoadOpts): Promise<void> {
    throw new NotSupported("loadModel", "anthropic");
  },
  unloadModel(_name?: string): Promise<void> {
    throw new NotSupported("unloadModel", "anthropic");
  },
  warmModel(_name: string): Promise<void> {
    throw new NotSupported("warmModel", "anthropic");
  },
  deleteModel(_name: string): Promise<void> {
    throw new NotSupported("deleteModel", "anthropic");
  },
};
