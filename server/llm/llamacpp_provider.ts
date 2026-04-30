// llamacpp provider — chat data plane goes directly to llama-server's
// OpenAI-compatible /v1/chat/completions. Management calls would go to the
// manager service, but in Phase 1 the manager doesn't exist yet — so every
// management method throws NotImplementedInPhase1.

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
  NotImplementedInPhase1,
  type Provider,
  type PullProgress,
  type PullSpec,
} from "./provider.ts";

function chatUrl(): string {
  return getRuntime().llamacpp.chat_url.replace(/\/+$/, "");
}

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

function openAiSseToChunks(source: ReadableStream<Uint8Array>): ReadableStream<ChatChunk> {
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
          buf += dec.decode(value, { stream: true });

          // SSE frames are separated by blank lines (`\n\n`).
          let sep: number;
          while ((sep = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            // Each frame may have multiple `data:` lines; concat them per spec.
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
            // Suppress role-only deltas (no content, no finish).
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

  activeModelLabel(): Promise<string> {
    // Phase 2 will hit the manager's /healthz to read the loaded model name.
    return Promise.resolve("(llamacpp; manager unreachable in Phase 1)");
  },

  chatStream,
  chatNonStream,

  capabilities(): Capabilities { return CAPS; },

  listInstalled(): Promise<ModelEntry[]> { throw new NotImplementedInPhase1("listInstalled"); },
  listLoaded():    Promise<LoadedEntry[]> { throw new NotImplementedInPhase1("listLoaded"); },
  pullModel(_s: PullSpec, _p: (p: PullProgress) => void): Promise<void> {
    throw new NotImplementedInPhase1("pullModel");
  },
  loadModel(_n: string, _o?: LoadOpts): Promise<void> { throw new NotImplementedInPhase1("loadModel"); },
  unloadModel(_n?: string): Promise<void> { throw new NotImplementedInPhase1("unloadModel"); },
  warmModel(_n: string): Promise<void> { throw new NotImplementedInPhase1("warmModel"); },
  deleteModel(_n: string): Promise<void> { throw new NotImplementedInPhase1("deleteModel"); },
};
