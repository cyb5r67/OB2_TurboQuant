//! One async fn per JSON-RPC method. Ported from `retrieval/sidecar.py`.
//!
//! Each handler takes `(&AppState, Value) -> anyhow::Result<Value>`:
//!   * parse params with Python-style leniency (missing-with-default, not
//!     missing-is-error),
//!   * call into the lib crates,
//!   * serialize a response shape byte-identical to the Python sidecar so
//!     the shared golden fixtures pass on both runtimes.

use anyhow::anyhow;
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Value};

use ob2_storage::{DocHit, DocRecord};

use crate::state::{AppState, ClassifierDecision};

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

fn require_str<'a>(params: &'a Value, key: &str) -> anyhow::Result<&'a str> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("missing param: '{}'", key))
}

fn opt_string(params: &Value, key: &str) -> Option<String> {
    params.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

/// Port of Python's `list(params.get(key) or [])` — returns an empty vec if
/// missing/None/not-an-array.
fn opt_tag_list(params: &Value, key: &str) -> Vec<String> {
    params
        .get(key)
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// Port of `int(params.get(key) or default)` semantics.
fn opt_int(params: &Value, key: &str, default: i64) -> i64 {
    match params.get(key) {
        Some(Value::Null) | None => default,
        Some(Value::Number(n)) => n.as_i64().unwrap_or_else(|| n.as_f64().unwrap_or(default as f64) as i64),
        Some(Value::String(s)) => s.parse().unwrap_or(default),
        _ => default,
    }
}

fn opt_float(params: &Value, key: &str, default: f64) -> f64 {
    match params.get(key) {
        Some(Value::Null) | None => default,
        Some(Value::Number(n)) => n.as_f64().unwrap_or(default),
        Some(Value::String(s)) => s.parse().unwrap_or(default),
        _ => default,
    }
}

fn iso_timestamp_now() -> String {
    // Python: `datetime.now(timezone.utc).isoformat(timespec="seconds")`
    // produces e.g. "2026-04-18T21:33:01+00:00". chrono's default RFC3339
    // secs matches when we strip the Z and use the +00:00 offset.
    let now = Utc::now();
    // Produces "2026-04-18T21:33:01+00:00"
    now.to_rfc3339_opts(SecondsFormat::Secs, false)
        // chrono renders UTC as "+00:00" already when the offset is Utc —
        // this matches Python's `isoformat()` exactly.
        .to_string()
}

/// Turn a DocHit into the Python retrieve/build_context response dict.
fn hit_to_doc_dict(h: &DocHit) -> Value {
    let tags = h
        .metadata
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let source = h
        .metadata
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("backend")
        .to_string();
    let match_reason = h
        .metadata
        .get("match_reason")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    json!({
        "doc_id": h.doc_id,
        "content": h.text,
        "score": h.score as f64,
        "match_reason": match_reason,
        "tags": tags,
        "source": source,
        "created_at": h.created_at,
    })
}

// ─────────────────────────────────────────────────────────────
// ping
// ─────────────────────────────────────────────────────────────

pub async fn ping(state: &AppState) -> anyhow::Result<Value> {
    let batcher_field = if state.batcher_available() {
        let stats = state.get_or_init_batcher().stats();
        // Python: `_batcher.stats()` returns a dict with total_batches,
        // total_items, avg_batch_ms, avg_items_per_batch. No "available".
        json!({
            "total_batches": stats.total_batches,
            "total_items": stats.total_items,
            "avg_batch_ms": round_f64(stats.avg_batch_ms, 1),
            "avg_items_per_batch": round_f64(stats.avg_items_per_batch, 1),
        })
    } else {
        Value::Null
    };
    Ok(json!({
        "pong": true,
        "embedder": true,
        "backend": state.storage_backend_name,
        "batcher": batcher_field,
    }))
}

fn round_f64(v: f64, places: i32) -> f64 {
    let m = 10f64.powi(places);
    (v * m).round() / m
}

// ─────────────────────────────────────────────────────────────
// capture
// ─────────────────────────────────────────────────────────────

pub async fn capture(state: &AppState, params: Value) -> anyhow::Result<Value> {
    let domain = require_str(&params, "domain")?.to_string();
    let doc_id = require_str(&params, "doc_id")?.to_string();
    let text = require_str(&params, "text")?.to_string();
    let tags = opt_tag_list(&params, "tags");
    let source = opt_string(&params, "source").unwrap_or_else(|| "user".to_string());

    let batcher = state.get_or_init_batcher();
    let embedding = batcher.embed_one(text.clone()).await?;

    let metadata = json!({ "source": source, "tags": tags });

    state
        .backend
        .upsert_doc(&domain, &doc_id, &text, &embedding, &metadata, "")
        .await?;

    // Python: if engine was hydrated, add_document; if cold, next retrieve
    // will hydrate and pick it up. Mirror by dropping the cache — cheaper
    // correct option.
    state.invalidate_engine(&domain);

    let stats = state.backend.domain_stats(&domain).await?;

    Ok(json!({
        "doc_id": doc_id,
        "domain": domain,
        "doc_count": stats.doc_count,
        "created_at": iso_timestamp_now(),
    }))
}

// ─────────────────────────────────────────────────────────────
// capture_batch
// ─────────────────────────────────────────────────────────────

pub async fn capture_batch(state: &AppState, params: Value) -> anyhow::Result<Value> {
    let domain = require_str(&params, "domain")?.to_string();
    let docs = params
        .get("docs")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    if docs.is_empty() {
        return Ok(json!({"written": 0, "domain": domain}));
    }

    // Collect texts in order for the batch embed call.
    let mut parsed: Vec<(String, String, Vec<String>, String, String)> =
        Vec::with_capacity(docs.len());
    for d in &docs {
        let doc_id = d
            .get("doc_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("batch item missing 'doc_id'"))?
            .to_string();
        let text = d
            .get("text")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("batch item missing 'text'"))?
            .to_string();
        let tags = d
            .get("tags")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let source = d
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or("import")
            .to_string();
        let source_hash = d
            .get("source_hash")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        parsed.push((doc_id, text, tags, source, source_hash));
    }

    let texts: Vec<String> = parsed.iter().map(|p| p.1.clone()).collect();
    let embedder = state.embedder.clone();
    let vecs =
        tokio::task::spawn_blocking(move || embedder.embed(texts)).await??;

    // Build DocRecord list and upsert in a single batch.
    let records: Vec<DocRecord> = parsed
        .iter()
        .zip(vecs.iter())
        .map(|((doc_id, text, tags, source, source_hash), emb)| DocRecord {
            doc_id: doc_id.clone(),
            domain: domain.clone(),
            text: text.clone(),
            embedding: emb.clone(),
            metadata: json!({ "source": source, "tags": tags }),
            source_hash: source_hash.clone(),
        })
        .collect();

    let written = state.backend.upsert_docs_batch(&domain, &records).await?;

    // Invalidate engine so next retrieve re-hydrates.
    state.invalidate_engine(&domain);

    Ok(json!({"written": written, "domain": domain}))
}

// ─────────────────────────────────────────────────────────────
// retrieve
// ─────────────────────────────────────────────────────────────

pub async fn retrieve(state: &AppState, params: Value) -> anyhow::Result<Value> {
    let domain = require_str(&params, "domain")?.to_string();
    let query = require_str(&params, "query")?.to_string();
    let top_k = opt_int(&params, "top_k", state.default_top_k as i64) as usize;
    let alpha = opt_float(&params, "alpha", state.default_alpha as f64) as f32;

    // Empty domain short-circuit — matches sidecar.py:294-296.
    let stats = state.backend.domain_stats(&domain).await?;
    if stats.doc_count == 0 {
        return Ok(json!({"docs": [], "unknown_domain": true}));
    }

    // Hydrate engine (rebuilds TF-IDF from backend if cold).
    let engine_handle = state.engine_for(&domain).await?;

    // Embed the query.
    let batcher = state.get_or_init_batcher();
    let q_emb = batcher.embed_one(query.clone()).await?;

    // Retrieve: take-and-release the lock around an await by snapshotting the
    // (cheap) references we need. The engine's retrieve is async so we can't
    // hold the parking_lot guard across it.
    let hits: Vec<DocHit> = {
        let guard = engine_handle.lock().await;
        guard
            .retrieve(&query, &q_emb, top_k, alpha)
            .await
            .map_err(|e| anyhow!("retrieve: {e}"))?
    };

    let docs: Vec<Value> = hits.iter().map(hit_to_doc_dict).collect();
    Ok(json!({"docs": docs}))
}

// ─────────────────────────────────────────────────────────────
// build_context
// ─────────────────────────────────────────────────────────────

pub async fn build_context(state: &AppState, params: Value) -> anyhow::Result<Value> {
    let domain = require_str(&params, "domain")?.to_string();
    let query = require_str(&params, "query")?.to_string();
    let budget = opt_int(
        &params,
        "budget_tokens",
        state.default_token_budget as i64,
    );

    // Empty domain short-circuit — matches sidecar.py:320-326.
    let stats = state.backend.domain_stats(&domain).await?;
    if stats.doc_count == 0 {
        return Ok(json!({
            "compressed_text": "",
            "retrieved_docs": [],
            "unknown_domain": true,
        }));
    }

    let engine_handle = state.engine_for(&domain).await?;

    let batcher = state.get_or_init_batcher();
    let q_emb = batcher.embed_one(query.clone()).await?;

    let packet = {
        let mut engine = engine_handle.lock().await;
        // Apply the per-request budget override (sidecar.py:329).
        engine
            .set_total_token_budget(budget as usize)
            .map_err(|e| anyhow!("set budget: {e}"))?;
        engine
            .build_context(&query, &q_emb)
            .await
            .map_err(|e| anyhow!("build_context: {e}"))?
    };

    // Translate packet to Python's exact dict shape (sidecar.py:331-349).
    let retrieved_docs: Vec<Value> = packet
        .retrieved_docs
        .iter()
        .map(|d| {
            json!({
                "doc_id": d.doc_id,
                "content": d.content,
                "score": d.score as f64,
                "match_reason": d.match_reason,
                "tags": d.tags,
                "source": d.source,
                "created_at": d.created_at,
            })
        })
        .collect();

    if packet.unknown_domain == Some(true) {
        return Ok(json!({
            "compressed_text": packet.compressed_text,
            "retrieved_docs": retrieved_docs,
            "unknown_domain": true,
        }));
    }

    let budget_summary = packet.budget_summary.as_ref().map(|b| {
        json!({
            "system_prompt": b.system_prompt,
            "history": b.history,
            "retrieved_docs": b.retrieved_docs,
        })
    });

    let metadata = packet.metadata.as_ref().map(|m| {
        json!({
            "compression_ratio": m.compression_ratio as f64,
            "tokens_saved": m.tokens_saved,
            "strategy_used": m.strategy_used,
            "memory_turns_total": m.memory_turns_total,
            "retrieval_mode": m.retrieval_mode,
        })
    });

    Ok(json!({
        "compressed_text": packet.compressed_text,
        "retrieved_docs": retrieved_docs,
        "budget_summary": budget_summary,
        "metadata": metadata,
    }))
}

// ─────────────────────────────────────────────────────────────
// knowledge_stats helpers
// ─────────────────────────────────────────────────────────────

/// Mirrors Python `_get_domain_description`: looks for a domain init doc
/// (metadata._ob2_type == "domain_init") and returns its description field.
async fn get_domain_description(state: &AppState, domain: &str) -> String {
    let filter = serde_json::json!({"_ob2_type": "domain_init"});
    match state.backend.list_docs(domain, 1, 0, Some(&filter)).await {
        Ok(docs) => docs
            .first()
            .and_then(|d| d.metadata.get("description"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        Err(_) => String::new(),
    }
}

// ─────────────────────────────────────────────────────────────
// knowledge_stats
// ─────────────────────────────────────────────────────────────

pub async fn knowledge_stats(state: &AppState, params: Value) -> anyhow::Result<Value> {
    match params.get("domain").and_then(|v| v.as_str()).map(str::to_string) {
        None => {
            let doms = state.backend.list_domains().await?;
            let mut entries = Vec::with_capacity(doms.len());
            for d in doms {
                let s = state.backend.domain_stats(&d).await?;
                entries.push(json!({"domain": d, "doc_count": s.doc_count}));
            }
            Ok(json!({"domains": entries}))
        }
        Some(domain) => {
            let stats = state.backend.domain_stats(&domain).await?;
            let description = get_domain_description(state, &domain).await;
            Ok(json!({
                "domain": stats.domain,
                "doc_count": stats.doc_count,
                "total_bytes": stats.total_bytes,
                "oldest_at": stats.oldest_at,
                "newest_at": stats.newest_at,
                "exists": stats.doc_count > 0,
                "description": description,
            }))
        }
    }
}

// ─────────────────────────────────────────────────────────────
// list_domains
// ─────────────────────────────────────────────────────────────

pub async fn list_domains(state: &AppState) -> anyhow::Result<Value> {
    let doms = state.backend.list_domains().await?;
    Ok(json!({"domains": doms}))
}

// ─────────────────────────────────────────────────────────────
// delete / delete_domain
// ─────────────────────────────────────────────────────────────

pub async fn delete(state: &AppState, params: Value) -> anyhow::Result<Value> {
    let domain = require_str(&params, "domain")?.to_string();
    let doc_id = require_str(&params, "doc_id")?.to_string();

    let ok = state.backend.delete_doc(&domain, &doc_id).await?;

    state.invalidate_engine(&domain);
    Ok(json!({"deleted": ok}))
}

pub async fn delete_domain(state: &AppState, params: Value) -> anyhow::Result<Value> {
    let domain = require_str(&params, "domain")?.to_string();
    let count = state.backend.delete_domain(&domain).await?;
    state.invalidate_engine(&domain);
    Ok(json!({"deleted_count": count, "domain": domain}))
}

// ─────────────────────────────────────────────────────────────
// has_source / record_source
// ─────────────────────────────────────────────────────────────

pub async fn has_source(state: &AppState, params: Value) -> anyhow::Result<Value> {
    let domain = require_str(&params, "domain")?.to_string();
    let source_id = require_str(&params, "source_id")?.to_string();
    let content_hash = require_str(&params, "content_hash")?.to_string();
    let exists = state
        .backend
        .has_source(&domain, &source_id, &content_hash)
        .await?;
    Ok(json!({"exists": exists}))
}

pub async fn record_source(state: &AppState, params: Value) -> anyhow::Result<Value> {
    let domain = require_str(&params, "domain")?.to_string();
    let source_id = require_str(&params, "source_id")?.to_string();
    let content_hash = require_str(&params, "content_hash")?.to_string();
    let chunks_produced = opt_int(&params, "chunks_produced", 0);
    state
        .backend
        .record_source_import(&domain, &source_id, &content_hash, chunks_produced)
        .await?;
    Ok(json!({"ok": true}))
}

// ─────────────────────────────────────────────────────────────
// aliases
// ─────────────────────────────────────────────────────────────

pub async fn upsert_alias(state: &AppState, params: Value) -> anyhow::Result<Value> {
    let domain = require_str(&params, "domain")?.to_string();
    let alias = require_str(&params, "alias")?.to_string();
    let canonical = require_str(&params, "canonical")?.to_string();
    state
        .backend
        .upsert_alias(&domain, &alias, &canonical)
        .await?;
    Ok(json!({"ok": true}))
}

pub async fn resolve_alias(state: &AppState, params: Value) -> anyhow::Result<Value> {
    let domain = require_str(&params, "domain")?.to_string();
    let alias = require_str(&params, "alias")?.to_string();
    let canonical = state.backend.resolve_alias(&domain, &alias).await?;
    // Python returns {"canonical": str | None}
    Ok(json!({"canonical": canonical}))
}

pub async fn list_aliases(state: &AppState, params: Value) -> anyhow::Result<Value> {
    let domain = require_str(&params, "domain")?.to_string();
    let pairs = state.backend.list_aliases(&domain).await?;
    let arr: Vec<Value> = pairs
        .into_iter()
        .map(|(a, c)| json!({"alias": a, "canonical": c}))
        .collect();
    Ok(json!({"aliases": arr}))
}

// ─────────────────────────────────────────────────────────────
// suggest_domains
// ─────────────────────────────────────────────────────────────

pub async fn suggest_domains(state: &AppState, params: Value) -> anyhow::Result<Value> {
    let text = opt_string(&params, "text").unwrap_or_default();
    if text.is_empty() {
        return Ok(json!({"suggestions": []}));
    }
    let text_lower = text.to_lowercase();

    let mut suggestions = Vec::new();
    for domain in state.backend.list_domains().await? {
        let aliases = state.backend.list_aliases(&domain).await?;
        let mut matched: Vec<String> = Vec::new();
        for (alias, _canonical) in &aliases {
            let alias_lower = alias.to_lowercase();
            // Whole-word match, boundary-aware (Python uses `\b`).
            let pat = format!(r"\b{}\b", regex::escape(&alias_lower));
            if let Ok(re) = regex::Regex::new(&pat) {
                if re.is_match(&text_lower) {
                    matched.push(alias.clone());
                }
            }
        }
        if !matched.is_empty() {
            suggestions.push(json!({"domain": domain, "matched_aliases": matched}));
        }
    }
    Ok(json!({"suggestions": suggestions}))
}

// ─────────────────────────────────────────────────────────────
// batcher_stats
// ─────────────────────────────────────────────────────────────

pub async fn batcher_stats(state: &AppState) -> anyhow::Result<Value> {
    if !state.batcher_available() {
        return Ok(json!({"available": false}));
    }
    let s = state.get_or_init_batcher().stats();
    Ok(json!({
        "available": true,
        "total_batches": s.total_batches,
        "total_items": s.total_items,
        "avg_batch_ms": round_f64(s.avg_batch_ms, 1),
        "avg_items_per_batch": round_f64(s.avg_items_per_batch, 1),
    }))
}

// ─────────────────────────────────────────────────────────────
// classifier
// ─────────────────────────────────────────────────────────────

pub async fn record_classifier_decision(
    state: &AppState,
    params: Value,
) -> anyhow::Result<Value> {
    let outcome = opt_string(&params, "outcome").unwrap_or_else(|| "passed".to_string());
    let query_raw = opt_string(&params, "query").unwrap_or_default();
    let query: String = query_raw.chars().take(120).collect();
    let domain = params.get("domain").cloned().unwrap_or(Value::Null);
    let confidence = params.get("confidence").cloned().unwrap_or(Value::Null);

    let decision = ClassifierDecision {
        at: iso_timestamp_now(),
        outcome: outcome.clone(),
        query,
        domain,
        confidence,
    };

    {
        let mut q = state.classifier.lock();
        if q.len() == 100 {
            q.pop_front();
        }
        q.push_back(decision);
    }

    {
        let mut c = state.classifier_counts.lock();
        match outcome.as_str() {
            "routed" => c.routed += 1,
            "passed" => c.passed += 1,
            "denied" => c.denied += 1,
            _ => {}
        }
    }

    Ok(json!({"ok": true}))
}

pub async fn classifier_stats(state: &AppState) -> anyhow::Result<Value> {
    let counts = { state.classifier_counts.lock().clone() };
    let recent: Vec<Value> = {
        let q = state.classifier.lock();
        q.iter()
            .map(|d| {
                json!({
                    "at": d.at,
                    "outcome": d.outcome,
                    "query": d.query,
                    "domain": d.domain,
                    "confidence": d.confidence,
                })
            })
            .collect()
    };
    Ok(json!({
        "counts": {
            "routed": counts.routed,
            "passed": counts.passed,
            "denied": counts.denied,
        },
        "recent": recent,
    }))
}

// ─────────────────────────────────────────────────────────────
// pg / sync stubs (Task 8 / 9)
// ─────────────────────────────────────────────────────────────

pub async fn test_pgvector(_state: &AppState, params: Value) -> anyhow::Result<Value> {
    // Python semantics: connect → SELECT extversion → SELECT COUNT(*) FROM docs
    // Match the response keys + rounding exactly.
    let url = opt_string(&params, "url")
        .or_else(|| std::env::var("OB2_PG_URL").ok())
        .unwrap_or_default();
    if url.is_empty() {
        return Ok(json!({"reachable": false, "error": "no URL provided"}));
    }

    use std::time::{Duration, Instant};
    use tokio_postgres::NoTls;

    // Parse the URL so we can reject early if it's malformed.
    let config: tokio_postgres::Config = match url.parse() {
        Ok(c) => c,
        Err(e) => {
            return Ok(json!({
                "reachable": false,
                "error": truncate_200(&format!("parse url: {e}"))
            }));
        }
    };

    let started = Instant::now();
    let probe = tokio::time::timeout(Duration::from_secs(5), async {
        let (client, connection) = config.connect(NoTls).await?;
        let conn_task = tokio::spawn(async move {
            let _ = connection.await;
        });

        let vec_row = client
            .query_opt(
                "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
                &[],
            )
            .await?;
        let pgvector_version: Option<String> = vec_row.map(|r| r.get::<_, String>(0));

        let count_row = client.query_one("SELECT COUNT(*) FROM docs", &[]).await?;
        let doc_count: i64 = count_row.get(0);

        // Drop client first, then the connection task resolves.
        drop(client);
        let _ = conn_task.await;
        Ok::<_, tokio_postgres::Error>((pgvector_version, doc_count))
    })
    .await;

    match probe {
        Ok(Ok((version, doc_count))) => {
            let latency_ms = (started.elapsed().as_secs_f64() * 1000.0 * 10.0).round() / 10.0;
            Ok(json!({
                "reachable": true,
                "latency_ms": latency_ms,
                "pgvector_version": version,
                "doc_count": doc_count,
            }))
        }
        Ok(Err(e)) => Ok(json!({
            "reachable": false,
            "error": truncate_200(&e.to_string()),
        })),
        Err(_) => Ok(json!({
            "reachable": false,
            "error": "connect timed out after 5s",
        })),
    }
}

fn truncate_200(s: &str) -> String {
    if s.len() > 200 {
        s.chars().take(200).collect()
    } else {
        s.to_string()
    }
}

pub async fn sync_status(state: &AppState) -> anyhow::Result<Value> {
    // Python: `_backend.sync_status if hasattr(_backend, 'sync_status')
    // else {"error": "not in two-tier mode"}`. Only the two-tier backend
    // carries a `SyncWorker`, so for sqlite / pgvector we return the
    // identical Python error shape.
    match &state.two_tier {
        None => Ok(json!({"error": "not in two-tier mode"})),
        Some(tt) => {
            let s = tt.status();
            // Python's status dict (two_tier.py::SyncWorker.status) rounds
            // last_sync_ms to 1 decimal place; do the same here. The two
            // extra fields (backoff_ms, last_error) are Rust-only but
            // useful; they're optional (default 0 / null) so consumers
            // that ignore them keep working.
            Ok(json!({
                "pending_docs": s.pending_docs,
                "last_sync_at": s.last_sync_at,
                "last_sync_docs": s.last_sync_docs,
                "last_sync_ms": round_f64(s.last_sync_ms, 1),
                "pgvector_reachable": s.pgvector_reachable,
                "backoff_ms": s.backoff_ms,
                "last_error": s.last_error,
            }))
        }
    }
}

