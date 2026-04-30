//! Compression strategies.
//!
//! Direct port of `context-engine/compressor.py` (283 LOC). Every algorithm
//! is mirrored step-by-step with the Python line numbers called out so the
//! golden fixtures in Task 7 land on byte-identical output.
//!
//! ## Token accounting
//!
//! Python's `estimate_tokens(text, chars_per_token=4)` returns
//! `len(text) // chars_per_token`. It is **char-based**, not token-based
//! (no tiktoken). CPython `len(str)` counts Unicode code points (a scalar
//! values count), so for multi-byte characters Python's length differs
//! from UTF-8 byte length.
//!
//! We mirror this with `text.chars().count()` (scalar value count) and
//! integer division. This is what [`estimate_tokens`] does and why.
//!
//! ## Three strategies (in `Strategy::Truncate`, `Sentence`, `Extractive`)
//!
//! * **Truncate** (`_truncate`, lines 176-180)
//!   Divides the char budget across chunks (`budget_per_chunk = max_chars
//!   // max(len(chunks), 1)`), keeps the head of each chunk, joins with
//!   `"\n\n"`, and finally truncates the joined result to `max_chars`
//!   characters. The final truncation is a safety net — the per-chunk
//!   budget can produce strings slightly over `max_chars` after joining.
//!
//! * **Sentence** (`_sentence`, lines 182-197)
//!   Splits every chunk into sentences via `re.split(r'(?<=[.!?])\s+', …)`,
//!   flattens them in chunk order, and greedily appends sentences until
//!   adding another would exceed `max_chars`. Cost accounting: each
//!   sentence's cost is its `len` plus 1 (for the space separator) if
//!   there's already at least one sentence in the output. The final
//!   output joins with `" "` and strips leading/trailing whitespace.
//!
//! * **Extractive** (`_extractive`, lines 199-240)
//!   Splits into sentences with `(chunk_idx, sent_idx)` keys, scores each
//!   by `_sentence_score` (lower-cased token-overlap fraction against the
//!   query), greedily picks the highest-scored sentences that fit a
//!   budget of `max_chars`, using `"  "` (two spaces) as the separator
//!   cost. Stops early once budget drops to ≤ 10 chars. If nothing
//!   fits, falls back to truncate. Final output restores chunk/sentence
//!   order from the selected set and joins with `"  "` + strips.
//!
//! ## Char budget vs "no compression needed"
//!
//! `Compressor.compress` first filters out chunks shorter than `min_chunk`
//! (default 20), joins with `"\n\n"`, and if the joined length already
//! fits the char budget, returns with `strategy_used = "none (fits
//! budget)"`. Empty input yields `strategy_used = "none (empty input)"`.

use regex::Regex;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

// ─────────────────────────────────────────────────────────────
// Strategy enum — matches Python `Literal["truncate", "sentence",
// "extractive"]` (compressor.py:29).
// ─────────────────────────────────────────────────────────────

/// Which compression algorithm to use.
///
/// Serialized as the same lowercase strings Python uses so the
/// sidecar config round-trips verbatim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Strategy {
    Truncate,
    Sentence,
    Extractive,
}

impl Strategy {
    /// Parse a `&str` using the same names Python's compressor uses.
    pub fn from_str(s: &str) -> Result<Self, CompressorError> {
        match s {
            "truncate" => Ok(Strategy::Truncate),
            "sentence" => Ok(Strategy::Sentence),
            "extractive" => Ok(Strategy::Extractive),
            other => Err(CompressorError::InvalidStrategy(other.to_string())),
        }
    }

