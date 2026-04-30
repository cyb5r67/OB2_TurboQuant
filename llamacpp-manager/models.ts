// Models directory operations.
//
// The GGUF header parser is best-effort — bad/truncated headers return null
// rather than throwing, so a single corrupt file doesn't poison the whole
// directory listing.

export interface GgufParsed {
  arch?: string;
  n_params?: number;
  quant?: string;
  ctx_train?: number;
}

export interface ModelInfo {
  filename: string;
  size_bytes: number;
  modified_at: string;
  parsed: GgufParsed | null;
  is_loaded: boolean;
}

const GGUF_MAGIC = new Uint8Array([0x47, 0x47, 0x55, 0x46]); // "GGUF"
// 64 KB is enough to walk past most tokenizer arrays and reach the
// post-tokenizer scalar metadata (quant version, file type, parameter count).
// llama-3-class tokenizers (~128k tokens × ~5 bytes/token) push this near the
// limit but typically still leave the architecture-specific scalars and the
// general.* tail readable.
const HEADER_READ_BYTES = 65536;

export async function parseGgufHeader(path: string): Promise<GgufParsed | null> {
  let f: Deno.FsFile;
  try { f = await Deno.open(path, { read: true }); }
  catch { return null; }
  try {
    const buf = new Uint8Array(HEADER_READ_BYTES);
    const n = await f.read(buf);
    if (!n || n < 24) return null;

    for (let i = 0; i < 4; i++) {
      if (buf[i] !== GGUF_MAGIC[i]) return null;
    }

    const view = new DataView(buf.buffer, 0, n);
    // version u32, tensor_count u64, kv_count u64
    const version = view.getUint32(4, true);
    if (version < 1 || version > 4) return null;
    const kvCount = Number(view.getBigUint64(16, true));

    let off = 24;
    const out: GgufParsed = {};
    for (let kv = 0; kv < kvCount && off < n; kv++) {
      // key: u64 length + bytes
      if (off + 8 > n) break;
      const keyLen = Number(view.getBigUint64(off, true));
      off += 8;
      if (off + keyLen > n) break;
      const key = new TextDecoder().decode(buf.slice(off, off + keyLen));
      off += keyLen;

      // value type u32 + value
      if (off + 4 > n) break;
      const vtype = view.getUint32(off, true);
      off += 4;

      const value = readValue(view, buf, off, n, vtype);
      if (value === undefined) break;
      off = value.next;

      switch (key) {
        case "general.architecture":
          if (typeof value.v === "string") out.arch = value.v;
          break;
        case "general.quantization_version":
          if (typeof value.v === "number") out.quant = `Q${value.v}`;
          break;
        case "llama.context_length":
        case "general.context_length":
          if (typeof value.v === "number") out.ctx_train = value.v;
          break;
        case "general.parameter_count":
          if (typeof value.v === "number") out.n_params = value.v;
          break;
      }
    }
    return out;
  } finally {
    f.close();
  }
}

function readValue(
  view: DataView,
  buf: Uint8Array,
  off: number,
  n: number,
  vtype: number,
): { v: unknown; next: number } | undefined {
  switch (vtype) {
    case 0: // uint8
      if (off + 1 > n) return;
      return { v: view.getUint8(off), next: off + 1 };
    case 4: // uint32
      if (off + 4 > n) return;
      return { v: view.getUint32(off, true), next: off + 4 };
    case 5: // int32
      if (off + 4 > n) return;
      return { v: view.getInt32(off, true), next: off + 4 };
    case 6: // float32
      if (off + 4 > n) return;
      return { v: view.getFloat32(off, true), next: off + 4 };
    case 8: { // string: u64 len + bytes
      if (off + 8 > n) return;
      const sl = Number(view.getBigUint64(off, true));
      if (off + 8 + sl > n) return;
      return {
        v: new TextDecoder().decode(buf.slice(off + 8, off + 8 + sl)),
        next: off + 8 + sl,
      };
    }
    case 10: // uint64
      if (off + 8 > n) return;
      return { v: Number(view.getBigUint64(off, true)), next: off + 8 };
    case 11: // int64
      if (off + 8 > n) return;
      return { v: Number(view.getBigInt64(off, true)), next: off + 8 };
    case 12: // float64
      if (off + 8 > n) return;
      return { v: view.getFloat64(off, true), next: off + 8 };
    case 9: { // array: u32 inner_type + u64 count + count × element-of-inner-type
      if (off + 12 > n) return;
      const innerType = view.getUint32(off, true);
      const count = Number(view.getBigUint64(off + 4, true));
      let p = off + 12;
      for (let i = 0; i < count; i++) {
        if (p >= n) return;
        const inner = readValue(view, buf, p, n, innerType);
        if (inner === undefined) return;
        p = inner.next;
      }
      // We don't surface array values to the caller (Phase 2 has no consumer
      // for them); just advance past them so subsequent KVs are reachable.
      return { v: undefined, next: p };
    }
    default:
      // Unknown types: skip the rest of this KV by giving up.
      return;
  }
}

export async function scan(dir: string, loadedFilename: string | null): Promise<ModelInfo[]> {
  const out: ModelInfo[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (!e.isFile || !e.name.endsWith(".gguf")) continue;
      const full = `${dir}/${e.name}`;
      let stat: Deno.FileInfo;
      try { stat = await Deno.stat(full); }
      catch { continue; }
      let parsed: GgufParsed | null = null;
      try { parsed = await parseGgufHeader(full); }
      catch { /* leave null */ }
      out.push({
        filename: e.name,
        size_bytes: stat.size,
        modified_at: stat.mtime?.toISOString() ?? new Date(0).toISOString(),
        parsed,
        is_loaded: e.name === loadedFilename,
      });
    }
  } catch {
    // Directory missing / unreadable / permission denied — return whatever
    // entries we already collected (typically an empty list).
    return out;
  }
  out.sort((a, b) => a.filename.localeCompare(b.filename));
  return out;
}

