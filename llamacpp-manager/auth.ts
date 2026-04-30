// Bearer-token middleware for the manager. Constant-time compare.
//
// The manager's token is read from OB2_LLAMACPP_MANAGER_TOKEN at process start
// and cached. If the env is unset, all auth-required endpoints return 503 so
// the operator gets a clear failure rather than a "default unauthenticated"
// surprise. /healthz is exempted at the route level (don't call this middleware
// on it).

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
