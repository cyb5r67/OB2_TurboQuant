# llama.cpp / turboquant_plus LLM Provider — Design

**Status:** Design.
**Date:** 2026-04-30

## Problem

OB2 generates chat completions through a single LLM backend: Ollama. The chat path (`server/routes/gateway.ts`), the query classifier (`server/routes/classifier.ts`), and the Models tab in the dashboard are all written directly against Ollama-specific HTTP APIs (`/api/chat`, `/api/tags`, `/api/ps`, `/api/pull`, `/api/generate?keep_alive=0`).

Operators who already have a `llama.cpp`-based stack — specifically the prebuilt `turboquant_plus` binaries on Windows-x64 (CUDA 12.4) and macOS-arm64 (Metal) — have no way to plug it in. `llama.cpp`'s `llama-server` speaks an OpenAI-compatible API, not Ollama's, and has fundamentally different operational semantics: it loads exactly one GGUF file at startup and switches models by restarting with a different `-m` flag. There's no registry, no list of "installed" models, no warm/unload concept.

Naively swapping the URL doesn't work, and adding `if (provider === "llamacpp")` branches at six call sites would create an unmaintainable mess.

## Goal

Add `llama-server` as a first-class, selectable LLM provider that lives **alongside** Ollama. Two deployment shapes are supported with the same control plane:

1. **Containerized (Linux+CUDA)** — a new `ob2-llamacpp` Docker service built from upstream `llama.cpp` source, behind a `--with-llamacpp` profile flag.
2. **Host-mode (Windows-x64 / macOS-arm64)** — operator unzips the `turboquant_plus` prebuilt release, drops in a single OB2-shipped manager binary, and OB2 (still in Docker) reaches it via `host.docker.internal` — the same mechanism the existing Ollama integration uses.

The provider switch is a runtime config field. Switching providers requires no restart of the OB2 server. Existing Ollama deployments are unaffected and observe zero behavior change.

## Non-goals

- **Replacing Ollama.** Ollama remains the default and a fully supported provider.
- **Multi-model loading inside a single `llama-server`.** One model loaded at a time. Spawning multiple `llama-server` processes on different ports is a v2 feature.
- **GPU/runtime detection magic.** Operators are responsible for ensuring Docker Desktop has NVIDIA GPU passthrough enabled, or for installing the correct CUDA/Metal runtime alongside the host binaries. We document the requirement; we do not detect or remediate it.
- **Linux host-mode** (running `llama-server` on a Linux host alongside Dockerized OB2). On Linux you'd use the containerized mode. We *do* compile a Linux build of the manager binary, but only because the container needs it.
- **Wine/CrossOver workarounds** for running the Windows binaries inside a Linux container. Container mode builds llama.cpp from source for Linux+CUDA.
- **Spawning models via Docker socket from inside OB2 server.** Process supervision lives in a dedicated manager service.
- **Preserving in-flight chat requests across model swaps.** A model swap kills the current `llama-server`. Open requests fail; the Open WebUI user retries.

## Architecture

### Component layout

```
OB2_TurboQuant/
├── server/
│   └── llm/                              ← NEW
│       ├── provider.ts                   Interface, factory, capability flags
│       ├── ollama_provider.ts            Wraps existing server/ollama/* — facade only
│       ├── llamacpp_provider.ts          Talks to manager (control) + llama-server (data)
│       └── openai_sse.ts                 Shared OpenAI-SSE chunk encoder
├── llamacpp-manager/                     ← NEW (Deno service, ~400 LOC)
│   ├── main.ts                           HTTP server, supervisor logic
│   ├── process.ts                        Spawn/kill/health-check llama-server
│   ├── models.ts                         Scan dir, parse GGUF headers, pull, delete
│   └── deno.json
├── docker/
│   ├── Dockerfile.llamacpp               ← NEW
│   └── docker-compose.yml                add `ob2-llamacpp` under `llamacpp` profile
├── scripts/
│   └── docker-start.sh                   add --with-llamacpp flag (mirrors --with-chat)
└── docs/
    ├── llamacpp-host-setup.md            ← NEW (Windows/Mac quick start)
    └── llamacpp-version-bump.md          ← NEW (runbook for bumping LLAMA_CPP_REF)
```

