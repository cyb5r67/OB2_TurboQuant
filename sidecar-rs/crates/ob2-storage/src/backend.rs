//! `StorageBackend` — Rust mirror of the Python `ABC` in
//! `retrieval/storage/backend.py:121`.
//!
//! Semantics (from the Python docstrings, preserved here for Rust callers):
//!
//! 1. `upsert_docs_batch(...)` is atomic — all or nothing on crash mid-batch.
//! 2. `query_similar(...)` returns hits ordered by DESC cosine similarity.
//! 3. `metadata_filter` DSL supports equality and `$in`; filters ANDed.
//! 4. All methods must be thread-safe; backends handle their own locking.
//! 5. `has_source(...)` returns true iff that exact content was imported before.
//! 6. Embeddings are `Vec<f32>` at the interface (normalized internally).
//!
//! Task 8: the trait is `async`. Rust 1.75+ supports async-in-trait natively,
//! but to keep `Arc<dyn StorageBackend>` dyn-safe we use the `async-trait`
//! crate — the macro rewrites each `async fn` into `fn ... -> Pin<Box<dyn
//! Future + Send>>`, which is object-safe today. Backends that are fundamentally
//! blocking (SQLite) wrap their bodies in `tokio::task::spawn_blocking`;
//! backends that are natively async (Postgres) call `.await` directly.

use async_trait::async_trait;

use crate::types::{DocHit, DocRecord, DomainStats, MetadataFilter, StorageError};

/// Persistence contract. All implementations must be `Send + Sync`.
#[async_trait]
pub trait StorageBackend: Send + Sync {
    // ── doc writes ──────────────────────────────────────────

    /// Insert or replace a single document in a domain.
    async fn upsert_doc(
        &self,
        domain: &str,
        doc_id: &str,
        text: &str,
        embedding: &[f32],
        metadata: &serde_json::Value,
        source_hash: &str,
    ) -> Result<i64, StorageError>;

    /// Atomically insert/replace a batch of docs in a domain.
    async fn upsert_docs_batch(
        &self,
        domain: &str,
        docs: &[DocRecord],
    ) -> Result<i64, StorageError>;

    // ── doc reads ───────────────────────────────────────────

    /// Cosine-similarity search within a domain.
    async fn query_similar(
        &self,
        domain: &str,
        query_embedding: &[f32],
        top_k: usize,
        metadata_filter: MetadataFilter<'_>,
    ) -> Result<Vec<DocHit>, StorageError>;

    /// Fetch one doc by id. Returns `Ok(None)` if not found.
    async fn get_doc(
        &self,
        domain: &str,
        doc_id: &str,
    ) -> Result<Option<DocRecord>, StorageError>;

    /// List docs in a domain, newest first. Useful for importers + admin UI.
    async fn list_docs(
        &self,
        domain: &str,
        limit: i64,
        offset: i64,
        metadata_filter: MetadataFilter<'_>,
    ) -> Result<Vec<DocRecord>, StorageError>;

    // ── doc deletes ─────────────────────────────────────────

    /// Delete one doc. Returns true iff the doc existed.
    async fn delete_doc(&self, domain: &str, doc_id: &str) -> Result<bool, StorageError>;

    /// Delete all docs + aliases + source_imports for a domain.
    async fn delete_domain(&self, domain: &str) -> Result<i64, StorageError>;

    // ── domain introspection ────────────────────────────────

    /// All domains that have at least one doc, sorted.
    async fn list_domains(&self) -> Result<Vec<String>, StorageError>;

    /// Aggregate stats for a domain.
    async fn domain_stats(&self, domain: &str) -> Result<DomainStats, StorageError>;

    // ── source-hash dedup (for bulk importers) ──────────────

    async fn has_source(
        &self,
        domain: &str,
        source_id: &str,
        content_hash: &str,
    ) -> Result<bool, StorageError>;

    async fn record_source_import(
        &self,
        domain: &str,
        source_id: &str,
        content_hash: &str,
        chunks_produced: i64,
    ) -> Result<(), StorageError>;

    // ── entity aliases ──────────────────────────────────────

    async fn upsert_alias(
        &self,
        domain: &str,
        alias: &str,
        canonical: &str,
    ) -> Result<(), StorageError>;

    async fn resolve_alias(
        &self,
        domain: &str,
        alias: &str,
    ) -> Result<Option<String>, StorageError>;

    async fn list_aliases(&self, domain: &str) -> Result<Vec<(String, String)>, StorageError>;

    // ── two-tier sync helpers ──────────────────────────────

    /// Return docs with `synced_at IS NULL`, oldest-first.
    async fn list_unsynced(&self, limit: i64) -> Result<Vec<DocRecord>, StorageError>;

    /// Set `synced_at = NOW` for the given doc_ids. Returns count updated.
    async fn mark_synced(&self, doc_ids: &[String]) -> Result<i64, StorageError>;
}
