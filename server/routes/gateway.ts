// OpenAI-compatible inference gateway.
//
// Routes:
//   GET  /v1/models               — list domains as model IDs (ob2-<domain>)
//   POST /v1/chat/completions     — streaming or non-streaming; parses @domain
//                                   from user messages OR ob2-<domain> model id,
//                                   retrieves context, injects, forwards to Ollama
//
// Domain resolution precedence:
//   1. @domain prefix in the last user message (e.g. "@netsec how do I...")
//   2. model field of form "ob2-<domain>"
//   3. None → pass-through, no retrieval

import { Hono } from "hono";
import type { Config } from "../config.ts";
import type { Sidecar } from "../sidecar.ts";
import { bearerAuthMulti, type AuthContext, hasPermission } from "../users.ts";
import { getRuntime } from "../runtime_config.ts";
import { classifyQuery } from "./classifier.ts";
import { signFileToken } from "../auth/file_signing.ts";

type AppEnv = { Variables: { auth?: AuthContext } };

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
}

interface SidecarContextResult {
  compressed_text: string;
  retrieved_docs: Array<{
    doc_id: string;
    content: string;
    score: number;
    match_reason: string;
    tags: string[];
    source: string;
    _ob2_import_file_id?: string | null;
    _ob2_import_filename?: string | null;
    _ob2_chunk_index?: number | null;
  }>;
  budget_summary: Record<string, number>;
  metadata: Record<string, unknown>;
  unknown_domain?: boolean;
}

interface SidecarDomainListResult {
  domains: string[];
}

interface SidecarSuggestion {
  domain: string;
  matched_aliases: string[];
}

interface SidecarSuggestResult {
  suggestions: SidecarSuggestion[];
}

// ─────────────────────────────────────────────────────────────
// Domain resolution
// ─────────────────────────────────────────────────────────────

/**
 * Parses @domain prefix from a user message. Returns the domain and the
 * message with the prefix stripped, or null if no prefix found.
 *
 * Accepts "@domain …" or "/ob2 domain …" forms.
 */
function parsePrefix(content: string): { domain: string; stripped: string } | null {
  const atMatch = content.match(/^@([a-z0-9][a-z0-9_-]*)\s+(.+)$/is);
  if (atMatch) return { domain: atMatch[1], stripped: atMatch[2].trim() };

  const slashMatch = content.match(/^\/ob2\s+([a-z0-9][a-z0-9_-]*)\s+(.+)$/is);
  if (slashMatch) return { domain: slashMatch[1], stripped: slashMatch[2].trim() };

  return null;
}

/**
 * Resolve the target domain from (model, messages). Returns domain + possibly
 * rewritten messages (with prefix stripped from the last user message).
 */
function resolveDomain(
  model: string,
  messages: ChatMessage[],
): { domain: string | null; messages: ChatMessage[] } {
  // 1. Scan user messages back-to-front for @prefix (usually the last one has it).
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    const parsed = parsePrefix(messages[i].content);
    if (parsed) {
      const rewritten = messages.slice();
      rewritten[i] = { ...rewritten[i], content: parsed.stripped };
      return { domain: parsed.domain, messages: rewritten };
    }
    break; // only check the most recent user message
  }

  // 2. model field of form "ob2-<domain>"
  const modelMatch = model.match(/^ob2-(.+)$/);
  if (modelMatch) return { domain: modelMatch[1], messages };

  return { domain: null, messages };
}

// ─────────────────────────────────────────────────────────────
// Context injection
// ─────────────────────────────────────────────────────────────

function lastUserQuery(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return "";
}

