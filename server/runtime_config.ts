// Runtime config — file-backed YAML, hot-reloaded on change.
//
// Mirrors the users.ts pattern: mtime-watched, in-memory cache, auto-reload
// on every read. Env vars ALWAYS override file values so 12-factor
// deployments keep working.
//
// Usage:
//     initRuntime(config.runtimeConfigPath);       // at server boot
//     const rt = getRuntime();                      // at each call site
//     rt.ollama.model                               // current model
//
// Modifying the file (e.g. via PUT /admin/config) takes effect on the next
// getRuntime() call — no restart needed.

import yaml from "npm:js-yaml@4.1.0";

// ─────────────────────────────────────────────────────────────
// Types — the full runtime config shape with every field required.
// ─────────────────────────────────────────────────────────────

export interface OllamaConfig {
  url: string;
  model: string;
  classifier_model: string;
  auto_route: boolean;
}

export interface EmbedderConfig {
  model: string;
  dim: number;
  batch_flush_ms: number;
  batch_max_size: number;
}

export interface SyncConfig {
  interval_sec: number;
  batch_size: number;
}

export interface RetrievalConfig {
  default_top_k: number;
  hybrid_alpha: number;
  total_token_budget: number;
}

export interface MailConfig {
  driver: "" | "smtp" | "log"; // "" = disabled
  host: string;
  port: number;
  user: string;
  pass: string;
  secure: "tls" | "starttls" | "none";
  from: string;
  public_url: string;
}

export interface GraphConfig {
  enabled: boolean;             // graph rerank in retrieval (default off until backfilled)
  extraction_enabled: boolean;  // async LLM extraction during capture (default off)
  extraction_model: string;     // empty → falls back to ollama.model
  extraction_concurrency: number;
  rerank_alpha: number;         // weight of graph boost vs vector score
}

export interface ContextConfig {
  show_uploader_in_context: boolean;
}

export interface RuntimeConfig {
  ollama: OllamaConfig;
  embedder: EmbedderConfig;
  sync: SyncConfig;
  retrieval: RetrievalConfig;
  mail: MailConfig;
  graph: GraphConfig;
  context: ContextConfig;
}

// Structure mirrors the RuntimeConfig but every leaf is the raw string
// env var name. Used to compute env-overrides.
const ENV_KEYS: Record<string, string> = {
  "ollama.url": "OB2_OLLAMA_URL",
  "ollama.model": "OB2_OLLAMA_MODEL",
  "ollama.classifier_model": "OB2_CLASSIFIER_MODEL",
  "ollama.auto_route": "OB2_AUTO_ROUTE",
  "embedder.model": "OB2_EMBEDDING_MODEL",
  "embedder.dim": "OB2_EMBEDDING_DIM",
  "embedder.batch_flush_ms": "OB2_BATCH_FLUSH_MS",
  "embedder.batch_max_size": "OB2_BATCH_MAX_SIZE",
  "sync.interval_sec": "OB2_SYNC_INTERVAL_SEC",
  "sync.batch_size": "OB2_SYNC_BATCH_SIZE",
  "retrieval.default_top_k": "OB2_RETRIEVAL_TOP_K",
  "retrieval.hybrid_alpha": "OB2_HYBRID_ALPHA",
  "retrieval.total_token_budget": "OB2_TOTAL_TOKEN_BUDGET",
  "mail.driver": "OB2_SMTP_DRIVER",
  "mail.host": "OB2_SMTP_HOST",
  "mail.port": "OB2_SMTP_PORT",
  "mail.user": "OB2_SMTP_USER",
  "mail.pass": "OB2_SMTP_PASS",
  "mail.secure": "OB2_SMTP_SECURE",
  "mail.from": "OB2_SMTP_FROM",
  "mail.public_url": "OB2_PUBLIC_URL",
  "graph.enabled": "OB2_GRAPH_ENABLED",
  "graph.extraction_enabled": "OB2_GRAPH_EXTRACTION_ENABLED",
  "graph.extraction_model": "OB2_GRAPH_EXTRACTION_MODEL",
  "graph.extraction_concurrency": "OB2_GRAPH_EXTRACTION_CONCURRENCY",
  "graph.rerank_alpha": "OB2_GRAPH_RERANK_ALPHA",
  "context.show_uploader_in_context": "OB2_CONTEXT_SHOW_UPLOADER",
};

