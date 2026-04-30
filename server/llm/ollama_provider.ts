// Ollama provider — wraps server/ollama/client.ts and server/ollama/pulls.ts.
// Those modules are NOT modified. The NDJSON-to-ChatChunk parser lives here.

import {
  listInstalled as ollamaListInstalled,
  listLoaded as ollamaListLoaded,
  unloadModel as ollamaUnload,
  warmModel as ollamaWarm,
  deleteModel as ollamaDelete,
  pullModel as ollamaPull,
} from "../ollama/client.ts";
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

interface OllamaChatChunkRaw {
  model?: string;
  message?: { role: string; content: string };
  done: boolean;
  done_reason?: string;
}

function ollamaUrl(): string {
  return getRuntime().ollama.url.replace(/\/+$/, "");
}

function model(): string {
  return getRuntime().ollama.model;
}

function bodyFor(messages: ChatMessage[], opts: ChatOpts, stream: boolean) {
  return {
    model: model(),
    messages,
    stream,
    keep_alive: Deno.env.get("OB2_OLLAMA_KEEP_ALIVE") || "24h",
    options: {
      ...(opts.temperature !== undefined && { temperature: opts.temperature }),
      ...(opts.top_p !== undefined && { top_p: opts.top_p }),
      ...(opts.max_tokens !== undefined && { num_predict: opts.max_tokens }),
    },
  };
}

async function chatNonStream(messages: ChatMessage[], opts: ChatOpts): Promise<NonStreamResult> {
  const resp = await fetch(`${ollamaUrl()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyFor(messages, opts, false)),
  });
  if (!resp.ok) {
    const msg = await resp.text().catch(() => "");
    throw new Error(`Ollama ${resp.status}: ${msg}`);
  }
  const j = await resp.json() as {
    message: { content: string };
    eval_count?: number;
    prompt_eval_count?: number;
  };
  return {
    content: j.message.content,
    prompt_tokens: j.prompt_eval_count ?? 0,
    completion_tokens: j.eval_count ?? 0,
  };
}

async function chatStream(messages: ChatMessage[], opts: ChatOpts): Promise<ReadableStream<ChatChunk>> {
  const resp = await fetch(`${ollamaUrl()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyFor(messages, opts, true)),
  });
  if (!resp.ok || !resp.body) {
    const msg = await resp.text().catch(() => "");
    throw new Error(`Ollama ${resp.status}: ${msg}`);
  }
  return ollamaNdjsonToChunks(resp.body);
}

function ollamaNdjsonToChunks(source: ReadableStream<Uint8Array>): ReadableStream<ChatChunk> {
  const reader = source.getReader();
  const dec = new TextDecoder();
  let buf = "";
  return new ReadableStream<ChatChunk>({
    async pull(controller) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            // Flush any trailing partial line — should be empty in practice.
            if (buf.trim()) {
              try {
                const j = JSON.parse(buf) as OllamaChatChunkRaw;
                controller.enqueue(toChunk(j));
              } catch { /* ignore malformed trailing line */ }
            }
            controller.close();
            return;
          }
          buf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            let j: OllamaChatChunkRaw;
            try {
              j = JSON.parse(line) as OllamaChatChunkRaw;
            } catch {
              // Malformed mid-stream frame — skip rather than aborting the whole response.
              // Matches the previous gateway.ts behavior so a single garbled chunk doesn't
              // truncate a working generation.
              continue;
            }
            controller.enqueue(toChunk(j));
            if (j.done) {
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

function toChunk(j: OllamaChatChunkRaw): ChatChunk {
  return {
    content: j.message?.content ?? "",
    done: j.done,
    finish_reason: j.done ? (j.done_reason === "length" ? "length" : "stop") : undefined,
  };
}

// ─────────────────────────────────────────────────────────────
// Management surface — delegates to existing client.ts / pulls.ts
// ─────────────────────────────────────────────────────────────

const CAPS: Capabilities = {
  canList: true,
  canPull: true,
  canDelete: true,
  canLoad: false,    // Ollama loads on-demand; explicit load is not a concept
  canUnload: true,
  canWarm: true,
};

export const ollamaProvider: Provider = {
  id: "ollama",

  activeModelLabel(): Promise<string> {
    return Promise.resolve(getRuntime().ollama.model);
  },

  chatStream,
  chatNonStream,

  capabilities(): Capabilities {
    return CAPS;
  },

  async listInstalled(): Promise<ModelEntry[]> {
    const rows = await ollamaListInstalled();
    return rows.map((r) => ({
      name: r.name,
      size_bytes: r.size,
      modified_at: r.modified_at,
      details: r.details,
    }));
  },

  async listLoaded(): Promise<LoadedEntry[]> {
    const rows = await ollamaListLoaded();
    return rows.map((r) => ({
      name: r.name,
      details: { expires_at: r.expires_at, size_vram: r.size_vram },
    }));
  },

  async pullModel(spec: PullSpec, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void> {
    if (spec.source !== "ollama" || !spec.name) {
      throw new Error(
        `ollama provider rejected pull spec: source="${spec.source}" name="${spec.name ?? ""}" — expected source="ollama" with a non-empty name`,
      );
    }
    return await ollamaPull(spec.name, (p) => onProgress({
      status: p.status,
      total: p.total,
      completed: p.completed,
    }), signal);
  },

  loadModel(_name: string, _opts?: LoadOpts): Promise<void> {
    throw new NotSupported("loadModel", "ollama");
  },

  async unloadModel(name?: string): Promise<void> {
    if (!name) throw new Error("ollama unload requires a model name");
    return await ollamaUnload(name);
  },

  warmModel(name: string): Promise<void> {
    return ollamaWarm(name);
  },

  deleteModel(name: string): Promise<void> {
    return ollamaDelete(name);
  },
};
