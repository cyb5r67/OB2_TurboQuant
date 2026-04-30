// Session store — in-memory map of signed session tokens.
//
// On login we:
//   1. Generate a random 32-byte session id
//   2. HMAC-sign it with OB2_SESSION_SECRET (auto-generated at boot if unset)
//   3. Store {id → {username, expires_at}} in memory
//   4. Return "<id>.<signature>" as the cookie value
//
// On verification we:
//   1. Split cookie on "."
//   2. Verify the HMAC signature (rejects cookies from restarts with a new secret)
//   3. Look up the id in memory (rejects expired or revoked sessions)
//   4. Return the username
//
// Sessions are ephemeral (in-memory) — server restart logs everyone out.
// This is acceptable for v1. If persistence is needed later, swap _sessions
// for a SQLite table with the same API.

const DEFAULT_TTL_SEC = 12 * 60 * 60; // 12 hours
const encoder = new TextEncoder();

// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────

interface SessionEntry {
  username: string;
  expires_at: number; // epoch ms
  created_at: number;
}

const _sessions = new Map<string, SessionEntry>();
let _signingKey: CryptoKey | null = null;
let _ttlSec: number = DEFAULT_TTL_SEC;

// ─────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────

export async function initSessions(opts: { secret?: string; ttlSec?: number } = {}): Promise<void> {
  _ttlSec = opts.ttlSec ?? DEFAULT_TTL_SEC;
  let secret = opts.secret || Deno.env.get("OB2_SESSION_SECRET") || "";
  if (!secret) {
    // Auto-generate a process-lifetime secret. Sessions won't survive restart,
    // which is the same behavior as our in-memory map, so this is consistent.
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    secret = btoa(String.fromCharCode(...bytes));
    console.log("Generated ephemeral session secret (set OB2_SESSION_SECRET for persistence across restarts)");
  }
  _signingKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );

  // Start a sweeper to drop expired sessions
  setInterval(sweepExpired, 60_000);
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function randomId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

function base64url(bytes: Uint8Array): string {
  const b64 = btoa(String.fromCharCode(...bytes));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(payload: string): Promise<string> {
  if (!_signingKey) throw new Error("sessions not initialized");
  const sig = await crypto.subtle.sign("HMAC", _signingKey, encoder.encode(payload));
  return base64url(new Uint8Array(sig));
}

async function verifySig(payload: string, providedSig: string): Promise<boolean> {
  const expected = await sign(payload);
  // Constant-time comparison
  if (expected.length !== providedSig.length) return false;
  let eq = 0;
  for (let i = 0; i < expected.length; i++) {
    eq |= expected.charCodeAt(i) ^ providedSig.charCodeAt(i);
  }
  return eq === 0;
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

export async function createSession(username: string): Promise<{ token: string; expires_at: number }> {
  const id = randomId();
  const now = Date.now();
  const expires_at = now + _ttlSec * 1000;
  _sessions.set(id, { username, expires_at, created_at: now });
  const sig = await sign(id);
  return { token: `${id}.${sig}`, expires_at };
}

/** Return the session entry for a valid cookie token, or null. */
export async function resolveSession(token: string): Promise<SessionEntry | null> {
  if (!token) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const id = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!(await verifySig(id, sig))) return null;
  const entry = _sessions.get(id);
  if (!entry) return null;
  if (entry.expires_at < Date.now()) {
    _sessions.delete(id);
    return null;
  }
  return entry;
}

export function revokeSession(token: string): boolean {
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const id = token.slice(0, dot);
  return _sessions.delete(id);
}

/** Revoke every session for a user (used after password change or user revoke). */
export function revokeUserSessions(username: string): number {
  let count = 0;
  for (const [id, entry] of _sessions.entries()) {
    if (entry.username === username) {
      _sessions.delete(id);
      count++;
    }
  }
  return count;
}

export function sweepExpired(): number {
  const now = Date.now();
  let count = 0;
  for (const [id, entry] of _sessions.entries()) {
    if (entry.expires_at < now) {
      _sessions.delete(id);
      count++;
    }
  }
  return count;
}

export function sessionCount(): number {
  return _sessions.size;
}

export const SESSION_COOKIE_NAME = "ob2_session";

export function buildCookie(token: string, maxAgeSec: number, isHttps: boolean): string {
  const publicUrlHttps = (Deno.env.get("OB2_PUBLIC_URL") || "").startsWith("https://");
  const secure = isHttps || publicUrlHttps;
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(isHttps: boolean): string {
  const publicUrlHttps = (Deno.env.get("OB2_PUBLIC_URL") || "").startsWith("https://");
  const secure = isHttps || publicUrlHttps;
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