### Process boundaries

| Component | Lives in | Owns |
|---|---|---|
| OB2 server | OB2 container | Provider abstraction; routing chat to active provider; auth; retrieval |
| `ob2-llamacpp-manager` | `ob2-llamacpp` container OR Windows/Mac host | Lifecycle of `llama-server`; models dir; HF/URL pulls; control-plane HTTP |
| `llama-server` | `ob2-llamacpp` container OR Windows/Mac host | Data plane only — `/v1/chat/completions` direct to OB2 |

Communication channels:

- OB2 server → manager: HTTP (control plane: load, unload, list, pull, delete).
- OB2 server → `llama-server`: HTTP (data plane: chat completions, OpenAI-compatible).
- Manager → `llama-server`: parent-child OS process; manager never proxies the data plane.

The manager is one binary, compiled from one Deno source tree, used in both deployment shapes. CI emits three artifacts per release: `ob2-llamacpp-manager-linux-x64`, `ob2-llamacpp-manager-windows-x64.zip`, `ob2-llamacpp-manager-macos-arm64.tar.gz`. The Linux build is `COPY`'d into the Docker image.

### Provider abstraction

Two surfaces. Most call sites only need the chat surface; management methods are optional and gated by a capability map so the dashboard can grey out unsupported actions instead of hitting endpoints that 501.

```ts
// server/llm/provider.ts
export interface ChatOpts { temperature?: number; top_p?: number; max_tokens?: number; }
export interface ChatChunk { content: string; done: boolean; finish_reason?: "stop"|"length"; }
export interface NonStreamResult { content: string; prompt_tokens: number; completion_tokens: number; }

export interface ChatProvider {
  readonly id: "ollama" | "llamacpp";
  activeModelLabel(): Promise<string>;
  chatStream(messages: ChatMessage[], opts: ChatOpts): Promise<ReadableStream<ChatChunk>>;
  chatNonStream(messages: ChatMessage[], opts: ChatOpts): Promise<NonStreamResult>;
}

export interface ManagementProvider {
  capabilities(): {
    canList: boolean; canPull: boolean; canDelete: boolean;
    canLoad: boolean; canUnload: boolean; canWarm: boolean;
  };
  listInstalled(): Promise<ModelEntry[]>;
  listLoaded():    Promise<LoadedEntry[]>;
  pullModel(spec: PullSpec, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void>;
  loadModel(name: string, opts?: LoadOpts): Promise<void>;     // llamacpp only
  unloadModel(name?: string): Promise<void>;                    // ollama: by-name; llamacpp: ignores name
  warmModel(name: string): Promise<void>;                       // ollama only — llamacpp throws NotSupported
  deleteModel(name: string): Promise<void>;
}

export type Provider = ChatProvider & Partial<ManagementProvider>;

export function getProvider(): Provider;
export function getClassifierProvider(): Provider;
```

Adapters:

- **`ollama_provider.ts`** — thin facade over existing `server/ollama/client.ts` and `pulls.ts`. Capability flags all `true`. Ollama-NDJSON-to-`ChatChunk` translation moves here from `gateway.ts`.
- **`llamacpp_provider.ts`** — chat goes to `${cfg.chat_url}/v1/chat/completions` (llama-server already speaks OpenAI SSE; adapter parses `data: ` frames back into `ChatChunk`). Management goes to `${cfg.manager_url}/v1/...`. Capabilities: `canList=true, canPull=true, canLoad=true, canUnload=true, canDelete=true, canWarm=false`.

The factory closes over `getRuntime()` so a config edit takes effect on the next request — same hot-reload pattern Ollama already follows.

### Call-site changes

