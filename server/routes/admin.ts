// Admin HTTP — domain CRUD, alias management, stats.
//
// All routes require Authorization: Bearer <brain_key>.
//
// Routes:
//   GET    /admin/domains                     — list domains + stats
//   GET    /admin/domains/:domain/stats       — stats for one domain
//   GET    /admin/domains/:domain/aliases     — list aliases for a domain
//   POST   /admin/domains/:domain/aliases     — upsert an alias (body: {alias, canonical})
//   DELETE /admin/domains/:domain/docs/:id    — delete one doc
//   DELETE /admin/domains/:domain             — delete entire domain
//   GET    /admin/domains/:domain/export      — stream the domain as a .ob2bundle (admin)
//   POST   /admin/domains/import              — restore a .ob2bundle (multipart, global admin)
//   GET    /admin/ollama/models               — list installed models, active model, env-pinned status
//   POST   /admin/ollama/model                — switch active LLM (global admin)
//   DELETE /admin/ollama/models/:name         — delete a model (global admin)
//   POST   /admin/ollama/pull                 — start a pull job (global admin)
//   GET    /admin/ollama/pull/:job_id         — poll a pull job
//   POST   /admin/ollama/pull/:job_id/cancel  — cancel an in-flight pull (global admin)
//   GET    /admin/domains/:domain/graph/stats        — entity/mention/edge counts (read)
//   GET    /admin/domains/:domain/graph/entities     — paginated entity list (read)
//   GET    /admin/domains/:domain/graph/edges        — relationship edges (read)
//   GET    /admin/domains/:domain/graph/entities/:eid/docs — backing docs (read)
//   POST   /admin/domains/:domain/graph/backfill     — async re-extract pass (admin on domain)
//   GET    /admin/graph/backfills/:job_id            — poll backfill (global admin)
//   POST   /admin/graph/backfills/:job_id/cancel     — cancel backfill (global admin)
//   GET    /admin/graph/backfills                    — list active+recent backfills (global admin)
//   GET    /admin/graph/overlap?domains=a,b,c        — cross-domain entity overlap (auth-filtered)

import { Hono } from "hono";
import type { Config } from "../config.ts";
import type { Sidecar } from "../sidecar.ts";
import {
  bearerAuthMulti,
  listUsers,
  createUser,
  updateUser,
  revokeUser,
  setPassword,
  type Permission,
  type AuthContext,
  hasPermission,
  isValidEmail,
  ZeroAdminError,
  getRawUsersFile,
  saveRawUsersFile,
  RawMtimeConflictError,
} from "../users.ts";
import { validatePasswordStrength } from "../auth/passwords.ts";
import { revokeUserSessions } from "../auth/sessions.ts";
import { getMailer } from "../mail/mailer.ts";
import { renderInviteEmail, renderSmtpTestEmail } from "../mail/templates.ts";
import { generateToken, revokeUserTokens } from "../auth/reset-tokens.ts";
import { getRuntime, validateRuntime, writeRuntime, type MailConfig } from "../runtime_config.ts";
import { safeError } from "./_errors.ts";
import { dispatch, loadIngestEnv } from "../import/runner.ts";
import { getJob } from "../import/jobs.ts";
import { verifyFileToken } from "../auth/file_signing.ts";
import {
  listInstalled as listInstalledOllama,
  listLoaded as listLoadedOllama,
  unloadModel as unloadOllamaModel,
  warmModel as warmOllamaModel,
  deleteModel as deleteOllamaModel,
} from "../ollama/client.ts";
import { startPull, getPull, listPulls, cancelPull } from "../ollama/pulls.ts";

type AppEnv = { Variables: { auth?: AuthContext } };

function requirePerm(
  c: { get: (k: "auth") => AuthContext | undefined; json: (body: unknown, status: number) => Response },
  domain: string,
  required: Permission,
): Response | null {
  const auth = c.get("auth");
  if (!auth) return c.json({ error: "not authenticated" }, 401);
  if (!hasPermission(auth, domain, required)) {
    return c.json({
      error: `insufficient permissions: ${auth.username} needs '${required}' on @${domain}`,
    }, 403);
  }
  return null;
}

function requireGlobalAdmin(
  c: { get: (k: "auth") => AuthContext | undefined; json: (body: unknown, status: number) => Response },
): Response | null {
  const auth = c.get("auth");
  if (!auth) return c.json({ error: "not authenticated" }, 401);
  if (!auth.global_admin) {
    return c.json({ error: "global admin required" }, 403);
  }
  return null;
}

interface DomainStatsResult {
  domain?: string;
  doc_count?: number;
  total_bytes?: number;
  oldest_at?: string | null;
  newest_at?: string | null;
  exists?: boolean;
  domains?: Array<{ domain: string; doc_count: number }>;
}

interface AliasListResult {
  aliases: Array<{ alias: string; canonical: string }>;
}

