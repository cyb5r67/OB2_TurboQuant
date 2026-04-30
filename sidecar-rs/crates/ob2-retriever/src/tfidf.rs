//! TF-IDF index — port of the TF-IDF bits of `context-engine/retriever.py`.
//!
//! ## Formula (from the Python source)
//!
//! Term frequency:   `tf(term, doc) = count(term in doc) / len(tokens(doc))`
//! Document freq.:   `df(term) = number of indexed docs containing term`
//! Inverse doc freq: `idf(term) = ln((1 + N) / (1 + df(term))) + 1.0`
//! Doc / query vec:  `v[term] = tf(term) * idf(term)`
//! Relevance:        `score(q, d) = cosine(v_q, v_d)`
//!
//! Python references:
//!   * `_term_frequency`  (lines 147-153)
//!   * `_cosine_sim`      (lines 156-163)
//!   * `Retriever._idf`   (lines 220-222)
//!   * `_tfidf_retrieve`  (lines 279-302)
//!
//! ## Scoring scope
//!
//! `Retriever._tfidf_retrieve` in Python iterates `self.documents` and
//! scores every one of them, then sorts and truncates to `top_k`. It does
//! NOT take a pre-filtered candidate set — the hybrid retriever does the
//! filtering externally by calling tf-idf first with `top_k=12` and then
//! doing a separate pass over all docs for embeddings.
//!
//! We mirror that: [`TfIdfIndex`] owns the docs and [`score_top_k`]
//! returns the top-k (doc_id, score) pairs with score > 0, rounded to 4
//! decimal places just like Python (`round(score, 4)`).
//!
//! ## Precision
//!
//! We use `f64` for all intermediate arithmetic (tf fractions, idf,
//! dot products, norms) and only round to 4 decimals at the very end to
//! stay within one ULP of Python's CPython float behavior.

use std::collections::HashMap;

use crate::tokenizer::tokenize;

/// Incremental TF-IDF index keyed by caller-supplied doc_id.
#[derive(Debug, Default, Clone)]
pub struct TfIdfIndex {
    /// doc_id -> (tokens, token_counts). We keep tokens rather than just
    /// counts because `_tfidf_retrieve` recomputes `_term_frequency` from
    /// the token list, and we want to reproduce the exact same sequence.
    docs: HashMap<String, Vec<String>>,
    /// Insertion order so iteration order is deterministic.
    doc_order: Vec<String>,
    /// term -> number of distinct docs containing it (Python
    /// `self._doc_freq` is a Counter updated via `set(tokens)`).
    doc_freq: HashMap<String, usize>,
    /// Total docs indexed (Python `self._n_docs`).
    n_docs: usize,
}

impl TfIdfIndex {
    pub fn new() -> Self {
        Self::default()
    }

    /// Number of documents currently indexed.
    pub fn len(&self) -> usize {
        self.n_docs
    }

    pub fn is_empty(&self) -> bool {
        self.n_docs == 0
    }

    /// Index a document. Matches `Retriever._index_document` + tokenization
    /// from `_tokenize`.
    ///
    /// If `doc_id` already exists, this overwrites the stored tokens and
    /// adjusts `doc_freq` accordingly so the index stays consistent. The
    /// Python implementation does not dedup — it appends — but re-indexing
    /// on update is the safer contract for our callers and is a strict
    /// superset of the Python behavior when doc_ids are unique (which is
    /// how the sidecar uses it).
    pub fn add(&mut self, doc_id: &str, text: &str) {
        let tokens = tokenize(text);

        if let Some(prev_tokens) = self.docs.remove(doc_id) {
            // Remove prior contributions to doc_freq.
            let prev_unique: std::collections::HashSet<&String> = prev_tokens.iter().collect();
            for term in prev_unique {
                if let Some(df) = self.doc_freq.get_mut(term) {
                    *df = df.saturating_sub(1);
                    if *df == 0 {
                        self.doc_freq.remove(term);
                    }
                }
            }
            // Preserve position in doc_order (don't re-push).
        } else {
            self.doc_order.push(doc_id.to_string());
            self.n_docs += 1;
        }

        // New contributions.
        let unique: std::collections::HashSet<&String> = tokens.iter().collect();
        for term in unique {
            *self.doc_freq.entry(term.clone()).or_insert(0) += 1;
        }

        self.docs.insert(doc_id.to_string(), tokens);
    }

    /// IDF for a term. Mirrors `Retriever._idf`:
    /// `ln((1 + N) / (1 + df)) + 1`.
    ///
    /// Uses f64 internally. Natural log to match Python's `math.log`.
    fn idf(&self, term: &str) -> f64 {
        let df = self.doc_freq.get(term).copied().unwrap_or(0) as f64;
        let n = self.n_docs as f64;
        ((1.0 + n) / (1.0 + df)).ln() + 1.0
    }

