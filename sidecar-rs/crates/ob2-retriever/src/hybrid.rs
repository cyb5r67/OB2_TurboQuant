//! Hybrid TF-IDF + cosine blender — port of
//! `context-engine/retriever.py::Retriever._hybrid_retrieve`.
//!
//! Python reference (condensed):
//! ```python
//! def _hybrid_retrieve(self, query, top_k, alpha=0.65):
//!     tfidf_results = self._tfidf_retrieve(query, top_k=12)
//!     tfidf_dict = {r.document.id: r.score for r in tfidf_results}
//!     emb_scores = self.embedding_engine.similarity(query_emb, self._doc_embeddings)
//!     results = []
//!     for i, doc in enumerate(self.documents):
//!         tf_score = tfidf_dict.get(doc.id, 0.0)
//!         emb_score = float(emb_scores[i])
//!         hybrid_score = alpha * emb_score + (1 - alpha) * tf_score
//!         results.append(ScoredDocument(
//!             document=doc,
//!             score=round(hybrid_score, 4),
//!             match_reason=f"hybrid (α={alpha:.2f})",
//!         ))
//!     results.sort(key=lambda x: x.score, reverse=True)
//!     return results[:top_k]
//! ```
//!
//! Key things to mirror exactly:
//!   * formula: `alpha * emb + (1 - alpha) * tfidf`
//!   * `tf_score` defaults to 0.0 when the doc isn't in the TF-IDF top-12
//!   * score rounded to 4 decimals
//!   * `match_reason` is the literal string `"hybrid (α=0.65)"` (with the
//!     Greek alpha and two-decimal alpha value) — NOT "tfidf"/"semantic"/
//!     "hybrid". The task plan's sketch was wrong about the reason
//!     classification; we follow Python so golden fixtures in Task 7
//!     match the Python sidecar's output byte-for-byte.
//!   * Sort DESC by blended score, stable on ties; truncate to `top_k`.

use ob2_storage::DocHit;

/// Default alpha blend weight, matching Python's
/// `_hybrid_retrieve(..., alpha: float = 0.65)` and the sidecar env
/// default `OB2_HYBRID_ALPHA=0.65`.
pub const DEFAULT_ALPHA: f32 = 0.65;

/// Hybrid blender.
#[derive(Debug, Clone, Copy)]
pub struct HybridScorer {
    alpha: f32,
}

impl HybridScorer {
    pub fn new(alpha: f32) -> Self {
        Self { alpha }
    }

    pub fn alpha(&self) -> f32 {
        self.alpha
    }

    /// Blend cosine (from `DocHit.score`) with per-doc TF-IDF scores.
    ///
    /// Each `candidates[i]` is `(hit, tfidf_score)` where `hit.score` is
    /// the cosine similarity from a semantic search and `tfidf_score` is
    /// the score from `TfIdfIndex::score_top_k` (or `0.0` if the doc
    /// wasn't in the TF-IDF top candidates — just like Python's
    /// `tfidf_dict.get(doc.id, 0.0)`).
    ///
    /// The returned `DocHit.score` is the blended score rounded to 4
    /// decimals. `match_reason` is set to the Python-compatible
    /// `"hybrid (α=0.65)"` string (or whatever alpha you passed).
    ///
    /// Results are sorted DESC by blended score and truncated to
    /// `top_k`.
    pub fn blend(&self, candidates: &[(DocHit, f32)], top_k: usize) -> Vec<DocHit> {
        let alpha = f64::from(self.alpha);
        let reason = format!("hybrid (α={:.2})", self.alpha);

        let mut out: Vec<DocHit> = candidates
            .iter()
            .map(|(hit, tf_score)| {
                let emb = f64::from(hit.score);
                let tf = f64::from(*tf_score);
                let blended = alpha * emb + (1.0 - alpha) * tf;
                // round(x, 4), same convention as tfidf scoring.
                let rounded = ((blended * 10_000.0).round() / 10_000.0) as f32;
                DocHit {
                    doc_id: hit.doc_id.clone(),
                    text: hit.text.clone(),
                    metadata: hit.metadata.clone(),
                    score: rounded,
                    created_at: hit.created_at.clone(),
                }
            })
            .collect();

        // Stamp the match_reason into metadata. DocHit has no explicit
        // match_reason field (it's Python-side ScoredDocument state), so
        // we store it under metadata["match_reason"] for callers that
        // want the Python-compatible string. This keeps DocHit's shape
        // unchanged.
        for hit in &mut out {
            if let serde_json::Value::Object(ref mut m) = hit.metadata {
                m.insert(
                    "match_reason".to_string(),
                    serde_json::Value::String(reason.clone()),
                );
            } else {
                // If metadata isn't an object (unusual), wrap it so we
                // can attach the reason.
                let mut m = serde_json::Map::new();
                m.insert(
                    "match_reason".to_string(),
                    serde_json::Value::String(reason.clone()),
                );
                hit.metadata = serde_json::Value::Object(m);
            }
        }

        out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
        if out.len() > top_k {
            out.truncate(top_k);
        }
        out
    }
}

impl Default for HybridScorer {
    fn default() -> Self {
        Self::new(DEFAULT_ALPHA)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn hit(doc_id: &str, text: &str, cosine: f32) -> DocHit {
        DocHit {
            doc_id: doc_id.into(),
            text: text.into(),
            metadata: json!({}),
            score: cosine,
            created_at: String::new(),
        }
    }

    #[test]
    fn default_alpha_is_0_65() {
        assert_eq!(HybridScorer::default().alpha(), 0.65);
    }

    #[test]
    fn pure_cosine_no_tfidf() {
        let s = HybridScorer::new(0.65);
        let hits = s.blend(&[(hit("d1", "text", 0.9), 0.0)], 10);
        // 0.65 * 0.9 + 0.35 * 0.0 = 0.585 → rounds to 0.585
        assert!((hits[0].score - 0.585).abs() < 1e-4);
    }

    #[test]
    fn pure_tfidf_zero_cosine() {
        let s = HybridScorer::new(0.65);
        let hits = s.blend(&[(hit("d1", "text", 0.0), 0.6)], 10);
        // 0.65 * 0 + 0.35 * 0.6 = 0.21
        assert!((hits[0].score - 0.21).abs() < 1e-4);
    }

    #[test]
    fn match_reason_in_metadata() {
        let s = HybridScorer::new(0.65);
        let hits = s.blend(&[(hit("d1", "x", 0.5), 0.5)], 10);
        let r = hits[0]
            .metadata
            .get("match_reason")
            .and_then(|v| v.as_str())
            .unwrap();
        // Python uses lowercase Greek α and two-decimal alpha.
        assert_eq!(r, "hybrid (α=0.65)");
    }
}
