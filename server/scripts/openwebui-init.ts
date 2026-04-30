// Generate a service token for the Open WebUI integration and write it to
// the project .env. Idempotent — re-running prints the existing token without
// changing it.
//
// Usage (from project root):
//   docker compose run --rm ob2-server \
//     deno run --allow-env --allow-read --allow-write \
//     /app/server/scripts/openwebui-init.ts
//
// Or on the host (outside Docker):
//   cd server && deno run --allow-env --allow-read --allow-write \
//     scripts/openwebui-init.ts
//
// The script writes/updates these lines in ../.env relative to the script:
//   OB2_OPENWEBUI_ENABLED=true
//   OB2_OPENWEBUI_SERVICE_TOKEN=ob2_<32-hex>
//   OB2_OPENWEBUI_PUBLIC_URL=<existing OB2_PUBLIC_URL host>:7601
// Then prints next-step instructions.

const ENV_PATH = new URL("../../.env", import.meta.url).pathname;

function genServiceToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `ob2_${hex}`;
}

interface EnvFile {
  lines: string[];
  index: Map<string, number>;
}

async function readEnv(path: string): Promise<EnvFile> {
  let text = "";
  try {
    text = await Deno.readTextFile(path);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  const lines = text ? text.split(/\r?\n/) : [];
  const index = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Z0-9_]+)=/);
    if (m) index.set(m[1], i);
  }
  return { lines, index };
}

function getEnv(env: EnvFile, key: string): string | null {
  const i = env.index.get(key);
  if (i === undefined) return null;
  const eq = env.lines[i].indexOf("=");
  return env.lines[i].slice(eq + 1);
}

function setEnv(env: EnvFile, key: string, value: string): void {
  const line = `${key}=${value}`;
  const i = env.index.get(key);
  if (i === undefined) {
    env.index.set(key, env.lines.length);
    env.lines.push(line);
  } else {
    env.lines[i] = line;
  }
}

function derivePublicUrl(ob2PublicUrl: string | null): string {
  // Default to localhost:7601 if OB2_PUBLIC_URL isn't set or doesn't parse.
  if (!ob2PublicUrl) return "http://localhost:7601";
  try {
    const u = new URL(ob2PublicUrl);
    u.port = "7601";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return "http://localhost:7601";
  }
}

async function main(): Promise<void> {
  const env = await readEnv(ENV_PATH);
  const existing = getEnv(env, "OB2_OPENWEBUI_SERVICE_TOKEN");
  let token = existing;
  let regenerated = false;
  if (!token || !/^ob2_[0-9a-f]{32}$/.test(token)) {
    token = genServiceToken();
    regenerated = true;
  }

  setEnv(env, "OB2_OPENWEBUI_ENABLED", "true");
  setEnv(env, "OB2_OPENWEBUI_SERVICE_TOKEN", token);
  if (!getEnv(env, "OB2_OPENWEBUI_PUBLIC_URL")) {
    setEnv(env, "OB2_OPENWEBUI_PUBLIC_URL", derivePublicUrl(getEnv(env, "OB2_PUBLIC_URL")));
  }

  await Deno.writeTextFile(ENV_PATH, env.lines.join("\n").replace(/\n+$/, "") + "\n");

  console.log(regenerated ? "Generated new service token." : "Reused existing service token.");
  console.log(`OB2_OPENWEBUI_ENABLED=true`);
  console.log(`OB2_OPENWEBUI_SERVICE_TOKEN=${token}`);
  console.log(`OB2_OPENWEBUI_PUBLIC_URL=${getEnv(env, "OB2_OPENWEBUI_PUBLIC_URL")}`);
  console.log("");
  console.log("Next steps:");
  console.log("  1. docker compose -f docker/docker-compose.yml --env-file .env --profile openwebui up -d");
  console.log("  2. docker compose -f docker/docker-compose.yml --env-file .env restart ob2-server");
  console.log("  3. Log into the dashboard, click Chat in the nav.");
}

if (import.meta.main) {
  await main();
}
