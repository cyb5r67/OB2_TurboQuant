# Rust Retrieval Sidecar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a wire-compatible Rust replacement for OB2's Python retrieval sidecar (`retrieval/*.py` + `context-engine/*.py`, ~3,400 Python LOC). Ship both runtimes in the Docker image; operators toggle via `OB2_SIDECAR_RUNTIME=python|rust`. Validate byte-equivalence via a golden-output test suite running in CI against both runtimes.

**Architecture:** Cargo workspace at `/mnt/c/projects/OB2/sidecar-rs/` with 5 crates (sidecar bin + storage / embedder / retriever / context libs). Tokio multi-thread runtime, fastembed-rs with ort/cuda feature (auto CPU-fallback), rusqlite + sqlite-vec crate for tier-1 storage, tokio-postgres + pgvector for tier-2, single-writer stdout pattern matching the Deno side.

**Tech Stack:** Rust 1.80 + Tokio 1 + fastembed 4 + ort 2 + rusqlite 0.32 + sqlite-vec 0.1 + tokio-postgres 0.7 + pgvector 0.4 + deadpool-postgres 0.14 + serde 1 + tracing 0.1 + anyhow/thiserror 1 + ndarray 0.16.

**Spec:** `docs/superpowers/specs/2026-04-19-rust-sidecar-design.md`

---

## Scale note to implementers

This plan breaks ~6,000 LOC of new Rust into 10 PR-sized tasks. Unlike our prior specs, each task here is a multi-day engineering block — the plan provides the *skeleton* (file paths, key type signatures, critical algorithms, the test harness, and the compatibility contract) rather than every line of code, because:

1. The porting target (Python) is the canonical reference. Each task points to the exact Python source file and says "port this verbatim" for the mechanical parts.
2. Golden-output tests are the real specification. If the fixtures pass, the code is correct, regardless of how it's structured.
3. Hand-writing 6,000 LOC of anticipated Rust code inside a plan document invites drift between plan and reality.

So: each task specifies file structure, public type signatures, the test gate, and the commit message. The implementer (human or subagent) ports the internals referencing the Python source, then validates against fixtures.

## Conventions

- Working directory: `/mnt/c/projects/OB2`. Branch: `rust-sidecar` (already created by the skill).
- Verification: per-task Rust builds with `cd sidecar-rs && cargo check --workspace` + progressive golden fixtures. Full e2e with both runtimes lands at the end.
- Commit policy: one logical commit per task (multiple commits allowed inside long tasks). Each ends with `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- Pinned Rust toolchain: 1.80 via `rust-toolchain.toml`. CI uses same.

---

## Task 1: Workspace skeleton + ping round-trip

**Files:**
- Create: `sidecar-rs/Cargo.toml`
- Create: `sidecar-rs/rust-toolchain.toml`
- Create: `sidecar-rs/crates/ob2-sidecar/Cargo.toml`
- Create: `sidecar-rs/crates/ob2-sidecar/src/main.rs`
- Create: `sidecar-rs/crates/ob2-storage/Cargo.toml`
- Create: `sidecar-rs/crates/ob2-storage/src/lib.rs`
- Create: `sidecar-rs/crates/ob2-embedder/Cargo.toml`
- Create: `sidecar-rs/crates/ob2-embedder/src/lib.rs`
- Create: `sidecar-rs/crates/ob2-retriever/Cargo.toml`
- Create: `sidecar-rs/crates/ob2-retriever/src/lib.rs`
- Create: `sidecar-rs/crates/ob2-context/Cargo.toml`
- Create: `sidecar-rs/crates/ob2-context/src/lib.rs`
- Create: `sidecar-rs/.gitignore`

- [ ] **Step 1: Workspace root**

`sidecar-rs/Cargo.toml`:
```toml
[workspace]
resolver = "2"
members = ["crates/*"]

[workspace.package]
version = "0.1.0"
edition = "2021"
rust-version = "1.80"

