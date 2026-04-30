//! `ContextEngine` — composes storage + retriever + compressor.
//!
//! Direct port of `context-engine/context_engineering.py::ContextEngine` (183
//! LOC), with one intentional deviation: the Rust engine has NO memory
//! module. The Python sidecar never exposes `remember()` over RPC, so
//! `engine._memory` is always empty in production. We preserve the API
//! surface (`budget_summary.history = 0`, `metadata.memory_turns_total = 0`)
//! so the packet is still shape-identical to Python's output.
//!
//! ## Flow (`build_context`)
//!
//! 1. Init a token budget with `total = total_token_budget`.
//! 2. Reserve the system prompt's tokens.
//! 3. Retrieve `retrieval_top_k * 2` candidates:
//!      * Storage backend → cosine-similarity hits.
//!      * In-memory TF-IDF index → TF-IDF scores.
//!      * Hybrid blender → `alpha * cosine + (1 - alpha) * tfidf`, sort
//!        DESC, truncate to `retrieval_top_k * 2`.
//! 4. Re-rank (boost docs whose tags match `memory|context|rag|embedding`
//!    by `1.4×`), sort, truncate to `retrieval_top_k`.
//! 5. Reserve 0 tokens for `history` (empty memory).
//! 6. Compute `remaining_chars = (remaining_tokens) * 4`, build a
//!    [`Compressor`] with that char budget, and compress the selected
//!    docs' text.
//! 7. Reserve the compressed docs' tokens under `retrieved_docs`.
//! 8. Assemble [`BuildContextPacket`].
//!
//! ## Hydration
//!
//! Python hydrates a per-domain `ContextEngine` lazily inside
//! `sidecar.py::_get_engine`: it creates an empty engine and calls
//! `engine.add_document(...)` for every record returned by
//! `backend.list_docs(domain, limit=1_000_000)`. The Rust mirror is
//! [`ContextEngine::reindex`], which drops the TF-IDF index and rebuilds
//! it from the backend. Callers should invoke it on cold-start and after
//! any batch mutation (Python drops the engine cache; we reindex).
//!
//! ## Byte-exact parity notes
//!
//! * `match_reason` strings preserve the Greek α used in the Python hybrid
//!   retriever (`"hybrid (α=0.65)"`). The re-ranker appends `" → reranked"`.
//! * Score rounding is 4 decimals everywhere — applied by the hybrid
//!   blender and again by our re-rank step (Python: `round(final_score,
//!   4)`).
//! * `list_docs` returns newest-first (matches Python), but the hybrid
//!   scoring path re-sorts by score so initial iteration order doesn't
//!   affect the packet.
//! * The Rust `retrieval_mode` reported in metadata is always `"hybrid"`
//!   (the only mode the sidecar exposes — see `sidecar.py:183`).

use std::sync::Arc;

use ob2_retriever::{HybridScorer, TfIdfIndex};
use ob2_storage::{DocHit, StorageBackend};

use crate::compressor::{estimate_tokens_default, Compressor, Strategy};
use crate::packet::{BudgetSummary, BuildContextPacket, Metadata, RetrievedDoc};

// ─────────────────────────────────────────────────────────────
// Defaults — mirror `ContextEngine.__init__` in Python.
// ─────────────────────────────────────────────────────────────

/// `DEFAULT_TOKEN_BUDGET=2048` — matches Python sidecar env default.
pub const DEFAULT_TOTAL_TOKEN_BUDGET: usize = 2048;
/// `DEFAULT_TOP_K=5` — matches Python sidecar env default.
pub const DEFAULT_RETRIEVAL_TOP_K: usize = 5;
/// `DEFAULT_ALPHA=0.65` — matches Python sidecar env default.
pub const DEFAULT_HYBRID_ALPHA: f32 = 0.65;
/// Python: `"You are a helpful assistant."` — but the sidecar overrides
/// this to `"Use the sources below. If not in sources, say you don't know."`
/// (see `sidecar.py:186`). We keep Python's class-level default here; the
/// sidecar binary in Task 7 will pass the override explicitly via config.
pub const DEFAULT_SYSTEM_PROMPT: &str = "You are a helpful assistant.";

/// Minimum total token budget — matches `context_engineering.py:81`
/// (`if total_token_budget < 64: raise`).
const MIN_TOTAL_BUDGET: usize = 64;

