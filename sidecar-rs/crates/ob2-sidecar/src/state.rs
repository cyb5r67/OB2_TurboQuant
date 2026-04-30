//! Shared state for RPC handlers.
//! Mirrors the module-level globals in `retrieval/sidecar.py`.
//!
//! Design:
//! - One process-global `AppState`, wrapped in `Arc` and passed to handlers.
//! - A single `SqliteVecBackend` (Task 7 only supports sqlite; pgvector +
//!   two-tier land in Tasks 8/9).
//! - A process-global `Embedder` + `EmbedBatcher` — model loads once.
//! - A per-domain `ContextEngine` cache — lazy-built via `engine_for(domain)`
//!   and invalidated on writes via `invalidate_engine(domain)`.
//! - A 100-slot classifier decision ring matching Python's
//!   `collections.deque(maxlen=100)`.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use ob2_context::engine::{EngineConfig, DEFAULT_HYBRID_ALPHA, DEFAULT_RETRIEVAL_TOP_K, DEFAULT_TOTAL_TOKEN_BUDGET};
use ob2_context::{ContextEngine, Strategy};
use ob2_embedder::{BatcherConfig, EmbedBatcher, Embedder, DEFAULT_DIM, DEFAULT_MODEL};
use ob2_storage::{PgVectorBackend, SqliteVecBackend, StorageBackend, TwoTierBackend};

use parking_lot::{Mutex, RwLock};
use tokio::sync::Mutex as AsyncMutex;

/// System prompt override matching `sidecar.py:186`.
pub const SIDECAR_SYSTEM_PROMPT: &str = "Use the sources below. If not in sources, say you don't know.";

pub struct AppState {
    pub backend: Arc<dyn StorageBackend>,
    /// Concrete two-tier handle, so `sync_status` RPC can read the worker
    /// state directly without downcasting the trait object.
    pub two_tier: Option<Arc<TwoTierBackend>>,
    pub embedder: Arc<Embedder>,
    /// Lazy batcher — created on first embed call so `ping` can report
    /// `batcher: null` before any RPC exercises the batcher (matches Python).
    pub batcher: RwLock<Option<Arc<EmbedBatcher>>>,
    pub batcher_config: BatcherConfig,

    pub engines: RwLock<HashMap<String, Arc<AsyncMutex<ContextEngine>>>>,

    pub classifier: Mutex<VecDeque<ClassifierDecision>>,
    pub classifier_counts: Mutex<ClassifierCounts>,

    // Config echoed in `ping` / stats.
    pub storage_backend_name: String,
    #[allow(dead_code)]
    pub embedding_dim: usize,
    pub default_token_budget: usize,
    pub default_top_k: usize,
    pub default_alpha: f32,
}

#[derive(Clone, serde::Serialize)]
pub struct ClassifierDecision {
    pub at: String,
    pub outcome: String,
    pub query: String,
    pub domain: serde_json::Value,
    pub confidence: serde_json::Value,
}

#[derive(Default, Clone, serde::Serialize)]
pub struct ClassifierCounts {
    pub routed: u64,
    pub passed: u64,
    pub denied: u64,
}

