//! TwoTierBackend — writes to SqliteVecBackend (tier-1) for low-latency
//! captures; reads from PgVectorBackend (tier-2) for HNSW-indexed search.
//! A background SyncWorker drains unsync'd docs from tier-1 to tier-2.
//!
//! Ported from `retrieval/storage/two_tier.py` — per-method routing
//! matches the Python reference exactly:
//!
//!   * writes (`upsert_doc`, `upsert_docs_batch`)        → tier-1 only
//!   * reads (`query_similar`, `get_doc`, `list_docs`)   → tier-2 with tier-1
//!                                                         fallback on error
//!   * deletes                                           → fan-out to both
//!   * introspection (`list_domains`, `domain_stats`)    → tier-2 merged with
//!                                                         tier-1 pending
//!   * source dedup / aliases                            → tier-2 canonical,
//!                                                         also mirrored to
//!                                                         tier-1 so dedup
//!                                                         works offline
//!   * `list_unsynced`/`mark_synced`                     → tier-1 only
//!                                                         (called by worker)

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use parking_lot::RwLock;
use tokio::sync::Notify;

use crate::backend::StorageBackend;
use crate::pg_vector::PgVectorBackend;
use crate::sqlite_vec::SqliteVecBackend;
use crate::types::{DocHit, DocRecord, DomainStats, MetadataFilter, StorageError};

// ─────────────────────────────────────────────────────────────
// Sync worker tunables — mirror Python defaults in two_tier.py.
// ─────────────────────────────────────────────────────────────

pub const SYNC_INTERVAL_SECS: u64 = 5;
pub const BATCH_THRESHOLD: i64 = 256;
pub const BACKOFF_MIN_MS: u64 = 1_000;
pub const BACKOFF_MAX_MS: u64 = 60_000;
/// Max wall time we allow `drain_once` to run at shutdown before giving up.
pub const SHUTDOWN_DRAIN_TIMEOUT_SECS: u64 = 10;

/// Sync-worker status as exposed by the `sync_status` RPC.
///
/// Shape mirrors `SyncWorker.status()` in `retrieval/storage/two_tier.py`
/// except the Rust port exposes two extra fields (`backoff_ms`,
/// `last_error`) that are useful for ops dashboards. They default to
/// zero / null which preserves the Python-only response surface.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SyncStatus {
    pub pending_docs: i64,
    pub last_sync_at: Option<String>,
    pub last_sync_docs: i64,
    /// Milliseconds, rounded to 1 decimal place on the wire.
    pub last_sync_ms: f64,
    pub pgvector_reachable: bool,
    /// Current backoff duration; 0 when healthy.
    pub backoff_ms: u64,
    /// Most recent error message (if any). Truncated to ~200 chars.
    pub last_error: Option<String>,
}

impl Default for SyncStatus {
    fn default() -> Self {
        Self {
            pending_docs: 0,
            last_sync_at: None,
            last_sync_docs: 0,
            last_sync_ms: 0.0,
            pgvector_reachable: true,
            backoff_ms: 0,
            last_error: None,
        }
    }
}

pub struct TwoTierBackend {
    tier1: Arc<SqliteVecBackend>,
    tier2: Arc<PgVectorBackend>,
    status: Arc<RwLock<SyncStatus>>,
    shutdown: Arc<Notify>,
}

impl TwoTierBackend {
    /// Wrap an already-open tier-1 + tier-2 and start the sync worker.
    pub async fn new(tier1: Arc<SqliteVecBackend>, tier2: Arc<PgVectorBackend>) -> Self {
        Self::with_config(tier1, tier2, SYNC_INTERVAL_SECS, BATCH_THRESHOLD).await
    }

    /// Like `new` but lets callers override the tick interval / batch size
    /// (the golden test suite dials both down so drains happen quickly).
    pub async fn with_config(
        tier1: Arc<SqliteVecBackend>,
        tier2: Arc<PgVectorBackend>,
        interval_secs: u64,
        batch_threshold: i64,
    ) -> Self {
        // Seed pending_docs from disk so the first `sync_status` call before
        // any tick returns the real backlog, not zero.
        let initial_pending = tier1.pending_sync_count().unwrap_or(0);
        let status = Arc::new(RwLock::new(SyncStatus {
            pending_docs: initial_pending,
            ..Default::default()
        }));
        let shutdown = Arc::new(Notify::new());
        let worker = SyncWorker {
            tier1: tier1.clone(),
            tier2: tier2.clone(),
            status: status.clone(),
            shutdown: shutdown.clone(),
            interval: Duration::from_secs(interval_secs.max(1)),
            batch_threshold,
        };
        tokio::spawn(worker.run());
        Self {
            tier1,
            tier2,
            status,
            shutdown,
        }
    }

