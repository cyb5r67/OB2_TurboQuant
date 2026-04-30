# llama.cpp Provider — Phase 1: Provider Abstraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a provider abstraction in front of OB2_TurboQuant's LLM call sites so chat can be routed to either Ollama or `llama-server` based on a runtime config switch — without touching Docker, the dashboard, or the manager service.

**Architecture:** Two new files (`server/llm/provider.ts` for the interface and factory, `server/llm/openai_sse.ts` for shared SSE encoding) plus two adapter files (`ollama_provider.ts`, `llamacpp_provider.ts`). The three call sites that talk to Ollama today (`gateway.ts`, `classifier.ts`, `mcp.ts`) are refactored to call `getProvider()` / `getClassifierProvider()`. `server/ollama/client.ts` and `server/ollama/pulls.ts` are NOT touched — the new `ollama_provider.ts` is a facade over them, preserving the Ollama wire path bit-for-bit.

**Tech Stack:** Deno + TypeScript + Hono. Custom one-shot test scripts (the codebase uses `deno run path/to/foo_test.ts` with a local `assert()` helper rather than `Deno.test` — see `server/import/chunker_test.ts` for the pattern). Runtime config in `server/runtime_config.ts` is YAML-backed with env-var overrides.

**Spec:** `docs/superpowers/specs/2026-04-30-llamacpp-provider-design.md`. Phase 1 delivers Section 4 ("Provider abstraction in OB2 server") and the `llm.*` / `llamacpp.*` parts of Section 2 ("Runtime config schema"), and refactors the three call-sites listed in the spec's call-site table EXCEPT `admin.ts` (which is deliberately left on the existing Ollama path until Phase 3) and `config_api.ts` (which only needs to surface the new fields once the dashboard exists in Phase 3).

---

## File Structure

### Created

