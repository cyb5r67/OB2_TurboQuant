// Simple in-memory rate limiter. Single-process, resets on restart.
// Callers pass a key (e.g. "ip:1.2.3.4", "user:alice", "token:abc123"),
// a limit (number of allowed events), and a window in milliseconds.

import type { Context } from "hono";

interface Bucket {
  count: number;
  resetAt: number;
}

const _buckets = new Map<string, Bucket>();

export function check(key: string, limit: number, windowMs: number): {
  allowed: boolean;
  retryAfterMs: number;
} {
  const now = Date.now();
  const existing = _buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    _buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterMs: 0 };
  }
  if (existing.count < limit) {
    existing.count++;
    return { allowed: true, retryAfterMs: 0 };
  }
  return { allowed: false, retryAfterMs: existing.resetAt - now };
}

export function reset(key: string): void {
  _buckets.delete(key);
}

/** Periodic sweep of stale buckets — optional, called from index.ts. */
export function sweep(): number {
  const now = Date.now();
  let removed = 0;
  for (const [k, b] of _buckets.entries()) {
    if (b.resetAt <= now) {
      _buckets.delete(k);
      removed++;
    }
  }
  return removed;
}

/** Resolve the client IP for rate-limit keying.
 * - trustProxy=true: read the first X-Forwarded-For entry.
 * - trustProxy=false: use the socket's direct peer address.
 * Direct exposure without a proxy should leave trustProxy=false, else
 * attackers can set XFF freely. */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();
  }
  // Hono exposes the underlying Deno.ServeHandlerInfo.remoteAddr via env.
  // Fall back to "unknown" if not available.
  const info = (c.env as { remoteAddr?: { hostname?: string } } | undefined)?.remoteAddr;
  return info?.hostname || "unknown";
}