    /// Convert back to the canonical lowercase name.
    pub fn as_str(&self) -> &'static str {
        match self {
            Strategy::Truncate => "truncate",
            Strategy::Sentence => "sentence",
            Strategy::Extractive => "extractive",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum CompressorError {
    #[error("strategy must be one of (\"truncate\", \"sentence\", \"extractive\"), got {0:?}.")]
    InvalidStrategy(String),

    #[error("max_chars must be >= 1, got {0}.")]
    InvalidMaxChars(i64),
}

// ─────────────────────────────────────────────────────────────
// Token estimator — compressor.py:54-61
// ─────────────────────────────────────────────────────────────

/// Rough token estimate. Mirrors Python `estimate_tokens(text,
/// chars_per_token=4)` → `len(text) // chars_per_token`.
///
/// * `chars_per_token` must be `>= 1` (Python raises `ValueError` otherwise).
/// * `len(text)` in Python is Unicode code points, so we use
///   `text.chars().count()` — NOT `text.len()` (which would be bytes).
///   Matters for any non-ASCII content; the golden harness will catch
///   divergence.
pub fn estimate_tokens(text: &str, chars_per_token: usize) -> usize {
    assert!(chars_per_token >= 1, "chars_per_token must be >= 1");
    text.chars().count() / chars_per_token
}

/// Convenience wrapper with the Python default of 4 chars/token.
pub fn estimate_tokens_default(text: &str) -> usize {
    estimate_tokens(text, 4)
}

// ─────────────────────────────────────────────────────────────
// Sentence splitter + overlap scorer — compressor.py:36-51
// ─────────────────────────────────────────────────────────────

fn sentence_split_regex() -> &'static Regex {
    // Python: re.split(r'(?<=[.!?])\s+', text.strip())
    // Rust's `regex` crate does not support look-behind directly, but we
    // can emulate the same split by finding `[.!?]\s+` boundaries and
    // splitting after the punctuation character. We implement the split
    // manually in `split_sentences` instead of relying on regex::split
    // (which would eat the punctuation).
    //
    // The regex here captures the punctuation + whitespace run so we can
    // compute the index at which to cut. See `split_sentences` below.
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"([.!?])(\s+)").expect("valid regex"))
}

/// Port of `_split_sentences` (compressor.py:36-42):
/// ```python
/// parts = re.split(r'(?<=[.!?])\s+', text.strip())
/// return [p.strip() for p in parts if p.strip()]
/// ```
///
/// The trick: `(?<=[.!?])\s+` splits on a whitespace run *preceded* by
/// sentence-ending punctuation. The punctuation stays attached to the
/// preceding sentence. We emulate this by walking matches of
/// `[.!?]\s+` and cutting after the punctuation char (not after the
/// whitespace), which yields identical partitions.
pub fn split_sentences(text: &str) -> Vec<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let re = sentence_split_regex();

    let mut out: Vec<String> = Vec::new();
    let mut cursor = 0usize;
    for m in re.find_iter(trimmed) {
        // `m` matched `[.!?]\s+`. We want to cut at:
        //   * END of the punctuation char (to keep it attached left), then
        //   * START of the next sentence = m.end() (after the whitespace run).
        let punct_end = m.start() + 1; // punct char is 1 byte ASCII
        let sentence = &trimmed[cursor..punct_end];
        let s = sentence.trim();
        if !s.is_empty() {
            out.push(s.to_string());
        }
        cursor = m.end();
    }
    // Trailing sentence (no terminal punctuation, or last one after final punct).
    if cursor < trimmed.len() {
        let s = trimmed[cursor..].trim();
        if !s.is_empty() {
            out.push(s.to_string());
        }
    }
    out
}

/// Port of `_sentence_score` (compressor.py:45-51).
///
/// Python:
/// ```python
/// if not query or not query.strip():
///     return 0.0
/// q_tokens = set(query.lower().split())
/// s_tokens = set(sentence.lower().split())
/// return len(q_tokens & s_tokens) / len(q_tokens) if q_tokens else 0.0
/// ```
///
/// `str.split()` with no args splits on any whitespace run, so we use
/// `split_whitespace()` which is equivalent.
pub fn sentence_score(sentence: &str, query: &str) -> f64 {
    if query.trim().is_empty() {
        return 0.0;
    }
    let q_lower = query.to_lowercase();
    let q_tokens: std::collections::HashSet<&str> = q_lower.split_whitespace().collect();
    if q_tokens.is_empty() {
        return 0.0;
    }
    let s_lower = sentence.to_lowercase();
    let s_tokens: std::collections::HashSet<&str> = s_lower.split_whitespace().collect();
    let overlap = q_tokens.intersection(&s_tokens).count();
    overlap as f64 / q_tokens.len() as f64
}