| File | Responsibility |
|---|---|
| `server/llm/provider.ts` | Provider interface (`ChatProvider`, `ManagementProvider`, `Provider`), shared types (`ChatMessage`, `ChatChunk`, `ChatOpts`, `NonStreamResult`, `ModelEntry`, `LoadedEntry`, `PullSpec`, `PullProgress`, `LoadOpts`), and factories `getProvider()` / `getClassifierProvider()`. |
| `server/llm/openai_sse.ts` | One pure function: `chatChunkStreamToOpenAiSSE(modelId, stream)` — encodes a `ReadableStream<ChatChunk>` into the OpenAI Chat Completions SSE wire format. Used by `gateway.ts` for both providers. |
| `server/llm/ollama_provider.ts` | `OllamaProvider` class implementing `Provider`. Wraps `server/ollama/client.ts` and `server/ollama/pulls.ts` (untouched). The Ollama-NDJSON-to-`ChatChunk` parser lives here. |
| `server/llm/llamacpp_provider.ts` | `LlamacppProvider` class implementing `ChatProvider` fully and `ManagementProvider` partially (every management method throws `NotImplementedInPhase1` — the manager service doesn't exist yet). Talks to `${cfg.chat_url}/v1/chat/completions`; parses OpenAI SSE back into `ChatChunk`. |
| `server/llm/provider_test.ts` | Tests `getProvider()` / `getClassifierProvider()` factory dispatch on config values. |
| `server/llm/openai_sse_test.ts` | Tests SSE chunk encoding for known `ChatChunk` sequences. |
| `server/llm/ollama_provider_test.ts` | Tests Ollama NDJSON parsing → `ChatChunk` and `chatNonStream` against a mock fetch. |
| `server/llm/llamacpp_provider_test.ts` | Tests OpenAI SSE parsing → `ChatChunk` and `chatNonStream` against a mock fetch. |
| `tests/fixtures/fake-llama-server.ts` | Tiny Deno HTTP server that responds to `POST /v1/chat/completions` with canned OpenAI SSE frames. Used by the e2e smoke test only. |

### Modified

| File | Change |
|---|---|
| `server/runtime_config.ts` | Add `LlmConfig` and `LlamacppConfig` interfaces, extend `RuntimeConfig`, extend `DEFAULTS`, add new entries to `ENV_KEYS`, extend `validateRuntime`. **No changes to existing `OllamaConfig` or `ollama` defaults.** |
| `server/routes/gateway.ts` | Replace local `callOllamaStream` / `callOllamaNonStream` / `ollamaToOpenAiSSE` with `getProvider()` calls + `chatChunkStreamToOpenAiSSE`. Net deletion ~80 lines. Keep all other gateway logic (auth, domain resolution, retrieval, source-link augmentation) unchanged. |
| `server/routes/classifier.ts` | Replace direct `fetch(${rt.ollama.url}/api/chat)` call with `getClassifierProvider().chatNonStream(...)`. |
| `server/routes/mcp.ts` | Replace the inline Ollama fetch in the `chat_knowledge` tool with `getProvider().chatNonStream(...)`. |
| `tests/e2e.sh` | Add `verify_llamacpp_provider` test that runs the fake llama-server fixture and asserts streaming chat works through the gateway. Existing tests run unchanged. |

### NOT touched in Phase 1

- `server/ollama/client.ts`, `server/ollama/pulls.ts` — wrapped, not modified.
- `server/routes/admin.ts` — Ollama-specific management endpoints stay on the direct Ollama path (provider-aware in Phase 3).
- `server/routes/config_api.ts` — new fields are accepted by `validateRuntime`; surfacing them in the editor UI happens in Phase 3.
- `docker/docker-compose.yml`, `Dockerfile` — Phase 2.
- Any dashboard files — Phase 3.

---

## Task 1: Add `LlmConfig` and `LlamacppConfig` types and defaults

**Files:**
- Modify: `server/runtime_config.ts`
- Test: `server/runtime_config_test.ts` (new)

- [ ] **Step 1: Read the current runtime_config.ts top section to confirm the merge points**

Run: `head -160 server/runtime_config.ts`
Expected: see `OllamaConfig` interface, `ENV_KEYS` map, `DEFAULTS` const, and `RuntimeConfig` interface.

- [ ] **Step 2: Write the failing test** at `server/runtime_config_test.ts`

```ts
// server/runtime_config_test.ts
// Run with: deno run --allow-read --allow-write --allow-env server/runtime_config_test.ts
import {
  initRuntime,
  getRuntime,
  validateRuntime,
} from "./runtime_config.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; }
  else { console.log("PASS:", msg); }
}

const tmp = await Deno.makeTempFile({ suffix: ".yaml" });
await Deno.writeTextFile(tmp, [
  "llm:",
  "  provider: llamacpp",
  "  classifier_provider: ollama",
  "llamacpp:",
  "  manager_url: http://m:8081",
  "  chat_url: http://m:8080",
  "  models_dir: /tmp/models",
  "  default_model: foo.gguf",
  "  ctx_size: 4096",
  "  gpu_layers: 32",
  "  parallel_slots: 2",
].join("\n"));
initRuntime(tmp);
const rt = getRuntime();

assert(rt.llm.provider === "llamacpp", "llm.provider read from YAML");
assert(rt.llm.classifier_provider === "ollama", "llm.classifier_provider read from YAML");
assert(rt.llamacpp.manager_url === "http://m:8081", "llamacpp.manager_url read");
assert(rt.llamacpp.ctx_size === 4096, "llamacpp.ctx_size coerced to number");
assert(rt.llamacpp.gpu_layers === 32, "llamacpp.gpu_layers coerced to number");

// Defaults applied when section absent
const tmp2 = await Deno.makeTempFile({ suffix: ".yaml" });
await Deno.writeTextFile(tmp2, "ollama:\n  url: http://x:11434\n");
initRuntime(tmp2);
const rt2 = getRuntime();
assert(rt2.llm.provider === "ollama", "llm.provider defaults to ollama when section absent");
assert(rt2.llamacpp.ctx_size === 8192, "llamacpp.ctx_size default");
assert(rt2.llamacpp.gpu_layers === -1, "llamacpp.gpu_layers default");
assert(rt2.llamacpp.parallel_slots === 1, "llamacpp.parallel_slots default");

// Env override
Deno.env.set("OB2_LLM_PROVIDER", "llamacpp");
Deno.env.set("OB2_LLAMACPP_CTX_SIZE", "16384");
initRuntime(tmp2);
const rt3 = getRuntime();
assert(rt3.llm.provider === "llamacpp", "OB2_LLM_PROVIDER overrides file");
assert(rt3.llamacpp.ctx_size === 16384, "OB2_LLAMACPP_CTX_SIZE overrides file");
Deno.env.delete("OB2_LLM_PROVIDER");
Deno.env.delete("OB2_LLAMACPP_CTX_SIZE");

// Validation rejects bad values
let threw = false;
try { validateRuntime({ llm: { provider: "anthropic" } }); }
catch { threw = true; }
assert(threw, "validateRuntime rejects unknown llm.provider");

threw = false;
try { validateRuntime({ llamacpp: { gpu_layers: -2 } }); }
catch { threw = true; }
assert(threw, "validateRuntime rejects gpu_layers < -1");

threw = false;
try { validateRuntime({ llamacpp: { ctx_size: 0 } }); }
catch { threw = true; }
assert(threw, "validateRuntime rejects ctx_size <= 0");

threw = false;
try { validateRuntime({ llamacpp: { manager_url: "ftp://x" } }); }
catch { threw = true; }
assert(threw, "validateRuntime rejects non-http manager_url");

await Deno.remove(tmp);
await Deno.remove(tmp2);
if (failures > 0) Deno.exit(1);
console.log(`\nAll runtime_config tests passed.`);
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `deno run --allow-read --allow-write --allow-env server/runtime_config_test.ts`
Expected: FAIL — `rt.llm` is undefined.

- [ ] **Step 4: Add the `LlmConfig` and `LlamacppConfig` interfaces**

In `server/runtime_config.ts`, after the `OllamaConfig` interface (around line 26), add:

```ts
export interface LlmConfig {
  provider: "ollama" | "llamacpp";
  /** Empty string → use the same provider as `provider`. */
  classifier_provider: "" | "ollama" | "llamacpp";
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
```

Then extend the `RuntimeConfig` interface (around line 69) so it includes the new sections. Add `llm: LlmConfig;` and `llamacpp: LlamacppConfig;` alongside the existing fields.

- [ ] **Step 5: Add ENV_KEYS entries**

In `server/runtime_config.ts`, extend `ENV_KEYS` (around line 81) with:

```ts
  "llm.provider": "OB2_LLM_PROVIDER",
  "llm.classifier_provider": "OB2_LLM_CLASSIFIER_PROVIDER",
  "llamacpp.manager_url": "OB2_LLAMACPP_MANAGER_URL",
  "llamacpp.chat_url": "OB2_LLAMACPP_CHAT_URL",
  "llamacpp.models_dir": "OB2_LLAMACPP_MODELS_DIR",
  "llamacpp.default_model": "OB2_LLAMACPP_DEFAULT_MODEL",
  "llamacpp.ctx_size": "OB2_LLAMACPP_CTX_SIZE",
  "llamacpp.gpu_layers": "OB2_LLAMACPP_GPU_LAYERS",
  "llamacpp.parallel_slots": "OB2_LLAMACPP_PARALLEL_SLOTS",
```

- [ ] **Step 6: Add DEFAULTS entries**

In `server/runtime_config.ts`, extend the `DEFAULTS` const (around line 111) with the new sections. Add ahead of the existing `ollama` block:

```ts
  llm: {
    provider: "ollama",
    classifier_provider: "",
  },
```

And after the existing `ollama` block:

```ts
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
```

- [ ] **Step 7: Extend `validateRuntime`**

In `server/runtime_config.ts`, locate the `validateRuntime` function (around line 284). Add `"llm"` and `"llamacpp"` to the section-list it iterates (around line 290). Then add validation blocks before the final `return c as Partial<RuntimeConfig>;`:

```ts
  const llm = c.llm as Record<string, unknown> | undefined;
  if (llm) {
    if (llm.provider !== undefined && llm.provider !== "ollama" && llm.provider !== "llamacpp") {
      throw new Error("llm.provider must be 'ollama' or 'llamacpp'");
    }
    if (
      llm.classifier_provider !== undefined &&
      llm.classifier_provider !== "" &&
      llm.classifier_provider !== "ollama" &&
      llm.classifier_provider !== "llamacpp"
    ) {
      throw new Error("llm.classifier_provider must be '', 'ollama', or 'llamacpp'");
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
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `deno run --allow-read --allow-write --allow-env server/runtime_config_test.ts`
Expected: PASS for every assertion. If any fail, fix the implementation.

- [ ] **Step 9: Commit**

```bash
git add server/runtime_config.ts server/runtime_config_test.ts
git commit -m "feat(config): add llm.* and llamacpp.* runtime config sections"
```

---

## Task 2: Provider interface, shared types, and `NotImplementedInPhase1` error

**Files:**
- Create: `server/llm/provider.ts`

This task creates the interface and types only. The factory functions are stubbed (they throw `"factory not wired"`) and get filled in once the adapters exist (Task 6).

- [ ] **Step 1: Create the provider.ts file with types and interface**

Write `server/llm/provider.ts`:

```ts
// Provider abstraction in front of the LLM call sites.
//
// `ChatProvider` is non-negotiable — every provider implements it.
// `ManagementProvider` is partial — methods may throw `NotImplementedInPhase1`
// or `NotSupported`, gated by `capabilities()` so the dashboard can grey out
// unsupported actions instead of hitting an endpoint that 501s.
//
// Factory functions `getProvider()` and `getClassifierProvider()` read the
// active provider from runtime config (hot-reloaded). Adapter modules
// register themselves into module-scoped slots in this file.

// ─────────────────────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ChatOpts {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
}

/** Normalized streaming chunk. Both providers parse their wire format into this. */
export interface ChatChunk {
  /** Incremental text. Empty string allowed (e.g. on the terminal frame). */
  content: string;
  done: boolean;
  finish_reason?: "stop" | "length";
}

export interface NonStreamResult {
  content: string;
  prompt_tokens: number;
  completion_tokens: number;
}

export interface ModelEntry {
  /** For Ollama: the model name (e.g. "gemma3:4b"). For llamacpp: the GGUF filename. */
  name: string;
  size_bytes: number;
  modified_at: string;
  /** Provider-specific extras the dashboard may surface. */
  details?: Record<string, unknown>;
}

export interface LoadedEntry {
  name: string;
  /** Provider-specific extras (Ollama: VRAM bytes; llamacpp: ctx_size, port). */
  details?: Record<string, unknown>;
}

export interface PullSpec {
  source: "url" | "hf" | "ollama";
  /** When source=url. */
  url?: string;
  /** When source=hf. */
  repo?: string;
  file?: string;
  /** When source=ollama. */
  name?: string;
}

export interface PullProgress {
  status: string;
  total?: number;
  completed?: number;
}

export interface LoadOpts {
  ctx_size?: number;
  gpu_layers?: number;
  parallel_slots?: number;
}

export interface Capabilities {
  canList: boolean;
  canPull: boolean;
  canDelete: boolean;
  canLoad: boolean;
  canUnload: boolean;
  canWarm: boolean;
}

// ─────────────────────────────────────────────────────────────
// Provider interface
// ─────────────────────────────────────────────────────────────

export interface ChatProvider {
  readonly id: "ollama" | "llamacpp";
  /** Free-form label for telemetry / status header. */
  activeModelLabel(): Promise<string>;
  chatStream(messages: ChatMessage[], opts: ChatOpts): Promise<ReadableStream<ChatChunk>>;
  chatNonStream(messages: ChatMessage[], opts: ChatOpts): Promise<NonStreamResult>;
}

export interface ManagementProvider {
  capabilities(): Capabilities;
  listInstalled(): Promise<ModelEntry[]>;
  listLoaded(): Promise<LoadedEntry[]>;
  pullModel(
    spec: PullSpec,
    onProgress: (p: PullProgress) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  /** llamacpp only — Ollama implementations should throw `NotSupported`. */
  loadModel(name: string, opts?: LoadOpts): Promise<void>;
  /** Ollama: by-name unload. llamacpp: ignores `name`, unloads the running model. */
  unloadModel(name?: string): Promise<void>;
  /** Ollama only — llamacpp throws `NotSupported`. */
  warmModel(name: string): Promise<void>;
  deleteModel(name: string): Promise<void>;
}

export type Provider = ChatProvider & Partial<ManagementProvider>;

// ─────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────

/** Thrown by providers for capability methods their backend doesn't support. */
export class NotSupported extends Error {
  constructor(method: string, providerId: string) {
    super(`${providerId} does not support ${method}`);
    this.name = "NotSupported";
  }
}

/** Thrown by Phase 1 stubs that depend on the Phase 2 manager service. */
export class NotImplementedInPhase1 extends Error {
  constructor(method: string) {
    super(`${method} requires the llamacpp manager service (Phase 2)`);
    this.name = "NotImplementedInPhase1";
  }
}

// ─────────────────────────────────────────────────────────────
// Factory (filled in by Task 6)
// ─────────────────────────────────────────────────────────────

export function getProvider(): Provider {
  throw new Error("provider factory not wired — see Task 6");
}

export function getClassifierProvider(): Provider {
  throw new Error("classifier provider factory not wired — see Task 6");
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `deno check server/llm/provider.ts`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/llm/provider.ts
git commit -m "feat(llm): provider interface, shared types, factory stubs"
```

---

## Task 3: Shared OpenAI-SSE encoder (`openai_sse.ts`)

This extracts the SSE-construction logic from `gateway.ts:ollamaToOpenAiSSE` into a pure function that consumes a `ReadableStream<ChatChunk>`. After the refactor in Task 7, `gateway.ts` no longer cares which provider produced the stream.

**Files:**
- Create: `server/llm/openai_sse.ts`
- Test: `server/llm/openai_sse_test.ts`

- [ ] **Step 1: Write the failing test**

Write `server/llm/openai_sse_test.ts`:

```ts
// Run with: deno run server/llm/openai_sse_test.ts
import { chatChunkStreamToOpenAiSSE } from "./openai_sse.ts";
import type { ChatChunk } from "./provider.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; }
  else { console.log("PASS:", msg); }
}

function chunksToStream(chunks: ChatChunk[]): ReadableStream<ChatChunk> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
  return out;
}

// Case 1: typical streaming completion
{
  const chunks: ChatChunk[] = [
    { content: "Hello", done: false },
    { content: " world", done: false },
    { content: "", done: true, finish_reason: "stop" },
  ];
  const sse = await collect(chatChunkStreamToOpenAiSSE("ob2", chunksToStream(chunks)));
  // Expect: 1 role-delta frame + 2 content frames + 1 finish frame + [DONE]
  const frames = sse.trim().split("\n\n");
  assert(frames.length === 5, `5 SSE frames; got ${frames.length}`);
  assert(frames[0].includes('"role":"assistant"'), "first frame is role delta");
  assert(frames[1].includes('"content":"Hello"'), "second frame is 'Hello'");
  assert(frames[2].includes('"content":" world"'), "third frame is ' world'");
  assert(frames[3].includes('"finish_reason":"stop"'), "fourth frame is finish=stop");
  assert(frames[4] === "data: [DONE]", "last frame is [DONE]");
}

// Case 2: empty content chunks are emitted as content deltas only when non-empty,
// but the role-delta and [DONE] still bracket the stream.
{
  const chunks: ChatChunk[] = [
    { content: "", done: false },
    { content: "x", done: false },
    { content: "", done: true, finish_reason: "length" },
  ];
  const sse = await collect(chatChunkStreamToOpenAiSSE("ob2", chunksToStream(chunks)));
  const frames = sse.trim().split("\n\n");
  // Expect: role-delta + 1 content frame ('x') + finish frame + [DONE]
  assert(frames.length === 4, `4 SSE frames (empty content suppressed); got ${frames.length}`);
  assert(frames[2].includes('"finish_reason":"length"'), "finish=length passes through");
}

// Case 3: each frame is `data: <json>\n\n` shape (Server-Sent Events spec)
{
  const chunks: ChatChunk[] = [
    { content: "ok", done: false },
    { content: "", done: true, finish_reason: "stop" },
  ];
  const sse = await collect(chatChunkStreamToOpenAiSSE("test-model", chunksToStream(chunks)));
  for (const line of sse.split("\n\n").filter(Boolean)) {
    assert(line.startsWith("data: "), `frame begins with 'data: ': ${line.slice(0, 20)}`);
  }
  assert(sse.includes('"model":"test-model"'), "model id propagated");
}

if (failures > 0) Deno.exit(1);
console.log("\nAll openai_sse tests passed.");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno run server/llm/openai_sse_test.ts`
Expected: FAIL — `chatChunkStreamToOpenAiSSE` doesn't exist.

- [ ] **Step 3: Write the implementation**

Write `server/llm/openai_sse.ts`:

```ts
// Encodes a ChatChunk stream into the OpenAI Chat Completions SSE wire format.
//
// Provider-agnostic: gateway.ts uses this for both Ollama and llamacpp.
// Format reference: https://platform.openai.com/docs/api-reference/chat/streaming
//
// Frames produced:
//   1. role-delta:    {choices:[{delta:{role:"assistant"}}]}
//   2. content-delta: {choices:[{delta:{content:"<text>"}}]} (one per non-empty chunk)
//   3. finish-delta:  {choices:[{delta:{},finish_reason:"stop"|"length"}]}
//   4. terminator:    `data: [DONE]\n\n`

import type { ChatChunk } from "./provider.ts";

function nowId(): string {
  return `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function chatChunkStreamToOpenAiSSE(
  modelId: string,
  source: ReadableStream<ChatChunk>,
): ReadableStream<Uint8Array> {
  const id = nowId();
  const created = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      const reader = source.getReader();
      let firstChunk = true;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;

          if (firstChunk) {
            firstChunk = false;
            const role = {
              id, object: "chat.completion.chunk", created, model: modelId,
              choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
            };
            controller.enqueue(enc.encode(`data: ${JSON.stringify(role)}\n\n`));
          }

          if (value.content) {
            const payload = {
              id, object: "chat.completion.chunk", created, model: modelId,
              choices: [{ index: 0, delta: { content: value.content }, finish_reason: null }],
            };
            controller.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`));
          }

          if (value.done) {
            const finalFrame = {
              id, object: "chat.completion.chunk", created, model: modelId,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: value.finish_reason ?? "stop",
              }],
            };
            controller.enqueue(enc.encode(`data: ${JSON.stringify(finalFrame)}\n\n`));
            controller.enqueue(enc.encode("data: [DONE]\n\n"));
            break;
          }
        }
      } catch (err) {
        const errPayload = {
          error: { message: (err as Error).message, type: "upstream_error" },
        };
        controller.enqueue(enc.encode(`data: ${JSON.stringify(errPayload)}\n\n`));
      } finally {
        controller.close();
      }
    },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno run server/llm/openai_sse_test.ts`
Expected: every assertion PASS.

- [ ] **Step 5: Commit**

```bash
git add server/llm/openai_sse.ts server/llm/openai_sse_test.ts
git commit -m "feat(llm): provider-agnostic OpenAI SSE encoder"
```

---

## Task 4: Ollama adapter (`ollama_provider.ts`)

Wraps the existing `server/ollama/client.ts` and `server/ollama/pulls.ts` modules. Implements the full `Provider` interface. The Ollama-NDJSON-to-`ChatChunk` parser lives here.

**Files:**
- Create: `server/llm/ollama_provider.ts`
- Test: `server/llm/ollama_provider_test.ts`

- [ ] **Step 1: Confirm what `server/ollama/client.ts` exports**

Run: `grep -n "^export" server/ollama/client.ts`
Expected: see `listInstalled`, `listLoaded`, `unloadModel`, `warmModel`, `deleteModel`, `pullModel`, plus the type interfaces.

- [ ] **Step 2: Write the failing test**

Write `server/llm/ollama_provider_test.ts`:

```ts
// Run with: deno run --allow-net --allow-read --allow-write --allow-env server/llm/ollama_provider_test.ts
import { ollamaProvider } from "./ollama_provider.ts";
import { initRuntime } from "../runtime_config.ts";
import type { ChatChunk } from "./provider.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; }
  else { console.log("PASS:", msg); }
}

// Mock fetch — Ollama emits NDJSON.
const realFetch = globalThis.fetch;
function mockFetch(handler: (input: string | URL, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(typeof input === "string" || input instanceof URL ? input : input.url, init))
  ) as typeof fetch;
}
function restoreFetch() { globalThis.fetch = realFetch; }

// Set up a minimal config file so getRuntime() works.
const tmp = await Deno.makeTempFile({ suffix: ".yaml" });
await Deno.writeTextFile(tmp, "ollama:\n  url: http://localhost:11434\n  model: gemma3:4b\n");
initRuntime(tmp);

// Case 1: chatNonStream
{
  mockFetch((url, init) => {
    if (String(url).endsWith("/api/chat")) {
      const body = JSON.parse(init?.body as string);
      assert(body.model === "gemma3:4b", "uses configured model");
      assert(body.stream === false, "non-stream flag set");
      return new Response(JSON.stringify({
        message: { content: "hello there" },
        prompt_eval_count: 4,
        eval_count: 2,
      }), { status: 200 });
    }
    throw new Error("unexpected url " + url);
  });
  const r = await ollamaProvider.chatNonStream(
    [{ role: "user", content: "hi" }],
    { temperature: 0.5 },
  );
  assert(r.content === "hello there", "chatNonStream content");
  assert(r.prompt_tokens === 4, "prompt_tokens parsed");
  assert(r.completion_tokens === 2, "completion_tokens parsed");
  restoreFetch();
}

// Case 2: chatStream parses NDJSON to ChatChunk
{
  const ndjson = [
    '{"model":"gemma3:4b","created_at":"...","message":{"role":"assistant","content":"Hi"},"done":false}',
    '{"model":"gemma3:4b","created_at":"...","message":{"role":"assistant","content":" you"},"done":false}',
    '{"model":"gemma3:4b","created_at":"...","done":true,"done_reason":"stop"}',
  ].join("\n") + "\n";

  mockFetch((url, init) => {
    if (String(url).endsWith("/api/chat")) {
      const body = JSON.parse(init?.body as string);
      assert(body.stream === true, "stream flag set on stream call");
      return new Response(ndjson, { status: 200 });
    }
    throw new Error("unexpected url " + url);
  });

  const stream = await ollamaProvider.chatStream(
    [{ role: "user", content: "hi" }],
    {},
  );
  const reader = stream.getReader();
  const collected: ChatChunk[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    collected.push(value!);
  }
  assert(collected.length === 3, `3 chunks (got ${collected.length})`);
  assert(collected[0].content === "Hi" && !collected[0].done, "chunk 1 = 'Hi'");
  assert(collected[1].content === " you" && !collected[1].done, "chunk 2 = ' you'");
  assert(collected[2].done && collected[2].finish_reason === "stop", "chunk 3 = done/stop");
  restoreFetch();
}

// Case 3: id and capabilities
{
  assert(ollamaProvider.id === "ollama", "id is 'ollama'");
  const caps = ollamaProvider.capabilities!();
  assert(caps.canList && caps.canPull && caps.canDelete && caps.canLoad === false, "capabilities flags");
  // Note: Ollama doesn't support an explicit "load" — pull+warm is the equivalent.
  // canWarm is true for Ollama; canLoad is false (loadModel throws NotSupported).
  assert(caps.canWarm === true, "canWarm true for Ollama");
  assert(caps.canUnload === true, "canUnload true for Ollama");
}

// Case 4: activeModelLabel reflects config
{
  const label = await ollamaProvider.activeModelLabel();
  assert(label === "gemma3:4b", `activeModelLabel: got "${label}"`);
}

await Deno.remove(tmp);
if (failures > 0) Deno.exit(1);
console.log("\nAll ollama_provider tests passed.");
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `deno run --allow-net --allow-read --allow-write --allow-env server/llm/ollama_provider_test.ts`
Expected: FAIL — `ollama_provider.ts` doesn't exist.

- [ ] **Step 4: Write the implementation**

Write `server/llm/ollama_provider.ts`:

```ts
// Ollama provider — wraps server/ollama/client.ts and server/ollama/pulls.ts.
// Those modules are NOT modified. The NDJSON-to-ChatChunk parser lives here.

import {
  listInstalled as ollamaListInstalled,
  listLoaded as ollamaListLoaded,
  unloadModel as ollamaUnload,
  warmModel as ollamaWarm,
  deleteModel as ollamaDelete,
  pullModel as ollamaPull,
} from "../ollama/client.ts";
import { getRuntime } from "../runtime_config.ts";
import {
  type Capabilities,
  type ChatChunk,
  type ChatMessage,
  type ChatOpts,
  type LoadedEntry,
  type LoadOpts,
  type ModelEntry,
  type NonStreamResult,
  NotSupported,
  type Provider,
  type PullProgress,
  type PullSpec,
} from "./provider.ts";

const KEEP_ALIVE = Deno.env.get("OB2_OLLAMA_KEEP_ALIVE") || "24h";

interface OllamaChatChunkRaw {
  model?: string;
  message?: { role: string; content: string };
  done: boolean;
  done_reason?: string;
}

function ollamaUrl(): string {
  return getRuntime().ollama.url.replace(/\/+$/, "");
}

function model(): string {
  return getRuntime().ollama.model;
}

function bodyFor(messages: ChatMessage[], opts: ChatOpts, stream: boolean) {
  return {
    model: model(),
    messages,
    stream,
    keep_alive: KEEP_ALIVE,
    options: {
      ...(opts.temperature !== undefined && { temperature: opts.temperature }),
      ...(opts.top_p !== undefined && { top_p: opts.top_p }),
      ...(opts.max_tokens !== undefined && { num_predict: opts.max_tokens }),
    },
  };
}

async function chatNonStream(messages: ChatMessage[], opts: ChatOpts): Promise<NonStreamResult> {
  const resp = await fetch(`${ollamaUrl()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyFor(messages, opts, false)),
  });
  if (!resp.ok) {
    const msg = await resp.text().catch(() => "");
    throw new Error(`Ollama ${resp.status}: ${msg}`);
  }
  const j = await resp.json() as {
    message: { content: string };
    eval_count?: number;
    prompt_eval_count?: number;
  };
  return {
    content: j.message.content,
    prompt_tokens: j.prompt_eval_count ?? 0,
    completion_tokens: j.eval_count ?? 0,
  };
}

async function chatStream(messages: ChatMessage[], opts: ChatOpts): Promise<ReadableStream<ChatChunk>> {
  const resp = await fetch(`${ollamaUrl()}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyFor(messages, opts, true)),
  });
  if (!resp.ok || !resp.body) {
    const msg = await resp.text().catch(() => "");
    throw new Error(`Ollama ${resp.status}: ${msg}`);
  }
  return ollamaNdjsonToChunks(resp.body);
}

function ollamaNdjsonToChunks(source: ReadableStream<Uint8Array>): ReadableStream<ChatChunk> {
  const reader = source.getReader();
  const dec = new TextDecoder();
  let buf = "";
  return new ReadableStream<ChatChunk>({
    async pull(controller) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            // Flush any trailing partial line — should be empty in practice.
            if (buf.trim()) {
              try {
                const j = JSON.parse(buf) as OllamaChatChunkRaw;
                controller.enqueue(toChunk(j));
              } catch { /* ignore malformed trailing line */ }
            }
            controller.close();
            return;
          }
          buf += dec.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            const j = JSON.parse(line) as OllamaChatChunkRaw;
            controller.enqueue(toChunk(j));
            if (j.done) {
              controller.close();
              return;
            }
          }
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) { reader.cancel(reason); },
  });
}

function toChunk(j: OllamaChatChunkRaw): ChatChunk {
  return {
    content: j.message?.content ?? "",
    done: j.done,
    finish_reason: j.done ? (j.done_reason === "length" ? "length" : "stop") : undefined,
  };
}

// ─────────────────────────────────────────────────────────────
// Management surface — delegates to existing client.ts / pulls.ts
// ─────────────────────────────────────────────────────────────

const CAPS: Capabilities = {
  canList: true,
  canPull: true,
  canDelete: true,
  canLoad: false,    // Ollama loads on-demand; explicit load is not a concept
  canUnload: true,
  canWarm: true,
};

export const ollamaProvider: Provider = {
  id: "ollama",

  activeModelLabel(): Promise<string> {
    return Promise.resolve(getRuntime().ollama.model);
  },

  chatStream,
  chatNonStream,

  capabilities(): Capabilities {
    return CAPS;
  },

  async listInstalled(): Promise<ModelEntry[]> {
    const rows = await ollamaListInstalled();
    return rows.map((r) => ({
      name: r.name,
      size_bytes: r.size,
      modified_at: r.modified_at,
      details: r.details,
    }));
  },

  async listLoaded(): Promise<LoadedEntry[]> {
    const rows = await ollamaListLoaded();
    return rows.map((r) => ({
      name: r.name,
      details: { expires_at: r.expires_at, size_vram: r.size_vram },
    }));
  },

  pullModel(spec: PullSpec, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void> {
    if (spec.source !== "ollama" || !spec.name) {
      throw new Error("ollama provider only accepts {source: 'ollama', name}");
    }
    return ollamaPull(spec.name, (p) => onProgress({
      status: p.status,
      total: p.total,
      completed: p.completed,
    }), signal);
  },

  loadModel(_name: string, _opts?: LoadOpts): Promise<void> {
    throw new NotSupported("loadModel", "ollama");
  },

  unloadModel(name?: string): Promise<void> {
    if (!name) throw new Error("ollama unload requires a model name");
    return ollamaUnload(name);
  },

  warmModel(name: string): Promise<void> {
    return ollamaWarm(name);
  },

  deleteModel(name: string): Promise<void> {
    return ollamaDelete(name);
  },
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `deno run --allow-net --allow-read --allow-write --allow-env server/llm/ollama_provider_test.ts`
Expected: every assertion PASS.

- [ ] **Step 6: Commit**

```bash
git add server/llm/ollama_provider.ts server/llm/ollama_provider_test.ts
git commit -m "feat(llm): Ollama provider adapter wrapping existing client/pulls"
```

---

## Task 5: llamacpp adapter (`llamacpp_provider.ts`)

Talks directly to `llama-server`'s OpenAI-compatible `/v1/chat/completions`. Parses OpenAI SSE back into `ChatChunk`. Management methods all throw `NotImplementedInPhase1` — they get filled in by Phase 2 once the manager service exists.

**Files:**
- Create: `server/llm/llamacpp_provider.ts`
- Test: `server/llm/llamacpp_provider_test.ts`

- [ ] **Step 1: Write the failing test**

Write `server/llm/llamacpp_provider_test.ts`:

```ts
// Run with: deno run --allow-net --allow-read --allow-write --allow-env server/llm/llamacpp_provider_test.ts
import { llamacppProvider } from "./llamacpp_provider.ts";
import { initRuntime } from "../runtime_config.ts";
import { NotImplementedInPhase1 } from "./provider.ts";
import type { ChatChunk } from "./provider.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; }
  else { console.log("PASS:", msg); }
}

const realFetch = globalThis.fetch;
function mockFetch(handler: (input: string | URL, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(typeof input === "string" || input instanceof URL ? input : input.url, init))
  ) as typeof fetch;
}
function restoreFetch() { globalThis.fetch = realFetch; }

const tmp = await Deno.makeTempFile({ suffix: ".yaml" });
await Deno.writeTextFile(tmp, [
  "llamacpp:",
  "  chat_url: http://lc:8080",
  "  manager_url: http://lc:8081",
].join("\n") + "\n");
initRuntime(tmp);

// Case 1: chatNonStream — llama-server returns OpenAI-shaped JSON
{
  mockFetch((url, init) => {
    if (String(url) === "http://lc:8080/v1/chat/completions") {
      const body = JSON.parse(init?.body as string);
      assert(body.stream === false, "non-stream flag set");
      assert(body.messages.length === 1, "messages forwarded");
      return new Response(JSON.stringify({
        choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error("unexpected url " + url);
  });
  const r = await llamacppProvider.chatNonStream(
    [{ role: "user", content: "hi" }],
    {},
  );
  assert(r.content === "hi", "chatNonStream content");
  assert(r.prompt_tokens === 3, "prompt_tokens");
  assert(r.completion_tokens === 1, "completion_tokens");
  restoreFetch();
}

// Case 2: chatStream — llama-server emits OpenAI SSE; adapter parses into ChatChunk
{
  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Hi" }, finish_reason: null }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ delta: { content: "!" }, finish_reason: null }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}`,
    "",
    "data: [DONE]",
    "",
  ].join("\n");

  mockFetch((url, init) => {
    if (String(url) === "http://lc:8080/v1/chat/completions") {
      const body = JSON.parse(init?.body as string);
      assert(body.stream === true, "stream flag set");
      return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    throw new Error("unexpected url " + url);
  });

  const stream = await llamacppProvider.chatStream(
    [{ role: "user", content: "hi" }],
    {},
  );
  const reader = stream.getReader();
  const collected: ChatChunk[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    collected.push(value!);
  }
  // Role-only delta is dropped (no content). Content frames + finish frame remain.
  // Expect: 'Hi', '!', done/stop  → 3 chunks total.
  assert(collected.length === 3, `3 chunks (got ${collected.length})`);
  assert(collected[0].content === "Hi" && !collected[0].done, "chunk 1 = 'Hi'");
  assert(collected[1].content === "!" && !collected[1].done, "chunk 2 = '!'");
  assert(collected[2].done && collected[2].finish_reason === "stop", "chunk 3 = done/stop");
  restoreFetch();
}

// Case 3: id, capabilities, NotImplementedInPhase1 stubs
{
  assert(llamacppProvider.id === "llamacpp", "id is 'llamacpp'");
  const caps = llamacppProvider.capabilities!();
  assert(caps.canList && caps.canPull && caps.canDelete && caps.canLoad && caps.canUnload, "all manage caps true");
  assert(caps.canWarm === false, "canWarm false");

  let threw = false;
  try { await llamacppProvider.listInstalled!(); } catch (e) { threw = e instanceof NotImplementedInPhase1; }
  assert(threw, "listInstalled throws NotImplementedInPhase1");

  threw = false;
  try { await llamacppProvider.loadModel!("foo.gguf"); } catch (e) { threw = e instanceof NotImplementedInPhase1; }
  assert(threw, "loadModel throws NotImplementedInPhase1");
}

// Case 4: activeModelLabel — Phase 1 has no manager, so returns a placeholder
{
  const label = await llamacppProvider.activeModelLabel();
  assert(label === "(llamacpp; manager unreachable in Phase 1)", `label fallback: "${label}"`);
}

await Deno.remove(tmp);
if (failures > 0) Deno.exit(1);
console.log("\nAll llamacpp_provider tests passed.");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno run --allow-net --allow-read --allow-write --allow-env server/llm/llamacpp_provider_test.ts`
Expected: FAIL — `llamacpp_provider.ts` doesn't exist.

- [ ] **Step 3: Write the implementation**

Write `server/llm/llamacpp_provider.ts`:

```ts
// llamacpp provider — chat data plane goes directly to llama-server's
// OpenAI-compatible /v1/chat/completions. Management calls would go to the
// manager service, but in Phase 1 the manager doesn't exist yet — so every
// management method throws NotImplementedInPhase1.

import { getRuntime } from "../runtime_config.ts";
import {
  type Capabilities,
  type ChatChunk,
  type ChatMessage,
  type ChatOpts,
  type LoadedEntry,
  type LoadOpts,
  type ModelEntry,
  type NonStreamResult,
  NotImplementedInPhase1,
  type Provider,
  type PullProgress,
  type PullSpec,
} from "./provider.ts";

function chatUrl(): string {
  return getRuntime().llamacpp.chat_url.replace(/\/+$/, "");
}

function bodyFor(messages: ChatMessage[], opts: ChatOpts, stream: boolean) {
  return {
    messages,
    stream,
    ...(opts.temperature !== undefined && { temperature: opts.temperature }),
    ...(opts.top_p !== undefined && { top_p: opts.top_p }),
    ...(opts.max_tokens !== undefined && { max_tokens: opts.max_tokens }),
  };
}

async function chatNonStream(messages: ChatMessage[], opts: ChatOpts): Promise<NonStreamResult> {
  const resp = await fetch(`${chatUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bodyFor(messages, opts, false)),
  });
  if (!resp.ok) {
    const msg = await resp.text().catch(() => "");
    throw new Error(`llama-server ${resp.status}: ${msg}`);
  }
  const j = await resp.json() as {
    choices: Array<{ message: { content: string }; finish_reason: string }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  return {
    content: j.choices?.[0]?.message?.content ?? "",
    prompt_tokens: j.usage?.prompt_tokens ?? 0,
    completion_tokens: j.usage?.completion_tokens ?? 0,
  };
}

async function chatStream(messages: ChatMessage[], opts: ChatOpts): Promise<ReadableStream<ChatChunk>> {
  const resp = await fetch(`${chatUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "text/event-stream" },
    body: JSON.stringify(bodyFor(messages, opts, true)),
  });
  if (!resp.ok || !resp.body) {
    const msg = await resp.text().catch(() => "");
    throw new Error(`llama-server ${resp.status}: ${msg}`);
  }
  return openAiSseToChunks(resp.body);
}

function openAiSseToChunks(source: ReadableStream<Uint8Array>): ReadableStream<ChatChunk> {
  const reader = source.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let closed = false;

  return new ReadableStream<ChatChunk>({
    async pull(controller) {
      if (closed) {
        controller.close();
        return;
      }
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            closed = true;
            controller.close();
            return;
          }
          buf += dec.decode(value, { stream: true });

          // SSE frames are separated by blank lines (`\n\n`).
          let sep: number;
          while ((sep = buf.indexOf("\n\n")) !== -1) {
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            // Each frame may have multiple `data:` lines; concat them per spec.
            const dataLines = frame.split("\n").filter((l) => l.startsWith("data:"));
            if (dataLines.length === 0) continue;
            const payload = dataLines.map((l) => l.slice(5).trim()).join("\n");
            if (payload === "[DONE]") {
              closed = true;
              controller.close();
              return;
            }
            let parsed: { choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }> };
            try { parsed = JSON.parse(payload); } catch { continue; }
            const choice = parsed.choices?.[0];
            if (!choice) continue;
            const content = choice.delta?.content ?? "";
            const finish = choice.finish_reason;
            if (finish) {
              if (content) controller.enqueue({ content, done: false });
              controller.enqueue({
                content: "",
                done: true,
                finish_reason: finish === "length" ? "length" : "stop",
              });
              closed = true;
              controller.close();
              return;
            }
            // Suppress role-only deltas (no content, no finish).
            if (content) controller.enqueue({ content, done: false });
          }
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) { reader.cancel(reason); },
  });
}