    /// Snapshot of the sync worker state.
    pub fn status(&self) -> SyncStatus {
        // Refresh `pending_docs` from SQLite lazily — cheap count(*) on the
        // partial index, and this keeps the RPC up-to-date even between ticks.
        let pending = self.tier1.pending_sync_count().unwrap_or(0);
        let mut s = self.status.write();
        s.pending_docs = pending;
        s.clone()
    }

    /// Signal the worker to drain once more (best-effort) and stop.
    pub fn shutdown(&self) {
        self.shutdown.notify_waiters();
    }
}

impl Drop for TwoTierBackend {
    fn drop(&mut self) {
        self.shutdown();
    }
}

// ─────────────────────────────────────────────────────────────
// SyncWorker
// ─────────────────────────────────────────────────────────────

struct SyncWorker {
    tier1: Arc<SqliteVecBackend>,
    tier2: Arc<PgVectorBackend>,
    status: Arc<RwLock<SyncStatus>>,
    shutdown: Arc<Notify>,
    interval: Duration,
    batch_threshold: i64,
}

impl SyncWorker {
    async fn run(self) {
        let mut ticker = tokio::time::interval(self.interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // The first tick fires immediately — skip it so we behave like
        // Python's `while not stop: drain(); stop.wait(interval)`.
        ticker.tick().await;

        let mut backoff_ms = BACKOFF_MIN_MS;

        loop {
            tokio::select! {
                _ = ticker.tick() => {
                    match self.drain_once().await {
                        Ok(_) => {
                            backoff_ms = BACKOFF_MIN_MS;
                            let mut s = self.status.write();
                            s.pgvector_reachable = true;
                            s.backoff_ms = 0;
                            s.last_error = None;
                        }
                        Err(e) => {
                            let msg = truncate_err(&e.to_string());
                            tracing::warn!("sync drain failed: {msg}");
                            {
                                let mut s = self.status.write();
                                s.pgvector_reachable = false;
                                s.backoff_ms = backoff_ms;
                                s.last_error = Some(msg);
                            }
                            // Hold off before the next tick — this acts as
                            // exponential backoff on top of the 5s interval.
                            tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                            backoff_ms = (backoff_ms.saturating_mul(2)).min(BACKOFF_MAX_MS);
                        }
                    }
                }
                _ = self.shutdown.notified() => {
                    // Best-effort final drain, capped so we can't hang forever.
                    let _ = tokio::time::timeout(
                        Duration::from_secs(SHUTDOWN_DRAIN_TIMEOUT_SECS),
                        self.drain_once(),
                    )
                    .await;
                    return;
                }
            }

            // If the backlog crossed the batch threshold since the last tick,
            // drain again immediately instead of waiting another interval.
            // Matches the Python comment in two_tier.py that says "or when
            // the buffer hits a batch threshold".
            if let Ok(pending) = self.tier1.pending_sync_count() {
                if pending >= self.batch_threshold {
                    ticker.reset_immediately();
                }
            }
        }
    }

    async fn drain_once(&self) -> anyhow::Result<()> {
        let started = std::time::Instant::now();
        let unsynced = self.tier1.list_unsynced(self.batch_threshold).await?;
        if unsynced.is_empty() {
            let mut s = self.status.write();
            s.pending_docs = 0;
            return Ok(());
        }

        // Capture the exact ids we'll be flushing — use these (not a re-read)
        // so we never mark-synced docs that weren't actually sent.
        let doc_ids: Vec<String> = unsynced.iter().map(|d| d.doc_id.clone()).collect();
        let n = unsynced.len() as i64;

        // Group by domain — matches Python so each domain gets an atomic
        // txn on the pgvector side.
        let mut by_domain: std::collections::HashMap<String, Vec<DocRecord>> =
            std::collections::HashMap::new();
        for doc in unsynced {
            by_domain.entry(doc.domain.clone()).or_default().push(doc);
        }
        for (domain, docs) in by_domain {
            self.tier2.upsert_docs_batch(&domain, &docs).await?;
        }

        self.tier1.mark_synced(&doc_ids).await?;

        let elapsed_ms = (started.elapsed().as_secs_f64() * 1000.0 * 10.0).round() / 10.0;
        let now = chrono::Utc::now()
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, false);
        {
            let mut s = self.status.write();
            s.last_sync_at = Some(now);
            s.last_sync_docs = n;
            s.last_sync_ms = elapsed_ms;
            s.pending_docs = self.tier1.pending_sync_count().unwrap_or(0);
        }
        tracing::info!("synced {} docs to pgvector in {:.0}ms", n, elapsed_ms);
        Ok(())
    }
}

