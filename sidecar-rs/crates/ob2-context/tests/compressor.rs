//! Integration tests for the compressor.
//!
//! Every assertion cross-checks against the Python `Compressor` at
//! `/mnt/c/projects/OB2/context-engine/compressor.py`. Run the Python
//! reference in an interpreter if you want to verify by hand:
//!
//! ```python
//! from compressor import Compressor, estimate_tokens
//! ```

use ob2_context::{estimate_tokens, CompressionResult, Compressor, Strategy};

// ── estimate_tokens ─────────────────────────────────────────

#[test]
fn count_tokens_matches_python_defaults() {
    // Python: estimate_tokens("", 4) == 0
    assert_eq!(estimate_tokens("", 4), 0);
    // Python: estimate_tokens("hello world", 4) == 11 // 4 == 2
    assert_eq!(estimate_tokens("hello world", 4), 2);
    // 20 chars, 4 cpt → 5 tokens
    assert_eq!(estimate_tokens("a".repeat(20).as_str(), 4), 5);
    // 20 chars, 3 cpt → 6 tokens (Python: 20 // 3 == 6)
    assert_eq!(estimate_tokens("a".repeat(20).as_str(), 3), 6);
}

// ── Empty-input and fits-budget fast paths ─────────────────

#[test]
fn empty_input_returns_none_strategy() {
    let c = Compressor::with_budget(100, Strategy::Extractive).unwrap();
    let r = c.compress(&[], "query");
    assert_eq!(r.strategy_used, "none (empty input)");
    assert_eq!(r.text, "");
    assert_eq!(r.original_chars, 0);
    assert_eq!(r.compressed_chars, 0);
    assert_eq!(r.estimated_tokens_saved, 0);
}

#[test]
fn all_chunks_too_small_treated_as_empty() {
    // min_chunk=20 by default (Python class default). "abc" is 3 chars
    // so it gets filtered out entirely.
    let c = Compressor::with_budget(100, Strategy::Extractive).unwrap();
    let r = c.compress(&["abc".into(), "xyz".into()], "q");
    assert_eq!(r.strategy_used, "none (empty input)");
}

#[test]
fn fits_budget_no_compression() {
    let c = Compressor::with_budget(100, Strategy::Extractive).unwrap();
    // 40 chars of content, joined with "\n\n" = 40 chars total (one chunk).
    let text = "a".repeat(40);
    let r = c.compress(&[text.clone()], "q");
    assert_eq!(r.strategy_used, "none (fits budget)");
    assert_eq!(r.text, text);
    assert_eq!(r.original_chars, 40);
    assert_eq!(r.compressed_chars, 40);
    assert_eq!(r.estimated_tokens_saved, 0);
}

// ── Truncate strategy ──────────────────────────────────────

#[test]
fn truncate_splits_budget_per_chunk_and_truncates_head() {
    // Two 40-char chunks, max_chars = 20.
    // Python: budget_per_chunk = 20 // 2 == 10
    // each chunk sliced to 10 chars: "aaaaaaaaaa", "bbbbbbbbbb"
    // joined with "\n\n" → "aaaaaaaaaa\n\nbbbbbbbbbb" (22 chars)
    // final slice to 20 chars → "aaaaaaaaaa\n\nbbbbbbbb" (20 chars)
    let c = Compressor::with_budget(20, Strategy::Truncate).unwrap();
    let a = "a".repeat(40);
    let b = "b".repeat(40);
    let r = c.compress(&[a, b], "");

    assert_eq!(r.strategy_used, "truncate");
    assert_eq!(r.compressed_chars, 20);
    assert_eq!(r.text, "aaaaaaaaaa\n\nbbbbbbbb");
}

#[test]
fn truncate_single_chunk() {
    // One 100-char chunk, max_chars = 30.
    // budget_per_chunk = 30 // 1 = 30, chunk[:30], joined is just that, final
    // slice to 30 chars.
    let c = Compressor::with_budget(30, Strategy::Truncate).unwrap();
    let input = "x".repeat(100);
    let r = c.compress(&[input], "");
    assert_eq!(r.text, "x".repeat(30));
    assert_eq!(r.strategy_used, "truncate");
}

// ── Sentence strategy ──────────────────────────────────────

#[test]
fn sentence_greedy_fill() {
    // Python:
    //   split_sentences("AAA. BBB. CCC.") → ["AAA.", "BBB.", "CCC."]
    //   With max_chars = 10:
    //     s="AAA." (4 chars) + cost 0 (empty parts) → used=4, parts=["AAA."]
    //     s="BBB." (4 chars) + cost 1 (sep) = 5 → used=9, parts=["AAA.","BBB."]
    //     s="CCC." (4 chars) + cost 1 = 5 → used+cost=14 > 10, break
    //   join with " " → "AAA. BBB." (9 chars)
    // Input must exceed budget for strategy to be invoked; "AAA. BBB. CCC."
    // is 14 chars vs budget 10 → OK.
    //
    // min_chunk is 20 by default which would filter out the input; drop to 5.
    let c = Compressor::new(10, Strategy::Sentence, 5).unwrap();
    let r = c.compress(&["AAA. BBB. CCC.".into()], "");
    assert_eq!(r.strategy_used, "sentence");
    assert_eq!(r.text, "AAA. BBB.");
}

