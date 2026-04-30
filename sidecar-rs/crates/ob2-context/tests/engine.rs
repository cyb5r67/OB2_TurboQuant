//! Integration tests for the ContextEngine.
//!
//! These use a real `SqliteVecBackend` (tempfile-backed) and assert the
//! engine's packet shape + retrieval flow. Golden byte-for-byte fixtures
//! vs the Python sidecar land in Task 7.
//!
//! Task 8: the engine is async; tests use `#[tokio::test]`.

use std::sync::Arc;

use ob2_context::{BuildContextPacket, ContextEngine};
use ob2_storage::{SqliteVecBackend, StorageBackend};

const DIM: usize = 8;

/// Build a tiny normalised embedding for tests. We make each doc's embedding
/// point mostly toward its own axis so `query_similar` gives us predictable
/// cosine scores.
fn one_hot(i: usize, dim: usize) -> Vec<f32> {
    let mut v = vec![0.01_f32; dim];
    v[i % dim] = 1.0;
    let norm: f32 = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    v.iter().map(|x| x / norm).collect()
}

async fn setup(
    docs: &[(&str, &str, &[&str])],
) -> (tempfile::TempDir, Arc<dyn StorageBackend>) {
    let tmp = tempfile::TempDir::new().unwrap();
    let path = tmp.path().join("ob2.db");
    let backend = SqliteVecBackend::open(path.to_str().unwrap(), DIM).unwrap();
    let backend: Arc<dyn StorageBackend> = Arc::new(backend);

    for (i, (id, text, tags)) in docs.iter().enumerate() {
        let emb = one_hot(i, DIM);
        let meta = serde_json::json!({
            "source": "test",
            "tags": tags.iter().copied().collect::<Vec<_>>(),
        });
        backend
            .upsert_doc("test", id, text, &emb, &meta, "")
            .await
            .unwrap();
    }

    (tmp, backend)
}

async fn make_engine(backend: Arc<dyn StorageBackend>) -> ContextEngine {
    let mut e = ContextEngine::with_defaults(backend, "test".to_string()).unwrap();
    e.reindex().await.unwrap();
    e
}

// ── Basic assembly ──────────────────────────────────────────

#[tokio::test]
async fn empty_domain_returns_unknown_domain_packet() {
    let tmp = tempfile::TempDir::new().unwrap();
    let path = tmp.path().join("ob2.db");
    let backend: Arc<dyn StorageBackend> =
        Arc::new(SqliteVecBackend::open(path.to_str().unwrap(), DIM).unwrap());
    let engine = ContextEngine::with_defaults(backend, "test".into()).unwrap();

    let packet = engine
        .build_context("any query", &one_hot(0, DIM))
        .await
        .unwrap();
    assert_eq!(packet.unknown_domain, Some(true));
    assert!(packet.retrieved_docs.is_empty());
    assert_eq!(packet.compressed_text, "");
    assert!(packet.budget_summary.is_none());
    assert!(packet.metadata.is_none());
}

#[tokio::test]
async fn empty_query_errors() {
    let (_tmp, backend) = setup(&[("d1", "postgres database stuff", &[])]).await;
    let engine = make_engine(backend).await;
    assert!(engine.build_context("", &one_hot(0, DIM)).await.is_err());
    assert!(engine.build_context("   ", &one_hot(0, DIM)).await.is_err());
}

#[tokio::test]
async fn engine_returns_packet_with_expected_shape() {
    let (_tmp, backend) = setup(&[
        (
            "d1",
            "Postgres replication configuration is straightforward to set up.",
            &[],
        ),
        (
            "d2",
            "Apple pies require butter, flour, sugar, and fresh fruit.",
            &[],
        ),
    ])
    .await;
    let engine = make_engine(backend).await;

    let q_emb = one_hot(0, DIM);
    let packet = engine
        .build_context("postgres replication", &q_emb)
        .await
        .unwrap();

    assert!(packet.unknown_domain.is_none());
    assert!(
        !packet.retrieved_docs.is_empty(),
        "expected at least one retrieved doc"
    );
    let bs = packet.budget_summary.expect("budget_summary present");
    assert!(bs.system_prompt > 0);
    assert_eq!(bs.history, 0);

    let md = packet.metadata.expect("metadata present");
    assert_eq!(md.retrieval_mode, "hybrid");
    assert_eq!(md.memory_turns_total, 0);
    assert!(
        matches!(
            md.strategy_used.as_str(),
            "none (empty input)"
                | "none (fits budget)"
                | "truncate"
                | "sentence"
                | "extractive"
        ),
        "unexpected strategy_used: {:?}",
        md.strategy_used
    );
}

// ── Reindex ────────────────────────────────────────────────

#[tokio::test]
async fn reindex_populates_tfidf_from_backend() {
    let (_tmp, backend) = setup(&[
        ("d1", "postgres database replication", &[]),
        ("d2", "apple banana cherry", &[]),
        ("d3", "golang rust programming languages", &[]),
    ])
    .await;
    let mut engine = ContextEngine::with_defaults(backend, "test".into()).unwrap();
    assert!(engine.is_empty());
    let n = engine.reindex().await.unwrap();
    assert_eq!(n, 3);
    assert_eq!(engine.len(), 3);
}

