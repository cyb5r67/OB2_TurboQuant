// LlamaSupervisor — owns the lifecycle of a single llama-server process.

export interface SpawnOpts {
  filename: string;
  ctx_size: number;
  gpu_layers: number;
  parallel_slots: number;
  cache_type_k?: string;
  cache_type_v?: string;
}

export interface SupervisorState {
  running: boolean;
  pid?: number;
  model?: string;
  port?: number;
  started_at?: string;
}

export interface SupervisorConfig {
  /** Path to the llama-server binary. In Docker: /usr/local/bin/llama-server. */
  binary: string;
  /**
   * Args prepended before the per-spawn args. Used by tests to invoke a stub
   * via `deno run --allow-net <stub.ts>`. In production, leave as `[]`.
   */
  preArgs: string[];
  /** Directory containing the GGUF files referenced by `SpawnOpts.filename`. */
  modelsDir: string;
  /** Port the spawned llama-server should bind. */
  chatPort: number;
}

const STDERR_RING_BYTES = 4096;

export class LlamaSupervisor {
  private cfg: SupervisorConfig;
  private child: Deno.ChildProcess | null = null;
  private state: SupervisorState = { running: false };
  private stderrBuf: string = "";

  constructor(cfg: SupervisorConfig) {
    this.cfg = cfg;
  }

  getState(): SupervisorState { return { ...this.state }; }

  /** Last 4 KB of stderr from the child (for surfacing in error responses). */
  getStderrTail(): string { return this.stderrBuf; }

  async spawn(opts: SpawnOpts): Promise<void> {
    if (this.child) {
      throw new Error("supervisor already has a running child; kill() first");
    }
    const modelPath = `${this.cfg.modelsDir}/${opts.filename}`;
    const args = [
      ...this.cfg.preArgs,
      "--port", String(this.cfg.chatPort),
      "-m", modelPath,
      "--ctx-size", String(opts.ctx_size),
      "--n-gpu-layers", String(opts.gpu_layers),
      "--parallel", String(opts.parallel_slots),
      "--host", "0.0.0.0",
      "--cache-prompt",
      ...(opts.cache_type_k ? ["--cache-type-k", opts.cache_type_k] : []),
      ...(opts.cache_type_v ? ["--cache-type-v", opts.cache_type_v] : []),
    ];

    const cmd = new Deno.Command(this.cfg.binary, {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });
    this.child = cmd.spawn();
    this.state = {
      running: true,
      pid: this.child.pid,
      model: opts.filename,
      port: this.cfg.chatPort,
      started_at: new Date().toISOString(),
    };
    this.stderrBuf = "";
    this._captureStderr();
    this._watchExit();
  }

  private async _captureStderr() {
    // Capture the child reference at the top — if a subsequent spawn replaces
    // this.child, we bail out so stderr from the dying generation doesn't leak
    // into the new generation's ring buffer.
    const child = this.child;
    if (!child) return;
    const reader = child.stderr.getReader();
    const dec = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (this.child !== child) break;   // generation changed — stop appending
        this.stderrBuf += dec.decode(value, { stream: true });
        if (this.stderrBuf.length > STDERR_RING_BYTES) {
          this.stderrBuf = this.stderrBuf.slice(-STDERR_RING_BYTES);
        }
      }
    } catch { /* connection closed */ }
  }

  private async _watchExit() {
    const child = this.child;
    if (!child) return;
    try {
      await child.status;
    } catch { /* ignore */ }
    // Only clear state if no subsequent spawn has replaced this generation.
    // Without this guard, a delayed exit-watcher for a killed child could
    // clobber state belonging to a newly-spawned successor.
    if (this.child === child) {
      this.state = { running: false };
      this.child = null;
    }
  }

  async awaitHealth(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const url = `http://127.0.0.1:${this.cfg.chatPort}/health`;
    while (Date.now() < deadline) {
      // Fast-fail if the child died before becoming healthy. Without this,
      // a malformed GGUF / OOM / missing CUDA driver causes a 60-second
      // /v1/load hang because we keep polling a port nothing is listening on.
      // _watchExit clears this.child on any exit; we surface stderr_tail.
      if (!this.child) {
        throw new Error(
          `llama-server exited before becoming healthy — last 4KB stderr:\n${this.stderrBuf.slice(-1024)}`,
        );
      }
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
        if (r.ok) {
          await r.body?.cancel().catch(() => {});
          return;
        }
      } catch { /* not ready yet */ }
      await new Promise((res) => setTimeout(res, 200));
    }
    throw new Error(
      `llama-server failed to become healthy within ${timeoutMs}ms — last 4KB stderr:\n${this.stderrBuf.slice(-1024)}`,
    );
  }

  async kill(): Promise<void> {
    if (!this.child) return;
    const c = this.child;
    try { c.kill("SIGTERM"); } catch { /* already dead */ }
    const killed = Promise.race([
      c.status.then(() => true),
      new Promise<boolean>((res) => setTimeout(() => res(false), 10_000)),
    ]);
    if (!(await killed)) {
      try { c.kill("SIGKILL"); } catch { /* */ }
      try { await c.status; } catch { /* */ }
    }
    this.state = { running: false };
    this.child = null;
  }
}