// ─────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum ContextEngineError {
    #[error("total_token_budget must be >= {MIN_TOTAL_BUDGET}, got {0}.")]
    InvalidTokenBudget(usize),

    #[error("retrieval_top_k must be >= 1, got {0}.")]
    InvalidTopK(usize),

    #[error("query must not be empty.")]
    EmptyQuery,

    #[error("storage error: {0}")]
    Storage(#[from] ob2_storage::StorageError),

    #[error("compressor error: {0}")]
    Compressor(#[from] crate::compressor::CompressorError),
}

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

/// Config knobs for a `ContextEngine`. Field names match Python's
/// `__init__` parameters.
#[derive(Debug, Clone)]
pub struct EngineConfig {
    pub total_token_budget: usize,
    pub retrieval_top_k: usize,
    pub compression_strategy: Strategy,
    pub hybrid_alpha: f32,
    pub system_prompt: String,
}

impl EngineConfig {
    /// Expose validation to external crates (sidecar uses this when patching
    /// a per-request budget override).
    pub fn validated(self) -> Result<Self, ContextEngineError> {
        self.validate()?;
        Ok(self)
    }
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            total_token_budget: DEFAULT_TOTAL_TOKEN_BUDGET,
            retrieval_top_k: DEFAULT_RETRIEVAL_TOP_K,
            compression_strategy: Strategy::Extractive,
            hybrid_alpha: DEFAULT_HYBRID_ALPHA,
            system_prompt: DEFAULT_SYSTEM_PROMPT.to_string(),
        }
    }
}