const DEFAULTS: RuntimeConfig = {
  ollama: {
    url: "http://localhost:11434",
    model: "gemma3:4b",
    classifier_model: "",
    auto_route: false,
  },
  embedder: {
    model: "all-MiniLM-L6-v2",
    dim: 384,
    batch_flush_ms: 100,
    batch_max_size: 32,
  },
  sync: {
    interval_sec: 5,
    batch_size: 256,
  },
  retrieval: {
    default_top_k: 5,
    hybrid_alpha: 0.65,
    total_token_budget: 2048,
  },
  mail: {
    driver: "",
    host: "",
    port: 587,
    user: "",
    pass: "",
    secure: "starttls",
    from: "",
    public_url: "",
  },
  graph: {
    enabled: false,
    extraction_enabled: false,
    extraction_model: "",
    extraction_concurrency: 1,
    rerank_alpha: 0.3,
  },
  context: {
    show_uploader_in_context: true,
  },
};

// ─────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────

let _path = "";
let _fileConfig: Partial<RuntimeConfig> = {};
let _lastMtime = 0;
let _cached: RuntimeConfig = structuredClone(DEFAULTS);

// ─────────────────────────────────────────────────────────────

export function initRuntime(configPath: string): void {
  _path = configPath;
  _reloadIfChanged();
}

function _reloadIfChanged(): void {
  if (!_path) return;
  try {
    const stat = Deno.statSync(_path);
    const mtime = stat.mtime?.getTime() ?? 0;
    if (mtime <= _lastMtime) return;
    _lastMtime = mtime;

    const text = Deno.readTextFileSync(_path);
    const parsed = yaml.load(text);
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("runtime config must be a YAML object");
    }
    _fileConfig = parsed as Partial<RuntimeConfig>;
    _cached = _merge();
    console.log(`Loaded runtime config from ${_path}`);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      // First run — write the defaults as a starter file
      try {
        Deno.writeTextFileSync(_path, yaml.dump(DEFAULTS));
        console.log(`Created default runtime config at ${_path}`);
        _lastMtime = 0; // force re-read on next call
      } catch (we) {
        console.warn(`Runtime config missing and couldn't seed: ${we}`);
      }
      return;
    }
    console.error(`Failed to load runtime config: ${e}`);
  }
}

/** Merge defaults ← file ← env (env wins). */
function _merge(): RuntimeConfig {
  const merged = structuredClone(DEFAULTS);
  _deepMerge(
    merged as unknown as Record<string, unknown>,
    _fileConfig as Record<string, unknown>,
  );
  _applyEnvOverrides(merged);
  // Normalization: strip trailing slash on public_url so downstream URL
  // construction (${public_url}/dashboard?...) never produces double slashes.
  merged.mail.public_url = merged.mail.public_url.replace(/\/+$/, "");
  return merged;
}

