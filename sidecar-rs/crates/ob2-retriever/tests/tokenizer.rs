//! Tokenizer integration tests. Expected outputs derived by mentally
//! executing `context-engine/retriever.py::_tokenize` on each input.

use ob2_retriever::{is_stopword, tokenize, STOPWORDS};

#[test]
fn basic_sentence_filters_stopwords_and_punct() {
    // "Hello world, this is a test."
    //   lower           -> "hello world, this is a test."
    //   strip non-alnum -> "hello world  this is a test "
    //   split           -> ["hello","world","this","is","a","test"]
    //   len>1 + !stop   -> ["hello","world","test"]
    //                      ("this","is","a" are stopwords; none are len<=1)
    let toks = tokenize("Hello world, this is a test.");
    assert_eq!(toks, vec!["hello", "world", "test"]);
}

#[test]
fn preserves_order_of_non_stopwords() {
    let toks = tokenize("postgres database replica fails");
    assert_eq!(
        toks,
        vec!["postgres", "database", "replica", "fails"],
        "no stopwords here — order must match input",
    );
}

#[test]
fn lowercases_uppercase_input() {
    let toks = tokenize("Hello WORLD POSTGRES");
    for t in &toks {
        assert_eq!(*t, t.to_lowercase(), "token {t:?} not lowercased");
    }
    assert_eq!(toks, vec!["hello", "world", "postgres"]);
}

#[test]
fn digits_survive_single_chars_dont() {
    // "7" is length 1 -> dropped.
    // "42" length 2 -> kept.
    // "a" is both len==1 AND a stopword, dropped on both counts.
    let toks = tokenize("7 42 a postgres");
    assert_eq!(toks, vec!["42", "postgres"]);
}

#[test]
fn stopword_detection_is_case_sensitive_post_lower() {
    // is_stopword is post-lowercase: caller lowercases first.
    assert!(is_stopword("the"));
    assert!(!is_stopword("The")); // uppercase not in the set
    assert!(!is_stopword("postgres"));
}

#[test]
fn stopwords_list_covers_known_entries() {
    // Spot-check a handful of entries we expect from the Python list.
    for w in &["the", "is", "a", "and", "or", "there", "any"] {
        assert!(STOPWORDS.contains(w), "expected {w:?} in STOPWORDS");
    }
    // And a word that should NOT be a stopword.
    assert!(!STOPWORDS.contains(&"postgres"));
}

#[test]
fn punctuation_internal_splits_words() {
    // "foo,bar" -> strip comma -> "foo bar"
    let toks = tokenize("foo,bar baz-qux");
    assert_eq!(toks, vec!["foo", "bar", "baz", "qux"]);
}
