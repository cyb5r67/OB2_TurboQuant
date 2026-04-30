// `.last_loaded.json` persistence: lets the manager auto-restore the last
// loaded model after a docker restart or process crash.

export interface LoadedState {
  filename: string;
  ctx_size: number;
  gpu_layers: number;
  parallel_slots: number;
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
    if (typeof j.filename !== "string" || typeof j.ctx_size !== "number") return null;
    return j;
  } catch {
    return null;
  }
}

export async function writeLoaded(modelsDir: string, s: LoadedState): Promise<void> {
  const path = `${modelsDir}/${FILENAME}`;
  await Deno.writeTextFile(path, JSON.stringify(s, null, 2));
}

export async function clearLoaded(modelsDir: string): Promise<void> {
  const path = `${modelsDir}/${FILENAME}`;
  try { await Deno.remove(path); }
  catch { /* idempotent */ }
}
