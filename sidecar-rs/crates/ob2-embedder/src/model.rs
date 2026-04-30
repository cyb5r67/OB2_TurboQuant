//! Embedder — direct ONNX Runtime wrapper for all-MiniLM-L6-v2.
//!
//! Replaces the earlier fastembed-based implementation: fastembed 5.x's
//! `cuda` feature only accelerates its candle-backed models, so MiniLM
//! always ran on the ORT CPU provider regardless of the cargo flag —
//! the `provider` string was cosmetic. Here we drive the ONNX session +
//! tokenizer directly, register `ep::CUDA` when the runtime exposes it
//! (and the `cuda` cargo feature is compiled in), and fall back to CPU
//! silently otherwise. The public API (`load`, `embed`, `name`, `dim`,
//! `provider`) is unchanged so callers and the EmbedBatcher don't move.
//!
//! Pooling + L2-normalization, previously hidden inside fastembed, now
//! live in `embed()`. MiniLM's ONNX export is deterministic across the
//! CUDA and CPU providers for identical weights, so golden fixtures
//! remain byte-for-byte stable.

use anyhow::{Context, Result};
use ndarray::Array2;
use ort::session::Session;
use ort::session::builder::{GraphOptimizationLevel, SessionBuilder};
use ort::value::TensorRef;
use parking_lot::Mutex;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Once};
use tokenizers::{
    PaddingDirection, PaddingParams, PaddingStrategy, Tokenizer, TruncationDirection,
    TruncationParams, TruncationStrategy,
};

/// Default model name. Matches `OB2_EMBEDDING_MODEL` default in Python.
pub const DEFAULT_MODEL: &str = "all-MiniLM-L6-v2";
pub const DEFAULT_DIM: usize = 384;
/// Matches the default `model_max_length` configured in the upstream
/// sentence-transformers all-MiniLM-L6-v2 tokenizer_config.json. Any
/// longer input is truncated to keep sequence-length-quadratic attention
/// cost bounded, exactly as fastembed did for us previously.
const MAX_SEQ_LEN: usize = 128;

/// ort's `Error<R>` carries `R` which is often a `!Send` handle (e.g.
/// `SessionBuilder`), so anyhow can't auto-convert via `?`. Stringifying
/// keeps the message and sidesteps the `Send + Sync + 'static` bound
/// anyhow requires.
fn ort_err<R>(e: ort::Error<R>) -> anyhow::Error {
    anyhow::anyhow!("ort: {e}")
}

pub struct Embedder {
    session: Mutex<Session>,
    tokenizer: Tokenizer,
    /// Does the MiniLM ONNX graph expose `token_type_ids` as an input? The
    /// Qdrant-hosted export does, but some third-party exports drop it.
    /// We introspect the session once at load time rather than probing on
    /// every request.
    expects_token_type_ids: bool,
    name: String,
    dim: usize,
    provider: String,
}

impl Embedder {
    /// Load the given model. Uses a locally-cached ONNX snapshot if one
    /// exists (the Docker build pre-warms the cache); otherwise downloads
    /// the model + tokenizer from HuggingFace Hub on first call.
    pub fn load(model_name: &str) -> Result<Self> {
        if model_name != DEFAULT_MODEL && model_name != "sentence-transformers/all-MiniLM-L6-v2" {
            anyhow::bail!(
                "unsupported embedding model: {model_name}. Only all-MiniLM-L6-v2 is wired today."
            );
        }

        init_ort_once();

        let (onnx_path, tokenizer_path) = resolve_model_files()
            .context("failed to locate or download MiniLM ONNX + tokenizer assets")?;

        let (session, provider) = build_session(&onnx_path)
            .with_context(|| format!("failed to build ORT session from {}", onnx_path.display()))?;

        let expects_token_type_ids =
            session.inputs().iter().any(|i| i.name() == "token_type_ids");

        let tokenizer = load_tokenizer(&tokenizer_path)?;

        let dim = DEFAULT_DIM;
        tracing::info!("embedder: {} on {} (dim={})", model_name, provider, dim);
        eprintln!("embedder: {model_name} on {provider} (dim={dim})");

        Ok(Self {
            session: Mutex::new(session),
            tokenizer,
            expects_token_type_ids,
            name: model_name.into(),
            dim,
            provider,
        })
    }

    /// Batch encode. Blocking — call via `tokio::task::spawn_blocking`.
    ///
    /// Produces mean-pooled + L2-normalized sentence embeddings, matching
    /// sentence-transformers' default behavior for all-MiniLM-L6-v2 (and
    /// what fastembed previously did for us behind the scenes).
    pub fn embed(&self, texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }

        // 1. Tokenize + pad to common length.
        let inputs: Vec<&str> = texts.iter().map(|s| s.as_str()).collect();
        let encodings = self
            .tokenizer
            .encode_batch(inputs, true)
            .map_err(|e| anyhow::anyhow!("tokenize failed: {e}"))?;