const CAPS: Capabilities = {
  canList: true,
  canPull: true,
  canDelete: true,
  canLoad: true,
  canUnload: true,
  canWarm: false,
};

export const llamacppProvider: Provider = {
  id: "llamacpp",

  activeModelLabel(): Promise<string> {
    // Phase 2 will hit the manager's /healthz to read the loaded model name.
    return Promise.resolve("(llamacpp; manager unreachable in Phase 1)");
  },

  chatStream,
  chatNonStream,

  capabilities(): Capabilities { return CAPS; },

  listInstalled(): Promise<ModelEntry[]> { throw new NotImplementedInPhase1("listInstalled"); },
  listLoaded():    Promise<LoadedEntry[]> { throw new NotImplementedInPhase1("listLoaded"); },
  pullModel(_s: PullSpec, _p: (p: PullProgress) => void): Promise<void> {
    throw new NotImplementedInPhase1("pullModel");
  },
  loadModel(_n: string, _o?: LoadOpts): Promise<void> { throw new NotImplementedInPhase1("loadModel"); },
  unloadModel(_n?: string): Promise<void> { throw new NotImplementedInPhase1("unloadModel"); },
  warmModel(_n: string): Promise<void> { throw new NotImplementedInPhase1("warmModel"); },
  deleteModel(_n: string): Promise<void> { throw new NotImplementedInPhase1("deleteModel"); },
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno run --allow-net --allow-read --allow-write --allow-env server/llm/llamacpp_provider_test.ts`
Expected: every assertion PASS.

- [ ] **Step 5: Commit**

```bash
git add server/llm/llamacpp_provider.ts server/llm/llamacpp_provider_test.ts
git commit -m "feat(llm): llamacpp adapter (chat path; management stubs for phase 2)"
```

---

## Task 6: Wire the factory in `provider.ts`

Replaces the throwing stubs from Task 2 with real dispatch on `runtime_config.llm.provider`.

**Files:**
- Modify: `server/llm/provider.ts`
- Test: `server/llm/provider_test.ts`

- [ ] **Step 1: Write the failing test**

Write `server/llm/provider_test.ts`:

```ts
// Run with: deno run --allow-read --allow-write --allow-env server/llm/provider_test.ts
import { getProvider, getClassifierProvider } from "./provider.ts";
import { initRuntime } from "../runtime_config.ts";

let failures = 0;
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error("FAIL:", msg); failures++; }
  else { console.log("PASS:", msg); }
}

