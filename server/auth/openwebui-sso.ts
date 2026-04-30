// Stateless single-use SSO tokens for the Open WebUI handoff.
//
// The dashboard's "Chat" link sends the user's browser through a handoff
// endpoint that signs a short-lived token containing {username, email, exp}.
// The browser then lands on the Open WebUI proxy port, which verifies the
// token, sets a same-origin SSO cookie, and bridges every subsequent request
// to upstream Open WebUI with X-Forwarded-Email injected.
//
// Tokens carry a one-minute TTL — long enough for the redirect, short enough
// that a captured token is useless after the page loads.
//
// Cookies on the proxy origin carry an extended TTL (12 hours) so the user
// stays signed into Open WebUI across page reloads.

const encoder = new TextEncoder();

let _key: CryptoKey | null = null;

const TOKEN_TTL_MS = 60 * 1000;          // 1 minute (handoff window)
const COOKIE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export async function initOpenwebuiSso(): Promise<void> {
  // Reuse OB2_SESSION_SECRET so a session-secret rotation invalidates SSO
  // tokens too. Auto-generate an ephemeral key when unset; tokens then last
  // only as long as the process.
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

function unb64url(s: string): Uint8Array {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sign(payload: string): Promise<string> {
  if (!_key) throw new Error("openwebui-sso not initialized");
  const sig = await crypto.subtle.sign("HMAC", _key, encoder.encode(payload));
  return b64url(new Uint8Array(sig));
}

async function verifySig(payload: string, sig: string): Promise<boolean> {
  const expected = await sign(payload);
  if (expected.length !== sig.length) return false;
  let eq = 0;
  for (let i = 0; i < expected.length; i++) {
    eq |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  }
  return eq === 0;
}

export interface SsoPayload {
  u: string;  // username
  e: string;  // email
  exp: number; // expiry epoch ms
}

/** Sign a one-minute handoff token. Used by the dashboard handoff endpoint. */
export async function signHandoffToken(username: string, email: string): Promise<string> {
  const payload: SsoPayload = { u: username, e: email, exp: Date.now() + TOKEN_TTL_MS };
  const json = b64url(encoder.encode(JSON.stringify(payload)));
  return `${json}.${await sign(json)}`;
}

/** Sign a 12-hour cookie token. Used by the proxy after handoff token consumption. */
export async function signCookieToken(username: string, email: string): Promise<string> {
  const payload: SsoPayload = { u: username, e: email, exp: Date.now() + COOKIE_TTL_MS };
  const json = b64url(encoder.encode(JSON.stringify(payload)));
  return `${json}.${await sign(json)}`;
}

/** Verify any SSO token. Returns the payload if valid + unexpired, else null. */
export async function verifySsoToken(token: string): Promise<SsoPayload | null> {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const json = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!(await verifySig(json, sig))) return null;
  let payload: SsoPayload;
  try {
    const decoded = new TextDecoder().decode(unb64url(json));
    payload = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (typeof payload.u !== "string" || typeof payload.e !== "string" || typeof payload.exp !== "number") {
    return null;
  }
  if (payload.exp < Date.now()) return null;
  return payload;
}
