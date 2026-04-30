// Single ingest pipeline: any caller (HTTP route, MCP tool) hands us a
// path or URL plus auth context, we drive sniffer → sidecar conversion →
// chunker → capture-loop, and we either return the result synchronously or
// kick off a background job and hand back its id.

import type { Sidecar } from "../sidecar.ts";
import { chunkMarkdown } from "./chunker.ts";
import { sniffMagicBytes, SniffResult } from "./sniffer.ts";
import { fetchUrlToTmp } from "./url_fetcher.ts";
import { createJob, updateJob } from "./jobs.ts";

export interface IngestRequest {
  domain: string;
  source: { kind: "path"; path: string } | { kind: "url"; url: string };
  source_label?: string;
  tags?: string[];
  // When provided, these stamp every chunk's metadata so the original file
  // remains downloadable post-ingestion. Set by the HTTP route after it
  // persists the upload to /data/imports/<domain>/<file_id><ext>.
  file_id?: string;
  original_filename?: string;
  uploaded_by?: string;
}

export interface IngestResult {
  ok: true;
  doc_ids: string[];
  source_format: string;
  chunks_captured: number;
  warnings: string[];
  file_id?: string;
}

export interface IngestJobResponse {
  ok: true;
  job_id: string;
  status: "queued";
}

export interface IngestEnv {
  maxBytes: number;
  syncThresholdBytes: number;
  syncTimeoutSec: number;
}

export function loadIngestEnv(): IngestEnv {
  const max = Number(Deno.env.get("OB2_IMPORT_MAX_BYTES") || 262144000);
  const sync = Number(Deno.env.get("OB2_IMPORT_SYNC_THRESHOLD_BYTES") || 26214400);
  const timeout = Number(Deno.env.get("OB2_IMPORT_SYNC_TIMEOUT_SEC") || 60);
  return { maxBytes: max, syncThresholdBytes: sync, syncTimeoutSec: timeout };
}

const ASYNC_FORMATS = new Set(["zip", "mp3", "wav", "flac", "m4a", "ogg"]);

interface ConvertResult {
  markdown: string;
  title: string | null;
  source_format: string;
  char_count: number;
  warnings: string[];
  duration_ms: number;
}

async function callConvert(sidecar: Sidecar, source: string): Promise<ConvertResult> {
  return await sidecar.call<ConvertResult>("convert_to_markdown", { source });
}

async function captureChunks(
  sidecar: Sidecar,
  req: IngestRequest,
  markdown: string,
  format: string,
  source_label: string,
): Promise<string[]> {
  const chunks = chunkMarkdown(markdown);
  const doc_ids: string[] = [];
  for (const c of chunks) {
    const text = c.breadcrumb ? `${c.breadcrumb}\n\n${c.text}` : c.text;
    const doc_id = `imp_${crypto.randomUUID()}`;
    const meta: Record<string, unknown> = {
      _ob2_import_source: source_label,
      _ob2_import_format: format,
      _ob2_chunk_index: c.chunk_index,
      _ob2_chunk_total: c.chunk_total,
      _ob2_breadcrumb: c.breadcrumb,
    };
    if (req.file_id) meta._ob2_import_file_id = req.file_id;
    if (req.original_filename) meta._ob2_import_filename = req.original_filename;
    if (req.uploaded_by) meta._ob2_uploaded_by = req.uploaded_by;
    await sidecar.call<{ doc_id: string }>("capture", {
      domain: req.domain,
      doc_id,
      text,
      source: source_label,
      tags: req.tags ?? [],
      metadata: meta,
    });
    doc_ids.push(doc_id);
  }
  return doc_ids;
}

/**
 * Full ingest: convert + chunk + capture. Throws on errors so the caller
 * can decide whether to surface or stash on a job record.
 */
async function runIngest(
  sidecar: Sidecar,
  req: IngestRequest,
  resolvedPath: string,
  source_label: string,
): Promise<IngestResult> {
  const conv = await callConvert(sidecar, resolvedPath);
  const ids = await captureChunks(sidecar, req, conv.markdown, conv.source_format, source_label);
  return {
    ok: true,
    doc_ids: ids,
    source_format: conv.source_format,
    chunks_captured: ids.length,
    warnings: conv.warnings,
    file_id: req.file_id,
  };
}

interface SniffedSource {
  path: string;
  sniff: SniffResult | null;
  size: number;
  derivedLabel: string;
}

async function sniffSource(req: IngestRequest, env: IngestEnv): Promise<SniffedSource> {
  if (req.source.kind === "path") {
    const path = req.source.path;
    const stat = await Deno.stat(path);
    if (stat.size > env.maxBytes) throw new Error("payload_too_large");
    const fh = await Deno.open(path, { read: true });
    const head = new Uint8Array(16);
    await fh.read(head);
    fh.close();
    const sniff = sniffMagicBytes(head);
    const label = path.split("/").pop() || path;
    return { path, sniff, size: stat.size, derivedLabel: label };
  }
  // URL
  const fetched = await fetchUrlToTmp(req.source.url, env.maxBytes);
  const url = new URL(req.source.url);
  const label = url.hostname + url.pathname;
  return { path: fetched.path, sniff: fetched.sniffed, size: fetched.size_bytes, derivedLabel: label };
}

function tryUnlink(path: string): void {
  Deno.remove(path).catch(() => {});
}

/**
 * Decide sync vs async, run the pipeline, return the appropriate response.
 */
export async function dispatch(
  sidecar: Sidecar,
  req: IngestRequest,
  env: IngestEnv,
): Promise<IngestResult | IngestJobResponse> {
  const sniffed = await sniffSource(req, env);
  const { path, sniff, size, derivedLabel } = sniffed;
  const source_label = req.source_label || derivedLabel;

  // Office files (docx, pptx, xlsx) start with ZIP magic bytes — the sniffer
  // can't tell them apart from a real ZIP archive. We disambiguate by file
  // extension: if the source name ends in an Office extension, do NOT treat
  // it as a ZIP (which would force the async path for every Word doc upload).
  const officeExt = /\.(docx|pptx|xlsx)(?:[?#]|$)/i;
  const sourceName = req.source.kind === "path" ? req.source.path : req.source.url;
  const isOfficeFile = officeExt.test(sourceName);
  const looksLikeAsyncFormat = sniff?.format
    ? (ASYNC_FORMATS.has(sniff.format) && !(sniff.format === "zip" && isOfficeFile))
    : false;
  const goAsync = size > env.syncThresholdBytes || looksLikeAsyncFormat;

  // Don't unlink persisted uploads — the HTTP route saves them under
  // /data/imports/<domain>/<file_id><ext> on purpose, so the dashboard can
  // offer a "download original" link later. Tmp scratch files (anywhere
  // under /tmp) are still cleaned up.
  const shouldCleanup = path.startsWith("/tmp/");

  if (!goAsync) {
    try {
      return await runIngest(sidecar, req, path, source_label);
    } finally {
      if (shouldCleanup) tryUnlink(path);
    }
  }

  // Async path
  const job = await createJob(req.domain, source_label);
  // Fire and forget; record progress on the job.
  (async () => {
    try {
      await updateJob(job.id, { status: "converting" });
      const result = await runIngest(sidecar, req, path, source_label);
      await updateJob(job.id, { status: "done", result: result as unknown as Record<string, unknown> });
    } catch (e) {
      await updateJob(job.id, {
        status: "error",
        error: { message: (e as Error).message, type: "conversion_failed" },
      });
    } finally {
      if (shouldCleanup) tryUnlink(path);
    }
  })();

  return { ok: true, job_id: job.id, status: "queued" };
}
