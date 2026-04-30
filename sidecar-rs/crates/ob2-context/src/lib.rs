//! `ob2-context` — Compressor + ContextEngine.
//!
//! Ported from:
//!   * `context-engine/compressor.py` (compression strategies, token estimate)
//!   * `context-engine/context_engineering.py` (`ContextEngine`, re-rank,
//!     `ContextPacket`)
//!   * `retrieval/sidecar.py::method_build_context` (the RPC response shape
//!     the golden fixtures in Task 7 will assert against)
//!
//! The Rust `ContextEngine` intentionally diverges in ONE place from the
//! Python reference: it does not own a `Memory` module. The sidecar never
//! exposes `remember` over RPC, so the Python memory is always empty in
//! practice and `history_text` is always `""`. Rust treats memory as
//! permanently empty (`history = 0 tokens`, no memory_turns in the
//! packet's metadata). See the module docs in `engine.rs` for the full
//! parity story.

pub mod compressor;
pub mod engine;
pub mod packet;

pub use compressor::{estimate_tokens, CompressionResult, Compressor, Strategy};
pub use engine::ContextEngine;
pub use packet::{BudgetSummary, BuildContextPacket, RetrievedDoc};
