// Python sidecar IPC client.
//
// Starts the retrieval/sidecar.py Python process and communicates over
// stdin/stdout using newline-delimited JSON-RPC 2.0.
//
// Keeps the Python process warm across requests — context-engine's embedding
// model stays loaded, avoiding per-call model load cost.

import type { Config } from "./config.ts";

export interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class Sidecar {
  private proc?: Deno.ChildProcess;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
  }>();
  private buf = "";
  // Single writer held for the process lifetime — stdin has exactly one reader
  // on the Python side, so concurrent RPC calls must serialize their writes.
  // Using one long-lived writer avoids the "stream already locked" race.
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private config: Config) {}

  async start(): Promise<void> {
    if (this.proc) return;
    // Retrieval-sidecar runtime toggle. "python" (default) spawns the
    // retrieval/sidecar.py process; "rust" spawns the compiled ob2-sidecar
    // binary. Both speak the same newline-delimited JSON-RPC 2.0 protocol.
    const runtime = Deno.env.get("OB2_SIDECAR_RUNTIME") ?? "python";
    const [bin, args] = runtime === "rust"
      ? [this.config.rustSidecarBin, [] as string[]]
      : [this.config.python, [this.config.sidecarScript]];
    console.log(`sidecar: runtime=${runtime} bin=${bin}`);
    const cmd = new Deno.Command(bin, {
      args,
      stdin: "piped",
      stdout: "piped",
      stderr: "inherit",
      cwd: new URL(".", import.meta.url).pathname,
    });
    this.proc = cmd.spawn();
    // Acquire the writer once; keep it for the process lifetime
    this.writer = this.proc.stdin.getWriter();
    this.readLoop().catch((e) => {
      console.error("sidecar read loop error:", e);
    });
  }

  private async readLoop(): Promise<void> {
    if (!this.proc) throw new Error("sidecar not started");
    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      this.buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        this.handleLine(line);
      }
    }
  }

  private handleLine(line: string): void {
    let msg: RpcResponse;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      console.error("sidecar produced non-JSON:", line);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) {
      p.reject(new Error(`sidecar rpc ${msg.error.code}: ${msg.error.message}`));
    } else {
      p.resolve(msg.result);
    }
  }

  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!this.proc || !this.writer) throw new Error("sidecar not started");
    const id = this.nextId++;
    const req: RpcRequest = { jsonrpc: "2.0", id, method, params };
    const body = JSON.stringify(req) + "\n";
    const bytes = new TextEncoder().encode(body);
    const writer = this.writer;

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      // Serialize writes through writeQueue so concurrent callers don't race
      this.writeQueue = this.writeQueue
        .then(() => writer.write(bytes))
        .catch((e) => {
          this.pending.delete(id);
          reject(e);
        });
    });
  }

  async close(): Promise<void> {
    if (!this.proc) return;
    try {
      if (this.writer) {
        await this.writer.close();
        this.writer = undefined;
      }
    } catch {
      // ignore
    }
    await this.proc.status;
    this.proc = undefined;
  }
}
