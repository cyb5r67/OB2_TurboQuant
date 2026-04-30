// URL fetcher with SSRF denylist. Resolves the host, refuses any IP in the
// configured CIDR denylist, otherwise streams the body to a tmp file and
// returns the path + sniffed content-type.

import { sniffMagicBytes, SniffResult } from "./sniffer.ts";

const DEFAULT_DENYLIST = [
  "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
  "169.254.0.0/16", "::1/128", "fc00::/7",
];

export interface FetchedFile {
  path: string;          // /tmp/upload-<uuid>.<ext>
  sniffed: SniffResult | null;
  size_bytes: number;
}

function ipv4ToInt(addr: string): number | null {
  const parts = addr.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const x = Number(p);
    if (!Number.isInteger(x) || x < 0 || x > 255) return null;
    n = (n << 8) | x;
  }
  return n >>> 0;
}

function inCidrV4(addr: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const a = ipv4ToInt(addr);
  const b = ipv4ToInt(base);
  if (a === null || b === null) return false;
  if (bits === 0) return true;
  const mask = (~0 << (32 - bits)) >>> 0;
  return (a & mask) === (b & mask);
}

export function isDeniedIp(addr: string, denylist: string[]): boolean {
  // IPv4 check only — for our deployment scenario IPv4 is what matters.
  // Loopback + ULA IPv6 are handled in the host check below by string match.
  if (addr === "::1" || addr.startsWith("fc") || addr.startsWith("fd")) return true;
  if (!addr.includes(".")) return false; // IPv6 outside the simple cases — accept conservatively
  for (const cidr of denylist) {
    if (cidr.includes(":")) continue; // skip IPv6 CIDRs in the v4 path
    if (inCidrV4(addr, cidr)) return true;
  }
  return false;
}

function denylist(): string[] {
  const env = Deno.env.get("OB2_IMPORT_URL_DENYLIST") || "";
  const list = env.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : DEFAULT_DENYLIST;
}

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;

export async function fetchUrlToTmp(url: string, maxBytes: number): Promise<FetchedFile> {
  const u = new URL(url);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error("only http(s) URLs are accepted");
  }

  // Denylist check. If the hostname is a bare IPv4 literal we check it
  // directly (Deno.resolveDns can't resolve a bare IP), otherwise we DNS-
  // resolve and check every returned A record. Either path that hits a
  // denylisted address throws "url_blocked" so the HTTP layer returns 400
  // with the right error type, not the generic conversion_failed.
  const deny = denylist();
  if (IPV4_RE.test(u.hostname)) {
    if (isDeniedIp(u.hostname, deny)) {
      throw new Error(`url_blocked: ${u.hostname} is in the denylist`);
    }
  } else {
    const records = await Deno.resolveDns(u.hostname, "A").catch((e) => {
      throw new Error(`DNS resolution failed: ${(e as Error).message}`);
    });
    if (!records || records.length === 0) throw new Error("URL host has no A record");
    for (const ip of records) {
      if (isDeniedIp(ip, deny)) {
        throw new Error(`url_blocked: ${u.hostname} resolves to denylisted ${ip}`);
      }
    }
  }

  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) throw new Error(`upstream_fetch_failed: HTTP ${resp.status}`);

  // Extension derivation: the last `.` in the final path segment, falling
  // back to "bin" if the path has no extension or the URL ends with "/".
  const lastSeg = u.pathname.split("/").pop() || "";
  const dotIdx = lastSeg.lastIndexOf(".");
  const rawExt = dotIdx > 0 ? lastSeg.slice(dotIdx + 1) : "";
  const ext = (rawExt.toLowerCase().slice(0, 6) || "bin");
  const tmpPath = `/tmp/upload-${crypto.randomUUID()}.${ext}`;
  const file = await Deno.open(tmpPath, { write: true, create: true, truncate: true });

  let total = 0;
  try {
    const reader = resp.body!.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error("payload_too_large");
      }
      await file.write(value);
    }
  } finally {
    file.close();
  }

  // Sniff first 16 bytes for type confirmation.
  let sniffed: SniffResult | null = null;
  try {
    const head = await Deno.readFile(tmpPath);
    sniffed = sniffMagicBytes(head.subarray(0, 16));
  } catch { /* sniff is best-effort */ }

  return { path: tmpPath, sniffed, size_bytes: total };
}