impl EngineConfig {
    fn validate(&self) -> Result<(), ContextEngineError> {
        if self.total_token_budget < MIN_TOTAL_BUDGET {
            return Err(ContextEngineError::InvalidTokenBudget(
                self.total_token_budget,
            ));
        }
        if self.retrieval_top_k < 1 {
            return Err(ContextEngineError::InvalidTopK(self.retrieval_top_k));
        }
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────
// Engine
// ─────────────────────────────────────────────────────────────

/// The per-domain engine. Owns a reference-counted `StorageBackend` +
/// an in-memory TF-IDF index hydrated from that backend.
///
/// Re-index the TF-IDF after any bulk write with [`reindex`]. For point
/// writes the sidecar's Task-7 dispatch will call `add_doc` directly.
pub struct ContextEngine {
    backend: Arc<dyn StorageBackend>,
    tfidf: TfIdfIndex,
    scorer: HybridScorer,
    config: EngineConfig,
    domain: String,
}

impl ContextEngine {
    /// Create an engine bound to a domain. The TF-IDF index starts empty;
    /// call [`reindex`] to hydrate from the backend.
    pub fn new(
        backend: Arc<dyn StorageBackend>,
        domain: String,
        config: EngineConfig,
    ) -> Result<Self, ContextEngineError> {
        config.validate()?;
        let scorer = HybridScorer::new(config.hybrid_alpha);
        Ok(Self {
            backend,
            tfidf: TfIdfIndex::new(),
            scorer,
            config,
            domain,
        })
    }

    /// Build a default-config engine — the common case for the sidecar.
    pub fn with_defaults(
        backend: Arc<dyn StorageBackend>,
        domain: String,
    ) -> Result<Self, ContextEngineError> {
        Self::new(backend, domain, EngineConfig::default())
    }

    /// Borrow the current config.
    pub fn config(&self) -> &EngineConfig {
        &self.config
    }

    /// Override the total token budget (matches Python's
    /// `engine.total_token_budget = budget` at `sidecar.py:329`).
    pub fn set_total_token_budget(&mut self, budget: usize) -> Result<(), ContextEngineError> {
        if budget < MIN_TOTAL_BUDGET {
            return Err(ContextEngineError::InvalidTokenBudget(budget));
        }
        self.config.total_token_budget = budget;
        Ok(())
    }

    /// Incrementally add a single doc to the TF-IDF index. Mirrors
    /// Python `engine.add_document(doc)`. The caller is responsible for
    /// also persisting the doc to the storage backend (the sidecar's
    /// `capture` RPC does both).
    pub fn add_doc(&mut self, doc_id: &str, text: &str) {
        self.tfidf.add(doc_id, text);
    }

    /// Drop and rebuild the TF-IDF index from the backend's current docs
    /// in this engine's domain.
    ///
    /// Matches `sidecar.py::_get_engine` hydration: pulls up to 1,000,000
    /// docs with `list_docs(..., limit=1_000_000)`.
    pub async fn reindex(&mut self) -> Result<usize, ContextEngineError> {
        let docs = self
            .backend
            .list_docs(&self.domain, 1_000_000, 0, None)
            .await?;
        let mut idx = TfIdfIndex::new();
        for d in &docs {
            idx.add(&d.doc_id, &d.text);
        }
        self.tfidf = idx;
        Ok(docs.len())
    }

    /// Count of docs currently indexed. Useful for tests.
    pub fn len(&self) -> usize {
        self.tfidf.len()
    }

    /// True if the TF-IDF index holds no docs.
    pub fn is_empty(&self) -> bool {
        self.tfidf.is_empty()
    }

    /// Build the full context packet. Port of Python `ContextEngine.build`
    /// (context_engineering.py:112-153).
    ///
    /// `query_embedding` is the pre-computed embedding for `query`; the
    /// engine does not own an embedder (Task 4 lives in `ob2-embedder`).
    pub async fn build_context(
        &self,
        query: &str,
        query_embedding: &[f32],
    ) -> Result<BuildContextPacket, ContextEngineError> {
        if query.trim().is_empty() {
            return Err(ContextEngineError::EmptyQuery);
        }

        // ── Empty-domain short-circuit ────────────────────────
        // Mirrors `sidecar.py:320-326`: if the domain has zero docs,
        // return the unknown_domain envelope and don't run the engine.
        let stats = self.backend.domain_stats(&self.domain).await?;
        if stats.doc_count == 0 {
            return Ok(BuildContextPacket::unknown_domain());
        }

        // ── Budget init ───────────────────────────────────────
        // TokenBudget semantics (compressor.py:247-276):
        //   - `reserve_text(slot, text)` = estimate_tokens(text)
        //   - `remaining() = max(0, total - sum(used))`
        //   - `remaining_chars() = remaining() * 4`
        let total = self.config.total_token_budget;
        let system_tokens = estimate_tokens_default(&self.config.system_prompt);

        // ── Retrieval ─────────────────────────────────────────
        // Python: top_k = retrieval_top_k * 2 for the initial retrieve.
        let initial_top_k = self.config.retrieval_top_k * 2;
        let scored_hits = self
            .retrieve_hybrid(query, query_embedding, initial_top_k)
            .await?;

        // ── Re-rank + truncate ────────────────────────────────
        let reranked = self.rerank(&scored_hits);
        let top: Vec<&DocHit> = reranked
            .iter()
            .take(self.config.retrieval_top_k)
            .collect();

        // ── Build the retrieved_docs list (for the packet) ───
        let retrieved_docs: Vec<RetrievedDoc> = top
            .iter()
            .map(|h| hit_to_retrieved_doc(h))
            .collect();

        // Extract raw chunks for compression — Python uses `doc.content`.
        let raw_chunks: Vec<String> = top.iter().map(|h| h.text.clone()).collect();

        // ── History slot (always empty in Rust) ──────────────
        let history_tokens: usize = 0;

        // ── Remaining chars → compressor budget ──────────────
        let used_so_far = system_tokens + history_tokens;
        let remaining_tokens = total.saturating_sub(used_so_far);
        let remaining_chars = remaining_tokens * 4;
        let max_chars = remaining_chars.max(1);

        let compressor = Compressor::with_budget(max_chars, self.config.compression_strategy)?;
        let result = compressor.compress(&raw_chunks, query);

        let docs_tokens = estimate_tokens_default(&result.text);

        // ── Assemble packet ──────────────────────────────────
        let budget_summary = BudgetSummary {
            system_prompt: system_tokens as i64,
            history: history_tokens as i64,
            retrieved_docs: docs_tokens as i64,
        };

        let metadata = Metadata {
            compression_ratio: result.compression_ratio(),
            tokens_saved: result.estimated_tokens_saved as i64,
            strategy_used: result.strategy_used.clone(),
            memory_turns_total: 0,
            retrieval_mode: "hybrid".to_string(),
        };

        Ok(BuildContextPacket {
            compressed_text: result.text,
            retrieved_docs,
            budget_summary: Some(budget_summary),
            metadata: Some(metadata),
            unknown_domain: None,
        })
    }

    /// Public hybrid retrieval entry point. Mirrors Python's
    /// `Retriever.retrieve(query, top_k=k, alpha=a)` (retriever.py:238-255)
    /// for mode="hybrid" — the only mode the sidecar exposes.
    ///
    /// Unlike `build_context`, this does NOT run the re-rank step (Python's
    /// `method_retrieve` calls `engine._retriever.retrieve(...)` directly,
    /// bypassing `ContextEngine._rerank`). Returned hits carry the
    /// `"hybrid (α=X.XX)"` match_reason from the scorer.
    pub async fn retrieve(
        &self,
        query: &str,
        query_embedding: &[f32],
        top_k: usize,
        alpha: f32,
    ) -> Result<Vec<DocHit>, ContextEngineError> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }
        if top_k < 1 {
            return Err(ContextEngineError::InvalidTopK(top_k));
        }
        let scorer = HybridScorer::new(alpha);
        self.retrieve_hybrid_with(&scorer, query, query_embedding, top_k)
            .await
    }

    // ── Internals ─────────────────────────────────────────────

