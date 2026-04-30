// Bearer-token middleware for the manager. Constant-time compare via
// timingSafeEqual.
//
// The token is read from OB2_LLAMACPP_MANAGER_TOKEN on EVERY request (not
// cached), so operators can rotate the token by setting a new env value
// without restarting the process. If the env var is unset or empty, the
// middleware fails closed with a 503 — there is no "auth disabled in dev"
// fallback.
//
// `/healthz` is unauthenticated, but this middleware itself is unconditional:
// the exemption is achieved in main.ts by mounting bearerAuth() on `/v1/*`
// only, so `/healthz` (outside that prefix) is never wrapped. If you add a
// new route OUTSIDE `/v1/*`, you are responsible for either (a) adding
// `bearerAuth()` to its handler explicitly, or (b) deciding it should be
// public.

import type { Context, MiddlewareHandler } from "hono";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function configuredToken(): string | null {
  const t = Deno.env.get("OB2_LLAMACPP_MANAGER_TOKEN");
  return t && t.length > 0 ? t : null;
}

export function bearerAuth(): MiddlewareHandler {
  return async (c: Context, next: () => Promise<void>) => {
    const expected = configuredToken();
    if (!expected) {
      return c.json({
        error: { type: "config_error", message: "manager token not configured" },
      }, 503);
    }
    const header = c.req.header("Authorization") ?? "";
    if (!header.startsWith("Bearer ")) {
      return c.json({
        error: { type: "unauthorized", message: "missing or malformed Bearer token" },
      }, 401);
    }
    const presented = header.slice("Bearer ".length);
    if (!timingSafeEqual(presented, expected)) {
      return c.json({
        error: { type: "unauthorized", message: "invalid token" },
      }, 401);
    }
    await next();
  };
}
