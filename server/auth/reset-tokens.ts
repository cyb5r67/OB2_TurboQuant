// Reset + invite token store. File-backed, hot-reloading, atomic writes.
// Plaintext never stored — sha256(plaintext) only.
//
// File path: server/data/reset-tokens.json (relative to the server CWD).
//
// TTLs:
//   - reset:  1 hour
//   - invite: 7 days
//
// Tokens are single-use. consumeToken deletes the record on success.
// revokeUserTokens clears every token for a username.

type TokenKind = "reset" | "invite";

interface ResetToken {
  token_hash: string;
  username: string;
  kind: TokenKind;
  expires_at: string; // ISO-8601
  created_at: string;
}

interface TokenStore {
  tokens: ResetToken[];
}

const STORE_PATH = "../server/data/reset-tokens.json";
const RESET_TTL_MS = 60 * 60 * 1000;          // 1 hour
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let _tokens: ResetToken[] = [];
let _lastMtime = 0;
let _loaded = false;

async function _ensureDir(): Promise<void> {
  try {
    await Deno.mkdir("../server/data", { recursive: true });
  } catch { /* already exists */ }
}

async function _loadIfChanged(): Promise<void> {
  try {
    const stat = await Deno.stat(STORE_PATH);
    const mtime = stat.mtime?.getTime() ?? 0;
    if (_loaded && mtime <= _lastMtime) return;
    _lastMtime = mtime;
    const text = await Deno.readTextFile(STORE_PATH);
    const data = JSON.parse(text) as TokenStore;
    _tokens = Array.isArray(data.tokens) ? data.tokens : [];
    _loaded = true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      _tokens = [];
      _loaded = true;
      return;
    }
    console.error(`reset-tokens: load failed: ${e}`);
  }
}

async function _atomicWrite(): Promise<void> {
  await _ensureDir();
  const tmp = `${STORE_PATH}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  await Deno.writeTextFile(tmp, JSON.stringify({ tokens: _tokens }, null, 2));
  await Deno.rename(tmp, STORE_PATH);
  _lastMtime = 0; // force reload on next call
}

async function _sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function _generatePlaintext(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface IssuedToken {
  plaintext: string;
  expiresAt: string;
}

export async function generateToken(
  username: string,
  kind: TokenKind,
): Promise<IssuedToken> {
  await _loadIfChanged();
  const plaintext = _generatePlaintext();
  const now = Date.now();
  const ttl = kind === "invite" ? INVITE_TTL_MS : RESET_TTL_MS;
  const expiresAt = new Date(now + ttl).toISOString();
  const hash = await _sha256Hex(plaintext);
  _tokens.push({
    token_hash: hash,
    username,
    kind,
    expires_at: expiresAt,
    created_at: new Date(now).toISOString(),
  });
  // Sweep expired on every write.
  _tokens = _tokens.filter((t) => Date.parse(t.expires_at) > now);
  await _atomicWrite();
  return { plaintext, expiresAt };
}

export async function consumeToken(
  plaintext: string,
): Promise<{ username: string; kind: TokenKind } | null> {
  await _loadIfChanged();
  const hash = await _sha256Hex(plaintext);
  const now = Date.now();
  const idx = _tokens.findIndex((t) => t.token_hash === hash);
  if (idx === -1) return null;
  const tok = _tokens[idx];
  if (Date.parse(tok.expires_at) <= now) {
    // Expired — delete lazily.
    _tokens.splice(idx, 1);
    await _atomicWrite();
    return null;
  }
  _tokens.splice(idx, 1); // single-use
  await _atomicWrite();
  return { username: tok.username, kind: tok.kind };
}

export async function peekToken(
  plaintext: string,
): Promise<{ username: string; kind: TokenKind } | null> {
  // Non-destructive — used by /auth/reset-token-info to let the UI pick copy.
  await _loadIfChanged();
  const hash = await _sha256Hex(plaintext);
  const now = Date.now();
  const tok = _tokens.find((t) => t.token_hash === hash);
  if (!tok) return null;
  if (Date.parse(tok.expires_at) <= now) return null;
  return { username: tok.username, kind: tok.kind };
}

export async function revokeUserTokens(username: string): Promise<number> {
  await _loadIfChanged();
  const before = _tokens.length;
  _tokens = _tokens.filter((t) => t.username !== username);
  const removed = before - _tokens.length;
  if (removed > 0) await _atomicWrite();
  return removed;
}

export async function sweepExpired(): Promise<number> {
  await _loadIfChanged();
  const now = Date.now();
  const before = _tokens.length;
  _tokens = _tokens.filter((t) => Date.parse(t.expires_at) > now);
  const removed = before - _tokens.length;
  if (removed > 0) await _atomicWrite();
  return removed;
}