function xmlEsc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildGexf(
  domain: string,
  entities: Array<{ entity_id: string; name: string; type: string; mention_count: number }>,
  edges: Array<{ src_id: string; dst_id: string; relation: string; weight: number }>,
): string {
  const date = new Date().toISOString().slice(0, 10);
  const entityIds = new Set(entities.map((e) => e.entity_id));
  const validEdges = edges.filter((e) => entityIds.has(e.src_id) && entityIds.has(e.dst_id));
  const nodes = entities
    .map(
      (e) =>
        `    <node id="${xmlEsc(e.entity_id)}" label="${xmlEsc(e.name)}"><attvalues>` +
        `<attvalue for="0" value="${xmlEsc(e.type)}"/>` +
        `<attvalue for="1" value="${e.mention_count}"/>` +
        `</attvalues></node>`,
    )
    .join("\n");
  const edgeElems = validEdges
    .map(
      (e, i) =>
        `    <edge id="${i}" source="${xmlEsc(e.src_id)}" target="${xmlEsc(e.dst_id)}" weight="${e.weight}">` +
        `<attvalues><attvalue for="0" value="${xmlEsc(e.relation)}"/></attvalues></edge>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gexf xmlns="http://gexf.net/1.3" version="1.3">
  <meta lastmodifieddate="${date}"><creator>OB2</creator><description>Knowledge graph — domain: ${xmlEsc(domain)}</description></meta>
  <graph defaultedgetype="directed" mode="static">
    <attributes class="node" mode="static">
      <attribute id="0" title="entity_type" type="string"/>
      <attribute id="1" title="mention_count" type="integer"/>
    </attributes>
    <attributes class="edge" mode="static">
      <attribute id="0" title="relation" type="string"/>
    </attributes>
    <nodes>
${nodes}
    </nodes>
    <edges>
${edgeElems}
    </edges>
  </graph>
</gexf>`;
}

export function adminRoutes(config: Config, sidecar: Sidecar): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // ─────────────────────────────────────────────────────────────
  // Signed-URL file downloads — registered BEFORE bearerAuthMulti
  // so a request with a valid `?t=` token doesn't get 401'd by the
  // standard auth middleware. The handler does its own auth: signed
  // token first, then session/Bearer fallback for dashboard clicks.
  // ─────────────────────────────────────────────────────────────
  app.get("/domains/:domain/imports/:file_id", async (c) => {
    const domain = c.req.param("domain");
    const file_id = c.req.param("file_id");

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(file_id)) {
      return c.json({ error: "invalid file_id" }, 400);
    }

    // Signed token is the chat-citation path (the URL came from a
    // model-rendered markdown link in Open WebUI; the user has no OB2
    // session in that browser context).
    const t = c.req.query("t");
    const expRaw = c.req.query("exp");
    let signedOk = false;
    if (t && expRaw) {
      const exp = parseInt(expRaw, 10);
      if (Number.isFinite(exp)) {
        signedOk = await verifyFileToken(domain, file_id, t, exp);
      }
    }

    if (!signedOk) {
      // Fall back to standard auth so the dashboard's docs-list
      // download links still work over an authenticated session.
      // We invoke bearerAuthMulti by hand against this single request.
      let authedOk = false;
      await bearerAuthMulti(config)(c, async () => {
        const auth = c.get("auth");
        if (auth && hasPermission(auth, domain, "read")) authedOk = true;
      });
      if (!authedOk) return c.json({ error: "not authenticated" }, 401);
    }

    const dir = `/data/imports/${domain}`;
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const e of Deno.readDir(dir)) entries.push(e);
    } catch {
      return c.json({ error: "not found" }, 404);
    }
    const match = entries.find((e) => e.isFile && e.name.startsWith(`${file_id}.`));
    if (!match) return c.json({ error: "not found" }, 404);

    const ext = match.name.split(".").pop()?.toLowerCase() ?? "";
    const ct = ({
      pdf: "application/pdf",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      html: "text/html",
      txt: "text/plain",
      md: "text/markdown",
      mp3: "audio/mpeg",
      wav: "audio/wav",
      m4a: "audio/mp4",
      zip: "application/zip",
    } as Record<string, string>)[ext] ?? "application/octet-stream";

    const data = await Deno.readFile(`${dir}/${match.name}`);
    return new Response(data, {
      headers: {
        "Content-Type": ct,
        "Content-Disposition": `attachment; filename="${match.name}"`,
        "Cache-Control": "no-store",
      },
    });
  });

  // Multi-user auth — falls back to single-key global admin if users.json absent
  app.use("*", bearerAuthMulti(config));

  // GET /admin/domains — list all domains + doc counts.
  // Each entry is decorated with effective_permission for the caller so the
  // dashboard can grey out domains the user has no access to.
  app.get("/domains", async (c) => {
    try {
      const r = await sidecar.call<DomainStatsResult>("knowledge_stats", {});
      const auth = c.get("auth");
      const entries = r.domains ?? [];
      const decorated = entries.map((e) => {
        const name = (e as { domain?: string }).domain ?? "";
        let effective_permission: Permission | null = null;
        if (auth?.global_admin) {
          effective_permission = "admin";
        } else if (auth) {
          effective_permission = auth.domains[name] ?? null;
        }
        return { ...e, effective_permission };
      });
      return c.json({ domains: decorated });
    } catch (err) {
      return c.json({ error: safeError(err, "internal server error") }, 500);
    }
  });

  // POST /admin/domains — create a new domain (global admin only)
  app.post("/domains", async (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    let body: { domain?: string; description?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const domain = (body.domain || "").trim().toLowerCase();
    if (!domain) return c.json({ error: "domain required" }, 400);
    if (!/^[a-z0-9-]+$/.test(domain) || domain.length > 64) {
      return c.json({
        error: "domain must be lowercase letters, numbers, and hyphens only (max 64 chars)",
      }, 400);
    }
    try {
      const result = await sidecar.call<{ ok: boolean; error?: string }>(
        "create_domain",
        { domain, description: body.description || "" },
      );
      if (!result.ok && result.error === "already_exists") {
        return c.json({ error: `domain @${domain} already exists` }, 409);
      }
      return c.json({ ok: true, domain }, 201);
    } catch (err) {
      return c.json({ error: safeError(err, "internal server error") }, 500);
    }
  });

  // GET /admin/domains/:domain/stats — requires read on domain
  app.get("/domains/:domain/stats", async (c) => {
    const domain = c.req.param("domain");
    const denied = requirePerm(c, domain, "read");
    if (denied) return denied;
    try {
      const r = await sidecar.call<DomainStatsResult>("knowledge_stats", { domain });
      return c.json(r);
    } catch (err) {
      return c.json({ error: safeError(err, "internal server error") }, 500);
    }
  });

  // GET /admin/domains/:domain/aliases — requires read on domain
  app.get("/domains/:domain/aliases", async (c) => {
    const domain = c.req.param("domain");
    const denied = requirePerm(c, domain, "read");
    if (denied) return denied;
    try {
      const r = await sidecar.call<AliasListResult>("list_aliases", { domain });
      return c.json({ aliases: r.aliases });
    } catch (err) {
      return c.json({ error: safeError(err, "internal server error") }, 500);
    }
  });

  // GET /admin/domains/:domain/docs — list user docs (excludes system docs)
  app.get("/domains/:domain/docs", async (c) => {
    const domain = c.req.param("domain");
    const denied = requirePerm(c, domain, "read");
    if (denied) return denied;
    const rawLimit = Number(c.req.query("limit") ?? 100);
    const rawOffset = Number(c.req.query("offset") ?? 0);
    if (!Number.isFinite(rawLimit) || !Number.isFinite(rawOffset) || rawLimit < 0 || rawOffset < 0) {
      return c.json({ error: "limit and offset must be non-negative integers" }, 400);
    }
    const limit = Math.min(200, Math.floor(rawLimit));
    const offset = Math.floor(rawOffset);
    try {
      const r = await sidecar.call<{
        docs: Array<{ doc_id: string; text: string; metadata: Record<string, unknown> }>;
        total: number;
      }>("list_docs", { domain, limit, offset });
      return c.json(r);
    } catch (err) {
      return c.json({ error: safeError(err, "internal server error") }, 500);
    }
  });

  // POST /admin/domains/:domain/import — multipart file upload.
  app.post("/domains/:domain/import", async (c) => {
    const domain = c.req.param("domain");
    const denied = requirePerm(c, domain, "write");
    if (denied) return denied;

    const env = loadIngestEnv();
    const form = await c.req.formData().catch(() => null);
    if (!form) {
      return c.json({ error: { message: "expected multipart body", type: "invalid_request_error" } }, 400);
    }
    const file = form.get("file");
    if (!(file instanceof File)) {
      return c.json({ error: { message: "missing 'file' field", type: "invalid_request_error" } }, 400);
    }
    if (file.size > env.maxBytes) {
      return c.json({ error: { message: `file exceeds ${env.maxBytes} bytes`, type: "payload_too_large" } }, 413);
    }
    const tagsRaw = String(form.get("tags") ?? "");
    const tags = tagsRaw ? tagsRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const source_label = String(form.get("source_label") ?? file.name ?? "uploaded-file");

    // Persist the original bytes under /data/imports/<domain>/<file_id><ext>.
    // file_id is a stable uuid shared across every chunk derived from this
    // upload, so the dashboard can offer a "download original" link per
    // source instead of per-chunk. /data/imports is on the ob2_data volume
    // → survives restarts; the runner doesn't delete it after conversion
    // the way it deletes /tmp/upload-*.
    const file_id = crypto.randomUUID();
    const ext = (file.name.split(".").pop() ?? "bin").toLowerCase().slice(0, 8) || "bin";
    const importsDir = `/data/imports/${domain}`;
    await Deno.mkdir(importsDir, { recursive: true });
    const persistedPath = `${importsDir}/${file_id}.${ext}`;
    const buf = new Uint8Array(await file.arrayBuffer());
    await Deno.writeFile(persistedPath, buf);

    try {
      const out = await dispatch(sidecar, {
        domain,
        source: { kind: "path", path: persistedPath },
        source_label,
        tags,
        file_id,
        original_filename: file.name,
        uploaded_by: c.get("auth")?.username,
      }, env);
      return c.json(out);
    } catch (e) {
      // Roll back the persisted file if dispatch threw before chunks landed.
      Deno.remove(persistedPath).catch(() => {});
      const msg = (e as Error).message || "conversion_failed";
      const status = msg.includes("payload_too_large") ? 413 : 400;
      const type = msg.includes("payload_too_large") ? "payload_too_large" : "conversion_failed";
      return c.json({ error: { message: msg, type } }, status);
    }
  });

  // POST /admin/domains/:domain/import/url — URL ingestion.
  app.post("/domains/:domain/import/url", async (c) => {
    const domain = c.req.param("domain");
    const denied = requirePerm(c, domain, "write");
    if (denied) return denied;

    let body: { url?: string; tags?: string[]; source_label?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { message: "invalid JSON", type: "invalid_request_error" } }, 400);
    }
    if (!body.url) {
      return c.json({ error: { message: "url required", type: "invalid_request_error" } }, 400);
    }

    const env = loadIngestEnv();
    try {
      const out = await dispatch(sidecar, {
        domain,
        source: { kind: "url", url: body.url },
        source_label: body.source_label,
        tags: body.tags ?? [],
        uploaded_by: c.get("auth")?.username,
      }, env);
      return c.json(out);
    } catch (e) {
      const msg = (e as Error).message || "conversion_failed";
      const status = msg.includes("url_blocked") ? 400
                   : msg.includes("payload_too_large") ? 413
                   : msg.includes("upstream_fetch_failed") ? 502
                   : 400;
      const type = msg.includes("url_blocked") ? "url_blocked"
                 : msg.includes("upstream_fetch_failed") ? "upstream_fetch_failed"
                 : msg.includes("payload_too_large") ? "payload_too_large"
                 : "conversion_failed";
      return c.json({ error: { message: msg, type } }, status);
    }
  });

  // GET /admin/domains/:domain/import/jobs/:id — async job status poll.
  app.get("/domains/:domain/import/jobs/:id", (c) => {
    const domain = c.req.param("domain");
    const denied = requirePerm(c, domain, "read");
    if (denied) return denied;
    const id = c.req.param("id");
    const j = getJob(id);
    if (!j || j.domain !== domain) {
      return c.json({ error: { message: "job not found", type: "not_found" } }, 404);
    }
    return c.json(j);
  });

  // POST /admin/domains/:domain/aliases — requires admin on domain
  app.post("/domains/:domain/aliases", async (c) => {
    const domain = c.req.param("domain");
    const denied = requirePerm(c, domain, "admin");
    if (denied) return denied;
    let body: { alias?: string; canonical?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    if (!body.alias || !body.canonical) {
      return c.json({ error: "body requires { alias, canonical }" }, 400);
    }
    try {
      await sidecar.call("upsert_alias", {
        domain,
        alias: body.alias,
        canonical: body.canonical,
      });
      return c.json({ ok: true, domain, alias: body.alias, canonical: body.canonical });
    } catch (err) {
      return c.json({ error: safeError(err, "internal server error") }, 500);
    }
  });

  // DELETE /admin/domains/:domain/docs/:id — requires admin on domain
  app.delete("/domains/:domain/docs/:id", async (c) => {
    const domain = c.req.param("domain");
    const denied = requirePerm(c, domain, "admin");
    if (denied) return denied;
    const id = c.req.param("id");
    try {
      const r = await sidecar.call<{ deleted: boolean }>("delete", {
        domain,
        doc_id: id,
      });
      return c.json(r);
    } catch (err) {
      return c.json({ error: safeError(err, "internal server error") }, 500);
    }
  });

  // GET /admin/domains/:domain/export — stream the domain as a .ob2bundle (tar.gz)
  // Admin perm on the domain. Spools the bundle through a /tmp file because the
  // sidecar protocol is line-delimited JSON; no streaming binary path exists.
  app.get("/domains/:domain/export", async (c) => {
    const domain = c.req.param("domain");
    const denied = requirePerm(c, domain, "admin");
    if (denied) return denied;

    const tmpPath = `/tmp/ob2-export-${crypto.randomUUID()}.ob2bundle`;
    let result: {
      ok: boolean;
      error?: string;
      domain?: string;
      doc_count?: number;
      alias_count?: number;
      file_count?: number;
      bytes_written?: number;
    };
    try {
      result = await sidecar.call("export_domain", { domain, out_path: tmpPath });
    } catch (err) {
      await Deno.remove(tmpPath).catch(() => {});
      return c.json({ error: safeError(err, "export failed") }, 500);
    }
    if (!result.ok) {
      await Deno.remove(tmpPath).catch(() => {});
      const status = result.error === "domain_not_found" ? 404 : 400;
      return c.json({ error: result.error || "export failed" }, status);
    }

    // Stream the temp file into the response and unlink when the stream closes.
    let file: Deno.FsFile;
    try {
      file = await Deno.open(tmpPath, { read: true });
    } catch (err) {
      await Deno.remove(tmpPath).catch(() => {});
      return c.json({ error: safeError(err, "spool open failed") }, 500);
    }
    const cleanup = async () => {
      await Deno.remove(tmpPath).catch(() => {});
    };
    const stream = new ReadableStream({
      async pull(ctrl) {
        const buf = new Uint8Array(64 * 1024);
        const n = await file.read(buf);
        if (n === null) {
          ctrl.close();
          try { file.close(); } catch { /* ignore */ }
          await cleanup();
          return;
        }
        ctrl.enqueue(buf.subarray(0, n));
      },
      async cancel() {
        try { file.close(); } catch { /* ignore */ }
        await cleanup();
      },
    });

    const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 13);
    const filename = `${domain}-${ts}.ob2bundle`;
    return new Response(stream, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(result.bytes_written ?? ""),
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-OB2-Bundle-Domain": result.domain ?? "",
        "X-OB2-Bundle-Doc-Count": String(result.doc_count ?? 0),
        "X-OB2-Bundle-Alias-Count": String(result.alias_count ?? 0),
        "X-OB2-Bundle-File-Count": String(result.file_count ?? 0),
      },
    });
  });

  // POST /admin/domains/import — restore a .ob2bundle (global admin only)
  // Multipart fields: bundle (the file) and optional target_domain (rename).
  app.post("/domains/import", async (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;

    const form = await c.req.formData().catch(() => null);
    if (!form) {
      return c.json({ error: "expected multipart body" }, 400);
    }
    const bundle = form.get("bundle");
    if (!(bundle instanceof File)) {
      return c.json({ error: "missing 'bundle' field" }, 400);
    }
    // 1 GB cap — bundles include raw embeddings + original files. Bigger
    // workloads can re-export in pieces or override later.
    const MAX_BUNDLE_BYTES = 1024 * 1024 * 1024;
    if (bundle.size > MAX_BUNDLE_BYTES) {
      return c.json({ error: `bundle exceeds ${MAX_BUNDLE_BYTES} bytes` }, 413);
    }
    const targetRaw = form.get("target_domain");
    const target_domain = typeof targetRaw === "string" ? targetRaw.trim().toLowerCase() : "";
    if (target_domain && (!/^[a-z0-9-]+$/.test(target_domain) || target_domain.length > 64)) {
      return c.json({ error: "target_domain must be lowercase letters, numbers, hyphens (≤64)" }, 400);
    }

    const tmpPath = `/tmp/ob2-import-${crypto.randomUUID()}.ob2bundle`;
    const buf = new Uint8Array(await bundle.arrayBuffer());
    await Deno.writeFile(tmpPath, buf);

    try {
      const r = await sidecar.call<{
        ok: boolean;
        error?: string;
        detail?: string;
        domain?: string;
        source_domain?: string;
        doc_count?: number;
        alias_count?: number;
        file_count?: number;
      }>("import_domain", {
        in_path: tmpPath,
        ...(target_domain ? { target_domain } : {}),
      });
      if (!r.ok) {
        const status = r.error === "domain_exists"
          ? 409
          : r.error === "embedding_model_mismatch" || r.error === "embedding_dim_mismatch"
            || r.error === "unsupported_bundle_version" || r.error === "bundle_invalid"
            || r.error === "invalid_domain_name"
            ? 400
            : 500;
        return c.json({ error: r.error || "import failed", detail: r.detail }, status);
      }
      return c.json({
        ok: true,
        domain: r.domain,
        source_domain: r.source_domain,
        doc_count: r.doc_count,
        alias_count: r.alias_count,
        file_count: r.file_count,
      }, 201);
    } catch (err) {
      return c.json({ error: safeError(err, "import failed") }, 500);
    } finally {
      await Deno.remove(tmpPath).catch(() => {});
    }
  });

  // DELETE /admin/domains/:domain — delete entire domain (requires admin)
  app.delete("/domains/:domain", async (c) => {
    const domain = c.req.param("domain");
    const denied = requirePerm(c, domain, "admin");
    if (denied) return denied;
    try {
      const r = await sidecar.call<{ deleted_count: number }>("delete_domain", { domain });
      return c.json({ ok: true, domain, ...r });
    } catch (err) {
      return c.json({ error: safeError(err, "internal server error") }, 500);
    }
  });

  // PATCH /admin/domains/:domain — update domain description
  app.patch("/domains/:domain", async (c) => {
    const domain = c.req.param("domain");
    const denied = requirePerm(c, domain, "admin");
    if (denied) return denied;
    let body: { description?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const description = typeof body.description === "string" ? body.description : "";
    try {
      await sidecar.call("set_domain_description", { domain, description });
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: safeError(err, "internal server error") }, 500);
    }
  });

  // GET /admin/sync-status — two-tier sync worker status
  app.get("/sync-status", async (c) => {
    try {
      const r = await sidecar.call<Record<string, unknown>>("sync_status", {});
      return c.json(r);
    } catch (err) {
      return c.json({ error: safeError(err, "internal server error") }, 500);
    }
  });

  // ── User management (global admin only) ──

  // GET /admin/users — list all users (keys masked, global admin only)
  app.get("/users", (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    return c.json({ users: listUsers() });
  });

  // POST /admin/users — create a new user (global admin only)
  app.post("/users", async (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    let body: {
      username?: string;
      domains?: Record<string, string>;
      global_admin?: boolean;
      email?: string;
      send_invite?: boolean;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    if (!body.username) {
      return c.json({ error: "username required" }, 400);
    }
    if (body.send_invite && !body.email) {
      return c.json({ error: "send_invite requires an email" }, 400);
    }
    const mailer = getMailer();
    const publicUrl = getRuntime().mail.public_url;
    if (body.send_invite && !publicUrl) {
      return c.json({ error: "OB2_PUBLIC_URL is not set; cannot build invite link" }, 400);
    }
    try {
      const user = createUser(
        body.username,
        (body.domains ?? {}) as Record<string, Permission>,
        body.global_admin ?? false,
        body.email,
      );
      if (user.global_admin) revokeUserSessions("_admin");

      // Mirror /admin/users/:u/invite shape under an `invite` sub-object so
      // the dashboard's copy-link modal can use the same code path.
      let invite:
        | { sent: boolean; url: string; expires_at: string; send_error?: string }
        | undefined;
      if (body.send_invite) {
        const { plaintext, expiresAt } = await generateToken(user.username, "invite");
        const url = `${publicUrl}/dashboard?token=${plaintext}`;
        if (!mailer?.isConfigured()) {
          invite = { sent: false, url, expires_at: expiresAt, send_error: "smtp_not_configured" };
        } else {
          try {
            const { subject, text, html } = renderInviteEmail({
              username: user.username,
              url,
              ttlDays: 7,
            });
            await mailer.send({ to: user.email!, subject, text, html });
            invite = { sent: true, url, expires_at: expiresAt };
          } catch (e) {
            invite = {
              sent: false,
              url,
              expires_at: expiresAt,
              send_error: (e as Error).message,
            };
          }
        }
      }

      return c.json({
        ok: true,
        username: user.username,
        key: user.key,
        email: user.email,
        domains: user.domains,
        global_admin: user.global_admin,
        ...(invite ? { invite } : {}),
      }, 201);
    } catch (err) {
      return c.json({ error: safeError(err, "internal server error") }, 500);
    }
  });

  // PATCH /admin/users/:username — update domain perms or global_admin
  app.patch("/users/:username", async (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    const username = c.req.param("username");
    let body: { domains?: Record<string, Permission>; global_admin?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    try {
      const updated = updateUser(username, body);
      // Promoting to global admin retires the bootstrap path.
      if (body.global_admin === true) revokeUserSessions("_admin");
      return c.json({ ok: true, user: updated });
    } catch (err) {
      if (err instanceof ZeroAdminError) {
        return c.json({ error: err.message }, 409);
      }
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // POST /admin/users/:username/password — admin-set initial or reset password
  // Used to bootstrap dashboard login for a newly-created user (no old password required).
  app.post("/users/:username/password", async (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    const username = c.req.param("username");
    if (username === "_admin") {
      return c.json({ error: "bootstrap admin cannot have a password" }, 400);
    }
    let body: { password?: string };
    try { body = await c.req.json(); }
    catch { return c.json({ error: "invalid JSON" }, 400); }
    const err = validatePasswordStrength(body.password || "");
    if (err) return c.json({ error: err }, 400);
    try {
      await setPassword(username, body.password || "");
      revokeUserSessions(username); // force re-login with new password
      await revokeUserTokens(username); // invalidate outstanding reset/invite tokens
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // ── POST /admin/users/:username/invite ── (global admin only)
  // Always returns the invite URL + expiry so the dashboard can offer a
  // copy-link fallback regardless of whether the email actually sent.
  app.post("/users/:username/invite", async (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    const username = c.req.param("username");
    const users = listUsers();
    const target = users.find((u) => u.username === username);
    if (!target) return c.json({ error: `user '${username}' not found` }, 404);
    if (!target.email) {
      return c.json({ error: "target user has no email address" }, 400);
    }
    const mailer = getMailer();
    const publicUrl = getRuntime().mail.public_url;
    if (!publicUrl) {
      return c.json({ error: "OB2_PUBLIC_URL is not set; cannot build invite link" }, 400);
    }
    const { plaintext, expiresAt } = await generateToken(username, "invite");
    const url = `${publicUrl}/dashboard?token=${plaintext}`;
    if (!mailer?.isConfigured()) {
      return c.json({
        ok: true,
        sent: false,
        url,
        expires_at: expiresAt,
        send_error: "smtp_not_configured",
      });
    }
    try {
      const { subject, text, html } = renderInviteEmail({ username, url, ttlDays: 7 });
      await mailer.send({ to: target.email, subject, text, html });
      return c.json({ ok: true, sent: true, url, expires_at: expiresAt });
    } catch (e) {
      return c.json({
        ok: true,
        sent: false,
        url,
        expires_at: expiresAt,
        send_error: (e as Error).message,
      });
    }
  });

  // GET /admin/smtp-status — minimal "is email infra ready?" for the UI.
  app.get("/smtp-status", (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    const mailer = getMailer();
    return c.json({ configured: !!(mailer?.isConfigured() && getRuntime().mail.public_url) });
  });

  // ── GET /admin/config/mail ── (global admin only)
  // Returns the current mail config with the password masked. Also reports
  // which fields are pinned by env vars so the UI can disable those inputs.
  app.get("/config/mail", (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    const m = getRuntime().mail;
    const envKeys: Record<string, string> = {
      driver: "OB2_SMTP_DRIVER",
      host: "OB2_SMTP_HOST",
      port: "OB2_SMTP_PORT",
      user: "OB2_SMTP_USER",
      pass: "OB2_SMTP_PASS",
      secure: "OB2_SMTP_SECURE",
      from: "OB2_SMTP_FROM",
      public_url: "OB2_PUBLIC_URL",
    };
    const envLocked: Record<string, boolean> = {};
    for (const [field, envVar] of Object.entries(envKeys)) {
      const v = Deno.env.get(envVar);
      envLocked[field] = v !== undefined && v !== "";
    }
    return c.json({
      mail: {
        driver: m.driver,
        host: m.host,
        port: m.port,
        user: m.user,
        pass: m.pass ? "••••" : "",  // masked — never reveal the plaintext
        secure: m.secure,
        from: m.from,
        public_url: m.public_url,
      },
      env_locked: envLocked,
    });
  });

  // ── POST /admin/config/mail ── (global admin only)
  // Writes a new mail config section into the runtime YAML. An empty `pass`
  // field is treated as "keep the existing value" so re-saving doesn't blank
  // the password. Fields pinned by env vars cannot be overwritten (env wins
  // on the next merge anyway; we explicitly reject to avoid confusing saves).
  app.post("/config/mail", async (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    let body: Partial<MailConfig>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }

    // Preserve the existing password if the caller sent empty or the mask sentinel.
    const currentPass = getRuntime().mail.pass;
    const incomingPass = typeof body.pass === "string" ? body.pass : undefined;
    const effectivePass = (incomingPass === undefined || incomingPass === "" || incomingPass === "••••")
      ? currentPass
      : incomingPass;

    // Build the new mail section, merged onto the existing one.
    const nextMail: MailConfig = {
      ...getRuntime().mail,
      ...(body.driver !== undefined ? { driver: body.driver } : {}),
      ...(body.host !== undefined ? { host: body.host } : {}),
      ...(body.port !== undefined ? { port: body.port } : {}),
      ...(body.user !== undefined ? { user: body.user } : {}),
      pass: effectivePass,
      ...(body.secure !== undefined ? { secure: body.secure } : {}),
      ...(body.from !== undefined ? { from: body.from } : {}),
      ...(body.public_url !== undefined ? { public_url: body.public_url } : {}),
    };

    // Validate then persist. Read the current file config, overlay the new
    // mail section, and write it back atomically via writeRuntime.
    try {
      validateRuntime({ mail: nextMail });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }

    try {
      // Re-fetch the file-level config (without env overrides) and overlay.
      // We use the runtime module's writeRuntime which accepts a full partial.
      // The existing module lacks a getFileConfig + overlay helper, so we
      // construct the next partial from the merged runtime minus env keys.
      // Since env vars ALWAYS win on the next merge, persisting them here is
      // harmless — they'll be re-applied by _applyEnvOverrides on reload.
      const fullNext = {
        ollama: getRuntime().ollama,
        embedder: getRuntime().embedder,
        sync: getRuntime().sync,
        retrieval: getRuntime().retrieval,
        mail: nextMail,
      };
      writeRuntime(fullNext);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: safeError(e, "internal server error") }, 500);
    }
  });

  // ── POST /admin/smtp/test ── (global admin only)
  app.post("/smtp/test", async (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    let body: { to?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const to = (body.to || "").trim();
    if (!to) return c.json({ error: "to required" }, 400);
    const mailer = getMailer();
    if (!mailer?.isConfigured()) {
      return c.json({ error: "mailer not configured" }, 400);
    }
    try {
      const { subject, text, html } = renderSmtpTestEmail();
      await mailer.send({ to, subject, text, html });
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: `SMTP send failed: ${(e as Error).message}` }, 500);
    }
  });

  // DELETE /admin/users/:username — revoke (soft-delete, preserves audit)
  app.delete("/users/:username", async (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    const username = c.req.param("username");
    try {
      const revoked = revokeUser(username);
      await revokeUserTokens(username); // invalidate outstanding reset/invite tokens
      return c.json({ ok: true, user: revoked });
    } catch (err) {
      if (err instanceof ZeroAdminError) {
        return c.json({ error: err.message }, 409);
      }
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // ── Raw users.json editor (global admin only) ──

  // GET /admin/users/raw — return the file verbatim + mtime
  app.get("/users/raw", (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    try {
      return c.json(getRawUsersFile());
    } catch (err) {
      return c.json({ error: safeError(err, "internal server error") }, 500);
    }
  });

  // POST /admin/users/raw — validate + zero-admin rail + atomic write
  app.post("/users/raw", async (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    let body: { content?: string; expected_mtime?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON in request body" }, 400);
    }
    if (typeof body.content !== "string" || typeof body.expected_mtime !== "string") {
      return c.json(
        { error: "body requires { content: string, expected_mtime: string }" },
        400,
      );
    }
    try {
      const { mtime, previouslyHadRealAdmin, nowHasRealAdmin } =
        saveRawUsersFile(body.content, body.expected_mtime);
      // If this save promoted someone (gate transitioned false → true),
      // evict any live _admin sessions to match the create/promote paths.
      if (!previouslyHadRealAdmin && nowHasRealAdmin) {
        revokeUserSessions("_admin");
      }
      return c.json({ ok: true, mtime });
    } catch (err) {
      if (err instanceof RawMtimeConflictError) {
        return c.json({ error: err.message }, 409);
      }
      if (err instanceof ZeroAdminError) {
        return c.json({ error: err.message }, 400);
      }
      if (err instanceof SyntaxError || err instanceof TypeError) {
        return c.json({ error: err.message }, 400);
      }
      return c.json({ error: safeError(err, "internal server error") }, 500);
    }
  });

  // ─────────────────────────────────────────────────────────────
  // LLM management — list, switch, pull, delete Ollama models
  // ─────────────────────────────────────────────────────────────

  // GET /admin/ollama/models — list installed + active + env-pinned status
  app.get("/ollama/models", async (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    try {
      const [installed, loaded] = await Promise.all([
        listInstalledOllama(),
        listLoadedOllama(),
      ]);
      const loadedNames = new Set(loaded.map((m) => m.name));
      const rt = getRuntime();
      const envPinnedModel = (Deno.env.get("OB2_OLLAMA_MODEL") || "").trim();
      const envPinned = envPinnedModel.length > 0;
      return c.json({
        active_model: rt.ollama.model,
        env_pinned: envPinned,
        env_var: envPinned ? "OB2_OLLAMA_MODEL" : null,
        ollama_url: rt.ollama.url,
        installed: installed.map((m) => ({
          name: m.name,
          size_bytes: m.size,
          modified_at: m.modified_at,
          loaded: loadedNames.has(m.name),
          parameter_size: m.details?.parameter_size ?? null,
          quantization: m.details?.quantization_level ?? null,
        })),
        loaded: loaded.map((m) => ({
          name: m.name,
          size_vram: m.size_vram,
          expires_at: m.expires_at,
        })),
        active_pulls: listPulls().filter((j) => j.status === "running" || j.status === "pending"),
      });
    } catch (err) {
      return c.json({ error: safeError(err, "ollama unreachable") }, 502);
    }
  });

  // POST /admin/ollama/model — switch active model (global admin only)
  app.post("/ollama/model", async (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    const envPinned = (Deno.env.get("OB2_OLLAMA_MODEL") || "").trim();
    if (envPinned.length > 0) {
      return c.json({
        error: "model_pinned_by_env",
        detail: `OB2_OLLAMA_MODEL=${envPinned} is set in the container env. ` +
                `Remove it from .env and restart to use the dashboard switcher.`,
      }, 409);
    }
    let body: { model?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const newModel = (body.model || "").trim();
    if (!newModel) return c.json({ error: "model required" }, 400);

    try {
      const installed = await listInstalledOllama();
      if (!installed.some((m) => m.name === newModel)) {
        return c.json({ error: "model_not_installed", detail: newModel }, 400);
      }

      const rt = getRuntime();
      const previous = rt.ollama.model;

      // Persist runtime config first so any concurrent chat reads the new
      // value before warmup completes.
      writeRuntime({ ollama: { ...rt.ollama, model: newModel } });

      // Best-effort unload of the previous model. Failures here aren't fatal —
      // Ollama may have already evicted it under memory pressure.
      if (previous && previous !== newModel) {
        try { await unloadOllamaModel(previous); } catch { /* ignore */ }
      }

      // Warmup the new model so the next chat call doesn't pay the load cost.
      try { await warmOllamaModel(newModel); } catch (e) {
        // Warmup errors don't undo the swap; the model is still selected,
        // but the user should know it didn't load successfully.
        return c.json({
          ok: true,
          warmed: false,
          model: newModel,
          previous_model: previous,
          warm_error: (e as Error).message,
        });
      }
      return c.json({
        ok: true,
        warmed: true,
        model: newModel,
        previous_model: previous,
      });
    } catch (err) {
      return c.json({ error: safeError(err, "switch failed") }, 502);
    }
  });

  // DELETE /admin/ollama/models/:name — delete a model from disk
  app.delete("/ollama/models/:name", async (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    const name = decodeURIComponent(c.req.param("name"));
    const rt = getRuntime();
    if (name === rt.ollama.model) {
      return c.json({
        error: "model_active",
        detail: "Cannot delete the currently active model. Switch to another model first.",
      }, 409);
    }
    try {
      // Unload first so the file isn't held open.
      try { await unloadOllamaModel(name); } catch { /* ignore */ }
      await deleteOllamaModel(name);
      return c.json({ ok: true, deleted: name });
    } catch (err) {
      return c.json({ error: safeError(err, "delete failed") }, 502);
    }
  });

  // POST /admin/ollama/pull — start a model pull job
  app.post("/ollama/pull", async (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    let body: { model?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const model = (body.model || "").trim();
    if (!model) return c.json({ error: "model required" }, 400);
    // Loose validation — Ollama accepts a wide variety of names like
    // "llama3.1:8b", "library/qwen2.5-coder:32b-instruct-q4_K_M", etc.
    if (!/^[A-Za-z0-9_./:-]{1,200}$/.test(model)) {
      return c.json({ error: "invalid_model_name" }, 400);
    }
    const job = startPull(model);
    return c.json(job, 201);
  });

  // GET /admin/ollama/pull/:job_id — poll a pull job
  app.get("/ollama/pull/:job_id", (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    const job = getPull(c.req.param("job_id"));
    if (!job) return c.json({ error: "not found" }, 404);
    return c.json(job);
  });

  // POST /admin/ollama/pull/:job_id/cancel — cancel an in-flight pull
  app.post("/ollama/pull/:job_id/cancel", (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    const ok = cancelPull(c.req.param("job_id"));
    if (!ok) return c.json({ error: "not running" }, 404);
    return c.json({ ok: true });
  });

  // ─────────────────────────────────────────────────────────────
  // Graph RAG — list entities/edges, browse, backfill, cross-domain overlap
  // ─────────────────────────────────────────────────────────────

  app.get("/domains/:domain/graph/stats", async (c) => {
    const domain = c.req.param("domain");
    const denied = requirePerm(c, domain, "read");
    if (denied) return denied;
    try {
      const r = await sidecar.call("graph_stats", { domain });
      return c.json(r);
    } catch (err) {
      return c.json({ error: safeError(err, "graph stats failed") }, 500);
    }
  });

  app.get("/domains/:domain/graph/entities", async (c) => {
    const domain = c.req.param("domain");
    const denied = requirePerm(c, domain, "read");
    if (denied) return denied;
    const limit = Math.min(1000, parseInt(c.req.query("limit") || "200", 10) || 200);
    const offset = Math.max(0, parseInt(c.req.query("offset") || "0", 10) || 0);
    const type = c.req.query("type") || undefined;
    const q = c.req.query("q") || undefined;
    try {
      const r = await sidecar.call("list_entities", { domain, limit, offset, type, q });
      return c.json(r);
    } catch (err) {
      return c.json({ error: safeError(err, "list entities failed") }, 500);
    }
  });

  app.get("/domains/:domain/graph/edges", async (c) => {
    const domain = c.req.param("domain");
    const denied = requirePerm(c, domain, "read");
    if (denied) return denied;
    const src_id = c.req.query("src_id") || undefined;
    const limit = Math.min(50000, parseInt(c.req.query("limit") || "10000", 10) || 10000);
    try {
      const r = await sidecar.call("list_edges", { domain, src_id, limit });
      return c.json(r);
    } catch (err) {
      return c.json({ error: safeError(err, "list edges failed") }, 500);
    }
  });

  app.get("/domains/:domain/graph/entities/:eid/docs", async (c) => {
    const domain = c.req.param("domain");
    const eid = c.req.param("eid");
    const denied = requirePerm(c, domain, "read");
    if (denied) return denied;
    const limit = Math.min(200, parseInt(c.req.query("limit") || "50", 10) || 50);
    try {
      const r = await sidecar.call("docs_for_entity", { domain, entity_id: eid, limit });
      return c.json(r);
    } catch (err) {
      return c.json({ error: safeError(err, "docs lookup failed") }, 500);
    }
  });

  app.post("/domains/:domain/graph/backfill", async (c) => {
    const domain = c.req.param("domain");
    const denied = requirePerm(c, domain, "admin");
    if (denied) return denied;
    try {
      const r = await sidecar.call("graph_backfill_start", { domain });
      return c.json(r, 201);
    } catch (err) {
      return c.json({ error: safeError(err, "backfill start failed") }, 500);
    }
  });

  app.get("/graph/backfills/:job_id", async (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    try {
      const r = await sidecar.call("graph_backfill_status", { job_id: c.req.param("job_id") });
      const result = r as { ok?: boolean; error?: string };
      if (result.ok === false && result.error === "not_found") {
        return c.json({ error: "not found" }, 404);
      }
      return c.json(r);
    } catch (err) {
      return c.json({ error: safeError(err, "backfill status failed") }, 500);
    }
  });

  app.post("/graph/backfills/:job_id/cancel", async (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    try {
      const r = await sidecar.call("graph_backfill_cancel", { job_id: c.req.param("job_id") });
      const result = r as { ok?: boolean; error?: string };
      if (result.ok === false) {
        return c.json({ error: result.error || "cancel failed" }, 404);
      }
      return c.json(r);
    } catch (err) {
      return c.json({ error: safeError(err, "cancel failed") }, 500);
    }
  });

  app.get("/graph/backfills", async (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    try {
      const r = await sidecar.call("graph_backfill_list", {});
      return c.json(r);
    } catch (err) {
      return c.json({ error: safeError(err, "list failed") }, 500);
    }
  });

  app.get("/graph/overlap", async (c) => {
    // Cross-domain entity overlap. ACL-filter the requested domains to the
    // caller's readable set before passing to the sidecar.
    const auth = c.get("auth");
    if (!auth) return c.json({ error: "not authenticated" }, 401);
    const requested = (c.req.query("domains") || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!requested.length) return c.json({ error: "domains query param required" }, 400);
    const readable = auth.global_admin
      ? requested
      : requested.filter((d) => hasPermission(auth, d, "read"));
    if (!readable.length) return c.json({ overlap: [] });
    const name_substr = c.req.query("q") || undefined;
    const limit = Math.min(2000, parseInt(c.req.query("limit") || "500", 10) || 500);
    try {
      const r = await sidecar.call("list_entities_multi", { domains: readable, name_substr, limit });
      return c.json(r);
    } catch (err) {
      return c.json({ error: safeError(err, "overlap query failed") }, 500);
    }
  });

  // GET /admin/domains/:domain/graph/export.gexf — GEXF download for Gephi.
  // Fetches up to 10 000 entities + 50 000 edges and streams GEXF 1.3 XML.
  app.get("/domains/:domain/graph/export.gexf", async (c) => {
    const domain = c.req.param("domain");
    const denied = requirePerm(c, domain, "read");
    if (denied) return denied;
    try {
      const [eRes, edRes] = await Promise.all([
        sidecar.call<{ entities: Array<{ entity_id: string; name: string; type: string; mention_count: number }> }>(
          "list_entities", { domain, limit: 10000 },
        ),
        sidecar.call<{ edges: Array<{ src_id: string; dst_id: string; relation: string; weight: number }> }>(
          "list_edges", { domain, limit: 50000 },
        ),
      ]);
      const xml = buildGexf(domain, eRes.entities ?? [], edRes.edges ?? []);
      const ts = new Date().toISOString().replace(/[:\-T]/g, "").slice(0, 13);
      return new Response(xml, {
        headers: {
          "Content-Type": "application/xml; charset=utf-8",
          "Content-Disposition": `attachment; filename="${domain}-graph-${ts}.gexf"`,
          "Cache-Control": "no-store",
        },
      });
    } catch (err) {
      return c.json({ error: safeError(err, "graph export failed") }, 500);
    }
  });

  // No catch-all here — config_api.ts is mounted on the same /admin prefix,
  // and its routes (/config, /metrics, etc.) must be reachable too.
  return app;
}