// SSRF denylist: private RFC1918 ranges + loopback + cloud metadata IPs.
// Mirrors server/import/url_fetcher.ts's logic.
//
// The OB2_LLAMACPP_ALLOW_LOCAL_PULL env var, when set to "1", bypasses the
// denylist for 127.0.0.1 (used in tests). Production deployments must NOT
// set this — the manager runs in a container reachable from inside the Docker
// network, and an attacker on that network could otherwise pull from cloud
// metadata services.

const PRIVATE_CIDRS: [number, number, number][] = [
  // [base IP first octet, mask, base second octet]
  [127, 8, 0],   // 127/8 loopback
  [10,  8, 0],   // 10/8 RFC1918
  [192, 16, 168], // 192.168/16
  [169, 16, 254], // 169.254/16 link-local + AWS metadata 169.254.169.254
];

export function isDeniedIp(ip: string): boolean {
  if (Deno.env.get("OB2_LLAMACPP_ALLOW_LOCAL_PULL") === "1" && ip === "127.0.0.1") return false;
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const oct = m.slice(1).map(Number);
  for (const [base, maskBits, secondOctet] of PRIVATE_CIDRS) {
    if (maskBits === 8 && oct[0] === base) return true;
    if (maskBits === 16 && oct[0] === base && oct[1] === secondOctet) return true;
  }
  // 172.16-31.0.0/12
  if (oct[0] === 172 && oct[1] >= 16 && oct[1] <= 31) return true;
  return false;
}

const MAX_PULL_BYTES = 50 * 1024 * 1024 * 1024; // 50 GB

export interface PullProgress {
  status: string;
  total?: number;
  completed?: number;
}

async function resolveAndCheck(url: string): Promise<void> {
  const u = new URL(url);
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`pull rejected: only http(s) URLs allowed, got ${u.protocol}`);
  }
  const host = u.hostname;
  // Numeric IPs: refuse upfront if denylisted.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    if (isDeniedIp(host)) throw new Error(`pull rejected: ${host} is in denylist`);
    return;
  }
  // Hostname: resolve A records and reject if any are denylisted.
  let addrs: Deno.NetAddr[];
  try { addrs = (await Deno.resolveDns(host, "A")) as unknown as Deno.NetAddr[]; }
  catch (e) { throw new Error(`pull rejected: failed to resolve ${host}: ${(e as Error).message}`); }
  for (const a of addrs as unknown as string[]) {
    if (isDeniedIp(a)) throw new Error(`pull rejected: ${host} resolves to denylisted ${a}`);
  }
}

export async function pullFromUrl(
  url: string,
  modelsDir: string,
  outFilename: string,
  onProgress: (p: PullProgress) => void,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  if (!isSafeFilename(outFilename)) {
    throw new Error(`pull rejected: unsafe filename "${outFilename}"`);
  }
  await resolveAndCheck(url);
  onProgress({ status: "starting" });

  const partial = `${modelsDir}/${outFilename}.partial`;
  const final = `${modelsDir}/${outFilename}`;

  const r = await fetch(url, { headers: extraHeaders });
  if (!r.ok || !r.body) {
    throw new Error(`pull failed: HTTP ${r.status}`);
  }
  const total = Number(r.headers.get("content-length") || "0") || undefined;
  if (total && total > MAX_PULL_BYTES) {
    throw new Error(`pull rejected: file size ${total} exceeds 50 GB cap`);
  }
  onProgress({ status: "downloading", total, completed: 0 });

  let written = 0;
  const out = await Deno.open(partial, { create: true, write: true, truncate: true });
  try {
    const reader = r.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      written += value.length;
      if (written > MAX_PULL_BYTES) {
        throw new Error(`pull aborted: stream exceeded 50 GB cap`);
      }
      await out.write(value);
      onProgress({ status: "downloading", total, completed: written });
    }
  } finally {
    out.close();
  }
  await Deno.rename(partial, final);
  onProgress({ status: "success", total, completed: written });
}

function isSafeFilename(name: string): boolean {
  return name.length > 0
    && name.length <= 256
    && !name.includes("/")
    && !name.includes("\\")
    && !name.includes("..")
    && name.endsWith(".gguf");
}

const HF_DEFAULT_BASE = "https://huggingface.co";

export async function pullFromHf(
  repo: string,
  hfFile: string,
  modelsDir: string,
  outFilename: string,
  onProgress: (p: PullProgress) => void,
): Promise<void> {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    throw new Error(`pull rejected: invalid HF repo "${repo}"`);
  }
  if (hfFile.includes("/") || hfFile.includes("..")) {
    throw new Error(`pull rejected: invalid HF file "${hfFile}"`);
  }
  const base = Deno.env.get("OB2_LLAMACPP_HF_BASE_URL") || HF_DEFAULT_BASE;
  const url = `${base}/${repo}/resolve/main/${hfFile}`;
  const headers: Record<string, string> = {};
  const tok = Deno.env.get("OB2_HF_TOKEN");
  if (tok) headers["Authorization"] = `Bearer ${tok}`;
  await pullFromUrl(url, modelsDir, outFilename, onProgress, headers);
}
