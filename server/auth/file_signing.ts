// Short-lived HMAC tokens for direct file download links embedded in chat
// responses. The chat surface (Open WebUI) lives at a different origin than
// OB2's dashboard, so the user's OB2 session cookie may not be set in the
// browser context that handles a citation click. A signed URL lets the
// /imports endpoint authorise the request without requiring a session.
//
// Token shape: HMAC-SHA256(secret, "<domain>|<file_id>|<exp>") base64url-encoded.
// URL shape: /admin/domains/<domain>/imports/<file_id>?t=<token>&exp=<unix_seconds>

const encoder = new TextEncoder();
let _key: CryptoKey | null = null;

const DEFAULT_TTL_SEC = 24 * 60 * 60; // 24 hours

export async function initFileSigning(): Promise<void> {
  let secret = Deno.env.get("OB2_SESSION_SECRET") || "";
  if (!secret) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    secret = btoa(String.fromCharCode(...bytes));
  }
  _key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function b64url(bytes: Uint8Array): string {
  const b64 = btoa(String.fromCharCode(...bytes));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(payload: string): Promise<string> {
  if (!_key) throw new Error("file-signing not initialised");
  const sig = await crypto.subtle.sign("HMAC", _key, encoder.encode(payload));
  return b64url(new Uint8Array(sig));
}

export async function signFileToken(
  domain: string,
  fileId: string,
  ttlSec: number = DEFAULT_TTL_SEC,
): Promise<{ token: string; exp: number }> {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const token = await sign(`${domain}|${fileId}|${exp}`);
  return { token, exp };
}

export async function verifyFileToken(
  domain: string,
  fileId: string,
  token: string,
  exp: number,
): Promise<boolean> {
  if (Math.floor(Date.now() / 1000) > exp) return false;
  const expected = await sign(`${domain}|${fileId}|${exp}`);
  if (expected.length !== token.length) return false;
  let eq = 0;
  for (let i = 0; i < expected.length; i++) {
    eq |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return eq === 0;
}