// ─────────────────────────────────────────────────────────────
// CompressionResult — compressor.py:68-89
// ─────────────────────────────────────────────────────────────

/// Mirrors `CompressionResult` dataclass.
#[derive(Debug, Clone, PartialEq)]
pub struct CompressionResult {
    pub text: String,
    pub original_chars: usize,
    pub compressed_chars: usize,
    pub strategy_used: String,
    pub estimated_tokens_saved: usize,
}

impl CompressionResult {
    /// `round(compressed / original, 3)`. Matches Python's
    /// `CompressionResult.compression_ratio` (compressor.py:76-81).
    ///
    /// Returns 1.0 when original is 0 (matching Python).
    pub fn compression_ratio(&self) -> f32 {
        if self.original_chars == 0 {
            return 1.0;
        }
        let raw = self.compressed_chars as f64 / self.original_chars as f64;
        ((raw * 1000.0).round() / 1000.0) as f32
    }
}

// ─────────────────────────────────────────────────────────────
// Compressor — compressor.py:96-240
// ─────────────────────────────────────────────────────────────

/// Defaults match Python's `Compressor.__init__` (compressor.py:103-108).
const DEFAULT_MAX_CHARS: usize = 1500;
const DEFAULT_MIN_CHUNK: usize = 20;

/// The compressor, parameterized by strategy + budget.
#[derive(Debug, Clone)]
pub struct Compressor {
    pub max_chars: usize,
    pub strategy: Strategy,
    pub min_chunk: usize,
}

impl Default for Compressor {
    fn default() -> Self {
        Self {
            max_chars: DEFAULT_MAX_CHARS,
            strategy: Strategy::Extractive,
            min_chunk: DEFAULT_MIN_CHUNK,
        }
    }
}

impl Compressor {
    /// Full constructor with validation matching Python:
    ///   * `max_chars < 1` → error
    ///   * `strategy` must be one of the three valid variants (enforced by type)
    pub fn new(
        max_chars: usize,
        strategy: Strategy,
        min_chunk: usize,
    ) -> Result<Self, CompressorError> {
        if max_chars < 1 {
            return Err(CompressorError::InvalidMaxChars(max_chars as i64));
        }
        Ok(Self {
            max_chars,
            strategy,
            min_chunk,
        })
    }

    /// Convenience constructor with `min_chunk = 20` (Python default).
    pub fn with_budget(max_chars: usize, strategy: Strategy) -> Result<Self, CompressorError> {
        Self::new(max_chars, strategy, DEFAULT_MIN_CHUNK)
    }

