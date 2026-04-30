//! `ob2-retriever` — TF-IDF index + hybrid blender.
//!
//! Ported from `/mnt/c/projects/OB2/context-engine/retriever.py` (~335 LOC).
//! The TF-IDF math, stopword list, IDF formula, and `match_reason` string
//! are byte-for-byte aligned with the Python reference so that golden
//! fixtures (landed in Task 7) can assert equivalence.
//!
//! Public surface:
//!   * [`tokenize`] / [`is_stopword`] / [`STOPWORDS`] — Python-parity tokenizer
//!   * [`TfIdfIndex`] — incremental index + top-k cosine TF-IDF scoring
//!   * [`HybridScorer`] / [`DEFAULT_ALPHA`] — alpha-blend cosine with TF-IDF
//!
//! `DocHit` is re-exported from `ob2-storage` so callers don't need to
//! depend on it directly.

pub mod hybrid;
pub mod tfidf;
pub mod tokenizer;

pub use hybrid::{HybridScorer, DEFAULT_ALPHA};
pub use ob2_storage::DocHit;
pub use tfidf::TfIdfIndex;
pub use tokenizer::{is_stopword, tokenize, STOPWORDS};
