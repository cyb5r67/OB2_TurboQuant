//! Integration tests for `SqliteVecBackend`.
//!
//! Each test opens a fresh temporary SQLite DB (via `tempfile::NamedTempFile`)
//! so they isolate fully. Every public trait method has at least one test.
//!
//! Task 8: the trait is async, so every test is a `#[tokio::test]` and
//! every backend call is `.await`-ed.

use ob2_storage::{DocRecord, SqliteVecBackend, StorageBackend};
use serde_json::json;

const DIM: usize = 8; // tiny vectors keep tests fast; real sidecar uses 384

fn fixture_doc(domain: &str, id: &str, text: &str, emb: [f32; DIM]) -> DocRecord {
    DocRecord {
        doc_id: id.into(),
        domain: domain.into(),
        text: text.into(),
        metadata: json!({"source": "test", "tags": []}),
        source_hash: String::new(),
        embedding: emb.to_vec(),
    }
}

fn open_scratch() -> (tempfile::TempDir, SqliteVecBackend) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ob2.db");
    let backend = SqliteVecBackend::open(path.to_str().unwrap(), DIM).unwrap();
    (dir, backend)
}

// ── writes ──────────────────────────────────────────────────

#[tokio::test]
async fn upsert_doc_returns_positive_key() {
    let (_dir, backend) = open_scratch();
    let key = backend
        .upsert_doc(
            "infra",
            "web-01",
            "hostname web-01 role web",
            &[0.1; DIM],
            &json!({"source": "user", "tags": ["a"]}),
            "",
        )
        .await
        .unwrap();
    assert!(key > 0, "expected positive rowid, got {key}");
}

#[tokio::test]
async fn upsert_doc_overwrites_on_duplicate_id() {
    let (_dir, backend) = open_scratch();
    let k1 = backend
        .upsert_doc("infra", "d1", "first", &[0.1; DIM], &json!({}), "")
        .await
        .unwrap();
    let k2 = backend
        .upsert_doc("infra", "d1", "second", &[0.2; DIM], &json!({}), "")
        .await
        .unwrap();
    assert_eq!(k1, k2, "upsert should keep the same doc_key");

    let got = backend.get_doc("infra", "d1").await.unwrap().unwrap();
    assert_eq!(got.text, "second");
    assert!((got.embedding[0] - 0.2).abs() < 1e-5);
}

#[tokio::test]
async fn upsert_docs_batch_is_atomic() {
    let (_dir, backend) = open_scratch();
    let docs = vec![
        fixture_doc("infra", "d1", "one", [0.1; DIM]),
        fixture_doc("infra", "d2", "two", [0.2; DIM]),
        fixture_doc("infra", "d3", "three", [0.3; DIM]),
    ];
    let written = backend.upsert_docs_batch("infra", &docs).await.unwrap();
    assert_eq!(written, 3);
    assert_eq!(backend.domain_stats("infra").await.unwrap().doc_count, 3);
}

#[tokio::test]
async fn upsert_docs_batch_rejects_cross_domain() {
    let (_dir, backend) = open_scratch();
    let docs = vec![
        fixture_doc("infra", "d1", "one", [0.1; DIM]),
        fixture_doc("other", "d2", "two", [0.2; DIM]),
    ];
    let err = backend.upsert_docs_batch("infra", &docs).await.unwrap_err();
    let msg = format!("{err}");
    assert!(msg.contains("other") && msg.contains("infra"), "got: {msg}");
    // Atomicity: nothing should have been inserted
    assert_eq!(backend.domain_stats("infra").await.unwrap().doc_count, 0);
}

#[tokio::test]
async fn dim_mismatch_errors() {
    let (_dir, backend) = open_scratch();
    let err = backend
        .upsert_doc(
            "infra",
            "d1",
            "text",
            &[0.1_f32; DIM + 1],
            &json!({}),
            "",
        )
        .await
        .unwrap_err();
    assert!(matches!(
        err,
        ob2_storage::StorageError::DimMismatch { got, want } if got == DIM + 1 && want == DIM
    ));
}

// ── reads ───────────────────────────────────────────────────

#[tokio::test]
async fn cosine_search_finds_nearest() {
    let (_dir, backend) = open_scratch();
    backend
        .upsert_doc("infra", "d1", "aligned", &[1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], &json!({}), "")
        .await
        .unwrap();
    backend
        .upsert_doc("infra", "d2", "ortho", &[0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], &json!({}), "")
        .await
        .unwrap();

    let hits = backend
        .query_similar("infra", &[1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], 5, None)
        .await
        .unwrap();
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].doc_id, "d1");
    assert!(hits[0].score > 0.99, "d1 score = {}", hits[0].score);
    assert!(hits[1].score.abs() < 0.01, "d2 score = {}", hits[1].score);
}