| File | Change |
|---|---|
| `server/routes/gateway.ts` | Replace `callOllamaStream` / `callOllamaNonStream` with `getProvider().chatStream/.chatNonStream`. OpenAI-SSE encoder lifted to `server/llm/openai_sse.ts`. Net: ~80 lines removed. |
| `server/routes/classifier.ts` | Use `getClassifierProvider().chatNonStream(...)`. |
| `server/routes/admin.ts` | Route through `getProvider()`; check `capabilities()` before exposing actions. New routes: `GET /admin/llm/capabilities`, `POST /admin/llm/load`, `POST /admin/llm/unload`, `POST /admin/llm/restart`, plus existing pull/delete now provider-aware. |
| `server/routes/config_api.ts` | Add `llm.*` and `llamacpp.*` to the editable surface. `ollama.*` unchanged. |
| `server/routes/mcp.ts` | Ollama → provider swap. |
| `server/ollama/client.ts`, `server/ollama/pulls.ts` | **Untouched.** `ollama_provider.ts` imports them. Keeps the Ollama wire path bit-for-bit identical. |

### Runtime config schema

New `llm:` and `llamacpp:` sections. Existing `ollama:` section unchanged.

```yaml
llm:
  provider: ollama          # "ollama" | "llamacpp"
  classifier_provider: ""   # "" → same as provider; "ollama" or "llamacpp" forces

ollama:                     # unchanged
  url: http://localhost:11434
  model: gemma3:4b
  classifier_model: ""
  auto_route: false

llamacpp:
  manager_url: http://localhost:8081     # control plane
  chat_url:    http://localhost:8080     # data plane (llama-server)
  models_dir:  /data/llamacpp/models     # path INSIDE the manager process
  default_model: ""                       # filename only; empty = no auto-load
  ctx_size: 8192
  gpu_layers: -1                          # -1 = all layers to GPU; 0 = CPU only
  parallel_slots: 1
  extra_args: []                          # advanced llama-server flags
```