fn truncate_err(s: &str) -> String {
    if s.len() > 200 {
        s.chars().take(200).collect()
    } else {
        s.to_string()
    }
}

// ─────────────────────────────────────────────────────────────
// StorageBackend impl — per-method routing mirrors two_tier.py.
// ─────────────────────────────────────────────────────────────

#[async_trait]
impl StorageBackend for TwoTierBackend {
    // ── writes → tier-1 only ───────────────────────────────

    async fn upsert_doc(
        &self,
        domain: &str,
        doc_id: &str,
        text: &str,
        embedding: &[f32],
        metadata: &serde_json::Value,
        source_hash: &str,
    ) -> Result<i64, StorageError> {
        self.tier1
            .upsert_doc(domain, doc_id, text, embedding, metadata, source_hash)
            .await
    }

    async fn upsert_docs_batch(
        &self,
        domain: &str,
        docs: &[DocRecord],
    ) -> Result<i64, StorageError> {
        self.tier1.upsert_docs_batch(domain, docs).await
    }

    // ── reads → tier-2 primary, tier-1 fallback ───────────

    async fn query_similar(
        &self,
        domain: &str,
        query_embedding: &[f32],
        top_k: usize,
        metadata_filter: MetadataFilter<'_>,
    ) -> Result<Vec<DocHit>, StorageError> {
        match self
            .tier2
            .query_similar(domain, query_embedding, top_k, metadata_filter)
            .await
        {
            Ok(hits) if !hits.is_empty() => Ok(hits),
            // Python: if pgvector returns empty, try SQLite (maybe docs
            // haven't synced yet). If it errors, same fallback.
            Ok(_) => {
                self.tier1
                    .query_similar(domain, query_embedding, top_k, metadata_filter)
                    .await
            }
            Err(e) => {
                tracing::warn!("pgvector query failed, falling back to SQLite: {e}");
                self.tier1
                    .query_similar(domain, query_embedding, top_k, metadata_filter)
                    .await
            }
        }
    }

    async fn get_doc(
        &self,
        domain: &str,
        doc_id: &str,
    ) -> Result<Option<DocRecord>, StorageError> {
        match self.tier2.get_doc(domain, doc_id).await {
            Ok(Some(d)) => Ok(Some(d)),
            _ => self.tier1.get_doc(domain, doc_id).await,
        }
    }

    async fn list_docs(
        &self,
        domain: &str,
        limit: i64,
        offset: i64,
        metadata_filter: MetadataFilter<'_>,
    ) -> Result<Vec<DocRecord>, StorageError> {
        match self
            .tier2
            .list_docs(domain, limit, offset, metadata_filter)
            .await
        {
            Ok(docs) if !docs.is_empty() => Ok(docs),
            _ => {
                self.tier1
                    .list_docs(domain, limit, offset, metadata_filter)
                    .await
            }
        }
    }

    // ── deletes → fan-out ──────────────────────────────────

    async fn delete_doc(&self, domain: &str, doc_id: &str) -> Result<bool, StorageError> {
        let pg_ok = self.tier2.delete_doc(domain, doc_id).await.unwrap_or(false);
        let sq_ok = self.tier1.delete_doc(domain, doc_id).await?;
        Ok(pg_ok || sq_ok)
    }

    async fn delete_domain(&self, domain: &str) -> Result<i64, StorageError> {
        let pg_count = self.tier2.delete_domain(domain).await.unwrap_or(0);
        let sq_count = self.tier1.delete_domain(domain).await?;
        Ok(pg_count.max(sq_count))
    }

