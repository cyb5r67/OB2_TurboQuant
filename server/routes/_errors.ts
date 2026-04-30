// Helpers for error responses that don't leak internal state to clients.
// The raw error message is still logged server-side via console.error; the
// client sees only the generic publicMsg passed in.

export function safeError(err: unknown, publicMsg: string): string {
  const msg = (err instanceof Error) ? err.message : String(err);
  console.error(`[server] ${publicMsg}: ${msg}`);
  return publicMsg;
}
