//! Integration tests for ob2-embedder.
//!
//! NOTE: first run downloads ~90MB of model weights from HuggingFace into
//! the fastembed cache. Budget 30-120s depending on network. Subsequent
//! runs are hot-cache and fast.

use ob2_embedder::{BatcherConfig, EmbedBatcher, Embedder, DEFAULT_DIM, DEFAULT_MODEL};
use std::sync::Arc;
use std::time::Duration;

#[tokio::test]
async fn load_and_embed_returns_correct_dim() {
    let emb = Embedder::load(DEFAULT_MODEL).expect("model load");
    let vecs = emb
        .embed(vec!["hello world".into(), "another doc".into()])
        .unwrap();
    assert_eq!(vecs.len(), 2);
    assert_eq!(vecs[0].len(), DEFAULT_DIM);
    assert_eq!(vecs[1].len(), DEFAULT_DIM);
    // sanity: distinct inputs produce different vectors
    assert_ne!(vecs[0], vecs[1]);
}

#[tokio::test]
async fn batcher_roundtrips_single_request() {
    let emb = Arc::new(Embedder::load(DEFAULT_MODEL).expect("model load"));
    let batcher = EmbedBatcher::spawn(
        emb,
        BatcherConfig {
            flush_interval: Duration::from_millis(50),
            ..Default::default()
        },
    );
    let v = batcher.embed_one("the quick brown fox".into()).await.unwrap();
    assert_eq!(v.len(), DEFAULT_DIM);
    let stats = batcher.stats();
    assert_eq!(stats.total_items, 1);
    assert!(stats.total_batches >= 1);
    batcher.shutdown();
}

#[tokio::test]
async fn batcher_handles_parallel_requests() {
    let emb = Arc::new(Embedder::load(DEFAULT_MODEL).expect("model load"));
    let batcher = Arc::new(EmbedBatcher::spawn(emb, BatcherConfig::default()));
    let handles: Vec<_> = (0..8)
        .map(|i| {
            let b = batcher.clone();
            tokio::spawn(async move { b.embed_one(format!("doc number {i}")).await })
        })
        .collect();
    for h in handles {
        let v = h.await.unwrap().unwrap();
        assert_eq!(v.len(), DEFAULT_DIM);
    }
    let stats = batcher.stats();
    assert_eq!(stats.total_items, 8);
    // Should have batched them, so batches < items.
    assert!(stats.total_batches < 8);
}