        let batch_size = encodings.len();
        let seq_len = encodings
            .iter()
            .map(|e| e.get_ids().len())
            .max()
            .unwrap_or(0);
        anyhow::ensure!(seq_len > 0, "tokenizer returned empty encoding");

        let mut input_ids = Array2::<i64>::zeros((batch_size, seq_len));
        let mut attention_mask = Array2::<i64>::zeros((batch_size, seq_len));
        let mut token_type_ids = Array2::<i64>::zeros((batch_size, seq_len));

        for (b, enc) in encodings.iter().enumerate() {
            let ids = enc.get_ids();
            let mask = enc.get_attention_mask();
            let types = enc.get_type_ids();
            for t in 0..ids.len().min(seq_len) {
                input_ids[[b, t]] = ids[t] as i64;
                attention_mask[[b, t]] = mask[t] as i64;
                if !types.is_empty() {
                    token_type_ids[[b, t]] = types[t] as i64;
                }
            }
        }

        // 2. Run the session. Build TensorRefs before the mutex lock so any
        //    construction error is reported without holding the lock.
        let ids_tensor = TensorRef::from_array_view(&input_ids).map_err(ort_err)?;
        let mask_tensor = TensorRef::from_array_view(&attention_mask).map_err(ort_err)?;
        let types_tensor = if self.expects_token_type_ids {
            Some(TensorRef::from_array_view(&token_type_ids).map_err(ort_err)?)
        } else {
            None
        };

        let mut session = self.session.lock();
        let outputs = if let Some(types_tensor) = types_tensor {
            session
                .run(ort::inputs![
                    "input_ids" => ids_tensor,
                    "attention_mask" => mask_tensor,
                    "token_type_ids" => types_tensor,
                ])
                .map_err(ort_err)?
        } else {
            session
                .run(ort::inputs![
                    "input_ids" => ids_tensor,
                    "attention_mask" => mask_tensor,
                ])
                .map_err(ort_err)?
        };

        // 3. Extract last_hidden_state, shape [batch, seq, dim]. The
        //    Qdrant-hosted export names it `last_hidden_state`; fall back
        //    to positional access if the name lookup fails.
        let hidden = match outputs.get("last_hidden_state") {
            Some(v) => v.try_extract_array::<f32>().map_err(ort_err)?,
            None => outputs[0].try_extract_array::<f32>().map_err(ort_err)?,
        };
        let shape = hidden.shape().to_vec();
        anyhow::ensure!(
            shape.len() == 3 && shape[0] == batch_size && shape[2] == DEFAULT_DIM,
            "unexpected MiniLM output shape: {:?} (want [{batch_size}, seq, {DEFAULT_DIM}])",
            shape
        );

        // 4. Mean-pool over the sequence axis, masked by attention_mask,
        //    then L2-normalize. Matches sentence-transformers' default
        //    `mean_tokens` + `normalize_embeddings=True` pipeline.
        let out_seq_len = shape[1];
        let mut results = Vec::with_capacity(batch_size);
        for b in 0..batch_size {
            let mut pooled = vec![0.0_f32; DEFAULT_DIM];
            let mut count = 0.0_f32;
            for t in 0..out_seq_len {
                if attention_mask[[b, t]] == 0 {
                    continue;
                }
                count += 1.0;
                for d in 0..DEFAULT_DIM {
                    pooled[d] += hidden[[b, t, d]];
                }
            }
            if count > 0.0 {
                let inv = 1.0 / count;
                for v in pooled.iter_mut() {
                    *v *= inv;
                }
            }
            let norm = pooled.iter().map(|x| x * x).sum::<f32>().sqrt();
            if norm > 0.0 {
                let inv = 1.0 / norm;
                for v in pooled.iter_mut() {
                    *v *= inv;
                }
            }
            results.push(pooled);
        }

        Ok(results)
    }

    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn dim(&self) -> usize {
        self.dim
    }
    pub fn provider(&self) -> &str {
        &self.provider
    }
}

/// Convenience wrapper so callers hold an `Arc<Embedder>` for cheap clones.
pub type SharedEmbedder = Arc<Embedder>;

/// `ort::init()` must run once per process. Subsequent sessions share the
/// same global environment.
fn init_ort_once() {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        ort::init().with_name("ob2-embedder").commit();
    });
}

/// Build an ORT session, preferring CUDA when available, CPU otherwise.
///
/// The returned provider string (`"cuda:0"` or `"cpu"`) reflects what
/// actually got registered — we check `ep::CUDA::is_available()` at
/// runtime instead of the earlier heuristic based on
/// `CUDA_VISIBLE_DEVICES`, which lied whenever a GPU-less host left the
/// var set (e.g. nvidia-docker with no GPU mapping).
fn build_session(onnx_path: &Path) -> Result<(Session, String)> {
    let mut builder = Session::builder().map_err(ort_err)?;
    builder = builder
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(ort_err)?;
    builder = builder.with_intra_threads(1).map_err(ort_err)?;

    let (builder, provider) = register_providers(builder)?;

    let mut builder = builder;
    let session = builder
        .commit_from_file(onnx_path)
        .map_err(ort_err)
        .with_context(|| format!("commit_from_file({}) failed", onnx_path.display()))?;

    Ok((session, provider))
}

