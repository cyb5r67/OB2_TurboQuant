# Rust Retrieval Sidecar — Design

**Status:** Design.
**Date:** 2026-04-19

## Problem

OB2's retrieval sidecar is Python. It handles embeddings (sentence-transformers `all-MiniLM-L6-v2`, 384-dim, PyTorch), hybrid TF-IDF + cosine retrieval, context compression for LLM prompting, three storage backends (sqlite-vec, pgvector, two-tier), a background sync worker, and exposes 20 JSON-RPC methods over newline-delimited stdin/stdout. Deno spawns it via `/mnt/c/projects/OB2/server/sidecar.ts` and keeps it warm across requests.

Cost profile:

- Resident memory: ~2 GB (torch + sentence-transformers + model weights).
- Cold start: ~500 ms.
- Deploy artifact: Python venv (~1.5 GB), pip resolve on image rebuild, no reproducible build without a lock file.

Rust replacement delivers:

- Resident memory ~50–150 MB (ONNX Runtime + all-MiniLM-L6-v2).
- Cold start ~300 ms.
- Single static binary (plus ONNX `.so` + model weights).

The payoff only materializes when Python is fully replaced — shimming Rust in front of Python preserves the torch heap and defeats the point. So: port everything, coexist with the Python sidecar during migration, retire Python in a future spec.

## Goal

Ship a Rust retrieval sidecar that is wire-compatible with the Python sidecar byte-for-byte, selectable at startup via `OB2_SIDECAR_RUNTIME=python|rust`, and proven safe by a CI-enforced golden-output test suite.

## Non-goals

- Any change to the Deno server beyond a 10-line spawn-branch in `server/sidecar.ts`.
- Any change to the JSON-RPC wire protocol. New methods require fixture additions to both runtimes in the same PR.
- Removing Python. That's a future spec, after ~2 weeks of production traffic on Rust with zero golden divergence.
- Performance gains beyond what replacing torch-with-ONNX delivers. No algorithmic changes. TF-IDF math, BM25 scoring, alpha blending, compression strategies — all ported verbatim to preserve golden-test equivalence.
- HTTP interface. Protocol stays stdin/stdout.

## Migration contract

1. **New env var `OB2_SIDECAR_RUNTIME`**: values `python` (default) and `rust`. Deno reads it at boot to pick which binary to spawn.
2. **Docker image ships both runtimes.** No operator-visible install flag; the choice is pure environment.
3. **Golden-output test suite** in `/mnt/c/projects/OB2/tests/sidecar-golden/` is the compatibility contract. JSONL fixtures generated from Python, validated against by both runtimes in CI.
4. **New methods** must land fixtures to both sides in the same PR.
5. **Failing fixture = merge blocker** on PRs touching `retrieval/`, `context-engine/`, `sidecar-rs/`, or the fixtures themselves.
6. **Default stays `python`** through the rollout. A follow-up PR flips the default to `rust` after 2 weeks of production evidence. A third PR (a different spec) retires Python when the default has been `rust` for ~3 months.

## Scope

- **All 20 JSON-RPC methods** ported: `ping`, `capture`, `capture_batch`, `retrieve`, `build_context`, `knowledge_stats`, `list_domains`, `delete`, `delete_domain`, `has_source`, `record_source`, `upsert_alias`, `resolve_alias`, `list_aliases`, `suggest_domains`, `batcher_stats`, `record_classifier_decision`, `classifier_stats`, `test_pgvector`, `sync_status`.
- **All 3 storage backends** ported: `sqlite_vec`, `pg_vector`, `two_tier`. `OB2_STORAGE_BACKEND` selects independently from `OB2_SIDECAR_RUNTIME`.
- **Embedding runtime**: `fastembed-rs` with `ort/cuda` feature enabled. ONNX Runtime dlopens `libcudart.so.12` at runtime and falls back to the CPU provider if CUDA isn't present — matches the current torch behavior.
- **Sync worker**: one `tokio::spawn` task implementing the Python `SyncWorker` semantics (5 s interval or 256-doc threshold; exponential backoff on pgvector outage).
- **Embed batcher**: tokio `mpsc` + `interval` implementation of the Python `EmbedBatcher` (100 ms window, 32-item flush, bypass on direct batch calls).
- **Multi-stage Dockerfile**: new `FROM rust:1.80-slim AS rust-builder` stage; final image carries both the Python venv and the compiled Rust binary; fastembed model cache pre-warmed at build time.
- **Golden fixtures + CI parity job**: `.github/workflows/sidecar-parity.yml` runs the suite against both runtimes on every PR.