    /// Port of `Compressor.compress` (compressor.py:120-172).
    ///
    /// Pipeline (Python line refs in parens):
    ///   1. Filter chunks where `c` is empty or `len(c) < min_chunk` (124).
    ///   2. If no chunks survive → empty CompressionResult with
    ///      `"none (empty input)"` (126-134).
    ///   3. Join survivors with `"\n\n"`; if it already fits the budget,
    ///      return as-is with `"none (fits budget)"` (136-148).
    ///   4. Dispatch to strategy (151-156).
    ///   5. Compute `tokens_saved = estimate(original) - estimate(compressed)`,
    ///      floored at 0 (159, 171).
    pub fn compress(&self, chunks: &[String], query: &str) -> CompressionResult {
        // Step 1 — filter. Python: `len(c) >= self.min_chunk`.
        // Python's `len()` on a `str` counts code points, so use
        // `chars().count()` for parity.
        let valid_chunks: Vec<&str> = chunks
            .iter()
            .filter(|c| !c.is_empty() && c.chars().count() >= self.min_chunk)
            .map(|s| s.as_str())
            .collect();

        if valid_chunks.is_empty() {
            return CompressionResult {
                text: String::new(),
                original_chars: 0,
                compressed_chars: 0,
                strategy_used: "none (empty input)".to_string(),
                estimated_tokens_saved: 0,
            };
        }

        let original = valid_chunks.join("\n\n");
        let original_chars = original.chars().count();

        if original_chars <= self.max_chars {
            return CompressionResult {
                text: original.clone(),
                original_chars,
                compressed_chars: original_chars,
                strategy_used: "none (fits budget)".to_string(),
                estimated_tokens_saved: 0,
            };
        }

        let compressed = match self.strategy {
            Strategy::Truncate => self.truncate(&valid_chunks),
            Strategy::Sentence => self.sentence(&valid_chunks),
            Strategy::Extractive => self.extractive(&valid_chunks, query),
        };

        let compressed_chars = compressed.chars().count();
        let orig_tokens = estimate_tokens_default(&original);
        let comp_tokens = estimate_tokens_default(&compressed);
        let tokens_saved = orig_tokens.saturating_sub(comp_tokens);

        CompressionResult {
            text: compressed,
            original_chars,
            compressed_chars,
            strategy_used: self.strategy.as_str().to_string(),
            estimated_tokens_saved: tokens_saved,
        }
    }

    // ── Strategy implementations ──────────────────────────────

    /// `_truncate` — compressor.py:176-180.
    ///
    /// ```python
    /// budget_per_chunk = self.max_chars // max(len(chunks), 1)
    /// result = "\n\n".join(chunk[:budget_per_chunk] for chunk in chunks)
    /// return result[:self.max_chars]
    /// ```
    ///
    /// Slicing Python strings is by code point. We mirror with
    /// `chars().take(...)`.
    fn truncate(&self, chunks: &[&str]) -> String {
        let budget_per_chunk = self.max_chars / chunks.len().max(1);
        let truncated: Vec<String> = chunks
            .iter()
            .map(|c| c.chars().take(budget_per_chunk).collect::<String>())
            .collect();
        let joined = truncated.join("\n\n");
        joined.chars().take(self.max_chars).collect::<String>()
    }

    /// `_sentence` — compressor.py:182-197.
    ///
    /// Cost of the Nth sentence (N >= 1) is `len(sentence) + 1` — +1 for
    /// the space separator used at join time. The first sentence has no
    /// prior separator, so its cost is just `len(sentence)`.
    fn sentence(&self, chunks: &[&str]) -> String {
        let mut all_sentences: Vec<String> = Vec::new();
        for c in chunks {
            all_sentences.extend(split_sentences(c));
        }

        let mut parts: Vec<String> = Vec::new();
        let mut used: usize = 0;
        for s in all_sentences {
            // `len(sentence)` is code-point count in Python.
            let slen = s.chars().count();
            let needed = slen + if parts.is_empty() { 0 } else { 1 };
            if used + needed > self.max_chars {
                break;
            }
            parts.push(s);
            used += needed;
        }

        parts.join(" ").trim().to_string()
    }

