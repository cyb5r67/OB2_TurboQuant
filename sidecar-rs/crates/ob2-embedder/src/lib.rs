//! ob2-embedder — fastembed wrapper + Tokio-based EmbedBatcher.
//!
//! Ported from /mnt/c/projects/OB2/retrieval/sidecar.py (model loader)
//! and /mnt/c/projects/OB2/retrieval/embed_batcher.py (batcher).

pub mod batcher;
pub mod model;
pub mod stats;

pub use batcher::{BatcherConfig, EmbedBatcher};
pub use model::{Embedder, SharedEmbedder, DEFAULT_DIM, DEFAULT_MODEL};
pub use stats::BatcherStats;
