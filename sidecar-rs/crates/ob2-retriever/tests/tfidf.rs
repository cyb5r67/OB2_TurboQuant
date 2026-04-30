//! TF-IDF integration tests. Expected ranking derived from the Python
//! reference implementation in `context-engine/retriever.py`.

use ob2_retriever::TfIdfIndex;

#[test]
fn add_then_score_ranks_relevant_doc_higher() {
    let mut idx = TfIdfIndex::new();
    idx.add("d1", "postgres database replica configuration");
    idx.add("d2", "apple banana cherry cake");
    let hits = idx.score_top_k("postgres replica", 5);
    // d2 has zero overlap (score 0, filtered). d1 survives.
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].0, "d1");
    // Cross-checked against Python reference (see commit message):
    // cosine(q_vec, d1_vec) rounded to 4 decimals = 0.7071.
    assert!(
        (hits[0].1 - 0.7071).abs() < 1e-4,
        "expected d1 score ~0.7071, got {}",
        hits[0].1
    );
}

#[test]
fn empty_query_returns_empty_list() {
    let mut idx = TfIdfIndex::new();
    idx.add("d1", "any text here works");
    let hits = idx.score_top_k("", 5);
    assert!(hits.is_empty(), "empty query must return empty results");
}

#[test]
fn query_of_only_stopwords_returns_empty() {
    let mut idx = TfIdfIndex::new();
    idx.add("d1", "any text here works");
    // After tokenize, "the a is" -> [] (all stopwords). Python returns [].
    let hits = idx.score_top_k("the a is", 5);
    assert!(hits.is_empty());
}

#[test]
fn top_k_truncation() {
    let mut idx = TfIdfIndex::new();
    for i in 0..10 {
        idx.add(&format!("d{i}"), "postgres replica config");
    }
    let hits = idx.score_top_k("postgres", 3);
    assert_eq!(hits.len(), 3);
}

#[test]
fn sorted_descending_by_score() {
    let mut idx = TfIdfIndex::new();
    idx.add("weak", "postgres and many other unrelated words here");
    idx.add("strong", "postgres postgres postgres postgres");
    idx.add("absent", "apple banana cherry");
    let hits = idx.score_top_k("postgres", 5);
    let ids: Vec<&str> = hits.iter().map(|(k, _)| k.as_str()).collect();
    // "strong" should rank above "weak" (higher tf). "absent" filtered out.
    assert_eq!(ids, vec!["strong", "weak"]);
    assert!(hits[0].1 >= hits[1].1);
}

#[test]
fn scores_are_rounded_to_4_decimals() {
    let mut idx = TfIdfIndex::new();
    idx.add("d1", "postgres replica");
    idx.add("d2", "postgres database replica failover configuration");
    let hits = idx.score_top_k("postgres replica", 5);
    for (_, score) in hits {
        // Round-to-4dp means *10000 should be an integer (modulo f32 noise).
        let scaled = score * 10_000.0;
        let rounded = scaled.round();
        assert!(
            (scaled - rounded).abs() < 1e-2,
            "score {score} not rounded to 4 decimals"
        );
    }
}
