//! Public types crossing the StorageBackend interface.
//!
//! Mirrors `retrieval/storage/backend.py` dataclasses. Kept Rust-idiomatic where
//! possible (e.g. `Option<String>` for nullable fields) but semantically
//! equivalent to the Python counterparts so that golden fixtures round-trip.

use serde::{Deserialize, Serialize};

/// A document as stored and returned by the backend.
///
/// Mirrors Python `DocRecord` (see `retrieval/storage/backend.py:45`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocRecord {
    pub doc_id: String,
    pub domain: String,
    pub text: String,
    /// JSON object — typically `{"source": "...", "tags": [...]}` plus any
    /// custom fields. Stored verbatim as a JSON TEXT column in SQLite.
    #[serde(default = "default_metadata")]
    pub metadata: serde_json::Value,
    /// SHA-256 of source chunk, for dedup. Empty string if not from a source
    /// import (matches Python semantics — Python uses "" rather than None).
    #[serde(default)]
    pub source_hash: String,
    /// Shape (D,), dtype float32 on the Python side. Backends normalize to
    /// whatever they store but return `Vec<f32>` to callers.
    pub embedding: Vec<f32>,
}

fn default_metadata() -> serde_json::Value {
    serde_json::Value::Object(Default::default())
}

/// A retrieval hit: doc + similarity score.
///
/// Mirrors Python `DocHit` (see `retrieval/storage/backend.py:65`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocHit {
    pub doc_id: String,
    pub text: String,
    pub metadata: serde_json::Value,
    /// Cosine similarity in [-1, 1]; callers can clip/threshold as needed.
    pub score: f32,
    /// ISO-8601 capture timestamp. Mirrors Python `DocHit.created_at`.
    #[serde(default)]
    pub created_at: String,
}

/// Aggregate info for one domain.
///
/// Mirrors Python `DomainStats` (see `retrieval/storage/backend.py:75`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DomainStats {
    pub domain: String,
    pub doc_count: i64,
    pub total_bytes: i64,
    pub oldest_at: Option<String>,
    pub newest_at: Option<String>,
}

/// Metadata filter DSL — see `retrieval/storage/backend.py:94`.
///
/// Currently supported shapes:
///   * `{"key": value}`                    — equality
///   * `{"key": {"$in": [v1, v2, ...]}}`   — set membership
///
/// Multiple keys are ANDed.
pub type MetadataFilter<'a> = Option<&'a serde_json::Value>;

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("postgres error: {0}")]
    Pg(String),

    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("doc not found: {0}")]
    NotFound(String),

    #[error("embedding dimension mismatch: got {got}, expected {want}")]
    DimMismatch { got: usize, want: usize },

    #[error("extension load failed: {0}")]
    ExtensionLoad(String),

    #[error("invalid input: {0}")]
    Invalid(String),
}

impl From<tokio_postgres::Error> for StorageError {
    fn from(e: tokio_postgres::Error) -> Self {
        StorageError::Pg(e.to_string())
    }
}

impl From<deadpool_postgres::PoolError> for StorageError {
    fn from(e: deadpool_postgres::PoolError) -> Self {
        StorageError::Pg(format!("pool: {e}"))
    }
}
