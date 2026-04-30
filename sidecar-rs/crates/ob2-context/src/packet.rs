//! Response shape of the `build_context` RPC.
//!
//! Matches `retrieval/sidecar.py::method_build_context` (lines 315-349)
//! byte-for-byte so the golden harness in Task 7 can diff Rust vs Python
//! outputs without a schema translation layer.
//!
//! Python returns, on success:
//! ```jsonc
//! {
//!   "compressed_text": "…",
//!   "retrieved_docs": [
//!     {
//!       "doc_id":       "id",
//!       "content":      "text",
//!       "score":        0.1234,      // float
//!       "match_reason": "hybrid (α=0.65)",
//!       "tags":         ["…", "…"],
//!       "source":       "backend"
//!     }, …
//!   ],
//!   "budget_summary": {
//!     // int token counts, underscore-prefixed keys (_remaining, _total)
//!     // are filtered out
//!     "system_prompt":   12,
//!     "history":         0,
//!     "retrieved_docs":  345
//!   },
//!   "metadata": {
//!     "compression_ratio":  0.42,    // rounded to 3 decimals by Python
//!     "tokens_saved":       128,
//!     "strategy_used":      "extractive",
//!     "memory_turns_total": 0,
//!     "retrieval_mode":     "hybrid"
//!   }
//! }
//! ```
//!
//! Or on empty domain:
//! ```jsonc
//! {
//!   "compressed_text":  "",
//!   "retrieved_docs":   [],
//!   "unknown_domain":   true
//! }
//! ```
//!
//! Notes on field-level parity:
//!   * `score` is `float(h.score)` in Python — a plain `f64` JSON number.
//!     We serialize `f32` here; serde_json emits it as a number without
//!     the synthetic precision Python has. The golden harness already
//!     tolerates `1e-4` absolute error on float scalars.
//!   * `match_reason` is the literal string emitted by the retriever
//!     (e.g. `"hybrid (α=0.65)"` — includes the Greek letter α).
//!   * `unknown_domain` is omitted when false, matching Python's dict
//!     which only sets it on the empty-domain branch. We use
//!     `#[serde(skip_serializing_if = "Option::is_none")]`.
//!   * `budget_summary` and `metadata` are fixed-shape structs in Rust
//!     (vs Python's dict) so the key order is deterministic.

use serde::{Deserialize, Serialize};

/// A retrieved document entry inside the packet.
///
/// Matches the dict comprehension at `sidecar.py:334-342`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RetrievedDoc {
    pub doc_id: String,
    pub content: String,
    pub score: f32,
    pub match_reason: String,
    pub tags: Vec<String>,
    pub source: String,
    /// ISO-8601 capture timestamp. Mirrors Python `sidecar.py:346`.
    #[serde(default)]
    pub created_at: String,
}

/// The three token slots emitted in `budget_summary`.
///
/// Python filters out `_remaining` and `_total` (see `sidecar.py:345-347`).
/// The remaining keys are always `system_prompt`, `history`, and
/// `retrieved_docs` — in that insertion order in Python, so we preserve
/// it here as a struct.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BudgetSummary {
    pub system_prompt: i64,
    pub history: i64,
    pub retrieved_docs: i64,
}

/// Free-form metadata dict emitted by the packet.
///
/// Python's `ContextPacket.metadata` has 5 fixed keys (see
/// `context_engineering.py:146-152`): `compression_ratio`,
/// `tokens_saved`, `strategy_used`, `memory_turns_total`, `retrieval_mode`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Metadata {
    /// `compressed_chars / original_chars`, rounded to 3 decimals.
    /// Matches `CompressionResult.compression_ratio`.
    pub compression_ratio: f32,
    /// Tokens saved by compression (clamped to >= 0 in Python).
    pub tokens_saved: i64,
    /// One of `"none (empty input)"`, `"none (fits budget)"`,
    /// `"truncate"`, `"sentence"`, `"extractive"`.
    pub strategy_used: String,
    /// Total memory turns (always 0 in the Rust port; kept for parity).
    pub memory_turns_total: i64,
    /// `"keyword"`, `"tfidf"`, or `"hybrid"`.
    pub retrieval_mode: String,
}

/// Full response body for `build_context`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BuildContextPacket {
    pub compressed_text: String,
    pub retrieved_docs: Vec<RetrievedDoc>,

    /// Token budget breakdown. Absent on the unknown-domain branch, so
    /// wrapped in `Option` and skipped on serialize if `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget_summary: Option<BudgetSummary>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Metadata>,

    /// Only set (to `true`) when the domain has zero docs. Omitted
    /// otherwise to match Python's dict shape exactly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unknown_domain: Option<bool>,
}

impl BuildContextPacket {
    /// Convenience constructor for the unknown-domain response.
    pub fn unknown_domain() -> Self {
        Self {
            compressed_text: String::new(),
            retrieved_docs: Vec::new(),
            budget_summary: None,
            metadata: None,
            unknown_domain: Some(true),
        }
    }
}
