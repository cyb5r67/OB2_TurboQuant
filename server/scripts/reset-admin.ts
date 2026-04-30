// Standalone break-glass utility to create or reset a global-admin user
// by directly editing users.json. Runs without the OB2 server up.
//
// Usage (typically via `docker exec`):
//
//   deno run --allow-read --allow-write --allow-env \
//     server/scripts/reset-admin.ts <username> \
//     [--password <pw>] [--promote]
//
// Behavior:
//   - Resolves the users.json path from OB2_USERS_FILE env, else
//     ../../users.json relative to this script (matches the server
//     default resolution).
//   - If --password is omitted, reads from stdin (echo disabled via stty).
//   - If --promote is set, ensures the user has global_admin=true and
//     enabled=true. Creates the user (with an empty domain set) if
//     they don't exist.
//   - Atomic write via tmp+rename.

import { hashPassword, validatePasswordStrength } from "../auth/passwords.ts";

interface UserRecord {
  username: string;
  key: string;
  password_hash?: string;
  global_admin: boolean;
  domains: Record<string, "read" | "write" | "admin">;
  created_at: string;
  enabled: boolean;
}

interface UsersConfig {
  users: UserRecord[];
}

function printUsage(): void {
  console.log(
    "usage: reset-admin.ts <username> [--password <pw>|--password=<pw>] [--promote]",
  );
  console.log("");
  console.log(
    "  --password <pw>    password to set (omit to be prompted; requires TTY)",
  );
  console.log(
    "  --promote          set global_admin=true, enabled=true (create if missing)",
  );
  console.log(
    "  -h, --help         print this message and exit",
  );
}

function parseArgs(argv: string[]): {
  username: string;
  password?: string;
  promote: boolean;
} {
  const rest: string[] = [];
  let password: string | undefined;
  let promote = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      printUsage();
      Deno.exit(0);
    } else if (a === "--password") {
      password = argv[++i];
      if (password === undefined) die("--password requires a value");
    } else if (a.startsWith("--password=")) {
      password = a.slice("--password=".length);
    } else if (a === "--promote") {
      promote = true;
    } else if (a.startsWith("--")) {
      die(`unknown flag: ${a}`);
    } else {
      rest.push(a);
    }
  }
  if (rest.length !== 1) {
    printUsage();
    die("exactly one <username> argument required");
  }
  return { username: rest[0], password, promote };
}

function die(msg: string): never {
  console.error(`reset-admin: ${msg}`);
  Deno.exit(2);
}

function resolveUsersFile(): string {
  const envPath = Deno.env.get("OB2_USERS_FILE");
  if (envPath) return envPath;
  // Fallback: ../../users.json relative to this script
  // (server/scripts/reset-admin.ts → ../../users.json)
  const scriptUrl = new URL(import.meta.url);
  const scriptDir = scriptUrl.pathname.replace(/\/[^/]+$/, "");
  return `${scriptDir}/../../users.json`;
}

function generateApiKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `ob2_${hex}`;
}

async function readPasswordFromStdin(): Promise<string> {
  // Refuse to prompt when there is no TTY — without echo suppression the
  // password would be echoed to stdout / docker logs / journal. A typical
  // footgun: `docker exec <ctr> deno run ... reset-admin.ts alice --promote`
  // (missing `-it`). Better to fail fast and tell the operator to pass
  // --password or re-run with a TTY.
  if (!Deno.stdin.isTerminal()) {
    die("no TTY attached — pass --password <value>, or re-run with `docker exec -it`");
  }
  const enc = new TextEncoder();
  await Deno.stdout.write(enc.encode("password: "));
  let echoDisabled = false;
  try {
    await new Deno.Command("stty", { args: ["-echo"] }).output();
    echoDisabled = true;
  } catch {
    console.error(
      "reset-admin: warning — could not disable terminal echo; password may be visible",
    );
  }
  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf) ?? 0;
  if (echoDisabled) {
    try {
      await new Deno.Command("stty", { args: ["echo"] }).output();
    } catch { /* best effort — terminal may need manual `stty echo` */ }
  }
  await Deno.stdout.write(enc.encode("\n"));
  return new TextDecoder().decode(buf.subarray(0, n)).replace(/\r?\n$/, "");
}

function loadUsers(path: string): UsersConfig {
  try {
    return JSON.parse(Deno.readTextFileSync(path)) as UsersConfig;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return { users: [] };
    throw e;
  }
}

function atomicWrite(path: string, data: UsersConfig): void {
  const tmp = `${path}.tmp.${Date.now()}`;
  Deno.writeTextFileSync(tmp, JSON.stringify(data, null, 2));
  Deno.renameSync(tmp, path);
}

async function main() {
  const args = parseArgs(Deno.args);
  const password = args.password ?? await readPasswordFromStdin();
  const pwErr = validatePasswordStrength(password);
  if (pwErr) die(pwErr);

  const path = resolveUsersFile();
  const data = loadUsers(path);
  const hash = await hashPassword(password);

  const idx = data.users.findIndex((u) => u.username === args.username);
  if (idx === -1) {
    if (!args.promote) {
      die(
        `user '${args.username}' not found. Pass --promote to create as global admin.`,
      );
    }
    data.users.push({
      username: args.username,
      key: generateApiKey(),
      password_hash: hash,
      global_admin: true,
      domains: {},
      created_at: new Date().toISOString(),
      enabled: true,
    });
    console.log(`reset-admin: created new global-admin user '${args.username}'`);
  } else {
    data.users[idx].password_hash = hash;
    data.users[idx].enabled = true;
    if (args.promote) data.users[idx].global_admin = true;
    console.log(
      `reset-admin: updated user '${args.username}' (promote=${args.promote})`,
    );
  }

  atomicWrite(path, data);
  console.log(`reset-admin: wrote ${path}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    console.error(`reset-admin: ${(e as Error).message}`);
    Deno.exit(1);
  }
}