    // ── introspection → tier-2 canonical, tier-1 pending ──

    async fn list_domains(&self) -> Result<Vec<String>, StorageError> {
        match self.tier2.list_domains().await {
            Ok(pg_domains) => {
                // Merge in any SQLite-only domains (newly captured, not yet
                // synced). Preserve pgvector's ordering; append sqlite-only
                // domains sorted.
                let sq_domains = self.tier1.list_domains().await.unwrap_or_default();
                let mut seen: std::collections::BTreeSet<String> =
                    pg_domains.iter().cloned().collect();
                let mut merged = pg_domains;
                let mut extras: Vec<String> = sq_domains
                    .into_iter()
                    .filter(|d| !seen.contains(d))
                    .collect();
                extras.sort();
                for d in extras {
                    if seen.insert(d.clone()) {
                        merged.push(d);
                    }
                }
                Ok(merged)
            }
            Err(_) => self.tier1.list_domains().await,
        }
    }

    async fn domain_stats(&self, domain: &str) -> Result<DomainStats, StorageError> {
        match self.tier2.domain_stats(domain).await {
            Ok(pg_stats) => {
                // Add pending unsync'd docs for this domain so consumers see
                // the true "how many docs are in this domain" number.
                let pending_for_domain = self
                    .tier1
                    .list_unsynced(100_000)
                    .await
                    .map(|docs| docs.iter().filter(|d| d.domain == domain).count() as i64)
                    .unwrap_or(0);
                if pending_for_domain == 0 {
                    return Ok(pg_stats);
                }
                Ok(DomainStats {
                    domain: pg_stats.domain,
                    doc_count: pg_stats.doc_count + pending_for_domain,
                    total_bytes: pg_stats.total_bytes,
                    oldest_at: pg_stats.oldest_at,
                    newest_at: pg_stats.newest_at,
                })
            }
            Err(_) => self.tier1.domain_stats(domain).await,
        }
    }

    // ── source dedup: check tier-2, fall back; write to both ──

    async fn has_source(
        &self,
        domain: &str,
        source_id: &str,
        content_hash: &str,
    ) -> Result<bool, StorageError> {
        match self.tier2.has_source(domain, source_id, content_hash).await {
            Ok(true) => Ok(true),
            _ => self.tier1.has_source(domain, source_id, content_hash).await,
        }
    }

    async fn record_source_import(
        &self,
        domain: &str,
        source_id: &str,
        content_hash: &str,
        chunks_produced: i64,
    ) -> Result<(), StorageError> {
        // Fan-out to both so dedup works regardless of which backend is queried.
        let _ = self
            .tier2
            .record_source_import(domain, source_id, content_hash, chunks_produced)
            .await;
        self.tier1
            .record_source_import(domain, source_id, content_hash, chunks_produced)
            .await
    }

    // ── aliases → tier-2 canonical, mirrored to tier-1 ────

    async fn upsert_alias(
        &self,
        domain: &str,
        alias: &str,
        canonical: &str,
    ) -> Result<(), StorageError> {
        let _ = self.tier2.upsert_alias(domain, alias, canonical).await;
        self.tier1.upsert_alias(domain, alias, canonical).await
    }

    async fn resolve_alias(
        &self,
        domain: &str,
        alias: &str,
    ) -> Result<Option<String>, StorageError> {
        match self.tier2.resolve_alias(domain, alias).await {
            Ok(Some(s)) => Ok(Some(s)),
            _ => self.tier1.resolve_alias(domain, alias).await,
        }
    }

    async fn list_aliases(&self, domain: &str) -> Result<Vec<(String, String)>, StorageError> {
        match self.tier2.list_aliases(domain).await {
            Ok(v) => Ok(v),
            Err(_) => self.tier1.list_aliases(domain).await,
        }
    }

    // ── sync helpers → tier-1 only ─────────────────────────

    async fn list_unsynced(&self, limit: i64) -> Result<Vec<DocRecord>, StorageError> {
        self.tier1.list_unsynced(limit).await
    }

    async fn mark_synced(&self, doc_ids: &[String]) -> Result<i64, StorageError> {
        self.tier1.mark_synced(doc_ids).await
    }
}
