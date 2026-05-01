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

export type ProviderId = "ollama" | "llamacpp" | "openai" | "anthropic" | "gemini";

export interface LlmConfig {
  provider: ProviderId;
  /** Empty string → use the same provider as `provider`. */
  classifier_provider: "" | ProviderId;
}

export interface LlamacppConfig {
  /** Control plane (manager service). Used by Phase 2+. Phase 1 leaves this unread. */
  manager_url: string;
  /** Data plane — llama-server's OpenAI-compatible /v1/chat/completions. */
  chat_url: string;
  /** Path inside the manager process; surfaced read-only in the dashboard. */
  models_dir: string;
  /** Filename only (no path). Empty = no auto-load on manager startup. */
  default_model: string;
  ctx_size: number;
  /** -1 = all layers to GPU, 0 = CPU only, N = first N layers to GPU. */
  gpu_layers: number;
  parallel_slots: number;
  /** Advanced llama-server flags appended verbatim. */
  extra_args: string[];
}

/**
 * Cloud-API providers. API keys are env-only (OB2_*_API_KEY) — never written
 * to runtime config so this YAML stays committable.
 */
export interface OpenAIConfig {
  /** Override to point at any OpenAI-compatible endpoint: Groq, Together,
   *  OpenRouter, vLLM, a bare llama-server, etc. */
  base_url: string;
  model: string;
  /** Empty → falls back to `model`. */
  classifier_model: string;
}

export interface AnthropicConfig {
  base_url: string;
  model: string;
  classifier_model: string;
  /** Anthropic's API requires max_tokens on every call. */
  max_tokens: number;
  /** anthropic-version header. */
  api_version: string;
  /** Apply cache_control to the system message + the leading user turn so RAG
   *  context is reused across turns. ~10× cheaper on long-context workloads. */
  prompt_caching: boolean;
}