function _deepMerge(target: Record<string, unknown>, patch: Record<string, unknown> | undefined | null): void {
  if (!patch) return;
  for (const [k, v] of Object.entries(patch)) {
    if (
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof target[k] === "object" &&
      target[k] !== null
    ) {
      _deepMerge(target[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      target[k] = v;
    }
  }
}

function _applyEnvOverrides(cfg: RuntimeConfig): void {
  const cfgAny = cfg as unknown as Record<string, Record<string, unknown>>;
  for (const [dotPath, envName] of Object.entries(ENV_KEYS)) {
    const v = Deno.env.get(envName);
    if (v === undefined || v === "") continue;
    const parts = dotPath.split(".");
    const section = parts[0];
    const leaf = parts[1];
    const parent = cfgAny[section];
    if (!parent) continue;
    const current = parent[leaf];

    // Coerce to the same type as the default
    if (typeof current === "boolean") {
      parent[leaf] = v === "true" || v === "1";
    } else if (typeof current === "number") {
      const n = Number(v);
      if (!Number.isNaN(n)) parent[leaf] = n;
    } else {
      parent[leaf] = v;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Public accessors
// ─────────────────────────────────────────────────────────────

export function getRuntime(): RuntimeConfig {
  _reloadIfChanged();
  return _cached;
}

/** Returns the raw file contents (without env overrides) for the admin UI. */
export function getFileConfig(): Partial<RuntimeConfig> {
  _reloadIfChanged();
  return structuredClone(_fileConfig);
}

/** Returns env overrides as a flat { "ollama.url": "http://..." } map, for UI source badges. */
export function getEnvOverrides(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [dotPath, envName] of Object.entries(ENV_KEYS)) {
    const v = Deno.env.get(envName);
    if (v !== undefined && v !== "") out[dotPath] = v;
  }
  return out;
}

/** Validate a candidate config object; throws on error. */
export function validateRuntime(candidate: unknown): Partial<RuntimeConfig> {
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error("config must be an object");
  }
  const c = candidate as Record<string, unknown>;

  for (const section of ["ollama", "embedder", "sync", "retrieval", "mail", "graph", "context"]) {
    if (section in c && (typeof c[section] !== "object" || c[section] === null)) {
      throw new Error(`'${section}' must be an object`);
    }
  }

  // Type-check specific fields where coercion matters
  const ollama = c.ollama as Record<string, unknown> | undefined;
  if (ollama) {
    if (ollama.url && typeof ollama.url !== "string") throw new Error("ollama.url must be string");
    if (ollama.auto_route !== undefined && typeof ollama.auto_route !== "boolean") {
      throw new Error("ollama.auto_route must be boolean");
    }
  }
  const embedder = c.embedder as Record<string, unknown> | undefined;
  if (embedder) {
    for (const f of ["dim", "batch_flush_ms", "batch_max_size"]) {
      if (embedder[f] !== undefined && typeof embedder[f] !== "number") {
        throw new Error(`embedder.${f} must be a number`);
      }
    }
  }
  const sync = c.sync as Record<string, unknown> | undefined;
  if (sync) {
    for (const f of ["interval_sec", "batch_size"]) {
      if (sync[f] !== undefined && typeof sync[f] !== "number") {
        throw new Error(`sync.${f} must be a number`);
      }
    }
  }
  const retrieval = c.retrieval as Record<string, unknown> | undefined;
  if (retrieval) {
    if (retrieval.hybrid_alpha !== undefined) {
      const a = retrieval.hybrid_alpha;
      if (typeof a !== "number" || a < 0 || a > 1) {
        throw new Error("retrieval.hybrid_alpha must be a number in [0, 1]");
      }
    }
    for (const f of ["default_top_k", "total_token_budget"]) {
      if (retrieval[f] !== undefined && typeof retrieval[f] !== "number") {
        throw new Error(`retrieval.${f} must be a number`);
      }
    }
  }

  const mail = c.mail as Record<string, unknown> | undefined;
  if (mail) {
    if (mail.driver !== undefined && !["", "smtp", "log"].includes(mail.driver as string)) {
      throw new Error("mail.driver must be '', 'smtp', or 'log'");
    }
    if (mail.secure !== undefined && !["tls", "starttls", "none"].includes(mail.secure as string)) {
      throw new Error("mail.secure must be 'tls', 'starttls', or 'none'");
    }
    if (mail.port !== undefined && (typeof mail.port !== "number" || !Number.isInteger(mail.port) || mail.port <= 0)) {
      throw new Error("mail.port must be a positive integer");
    }
    for (const f of ["host", "user", "pass", "from", "public_url"]) {
      if (mail[f] !== undefined && typeof mail[f] !== "string") {
        throw new Error(`mail.${f} must be a string`);
      }
    }
    if (typeof mail.public_url === "string" && mail.public_url && !mail.public_url.startsWith("http://") && !mail.public_url.startsWith("https://")) {
      throw new Error("mail.public_url must start with http:// or https://");
    }
  }

  const context = c.context as Record<string, unknown> | undefined;
  if (context) {
    if (context.show_uploader_in_context !== undefined && typeof context.show_uploader_in_context !== "boolean") {
      throw new Error("context.show_uploader_in_context must be a boolean");
    }
  }

  return c as Partial<RuntimeConfig>;
}

/** Write a new file config. Caller already validated. */
export function writeRuntime(candidate: Partial<RuntimeConfig>): void {
  if (!_path) throw new Error("runtime config path not initialized");
  const text = yaml.dump(candidate, { lineWidth: 120 });
  Deno.writeTextFileSync(_path, text);
  _lastMtime = 0; // force reload on next call
  _reloadIfChanged();
}

export function runtimeConfigPath(): string {
  return _path;
}

/** YAML-serialize the current file-level config for the admin UI. */
export function dumpFileConfigYaml(): string {
  return yaml.dump(getFileConfig() as Record<string, unknown>, { lineWidth: 120 });
}