async function augmentWithContext(
  messages: ChatMessage[],
  context: SidecarContextResult,
): Promise<ChatMessage[]> {
  if (context.unknown_domain || !context.compressed_text) {
    return messages;
  }

  // Build a Sources section listing one row per UNIQUE original file the
  // retrieved chunks came from, with a signed download URL. The model is
  // instructed below to cite using the markdown link form so users on
  // Open WebUI (a different origin) can click straight to the file.
  const publicUrl = (Deno.env.get("OB2_PUBLIC_URL") || "").replace(/\/+$/, "");
  const seen = new Set<string>();
  const sourceLines: string[] = [];
  for (const d of context.retrieved_docs) {
    const fid = d._ob2_import_file_id;
    if (!fid || seen.has(fid)) continue;
    seen.add(fid);
    const filename = d._ob2_import_filename || "uploaded-file";
    if (publicUrl) {
      const { token, exp } = await signFileToken(d.source, fid);
      const url = `${publicUrl}/admin/domains/${encodeURIComponent(d.source)}` +
        `/imports/${encodeURIComponent(fid)}?t=${encodeURIComponent(token)}&exp=${exp}`;
      sourceLines.push(`- ${filename}: ${url}`);
    } else {
      sourceLines.push(`- ${filename}`);
    }
  }
  const sourcesBlock = sourceLines.length > 0
    ? "\n\n=== ORIGINAL FILES ===\n" + sourceLines.join("\n")
    : "";

  // Each block in compressed_text already has a header like
  // "[1] @domain · captured YYYY-MM-DD" from the sidecar. No separate
  // SOURCE IDS list — that used to leak opaque doc_ids which Gemma would
  // mangle into fake "test numbers" etc. Citations are just [N].
  const systemContent = [
    "Answer using the SOURCES below as ground truth. If the sources don't",
    "contain the answer, say you don't know.",
    "",
    "Each source block looks like:",
    "    [N] source=@<domain>",
    "    <the fact text>",
    "      (Saved on YYYY-MM-DD.)",
    "",
    "The 'Saved on' date inside a source is when the user added that fact",
    "to their knowledge base — i.e. when they told you. If the user asks",
    "when they told/said/mentioned/saved/added something, that 'Saved on'",
    "date is the answer for the source you're citing.",
    "",
    "Rules (follow exactly):",
    "  1. Cite sources using ONLY the bracketed number — e.g. [1], [2].",
    "     Never append the domain, the date, or anything else after [N].",
    "  2. Each source's 'Saved on' date belongs only to that source. When",
    "     citing a fact from [N], use [N]'s 'Saved on' date — never",
    "     another source's date.",
    "",
    "Example:",
    "    [1] source=@test",
    "    My wife is Jane.",
    "      (Saved on 2026-04-25.)",
    "    [2] source=@test",
    "    My favorite color is blue.",
    "      (Saved on 2026-04-10.)",
    "  User: Who is my wife and when did I tell you?",
    "  RIGHT answer: Your wife is Jane [1]. You told me on April 25, 2026.",
    "  WRONG answer: Your wife is Jane [1]. You told me on April 10, 2026 [2].",
    "  (The second is wrong because [2] is about a color, not a wife — its",
    "   date has nothing to do with the wife fact.)",
    "",
    "=== SOURCES ===",
    context.compressed_text,
    sourcesBlock,
    "",
    sourceLines.length > 0
      ? [
          "After your answer, ALWAYS add a final paragraph titled exactly:",
          "",
          "    **Sources:**",
          "",
          "Then list each ORIGINAL FILE you used (one per line, '-' bullet) as a",
          "Markdown link in the form `[<filename>](<url>)`. Use the EXACT filename",
          "and URL from the ORIGINAL FILES section above — do not invent or alter",
          "the URL. Only list a file if your answer actually used content from it.",
          "Skip the Sources paragraph entirely if you didn't use any of the listed",
          "files (e.g. answering from general knowledge).",
        ].join("\n")
      : "",
  ].join("\n");
  return [
    { role: "system", content: systemContent },
    ...messages,
  ];
}

// ─────────────────────────────────────────────────────────────
// Ollama bridging
// ─────────────────────────────────────────────────────────────

interface OllamaChatChunk {
  model: string;
  created_at: string;
  message?: { role: string; content: string };
  done: boolean;
  done_reason?: string;
}

function nowId(): string {
  return `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// keep_alive = "24h" so Ollama keeps the model loaded in VRAM for 24 hours
// after each request. Default is 5 minutes — any conversation pause longer
// than that means the next message pays a 5–10 s VRAM-load penalty, which
// users perceive as "the GPU is reloading the LLM every time."
// Override per-deployment via OB2_OLLAMA_KEEP_ALIVE.
const OLLAMA_KEEP_ALIVE = Deno.env.get("OB2_OLLAMA_KEEP_ALIVE") || "24h";

async function callOllamaStream(
  config: Config,
  messages: ChatMessage[],
  req: ChatCompletionRequest,
): Promise<ReadableStream<Uint8Array>> {
  const body = {
    model: getRuntime().ollama.model,
    messages,
    stream: true,
    keep_alive: OLLAMA_KEEP_ALIVE,
    options: {
      ...(req.temperature !== undefined && { temperature: req.temperature }),
      ...(req.top_p !== undefined && { top_p: req.top_p }),
      ...(req.max_tokens !== undefined && { num_predict: req.max_tokens }),
    },
  };
  const resp = await fetch(`${getRuntime().ollama.url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok || !resp.body) {
    const msg = await resp.text().catch(() => "");
    throw new Error(`Ollama ${resp.status}: ${msg}`);
  }
  return resp.body;
}