`llamacpp.model` is deliberately absent. With Ollama, the active model is config (Ollama loads on demand by name). With `llama-server` the active model is **runtime state** — whatever the manager has loaded right now. The manager persists this state to `<models_dir>/.last_loaded.json`; on manager startup it restores from that file (or from `default_model` if the file doesn't exist). Dashboard "Load" actions update the file. This means UI selections survive `docker compose restart`.

Env overrides added to `ENV_KEYS`:

```
OB2_LLM_PROVIDER, OB2_LLM_CLASSIFIER_PROVIDER
OB2_LLAMACPP_MANAGER_URL, OB2_LLAMACPP_CHAT_URL
OB2_LLAMACPP_MODELS_DIR, OB2_LLAMACPP_DEFAULT_MODEL
OB2_LLAMACPP_CTX_SIZE, OB2_LLAMACPP_GPU_LAYERS, OB2_LLAMACPP_PARALLEL_SLOTS
OB2_LLAMACPP_MANAGER_TOKEN     # shared secret; generated by docker-start.sh if unset
OB2_HF_TOKEN                   # optional; forwarded on HF pulls only
```

Validation in `validateRuntime`:

- `llm.provider` ∈ `{"ollama", "llamacpp"}`.
- `llamacpp.gpu_layers` integer ≥ -1.
- `llamacpp.ctx_size` positive integer.
- All URLs start with `http://` or `https://`.
- An empty `llamacpp:` section is fine when `llm.provider == "ollama"` — never read.

### Manager HTTP API

All endpoints except `/healthz` require `Authorization: Bearer ${OB2_LLAMACPP_MANAGER_TOKEN}`. Constant-time compare. Even on localhost — `POST /v1/load` runs a binary against an attacker-supplied filename, and `POST /v1/pull` writes to disk. Defense in depth.

```
GET  /healthz                                                   [no auth]
     → { ok, version, uptime_sec, llama_server: {running, pid?, model?, port?} }

GET  /v1/models                                                 [auth]
     → { models: [{filename, size_bytes, modified_at, parsed: {arch?,n_params?,quant?,ctx_train?}|null, is_loaded}],
         loaded:  {filename, ctx_size, gpu_layers, port, started_at} | null }
     parsed comes from a cheap GGUF header read; null if parse fails (file still listed).

POST /v1/load                                                   [auth]
     Body: { filename, ctx_size?, gpu_layers?, parallel_slots? }
     1. Kill any running llama-server (SIGTERM, then SIGKILL after 10s).
     2. Spawn `llama-server -m <models_dir>/<filename> --port <chat_port> ...`.
     3. Poll child /health every 200ms until ready (60s timeout).
     4. Persist {filename, ctx_size, gpu_layers, parallel_slots} to .last_loaded.json.
     5. Return when ready.
     Errors: 400 invalid/non-gguf/path-traversal; 404 file missing;
             500 spawn failed / health timeout (body: last 4KB of stderr).

POST /v1/unload                                                 [auth]
     Idempotent. Clears .last_loaded.json so next manager restart does not auto-reload.

POST /v1/pull                                                   [auth]
     Body (one of):
       { source: "url", url: "https://..." }
       { source: "hf",  repo: "owner/repo", file: "model.Q4_K_M.gguf" }
     HF pulls forward `Authorization: Bearer ${OB2_HF_TOKEN}` if the env var is set.
     Streams NDJSON: { status, total?, completed? }, terminal { status: "success", filename }.
     SSRF defense: reuse the OB2 url_fetcher denylist (private IPs, metadata IPs).
     Hard caps: max 50 GB/file; only writes inside models_dir.

DELETE /v1/models/:filename                                     [auth]
     Refused if loaded — explicit unload required first.

POST /v1/restart                                                [auth]
     Body: { ctx_size?, gpu_layers?, parallel_slots? }
     Re-spawn with current loaded model + provided overrides. 400 if nothing loaded.
```

Behavior under failure:

- **Manager crashes** → Docker `restart: unless-stopped` brings it back; auto-loads from `.last_loaded.json` on boot. Net effect: ≤30s gap.
- **`llama-server` crashes (manager survives)** → manager detects via SIGCHLD, marks unloaded, **does not auto-restart**. Auto-restart loops are foot-guns when the model is the actual cause (OOM, bad GGUF). Operator must re-load.
- **Manager unreachable from OB2** → provider returns 502 `manager_unreachable`. Chat with no model loaded → 503 `no_model_loaded`.

### Deployment — containerized (Linux+CUDA)

`docker/Dockerfile.llamacpp` is a three-stage build:

1. **`llama-build`** — `nvidia/cuda:12.4.0-devel-ubuntu22.04`. `git clone --depth 1 --branch ${LLAMA_CPP_REF}` (the exact tag — e.g. `b4404` — is picked at implementation time and pinned in the Dockerfile; bumps follow `docs/llamacpp-version-bump.md`), `cmake -DGGML_CUDA=ON -DLLAMA_CURL=ON --target llama-server`. ~5 min cold, ~1 min warm.
2. **`manager-build`** — `denoland/deno:2.1.4`. `deno compile` the manager into a single static binary.
3. **Runtime** — `nvidia/cuda:12.4.0-runtime-ubuntu22.04` + `tini`, `libcurl4`, `ca-certificates`. `COPY` `llama-server` and `ob2-llamacpp-manager` from earlier stages. Healthcheck on `/healthz`. Entrypoint runs the manager.

`docker/docker-compose.yml` updates the stack name and pins existing volume names so the rename and any future renames are data-safe, then adds a new service under `profiles: ["llamacpp"]`:

```yaml
# top of docker-compose.yml
name: ob2_turboquant         # was: ob2

# existing services unchanged (container_name: ob2-server etc. are kept as-is —
# they're already independent of the stack name)

services:
  # … existing ob2-server, ob2-postgres, ob2-pgadmin, ob2-openwebui …

  ob2-llamacpp:                                         # NEW
    profiles: ["llamacpp"]
    build: { context: .., dockerfile: docker/Dockerfile.llamacpp }
    environment:
      OB2_LLAMACPP_MANAGER_TOKEN: ${OB2_LLAMACPP_MANAGER_TOKEN:?set in .env}
      OB2_HF_TOKEN: ${OB2_HF_TOKEN:-}
      OB2_LLAMACPP_DEFAULT_MODEL: ${OB2_LLAMACPP_DEFAULT_MODEL:-}
      OB2_LLAMACPP_CTX_SIZE: ${OB2_LLAMACPP_CTX_SIZE:-8192}
      OB2_LLAMACPP_GPU_LAYERS: ${OB2_LLAMACPP_GPU_LAYERS:--1}
    volumes: [llamacpp_models:/data/llamacpp/models]
    deploy: { resources: { reservations: { devices: [{ capabilities: [gpu] }] } } }
    restart: unless-stopped

volumes:
  ob2_data:           { name: ob2_data }                # NEW: pin name (was: project-prefixed)
  ob2_pgdata:         { name: ob2_pgdata }              # NEW: pin name
  ob2_openwebui_data: { name: ob2_openwebui_data }      # NEW: pin name
  llamacpp_models:    { name: llamacpp_models }         # NEW
```

**Why the volume `name:` pins.** Without `name:` overrides, Compose prefixes named volumes with the project name on disk (so today's volumes are `ob2_ob2_data`, `ob2_ob2_pgdata`, `ob2_ob2_openwebui_data`). Renaming the project from `ob2` → `ob2_turboquant` would create new empty volumes and orphan the data. Pinning the name decouples the volume identity from the stack name once and for all — this rename is the one-time migration; future renames cost nothing.

Both the llamacpp manager port and chat port are bound on the internal Docker network only — never published to the host.

`scripts/docker-start.sh --with-llamacpp` enables the `llamacpp` profile, generates `OB2_LLAMACPP_MANAGER_TOKEN` if unset (32 bytes hex, written to `.env` — same pattern as `OB2_BRAIN_KEY`), and sets `OB2_LLM_PROVIDER=llamacpp`. Combinable with `--with-chat`.

**Operator upgrade path.** A new `docs/upgrade-ob2-to-turboquant.md` runbook documents the one-time data migration for existing deployments: stop the stack, rename each `ob2_ob2_<name>` volume to its pinned `ob2_<name>` form (one `docker run --rm` per volume copying the contents, then delete the old), and start the stack under the new project name. The runbook includes a `--check` step that lists volumes and verifies row counts in the pgvector tables before declaring success. Fresh deployments skip this entirely — they only ever see the pinned names.

### Deployment — host mode (Windows / macOS)

Operator's directory after setup:

```
C:\turboquant\
├── llama-server.exe           ← from turboquant_plus zip
├── llama-cli.exe              ← from turboquant_plus zip
├── llama-bench.exe            ← from turboquant_plus zip
├── ggml-cuda.dll              ← from turboquant_plus zip
├── (CUDA runtime DLLs)        ← from turboquant_plus zip
├── ob2-llamacpp-manager.exe   ← from OB2 GitHub releases (CI-built)
├── ob2-llamacpp.bat           ← shipped alongside the manager binary
└── models\                    ← operator drops GGUFs here, or pulls via dashboard
```

The `.bat` (and the macOS `.command` equivalent) sets `OB2_LLAMA_SERVER_BIN` to the local `llama-server` binary, sets ports, and runs the manager. OB2 (Docker) is configured with:

```
OB2_LLM_PROVIDER=llamacpp
OB2_LLAMACPP_MANAGER_URL=http://host.docker.internal:8081
OB2_LLAMACPP_CHAT_URL=http://host.docker.internal:8080
OB2_LLAMACPP_MANAGER_TOKEN=<same token as the .bat>
```

`docs/llamacpp-host-setup.md` walks operators through it end-to-end — same shape as the existing `docs/deployment.md`.

### Dashboard

**Provider switch (Config tab).** Radio between Ollama and llama-server. Below the radio, the panel for the selected provider is shown; the other is hidden. Env-overridden fields show the same yellow "from env" badge `ollama.*` already uses.

**Models tab — provider-aware.** Reads `/admin/llm/capabilities` once per page load. Two render modes:

- **Ollama mode** — unchanged from today.
- **llama-server mode** — single "Loaded model" widget with restart/unload buttons; table of available `.gguf` files in `models_dir` with Load/Delete actions; "Pull from URL" and "Pull from HuggingFace" modals reusing the existing NDJSON pull-progress UI. HF modal shows a banner when `OB2_HF_TOKEN` is configured. Deletes refused server-side if the file is loaded.

Loading a model kills the running `llama-server`. Modal warning: "This will swap the loaded model. In-flight chat requests will fail." Confirm to proceed.

**Classifier section (Config tab).** Explicit subsection because configuration crosses providers:

```
Classifier (used for query routing)
  Classifier provider: ( ) Same as chat   ( ) Ollama   ( ) llama-server

  Current effective configuration:
    Chat:        llama-server → qwen2.5-7b-instruct.Q4_K_M.gguf
    Classifier:  Ollama       → qwen2.5:0.5b
    ↳ Cross-provider: classifier runs on Ollama while chat runs on
      llama-server. Both backends must be up.

  Classifier model (Ollama only): [qwen2.5:0.5b ▾]
    ⓘ When the classifier provider is llama-server, the loaded chat
      model is reused — there is no separate classifier model because
      llama-server holds one model at a time.
```

The "current effective configuration" line is the load-bearing UX element. Anyone reading it can answer "what's classifying my queries?" in three seconds.

**Status header.** A provider badge in the top-right strip:

```
…  •  LLM: llama-server (qwen2.5-7b-instruct.Q4_K_M)  •  status
```

Click to jump to the LLM Provider section in the Config tab.

**Mid-conversation model swaps** fail the in-flight request. No auto-retry. Open WebUI surfaces the error; user retries the message. Predictable behavior beats a 30-second invisible pause that masquerades as latency.

### Cross-provider classifier

The classifier today uses `getRuntime().ollama.classifier_model` — typically a smaller, faster model than the chat one. With `llama-server` only loading one model at a time, "different classifier model" only works when the classifier provider differs from the chat provider:

| Chat provider | Classifier provider | Effect |
|---|---|---|
| Ollama | Ollama (or "") | Existing behavior. Separate `classifier_model` in YAML. |
| llamacpp | llamacpp (or "") | Classifier reuses the loaded chat model. |
| llamacpp | Ollama | Classifier on a small Ollama model; chat on llama-server. Both backends up. |
| Ollama | llamacpp | Unusual but supported. Chat fast on Ollama; classifier reuses llama-server's loaded model. |

The dashboard Classifier section spells out the resolved configuration in plain English.

## Phasing

Three phases, each independently shippable. The implementation plans (per-phase) come from the next step (writing-plans), not this spec.

### Phase 1 — Provider abstraction + chat path

- `server/llm/{provider,ollama_provider,llamacpp_provider,openai_sse}.ts`
- Runtime config: `llm.provider`, `llm.classifier_provider`, `llamacpp.*`
- `gateway.ts`, `classifier.ts`, `mcp.ts` swapped to `getProvider()` / `getClassifierProvider()`
- **`admin.ts` is NOT touched in this phase.** The existing Ollama-specific management endpoints (model list, pull, unload, etc.) keep calling Ollama directly. When `provider == llamacpp` is set in Phase 1, those endpoints will fail; the operator simply doesn't use them. `admin.ts` becomes provider-aware in Phase 3.
- **No manager. No dashboard changes. No Docker changes.**

End-of-phase capability: an admin who points `OB2_LLAMACPP_CHAT_URL` at any externally-running `llama-server` (the prebuilt Windows binary launched by hand, or the upstream `ghcr.io/ggml-org/llama.cpp:server-cuda` container) gets working chat through OB2, with retrieval and citations. Models tab still shows Ollama-only — the operator simply doesn't use it.

Validates the entire chat-side architecture before touching Docker or UI.

### Phase 2 — Manager service + Docker integration

- `llamacpp-manager/` Deno service implementing the API above.
- `docker/Dockerfile.llamacpp` (3-stage), `docker-compose.yml` `llamacpp` profile, `scripts/docker-start.sh --with-llamacpp`.
- **Compose stack rename**: `name: ob2` → `name: ob2_turboquant`, with `name:` overrides pinned on every named volume (`ob2_data`, `ob2_pgdata`, `ob2_openwebui_data`, `llamacpp_models`) so volume identity is decoupled from the stack name forever.
- **One-time data migration runbook** at `docs/upgrade-ob2-to-turboquant.md` covering existing deployments: stop the stack, copy each `ob2_ob2_<name>` volume into its pinned `ob2_<name>` form, verify row counts, restart under the new stack name. Fresh deployments skip this.
- CI release of host binaries (`linux-x64`, `windows-x64`, `macos-arm64`).
- `docs/llamacpp-host-setup.md`, `docs/llamacpp-version-bump.md`.

End-of-phase capability: full deploy story works for both deployment shapes. Management still happens via `curl` to the manager.

### Phase 3 — Dashboard provider-awareness

- Config-tab provider switch and `llamacpp.*` panel.
- Models tab dual-mode.
- Classifier section.
- Status-header provider badge.
- New admin routes: `/admin/llm/capabilities`, `/admin/llm/load`, `/admin/llm/unload`, `/admin/llm/restart`.

End-of-phase capability: feature is a polished product; nothing requires `curl`.

## Risks / known gotchas

- **NVIDIA-on-WSL2 is operator's responsibility.** Docker Desktop ≥4.27 with NVIDIA GPU passthrough enabled. We document; we do not detect.
- **`LLAMA_CPP_REF` bumps could regress.** Mitigated by pinning, the version-bump runbook, and the Phase 2 smoke test (`tests/e2e.sh` adds an llamacpp pass that asserts streaming chat returns non-empty content for a known prompt).
- **GGUF format drift.** `llama.cpp` occasionally bumps GGUF major versions; older quants stop loading. Manager surfaces the error verbatim (last 4KB of stderr in the load-response body); the runbook covers re-quantization or pinning to an older `LLAMA_CPP_REF`.
- **Manager token leakage.** Token written to `.env` (file mode 0600 by `docker-start.sh`). Not logged. Constant-time compare on the manager side. Rotation requires a single env update and `docker compose up -d ob2-llamacpp ob2-server`.
- **HuggingFace pull of a gated model with no token set.** Pull fails with HTTP 401; manager surfaces the upstream body in the NDJSON error frame. Dashboard pull modal links to docs explaining `OB2_HF_TOKEN`.
- **Concurrent `POST /v1/load` from two admins.** Manager serializes load operations behind a mutex — second caller waits or 409s after a 30s queue timeout. Avoids the race where both spawn `llama-server` and one orphans the other.

## Migration contract

1. **Default stays `OB2_LLM_PROVIDER=ollama`** through every phase. Nothing changes for existing deployments unless they opt in.
2. **No config-key renames.** `ollama.*` runtime config stays exactly as today — same YAML keys, same env vars. New fields are additive.
3. **`server/ollama/client.ts` and `pulls.ts` are untouched.** Only `ollama_provider.ts` (the new facade) imports them. Wire-level Ollama behavior is bit-for-bit preserved.
4. **`tests/e2e.sh`** gets one new pass: `OB2_LLM_PROVIDER=llamacpp` against a compose stack with the `llamacpp` profile. Asserts streaming chat returns non-empty content; asserts `POST /admin/llm/load` switches model and a follow-up chat reflects the new model in `activeModelLabel()`. Existing Ollama passes run unchanged with `OB2_LLM_PROVIDER=ollama`.
5. **No flip-the-default PR is planned.** Unlike the Rust sidecar migration, neither provider is "better" — they serve different operator situations. Both remain first-class indefinitely.
6. **Compose stack renames once, then never again.** `name: ob2` → `name: ob2_turboquant` lands in Phase 2. At the same time, every named volume gets a pinned `name:` override so the on-disk volume name stops being prefixed by the stack name. From this point forward, the stack can be renamed freely without touching data. Existing operators perform the one-time `ob2_ob2_<name>` → `ob2_<name>` migration documented in `docs/upgrade-ob2-to-turboquant.md`. Container names (`ob2-server`, `ob2-postgres`, `ob2-pgadmin`, `ob2-openwebui`) are deliberately left unchanged — they're independent of the stack name and renaming them would force operators to update any host references without buying anything in return.

## Test plan

- **Unit:** provider abstraction with a fake provider (no backend); each adapter against a mock HTTP server returning canned NDJSON / SSE / pull-progress frames.
- **Manager unit tests:** GGUF header parser fixtures; SSRF denylist; path-traversal refusals on filenames; token comparison.
- **Integration:** `tests/e2e.sh` passes for both providers; new llamacpp pass exercises load/unload/chat sequence; HF pull test uses a tiny public GGUF (≤200 MB) and is skipped by default in CI to keep wall time down.
- **Manual / smoke:** Phase 1 — chat against an externally-running `llama-server`. Phase 2 — `--with-llamacpp` end-to-end on a CUDA host. Phase 3 — every dashboard control click-tested.
