// MCP route handler — registers OB2's three tools and dispatches via StreamableHTTPTransport.
//
// Tools (each calls the Python sidecar via JSON-RPC):
//   - capture_knowledge   → sidecar.capture
//   - search_knowledge    → sidecar.retrieve
//   - knowledge_stats     → sidecar.knowledge_stats

import { Hono, type Context } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Config } from "../config.ts";
import type { Sidecar } from "../sidecar.ts";
import { mcpAuthMulti, type AuthContext, hasPermission } from "../users.ts";
import { dispatch, loadIngestEnv } from "../import/runner.ts";
import { getProvider, type ChatMessage } from "../llm/provider.ts";

// AsyncLocalStorage carries the authenticated user's context into MCP tool handlers.
const authStore = new AsyncLocalStorage<AuthContext>();

function getAuth(): AuthContext | undefined {
  return authStore.getStore();
}

function checkPerm(domain: string, required: "read" | "write" | "admin"): string | null {
  const auth = getAuth();
  if (!auth) return null; // no multi-user mode — allow (single-key already validated)
  if (!hasPermission(auth, domain, required)) {
    return `Permission denied: ${auth.username} needs '${required}' on @${domain}`;
  }
  return null;
}

function checkGlobalAdmin(): string | null {
  const auth = getAuth();
  if (!auth) return null; // single-key mode — allow
  if (!auth.global_admin) return `Permission denied: ${auth.username} is not a global admin`;
  return null;
}

// ─────────────────────────────────────────────────────────────
// Sidecar result shapes (mirrors retrieval/sidecar.py)
// ─────────────────────────────────────────────────────────────

interface CaptureResult {
  doc_id: string;
  domain: string;
  doc_count: number;
  created_at?: string;
}

interface RetrievedDoc {
  doc_id: string;
  content: string;
  score: number;
  match_reason: string;
  tags: string[];
  source: string;
  created_at?: string;
}

interface RetrieveResult {
  docs: RetrievedDoc[];
  unknown_domain?: boolean;
}

interface StatsResult {
  domain?: string;
  doc_count?: number;
  exists?: boolean;
  domains?: Array<{ domain: string; doc_count: number }>;
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
  }>;
  budget_summary: Record<string, number>;
  metadata: Record<string, unknown>;
  unknown_domain?: boolean;
}

// ─────────────────────────────────────────────────────────────

