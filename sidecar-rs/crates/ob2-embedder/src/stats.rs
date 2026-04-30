//! Batcher stats — mirrors the shape returned by the Python
//! `batcher_stats` RPC (see /mnt/c/projects/OB2/retrieval/embed_batcher.py
//! `EmbedBatcher.stats`).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BatcherStats {
    pub available: bool,
    pub total_batches: u64,
    pub total_items: u64,
    pub avg_batch_ms: f64,
    pub avg_items_per_batch: f64,
}
