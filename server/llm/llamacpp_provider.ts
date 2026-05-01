// llamacpp provider — chat data plane goes directly to llama-server's
// OpenAI-compatible /v1/chat/completions. Management calls go to the manager
// service over HTTP (Phase 2).

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

function chatUrl(): string {
  return getRuntime().llamacpp.chat_url.replace(/\/+$/, "");
}

function managerUrl(): string {
  return getRuntime().llamacpp.manager_url.replace(/\/+$/, "");
}

function managerToken(): string {
  return Deno.env.get("OB2_LLAMACPP_MANAGER_TOKEN") || "";
}

function managerHeaders(): Record<string, string> {
  return { "Authorization": `Bearer ${managerToken()}` };
}

async function managerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = `${managerUrl()}${path}`;
  const headers = { ...(init.headers as Record<string, string> | undefined ?? {}), ...managerHeaders() };
  let r: Response;
  try { r = await fetch(url, { ...init, headers }); }
  catch (e) {
    throw new Error(`manager_unreachable: ${(e as Error).message}`);
  }
  return r;
}

// 5-second in-memory cache for activeModelLabel to avoid hammering the manager
// from every chat-stream open.
let _labelCache: { value: string; at: number } | null = null;
const LABEL_CACHE_MS = 5_000;

function bodyFor(messages: ChatMessage[], opts: ChatOpts, stream: boolean) {
  return {
    messages,
    stream,
    ...(opts.temperature !== undefined && { temperature: opts.temperature }),
    ...(opts.top_p !== undefined && { top_p: opts.top_p }),
    ...(opts.max_tokens !== undefined && { max_tokens: opts.max_tokens }),
  };
}

async function chatNonStream(messages: ChatMessage[], opts: ChatOpts): Promise<NonStreamResult> {
  const resp = await fetch(`${chatUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyFor(messages, opts, false)),
  });
  if (!resp.ok) {
    const msg = await resp.text().catch(() => "");
    throw new Error(`llama-server ${resp.status}: ${msg}`);
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
  const resp = await fetch(`${chatUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
    body: JSON.stringify(bodyFor(messages, opts, true)),
  });
  if (!resp.ok || !resp.body) {
    const msg = await resp.text().catch(() => "");
    throw new Error(`llama-server ${resp.status}: ${msg}`);
  }
  return openAiSseToChunks(resp.body);
}

const CAPS: Capabilities = {
  canList: true,
  canPull: true,
  canDelete: true,
  canLoad: true,
  canUnload: true,
  canWarm: false,
};

export const llamacppProvider: Provider = {
  id: "llamacpp",

  async activeModelLabel(): Promise<string> {
    if (_labelCache && Date.now() - _labelCache.at < LABEL_CACHE_MS) {
      return _labelCache.value;
    }
    let value: string;
    try {
      const r = await fetch(`${managerUrl()}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (!r.ok) {
        value = `(manager error ${r.status})`;
      } else {
        const j = await r.json() as { llama_server?: { running?: boolean; model?: string } };
        value = j.llama_server?.running && j.llama_server?.model
          ? j.llama_server.model
          : "(not loaded)";
      }
    } catch {
      value = "(manager unreachable)";
    }
    _labelCache = { value, at: Date.now() };
    return value;
  },

  chatStream,
  chatNonStream,

  capabilities(): Capabilities { return CAPS; },

  async listInstalled(): Promise<ModelEntry[]> {
    const r = await managerFetch("/v1/models");
    if (!r.ok) throw new Error(`manager /v1/models ${r.status}: ${await r.text().catch(() => "")}`);
    const j = await r.json() as { models: Array<{ filename: string; size_bytes: number; modified_at: string; parsed?: unknown; is_loaded: boolean }> };
    return j.models.map((m) => ({
      name: m.filename,
      size_bytes: m.size_bytes,
      modified_at: m.modified_at,
      details: { parsed: m.parsed, is_loaded: m.is_loaded },
    }));
  },

  async listLoaded(): Promise<LoadedEntry[]> {
    const r = await managerFetch("/v1/models");
    if (!r.ok) throw new Error(`manager /v1/models ${r.status}`);
    const j = await r.json() as { loaded: { filename: string; port: number; started_at: string } | null };
    return j.loaded
      ? [{ name: j.loaded.filename, details: { port: j.loaded.port, started_at: j.loaded.started_at } }]
      : [];
  },

  async pullModel(spec: PullSpec, onProgress: (p: PullProgress) => void): Promise<void> {
    if (spec.source === "ollama") {
      throw new Error("llamacpp provider does not accept Ollama-style pulls");
    }
    const body = spec.source === "url"
      ? { source: "url", url: spec.url }
      : { source: "hf", repo: spec.repo, file: spec.file };
    const r = await managerFetch("/v1/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok || !r.body) {
      throw new Error(`manager /v1/pull ${r.status}: ${await r.text().catch(() => "")}`);
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let p: PullProgress;
        try { p = JSON.parse(line) as PullProgress; }
        catch { continue; /* malformed line — skip, don't fail the whole pull */ }
        if ((p as { status?: string }).status === "error") {
          // Manager surfaced a terminal error frame; propagate so the caller
          // knows the pull failed even with a custom message that doesn't
          // happen to contain the literal word "error".
          throw new Error((p as unknown as { message?: string }).message || "pull failed");
        }
        onProgress(p);
      }
    }
    // Invalidate active-model cache (the next chat may target the freshly pulled model).
    _labelCache = null;
  },

  async loadModel(name: string, opts?: LoadOpts): Promise<void> {
    const r = await managerFetch("/v1/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: name, ...opts }),
    });
    if (!r.ok) throw new Error(`manager /v1/load ${r.status}: ${await r.text().catch(() => "")}`);
    _labelCache = null;
  },

  async unloadModel(_name?: string): Promise<void> {
    const r = await managerFetch("/v1/unload", { method: "POST" });
    if (!r.ok) throw new Error(`manager /v1/unload ${r.status}`);
    _labelCache = null;
  },

  warmModel(_name: string): Promise<void> {
    throw new NotSupported("warmModel", "llamacpp");
  },

  async deleteModel(name: string): Promise<void> {
    const r = await managerFetch(`/v1/models/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (!r.ok) throw new Error(`manager DELETE ${r.status}: ${await r.text().catch(() => "")}`);
  },
};
