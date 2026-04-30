// In-memory import-job registry with mtime-based persistence to disk.
// Mirrors the pattern used by users.ts / reset-tokens.ts so behavior is
// uniform across the server: in-memory map for speed, atomic write on
// every mutation, hot-reload from disk on startup.

export type JobStatus =
  | "queued"
  | "converting"
  | "chunking"
  | "embedding"
  | "done"
  | "error"
  | "interrupted";

export interface JobRecord {
  id: string;
  domain: string;
  source_label: string;
  status: JobStatus;
  progress?: number;
  result?: Record<string, unknown>;
  error?: { message: string; type: string };
  created_at: string;
  updated_at: string;
}

const STORE_PATH = "/data/import-jobs.json";
const TERMINAL = new Set<JobStatus>(["done", "error", "interrupted"]);

const _jobs = new Map<string, JobRecord>();
let _loaded = false;

export async function initJobs(): Promise<void> {
  try {
    const text = await Deno.readTextFile(STORE_PATH);
    const data = JSON.parse(text) as { jobs?: JobRecord[] };
    for (const j of data.jobs ?? []) {
      // Anything mid-flight at the previous shutdown is now interrupted.
      if (!TERMINAL.has(j.status)) {
        j.status = "interrupted";
        j.error = { message: "server restarted while job was in flight", type: "interrupted" };
        j.updated_at = new Date().toISOString();
      }
      _jobs.set(j.id, j);
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) {
      console.warn("import-jobs: failed to load existing store:", e);
    }
  }
  _loaded = true;
  // Periodic expiry sweep — drop terminal jobs older than 24 h.
  setInterval(() => sweep().catch(() => {}), 60 * 60 * 1000);
}

async function persist(): Promise<void> {
  const tmp = `${STORE_PATH}.tmp.${crypto.randomUUID()}`;
  const data = { jobs: Array.from(_jobs.values()) };
  await Deno.writeTextFile(tmp, JSON.stringify(data, null, 2));
  await Deno.rename(tmp, STORE_PATH);
}

async function sweep(): Promise<void> {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let changed = false;
  for (const [id, j] of _jobs) {
    if (TERMINAL.has(j.status) && Date.parse(j.updated_at) < cutoff) {
      _jobs.delete(id);
      changed = true;
    }
  }
  if (changed) await persist();
}

export async function createJob(domain: string, source_label: string): Promise<JobRecord> {
  if (!_loaded) await initJobs();
  const now = new Date().toISOString();
  const id = `imp_${crypto.randomUUID().slice(0, 12)}`;
  const job: JobRecord = {
    id, domain, source_label,
    status: "queued",
    created_at: now, updated_at: now,
  };
  _jobs.set(id, job);
  await persist();
  return job;
}

export async function updateJob(id: string, patch: Partial<JobRecord>): Promise<JobRecord | null> {
  const j = _jobs.get(id);
  if (!j) return null;
  const next = { ...j, ...patch, updated_at: new Date().toISOString() };
  _jobs.set(id, next);
  await persist();
  return next;
}

export function getJob(id: string): JobRecord | null {
  return _jobs.get(id) ?? null;
}

export function listJobsForDomain(domain: string): JobRecord[] {
  return Array.from(_jobs.values()).filter((j) => j.domain === domain);
}
