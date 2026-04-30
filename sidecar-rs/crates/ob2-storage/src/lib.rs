//! `ob2-storage` — storage backend trait + concrete impls.
//!
//! Ported from `retrieval/storage/*.py` (Python sidecar's storage layer).
//!
//! Exposes:
//!   * [`StorageBackend`]  — the async contract every backend implements.
//!   * [`SqliteVecBackend`] — Tier-1, SQLite + sqlite-vec.
//!   * [`PgVectorBackend`]  — Tier-2, Postgres + pgvector (Task 8).
//!   * [`TwoTierBackend`]   — coalescer: writes → tier-1, reads → tier-2,
//!                            background SyncWorker drains (Task 9).

pub mod backend;
pub mod pg_vector;
pub mod sqlite_vec;
pub mod two_tier;
pub mod types;

pub use backend::StorageBackend;
pub use pg_vector::PgVectorBackend;
pub use sqlite_vec::SqliteVecBackend;
pub use two_tier::{SyncStatus, TwoTierBackend};
pub use types::{DocHit, DocRecord, DomainStats, MetadataFilter, StorageError};
