// Central config. All env vars parsed here, with defaults and validation.
//
// Bootstrap + storage + paths live here (read once at boot, don't hot-reload).
// Runtime-tunable values (Ollama model, embedder, sync, retrieval, mail/SMTP)
// live in runtime_config.ts and can be edited live via config.yaml or the
// admin UI.

export interface Config {
  brainKey: string;
  port: number;
  host: string;
  storageBackend: "sqlite" | "pgvector" | "two-tier";
  sqlitePath: string;
  pgUrl: string;
  ollamaUrl: string;
  ollamaModel: string;
  autoRoute: boolean;
  trustProxy: boolean;
  classifierModel: string;
  usersFile: string;
  runtimeConfigPath: string;
  python: string;
  sidecarScript: string;
  rustSidecarBin: string;
  openwebuiEnabled: boolean;
  openwebuiUpstream: string;
  openwebuiServiceToken: string;
  importMaxBytes: number;
  importSyncThresholdBytes: number;
  importSyncTimeoutSec: number;
  importMcpTimeoutSec: number;
  whisperModel: string;
  whisperDevice: string;
  ocrLanguage: string;
  importUrlDenylist: string;
}

function required(name: string): string {
  const v = Deno.env.get(name);
  if (!v) {
    throw new Error(`missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  return Deno.env.get(name) ?? fallback;
}

export function loadConfig(): Config {
  const backend = optional("OB2_STORAGE_BACKEND", "two-tier");
  if (backend !== "sqlite" && backend !== "pgvector" && backend !== "two-tier") {
    throw new Error(`OB2_STORAGE_BACKEND must be 'sqlite', 'pgvector', or 'two-tier', got '${backend}'`);
  }

  return {
    brainKey: required("OB2_BRAIN_KEY"),
    port: parseInt(optional("OB2_PORT", "7600"), 10),
    host: optional("OB2_HOST", "127.0.0.1"),
    storageBackend: backend,
    sqlitePath: optional("OB2_SQLITE_PATH", "./ob2.db"),
    pgUrl: optional("OB2_PG_URL", ""),
    ollamaUrl: optional("OB2_OLLAMA_URL", "http://localhost:11434"),
    ollamaModel: optional("OB2_OLLAMA_MODEL", "gemma3:4b"),
    autoRoute: optional("OB2_AUTO_ROUTE", "false") === "true",
    trustProxy: optional("OB2_TRUST_PROXY", "false") === "true",
    classifierModel: optional("OB2_CLASSIFIER_MODEL", ""),
    usersFile: optional("OB2_USERS_FILE", "../users.json"),
    runtimeConfigPath: optional("OB2_RUNTIME_CONFIG_PATH", "../config.yaml"),
    python: optional("OB2_PYTHON", "python3"),
    sidecarScript: optional("OB2_SIDECAR_SCRIPT", "../retrieval/sidecar.py"),
    rustSidecarBin: optional("OB2_RUST_SIDECAR_BIN", "/app/sidecar-rs/ob2-sidecar"),
    openwebuiEnabled: optional("OB2_OPENWEBUI_ENABLED", "false") === "true",
    openwebuiUpstream: optional("OB2_OPENWEBUI_UPSTREAM", "http://ob2-openwebui:8080"),
    openwebuiServiceToken: optional("OB2_OPENWEBUI_SERVICE_TOKEN", ""),
    importMaxBytes: parseInt(optional("OB2_IMPORT_MAX_BYTES", "262144000"), 10),
    importSyncThresholdBytes: parseInt(optional("OB2_IMPORT_SYNC_THRESHOLD_BYTES", "26214400"), 10),
    importSyncTimeoutSec: parseInt(optional("OB2_IMPORT_SYNC_TIMEOUT_SEC", "60"), 10),
    importMcpTimeoutSec: parseInt(optional("OB2_IMPORT_MCP_TIMEOUT_SEC", "600"), 10),
    whisperModel: optional("OB2_WHISPER_MODEL", "base.en"),
    whisperDevice: optional("OB2_WHISPER_DEVICE", "cpu"),
    ocrLanguage: optional("OB2_OCR_LANGUAGE", "eng"),
    importUrlDenylist: optional("OB2_IMPORT_URL_DENYLIST", "127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,169.254.0.0/16,::1/128,fc00::/7"),
  };
}