    /// Hybrid retrieve with an explicit scorer — shared by `retrieve` and
    /// `build_context`.
    async fn retrieve_hybrid_with(
        &self,
        scorer: &HybridScorer,
        query: &str,
        query_embedding: &[f32],
        top_k: usize,
    ) -> Result<Vec<DocHit>, ContextEngineError> {
        let candidate_k = std::cmp::max(top_k, self.tfidf.len().max(1));
        let cosine_hits = self
            .backend
            .query_similar(&self.domain, query_embedding, candidate_k, None)
            .await?;
        let tfidf_top: Vec<(String, f32)> = self.tfidf.score_top_k(query, 12);
        let tfidf_map: std::collections::HashMap<String, f32> =
            tfidf_top.into_iter().collect();
        let paired: Vec<(DocHit, f32)> = cosine_hits
            .into_iter()
            .map(|hit| {
                let tf = tfidf_map.get(&hit.doc_id).copied().unwrap_or(0.0);
                (hit, tf)
            })
            .collect();
        Ok(scorer.blend(&paired, top_k))
    }

    /// Hybrid retrieve: blend storage cosine hits with TF-IDF scores.
    ///
    /// Python's `_hybrid_retrieve` (retriever.py:304-335) scores EVERY
    /// indexed doc. We approximate by asking the storage backend for
    /// `max(top_k, tfidf.len())` cosine candidates — which in practice
    /// means "all docs" because `tfidf.len()` is the full domain doc
    /// count after `reindex()`. This matches Python's behavior for
    /// realistic domain sizes (thousands of docs) without O(n^2) recompute.
    async fn retrieve_hybrid(
        &self,
        query: &str,
        query_embedding: &[f32],
        top_k: usize,
    ) -> Result<Vec<DocHit>, ContextEngineError> {
        self.retrieve_hybrid_with(&self.scorer, query, query_embedding, top_k)
            .await
    }

    /// Multi-factor re-rank. Port of `ContextEngine._rerank`
    /// (context_engineering.py:155-174).
    ///
    /// Python:
    /// ```python
    /// importance = 1.4 if any(tag in doc.tags for tag in
    ///     ["memory", "context", "rag", "embedding"]) else 1.0
    /// final_score = base * 0.68 + importance * 0.32
    /// ```
    ///
    /// The match_reason gets `" → reranked"` appended.
    fn rerank(&self, hits: &[DocHit]) -> Vec<DocHit> {
        const BOOST_TAGS: &[&str] = &["memory", "context", "rag", "embedding"];

        let mut out: Vec<DocHit> = hits
            .iter()
            .map(|h| {
                let tags = extract_tags(&h.metadata);
                let has_boost_tag = tags.iter().any(|t| BOOST_TAGS.contains(&t.as_str()));
                let importance: f64 = if has_boost_tag { 1.4 } else { 1.0 };
                let base = f64::from(h.score);
                let final_score = base * 0.68 + importance * 0.32;
                // round(x, 4).
                let rounded = ((final_score * 10_000.0).round() / 10_000.0) as f32;

                // Append `" → reranked"` to the match_reason stored in metadata.
                let mut meta = h.metadata.clone();
                if let serde_json::Value::Object(ref mut m) = meta {
                    let prior = m
                        .get("match_reason")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let new_reason = format!("{prior} → reranked");
                    m.insert(
                        "match_reason".to_string(),
                        serde_json::Value::String(new_reason),
                    );
                }

                DocHit {
                    doc_id: h.doc_id.clone(),
                    text: h.text.clone(),
                    metadata: meta,
                    score: rounded,
                    created_at: h.created_at.clone(),
                }
            })
            .collect();

        out.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        out
    }
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/// Pull `tags` out of a metadata JSON object. Matches Python's
/// `doc.tags` (`retriever.py:104-109`) which is a `List[str]`.
fn extract_tags(meta: &serde_json::Value) -> Vec<String> {
    meta.get("tags")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// Pull `source` out of a metadata JSON object. Defaults to `"backend"`
/// matching Python (`sidecar.py:195`).
fn extract_source(meta: &serde_json::Value) -> String {
    meta.get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("backend")
        .to_string()
}

/// Pull `match_reason` out of metadata (stored by the hybrid blender
/// and re-rank step). Defaults to empty string.
fn extract_match_reason(meta: &serde_json::Value) -> String {
    meta.get("match_reason")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn hit_to_retrieved_doc(h: &DocHit) -> RetrievedDoc {
    RetrievedDoc {
        doc_id: h.doc_id.clone(),
        content: h.text.clone(),
        score: h.score,
        match_reason: extract_match_reason(&h.metadata),
        tags: extract_tags(&h.metadata),
        source: extract_source(&h.metadata),
        created_at: h.created_at.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extract_tags_from_metadata() {
        let m = json!({"tags": ["a", "b"], "source": "x"});
        assert_eq!(extract_tags(&m), vec!["a", "b"]);
    }

    #[test]
    fn extract_tags_missing() {
        let m = json!({});
        assert!(extract_tags(&m).is_empty());
    }

    #[test]
    fn extract_source_defaults_to_backend() {
        let m = json!({});
        assert_eq!(extract_source(&m), "backend");
    }
}
