// In-memory tracker for active and recent Ollama pull jobs.
//
// Pulls run as background fetch streams; the dashboard polls
// GET /admin/ollama/pull/:job_id for progress. Jobs are not persisted —
// a server restart cancels in-flight pulls (Ollama itself keeps the
// partial download for resume on a second pull request).

import { pullModel } from "./client.ts";

export type PullStatus = "pending" | "running" | "done" | "error" | "canceled";

export interface PullJob {
  id: string;
  model: string;
  status: PullStatus;
  message: string;          // human-readable (e.g. "downloading manifest")
  total_bytes: number;
  completed_bytes: number;
  percent: number;          // 0..100; 100 once status === "done"
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

const _jobs = new Map<string, PullJob>();
const _controllers = new Map<string, AbortController>();
const MAX_RETAINED_JOBS = 50;

function _now(): string {
  return new Date().toISOString();
}

function _trimRetention(): void {
  if (_jobs.size <= MAX_RETAINED_JOBS) return;
  // Drop oldest finished jobs first, never running ones.
  const finished = Array.from(_jobs.values())
    .filter((j) => j.status !== "running" && j.status !== "pending")
    .sort((a, b) => (a.finished_at ?? "").localeCompare(b.finished_at ?? ""));
  while (_jobs.size > MAX_RETAINED_JOBS && finished.length > 0) {
    const drop = finished.shift()!;
    _jobs.delete(drop.id);
  }
}

export function listPulls(): PullJob[] {
  return Array.from(_jobs.values()).sort((a, b) => b.started_at.localeCompare(a.started_at));
}

export function getPull(id: string): PullJob | undefined {
  return _jobs.get(id);
}

export function cancelPull(id: string): boolean {
  const ctrl = _controllers.get(id);
  if (!ctrl) return false;
  ctrl.abort();
  return true;
}

/**
 * Start a model pull in the background. Returns the job record immediately;
 * progress updates land in `_jobs.get(id)` as Ollama streams frames.
 */
export function startPull(model: string): PullJob {
  // If there's already a running pull for the same model, reuse it.
  for (const j of _jobs.values()) {
    if (j.model === model && (j.status === "pending" || j.status === "running")) {
      return j;
    }
  }
  const id = crypto.randomUUID();
  const job: PullJob = {
    id,
    model,
    status: "pending",
    message: "queued",
    total_bytes: 0,
    completed_bytes: 0,
    percent: 0,
    started_at: _now(),
    finished_at: null,
    error: null,
  };
  _jobs.set(id, job);
  _trimRetention();

  const ctrl = new AbortController();
  _controllers.set(id, ctrl);

  // Fire and forget — caller polls.
  (async () => {
    job.status = "running";
    job.message = "starting";
    try {
      await pullModel(model, (p) => {
        job.message = p.status || "in progress";
        if (typeof p.total === "number" && p.total > 0) {
          job.total_bytes = p.total;
        }
        if (typeof p.completed === "number") {
          job.completed_bytes = p.completed;
        }
        if (job.total_bytes > 0) {
          job.percent = Math.min(100, Math.round((job.completed_bytes / job.total_bytes) * 100));
        }
      }, ctrl.signal);
      job.status = "done";
      job.message = "success";
      job.percent = 100;
    } catch (err) {
      const msg = (err as Error).message || String(err);
      if (ctrl.signal.aborted) {
        job.status = "canceled";
        job.message = "canceled";
      } else {
        job.status = "error";
        job.error = msg;
        job.message = "failed";
      }
    } finally {
      job.finished_at = _now();
      _controllers.delete(id);
    }
  })();

  return job;
}