export interface GeminiConfig {
  base_url: string;
  model: string;
  classifier_model: string;
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
  llm: LlmConfig;
  ollama: OllamaConfig;
  llamacpp: LlamacppConfig;
  openai: OpenAIConfig;
  anthropic: AnthropicConfig;
  gemini: GeminiConfig;
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
  "llm.provider": "OB2_LLM_PROVIDER",
  "llm.classifier_provider": "OB2_LLM_CLASSIFIER_PROVIDER",
  "ollama.url": "OB2_OLLAMA_URL",
  "ollama.model": "OB2_OLLAMA_MODEL",
  "ollama.classifier_model": "OB2_CLASSIFIER_MODEL",
  "ollama.auto_route": "OB2_AUTO_ROUTE",
  "llamacpp.manager_url": "OB2_LLAMACPP_MANAGER_URL",
  "llamacpp.chat_url": "OB2_LLAMACPP_CHAT_URL",
  "llamacpp.models_dir": "OB2_LLAMACPP_MODELS_DIR",
  "llamacpp.default_model": "OB2_LLAMACPP_DEFAULT_MODEL",
  "llamacpp.ctx_size": "OB2_LLAMACPP_CTX_SIZE",
  "llamacpp.gpu_layers": "OB2_LLAMACPP_GPU_LAYERS",
  "llamacpp.parallel_slots": "OB2_LLAMACPP_PARALLEL_SLOTS",
  "openai.base_url": "OB2_OPENAI_BASE_URL",
  "openai.model": "OB2_OPENAI_MODEL",
  "openai.classifier_model": "OB2_OPENAI_CLASSIFIER_MODEL",
  "anthropic.base_url": "OB2_ANTHROPIC_BASE_URL",
  "anthropic.model": "OB2_ANTHROPIC_MODEL",
  "anthropic.classifier_model": "OB2_ANTHROPIC_CLASSIFIER_MODEL",
  "anthropic.max_tokens": "OB2_ANTHROPIC_MAX_TOKENS",
  "anthropic.api_version": "OB2_ANTHROPIC_API_VERSION",
  "anthropic.prompt_caching": "OB2_ANTHROPIC_PROMPT_CACHING",
  "gemini.base_url": "OB2_GEMINI_BASE_URL",
  "gemini.model": "OB2_GEMINI_MODEL",
  "gemini.classifier_model": "OB2_GEMINI_CLASSIFIER_MODEL",
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
  llm: {
    provider: "ollama",
    classifier_provider: "",
  },
  ollama: {
    url: "http://localhost:11434",
    model: "gemma3:4b",
    classifier_model: "",
    auto_route: false,
  },
  llamacpp: {
    manager_url: "http://localhost:8081",
    chat_url: "http://localhost:8080",
    models_dir: "/data/llamacpp/models",
    default_model: "",
    ctx_size: 8192,
    gpu_layers: -1,
    parallel_slots: 1,
    extra_args: [],
  },
  openai: {
    base_url: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    classifier_model: "",
  },
  anthropic: {
    base_url: "https://api.anthropic.com",
    model: "claude-sonnet-4-6",
    classifier_model: "claude-haiku-4-5",
    max_tokens: 4096,
    api_version: "2023-06-01",
    prompt_caching: true,
  },
  gemini: {
    base_url: "https://generativelanguage.googleapis.com",
    model: "gemini-2.0-flash",
    classifier_model: "",
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
  _lastMtime = 0; // force fresh read on (re)init
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

  for (const section of ["llm", "ollama", "llamacpp", "openai", "anthropic", "gemini", "embedder", "sync", "retrieval", "mail", "graph", "context"]) {
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

  const VALID_PROVIDERS = ["ollama", "llamacpp", "openai", "anthropic", "gemini"] as const;
  const llm = c.llm as Record<string, unknown> | undefined;
  if (llm) {
    if (
      llm.provider !== undefined &&
      !VALID_PROVIDERS.includes(llm.provider as typeof VALID_PROVIDERS[number])
    ) {
      throw new Error(`llm.provider must be one of: ${VALID_PROVIDERS.join(", ")}`);
    }
    if (
      llm.classifier_provider !== undefined &&
      llm.classifier_provider !== "" &&
      !VALID_PROVIDERS.includes(llm.classifier_provider as typeof VALID_PROVIDERS[number])
    ) {
      throw new Error(`llm.classifier_provider must be '' or one of: ${VALID_PROVIDERS.join(", ")}`);
    }
  }

  const validateCloudProvider = (
    name: "openai" | "anthropic" | "gemini",
    block: Record<string, unknown> | undefined,
  ) => {
    if (!block) return;
    for (const f of ["base_url", "model", "classifier_model"]) {
      if (block[f] !== undefined && typeof block[f] !== "string") {
        throw new Error(`${name}.${f} must be a string`);
      }
    }
    if (typeof block.base_url === "string" && block.base_url) {
      if (!block.base_url.startsWith("http://") && !block.base_url.startsWith("https://")) {
        throw new Error(`${name}.base_url must start with http:// or https://`);
      }
    }
  };
  validateCloudProvider("openai", c.openai as Record<string, unknown> | undefined);
  validateCloudProvider("anthropic", c.anthropic as Record<string, unknown> | undefined);
  validateCloudProvider("gemini", c.gemini as Record<string, unknown> | undefined);

  const anthropic = c.anthropic as Record<string, unknown> | undefined;
  if (anthropic) {
    if (anthropic.max_tokens !== undefined) {
      const n = anthropic.max_tokens;
      if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
        throw new Error("anthropic.max_tokens must be a positive integer");
      }
    }
    if (anthropic.api_version !== undefined && typeof anthropic.api_version !== "string") {
      throw new Error("anthropic.api_version must be a string");
    }
    if (anthropic.prompt_caching !== undefined && typeof anthropic.prompt_caching !== "boolean") {
      throw new Error("anthropic.prompt_caching must be a boolean");
    }
  }

  const llamacpp = c.llamacpp as Record<string, unknown> | undefined;
  if (llamacpp) {
    for (const f of ["manager_url", "chat_url"]) {
      const v = llamacpp[f];
      if (v !== undefined) {
        if (typeof v !== "string") throw new Error(`llamacpp.${f} must be a string`);
        if (v && !v.startsWith("http://") && !v.startsWith("https://")) {
          throw new Error(`llamacpp.${f} must start with http:// or https://`);
        }
      }
    }
    for (const f of ["models_dir", "default_model"]) {
      if (llamacpp[f] !== undefined && typeof llamacpp[f] !== "string") {
        throw new Error(`llamacpp.${f} must be a string`);
      }
    }
    if (llamacpp.ctx_size !== undefined) {
      const n = llamacpp.ctx_size;
      if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
        throw new Error("llamacpp.ctx_size must be a positive integer");
      }
    }
    if (llamacpp.gpu_layers !== undefined) {
      const n = llamacpp.gpu_layers;
      if (typeof n !== "number" || !Number.isInteger(n) || n < -1) {
        throw new Error("llamacpp.gpu_layers must be an integer ≥ -1");
      }
    }
    if (llamacpp.parallel_slots !== undefined) {
      const n = llamacpp.parallel_slots;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
        throw new Error("llamacpp.parallel_slots must be a positive integer");
      }
    }
    if (llamacpp.extra_args !== undefined) {
      if (!Array.isArray(llamacpp.extra_args) || !llamacpp.extra_args.every((s: unknown) => typeof s === "string")) {
        throw new Error("llamacpp.extra_args must be an array of strings");
      }
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
