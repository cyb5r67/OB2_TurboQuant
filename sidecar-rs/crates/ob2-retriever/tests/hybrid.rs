//! Hybrid scorer integration tests. Formula derived verbatim from
//! `context-engine/retriever.py::_hybrid_retrieve`.

use ob2_retriever::{HybridScorer, DEFAULT_ALPHA};
use ob2_storage::DocHit;
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
fn default_alpha_matches_python() {
    assert_eq!(DEFAULT_ALPHA, 0.65);
    assert_eq!(HybridScorer::default().alpha(), 0.65);
}

#[test]
fn blend_pure_cosine_no_tfidf() {
    let s = HybridScorer::new(0.65);
    let hits = s.blend(&[(hit("d1", "text", 0.9), 0.0)], 10);
    // 0.65 * 0.9 + 0.35 * 0 = 0.585
    assert!((hits[0].score - 0.585).abs() < 1e-4);
}

#[test]
fn blend_both_contributions() {
    let s = HybridScorer::new(0.65);
    let hits = s.blend(&[(hit("d1", "text", 0.8), 0.6)], 10);
    // 0.65 * 0.8 + 0.35 * 0.6 = 0.52 + 0.21 = 0.73
    assert!((hits[0].score - 0.73).abs() < 1e-4);
}

#[test]
fn blend_sorts_desc() {
    let s = HybridScorer::new(0.65);
    let hits = s.blend(
        &[
            (hit("low", "x", 0.3), 0.1),
            (hit("hi", "x", 0.9), 0.0),
            (hit("mid", "x", 0.5), 0.5),
        ],
        10,
    );
    let ids: Vec<&str> = hits.iter().map(|h| h.doc_id.as_str()).collect();
    // Blended scores (alpha=0.65):
    //   low: 0.65*0.3 + 0.35*0.1 = 0.195 + 0.035 = 0.230
    //   hi:  0.65*0.9 + 0.35*0.0 = 0.585
    //   mid: 0.65*0.5 + 0.35*0.5 = 0.325 + 0.175 = 0.500
    assert_eq!(ids, vec!["hi", "mid", "low"]);
}

#[test]
fn blend_respects_top_k() {
    let s = HybridScorer::new(0.65);
    let hits = s.blend(
        &[
            (hit("a", "x", 0.9), 0.0),
            (hit("b", "x", 0.8), 0.0),
            (hit("c", "x", 0.7), 0.0),
        ],
        2,
    );
    assert_eq!(hits.len(), 2);
    assert_eq!(hits[0].doc_id, "a");
    assert_eq!(hits[1].doc_id, "b");
}

#[test]
fn match_reason_is_python_compatible() {
    // Python uses f"hybrid (α={alpha:.2f})". We store it in metadata.
    let s = HybridScorer::new(0.65);
    let hits = s.blend(&[(hit("d1", "x", 0.5), 0.5)], 10);
    let r = hits[0]
        .metadata
        .get("match_reason")
        .and_then(|v| v.as_str())
        .expect("match_reason should be stamped into metadata");
    assert_eq!(r, "hybrid (α=0.65)");
}

#[test]
fn blend_alpha_zero_pure_tfidf() {
    // alpha=0 means pure TF-IDF (the cosine side is zeroed).
    let s = HybridScorer::new(0.0);
    let hits = s.blend(&[(hit("d1", "x", 0.9), 0.4)], 10);
    // 0*0.9 + 1*0.4 = 0.4
    assert!((hits[0].score - 0.4).abs() < 1e-4);
}

#[test]
fn blend_alpha_one_pure_cosine() {
    // alpha=1 means pure cosine.
    let s = HybridScorer::new(1.0);
    let hits = s.blend(&[(hit("d1", "x", 0.7), 0.9)], 10);
    // 1*0.7 + 0*0.9 = 0.7
    assert!((hits[0].score - 0.7).abs() < 1e-4);
}