## Architecture

### Cargo workspace — 5 crates under `/mnt/c/projects/OB2/sidecar-rs/`

```
sidecar-rs/
├── Cargo.toml                    # [workspace]
├── rust-toolchain.toml           # pinned 1.80
├── crates/
│   ├── ob2-sidecar/              # bin (~300 LOC)
│   ├── ob2-storage/              # lib (~1800 LOC) — features: sqlite-vec, pgvector, two-tier
│   ├── ob2-embedder/             # lib (~400 LOC)
│   ├── ob2-retriever/            # lib (~500 LOC)
│   └── ob2-context/              # lib (~600 LOC)
└── tests/
    └── golden/                   # integration runner
```

Each lib crate is pure (no stdin/stdout knowledge) so golden tests can drive them directly. One binary crate wires them together.

### Dependencies

Pinned to major. Full table in the implementation plan; key picks:

- `fastembed` 4 + `ort` 2 (cuda feature) — embeddings
- `rusqlite` 0.32 (bundled + load_extension) + `sqlite-vec` 0.1 (Rust crate ships the extension)
- `tokio-postgres` 0.7 + `pgvector` 0.4 + `deadpool-postgres` 0.14
- `tokio` 1, `serde`/`serde_json` 1, `tracing` 0.1, `anyhow`/`thiserror`
- `ndarray` 0.16 for internal embedding math
- Hand-written TF-IDF (~80 LOC) — reject `tantivy` (30 MB, different tokenization, would break fixtures)

### Concurrency model

- `tokio` multi-thread, 2 worker threads.
- Embedding inference wrapped in `tokio::task::spawn_blocking` (ONNX is synchronous).
- Response writes funnel through one `mpsc::UnboundedSender<String>` drained by a single writer task — mirrors the Deno single-writer pattern, guarantees newline atomicity.
- Sync worker and embed batcher both run as long-lived `tokio::spawn` tasks with `select! { interval | shutdown }`.

### Deno integration

One branch in `server/sidecar.ts:43-50`:

```ts
const runtime = Deno.env.get("OB2_SIDECAR_RUNTIME") ?? "python";
const [bin, args] = runtime === "rust"
  ? [this.config.rustSidecarBin, []]
  : [this.config.python, [this.config.sidecarScript]];
const cmd = new Deno.Command(bin, { args, stdin: "piped", stdout: "piped", stderr: "inherit", cwd: ... });
```

`Config` gets `rustSidecarBin: string` (default `/app/sidecar-rs/ob2-sidecar`). No runtime-YAML configurability; the choice is a startup-time decision.

### Dockerfile changes

Add a new stage:

```dockerfile
FROM rust:1.80-slim AS rust-builder
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev \
 && rm -rf /var/lib/apt/lists/*
COPY sidecar-rs/ ./sidecar-rs/
RUN cd sidecar-rs && cargo build --release --bin ob2-sidecar
RUN /build/sidecar-rs/target/release/ob2-sidecar --warm-embedder
```

Final stage appends:

```dockerfile
COPY --from=rust-builder /build/sidecar-rs/target/release/ob2-sidecar /app/sidecar-rs/ob2-sidecar
COPY --from=rust-builder /root/.cache/fastembed /app/.cache/fastembed
ENV FASTEMBED_CACHE_PATH=/app/.cache/fastembed
```

`docker-compose.yml` gets `OB2_SIDECAR_RUNTIME: ${OB2_SIDECAR_RUNTIME:-}` (empty default = Python).

### Golden-output test suite

**Location:** `/mnt/c/projects/OB2/tests/sidecar-golden/`.

**Format:** JSONL fixtures, one file per method, each line:
```json
{"request":{"jsonrpc":"2.0","id":1,"method":"capture","params":{...}},
 "expected":{"jsonrpc":"2.0","id":1,"result":{...}},
 "seed_docs":[...]}
```

**Generator:** `generate.py --regen` spawns the Python sidecar, runs a deterministic corpus, captures responses, writes fixtures. Regeneration requires explicit human diff review in the PR.

