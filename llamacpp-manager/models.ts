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
// Read up to 4 KB of header — enough for the magic + a few KV pairs.
const HEADER_READ_BYTES = 4096;

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
    default:
      // Arrays (type 9) and others: skip the rest of this KV by giving up.
      return;
  }
}

export async function scan(dir: string, loadedFilename: string | null): Promise<ModelInfo[]> {
  const out: ModelInfo[] = [];
  let entries: AsyncIterable<Deno.DirEntry>;
  try { entries = Deno.readDir(dir); }
  catch { return out; }
  for await (const e of entries) {
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
  out.sort((a, b) => a.filename.localeCompare(b.filename));
  return out;
}