    /// `_extractive` — compressor.py:199-240.
    ///
    /// Key behaviours:
    ///   * Separator for both cost accounting and final join is `"  "`
    ///     (two spaces).
    ///   * Stop early once budget ≤ 10 chars (safety margin, 225).
    ///   * Falls back to truncate when nothing fits (228-230).
    ///   * Output restores original (chunk_idx, sent_idx) order, not the
    ///     ranked order (232-238) — important for parity.
    fn extractive(&self, chunks: &[&str], query: &str) -> String {
        // Build indexed: (c_idx, s_idx, score, text)
        let mut indexed: Vec<(usize, usize, f64, String)> = Vec::new();
        for (c_idx, chunk) in chunks.iter().enumerate() {
            for (s_idx, sent) in split_sentences(chunk).into_iter().enumerate() {
                let score = sentence_score(&sent, query);
                indexed.push((c_idx, s_idx, score, sent));
            }
        }

        // Rank by score DESC. Python uses `sorted(..., key=..., reverse=True)`
        // which is stable — equal scores preserve original (c_idx, s_idx)
        // order. `Vec::sort_by` in Rust is also stable, so we get the same
        // tiebreaks.
        let mut ranked: Vec<&(usize, usize, f64, String)> = indexed.iter().collect();
        ranked.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));

        let separator = "  ";
        let sep_len = separator.chars().count(); // == 2
        let mut budget: isize = self.max_chars as isize;
        let mut selected: std::collections::HashSet<(usize, usize)> =
            std::collections::HashSet::new();

        for (c_idx, s_idx, _score, sent) in ranked {
            let sent_len = sent.chars().count() as isize;
            let cost =
                sent_len + if selected.is_empty() { 0 } else { sep_len as isize };
            if cost <= budget {
                selected.insert((*c_idx, *s_idx));
                budget -= cost;
            }
            // Python checks `budget <= 10` after the subtraction but BEFORE
            // the next iteration; we do the same.
            if budget <= 10 {
                break;
            }
        }

        if selected.is_empty() {
            // Fallback (compressor.py:228-230).
            return self.truncate(chunks);
        }

        // Restore original order.
        let ordered: Vec<&str> = indexed
            .iter()
            .filter_map(|(c_idx, s_idx, _score, sent)| {
                if selected.contains(&(*c_idx, *s_idx)) {
                    Some(sent.as_str())
                } else {
                    None
                }
            })
            .collect();

        ordered.join(separator).trim().to_string()
    }
}

// ─────────────────────────────────────────────────────────────
// Unit tests (whitebox — more end-to-end coverage in tests/compressor.rs)
// ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn estimate_tokens_char_based() {
        // Python: len("hello world") == 11, 11 // 4 == 2
        assert_eq!(estimate_tokens_default("hello world"), 2);
        // Empty string → 0 tokens
        assert_eq!(estimate_tokens_default(""), 0);
        // 16 chars → 4 tokens
        assert_eq!(estimate_tokens_default("abcdefghijklmnop"), 4);
    }

    #[test]
    fn estimate_tokens_counts_codepoints() {
        // Japanese "日本語" is 3 code points, 9 bytes in UTF-8.
        // Python `len("日本語")` == 3. 3 // 4 == 0.
        assert_eq!(estimate_tokens_default("日本語"), 0);
        // 4 non-ASCII chars → 1 token
        assert_eq!(estimate_tokens_default("日本語日"), 1);
    }

    #[test]
    fn split_sentences_basic() {
        let out = split_sentences("First sentence. Second one! And a third?");
        assert_eq!(
            out,
            vec!["First sentence.", "Second one!", "And a third?"]
        );
    }

    #[test]
    fn split_sentences_preserves_punctuation() {
        let out = split_sentences("Hey. Hello.");
        assert_eq!(out, vec!["Hey.", "Hello."]);
    }

    #[test]
    fn split_sentences_empty() {
        assert!(split_sentences("").is_empty());
        assert!(split_sentences("   ").is_empty());
    }

    #[test]
    fn sentence_score_overlap_fraction() {
        // query tokens: {"postgres", "replica"}
        // sentence tokens after lower+split: {"we", "configure", "postgres"}
        // overlap = 1, q_tokens = 2 → 0.5
        let s = sentence_score("We configure postgres", "postgres replica");
        assert!((s - 0.5).abs() < 1e-9);
    }

    #[test]
    fn sentence_score_empty_query() {
        assert_eq!(sentence_score("anything", ""), 0.0);
        assert_eq!(sentence_score("anything", "   "), 0.0);
    }

    #[test]
    fn strategy_roundtrip() {
        for s in ["truncate", "sentence", "extractive"] {
            assert_eq!(Strategy::from_str(s).unwrap().as_str(), s);
        }
        assert!(Strategy::from_str("unknown").is_err());
    }
}
