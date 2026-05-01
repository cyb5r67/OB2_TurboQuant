// OpenAI / OpenAI-compatible provider — chat-only.
//
// Speaks the standard /v1/chat/completions wire format used by OpenAI itself
// and every "OpenAI-compatible" endpoint: Groq, Together, OpenRouter, vLLM,
// a bare llama-server (without the manager sidecar), Fireworks, DeepInfra,
// etc. Point `OB2_OPENAI_BASE_URL` at any of those to switch backends with
// no code change.
//
// API key is env-only: OB2_OPENAI_API_KEY. Never written to runtime config.

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
import { openAiSseToChunks } from "./sse_parsers.ts";

function baseUrl(): string {
  return getRuntime().openai.base_url.replace(/\/+$/, "");
}

function model(): string {
  return getRuntime().openai.model;
}

function apiKey(): string {
  return Deno.env.get("OB2_OPENAI_API_KEY") || "";
}

function authHeaders(): Record<string, string> {
  const key = apiKey();
  // Bare local endpoints (vLLM without auth, llama-server) often don't require
  // a key; only set the header when one is configured.
  return key ? { "Authorization": `Bearer ${key}` } : {};
}

function bodyFor(messages: ChatMessage[], opts: ChatOpts, stream: boolean) {
  return {
    model: opts.model ?? model(),
    messages,
    stream,
    ...(opts.temperature !== undefined && { temperature: opts.temperature }),
    ...(opts.top_p !== undefined && { top_p: opts.top_p }),
    ...(opts.max_tokens !== undefined && { max_tokens: opts.max_tokens }),
  };
}

async function chatNonStream(messages: ChatMessage[], opts: ChatOpts): Promise<NonStreamResult> {
  const resp = await fetch(`${baseUrl()}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(bodyFor(messages, opts, false)),
  });
  if (!resp.ok) {
    const msg = await resp.text().catch(() => "");
    throw new Error(`openai ${resp.status}: ${msg}`);
  }
  const j = await resp.json() as {
    choices: Array<{ message: { content: string }; finish_reason: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    content: j.choices?.[0]?.message?.content ?? "",
    prompt_tokens: j.usage?.prompt_tokens ?? 0,
    completion_tokens: j.usage?.completion_tokens ?? 0,
  };
}

async function chatStream(messages: ChatMessage[], opts: ChatOpts): Promise<ReadableStream<ChatChunk>> {
  const resp = await fetch(`${baseUrl()}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      ...authHeaders(),
    },
    body: JSON.stringify(bodyFor(messages, opts, true)),
  });
  if (!resp.ok || !resp.body) {
    const msg = await resp.text().catch(() => "");
    throw new Error(`openai ${resp.status}: ${msg}`);
  }
  return openAiSseToChunks(resp.body);
}

const CAPS: Capabilities = {
  canList: false,
  canPull: false,
  canDelete: false,
  canLoad: false,
  canUnload: false,
  canWarm: false,
};

export const openaiProvider: Provider = {
  id: "openai",

  activeModelLabel(): Promise<string> {
    return Promise.resolve(getRuntime().openai.model);
  },

  chatStream,
  chatNonStream,

  capabilities(): Capabilities { return CAPS; },

  listInstalled(): Promise<ModelEntry[]> {
    throw new NotSupported("listInstalled", "openai");
  },
  listLoaded(): Promise<LoadedEntry[]> {
    throw new NotSupported("listLoaded", "openai");
  },
  pullModel(_spec: PullSpec, _onProgress: (p: PullProgress) => void): Promise<void> {
    throw new NotSupported("pullModel", "openai");
  },
  loadModel(_name: string, _opts?: LoadOpts): Promise<void> {
    throw new NotSupported("loadModel", "openai");
  },
  unloadModel(_name?: string): Promise<void> {
    throw new NotSupported("unloadModel", "openai");
  },
  warmModel(_name: string): Promise<void> {
    throw new NotSupported("warmModel", "openai");
  },
  deleteModel(_name: string): Promise<void> {
    throw new NotSupported("deleteModel", "openai");
  },
};
