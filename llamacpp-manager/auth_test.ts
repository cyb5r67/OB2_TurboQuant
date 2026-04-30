// Run with: cd llamacpp-manager && deno run --allow-env --allow-net auth_test.ts
import { bearerAuth } from "./auth.ts";
import { Hono } from "hono";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; }
  else { console.log("PASS:", msg); }
}

Deno.env.set("OB2_LLAMACPP_MANAGER_TOKEN", "secret-token-aaaa-bbbb-cccc");

const app = new Hono();
app.use("*", bearerAuth());
app.get("/protected", (c) => c.json({ ok: true }));

// Case 1: no Authorization → 401
{
  const r = await app.request("/protected");
  assert(r.status === 401, `no auth → 401 (got ${r.status})`);
}

// Case 2: malformed header (no "Bearer ") → 401
{
  const r = await app.request("/protected", { headers: { Authorization: "secret-token-aaaa-bbbb-cccc" } });
  assert(r.status === 401, `non-Bearer → 401 (got ${r.status})`);
}

// Case 3: wrong token → 401
{
  const r = await app.request("/protected", { headers: { Authorization: "Bearer wrong-token" } });
  assert(r.status === 401, `wrong token → 401 (got ${r.status})`);
}

// Case 4: correct token → 200
{
  const r = await app.request("/protected", { headers: { Authorization: "Bearer secret-token-aaaa-bbbb-cccc" } });
  assert(r.status === 200, `correct token → 200 (got ${r.status})`);
}

// Case 5: empty token configured → ALL requests rejected (defense)
{
  Deno.env.delete("OB2_LLAMACPP_MANAGER_TOKEN");
  const app2 = new Hono();
  app2.use("*", bearerAuth());
  app2.get("/p", (c) => c.json({ ok: true }));
  const r = await app2.request("/p", { headers: { Authorization: "Bearer anything" } });
  assert(r.status === 503, `empty token env → 503 (got ${r.status})`);
}

if (failures > 0) Deno.exit(1);
console.log("\nAll auth tests passed.");