#[tokio::test]
async fn cosine_search_applies_top_k() {
    let (_dir, backend) = open_scratch();
    for i in 0..5 {
        let mut v = [0.0_f32; DIM];
        v[0] = 1.0 - (i as f32) * 0.1;
        backend
            .upsert_doc("infra", &format!("d{i}"), "t", &v, &json!({}), "")
            .await
            .unwrap();
    }
    let hits = backend
        .query_similar("infra", &[1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0], 2, None)
        .await
        .unwrap();
    assert_eq!(hits.len(), 2);
}

#[tokio::test]
async fn cosine_search_respects_domain_isolation() {
    let (_dir, backend) = open_scratch();
    backend
        .upsert_doc("infra", "d1", "infra doc", &[0.1; DIM], &json!({}), "")
        .await
        .unwrap();
    backend
        .upsert_doc("netsec", "d2", "netsec doc", &[0.1; DIM], &json!({}), "")
        .await
        .unwrap();
    let hits = backend.query_similar("netsec", &[0.1; DIM], 10, None).await.unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].doc_id, "d2");
}

#[tokio::test]
async fn cosine_search_applies_metadata_filter() {
    let (_dir, backend) = open_scratch();
    backend
        .upsert_doc("infra", "a", "server a", &[0.1; DIM], &json!({"tag": "prod"}), "")
        .await
        .unwrap();
    backend
        .upsert_doc("infra", "b", "server b", &[0.1; DIM], &json!({"tag": "dev"}), "")
        .await
        .unwrap();

    let filter = json!({"tag": "prod"});
    let hits = backend
        .query_similar("infra", &[0.1; DIM], 10, Some(&filter))
        .await
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].doc_id, "a");

    let filter_in = json!({"tag": {"$in": ["dev", "stage"]}});
    let hits2 = backend
        .query_similar("infra", &[0.1; DIM], 10, Some(&filter_in))
        .await
        .unwrap();
    assert_eq!(hits2.len(), 1);
    assert_eq!(hits2[0].doc_id, "b");
}

#[tokio::test]
async fn get_doc_returns_none_for_unknown() {
    let (_dir, backend) = open_scratch();
    assert!(backend.get_doc("infra", "missing").await.unwrap().is_none());
}

#[tokio::test]
async fn get_doc_roundtrips_metadata() {
    let (_dir, backend) = open_scratch();
    let meta = json!({"tags": ["x", "y"], "source": "disk"});
    backend
        .upsert_doc("infra", "d1", "body", &[0.3; DIM], &meta, "abc123")
        .await
        .unwrap();
    let got = backend.get_doc("infra", "d1").await.unwrap().unwrap();
    assert_eq!(got.doc_id, "d1");
    assert_eq!(got.domain, "infra");
    assert_eq!(got.text, "body");
    assert_eq!(got.metadata["tags"], json!(["x", "y"]));
    assert_eq!(got.metadata["source"], "disk");
    assert_eq!(got.source_hash, "abc123");
    assert_eq!(got.embedding.len(), DIM);
}

#[tokio::test]
async fn list_docs_orders_newest_first() {
    let (_dir, backend) = open_scratch();
    backend.upsert_doc("infra", "a", "1st", &[0.1; DIM], &json!({}), "").await.unwrap();
    backend.upsert_doc("infra", "b", "2nd", &[0.1; DIM], &json!({}), "").await.unwrap();
    backend.upsert_doc("infra", "c", "3rd", &[0.1; DIM], &json!({}), "").await.unwrap();
    let docs = backend.list_docs("infra", 10, 0, None).await.unwrap();
    let ids: Vec<_> = docs.iter().map(|d| d.doc_id.clone()).collect();
    assert_eq!(ids, vec!["c", "b", "a"]);
}

// ── deletes ─────────────────────────────────────────────────

#[tokio::test]
async fn delete_doc_removes_and_reports() {
    let (_dir, backend) = open_scratch();
    backend.upsert_doc("infra", "d1", "t", &[0.1; DIM], &json!({}), "").await.unwrap();
    assert!(backend.delete_doc("infra", "d1").await.unwrap());
    assert!(!backend.delete_doc("infra", "d1").await.unwrap());
    assert!(backend.get_doc("infra", "d1").await.unwrap().is_none());
    let hits = backend.query_similar("infra", &[0.1; DIM], 10, None).await.unwrap();
    assert!(hits.is_empty());
}

#[tokio::test]
async fn delete_domain_wipes_docs_aliases_and_sources() {
    let (_dir, backend) = open_scratch();
    backend.upsert_doc("infra", "d1", "t", &[0.1; DIM], &json!({}), "").await.unwrap();
    backend.upsert_doc("infra", "d2", "t", &[0.1; DIM], &json!({}), "").await.unwrap();
    backend.upsert_alias("infra", "db", "db-01").await.unwrap();
    backend.record_source_import("infra", "hosts.csv", "hash1", 5).await.unwrap();

    let n = backend.delete_domain("infra").await.unwrap();
    assert_eq!(n, 2);
    assert_eq!(backend.domain_stats("infra").await.unwrap().doc_count, 0);
    assert!(backend.list_aliases("infra").await.unwrap().is_empty());
    assert!(!backend.has_source("infra", "hosts.csv", "hash1").await.unwrap());
}