const tmp = await Deno.makeTempFile({ suffix: ".yaml" });

// Default → ollama
await Deno.writeTextFile(tmp, "ollama:\n  url: http://x:11434\n");
initRuntime(tmp);
assert(getProvider().id === "ollama", "default provider is ollama");
assert(getClassifierProvider().id === "ollama", "classifier provider defaults to ollama (same as main)");

// Switch main → llamacpp
await Deno.writeTextFile(tmp, "llm:\n  provider: llamacpp\n");
initRuntime(tmp);
assert(getProvider().id === "llamacpp", "switched provider is llamacpp");
assert(getClassifierProvider().id === "llamacpp", "classifier follows main provider when classifier_provider is empty");

// Cross-provider classifier
await Deno.writeTextFile(tmp, "llm:\n  provider: llamacpp\n  classifier_provider: ollama\n");
initRuntime(tmp);
assert(getProvider().id === "llamacpp", "main provider still llamacpp");
assert(getClassifierProvider().id === "ollama", "classifier_provider override honored");

await Deno.remove(tmp);
if (failures > 0) Deno.exit(1);
console.log("\nAll provider factory tests passed.");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `deno run --allow-read --allow-write --allow-env server/llm/provider_test.ts`
Expected: FAIL — factory throws "factory not wired".