impl AppState {
    pub async fn from_env() -> anyhow::Result<Arc<Self>> {
        // Python defaults: see `retrieval/sidecar.py:62-71`.
        let sqlite_path = std::env::var("OB2_SQLITE_PATH").unwrap_or_else(|_| "./ob2.db".to_string());
        let storage_backend_name =
            std::env::var("OB2_STORAGE_BACKEND").unwrap_or_else(|_| "sqlite".to_string());
        let embedding_model =
            std::env::var("OB2_EMBEDDING_MODEL").unwrap_or_else(|_| DEFAULT_MODEL.to_string());
        let embedding_dim: usize = std::env::var("OB2_EMBEDDING_DIM")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(DEFAULT_DIM);
        let default_token_budget: usize = std::env::var("OB2_TOTAL_TOKEN_BUDGET")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(DEFAULT_TOTAL_TOKEN_BUDGET);
        let default_top_k: usize = std::env::var("OB2_RETRIEVAL_TOP_K")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(DEFAULT_RETRIEVAL_TOP_K);
        let default_alpha: f32 = std::env::var("OB2_HYBRID_ALPHA")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(DEFAULT_HYBRID_ALPHA);

        let mut two_tier_handle: Option<Arc<TwoTierBackend>> = None;
        let backend_arc: Arc<dyn StorageBackend> = match storage_backend_name.as_str() {
            "sqlite" => {
                let backend = SqliteVecBackend::open(&sqlite_path, embedding_dim)?;
                Arc::new(backend)
            }
            "pgvector" => {
                let url = std::env::var("OB2_PG_URL").map_err(|_| {
                    anyhow::anyhow!("OB2_PG_URL is required when OB2_STORAGE_BACKEND=pgvector")
                })?;
                let backend = PgVectorBackend::connect(&url, embedding_dim)
                    .await
                    .map_err(|e| anyhow::anyhow!("pgvector connect: {e}"))?;
                Arc::new(backend)
            }
            "two-tier" => {
                let url = std::env::var("OB2_PG_URL").map_err(|_| {
                    anyhow::anyhow!("OB2_PG_URL is required when OB2_STORAGE_BACKEND=two-tier")
                })?;
                let tier1 = Arc::new(SqliteVecBackend::open(&sqlite_path, embedding_dim)?);
                let tier2 = Arc::new(
                    PgVectorBackend::connect(&url, embedding_dim)
                        .await
                        .map_err(|e| anyhow::anyhow!("pgvector connect: {e}"))?,
                );
                // Optional env knobs so golden tests can dial the worker
                // down to interval=1s for quick drain convergence.
                let interval_secs: u64 = std::env::var("OB2_SYNC_INTERVAL_SEC")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(ob2_storage::two_tier::SYNC_INTERVAL_SECS);
                let threshold: i64 = std::env::var("OB2_SYNC_BATCH_THRESHOLD")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(ob2_storage::two_tier::BATCH_THRESHOLD);
                let tt = Arc::new(
                    TwoTierBackend::with_config(tier1, tier2, interval_secs, threshold).await,
                );
                two_tier_handle = Some(tt.clone());
                tt as Arc<dyn StorageBackend>
            }
            other => anyhow::bail!(
                "unknown OB2_STORAGE_BACKEND: {other:?} (supported: sqlite, pgvector, two-tier)"
            ),
        };

        let embedder = Arc::new(Embedder::load(&embedding_model)?);

        // Match Python env-var knobs (`OB2_BATCH_FLUSH_MS`, `OB2_BATCH_MAX_SIZE`).
        let flush_ms: f32 = std::env::var("OB2_BATCH_FLUSH_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(100.0);
        let max_batch: usize = std::env::var("OB2_BATCH_MAX_SIZE")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(32);
        let batcher_config = BatcherConfig {
            flush_interval: std::time::Duration::from_millis(flush_ms as u64),
            max_batch,
            channel_capacity: 1024,
        };

        // Python startup log — keep format identical so operators grep the
        // same substring in both runtimes.
        eprintln!(
            "ob2-retrieval sidecar started (backend={}, dim={}, embedder={}, budget={}, top_k={}, alpha={})",
            storage_backend_name,
            embedding_dim,
            "sentence-transformers",
            default_token_budget,
            default_top_k,
            default_alpha,
        );

        Ok(Arc::new(Self {
            backend: backend_arc,
            two_tier: two_tier_handle,
            embedder,
            batcher: RwLock::new(None),
            batcher_config,
            engines: RwLock::new(HashMap::new()),
            classifier: Mutex::new(VecDeque::with_capacity(100)),
            classifier_counts: Mutex::new(ClassifierCounts::default()),
            storage_backend_name,
            embedding_dim,
            default_token_budget,
            default_top_k,
            default_alpha,
        }))
    }

    /// Return the process batcher, lazily spawning it on first use.
    pub fn get_or_init_batcher(&self) -> Arc<EmbedBatcher> {
        if let Some(b) = self.batcher.read().as_ref() {
            return b.clone();
        }
        let mut w = self.batcher.write();
        if let Some(b) = w.as_ref() {
            return b.clone();
        }
        let b = Arc::new(EmbedBatcher::spawn(
            self.embedder.clone(),
            BatcherConfig {
                flush_interval: self.batcher_config.flush_interval,
                max_batch: self.batcher_config.max_batch,
                channel_capacity: self.batcher_config.channel_capacity,
            },
        ));
        *w = Some(b.clone());
        b
    }

    /// Has the batcher ever been spawned? Matches Python's
    /// `_batcher is not None` check in `method_ping` / `method_batcher_stats`.
    pub fn batcher_available(&self) -> bool {
        self.batcher.read().is_some()
    }

    pub fn invalidate_engine(&self, domain: &str) {
        self.engines.write().remove(domain);
    }

    /// Get-or-build engine for a domain. Reindexes from the backend on miss.
    pub async fn engine_for(
        &self,
        domain: &str,
    ) -> anyhow::Result<Arc<AsyncMutex<ContextEngine>>> {
        if let Some(e) = self.engines.read().get(domain) {
            return Ok(e.clone());
        }

        let config = EngineConfig {
            total_token_budget: self.default_token_budget,
            retrieval_top_k: self.default_top_k,
            compression_strategy: Strategy::Extractive,
            hybrid_alpha: self.default_alpha,
            system_prompt: SIDECAR_SYSTEM_PROMPT.to_string(),
        };

        let mut engine = ContextEngine::new(self.backend.clone(), domain.to_string(), config)
            .map_err(|e| anyhow::anyhow!("create engine: {e}"))?;
        engine
            .reindex()
            .await
            .map_err(|e| anyhow::anyhow!("reindex engine: {e}"))?;

        let mut w = self.engines.write();
        // Double-check someone else didn't race us while we were reindexing.
        if let Some(e) = w.get(domain) {
            return Ok(e.clone());
        }
        let arc = Arc::new(AsyncMutex::new(engine));
        w.insert(domain.to_string(), arc.clone());
        Ok(arc)
    }
}