/**
 * Transform Ollama's NDJSON stream into OpenAI chat-completion-chunk SSE.
 */
function ollamaToOpenAiSSE(
  modelId: string,
  ollamaStream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const id = nowId();
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return new ReadableStream({
    async start(controller) {
      const reader = ollamaStream.getReader();
      let buf = "";
      let firstChunk = true;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;

            let chunk: OllamaChatChunk;
            try {
              chunk = JSON.parse(line);
            } catch {
              continue;
            }

            // Emit role delta on first chunk
            if (firstChunk) {
              firstChunk = false;
              const first = {
                id, object: "chat.completion.chunk", created, model: modelId,
                choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(first)}\n\n`));
            }

            if (chunk.message?.content) {
              const payload = {
                id, object: "chat.completion.chunk", created, model: modelId,
                choices: [{
                  index: 0,
                  delta: { content: chunk.message.content },
                  finish_reason: null,
                }],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
            }

            if (chunk.done) {
              const finalChunk = {
                id, object: "chat.completion.chunk", created, model: modelId,
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: chunk.done_reason === "length" ? "length" : "stop",
                }],
              };
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              break;
            }
          }
        }
      } catch (err) {
        const errPayload = {
          error: { message: (err as Error).message, type: "upstream_error" },
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errPayload)}\n\n`));
      } finally {
        controller.close();
      }
    },
  });
}

