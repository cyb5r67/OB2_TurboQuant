//! Two-tier soak tests — end-to-end convergence through the real
//! SyncWorker. Skipped unless `OB2_PG_URL_TEST` is set so CI without
//! a pgvector sidecar can still run `cargo test --workspace`.
//!
//! Each test drops+recreates the pgvector tables (via the Rust backend's
//! own DDL is idempotent, so we just `DELETE FROM` the three tables
//! at the top of each test to isolate state).

use std::sync::Arc;
use std::time::Duration;

use ob2_storage::{PgVectorBackend, SqliteVecBackend, StorageBackend, TwoTierBackend};
use serde_json::json;

const DIM: usize = 8;

fn pg_url() -> Option<String> {
    std::env::var("OB2_PG_URL_TEST").ok()
}

async fn reset_pg(url: &str) {
    use tokio_postgres::NoTls;
    let (client, conn) = tokio_postgres::connect(url, NoTls)
        .await
        .expect("connect pg");
    tokio::spawn(async move { let _ = conn.await; });
    // DDL runs on connect(); just clear rows.
    for stmt in [
        "DROP TABLE IF EXISTS docs CASCADE",
        "DROP TABLE IF EXISTS source_imports CASCADE",
        "DROP TABLE IF EXISTS entity_aliases CASCADE",
    ] {
        client.execute(stmt, &[]).await.ok();
    }
}

async fn wait_for_drain(tt: &TwoTierBackend, max: Duration) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < max {
        let s = tt.status();
        if s.pending_docs == 0 && s.last_sync_docs > 0 && s.pgvector_reachable {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    false
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_tier_captures_and_syncs() {
    let Some(url) = pg_url() else {
        eprintln!("skipped: OB2_PG_URL_TEST not set");
        return;
    };
    reset_pg(&url).await;

    let tmp = tempfile::tempdir().unwrap();
    let sqlite_path = tmp.path().join("ob2.db");
    let tier1 = Arc::new(SqliteVecBackend::open(sqlite_path.to_str().unwrap(), DIM).unwrap());
    let tier2 = Arc::new(
        PgVectorBackend::connect(&url, DIM)
            .await
            .expect("pg connect"),
    );
    // Fast sync interval so the test drains in seconds, not 5-second ticks.
    let tt = TwoTierBackend::with_config(tier1.clone(), tier2.clone(), 1, 256).await;

    // Capture 100 docs — interleave a couple of domains to exercise the
    // group-by-domain path in the worker.
    for i in 0..100u32 {
        let dom = if i % 2 == 0 { "alpha" } else { "beta" };
        tt.upsert_doc(
            dom,
            &format!("d{i}"),
            &format!("doc {i}"),
            &vec![(i as f32) * 0.01; DIM],
            &json!({"source": "soak", "tags": []}),
            "",
        )
        .await
        .expect("upsert");
    }

    // Immediate read: pending should be ≈100 but `domain_stats` via tier-2
    // + tier-1 pending should total 100 across both domains.
    let immediate = tt.status();
    assert!(
        immediate.pending_docs > 0,
        "status should reflect backlog: {immediate:?}"
    );

    // Wait for the worker to drain.
    assert!(
        wait_for_drain(&tt, Duration::from_secs(15)).await,
        "worker did not drain 100 docs in 15s; status={:?}",
        tt.status()
    );

    // Query via tier-2 directly to confirm each doc landed.
    for i in 0..100u32 {
        let dom = if i % 2 == 0 { "alpha" } else { "beta" };
        let doc = tier2
            .get_doc(dom, &format!("d{i}"))
            .await
            .expect("get_doc")
            .expect("doc present in pgvector");
        assert_eq!(doc.text, format!("doc {i}"));
    }

    // Final status: no backlog, reachable, no error.
    let final_status = tt.status();
    assert_eq!(final_status.pending_docs, 0, "{final_status:?}");
    assert!(final_status.pgvector_reachable);
    assert!(final_status.last_error.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_tier_survives_mid_sync_restart() {
    let Some(url) = pg_url() else {
        eprintln!("skipped: OB2_PG_URL_TEST not set");
        return;
    };
    reset_pg(&url).await;

    let tmp = tempfile::tempdir().unwrap();
    let sqlite_path = tmp.path().join("ob2.db");

    // --- Round 1: capture 500 docs, let the worker start draining, then
    //     drop the TwoTierBackend to simulate a restart mid-flush.
    let tier1 = Arc::new(SqliteVecBackend::open(sqlite_path.to_str().unwrap(), DIM).unwrap());
    {
        let tier2 = Arc::new(PgVectorBackend::connect(&url, DIM).await.unwrap());
        let tt = TwoTierBackend::with_config(tier1.clone(), tier2.clone(), 1, 256).await;
        for i in 0..500u32 {
            tt.upsert_doc(
                "restart",
                &format!("d{i}"),
                &format!("doc {i}"),
                &vec![(i as f32) * 0.001; DIM],
                &json!({"source": "soak", "tags": []}),
                "",
            )
            .await
            .unwrap();
        }
        // Give the worker a brief window to flush one batch (256 docs).
        tokio::time::sleep(Duration::from_millis(1500)).await;
        // Drop tt — its Drop triggers shutdown().
    }

    // --- Round 2: reopen tier1 (shared sqlite file) + a fresh tier2 handle.
    let tier2 = Arc::new(PgVectorBackend::connect(&url, DIM).await.unwrap());
    let tt = TwoTierBackend::with_config(tier1.clone(), tier2.clone(), 1, 256).await;

    // Wait until everything is synced.
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        let pending = tt.status().pending_docs;
        if pending == 0 {
            break;
        }
        if std::time::Instant::now() > deadline {
            panic!("failed to converge; still {} pending", pending);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }

    // Verify every doc is in pgvector exactly once (no duplicates).
    let stats = tier2.domain_stats("restart").await.unwrap();
    assert_eq!(
        stats.doc_count, 500,
        "pgvector should have exactly 500 docs, got {}",
        stats.doc_count
    );
    // And tier-1 still has them too (with synced_at non-null now).
    let sq_stats = tier1.domain_stats("restart").await.unwrap();
    assert_eq!(sq_stats.doc_count, 500);
}