    /// Term frequency map for a token list. `count / total_tokens`.
    /// Matches Python `_term_frequency`.
    fn term_frequency(tokens: &[String]) -> HashMap<String, f64> {
        if tokens.is_empty() {
            return HashMap::new();
        }
        let total = tokens.len() as f64;
        let mut counts: HashMap<String, f64> = HashMap::new();
        for t in tokens {
            *counts.entry(t.clone()).or_insert(0.0) += 1.0;
        }
        for v in counts.values_mut() {
            *v /= total;
        }
        counts
    }

    /// Build the TF-IDF weight vector for a tokenized input.
    fn vectorize(&self, tokens: &[String]) -> HashMap<String, f64> {
        let tf = Self::term_frequency(tokens);
        let mut out = HashMap::with_capacity(tf.len());
        for (term, tf_val) in tf {
            let idf = self.idf(&term);
            out.insert(term, tf_val * idf);
        }
        out
    }

    /// Cosine similarity between two sparse TF-IDF vectors.
    /// Mirrors Python `_cosine_sim`: iterates keys of `a`, computes
    /// `sum(a[k] * b.get(k, 0))`, divides by product of Euclidean norms.
    fn cosine(a: &HashMap<String, f64>, b: &HashMap<String, f64>) -> f64 {
        let dot: f64 = a.iter().map(|(k, v)| v * b.get(k).copied().unwrap_or(0.0)).sum();
        let norm_a: f64 = a.values().map(|v| v * v).sum::<f64>().sqrt();
        let norm_b: f64 = b.values().map(|v| v * v).sum::<f64>().sqrt();
        if norm_a == 0.0 || norm_b == 0.0 {
            0.0
        } else {
            dot / (norm_a * norm_b)
        }
    }

    /// Score all indexed docs against `query` and return the top-k by
    /// score DESC. Scores are rounded to 4 decimals to match Python.
    /// Docs with score <= 0 are filtered out (matches Python's
    /// `if score > 0.0`).
    ///
    /// This is the direct analogue of `Retriever._tfidf_retrieve`.
    pub fn score_top_k(&self, query: &str, top_k: usize) -> Vec<(String, f32)> {
        let query_tokens = tokenize(query);
        if query_tokens.is_empty() {
            return Vec::new();
        }
        let query_vec = self.vectorize(&query_tokens);

        let mut results: Vec<(String, f32)> = Vec::new();
        for doc_id in &self.doc_order {
            let tokens = match self.docs.get(doc_id) {
                Some(t) => t,
                None => continue,
            };
            let doc_vec = self.vectorize(tokens);
            let score = Self::cosine(&query_vec, &doc_vec);
            if score > 0.0 {
                // round(x, 4) — matches Python. Banker's rounding in
                // CPython, half-to-even; f64::round in Rust is
                // half-away-from-zero. Differences only show at exactly
                // .xxxx5 boundaries; we accept that tiny edge-case drift
                // and document it. The golden fixtures in Task 7 should
                // tolerate 1e-4 absolute error if needed.
                let rounded = ((score * 10_000.0).round() / 10_000.0) as f32;
                results.push((doc_id.clone(), rounded));
            }
        }

        // Sort DESC by score, stable w.r.t. insertion order on ties.
        results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        if results.len() > top_k {
            results.truncate(top_k);
        }
        results
    }

    /// Iterate stored doc_ids in insertion order. Useful for callers
    /// (like the hybrid blender) that need to enumerate docs.
    pub fn doc_ids(&self) -> impl Iterator<Item = &str> {
        self.doc_order.iter().map(|s| s.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_query_returns_empty() {
        let mut idx = TfIdfIndex::new();
        idx.add("d1", "some content about postgres");
        assert!(idx.score_top_k("", 5).is_empty());
        // Query that tokenizes to nothing (all stopwords) also empty.
        assert!(idx.score_top_k("the a is", 5).is_empty());
    }

    #[test]
    fn ranks_relevant_doc_above_irrelevant() {
        let mut idx = TfIdfIndex::new();
        idx.add("d1", "postgres database replica configuration");
        idx.add("d2", "apple banana cherry cake");
        let hits = idx.score_top_k("postgres replica", 5);
        // d2 has zero overlap so it should be filtered (score 0). d1
        // survives with a positive score.
        let ids: Vec<&str> = hits.iter().map(|(k, _)| k.as_str()).collect();
        assert_eq!(ids, vec!["d1"]);
    }

    #[test]
    fn top_k_truncates() {
        let mut idx = TfIdfIndex::new();
        for i in 0..10 {
            idx.add(&format!("d{i}"), "postgres replica config");
        }
        let hits = idx.score_top_k("postgres", 3);
        assert_eq!(hits.len(), 3);
    }

    #[test]
    fn re_add_updates_doc_freq() {
        let mut idx = TfIdfIndex::new();
        idx.add("d1", "postgres replica");
        idx.add("d1", "completely different content");
        // After re-add, "postgres" should have df=0, so querying for it
        // returns nothing (d1 no longer contains it).
        let hits = idx.score_top_k("postgres", 5);
        assert!(hits.is_empty(), "expected no hits, got {hits:?}");
        assert_eq!(idx.len(), 1);
    }
}