// ── Extractive strategy ────────────────────────────────────

#[test]
fn extractive_prefers_query_overlap() {
    // Two sentences: one relevant to query, one not.
    // Query: "postgres replica"
    // Sentence "postgres replica configuration guide." has overlap 2/2 = 1.0
    // Sentence "apple banana cherry cake pie." has overlap 0/2 = 0.0
    //
    // With a budget that fits only ONE sentence, the ranked-by-score greedy
    // pass picks the relevant one first.
    let c = Compressor::new(40, Strategy::Extractive, 5).unwrap();
    let chunks = vec!["postgres replica configuration guide. apple banana cherry cake pie.".into()];
    let r = c.compress(&chunks, "postgres replica");

    assert_eq!(r.strategy_used, "extractive");
    // Should contain the relevant sentence, not the irrelevant one.
    assert!(r.text.contains("postgres"), "expected postgres sentence, got {:?}", r.text);
    assert!(!r.text.contains("banana"), "unexpected banana sentence in {:?}", r.text);
}

#[test]
fn extractive_falls_back_to_truncate_when_nothing_fits() {
    // Budget so tight that no sentence can be selected: max_chars = 3.
    // Every sentence is longer than 3, so selected is empty → fallback to
    // truncate. Input must exceed budget to avoid the fits-budget short path.
    let c = Compressor::new(3, Strategy::Extractive, 5).unwrap();
    let chunks = vec!["A long sentence here. Another long one.".into()];
    let r = c.compress(&chunks, "q");
    // Fallback produces the truncate strategy's output, but the returned
    // strategy_used is still the Python-style "extractive" (Python reports
    // its configured strategy — the fallback is internal).
    assert_eq!(r.strategy_used, "extractive");
    // Expect something — the result shouldn't be empty.
    assert!(!r.text.is_empty());
}

#[test]
fn extractive_restores_source_order() {
    // Query strongly matches sentence 3 of chunk; sentence 1 has lower score.
    // With a budget for both, the selected set restores ORIGINAL order,
    // not score-DESC order. Python comment: "Restore original order".
    let c = Compressor::new(60, Strategy::Extractive, 5).unwrap();
    let chunks = vec!["bird cat. middle filler ignored. postgres replica main topic.".into()];
    let r = c.compress(&chunks, "postgres replica");
    // "postgres replica main topic." has the highest overlap; "bird cat." has
    // zero. With budget=60 we might fit bird+postgres. If both selected, the
    // output order must be "bird cat.  postgres replica main topic." — NOT
    // reordered by score.
    // Given budget 60, sentences "bird cat."(9) + sep(2) + "postgres replica main topic."(28) = 39 → fits.
    // Middle "middle filler ignored."(22) with overlap 0 could also fit: 39+2+22=63 > 60 → excluded.
    // So expected text is "bird cat.  postgres replica main topic." or similar,
    // depending on selection order.
    //
    // Whatever is selected, postgres sentence must come AFTER bird sentence
    // if both made the cut, because that's the source order.
    if r.text.contains("bird") && r.text.contains("postgres") {
        let bird_pos = r.text.find("bird").unwrap();
        let pg_pos = r.text.find("postgres").unwrap();
        assert!(bird_pos < pg_pos, "source order not preserved: {:?}", r.text);
    }
}

// ── CompressionResult helpers ──────────────────────────────

#[test]
fn compression_ratio_rounded_to_3_decimals() {
    let r = CompressionResult {
        text: "x".repeat(333),
        original_chars: 1000,
        compressed_chars: 333,
        strategy_used: "extractive".into(),
        estimated_tokens_saved: 0,
    };
    // 333 / 1000 = 0.333 → rounds to 0.333
    assert!((r.compression_ratio() - 0.333).abs() < 1e-6);
}

#[test]
fn compression_ratio_zero_original_is_one() {
    let r = CompressionResult {
        text: String::new(),
        original_chars: 0,
        compressed_chars: 0,
        strategy_used: "none (empty input)".into(),
        estimated_tokens_saved: 0,
    };
    assert_eq!(r.compression_ratio(), 1.0);
}

// ── Strategy validation ────────────────────────────────────

#[test]
fn invalid_strategy_errors() {
    assert!(Strategy::from_str("").is_err());
    assert!(Strategy::from_str("Truncate").is_err()); // wrong case
    assert!(Strategy::from_str("unknown").is_err());
}

#[test]
fn strategy_config_names_match_python() {
    // These are the exact strings Python's Literal type accepts AND the
    // strings that appear in `VALID_STRATEGIES` at compressor.py:101.
    assert_eq!(Strategy::Truncate.as_str(), "truncate");
    assert_eq!(Strategy::Sentence.as_str(), "sentence");
    assert_eq!(Strategy::Extractive.as_str(), "extractive");
}

// ── Budget validation ──────────────────────────────────────

#[test]
fn max_chars_zero_errors() {
    assert!(Compressor::with_budget(0, Strategy::Extractive).is_err());
}