**Comparator redactions:**
- Timestamp fields (`at`, `last_sync_at`, `oldest_at`, `newest_at`, `imported_at`) stripped before compare.
- `score` fields compared with tolerance `1e-4` (matches Python `round(score, 4)`).
- Everything else byte-exact.

**Harnesses:**
- Python: `pytest tests/sidecar-golden/test_python.py`.
- Rust: `cargo test --release --test golden` drives the built binary via `assert_cmd`.

### CUDA / GPU fallback

`fastembed` compiled with `ort/cuda` runs on CPU-only hosts — ONNX dlopens CUDA libs at runtime and falls back to CPU silently. Operators on GPU hosts either mount `/usr/local/cuda/lib64` or switch the final Docker stage to `nvidia/cuda:12.2-runtime`. Startup log line reports the resolved provider (`embedder: all-MiniLM-L6-v2 on cuda:0 (dim=384)` vs `... on cpu (dim=384)`).

## Data model

No changes. On-disk format for `sqlite-vec` and `pgvector` is copied verbatim from the Python DDL (`retrieval/storage/sqlite_vec.py:48-78`, `retrieval/storage/pg_vector.py:65-80`). The `docs`, `docs_vec`, `source_imports`, `entity_aliases` schemas remain compatible with both runtimes — operators can flip `OB2_SIDECAR_RUNTIME` without touching the database.

## Error handling

- Method-not-found → JSON-RPC error code `-32601`, same message as Python.
- Missing-parameter (KeyError equivalent) → `-32602`.
- All other exceptions → `-32603` with `e.to_string()` truncated to 200 chars (matches Python `str(e)[:200]` in `test_pgvector`).
- Structured error types (`thiserror` at lib layer, `anyhow` at bin layer) map through a single translation point just before serialization.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| `sqlite-vec` Rust crate lags upstream | Crate exists (same author as Python pkg) and ships extension bytes. Fallback: vendor the `.so` and load via `rusqlite::Connection::load_extension(path, None)`. |
| CUDA dlopen unexpectedly fails on slim base | Documented behavior; fallback is automatic. Startup log confirms which provider resolved. |
| FastEmbed downloads weights on first call | Pre-warm during Docker build (`--warm-embedder` flag caches under `FASTEMBED_CACHE_PATH`). |
| Protocol drift | Golden fixtures + CI parity job; new methods require same-PR fixture additions. |
| Timestamp / float precision drift | Comparator redacts timestamps; floats compared with 1e-4 tolerance; `chrono` format pinned to match Python `isoformat(timespec="seconds")`. |
| Two-tier sync-worker behavior diverges under load | Soak test: 10k captures, kill mid-sync, restart, verify no loss (matches current Python soak).  |

## Rollout

1. **Week 0–6 — Spec A–J**: land all 10 implementation steps (workspace skeleton → Dockerfile). Default `OB2_SIDECAR_RUNTIME=python`.
2. **Week 7**: enable the parity CI job on `main`. Merge gate.
3. **Week 7–9**: operators opt-in via `OB2_SIDECAR_RUNTIME=rust` on staging deployments. Collect feedback, fix edge cases.
4. **Week 9**: flip default to `rust` in a follow-up PR. Python still available via env var.
5. **Week 12+**: separate spec retires Python (deletes `retrieval/` + `context-engine/`, removes the Python venv from the Docker image, saves ~1.5 GB).

## Verification

Per-step:
- `cargo build --release` clean.
- `cargo test --workspace` passes.
- `cargo test --release --test golden` passes all fixtures.
- `pytest tests/sidecar-golden/test_python.py` passes (catches Python regressions on the same fixtures).

End-to-end after step 10:
```bash
cd docker && docker compose build ob2-server && cd ..

OB2_SMTP_DRIVER=log OB2_PUBLIC_URL=http://127.0.0.1:7600 \
  OB2_SIDECAR_RUNTIME=python bash tests/e2e.sh
# Expected: 66/66 PASS

OB2_SMTP_DRIVER=log OB2_PUBLIC_URL=http://127.0.0.1:7600 \
  OB2_SIDECAR_RUNTIME=rust bash tests/e2e.sh
# Expected: 66/66 PASS with identical semantics

docker stats ob2-server --no-stream
# Python: ~2 GB RSS; Rust: ~150 MB RSS
```

## Open questions

None blocking. Staging plan in the implementation plan handles all the identified dependencies.