#[cfg(feature = "cuda")]
fn register_providers(builder: SessionBuilder) -> Result<(SessionBuilder, String)> {
    use ort::ep::{CUDA, ExecutionProvider};

    let cuda = CUDA::default();
    let mut builder = builder;
    if cuda.is_available().unwrap_or(false) {
        // Registration still can fail even when `is_available()` reports
        // yes (e.g. driver present but wrong version). Fall back to CPU
        // rather than aborting the whole sidecar in that case.
        match cuda.register(&mut builder) {
            Ok(()) => Ok((builder, "cuda:0".into())),
            Err(err) => {
                tracing::warn!(
                    "CUDA provider available but failed to register ({err}); falling back to CPU"
                );
                Ok((builder, "cpu".into()))
            }
        }
    } else {
        Ok((builder, "cpu".into()))
    }
}

#[cfg(not(feature = "cuda"))]
fn register_providers(builder: SessionBuilder) -> Result<(SessionBuilder, String)> {
    Ok((builder, "cpu".into()))
}

fn load_tokenizer(path: &Path) -> Result<Tokenizer> {
    let mut tok = Tokenizer::from_file(path)
        .map_err(|e| anyhow::anyhow!("tokenizer load from {} failed: {e}", path.display()))?;
    // Match sentence-transformers: pad to the longest item in the batch,
    // truncate anything longer than MAX_SEQ_LEN. Without this, batches of
    // mixed-length inputs would produce ragged encodings that can't be
    // stacked into a rectangular tensor.
    tok.with_padding(Some(PaddingParams {
        strategy: PaddingStrategy::BatchLongest,
        direction: PaddingDirection::Right,
        pad_to_multiple_of: None,
        pad_id: 0,
        pad_type_id: 0,
        pad_token: "[PAD]".into(),
    }));
    tok.with_truncation(Some(TruncationParams {
        max_length: MAX_SEQ_LEN,
        strategy: TruncationStrategy::LongestFirst,
        stride: 0,
        direction: TruncationDirection::Right,
    }))
    .map_err(|e| anyhow::anyhow!("with_truncation failed: {e}"))?;
    Ok(tok)
}

/// Locate `model.onnx` + `tokenizer.json`. Search the pre-warmed fastembed
/// cache layout (for continuity with the existing Docker build), falling
/// back to an hf-hub download rooted at the same cache dir.
fn resolve_model_files() -> Result<(PathBuf, PathBuf)> {
    let cache_root = cache_root();

    if let Some(found) = scan_fastembed_cache(&cache_root) {
        return Ok(found);
    }

    download_from_hf(&cache_root)
}

fn cache_root() -> PathBuf {
    if let Ok(p) = std::env::var("FASTEMBED_CACHE_PATH") {
        return PathBuf::from(p);
    }
    if let Ok(p) = std::env::var("OB2_EMBEDDER_CACHE_PATH") {
        return PathBuf::from(p);
    }
    PathBuf::from("./.fastembed_cache")
}

fn scan_fastembed_cache(cache_root: &Path) -> Option<(PathBuf, PathBuf)> {
    // fastembed-style cache: `<root>/models--Qdrant--all-MiniLM-L6-v2-onnx/snapshots/<rev>/{model.onnx,tokenizer.json}`.
    let snapshots = cache_root
        .join("models--Qdrant--all-MiniLM-L6-v2-onnx")
        .join("snapshots");
    if !snapshots.is_dir() {
        return None;
    }
    let entries = std::fs::read_dir(&snapshots).ok()?;
    for entry in entries.flatten() {
        let snap = entry.path();
        let onnx = snap.join("model.onnx");
        let tok = snap.join("tokenizer.json");
        if onnx.exists() && tok.exists() {
            return Some((onnx, tok));
        }
    }
    None
}

fn download_from_hf(cache_root: &Path) -> Result<(PathBuf, PathBuf)> {
    use hf_hub::api::sync::ApiBuilder;
    std::fs::create_dir_all(cache_root).ok();
    let api = ApiBuilder::new()
        .with_cache_dir(cache_root.to_path_buf())
        .build()
        .context("hf-hub ApiBuilder::build failed")?;
    let repo = api.model("Qdrant/all-MiniLM-L6-v2-onnx".into());
    let onnx = repo
        .get("model.onnx")
        .context("hf-hub download of model.onnx failed")?;
    let tok = repo
        .get("tokenizer.json")
        .context("hf-hub download of tokenizer.json failed")?;
    Ok((onnx, tok))
}
