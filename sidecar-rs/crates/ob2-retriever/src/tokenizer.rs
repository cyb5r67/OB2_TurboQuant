//! Tokenizer — port of `context-engine/retriever.py::_tokenize`.
//!
//! Python reference (verbatim):
//! ```python
//! def _tokenize(text: str) -> List[str]:
//!     """Lowercase, strip punctuation, remove stopwords."""
//!     text = text.lower()
//!     text = re.sub(r"[^a-z0-9\s]", " ", text)
//!     return [
//!         t for t in text.split()
//!         if len(t) > 1 and t not in _STOPWORDS
//!     ]
//! ```
//!
//! Semantics we preserve byte-for-byte:
//!   * Lowercasing is ASCII-only in Python for the purposes of the regex;
//!     after `.lower()` anything outside `[a-z0-9\s]` is replaced with a
//!     single space. Unicode letters get stripped (they don't match `[a-z]`).
//!   * `str.split()` with no args splits on runs of ASCII whitespace and
//!     discards empty tokens. We match that with `split_whitespace()`.
//!   * `len(t) > 1` is a **byte-length** check in CPython only for bytes;
//!     for `str`, `len` is character count. Since our regex has stripped
//!     everything to `[a-z0-9]` runs, each surviving token is pure ASCII,
//!     so `s.chars().count() == s.len()`. We use `s.len()` (bytes) as a
//!     fast-path that is exactly equivalent here.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;

/// Exact stopword set copied verbatim from `context-engine/retriever.py`
/// lines 87-96. Keep this in sync if the Python changes.
pub const STOPWORDS: &[&str] = &[
    "a", "an", "the", "is", "it", "in", "on", "at", "to", "for",
    "of", "and", "or", "but", "not", "with", "this", "that", "are",
    "was", "be", "by", "from", "as", "has", "have", "had", "its",
    "they", "them", "their", "we", "you", "he", "she", "i", "my",
    "your", "our", "how", "what", "which", "who", "when", "where",
    "do", "does", "did", "will", "would", "can", "could", "should",
    "may", "might", "also", "so", "if", "about", "into", "than",
    "more", "such", "both", "each", "all", "no", "any", "there",
];

fn stopwords_set() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| STOPWORDS.iter().copied().collect())
}

fn non_alnum_regex() -> &'static Regex {
    // Mirrors Python `re.sub(r"[^a-z0-9\s]", " ", text)` applied AFTER
    // lowercasing. We keep the same class: strip anything outside
    // `[a-z0-9]` and ASCII whitespace.
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[^a-z0-9\s]").expect("valid regex"))
}

/// Returns true iff `token` is in the stopword set. Matches Python's
/// `t not in _STOPWORDS` check (case-sensitive — the caller has already
/// lowercased).
pub fn is_stopword(token: &str) -> bool {
    stopwords_set().contains(token)
}

/// Tokenize a string. Equivalent to Python's `_tokenize`:
///   1. lowercase,
///   2. replace non-`[a-z0-9\s]` with space,
///   3. split on whitespace,
///   4. keep tokens with `len > 1` and not in `_STOPWORDS`.
pub fn tokenize(text: &str) -> Vec<String> {
    // Step 1: lowercase. Python `str.lower()` lowercases Unicode; for any
    // character that is not ASCII `[a-z0-9]` the next step will strip it
    // anyway, so using Rust `to_lowercase` (Unicode-aware) is at least as
    // permissive as Python and produces the same tokens for the ASCII
    // subset that survives.
    let lowered = text.to_lowercase();

    // Step 2: strip punctuation — replace non-alnum/whitespace with space.
    let cleaned = non_alnum_regex().replace_all(&lowered, " ");

    // Steps 3 + 4: split on whitespace, keep len > 1 and non-stopword.
    cleaned
        .split_whitespace()
        .filter(|t| t.len() > 1 && !is_stopword(t))
        .map(|t| t.to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stopwords_list_has_expected_size() {
        // Sanity: the Python frozenset has 69 entries. If this assertion
        // fails you probably edited one side without the other.
        assert_eq!(STOPWORDS.len(), 69);
    }

    #[test]
    fn tokenizes_simple_sentence() {
        // "Hello world, this is a test." -> lower -> strip punct ->
        // ["hello", "world", "this", "is", "a", "test"] -> drop stopwords
        // ("this", "is", "a") and drop len<=1 (none here) ->
        // ["hello", "world", "test"]
        let toks = tokenize("Hello world, this is a test.");
        assert_eq!(toks, vec!["hello", "world", "test"]);
    }

    #[test]
    fn drops_single_char_tokens() {
        // 'x' is length 1 — dropped. 'ab' survives.
        let toks = tokenize("x ab c de");
        assert_eq!(toks, vec!["ab", "de"]);
    }

    #[test]
    fn strips_unicode_punct_to_space() {
        // em-dash / curly-quote: not in [a-z0-9\s], so get replaced with
        // spaces, effectively splitting the phrase.
        let toks = tokenize("foo—bar‘baz");
        assert_eq!(toks, vec!["foo", "bar", "baz"]);
    }
}