#[tokio::test]
async fn delete_domain_is_zero_for_unknown() {
    let (_dir, backend) = open_scratch();
    assert_eq!(backend.delete_domain("ghost").await.unwrap(), 0);
}

// ── introspection ───────────────────────────────────────────

#[tokio::test]
async fn list_domains_returns_sorted_distinct() {
    let (_dir, backend) = open_scratch();
    backend.upsert_doc("zeta", "x", "t", &[0.1; DIM], &json!({}), "").await.unwrap();
    backend.upsert_doc("alpha", "y", "t", &[0.1; DIM], &json!({}), "").await.unwrap();
    backend.upsert_doc("alpha", "z", "t", &[0.1; DIM], &json!({}), "").await.unwrap();
    assert_eq!(backend.list_domains().await.unwrap(), vec!["alpha", "zeta"]);
}

#[tokio::test]
async fn domain_stats_counts_correctly() {
    let (_dir, backend) = open_scratch();
    backend.upsert_doc("infra", "a", "hello", &[0.1; DIM], &json!({}), "").await.unwrap();
    backend.upsert_doc("infra", "b", "world!", &[0.1; DIM], &json!({}), "").await.unwrap();
    let s = backend.domain_stats("infra").await.unwrap();
    assert_eq!(s.doc_count, 2);
    assert_eq!(s.total_bytes, "hello".len() as i64 + "world!".len() as i64);
    assert!(s.oldest_at.is_some());
    assert!(s.newest_at.is_some());
}

#[tokio::test]
async fn domain_stats_empty_for_unknown_domain() {
    let (_dir, backend) = open_scratch();
    let s = backend.domain_stats("ghost").await.unwrap();
    assert_eq!(s.doc_count, 0);
    assert_eq!(s.total_bytes, 0);
    assert!(s.oldest_at.is_none());
}

// ── source-hash dedup ───────────────────────────────────────

#[tokio::test]
async fn source_import_roundtrip() {
    let (_dir, backend) = open_scratch();
    assert!(!backend.has_source("infra", "hosts.csv", "h1").await.unwrap());
    backend
        .record_source_import("infra", "hosts.csv", "h1", 10)
        .await
        .unwrap();
    assert!(backend.has_source("infra", "hosts.csv", "h1").await.unwrap());
    assert!(!backend.has_source("infra", "hosts.csv", "h2").await.unwrap());
    backend
        .record_source_import("infra", "hosts.csv", "h2", 11)
        .await
        .unwrap();
    assert!(backend.has_source("infra", "hosts.csv", "h2").await.unwrap());
    assert!(!backend.has_source("infra", "hosts.csv", "h1").await.unwrap());
}

// ── aliases ─────────────────────────────────────────────────

#[tokio::test]
async fn alias_upsert_resolve_list() {
    let (_dir, backend) = open_scratch();
    backend.upsert_alias("infra", "db", "postgres-01").await.unwrap();
    backend.upsert_alias("infra", "web", "web-01").await.unwrap();
    assert_eq!(
        backend.resolve_alias("infra", "db").await.unwrap(),
        Some("postgres-01".into())
    );
    assert_eq!(backend.resolve_alias("infra", "ghost").await.unwrap(), None);

    backend.upsert_alias("infra", "db", "postgres-02").await.unwrap();
    assert_eq!(
        backend.resolve_alias("infra", "db").await.unwrap(),
        Some("postgres-02".into())
    );

    let aliases = backend.list_aliases("infra").await.unwrap();
    assert_eq!(
        aliases,
        vec![
            ("db".into(), "postgres-02".into()),
            ("web".into(), "web-01".into())
        ]
    );
}

// ── two-tier sync helpers ──────────────────────────────────

#[tokio::test]
async fn unsynced_mark_synced_roundtrip() {
    let (_dir, backend) = open_scratch();
    backend.upsert_doc("infra", "a", "1", &[0.1; DIM], &json!({}), "").await.unwrap();
    backend.upsert_doc("infra", "b", "2", &[0.1; DIM], &json!({}), "").await.unwrap();
    backend.upsert_doc("infra", "c", "3", &[0.1; DIM], &json!({}), "").await.unwrap();

    let pending = backend.list_unsynced(10).await.unwrap();
    let pending_ids: Vec<_> = pending.iter().map(|d| d.doc_id.clone()).collect();
    assert_eq!(pending_ids, vec!["a", "b", "c"]);

    let n = backend
        .mark_synced(&["a".to_string(), "c".to_string()])
        .await
        .unwrap();
    assert_eq!(n, 2);

    let still_pending = backend.list_unsynced(10).await.unwrap();
    let ids: Vec<_> = still_pending.iter().map(|d| d.doc_id.clone()).collect();
    assert_eq!(ids, vec!["b"]);
}

#[tokio::test]
async fn mark_synced_no_ids_is_noop() {
    let (_dir, backend) = open_scratch();
    assert_eq!(backend.mark_synced(&[]).await.unwrap(), 0);
}