#[tokio::test]
async fn reindex_then_query_finds_relevant_doc_first() {
    let (_tmp, backend) = setup(&[
        (
            "d1",
            "Postgres replication setup guide with monitoring details.",
            &[],
        ),
        (
            "d2",
            "Cooking dinner tonight with spinach, garlic and olive oil is simple.",
            &[],
        ),
    ])
    .await;
    let engine = make_engine(backend).await;

    let q_emb = one_hot(0, DIM);
    let packet = engine
        .build_context("postgres replication", &q_emb)
        .await
        .unwrap();

    assert_eq!(packet.retrieved_docs[0].doc_id, "d1");
}

// ── Budget enforcement ─────────────────────────────────────

#[tokio::test]
async fn compressed_text_respects_budget() {
    let long_a = "postgres replication monitoring. ".repeat(200);
    let long_b = "apples are tasty fruit everyday. ".repeat(200);
    let (_tmp, backend) = setup(&[
        ("d1", long_a.as_str(), &[]),
        ("d2", long_b.as_str(), &[]),
    ])
    .await;

    let mut engine = make_engine(backend).await;
    engine.set_total_token_budget(128).unwrap();

    let q_emb = one_hot(0, DIM);
    let packet: BuildContextPacket = engine
        .build_context("postgres replication", &q_emb)
        .await
        .unwrap();

    let compressed_char_count = packet.compressed_text.chars().count();
    assert!(
        compressed_char_count <= 484,
        "compressed text {} chars exceeds expected budget",
        compressed_char_count
    );

    let md = packet.metadata.unwrap();
    assert!(
        matches!(md.strategy_used.as_str(), "truncate" | "sentence" | "extractive"),
        "expected real compression, got {:?}",
        md.strategy_used
    );
}

// ── Re-rank boosts tagged docs ─────────────────────────────

#[tokio::test]
async fn rerank_boosts_docs_with_memory_or_rag_tags() {
    let tmp = tempfile::TempDir::new().unwrap();
    let path = tmp.path().join("ob2.db");
    let backend: Arc<dyn StorageBackend> =
        Arc::new(SqliteVecBackend::open(path.to_str().unwrap(), DIM).unwrap());

    let shared_text = "postgres replication configuration guide";
    let shared_emb = one_hot(0, DIM);

    backend
        .upsert_doc(
            "test",
            "plain",
            shared_text,
            &shared_emb,
            &serde_json::json!({"source": "test", "tags": []}),
            "",
        )
        .await
        .unwrap();
    backend
        .upsert_doc(
            "test",
            "tagged",
            shared_text,
            &shared_emb,
            &serde_json::json!({"source": "test", "tags": ["rag"]}),
            "",
        )
        .await
        .unwrap();

    let mut engine = ContextEngine::with_defaults(backend, "test".into()).unwrap();
    engine.reindex().await.unwrap();

    let packet = engine
        .build_context("postgres replication", &shared_emb)
        .await
        .unwrap();

    assert_eq!(packet.retrieved_docs[0].doc_id, "tagged");
    assert!(
        packet.retrieved_docs[0].match_reason.contains("reranked"),
        "expected 'reranked' in match_reason, got {:?}",
        packet.retrieved_docs[0].match_reason
    );
}

// ── Packet serialization round-trip ────────────────────────

#[tokio::test]
async fn packet_serializes_to_expected_keys() {
    let (_tmp, backend) = setup(&[("d1", "postgres replication monitoring guide", &[])]).await;
    let engine = make_engine(backend).await;

    let packet = engine
        .build_context("postgres", &one_hot(0, DIM))
        .await
        .unwrap();
    let j = serde_json::to_value(&packet).unwrap();

    assert!(j.get("compressed_text").is_some());
    assert!(j.get("retrieved_docs").is_some());
    assert!(j.get("budget_summary").is_some());
    assert!(j.get("metadata").is_some());
    assert!(j.get("unknown_domain").is_none());

    let bs = j.get("budget_summary").unwrap();
    assert!(bs.get("system_prompt").is_some());
    assert!(bs.get("history").is_some());
    assert!(bs.get("retrieved_docs").is_some());

    let md = j.get("metadata").unwrap();
    assert!(md.get("compression_ratio").is_some());
    assert!(md.get("tokens_saved").is_some());
    assert!(md.get("strategy_used").is_some());
    assert!(md.get("memory_turns_total").is_some());
    assert!(md.get("retrieval_mode").is_some());

    let rd = j
        .get("retrieved_docs")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .expect("at least one retrieved doc");
    for key in ["doc_id", "content", "score", "match_reason", "tags", "source"] {
        assert!(rd.get(key).is_some(), "missing key {} in {:?}", key, rd);
    }
}

#[test]
fn unknown_domain_packet_serializes_correctly() {
    let packet = BuildContextPacket::unknown_domain();
    let j = serde_json::to_value(&packet).unwrap();
    assert_eq!(j.get("unknown_domain").and_then(|v| v.as_bool()), Some(true));
    assert_eq!(j.get("compressed_text").and_then(|v| v.as_str()), Some(""));
    assert!(
        j.get("retrieved_docs")
            .and_then(|v| v.as_array())
            .unwrap()
            .is_empty()
    );
    assert!(j.get("budget_summary").is_none());
    assert!(j.get("metadata").is_none());
}
