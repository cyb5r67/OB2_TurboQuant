// `.last_loaded.json` persistence: lets the manager auto-restore the last
// loaded model after a docker restart or process crash.

export interface LoadedState {
  filename: string;
  ctx_size: number;
  gpu_layers: number;
  parallel_slots: number;
  cache_type_k?: string;
  cache_type_v?: string;
  port: number;
  started_at: string;
}

const FILENAME = ".last_loaded.json";

export async function readLoaded(modelsDir: string): Promise<LoadedState | null> {
  const path = `${modelsDir}/${FILENAME}`;
  let text: string;
  try { text = await Deno.readTextFile(path); }
  catch { return null; }
  try {
    const j = JSON.parse(text) as LoadedState;
    // Strict guard on EVERY required field. A partial/hand-edited file is
    // treated as if absent — Task 9's restoreOnStartup passes these values
    // directly to supervisor.spawn(), so undefineds propagate badly.
    if (
      typeof j.filename !== "string" ||
      typeof j.ctx_size !== "number" ||
      typeof j.gpu_layers !== "number" ||
      typeof j.parallel_slots !== "number" ||
      typeof j.port !== "number" ||
      typeof j.started_at !== "string"
    ) return null;
    return j;
  } catch {
    return null;
  }
}

// Note: plain writeTextFile is acceptable because the payload is <4KB (a single
// atomic kernel write on Linux) and readLoaded defends against truncated /
// malformed reads. If LoadedState ever grows past PIPE_BUF or gains nested
// structure, switch to temp+rename.
export async function writeLoaded(modelsDir: string, s: LoadedState): Promise<void> {
  const path = `${modelsDir}/${FILENAME}`;
  await Deno.writeTextFile(path, JSON.stringify(s, null, 2));
}

export async function clearLoaded(modelsDir: string): Promise<void> {
  const path = `${modelsDir}/${FILENAME}`;
  try { await Deno.remove(path); }
  catch { /* idempotent */ }
}