- [ ] **Step 3: Wire the factory**

Two edits to `server/llm/provider.ts`:

**(a) Add three imports at the very top of the file** (above the first `// Shared types` divider):

```ts
import { getRuntime } from "../runtime_config.ts";
import { ollamaProvider } from "./ollama_provider.ts";
import { llamacppProvider } from "./llamacpp_provider.ts";
```

ES module imports must live at the top of the file — do not place them under the `// Factory` divider.

**(b) At the bottom of the file, replace the two stub function bodies** that currently `throw new Error("...factory not wired...")` with real dispatch:

```ts
export function getProvider(): Provider {
  return getRuntime().llm.provider === "llamacpp" ? llamacppProvider : ollamaProvider;
}

export function getClassifierProvider(): Provider {
  const cp = getRuntime().llm.classifier_provider;
  const id = cp === "" ? getRuntime().llm.provider : cp;
  return id === "llamacpp" ? llamacppProvider : ollamaProvider;
}
```

The `// ─── Factory ───` divider above these functions stays as-is.

- [ ] **Step 4: Run the test to verify it passes**

Run: `deno run --allow-read --allow-write --allow-env server/llm/provider_test.ts`
Expected: every assertion PASS.

- [ ] **Step 5: Run all llm/* tests to confirm nothing regressed**

Run:
```bash
deno run server/llm/openai_sse_test.ts && \
deno run --allow-net --allow-read --allow-write --allow-env server/llm/ollama_provider_test.ts && \
deno run --allow-net --allow-read --allow-write --allow-env server/llm/llamacpp_provider_test.ts && \
deno run --allow-read --allow-write --allow-env server/llm/provider_test.ts
```
Expected: all four suites green.

- [ ] **Step 6: Commit**

```bash
git add server/llm/provider.ts server/llm/provider_test.ts
git commit -m "feat(llm): wire getProvider/getClassifierProvider factory"
```

---

## Task 7: Refactor `gateway.ts` to use the provider abstraction

Replace local `callOllamaStream`, `callOllamaNonStream`, and `ollamaToOpenAiSSE` with `getProvider().chatStream/.chatNonStream` and `chatChunkStreamToOpenAiSSE`. Net deletion ~80 lines.

**Files:**
- Modify: `server/routes/gateway.ts`

- [ ] **Step 1: Read the current gateway.ts to identify exact deletion boundaries**

Run: `grep -n "callOllamaStream\|callOllamaNonStream\|ollamaToOpenAiSSE\|interface OllamaChatChunk\|OLLAMA_KEEP_ALIVE\|nowId" server/routes/gateway.ts`
Expected: matches at known lines (around 231, 239, 248, 250, 281, 362; and route handlers around 545, 547, 563).

- [ ] **Step 2: Update imports at the top of `gateway.ts`**

In `server/routes/gateway.ts`, find the existing import block (around lines 14–20). Add these imports:

```ts
import { getProvider } from "../llm/provider.ts";
import { chatChunkStreamToOpenAiSSE } from "../llm/openai_sse.ts";
```

Remove the local `ChatMessage` interface (around line 28-31) — import it from provider.ts instead. Add to one of the imports:

```ts
import type { ChatMessage } from "../llm/provider.ts";
```

- [ ] **Step 3: Delete the Ollama-specific helpers**

In `server/routes/gateway.ts`, delete the entire region from the `// ─── Ollama bridging ───` divider through `callOllamaNonStream`. Specifically, delete:

- The `interface OllamaChatChunk` (around line 231)
- The `function nowId()` (around line 239)
- The `OLLAMA_KEEP_ALIVE` const (around line 248)
- The `async function callOllamaStream(...)` (around lines 250–276)
- The `function ollamaToOpenAiSSE(...)` (around lines 281–360)
- The `async function callOllamaNonStream(...)` (around lines 362–397)

Net deletion: ~170 lines (the divider comment block too). Keep the divider for the new section.

- [ ] **Step 4: Replace the route-handler call sites**

In `server/routes/gateway.ts`, find the streaming branch in the `/chat/completions` handler (around line 545):

```ts
    // Forward to Ollama
    if (stream) {
      try {
        const ollamaStream = await callOllamaStream(config, messagesForModel, req);
        const openAiStream = ollamaToOpenAiSSE(modelId, ollamaStream);
        return new Response(openAiStream, {
```

Replace those three lines with:

```ts
    // Forward to the active LLM provider.
    if (stream) {
      try {
        const chunkStream = await getProvider().chatStream(messagesForModel, {
          temperature: req.temperature,
          top_p: req.top_p,
          max_tokens: req.max_tokens,
        });
        const openAiStream = chatChunkStreamToOpenAiSSE(modelId, chunkStream);
        return new Response(openAiStream, {
```

Then find the non-stream branch (around line 562):

```ts
    } else {
      try {
        const r = await callOllamaNonStream(config, messagesForModel, req);
        const id = nowId();
        const created = Math.floor(Date.now() / 1000);
        return c.json({
          id,
          object: "chat.completion",
          created,
          model: modelId,
          choices: [{
            index: 0,
            message: { role: "assistant", content: r.content },
            finish_reason: "stop",
          }],
          usage: {
            prompt_tokens: r.prompt_eval_count ?? 0,
            completion_tokens: r.eval_count ?? 0,
            total_tokens: (r.prompt_eval_count ?? 0) + (r.eval_count ?? 0),
          },
        });
```

Replace with:

```ts
    } else {
      try {
        const r = await getProvider().chatNonStream(messagesForModel, {
          temperature: req.temperature,
          top_p: req.top_p,
          max_tokens: req.max_tokens,
        });
        const id = `chatcmpl-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
        const created = Math.floor(Date.now() / 1000);
        return c.json({
          id,
          object: "chat.completion",
          created,
          model: modelId,
          choices: [{
            index: 0,
            message: { role: "assistant", content: r.content },
            finish_reason: "stop",
          }],
          usage: {
            prompt_tokens: r.prompt_tokens,
            completion_tokens: r.completion_tokens,
            total_tokens: r.prompt_tokens + r.completion_tokens,
          },
        });
```

- [ ] **Step 5: Type-check the file**

Run: `deno check server/routes/gateway.ts`
Expected: no errors. If `Config` or `Sidecar` imports complain about being unused after the deletion, remove them from the import block.

- [ ] **Step 6: Run the full test suite to confirm Ollama path is preserved**

Existing chat path validation lives in `tests/e2e.sh`. Run the smoke test that exercises the gateway against a live Ollama:

```bash
bash tests/e2e.sh
```

Expected: every existing pass still PASSES. The new llamacpp pass arrives in Task 10 — for now this is regression confirmation only. If you don't have a live Ollama available, run the unit tests instead and rely on Task 10 for end-to-end coverage:

```bash
deno run server/llm/openai_sse_test.ts && \
deno run --allow-net --allow-read --allow-write --allow-env server/llm/ollama_provider_test.ts
```

- [ ] **Step 7: Commit**

```bash
git add server/routes/gateway.ts
git commit -m "refactor(gateway): route chat through the LLM provider abstraction"
```

---

## Task 8: Refactor `classifier.ts` to use the classifier provider

**Files:**
- Modify: `server/routes/classifier.ts`

The classifier today builds a single non-stream chat request to Ollama. Swap it for `getClassifierProvider().chatNonStream(...)`. The cross-provider semantics (Ollama-only `classifier_model` field) are preserved because `chatNonStream` reads its model from the active provider's config.

- [ ] **Step 1: Read the current classifier call site**

Run: `sed -n '85,125p' server/routes/classifier.ts`
Expected: see the `try { const model = ... const resp = await fetch(...) ... }` block.

- [ ] **Step 2: Update imports**

In `server/routes/classifier.ts`, add to the import block at the top:

```ts
import { getClassifierProvider } from "../llm/provider.ts";
```

- [ ] **Step 3: Replace the fetch with the provider call**

In `server/routes/classifier.ts`, locate the `try {` block starting around line 90 and ending where `data.message.content` is read (around line 106). Replace this:

```ts
  try {
    const model = rt.ollama.classifier_model || rt.ollama.model;
    const resp = await fetch(`${rt.ollama.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: classifierPrompt }],
        stream: false,
        keep_alive: Deno.env.get("OB2_OLLAMA_KEEP_ALIVE") || "24h",
        options: { temperature: 0, num_predict: 60 },
      }),
    });
    if (!resp.ok) return null;

    const data = await resp.json() as { message: { content: string } };
    const text = data.message.content.trim();
```

With:

```ts
  try {
    let text: string;
    try {
      const r = await getClassifierProvider().chatNonStream(
        [{ role: "user", content: classifierPrompt }],
        { temperature: 0, max_tokens: 60 },
      );
      text = r.content.trim();
    } catch {
      return null;
    }
```

The rest of the function (the regex parse, domain validation) is untouched.

- [ ] **Step 4: Type-check**

Run: `deno check server/routes/classifier.ts`
Expected: no errors. If `rt` or `Deno.env.get("OB2_OLLAMA_KEEP_ALIVE")` was the last reference to `rt` / `Deno`, the linter may flag unused — leave the broader `rt` reference alone since `rt.ollama.auto_route` is still consulted at the top of the function.

- [ ] **Step 5: Verify against an Ollama instance** (skip if not available)

Run: `bash tests/e2e.sh` and confirm the auto-routing tests still pass. The classifier's behavior is unchanged when `provider == "ollama"` and `classifier_provider == ""` — both default and the old call site is functionally equivalent.

- [ ] **Step 6: Commit**

```bash
git add server/routes/classifier.ts
git commit -m "refactor(classifier): route through getClassifierProvider"
```

---

## Task 9: Refactor `mcp.ts` `chat_knowledge` tool to use the provider

**Files:**
- Modify: `server/routes/mcp.ts`

The MCP tool `chat_knowledge` runs a non-stream chat using the active provider. Same change pattern as the classifier.

- [ ] **Step 1: Read the current call site**

Run: `sed -n '370,420p' server/routes/mcp.ts`
Expected: see the `const ollamaResp = await fetch(...)` block inside the `chat_knowledge` tool handler.

- [ ] **Step 2: Update imports**

In `server/routes/mcp.ts`, add to the import block at the top:

```ts
import { getProvider } from "../llm/provider.ts";
```

- [ ] **Step 3: Replace the fetch with the provider call**

In `server/routes/mcp.ts`, locate the chat block in the `chat_knowledge` tool (lines 385–401 from the grep above). Replace:

```ts
        const ollamaResp = await fetch(`${config.ollamaUrl}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: config.ollamaModel,
            messages,
            stream: false,
            keep_alive: Deno.env.get("OB2_OLLAMA_KEEP_ALIVE") || "24h",
          }),
        });
        if (!ollamaResp.ok) {
          const msg = await ollamaResp.text().catch(() => "");
          throw new Error(`Ollama ${ollamaResp.status}: ${msg}`);
        }
        const ollamaData = await ollamaResp.json() as {
          message: { content: string };
        };
```

With:

```ts
        const r = await getProvider().chatNonStream(messages, {});
```

Then update the response builder (around line 413) to read from `r.content` instead of `ollamaData.message.content`:

```ts
            text: r.content +
              (sourceList ? `\n\nSources:\n${sourceList}` : ""),
```

- [ ] **Step 4: Type-check**

Run: `deno check server/routes/mcp.ts`
Expected: no errors.

- [ ] **Step 5: Verify** (skip if Ollama not available)

Run the MCP smoke test:

```bash
python3 tests/mcp_runner.py chat_knowledge
```

Expected: returns a non-empty response. If the runner has different invocation conventions, defer to `tests/e2e.sh` which exercises this path.

- [ ] **Step 6: Commit**

```bash
git add server/routes/mcp.ts
git commit -m "refactor(mcp): route chat_knowledge through provider abstraction"
```

---

## Task 10: End-to-end smoke test for the llamacpp provider

This validates the entire chat path from `POST /v1/chat/completions` on the gateway, through `getProvider()`, through `LlamacppProvider.chatStream`, into a fake llama-server, and back out as OpenAI SSE.

**Files:**
- Create: `tests/fixtures/fake-llama-server.ts`
- Modify: `tests/e2e.sh`

- [ ] **Step 1: Create the fake llama-server fixture**

Write `tests/fixtures/fake-llama-server.ts`:

```ts
// Tiny stand-in for llama-server's /v1/chat/completions used by tests/e2e.sh.
// Speaks just enough OpenAI to validate the chat path.
//
// Usage:
//   deno run --allow-net tests/fixtures/fake-llama-server.ts --port 18080

const port = (() => {
  const i = Deno.args.indexOf("--port");
  return i >= 0 ? Number(Deno.args[i + 1]) : 18080;
})();

const enc = new TextEncoder();

Deno.serve({ port }, (req) => {
  const url = new URL(req.url);
  if (req.method === "GET" && url.pathname === "/health") {
    return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
  }
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    const stream = new ReadableStream({
      async start(controller) {
        const frames = [
          { choices: [{ delta: { role: "assistant" }, finish_reason: null }] },
          { choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
          { choices: [{ delta: { content: " from fake llama" }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ];
        for (const f of frames) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
          await new Promise((r) => setTimeout(r, 5));
        }
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  }
  return new Response("not found", { status: 404 });
});
```

- [ ] **Step 2: Add the `verify_llamacpp_provider` function to `tests/e2e.sh`**

In `tests/e2e.sh`, find a spot near the existing `verify_*` test functions (look for `verify_chat_passthrough` or similar with `grep -n '^verify_' tests/e2e.sh`). Add a new function:

```bash
verify_llamacpp_provider() {
  local server_pid fake_pid
  echo "  Starting fake llama-server on :18080..."
  "$DENO" run --allow-net "$PROJECT_DIR/tests/fixtures/fake-llama-server.ts" --port 18080 >/tmp/fake-llama.log 2>&1 &
  fake_pid=$!

  # Wait for fake server health
  for _ in $(seq 1 20); do
    if curl -fsS http://localhost:18080/health >/dev/null 2>&1; then break; fi
    sleep 0.2
  done

  echo "  Starting OB2 server with OB2_LLM_PROVIDER=llamacpp..."
  (
    cd "$SERVER_DIR"
    OB2_LLM_PROVIDER=llamacpp \
    OB2_LLAMACPP_CHAT_URL=http://localhost:18080 \
    OB2_LLAMACPP_MANAGER_URL=http://localhost:18081 \
    "$DENO" run --allow-all index.ts >/tmp/ob2-llamacpp.log 2>&1 &
    echo $! >/tmp/ob2-llamacpp.pid
  )
  sleep 3
  server_pid=$(cat /tmp/ob2-llamacpp.pid)

  # Stream a chat request through the gateway.
  local resp
  resp=$(curl -fsS -N -H "Authorization: Bearer $OB2_BRAIN_KEY" \
    -H "Content-Type: application/json" \
    -d '{"model":"ob2","messages":[{"role":"user","content":"hi"}],"stream":true}' \
    http://localhost:7600/v1/chat/completions || true)

  kill "$server_pid" 2>/dev/null || true
  kill "$fake_pid" 2>/dev/null || true
  wait 2>/dev/null

  TESTS=$((TESTS + 1))
  if echo "$resp" | grep -q '"content":"Hello"' && echo "$resp" | grep -q '\[DONE\]'; then
    echo "  PASS: llamacpp provider streams chat through gateway"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: llamacpp provider chat path"
    echo "      response head: $(echo "$resp" | head -c 200)"
    FAIL=$((FAIL + 1))
  fi
}
```

Then add a call to it in the test orchestration block — same pattern the existing `verify_*` functions use. Find where the other tests are invoked sequentially (often at the bottom of the file under a `# Run tests` comment) and add:

```bash
echo
echo "── Provider abstraction (llamacpp) ──"
verify_llamacpp_provider
```

- [ ] **Step 3: Run the new pass**

Run: `bash tests/e2e.sh`
Expected: all existing tests pass, AND the new llamacpp pass shows `PASS: llamacpp provider streams chat through gateway`. The full suite reports a single new test added to `TESTS`.

If the OB2 server fails to start under `OB2_LLM_PROVIDER=llamacpp`, check `/tmp/ob2-llamacpp.log` — common cause is a missing required env var or a port collision. The fake server logs are at `/tmp/fake-llama.log`.

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/fake-llama-server.ts tests/e2e.sh
git commit -m "test(e2e): smoke test for llamacpp provider chat path"
```

---

## Final Verification

- [ ] **Step 1: Run every unit test in `server/llm/`**

```bash
deno run --allow-read --allow-write --allow-env server/runtime_config_test.ts && \
deno run server/llm/openai_sse_test.ts && \
deno run --allow-net --allow-read --allow-write --allow-env server/llm/ollama_provider_test.ts && \
deno run --allow-net --allow-read --allow-write --allow-env server/llm/llamacpp_provider_test.ts && \
deno run --allow-read --allow-write --allow-env server/llm/provider_test.ts
```
Expected: every suite green.

- [ ] **Step 2: Run the e2e suite**

```bash
bash tests/e2e.sh
```
Expected: all existing tests pass; new llamacpp pass passes; final summary shows zero failures.

- [ ] **Step 3: Manual smoke against a real llama-server**

Pick one of:

  a. **Upstream llama.cpp server image:**
     ```bash
     docker run --rm -d --name llamacpp-smoke -p 18080:8080 \
       -v $HOME/models:/models \
       ghcr.io/ggml-org/llama.cpp:server-cuda \
       -m /models/<your-gguf>.gguf --host 0.0.0.0 --port 8080
     ```

  b. **Prebuilt turboquant_plus on the host (Windows/Mac):**
     Unzip the release; run `llama-server -m <gguf> --host 0.0.0.0 --port 18080`.

Then:
```bash
export OB2_LLM_PROVIDER=llamacpp
export OB2_LLAMACPP_CHAT_URL=http://localhost:18080
# (or http://host.docker.internal:18080 if OB2 server runs in Docker)
# Restart OB2 server.
curl -N -H "Authorization: Bearer $OB2_BRAIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"ob2","messages":[{"role":"user","content":"hello"}],"stream":true}' \
  http://localhost:7600/v1/chat/completions
```

Expected: a streaming OpenAI SSE response with non-empty `content` deltas and a `[DONE]` terminator. Retrieval still happens — if you have a domain configured and use `@<domain>` in the prompt, you'll get grounded output with citations exactly as you would on Ollama.

- [ ] **Step 4: Commit any clean-up**

If any leftover unused imports were flagged by `deno check`, remove them and commit. Otherwise this step is a no-op.

---

## Phase 1 Done — End-of-Phase Capability

After Phase 1 lands:

- An admin can flip `OB2_LLM_PROVIDER=llamacpp` and point `OB2_LLAMACPP_CHAT_URL` at any externally-running `llama-server` (host binary, upstream Docker image, or anything that speaks OpenAI `/v1/chat/completions`). Chat works end-to-end with retrieval and citations.
- All existing Ollama deployments are unaffected — they continue to default to `OB2_LLM_PROVIDER=ollama` and the wire path is unchanged.
- Cross-provider classifier (`classifier_provider=ollama` while `provider=llamacpp`) works.
- The Models tab in the dashboard still shows Ollama-only management — calling Ollama-style endpoints under `llamacpp` will fail (admin.ts is intentionally not refactored in Phase 1).

The next plan (`docs/superpowers/plans/<later-date>-llamacpp-phase2-manager-and-docker.md`) builds the manager service, the `Dockerfile.llamacpp`, the compose stack rename, and the host-mode binary distribution. It will be written against the actual code Phase 1 produces, not speculation.