function newDocId(): string {
  // doc_id = timestamp + 6-char random; monotonically sortable, no uuid dep.
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rnd}`;
}

function buildMcpServer(config: Config, sidecar: Sidecar): McpServer {
  const server = new McpServer({
    name: "ob2",
    version: "0.1.0",
  });

  // ── Tool 1: capture_knowledge ──
  server.registerTool(
    "capture_knowledge",
    {
      title: "Capture Knowledge",
      description:
        "Save a fact, rule, or note to a domain's knowledge store. Use this when the user says 'remember', 'save', 'add to OB2', or similar. The text is embedded and indexed for later retrieval. Returns immediately; embedding happens in the background.",
      inputSchema: {
        domain: z.string().describe(
          "Domain to save into, e.g. 'netsec', 'company-policy', 'coding-standards'.",
        ),
        text: z.string().describe("The knowledge to save (free-form text)."),
        tags: z.array(z.string()).optional().describe("Optional topical tags for later filtering."),
        source: z.string().optional().describe("Where this came from: 'user', 'runbook', 'slack', etc."),
      },
    },
    async ({ domain, text, tags, source }) => {
      const auth = getAuth();
      const denied = checkPerm(domain, "write");
      if (denied) return { content: [{ type: "text" as const, text: denied }], isError: true };
      try {
        const doc_id = newDocId();
        const r = await sidecar.call<CaptureResult>("capture", {
          domain,
          doc_id,
          text,
          tags: tags ?? [],
          source: source ?? "user",
          metadata: auth?.username ? { _ob2_uploaded_by: auth.username } : {},
        });
        return {
          content: [{
            type: "text" as const,
            text: `Captured to @${domain} as doc ${r.doc_id}${r.created_at ? ` at ${r.created_at}` : ""}. Domain now has ${r.doc_count} document(s).`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `capture_knowledge error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // ── Tool: capture_file ──
  // Ingest a local file (under /data/) or an http(s) URL. Goes through the
  // same dispatch() pipeline as the dashboard upload, so chunks land in the
  // domain with rich _ob2_import_* metadata and the existing citation path
  // surfaces a meaningful source label.
  server.registerTool(
    "capture_file",
    {
      title: "Capture File or URL",
      description:
        "Convert a file or URL to Markdown and capture into a domain. Supports PDF, DOCX, PPTX, XLSX, HTML, CSV, JSON, XML, MD, TXT, images (OCR), audio (Whisper transcription), ZIP archives, HTTP URLs, and YouTube transcripts. Files must live inside the container's /data volume; arbitrary host paths are refused. Use this whenever the user wants to ingest a document, slide deck, spreadsheet, image, audio recording, or webpage into a domain.",
      inputSchema: {
        domain: z.string().describe("Domain to capture into."),
        path_or_url: z.string().describe("Either a /data/... filesystem path or an https:// URL."),
        source_label: z.string().optional().describe("Override the auto-derived filename used in citations."),
        tags: z.array(z.string()).optional().describe("Topical tags for later filtering."),
      },
    },
    async ({ domain, path_or_url, source_label, tags }) => {
      const fileAuth = getAuth();
      const denied = checkPerm(domain, "write");
      if (denied) return { content: [{ type: "text" as const, text: denied }], isError: true };
      try {
        const isUrl = /^https?:\/\//i.test(path_or_url);
        let resolvedPath = path_or_url;
        if (!isUrl) {
          // Path mode: must canonicalise under /data/. No symlinks following outside the volume.
          const real = await Deno.realPath(path_or_url).catch(() => null);
          if (!real || !real.startsWith("/data/")) {
            return {
              content: [{ type: "text" as const, text: `capture_file error: path_outside_volume — ${path_or_url}` }],
              isError: true,
            };
          }
          resolvedPath = real;
        }

        const env = loadIngestEnv();
        const out = await dispatch(sidecar, {
          domain,
          source: isUrl
            ? { kind: "url" as const, url: path_or_url }
            : { kind: "path" as const, path: resolvedPath },
          source_label,
          tags,
          uploaded_by: fileAuth?.username,
        }, env);

        if ("job_id" in out) {
          return {
            content: [{
              type: "text" as const,
              text: `Capture queued (job ${out.job_id}). This is a long-running ingestion (audio or large file). Check status via GET /admin/domains/${domain}/import/jobs/${out.job_id}.`,
            }],
          };
        }

        const lines = [
          `Captured ${out.chunks_captured} chunk(s) into @${domain} as ${out.source_format}.`,
          `Doc IDs: ${out.doc_ids.slice(0, 5).join(", ")}${out.doc_ids.length > 5 ? ", ..." : ""}.`,
        ];
        if (out.warnings.length) {
          lines.push(`Warnings:`);
          for (const w of out.warnings) lines.push(`  - ${w}`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: `capture_file error: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // ── Tool 2: search_knowledge ──
  server.registerTool(
    "search_knowledge",
    {
      title: "Search Knowledge",
      description:
        "Retrieve relevant documents from a domain's knowledge store. Use this when answering questions that may involve captured team knowledge. Returns ranked hits with content and scores.",
      inputSchema: {
        domain: z.string().describe("Domain to search within."),
        query: z.string().describe("Natural-language query."),
        top_k: z.number().optional().default(5).describe("Number of hits to return (default 5)."),
      },
    },
    async ({ domain, query, top_k }) => {
      const denied = checkPerm(domain, "read");
      if (denied) return { content: [{ type: "text" as const, text: denied }], isError: true };
      try {
        const r = await sidecar.call<RetrieveResult>("retrieve", {
          domain,
          query,
          top_k,
        });
        if (r.unknown_domain) {
          return {
            content: [{
              type: "text" as const,
              text: `No knowledge stored in domain @${domain} yet. Use capture_knowledge to add some.`,
            }],
          };
        }
        if (r.docs.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: `No hits for "${query}" in @${domain}.`,
            }],
          };
        }
        const lines = r.docs.map((d, i) => {
          const parts: (string | null)[] = [
            `--- Result ${i + 1} (score ${d.score.toFixed(3)}, ${d.match_reason}) ---`,
            `Source: ${d.source}  Tags: ${d.tags.length ? d.tags.join(", ") : "(none)"}`,
            `Doc ID: ${d.doc_id}`,
            d.created_at ? `Captured: ${d.created_at}` : null,
            "",
            d.content,
          ];
          return parts.filter(Boolean).join("\n");
        });
        return {
          content: [{
            type: "text" as const,
            text: `${r.docs.length} hit(s) in @${domain}:\n\n${lines.join("\n\n")}`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `search_knowledge error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // ── Tool 3: knowledge_stats ──
  server.registerTool(
    "knowledge_stats",
    {
      title: "Knowledge Stats",
      description:
        "Report document counts per domain. Call with no domain to see all domains; call with a specific domain for its count.",
      inputSchema: {
        domain: z.string().optional().describe(
          "Optional: specific domain to query. Omit for all domains.",
        ),
      },
    },
    async ({ domain }) => {
      try {
        const r = await sidecar.call<StatsResult>("knowledge_stats", domain ? { domain } : {});
        if (r.domains !== undefined) {
          if (r.domains.length === 0) {
            return { content: [{ type: "text" as const, text: "No domains have any captured knowledge yet." }] };
          }
          const rows = r.domains.map((d) => `  @${d.domain}: ${d.doc_count} doc(s)`);
          return {
            content: [{
              type: "text" as const,
              text: `Domains:\n${rows.join("\n")}`,
            }],
          };
        }
        if (r.exists === false) {
          return {
            content: [{
              type: "text" as const,
              text: `Domain @${r.domain} has no captured knowledge.`,
            }],
          };
        }
        return {
          content: [{
            type: "text" as const,
            text: `@${r.domain}: ${r.doc_count} document(s).`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `knowledge_stats error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // ── Tool 4: chat_knowledge ──
  server.registerTool(
    "chat_knowledge",
    {
      title: "Chat with Knowledge",
      description:
        "Ask a question grounded in a domain's knowledge. Retrieves relevant docs, " +
        "compresses to token budget, and synthesizes an answer via the local LLM. " +
        "Use this for questions that need domain-specific grounding — equivalent to " +
        "typing '@domain <question>' in the chat gateway.",
      inputSchema: {
        domain: z.string().describe("Domain to query."),
        question: z.string().describe("Natural-language question."),
      },
    },
    async ({ domain, question }) => {
      const denied = checkPerm(domain, "read");
      if (denied) return { content: [{ type: "text" as const, text: denied }], isError: true };
      try {
        // 1. Retrieve + compress
        const ctx = await sidecar.call<SidecarContextResult>("build_context", {
          domain,
          query: question,
          budget_tokens: 1500,
        });
        if (ctx.unknown_domain) {
          return {
            content: [{
              type: "text" as const,
              text: `No knowledge in @${domain}. Use capture_knowledge to add some.`,
            }],
          };
        }
        if (!ctx.compressed_text) {
          return {
            content: [{
              type: "text" as const,
              text: `No relevant docs found in @${domain} for "${question}".`,
            }],
          };
        }

        // 2. Synthesize via Ollama
        const messages: ChatMessage[] = [
          {
            role: "system",
            content:
              "Answer using the SOURCES below as ground truth. " +
              "If the sources don't contain the answer, say you don't know.\n\n" +
              "=== SOURCES ===\n" + ctx.compressed_text,
          },
          { role: "user", content: question },
        ];
        const r = await getProvider().chatNonStream(messages, {});

        // 3. Format response with sources
        const sourceList = ctx.retrieved_docs
          .map((d: SidecarContextResult["retrieved_docs"][number], i: number) =>
            `[${i + 1}] ${d.doc_id}${d.tags?.length ? ` (${d.tags.join(", ")})` : ""}`,
          )
          .join("\n");

        return {
          content: [{
            type: "text" as const,
            text: r.content +
              (sourceList ? `\n\nSources:\n${sourceList}` : ""),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `chat_knowledge error: ${(err as Error).message}`,
          }],
          isError: true,
        };
      }
    },
  );

  // ── Tool 5: create_domain ──
  server.registerTool(
    "create_domain",
    {
      title: "Create Domain",
      description:
        "Create a new knowledge domain. Use this when the user wants to store knowledge in a topic area that doesn't exist yet. " +
        "Domain names must be lowercase letters, numbers, and hyphens only (max 64 chars). Requires global admin privileges.",
      inputSchema: {
        domain: z.string().describe("Domain name (lowercase letters, numbers, hyphens only, e.g. 'netsec', 'company-policy')."),
        description: z.string().optional().describe("Optional human-readable description of this domain's purpose."),
      },
    },
    async ({ domain, description }) => {
      const denied = checkGlobalAdmin();
      if (denied) return { content: [{ type: "text" as const, text: denied }], isError: true };
      try {
        await sidecar.call<{ ok: boolean; domain: string }>("create_domain", {
          domain,
          description: description ?? "",
        });
        return {
          content: [{
            type: "text" as const,
            text: `Domain @${domain} created.${description ? ` Description: "${description}"` : ""}`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `create_domain error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // ── Tool 6: delete_doc ──
  server.registerTool(
    "delete_doc",
    {
      title: "Delete Document",
      description:
        "Permanently delete a single document from a domain. This is irreversible. " +
        "You MUST ask the user for explicit confirmation before calling with confirmed=true. " +
        "When confirmed is omitted or false, this tool describes what would be deleted without doing anything.",
      inputSchema: {
        domain: z.string().describe("Domain containing the document."),
        doc_id: z.string().describe("Document ID to delete (from search_knowledge results)."),
        confirmed: z.boolean().optional().describe(
          "Set true only after the user has explicitly confirmed the deletion. Omit to preview without deleting.",
        ),
      },
    },
    async ({ domain, doc_id, confirmed }) => {
      const denied = checkPerm(domain, "admin");
      if (denied) return { content: [{ type: "text" as const, text: denied }], isError: true };
      if (!confirmed) {
        return {
          content: [{
            type: "text" as const,
            text:
              `Confirmation required: permanently delete doc "${doc_id}" from @${domain}. ` +
              `This cannot be undone. Ask the user to confirm, then call delete_doc again with confirmed=true.`,
          }],
        };
      }
      try {
        const r = await sidecar.call<{ deleted: boolean }>("delete", { domain, doc_id });
        return {
          content: [{
            type: "text" as const,
            text: r.deleted
              ? `Deleted doc "${doc_id}" from @${domain}.`
              : `Doc "${doc_id}" not found in @${domain}.`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `delete_doc error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // ── Tool 7: delete_domain ──
  server.registerTool(
    "delete_domain",
    {
      title: "Delete Domain",
      description:
        "Permanently delete an entire domain and ALL its documents. This is irreversible. " +
        "You MUST ask the user for explicit confirmation before calling with confirmed=true. " +
        "When confirmed is omitted or false, this tool describes what would be deleted without doing anything.",
      inputSchema: {
        domain: z.string().describe("Domain to delete entirely."),
        confirmed: z.boolean().optional().describe(
          "Set true only after the user has explicitly confirmed the deletion. Omit to preview without deleting.",
        ),
      },
    },
    async ({ domain, confirmed }) => {
      const denied = checkGlobalAdmin();
      if (denied) return { content: [{ type: "text" as const, text: denied }], isError: true };
      if (!confirmed) {
        let docCount = "an unknown number of";
        try {
          const stats = await sidecar.call<StatsResult>("knowledge_stats", { domain });
          if (stats.doc_count !== undefined) docCount = String(stats.doc_count);
        } catch { /* ignore — warning still shown */ }
        return {
          content: [{
            type: "text" as const,
            text:
              `Confirmation required: permanently delete domain @${domain} and all ${docCount} document(s) it contains. ` +
              `This cannot be undone. Ask the user to confirm, then call delete_domain again with confirmed=true.`,
          }],
        };
      }
      try {
        const r = await sidecar.call<{ deleted_count: number }>("delete_domain", { domain });
        return {
          content: [{
            type: "text" as const,
            text: `Domain @${domain} deleted. ${r.deleted_count} document(s) removed.`,
          }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `delete_domain error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

// ─────────────────────────────────────────────────────────────

type AppEnv = { Variables: { auth?: AuthContext } };

export function mcpRoutes(config: Config, sidecar: Sidecar): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // Use multi-user auth (sets c.auth with domain permissions).
  // Falls back to single-key mode if users.json doesn't exist.
  app.use("*", mcpAuthMulti(config));

  // StreamableHTTPTransport is stateless per-request; create a fresh one
  // per call and connect it to the shared McpServer. The McpServer instance
  // is built once (tools registered once) and reused across requests.
  const server = buildMcpServer(config, sidecar);

  app.all("*", async (c) => {
    const transport = new StreamableHTTPTransport();
    await server.connect(transport);
    // Carry the authenticated user context into MCP tool handlers via AsyncLocalStorage.
    // In single-key mode, auth context is a global admin; in multi-user mode, it's
    // the specific user with their domain permissions.
    const auth = c.get("auth");
    if (auth) {
      return authStore.run(auth, () => transport.handleRequest(c));
    }
    return transport.handleRequest(c);
  });

  return app;
}