[workspace.dependencies]
tokio = { version = "1", features = ["rt-multi-thread", "macros", "io-std", "sync", "time", "signal"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
anyhow = "1"
thiserror = "1"
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
chrono = { version = "0.4", features = ["serde"] }
ndarray = "0.16"
```

`sidecar-rs/rust-toolchain.toml`:
```toml
[toolchain]
channel = "1.80"
components = ["rustfmt", "clippy"]
```

`sidecar-rs/.gitignore`:
```
target/
**/*.rs.bk
Cargo.lock
```

(Commit `Cargo.lock` later once the full dep tree is stable — for now, keep diffs clean.)

- [ ] **Step 2: Empty library crates**

Each lib crate (`ob2-storage`, `ob2-embedder`, `ob2-retriever`, `ob2-context`):
```toml
[package]
name = "ob2-storage"  # adjust per crate
version.workspace = true
edition.workspace = true

[dependencies]
anyhow.workspace = true
thiserror.workspace = true
serde.workspace = true
serde_json.workspace = true
tracing.workspace = true
```

Their `src/lib.rs`:
```rust
//! ob2-storage — storage backend trait + sqlite/pg/two-tier implementations.
//! Ported from /mnt/c/projects/OB2/retrieval/storage/*.py
```

(Adjust module doc per crate.)

- [ ] **Step 3: Binary crate with ping handler**

`sidecar-rs/crates/ob2-sidecar/Cargo.toml`:
```toml
[package]
name = "ob2-sidecar"
version.workspace = true
edition.workspace = true

[[bin]]
name = "ob2-sidecar"
path = "src/main.rs"

[dependencies]
anyhow.workspace = true
serde.workspace = true
serde_json.workspace = true
tokio.workspace = true
tracing.workspace = true
tracing-subscriber.workspace = true
```

`sidecar-rs/crates/ob2-sidecar/src/main.rs`:
```rust
use anyhow::Result;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Stdin, Stdout};

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().with_writer(std::io::stderr).with_env_filter(
        tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
    ).init();

    tracing::info!("ob2-sidecar (rust) starting");
    eprintln!("ob2-retrieval sidecar started (backend=stub, dim=384, embedder=stub)");

    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();
    run_rpc_loop(stdin, stdout).await
}

async fn run_rpc_loop(stdin: Stdin, mut stdout: Stdout) -> Result<()> {
    let mut reader = BufReader::new(stdin).lines();
    while let Some(line) = reader.next_line().await? {
        let line = line.trim();
        if line.is_empty() { continue; }
        let resp = handle_line(line).await;
        stdout.write_all(resp.as_bytes()).await?;
        stdout.write_all(b"\n").await?;
        stdout.flush().await?;
    }
    Ok(())
}

async fn handle_line(line: &str) -> String {
    let req: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return error_resp(Value::Null, -32700, &format!("parse error: {e}")),
    };
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
    match method {
        "ping" => ok_resp(id, json!({
            "pong": true,
            "embedder": "stub",
            "backend": "stub",
            "batcher": { "available": false }
        })),
        other => error_resp(id, -32601, &format!("method not found: {other}")),
    }
}

fn ok_resp(id: Value, result: Value) -> String {
    serde_json::to_string(&json!({ "jsonrpc": "2.0", "id": id, "result": result })).unwrap()
}

fn error_resp(id: Value, code: i64, message: &str) -> String {
    serde_json::to_string(&json!({
        "jsonrpc": "2.0", "id": id,
        "error": { "code": code, "message": message }
    })).unwrap()
}
```

- [ ] **Step 4: Build + smoke-test**

```bash
cd /mnt/c/projects/OB2/sidecar-rs
cargo build --workspace
echo '{"jsonrpc":"2.0","id":1,"method":"ping"}' | ./target/debug/ob2-sidecar
# Expect: {"jsonrpc":"2.0","id":1,"result":{"pong":true,...}}
```

- [ ] **Step 5: Commit**

```bash
cd /mnt/c/projects/OB2
git add sidecar-rs/
git commit -m "$(cat <<'EOF'
rust-sidecar: workspace skeleton + ping round-trip

Cargo workspace with 5 crates (sidecar bin + 4 libs). Binary reads
JSON-RPC from stdin, writes responses to stdout. Only `ping` is
wired; all other methods return -32601. Subsequent tasks fill in
the libs. Deno-side integration + Docker build come later.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Golden fixture generator + Python-side harness

**Files:**
- Create: `tests/sidecar-golden/__init__.py`
- Create: `tests/sidecar-golden/generate.py`
- Create: `tests/sidecar-golden/comparator.py`
- Create: `tests/sidecar-golden/test_python.py`
- Create: `tests/sidecar-golden/fixtures/.gitkeep`
- Create: `tests/sidecar-golden/README.md`

This task lands the **contract** before any Rust code. Once it passes on Python, every subsequent Rust PR adds `--runtime rust` validation.

- [ ] **Step 1: Comparator with redaction + float tolerance**

`tests/sidecar-golden/comparator.py` — see spec §Golden-output test suite for the rules:

```python
"""Fixture comparison logic shared by Python + Rust harnesses.

Redacts non-deterministic fields (timestamps) and applies float tolerance
to score-like fields. Everything else must match byte-exact.
"""
from __future__ import annotations
import math
from typing import Any

TIMESTAMP_KEYS = {"at", "last_sync_at", "oldest_at", "newest_at", "imported_at", "created_at"}
FLOAT_TOLERANCE = 1e-4


def redact_timestamps(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: (None if k in TIMESTAMP_KEYS else redact_timestamps(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [redact_timestamps(x) for x in obj]
    return obj


def compare(actual: Any, expected: Any, path: str = "") -> list[str]:
    """Return list of human-readable mismatches; empty list = pass."""
    actual = redact_timestamps(actual)
    expected = redact_timestamps(expected)
    return _diff(actual, expected, path)


def _diff(a: Any, e: Any, path: str) -> list[str]:
    if isinstance(e, dict):
        if not isinstance(a, dict):
            return [f"{path}: expected dict, got {type(a).__name__}"]
        errs = []
        for k in set(a.keys()) | set(e.keys()):
            if k not in a:
                errs.append(f"{path}.{k}: missing in actual")
            elif k not in e:
                errs.append(f"{path}.{k}: unexpected in actual")
            else:
                errs += _diff(a[k], e[k], f"{path}.{k}")
        return errs
    if isinstance(e, list):
        if not isinstance(a, list) or len(a) != len(e):
            return [f"{path}: list length differs (got {len(a) if isinstance(a, list) else 'non-list'}, want {len(e)})"]
        errs = []
        for i, (x, y) in enumerate(zip(a, e)):
            errs += _diff(x, y, f"{path}[{i}]")
        return errs
    if isinstance(e, float):
        if not isinstance(a, (int, float)) or not math.isfinite(a) or abs(a - e) > FLOAT_TOLERANCE:
            return [f"{path}: float mismatch (got {a}, want {e} ± {FLOAT_TOLERANCE})"]
        return []
    if a != e:
        return [f"{path}: mismatch (got {a!r}, want {e!r})"]
    return []
```

- [ ] **Step 2: Fixture generator**

`tests/sidecar-golden/generate.py`:
```python
"""Generate golden fixtures by driving the Python sidecar against a scratch DB.

Usage:
    python tests/sidecar-golden/generate.py --regen   # rewrite fixtures
    python tests/sidecar-golden/generate.py --check   # compare without rewriting

Fixtures live at tests/sidecar-golden/fixtures/<method>.jsonl. Each line:
    {"name": "descriptive-name",
     "seed": [{"method": "...", "params": {...}}, ...],  # setup calls
     "request": {"method": "...", "params": {...}},
     "expected": {...}}
"""
# Full implementation: spawns python retrieval/sidecar.py subprocess with
# OB2_SQLITE_PATH=/tmp/ob2-golden-<ts>.db, OB2_EMBEDDER_FORCE_CPU=1,
# runs curated corpus, captures responses, writes fixtures.
```

Minimum fixture set to land with Task 2 (just `ping`):

`tests/sidecar-golden/fixtures/ping.jsonl`:
```
{"name":"ping basic","seed":[],"request":{"method":"ping","params":{}},"expected":{"pong":true,"embedder":"all-MiniLM-L6-v2","backend":"sqlite","batcher":{"available":true}}}
```

Later tasks grow this per method.

- [ ] **Step 3: Python harness**

`tests/sidecar-golden/test_python.py`:
```python
import json
import pathlib
import pytest
import subprocess

from comparator import compare

FIXTURES = pathlib.Path(__file__).parent / "fixtures"


def iter_fixtures():
    for path in sorted(FIXTURES.glob("*.jsonl")):
        with open(path) as f:
            for i, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                fx = json.loads(line)
                yield path.name, i, fx


@pytest.mark.parametrize("file_,lineno,fx", list(iter_fixtures()))
def test_python_fixture(file_, lineno, fx, tmp_path):
    # Spawn Python sidecar, run seed calls, run request, compare response.
    # Implementation detail: tmp_path holds a scratch SQLite DB.
    raise NotImplementedError("flesh out during Task 2 — see harness pattern in generate.py")
```

(The final implementation spawns the sidecar via `subprocess.Popen(["python", "retrieval/sidecar.py"], stdin=PIPE, stdout=PIPE)` with `OB2_SQLITE_PATH=tmp_path/ob2.db`, sends JSON-RPC lines, captures responses, calls `compare(actual, expected)` — fail on non-empty error list.)

- [ ] **Step 4: README**

`tests/sidecar-golden/README.md`:
Documents the harness workflow, regen gate, and the compat contract for adding new methods.

- [ ] **Step 5: Verify harness passes on Python**

```bash
cd /mnt/c/projects/OB2
pytest tests/sidecar-golden/test_python.py -v
# Expect: 1 passed (just the ping fixture)
```

- [ ] **Step 6: Commit**

```bash
git add tests/sidecar-golden/
git commit -m "$(cat <<'EOF'
rust-sidecar: golden fixture harness + Python passes ping

Fixture format: JSONL per method. Comparator redacts timestamp
fields, applies 1e-4 tolerance to floats, byte-exact on everything
else. Python harness drives the existing retrieval/sidecar.py via
subprocess. Rust harness lands in Task 10 (after all methods are
implemented) — but every intermediate Rust PR will run its subset
against fixtures as they're added.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `ob2-storage` — sqlite-vec backend

**Files:**
- Modify: `sidecar-rs/crates/ob2-storage/Cargo.toml` (add rusqlite, sqlite-vec)
- Create: `sidecar-rs/crates/ob2-storage/src/types.rs` — DocRecord, DocHit, DomainStats, MetadataFilter
- Create: `sidecar-rs/crates/ob2-storage/src/backend.rs` — `trait StorageBackend`
- Create: `sidecar-rs/crates/ob2-storage/src/sqlite_vec.rs` — `SqliteVecBackend` impl
- Modify: `sidecar-rs/crates/ob2-storage/src/lib.rs`
- Create: `sidecar-rs/crates/ob2-storage/tests/sqlite_vec.rs`
- Extend: `tests/sidecar-golden/fixtures/capture.jsonl`, `delete.jsonl`, `knowledge_stats.jsonl`, `list_domains.jsonl`, `has_source.jsonl`, `record_source.jsonl`, `upsert_alias.jsonl`, `resolve_alias.jsonl`, `list_aliases.jsonl`, `delete_domain.jsonl`

Reference: `/mnt/c/projects/OB2/retrieval/storage/sqlite_vec.py` (588 LOC). Port DDL **verbatim** so on-disk format is bit-compatible with Python.

- [ ] **Step 1: Add deps**

`sidecar-rs/crates/ob2-storage/Cargo.toml`:
```toml
[dependencies]
# ... existing ...
rusqlite = { version = "0.32", features = ["bundled", "load_extension", "blob", "chrono"] }
sqlite-vec = "0.1"
parking_lot = "0.12"
chrono.workspace = true
ndarray.workspace = true
```

- [ ] **Step 2: Types module** (`types.rs`)

Mirror Python dataclasses in `retrieval/storage/backend.py`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocRecord {
    pub doc_id: String,
    pub text: String,
    pub metadata: serde_json::Value, // JSON object
    pub source_hash: Option<String>,
    pub embedding: Vec<f32>, // 384 dim
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocHit {
    pub doc_id: String,
    pub content: String,
    pub score: f32,
    pub match_reason: String,
    pub tags: Vec<String>,
    pub source: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainStats {
    pub domain: String,
    pub doc_count: i64,
    pub total_bytes: i64,
    pub oldest_at: Option<String>,
    pub newest_at: Option<String>,
    pub exists: bool,
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum StorageError {
    #[error("database error: {0}")] Db(#[from] rusqlite::Error),
    #[error("doc not found: {0}")] NotFound(String),
    #[error("invalid metadata filter: {0}")] FilterInvalid(String),
    #[error("embedding dimension mismatch: got {got}, expected {want}")] DimMismatch { got: usize, want: usize },
}
```

- [ ] **Step 3: Backend trait** (`backend.rs`)

```rust
use crate::types::{DocRecord, DocHit, DomainStats, StorageError};

pub trait StorageBackend: Send + Sync {
    fn capture(&self, domain: &str, doc: DocRecord) -> Result<i64, StorageError>;
    fn capture_batch(&self, domain: &str, docs: Vec<DocRecord>) -> Result<i64, StorageError>;
    fn cosine_search(&self, domain: &str, query_vec: &[f32], top_k: usize) -> Result<Vec<DocHit>, StorageError>;
    fn get_all_docs(&self, domain: &str) -> Result<Vec<DocRecord>, StorageError>;
    fn delete(&self, domain: &str, doc_id: &str) -> Result<bool, StorageError>;
    fn delete_domain(&self, domain: &str) -> Result<i64, StorageError>;
    fn domain_stats(&self, domain: Option<&str>) -> Result<Vec<DomainStats>, StorageError>;
    fn list_domains(&self) -> Result<Vec<String>, StorageError>;
    fn has_source(&self, domain: &str, source_id: &str, content_hash: &str) -> Result<bool, StorageError>;
    fn record_source(&self, domain: &str, source_id: &str, content_hash: &str, chunks: i64) -> Result<(), StorageError>;
    fn upsert_alias(&self, domain: &str, alias: &str, canonical: &str) -> Result<(), StorageError>;
    fn resolve_alias(&self, domain: &str, alias: &str) -> Result<Option<String>, StorageError>;
    fn list_aliases(&self, domain: &str) -> Result<Vec<(String, String)>, StorageError>;
    fn list_unsynced(&self, limit: i64) -> Result<Vec<(i64, String, DocRecord)>, StorageError>;
    fn mark_synced(&self, doc_keys: &[i64]) -> Result<(), StorageError>;
}
```

- [ ] **Step 4: SQLite backend** (`sqlite_vec.rs`)

Port each method from `retrieval/storage/sqlite_vec.py`. Key invariants:
- DDL verbatim from Python (lines 48-78).
- `docs_vec` virtual table via `sqlite_vec::load(&conn)` + `CREATE VIRTUAL TABLE docs_vec USING vec0(embedding float[384])`.
- WAL mode: `PRAGMA journal_mode=WAL`.
- All SQL parameterized — never string-interpolate user input.
- Thread-safety via `parking_lot::Mutex<Connection>` (match Python's instance lock).

Pattern for one method (capture):
```rust
pub struct SqliteVecBackend { conn: parking_lot::Mutex<rusqlite::Connection>, dim: usize }

impl SqliteVecBackend {
    pub fn open(path: &str, dim: usize) -> Result<Self, StorageError> {
        let conn = rusqlite::Connection::open(path)?;
        unsafe { conn.load_extension_enable()?; }
        sqlite_vec::load(&conn)?;
        unsafe { conn.load_extension_disable()?; }
        conn.pragma_update(None, "journal_mode", "WAL")?;
        // DDL ... (port verbatim from Python sqlite_vec.py:48-78)
        Ok(Self { conn: parking_lot::Mutex::new(conn), dim })
    }
}

impl StorageBackend for SqliteVecBackend {
    fn capture(&self, domain: &str, doc: DocRecord) -> Result<i64, StorageError> {
        if doc.embedding.len() != self.dim {
            return Err(StorageError::DimMismatch { got: doc.embedding.len(), want: self.dim });
        }
        let conn = self.conn.lock();
        // INSERT INTO docs + INSERT INTO docs_vec with rowid alignment
        // ... port from sqlite_vec.py:capture
        todo!("port from retrieval/storage/sqlite_vec.py")
    }
    // ... all 15 trait methods
}
```

- [ ] **Step 5: Unit tests**

`sidecar-rs/crates/ob2-storage/tests/sqlite_vec.rs` — exercise each trait method against a tmp-file DB:
```rust
use ob2_storage::{SqliteVecBackend, StorageBackend, DocRecord};

fn fixture_doc(id: &str, text: &str) -> DocRecord {
    DocRecord {
        doc_id: id.into(),
        text: text.into(),
        metadata: serde_json::json!({}),
        source_hash: None,
        embedding: vec![0.1; 384],
    }
}

#[test]
fn capture_then_cosine_search_finds_doc() {
    let tmp = tempfile::NamedTempFile::new().unwrap();
    let backend = SqliteVecBackend::open(tmp.path().to_str().unwrap(), 384).unwrap();
    backend.capture("infra", fixture_doc("web-01", "hostname web-01 role web")).unwrap();
    let hits = backend.cosine_search("infra", &vec![0.1_f32; 384], 5).unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].doc_id, "web-01");
}
// ... one test per trait method
```

- [ ] **Step 6: Regen fixtures + verify Python side passes**

```bash
cd /mnt/c/projects/OB2
python tests/sidecar-golden/generate.py --regen
pytest tests/sidecar-golden/test_python.py -v
# Expect: N passed (for each method in scope for this task)
```

- [ ] **Step 7: Commit**

```bash
git add sidecar-rs/crates/ob2-storage/ tests/sidecar-golden/fixtures/
git commit -m "$(cat <<'EOF'
rust-sidecar: sqlite-vec storage backend

StorageBackend trait + SqliteVecBackend impl (port from
retrieval/storage/sqlite_vec.py). DDL verbatim for on-disk compat.
Unit tests against a tmp DB cover all 15 trait methods. Golden
fixtures added for capture, delete, knowledge_stats, list_domains,
has_source, record_source, upsert_alias, resolve_alias,
list_aliases, delete_domain — all passing on Python side.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `ob2-embedder` — fastembed + EmbedBatcher

**Files:**
- Modify: `sidecar-rs/crates/ob2-embedder/Cargo.toml`
- Create: `sidecar-rs/crates/ob2-embedder/src/model.rs`
- Create: `sidecar-rs/crates/ob2-embedder/src/batcher.rs`
- Modify: `sidecar-rs/crates/ob2-embedder/src/lib.rs`

Reference: `/mnt/c/projects/OB2/retrieval/embed_batcher.py`, `/mnt/c/projects/OB2/retrieval/sidecar.py:87-127`.

- [ ] **Step 1: Add deps**

```toml
[dependencies]
# ... existing ...
fastembed = { version = "4", features = ["ort-load-dynamic"] }
tokio.workspace = true
ndarray.workspace = true

[features]
default = []
cuda = ["fastembed/ort-cuda"]
```

`cuda` feature is opt-in. Default CPU build compiles without pulling CUDA.

- [ ] **Step 2: Model wrapper**

`src/model.rs`:
```rust
use anyhow::Result;
use fastembed::{TextEmbedding, InitOptions, EmbeddingModel};
use std::sync::Arc;

pub struct Embedder {
    model: Arc<TextEmbedding>,
    dim: usize,
    name: String,
    provider: String, // "cpu" | "cuda"
}

impl Embedder {
    pub fn load(model_name: &str) -> Result<Self> {
        let opts = InitOptions::new(EmbeddingModel::AllMiniLML6V2);
        let model = TextEmbedding::try_new(opts)?;
        let provider = detect_provider();
        tracing::info!("embedder: {model_name} on {provider} (dim=384)");
        Ok(Self { model: Arc::new(model), dim: 384, name: model_name.into(), provider })
    }

    pub fn embed(&self, texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
        Ok(self.model.embed(texts, Some(64))?)
    }

    pub fn dim(&self) -> usize { self.dim }
    pub fn name(&self) -> &str { &self.name }
    pub fn provider(&self) -> &str { &self.provider }
}

fn detect_provider() -> String {
    // fastembed/ort picks provider at runtime; we can inspect via an env
    // probe since the ort API doesn't expose "what did you actually load"
    // cleanly until v3.
    if std::env::var("CUDA_VISIBLE_DEVICES").is_ok() && !cfg!(not(feature="cuda")) {
        "cuda:0".into()
    } else {
        "cpu".into()
    }
}
```

- [ ] **Step 3: EmbedBatcher**

`src/batcher.rs` — port `retrieval/embed_batcher.py` semantics:
```rust
use anyhow::Result;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, Mutex, Notify};

use crate::model::Embedder;

pub struct EmbedBatcher {
    tx: mpsc::Sender<Req>,
    stats: Arc<Mutex<BatcherStats>>,
}

struct Req {
    text: String,
    reply: oneshot::Sender<Result<Vec<f32>>>,
}

#[derive(Default, Clone, serde::Serialize)]
pub struct BatcherStats {
    pub available: bool,
    pub total_batches: u64,
    pub total_items: u64,
    pub avg_batch_ms: f64,
    pub avg_items_per_batch: f64,
}

impl EmbedBatcher {
    pub fn new(model: Arc<Embedder>, flush_ms: u64, max_batch: usize) -> (Self, Arc<Notify>) {
        let (tx, mut rx) = mpsc::channel::<Req>(1024);
        let stats = Arc::new(Mutex::new(BatcherStats { available: true, ..Default::default() }));
        let shutdown = Arc::new(Notify::new());
        let shutdown_w = shutdown.clone();
        let stats_w = stats.clone();
        tokio::spawn(async move {
            let mut buf: Vec<Req> = Vec::with_capacity(max_batch);
            let mut interval = tokio::time::interval(Duration::from_millis(flush_ms));
            loop {
                tokio::select! {
                    Some(req) = rx.recv() => {
                        buf.push(req);
                        if buf.len() >= max_batch {
                            flush(&model, &mut buf, &stats_w).await;
                        }
                    }
                    _ = interval.tick() => {
                        if !buf.is_empty() {
                            flush(&model, &mut buf, &stats_w).await;
                        }
                    }
                    _ = shutdown_w.notified() => {
                        if !buf.is_empty() {
                            flush(&model, &mut buf, &stats_w).await;
                        }
                        break;
                    }
                }
            }
        });
        (Self { tx, stats }, shutdown)
    }

    pub async fn embed_one(&self, text: String) -> Result<Vec<f32>> {
        let (rtx, rrx) = oneshot::channel();
        self.tx.send(Req { text, reply: rtx }).await?;
        rrx.await?
    }

    pub async fn stats(&self) -> BatcherStats {
        self.stats.lock().await.clone()
    }
}

async fn flush(model: &Arc<Embedder>, buf: &mut Vec<Req>, stats: &Arc<Mutex<BatcherStats>>) {
    let start = std::time::Instant::now();
    let texts: Vec<String> = buf.iter().map(|r| r.text.clone()).collect();
    let model2 = model.clone();
    let embeddings = tokio::task::spawn_blocking(move || model2.embed(texts)).await;
    let elapsed_ms = start.elapsed().as_millis() as f64;
    let n = buf.len();
    match embeddings {
        Ok(Ok(vecs)) => {
            for (req, vec) in buf.drain(..).zip(vecs) {
                let _ = req.reply.send(Ok(vec));
            }
        }
        Ok(Err(e)) => {
            let err = std::sync::Arc::new(e);
            for req in buf.drain(..) {
                let _ = req.reply.send(Err(anyhow::anyhow!("{}", err)));
            }
        }
        Err(join_err) => {
            for req in buf.drain(..) {
                let _ = req.reply.send(Err(anyhow::anyhow!("batcher join error: {join_err}")));
            }
        }
    }
    let mut s = stats.lock().await;
    s.total_batches += 1;
    s.total_items += n as u64;
    s.avg_batch_ms = (s.avg_batch_ms * (s.total_batches - 1) as f64 + elapsed_ms) / s.total_batches as f64;
    s.avg_items_per_batch = s.total_items as f64 / s.total_batches as f64;
}
```

- [ ] **Step 4: Warm-embedder CLI flag**

Add `--warm-embedder` to `ob2-sidecar` bin (Task 1 skeleton). When passed, load the embedder and exit. Used by Dockerfile pre-warm step.

- [ ] **Step 5: Unit test + golden extension**

```rust
#[tokio::test]
async fn batcher_returns_embedding_with_correct_dim() {
    let emb = Arc::new(Embedder::load("all-MiniLM-L6-v2").unwrap());
    let (batcher, _shutdown) = EmbedBatcher::new(emb.clone(), 100, 32);
    let v = batcher.embed_one("hello world".into()).await.unwrap();
    assert_eq!(v.len(), 384);
}
```

Fixture for `ping` is already there; now extend with `batcher_stats` fixture.

- [ ] **Step 6: Commit**

```bash
git add sidecar-rs/crates/ob2-embedder/ sidecar-rs/crates/ob2-sidecar/src/main.rs
git commit -m "$(cat <<'EOF'
rust-sidecar: fastembed + EmbedBatcher

Singleton TextEmbedding loaded once, wrapped in an Arc. Tokio-based
batcher with mpsc + interval matches Python embed_batcher.py: 100ms
flush window or 32-item max batch. ONNX inference wrapped in
spawn_blocking so the runtime doesn't stall. Stats exposed via
batcher_stats RPC (still to wire in Task 7). --warm-embedder flag
loads and exits, used by Dockerfile pre-warm.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `ob2-retriever` — TF-IDF + hybrid + Document

**Files:**
- Modify: `sidecar-rs/crates/ob2-retriever/Cargo.toml`
- Create: `sidecar-rs/crates/ob2-retriever/src/tokenizer.rs` — port stopwords + split logic
- Create: `sidecar-rs/crates/ob2-retriever/src/tfidf.rs` — TfIdfIndex
- Create: `sidecar-rs/crates/ob2-retriever/src/hybrid.rs` — alpha blending
- Create: `sidecar-rs/crates/ob2-retriever/src/document.rs` — Document type
- Modify: `sidecar-rs/crates/ob2-retriever/src/lib.rs`

Reference: `/mnt/c/projects/OB2/context-engine/retriever.py` (335 LOC).

- [ ] **Step 1: Deps**

```toml
[dependencies]
unicode-segmentation = "1"
regex = "1"
```

- [ ] **Step 2: Tokenizer — port verbatim**

Port the stopword list + tokenization from `context-engine/retriever.py`. This is load-bearing for golden-test equivalence.

- [ ] **Step 3: TfIdfIndex**

Port the TF-IDF logic. IDF formula must match Python exactly (`log((N + 1) / (df + 1)) + 1` or whatever the Python uses — read the source). Score rounding to 4 decimals.

- [ ] **Step 4: Hybrid scorer**

Alpha-blend TF-IDF with cosine scores. `match_reason` string formatting must match Python exactly (`"tfidf"`, `"semantic"`, `"hybrid"`).

- [ ] **Step 5: Unit tests + golden fixtures**

Port test cases from Python. Extend `tests/sidecar-golden/fixtures/retrieve.jsonl`.

- [ ] **Step 6: Commit**

```bash
git add sidecar-rs/crates/ob2-retriever/ tests/sidecar-golden/fixtures/retrieve.jsonl
git commit -m "$(cat <<'EOF'
rust-sidecar: TF-IDF + hybrid retrieval

Port from context-engine/retriever.py. Tokenizer + stopwords +
IDF formula verbatim. Hybrid scorer blends TF-IDF and cosine via
alpha (default 0.65). Match-reason strings match Python output.
Scores round to 4 decimals to match Python round(score, 4).
Golden fixture for retrieve method passing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `ob2-context` — compressor + ContextEngine

**Files:**
- Create: `sidecar-rs/crates/ob2-context/src/compressor.rs`
- Create: `sidecar-rs/crates/ob2-context/src/engine.rs`
- Modify: `sidecar-rs/crates/ob2-context/src/lib.rs`

Reference: `/mnt/c/projects/OB2/context-engine/compressor.py` (283 LOC) + `context_engineering.py` (183 LOC).

- [ ] **Step 1: Compressor strategies**

Port extractive, sentence, truncate. Token counting matches Python's approach (probably char-based or a simple split — confirm from source).

- [ ] **Step 2: ContextEngine**

Port the per-domain engine logic (index build, retrieve, compress-to-budget, metadata packet assembly).

- [ ] **Step 3: Unit tests + golden fixtures for `build_context`**

- [ ] **Step 4: Commit**

```bash
git add sidecar-rs/crates/ob2-context/ tests/sidecar-golden/fixtures/build_context.jsonl
git commit -m "$(cat <<'EOF'
rust-sidecar: context compressor + engine

Port from context-engine/compressor.py + context_engineering.py.
Extractive / sentence / truncate strategies; budget enforcement
exact match with Python. Per-domain engine cache mirrors Python's
_engines map (DashMap for lock-free reads).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `ob2-sidecar` — full dispatch + stdin loop

**Files:**
- Modify: `sidecar-rs/crates/ob2-sidecar/src/main.rs`
- Create: `sidecar-rs/crates/ob2-sidecar/src/methods.rs` (one handler per method)
- Create: `sidecar-rs/crates/ob2-sidecar/src/state.rs` — AppState wires embedder + storage + retriever + context
- Modify: `sidecar-rs/crates/ob2-sidecar/Cargo.toml` (depend on all 4 lib crates)

Reference: `/mnt/c/projects/OB2/retrieval/sidecar.py:523-547` (METHODS dict).

- [ ] **Step 1: AppState**

```rust
pub struct AppState {
    pub backend: Arc<dyn StorageBackend>,
    pub embedder: Arc<Embedder>,
    pub batcher: EmbedBatcher,
    pub engines: dashmap::DashMap<String, Arc<ContextEngine>>,
    pub classifier: parking_lot::Mutex<VecDeque<ClassifierDecision>>,
}

impl AppState {
    pub async fn from_env() -> Result<Arc<Self>> {
        let path = std::env::var("OB2_SQLITE_PATH").unwrap_or_else(|_| "./ob2.db".into());
        let backend = Arc::new(SqliteVecBackend::open(&path, 384)?) as Arc<dyn StorageBackend>;
        let embedder = Arc::new(Embedder::load("all-MiniLM-L6-v2")?);
        let (batcher, _shutdown) = EmbedBatcher::new(embedder.clone(), 100, 32);
        Ok(Arc::new(Self {
            backend, embedder, batcher,
            engines: dashmap::DashMap::new(),
            classifier: parking_lot::Mutex::new(VecDeque::with_capacity(100)),
        }))
    }
}
```

- [ ] **Step 2: Dispatch**

```rust
async fn dispatch(state: &AppState, method: &str, params: Value) -> anyhow::Result<Value> {
    match method {
        "ping" => methods::ping(state).await,
        "capture" => methods::capture(state, params).await,
        "capture_batch" => methods::capture_batch(state, params).await,
        "retrieve" => methods::retrieve(state, params).await,
        "build_context" => methods::build_context(state, params).await,
        "knowledge_stats" => methods::knowledge_stats(state, params).await,
        "list_domains" => methods::list_domains(state).await,
        "delete" => methods::delete(state, params).await,
        "delete_domain" => methods::delete_domain(state, params).await,
        "has_source" => methods::has_source(state, params).await,
        "record_source" => methods::record_source(state, params).await,
        "upsert_alias" => methods::upsert_alias(state, params).await,
        "resolve_alias" => methods::resolve_alias(state, params).await,
        "list_aliases" => methods::list_aliases(state, params).await,
        "suggest_domains" => methods::suggest_domains(state, params).await,
        "batcher_stats" => methods::batcher_stats(state).await,
        "record_classifier_decision" => methods::record_classifier(state, params).await,
        "classifier_stats" => methods::classifier_stats(state).await,
        "test_pgvector" => methods::test_pgvector(state, params).await,
        "sync_status" => methods::sync_status(state).await,
        other => Err(anyhow::anyhow!("method not found: {other}")),
    }
}
```

- [ ] **Step 3: Methods module**

One function per method in `methods.rs`. Each takes `&AppState + Value params`, returns `anyhow::Result<Value>`.

- [ ] **Step 4: Response funnel**

Spawn-task-per-request pattern from spec §Concurrency model. Use `mpsc::UnboundedSender<String>` for responses; single writer task drains and writes to stdout with newline atomicity.

- [ ] **Step 5: Full golden suite passes on Rust with sqlite backend**

```bash
cd sidecar-rs
cargo build --release
cd ..
# Add a Rust harness equivalent to test_python.py
# (can be a Python script that wraps the Rust binary — simplest)
OB2_SIDECAR_RUNTIME=rust pytest tests/sidecar-golden/test_both_runtimes.py -v
# Expect: all fixtures passing for sqlite-backed methods
```

- [ ] **Step 6: Commit**

```bash
git add sidecar-rs/
git commit -m "$(cat <<'EOF'
rust-sidecar: dispatch + stdin loop + all 20 methods

AppState wires embedder, storage, batcher, engines cache, classifier
ring buffer. One handler per method (methods.rs). Dispatch via match.
spawn-per-request + single writer task for newline atomicity. Full
golden suite passes against SqliteVecBackend (tier-2 backends land
in Tasks 8-9). Build release is ~180s on first run, ~8s incremental.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: `ob2-storage` — pgvector backend

**Files:**
- Modify: `sidecar-rs/crates/ob2-storage/Cargo.toml`
- Create: `sidecar-rs/crates/ob2-storage/src/pg_vector.rs`
- Modify: `sidecar-rs/crates/ob2-storage/src/lib.rs` (export PgVectorBackend)

Reference: `/mnt/c/projects/OB2/retrieval/storage/pg_vector.py` (447 LOC). DDL verbatim from lines 65-80.

- [ ] **Step 1: Deps**

```toml
[dependencies]
# ... existing ...
tokio-postgres = "0.7"
pgvector = { version = "0.4", features = ["postgres"] }
deadpool-postgres = "0.14"
```

- [ ] **Step 2: Async trait**

Because tokio-postgres is async, we need either:
- An async `StorageBackend` trait (requires `async-trait` crate or stable async-in-trait as of 1.80).
- Sync wrappers that use `tokio::runtime::Handle::current().block_on(...)`.

Pick **stable async-in-trait** (Rust 1.80 supports it). Convert `StorageBackend` from Task 3's sync trait to async:
```rust
pub trait StorageBackend: Send + Sync {
    async fn capture(&self, domain: &str, doc: DocRecord) -> Result<i64, StorageError>;
    // ... async everywhere
}
```

Sqlite impl from Task 3 wraps its calls in `tokio::task::spawn_blocking`. pgvector impl is natively async.

- [ ] **Step 3: PgVectorBackend impl**

Port from Python. Connection pool via deadpool-postgres. HNSW index DDL verbatim. `register_pgvector_types` must run on every pooled connection (reconnect hooks).

- [ ] **Step 4: Golden suite re-runs with pgvector backend**

```bash
OB2_STORAGE_BACKEND=pgvector OB2_PG_URL=... OB2_SIDECAR_RUNTIME=rust \
  pytest tests/sidecar-golden/test_both_runtimes.py -v
# Expect: same fixtures pass against pgvector
```

- [ ] **Step 5: Commit**

```bash
git add sidecar-rs/
git commit -m "$(cat <<'EOF'
rust-sidecar: pgvector storage backend

Port from retrieval/storage/pg_vector.py. tokio-postgres +
deadpool-postgres + pgvector crate with postgres feature. HNSW
index DDL verbatim. Pool reconnect hook runs pgvector type
registration on each new connection. StorageBackend trait
migrated to async-in-trait (Rust 1.80 stable). SqliteVecBackend
methods wrap their sync work in spawn_blocking. Golden suite
passes against pgvector backend.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: `ob2-storage` — two-tier + sync worker

**Files:**
- Create: `sidecar-rs/crates/ob2-storage/src/two_tier.rs`
- Modify: `sidecar-rs/crates/ob2-storage/src/lib.rs`
- Create: `sidecar-rs/crates/ob2-storage/tests/two_tier_soak.rs`

Reference: `/mnt/c/projects/OB2/retrieval/storage/two_tier.py` (192 LOC).

- [ ] **Step 1: TwoTierBackend struct**

Wraps two `Arc<dyn StorageBackend>` (sqlite tier-1 for writes, pgvector tier-2 for reads). All reads go to tier-2; all writes to tier-1; sync worker drains.

- [ ] **Step 2: SyncWorker tokio task**

```rust
async fn run_sync_worker(
    tier1: Arc<SqliteVecBackend>,
    tier2: Arc<PgVectorBackend>,
    status: Arc<RwLock<SyncStatus>>,
    shutdown: Arc<Notify>,
) {
    let mut interval = tokio::time::interval(Duration::from_secs(5));
    let mut backoff = Duration::from_secs(1);
    loop {
        tokio::select! {
            _ = interval.tick() => {
                match drain_once(&tier1, &tier2, &status).await {
                    Ok(_) => { backoff = Duration::from_secs(1); }
                    Err(_) => {
                        tokio::time::sleep(backoff).await;
                        backoff = (backoff * 2).min(Duration::from_secs(60));
                    }
                }
            }
            _ = shutdown.notified() => { let _ = drain_once(...).await; break; }
        }
    }
}
```

- [ ] **Step 3: Soak test**

`tests/two_tier_soak.rs` — 10k captures, kill mid-sync via channel signal, restart, verify all docs visible in tier-2.

- [ ] **Step 4: `sync_status` method wired**

- [ ] **Step 5: Commit**

```bash
git add sidecar-rs/
git commit -m "$(cat <<'EOF'
rust-sidecar: two-tier storage + sync worker

Port from retrieval/storage/two_tier.py. Writes go to SQLite
tier-1, reads from pgvector tier-2. Background tokio task drains
unsynced docs every 5s or at 256-doc threshold. Exponential
backoff on pgvector outage (1s → 60s cap). sync_status method
returns live status snapshot via lock-free RwLock read. Soak test
captures 10k docs, kills mid-sync, restarts, verifies no loss.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Dockerfile multi-stage + Deno toggle + CI parity job

**Files:**
- Modify: `Dockerfile`
- Modify: `docker/docker-compose.yml`
- Modify: `server/sidecar.ts`
- Modify: `server/config.ts`
- Create: `.github/workflows/sidecar-parity.yml`
- Extend: `tests/e2e.sh` (new Step 15)
- Modify: `docs/user-guide.md`

- [ ] **Step 1: Dockerfile rust-builder stage**

Before the existing runtime stage:
```dockerfile
FROM rust:1.80-slim AS rust-builder
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev \
 && rm -rf /var/lib/apt/lists/*
COPY sidecar-rs/ ./sidecar-rs/
RUN cd sidecar-rs && cargo build --release --bin ob2-sidecar
RUN /build/sidecar-rs/target/release/ob2-sidecar --warm-embedder
```

Runtime stage appends:
```dockerfile
COPY --from=rust-builder /build/sidecar-rs/target/release/ob2-sidecar /app/sidecar-rs/ob2-sidecar
COPY --from=rust-builder /root/.cache/fastembed /app/.cache/fastembed
ENV FASTEMBED_CACHE_PATH=/app/.cache/fastembed
```

- [ ] **Step 2: Deno toggle**

`server/sidecar.ts:43-50`:
```ts
async start(): Promise<void> {
  if (this.proc) return;
  const runtime = Deno.env.get("OB2_SIDECAR_RUNTIME") ?? "python";
  const [bin, args] = runtime === "rust"
    ? [this.config.rustSidecarBin, []]
    : [this.config.python, [this.config.sidecarScript]];
  const cmd = new Deno.Command(bin, {
    args,
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
    cwd: new URL(".", import.meta.url).pathname,
  });
  this.proc = cmd.spawn();
  // ... rest unchanged
}
```

`server/config.ts`:
```ts
// add field
rustSidecarBin: string;

// in loadConfig:
rustSidecarBin: optional("OB2_RUST_SIDECAR_BIN", "/app/sidecar-rs/ob2-sidecar"),
```

`docker/docker-compose.yml` service env:
```yaml
OB2_SIDECAR_RUNTIME: ${OB2_SIDECAR_RUNTIME:-}
OB2_RUST_SIDECAR_BIN: ${OB2_RUST_SIDECAR_BIN:-/app/sidecar-rs/ob2-sidecar}
```

- [ ] **Step 3: E2E Step 15 cross-runtime smoke**

`tests/e2e.sh` — new Step 15 runs after existing suite: restart server with `OB2_SIDECAR_RUNTIME=rust`, re-run a subset of Step 2-5 RAG assertions, verify identical results.

- [ ] **Step 4: CI parity job**

`.github/workflows/sidecar-parity.yml`:
```yaml
name: sidecar-parity

on:
  pull_request:
    paths:
      - 'retrieval/**'
      - 'context-engine/**'
      - 'sidecar-rs/**'
      - 'tests/sidecar-golden/**'

jobs:
  python-golden:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: '3.12' }
      - run: pip install -r retrieval/requirements.txt pytest
      - run: pytest tests/sidecar-golden/test_python.py -v

  rust-golden:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@1.80
      - uses: Swatinem/rust-cache@v2
      - run: cd sidecar-rs && cargo build --release
      - uses: actions/setup-python@v5
        with: { python-version: '3.12' }
      - run: pip install pytest
      - run: OB2_SIDECAR_RUNTIME=rust pytest tests/sidecar-golden/test_rust.py -v
```

- [ ] **Step 5: Docs**

`docs/user-guide.md` — new section "Switching the retrieval sidecar runtime":
- What `OB2_SIDECAR_RUNTIME` controls
- Default (`python`) and alternative (`rust`)
- Trade-offs (memory footprint, startup time)
- How to verify which runtime is active (look for `sidecar-rs` in process list, or observe startup log line)
- Rollback instructions (`OB2_SIDECAR_RUNTIME=python` + restart)

- [ ] **Step 6: End-to-end verification**

```bash
cd /mnt/c/projects/OB2
docker stop ob2-server
cd docker && docker compose build ob2-server && cd ..

# Python runtime baseline
OB2_SMTP_DRIVER=log OB2_PUBLIC_URL=http://127.0.0.1:7600 \
  OB2_SIDECAR_RUNTIME=python bash tests/e2e.sh
# Expected: 66/66 PASS

# Rust runtime
OB2_SMTP_DRIVER=log OB2_PUBLIC_URL=http://127.0.0.1:7600 \
  OB2_SIDECAR_RUNTIME=rust bash tests/e2e.sh
# Expected: 66/66 PASS with identical semantics
```

- [ ] **Step 7: Commit**

```bash
git add Dockerfile docker/docker-compose.yml server/sidecar.ts server/config.ts tests/e2e.sh docs/user-guide.md .github/workflows/sidecar-parity.yml
git commit -m "$(cat <<'EOF'
rust-sidecar: Dockerfile multi-stage + Deno toggle + CI parity

New FROM rust:1.80-slim AS rust-builder stage compiles ob2-sidecar
and pre-warms the fastembed cache. Runtime stage copies binary +
cache alongside the Python venv. server/sidecar.ts branches on
OB2_SIDECAR_RUNTIME (default python). docker-compose passes the
env var through. CI parity job runs golden suite against both
runtimes on every PR touching retrieval/ or sidecar-rs/.
tests/e2e.sh gets Step 15 that re-runs a subset against Rust.
user-guide documents the toggle.

Default remains python. Future PR flips to rust after ~2 weeks
of production evidence; then a separate spec retires Python.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Workspace + 5 crates | 1 |
| Golden fixture harness | 2 |
| `sqlite_vec` backend | 3 |
| Embedder + batcher | 4 |
| TF-IDF + hybrid | 5 |
| Compressor + engine | 6 |
| 20 JSON-RPC methods dispatched | 7 |
| `pg_vector` backend | 8 |
| `two_tier` + sync worker | 9 |
| Dockerfile multi-stage + Deno toggle + CI | 10 |

All 10 steps from spec §Staging covered.

**Known caveats:**
- Each task is multi-day engineering work. A subagent dispatching this plan should tolerate long runtime per task and multiple intermediate commits inside a single "task."
- Task 8 requires a migration of the `StorageBackend` trait from sync (Task 3) to async-in-trait. Task 3's implementer should know async is coming so Task 3's sync signatures aren't over-relied-on by callers.
- The golden fixture generator in Task 2 is sketched, not fully coded. The Task 2 implementer fleshes out the Popen-based driver pattern.
- Dependencies version-pin to majors; `Cargo.lock` is gitignored at Task 1, added to the repo at Task 10 once the tree stabilizes.

**Type consistency:**
- `StorageBackend` trait is sync in Task 3, async in Task 8. Migrate the SqliteVecBackend impl when Task 8 lands.
- `DocRecord`, `DocHit`, `DomainStats`, `StorageError` defined in Task 3 and reused throughout.
- `EmbedBatcher` API (Task 4): `embed_one`, `stats`, `new`. Consumed by AppState in Task 7.
- `Embedder` API (Task 4): `load`, `embed`, `dim`, `name`, `provider`. Consumed by batcher + app state.

**Known non-specificities (hand-waved):**
- Exact Python-to-Rust line-level port for ~3,400 LOC Python is not enumerated. The plan points each Task to its Python source file and expects the implementer to read it. The golden fixtures catch semantic drift.
- The Dockerfile CUDA opt-in path (operator mounts `/usr/local/cuda/lib64` or swaps base to `nvidia/cuda:12.2-runtime`) is documented in the spec but not scripted in Task 10 — operators handle their own GPU deploy.
