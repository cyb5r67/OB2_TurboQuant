// Ollama HTTP client used by the LLM management UI.
//
// All calls go to `${getRuntime().ollama.url}` — the same value the chat
// gateway uses, so swapping host (e.g. switching from local Ollama to a
// remote one) takes effect everywhere at once.
//
// Endpoints touched:
//   GET    /api/tags             list installed models
//   GET    /api/ps               list models currently loaded in VRAM
//   POST   /api/generate         used to unload (keep_alive=0) and warm up
//   POST   /api/pull             stream NDJSON download progress
//   DELETE /api/delete           remove a model from disk

import { getRuntime } from "../runtime_config.ts";

export interface OllamaModelEntry {
  name: string;
  size: number; // bytes on disk
  modified_at: string;
  digest?: string;
  details?: {
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
  };
}

export interface OllamaLoadedEntry {
  name: string;
  expires_at: string;
  size_vram: number;
}

export interface OllamaPullProgress {
  status: string;          // e.g. "pulling manifest", "downloading", "verifying sha256 digest", "success"
  digest?: string;
  total?: number;          // bytes
  completed?: number;      // bytes
}

function ollamaUrl(): string {
  return getRuntime().ollama.url.replace(/\/+$/, "");
}

/** List models installed on the Ollama host. */
export async function listInstalled(): Promise<OllamaModelEntry[]> {
  const r = await fetch(`${ollamaUrl()}/api/tags`);
  if (!r.ok) throw new Error(`ollama tags ${r.status}: ${await r.text().catch(() => "")}`);
  const j = await r.json() as { models?: OllamaModelEntry[] };
  return j.models ?? [];
}

/** List models currently loaded in VRAM (Ollama's "process list"). */
export async function listLoaded(): Promise<OllamaLoadedEntry[]> {
  // /api/ps is supported by recent Ollama; older builds 404. Treat 404 as empty.
  const r = await fetch(`${ollamaUrl()}/api/ps`);
  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`ollama ps ${r.status}: ${await r.text().catch(() => "")}`);
  const j = await r.json() as { models?: OllamaLoadedEntry[] };
  return j.models ?? [];
}

/**
 * Unload a model from VRAM by issuing a no-op generate with keep_alive=0.
 * Resolves whether the model was actually loaded; Ollama just returns success.
 */
export async function unloadModel(model: string): Promise<void> {
  const r = await fetch(`${ollamaUrl()}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: "",
      stream: false,
      keep_alive: 0,
    }),
  });
  if (!r.ok) throw new Error(`unload ${model}: ${r.status} ${await r.text().catch(() => "")}`);
  // Drain body so the connection can be reused / GC'd promptly.
  await r.body?.cancel().catch(() => {});
}

/**
 * Warm a model into VRAM. Sends a minimal prompt with keep_alive=24h so the
 * model stays resident for normal-cadence chat (matches the gateway default).
 */
export async function warmModel(model: string): Promise<void> {
  const keepAlive = Deno.env.get("OB2_OLLAMA_KEEP_ALIVE") || "24h";
  const r = await fetch(`${ollamaUrl()}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: "ok",
      stream: false,
      keep_alive: keepAlive,
      options: { num_predict: 1 },
    }),
  });
  if (!r.ok) throw new Error(`warm ${model}: ${r.status} ${await r.text().catch(() => "")}`);
  await r.body?.cancel().catch(() => {});
}

/** Delete a model from the Ollama host. */
export async function deleteModel(model: string): Promise<void> {
  const r = await fetch(`${ollamaUrl()}/api/delete`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: model }),
  });
  if (!r.ok) throw new Error(`delete ${model}: ${r.status} ${await r.text().catch(() => "")}`);
}

/**
 * Stream a model pull. The callback fires for every NDJSON status frame
 * Ollama emits. Resolves when the stream ends; rejects on HTTP errors.
 *
 * Ollama's pull stream is NDJSON of `{status, digest?, total?, completed?}`.
 * The terminal frame is `{status: "success"}`. We surface every frame so the
 * job tracker can persist the latest percent-complete.
 */
export async function pullModel(
  model: string,
  onProgress: (p: OllamaPullProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const r = await fetch(`${ollamaUrl()}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: model, stream: true }),
    signal,
  });
  if (!r.ok || !r.body) {
    throw new Error(`pull ${model}: ${r.status} ${await r.text().catch(() => "")}`);
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const p = JSON.parse(line) as OllamaPullProgress & { error?: string };
          if (p.error) throw new Error(`ollama pull error: ${p.error}`);
          onProgress(p);
        } catch (e) {
          // Treat JSON parse failures as fatal — the stream is malformed.
          if (e instanceof Error && e.message.startsWith("ollama pull error")) throw e;
          throw new Error(`pull ${model}: malformed progress frame: ${line.slice(0, 120)}`);
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}
