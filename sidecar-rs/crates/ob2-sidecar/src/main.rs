//! `ob2-sidecar` — JSON-RPC 2.0 front-end for OB2 retrieval.
//!
//! Reads newline-delimited JSON-RPC requests from stdin, dispatches to
//! `methods::*` handlers, and writes responses through a single-writer
//! task. Matches the Python reference in `retrieval/sidecar.py` method
//! for method.

use anyhow::Result;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

mod methods;
mod state;

use state::AppState;

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--warm-embedder") {
        let _ = ob2_embedder::Embedder::load(ob2_embedder::DEFAULT_MODEL)?;
        eprintln!("warm-embedder: ok");
        return Ok(());
    }

    let state = AppState::from_env().await?;

    // Single writer task — drains a channel and writes to stdout. Keeps
    // response-line atomicity without each handler contending on stdout.
    let (tx_out, mut rx_out) = mpsc::unbounded_channel::<String>();
    let writer_task = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(line) = rx_out.recv().await {
            if stdout.write_all(line.as_bytes()).await.is_err() {
                break;
            }
            if stdout.write_all(b"\n").await.is_err() {
                break;
            }
            if stdout.flush().await.is_err() {
                break;
            }
        }
    });

    // Spawn-per-request reader loop.
    let stdin = tokio::io::stdin();
    let mut reader = BufReader::new(stdin).lines();
    while let Some(line) = reader.next_line().await? {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        let state_c = state.clone();
        let tx_c = tx_out.clone();
        tokio::spawn(async move {
            let resp = handle_line(&state_c, &line).await;
            let _ = tx_c.send(resp);
        });
    }
    drop(tx_out);
    let _ = writer_task.await;
    Ok(())
}

async fn handle_line(state: &AppState, line: &str) -> String {
    let req: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return error_resp(Value::Null, -32700, &format!("parse error: {e}")),
    };
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let method = req.get("method").and_then(|m| m.as_str()).unwrap_or("");
    let params = req.get("params").cloned().unwrap_or(json!({}));

    let result = dispatch(state, method, params).await;
    match result {
        Ok(v) => ok_resp(id, v),
        Err(e) => {
            let msg = e.to_string();
            let code = if msg.starts_with("method not found") {
                -32601
            } else if msg.starts_with("missing param") {
                -32602
            } else {
                -32603
            };
            error_resp(id, code, &msg)
        }
    }
}

async fn dispatch(state: &AppState, method: &str, params: Value) -> Result<Value> {
    match method {
        "ping" => methods::ping(state).await,
        "capture" => methods::capture(state, params).await,
        "capture_batch" => methods::capture_batch(state, params).await,
        "retrieve" => methods::retrieve(state, params).await,
        "build_context" => methods::build_context(state, params).await,
        "knowledge_stats" => methods::knowledge_stats(state, params).await,
        "list_domains" => methods::list_domains(state).await,
        "delete" => methods::delete(state, params).await,
        "delete_domain" => methods::delete_domain(state, params).await,
        "has_source" => methods::has_source(state, params).await,
        "record_source" => methods::record_source(state, params).await,
        "upsert_alias" => methods::upsert_alias(state, params).await,
        "resolve_alias" => methods::resolve_alias(state, params).await,
        "list_aliases" => methods::list_aliases(state, params).await,
        "suggest_domains" => methods::suggest_domains(state, params).await,
        "batcher_stats" => methods::batcher_stats(state).await,
        "record_classifier_decision" => methods::record_classifier_decision(state, params).await,
        "classifier_stats" => methods::classifier_stats(state).await,
        "test_pgvector" => methods::test_pgvector(state, params).await,
        "sync_status" => methods::sync_status(state).await,
        other => Err(anyhow::anyhow!("method not found: {other}")),
    }
}

fn ok_resp(id: Value, result: Value) -> String {
    serde_json::to_string(&json!({ "jsonrpc": "2.0", "id": id, "result": result })).unwrap()
}

fn error_resp(id: Value, code: i64, message: &str) -> String {
    serde_json::to_string(&json!({
        "jsonrpc": "2.0", "id": id,
        "error": { "code": code, "message": message }
    }))
    .unwrap()
}
