// Boot-time sync: Open WebUI connection config + user role reconciliation.
//
// Approach: shells out to Python 3 (already in the image, with stdlib sqlite3)
// via Deno.Command.  This avoids adding a new Deno SQLite dependency and keeps
// the pattern consistent with the existing Python sidecar.
//
// Two public exports:
//   ensureOpenWebuiConnectionPublic(config) — writes the openai connection block
//     so ALL Open WebUI roles see models in the dropdown.
//   syncOpenWebuiRoles()                    — reconciles each Open WebUI user's
//     role with OB2's global_admin flag.  Idempotent; skips unknowns + internal
//     sentinel accounts.
//
// Both are best-effort: they log on error and return without throwing so a DB
// hiccup at boot doesn't bring down the whole server.

import type { Config } from "./config.ts";
import { listUsers } from "./users.ts";

const WEBUI_DB_PATH = "/openwebui-data/webui.db";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runPython(script: string): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  const cmd = new Deno.Command("python3", {
    args: ["-c", script],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    stdout: new TextDecoder().decode(stdout).trim(),
    stderr: new TextDecoder().decode(stderr).trim(),
    ok: code === 0,
  };
}

// ---------------------------------------------------------------------------
// Part A — ensure the OpenAI connection is public (model_ids: [])
// ---------------------------------------------------------------------------

/**
 * Ensure Open WebUI's OpenAI connection is enabled and visible to all roles.
 * Idempotent. Best-effort: logs and returns on any error.
 */
export async function ensureOpenWebuiConnectionPublic(config: Config): Promise<void> {
  if (!config.openwebuiServiceToken) {
    console.warn("openwebui_sync: service token not set, skipping connection config");
    return;
  }

  const serviceToken = config.openwebuiServiceToken;
  const apiBaseUrl = "http://ob2-server:7600/v1";

  // We read the existing config row, merge the openai section, then write back.
  // Using json.dumps with ensure_ascii=False to preserve any Unicode safely.
  const script = `
import sqlite3, json, sys

DB = ${JSON.stringify(WEBUI_DB_PATH)}
API_BASE_URL = ${JSON.stringify(apiBaseUrl)}
API_KEY = ${JSON.stringify(serviceToken)}

desired_openai = {
    "enable": True,
    "api_base_urls": [API_BASE_URL],
    "api_keys": [API_KEY],
    "api_configs": {
        "0": {
            "enable": True,
            "tags": [],
            "prefix_id": "",
            "model_ids": [],
            "connection_type": "external"
        }
    }
}

try:
    con = sqlite3.connect(DB)
    cur = con.cursor()

    # Fetch existing config
    cur.execute("SELECT data FROM config WHERE id = 1")
    row = cur.fetchone()
    if row is None:
        print("ERROR: config row id=1 not found", file=sys.stderr)
        con.close()
        sys.exit(1)

    existing = json.loads(row[0]) if row[0] else {}

    # Check if update is needed
    current_openai = existing.get("openai", {})
    if (current_openai.get("enable") == True
            and current_openai.get("api_base_urls") == [API_BASE_URL]
            and current_openai.get("api_keys") == [API_KEY]
            and isinstance(current_openai.get("api_configs"), dict)
            and current_openai["api_configs"].get("0", {}).get("model_ids") == []):
        print("SKIP: already up to date")
        con.close()
        sys.exit(0)

    # Merge: preserve other top-level keys, replace openai section wholesale
    existing["openai"] = desired_openai
    new_data = json.dumps(existing, ensure_ascii=False)

    cur.execute("UPDATE config SET data = ? WHERE id = 1", (new_data,))
    con.commit()
    print(f"UPDATED: wrote openai connection config ({cur.rowcount} row)")
    con.close()
except Exception as e:
    print(f"ERROR: {e}", file=sys.stderr)
    sys.exit(1)
`;

  const result = await runPython(script);
  if (!result.ok) {
    console.error(`openwebui_sync(connection): FAILED — ${result.stderr || result.stdout}`);
    return;
  }
  console.log(`openwebui_sync(connection): ${result.stdout}`);
  if (result.stderr) {
    console.warn(`openwebui_sync(connection) stderr: ${result.stderr}`);
  }
}

// ---------------------------------------------------------------------------
// Part B — sync user roles from OB2's global_admin flag
// ---------------------------------------------------------------------------

/**
 * Sync each user role in Open WebUI from OB2's global_admin flag.
 * Idempotent. Best-effort: logs and returns on any error.
 *
 * Rules:
 *   - OB2 global_admin=true  → Open WebUI role = "admin"
 *   - OB2 global_admin=false → Open WebUI role = "user"
 *   - email not found in OB2 → skip (leave as-is)
 *   - _ob2_bridge@internal   → skip always
 */
export async function syncOpenWebuiRoles(): Promise<{ synced: number; skipped: number }> {
  // Build the email→role map from OB2 users
  const ob2Users = listUsers();
  if (ob2Users.length === 0) {
    console.warn("openwebui_sync(roles): no OB2 users loaded, skipping");
    return { synced: 0, skipped: 0 };
  }

  // Map email → desired Open WebUI role
  const roleMap: Record<string, "admin" | "user"> = {};
  for (const u of ob2Users) {
    if (!u.email) continue;
    roleMap[u.email.toLowerCase()] = u.global_admin ? "admin" : "user";
  }

  const roleMapJson = JSON.stringify(roleMap);

  const script = `
import sqlite3, json, sys

DB = ${JSON.stringify(WEBUI_DB_PATH)}
ROLE_MAP = json.loads(${JSON.stringify(roleMapJson)})
SKIP_EMAILS = {"_ob2_bridge@internal"}

try:
    con = sqlite3.connect(DB)
    cur = con.cursor()

    cur.execute("SELECT id, email, role FROM user")
    rows = cur.fetchall()

    synced = 0
    skipped = 0

    for (uid, email, current_role) in rows:
        email_lower = (email or "").lower()
        if email_lower in SKIP_EMAILS:
            skipped += 1
            continue
        desired = ROLE_MAP.get(email_lower)
        if desired is None:
            # Not in OB2 — leave alone
            skipped += 1
            continue
        if current_role == desired:
            skipped += 1
            continue
        cur.execute("UPDATE user SET role = ? WHERE id = ?", (desired, uid))
        print(f"  {email}: {current_role} -> {desired}")
        synced += 1

    con.commit()
    print(f"DONE: synced={synced} skipped={skipped}")
    con.close()
except Exception as e:
    print(f"ERROR: {e}", file=sys.stderr)
    sys.exit(1)
`;

  const result = await runPython(script);
  if (!result.ok) {
    console.error(`openwebui_sync(roles): FAILED — ${result.stderr || result.stdout}`);
    return { synced: 0, skipped: 0 };
  }

  // Parse synced/skipped from stdout
  let synced = 0;
  let skipped = 0;
  for (const line of result.stdout.split("\n")) {
    const m = line.match(/synced=(\d+)\s+skipped=(\d+)/);
    if (m) {
      synced = parseInt(m[1], 10);
      skipped = parseInt(m[2], 10);
    }
    if (line && !line.startsWith("DONE:")) {
      console.log(`openwebui_sync(roles): ${line}`);
    }
  }
  if (result.stderr) {
    console.warn(`openwebui_sync(roles) stderr: ${result.stderr}`);
  }

  return { synced, skipped };
}