async function callOllamaNonStream(
  config: Config,
  messages: ChatMessage[],
  req: ChatCompletionRequest,
): Promise<{ content: string; eval_count?: number; prompt_eval_count?: number }> {
  const body = {
    model: getRuntime().ollama.model,
    messages,
    stream: false,
    keep_alive: OLLAMA_KEEP_ALIVE,
    options: {
      ...(req.temperature !== undefined && { temperature: req.temperature }),
      ...(req.top_p !== undefined && { top_p: req.top_p }),
      ...(req.max_tokens !== undefined && { num_predict: req.max_tokens }),
    },
  };
  const resp = await fetch(`${getRuntime().ollama.url}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
    eval_count: j.eval_count,
    prompt_eval_count: j.prompt_eval_count,
  };
}

// ─────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────

export function gatewayRoutes(config: Config, sidecar: Sidecar): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // Multi-user auth (falls back to single-key if no users.json)
  app.use("*", bearerAuthMulti(config));

  // GET /v1/models — list just the generic "ob2" model.
  //
  // Before multi-domain retrieval shipped, each "ob2-<domain>" was the user's
  // way to force retrieval on a specific domain. Now that generic "ob2"
  // searches every domain the caller can read in one scan, per-domain models
  // only add clutter to the dropdown. If someone genuinely wants to pin a
  // query to one domain, they can still type "@domain " at the start of the
  // message — that prefix still short-circuits to single-domain retrieval.
  app.get("/models", (c) => {
    const created = Math.floor(Date.now() / 1000);
    return c.json({
      object: "list",
      data: [{ id: "ob2", object: "model", created, owned_by: "ob2" }],
    });
  });

  // POST /v1/chat/completions
  app.post("/chat/completions", async (c) => {
    // Service token alone may list models but cannot generate chat — chat
    // must always run as a real user so per-domain ACL applies. Open WebUI
    // should forward user identity via X-OpenWebUI-User-Name (enabled by
    // ENABLE_FORWARD_USER_INFO_HEADERS=true on its side).
    const auth = c.get("auth");
    if (auth?.service_only) {
      return c.json({
        error: {
          message:
            "chat requires user identity; enable ENABLE_FORWARD_USER_INFO_HEADERS " +
            "on Open WebUI so X-OpenWebUI-User-Name reaches /v1/chat/completions",
          type: "authentication_error",
        },
      }, 403);
    }
    let req: ChatCompletionRequest;
    try {
      req = await c.req.json();
    } catch {
      return c.json({
        error: { message: "invalid JSON body", type: "invalid_request_error" },
      }, 400);
    }
    if (!Array.isArray(req.messages) || req.messages.length === 0) {
      return c.json({
        error: { message: "messages[] is required", type: "invalid_request_error" },
      }, 400);
    }
    const stream = req.stream ?? false;
    const modelId = req.model || "ob2";

    // Resolve domain, possibly rewrite messages (strip prefix)
    const { domain, messages: resolvedMsgs } = resolveDomain(modelId, req.messages);

    // Retrieve + augment if domain identified
    let messagesForModel = resolvedMsgs;
    if (domain) {
      // Check domain permission
      const auth = c.get("auth");
      if (auth && !hasPermission(auth, domain, "read")) {
        return c.json({
          error: {
            message: `Permission denied: ${auth.username} cannot read @${domain}`,
            type: "permission_error",
          },
        }, 403);
      }
      try {
        const query = lastUserQuery(resolvedMsgs);
        const ctx = await sidecar.call<SidecarContextResult>("build_context", {
          domain,
          query,
          budget_tokens: 6000,
          show_uploader_in_context: getRuntime().context.show_uploader_in_context,
        });
        messagesForModel = await augmentWithContext(resolvedMsgs, ctx);
      } catch (err) {
        // If retrieval fails, fall back to pass-through rather than error out
        console.error(`retrieval failed for domain=${domain}:`, err);
      }
    } else {
      // No prefix and no model match → search every domain the caller can
      // read in a single pgvector scan, let cosine similarity rank hits
      // across domains together, inject the top hits as context. This
      // replaces the previous classifier-based routing: we don't try to
      // guess which domain has the answer from a name + description, we
      // just look at the actual docs.
      const auth = c.get("auth");
      const isAdmin = !!auth?.global_admin;

      // Candidate set:
      //   - non-admin → exactly the domains they've been granted (any level)
      //   - admin     → every domain the sidecar knows about
      //   - no auth   → shouldn't happen (bearerAuthMulti already ran), but
      //                 treat as empty for defense in depth
      let candidates: string[] = [];
      if (auth) {
        if (isAdmin) {
          try {
            const r = await sidecar.call<SidecarDomainListResult>("list_domains");
            candidates = r.domains ?? [];
          } catch {
            candidates = [];
          }
        } else {
          candidates = Object.keys(auth.domains ?? {});
        }
      }

      if (auth && !isAdmin && candidates.length === 0) {
        return c.json({
          error: {
            message: "You have no domain assignments. Ask an admin to assign you a domain.",
            type: "no_domain_access",
          },
        }, 403);
      }

      const query = lastUserQuery(resolvedMsgs);
      if (query && candidates.length > 0) {
        try {
          const ctx = await sidecar.call<SidecarContextResult>("build_multi_context", {
            domains: candidates,
            query,
            budget_tokens: 6000,  // see note above @ build_context call
            show_uploader_in_context: getRuntime().context.show_uploader_in_context,
          });
          if (ctx.compressed_text && ctx.compressed_text.length > 0) {
            messagesForModel = await augmentWithContext(resolvedMsgs, ctx);
          }
        } catch (err) {
          // Retrieval failed — fall through to vanilla pass-through so the
          // user still gets a Gemma answer (ungrounded, but not an error).
          console.error(`multi-domain retrieval failed:`, err);
        }
      }
    }

    // Forward to Ollama
    if (stream) {
      try {
        const ollamaStream = await callOllamaStream(config, messagesForModel, req);
        const openAiStream = ollamaToOpenAiSSE(modelId, ollamaStream);
        return new Response(openAiStream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          },
        });
      } catch (err) {
        return c.json({
          error: { message: (err as Error).message, type: "upstream_error" },
        }, 502);
      }
    } else {
      try {
        const r = await callOllamaNonStream(config, messagesForModel, req);
        const id = nowId();
        const created = Math.floor(Date.now() / 1000);
        return c.json({
          id,
          object: "chat.completion",
          created,
          model: modelId,
          choices: [{
            index: 0,
            message: { role: "assistant", content: r.content },
            finish_reason: "stop",
          }],
          usage: {
            prompt_tokens: r.prompt_eval_count ?? 0,
            completion_tokens: r.eval_count ?? 0,
            total_tokens: (r.prompt_eval_count ?? 0) + (r.eval_count ?? 0),
          },
        });
      } catch (err) {
        return c.json({
          error: { message: (err as Error).message, type: "upstream_error" },
        }, 502);
      }
    }
  });

  app.all("*", (c) =>
    c.json({
      error: { message: "not implemented on /v1", type: "invalid_request_error" },
    }, 404)
  );

  return app;
}
