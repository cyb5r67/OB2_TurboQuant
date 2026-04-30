"""OB2 retrieval sidecar.

Reads JSON-RPC 2.0 requests line-by-line from stdin, writes responses
line-by-line to stdout. Stderr is logging.

Architecture (Phase 3.4):
    Deno → JSON-RPC → Sidecar → StorageBackend (SQLite or pgvector) + ContextEngine
                              ↘ sentence-transformers (embeddings on CUDA if available)

- Backend = source of truth for captures (persistent across restarts)
- ContextEngine = in-process retrieval cache, hydrated lazily per domain
- sentence-transformers = embedding computation (singleton, model stays warm)

Env vars:
    OB2_STORAGE_BACKEND       — 'sqlite' or 'pgvector' (default sqlite)
    OB2_SQLITE_PATH           — path to ob2.db (default ./ob2.db)
    OB2_PG_URL                — postgres conninfo (required if pgvector)
    OB2_EMBEDDING_MODEL       — sentence-transformers model (default all-MiniLM-L6-v2)
    OB2_EMBEDDING_DIM         — embedding dim (default 384)
    OB2_CONTEXT_ENGINE_PATH   — path to /mnt/c/projects/context-engine
    OB2_TOTAL_TOKEN_BUDGET    — default token budget (default 2048)
    OB2_RETRIEVAL_TOP_K       — default top-k (default 5)
    OB2_HYBRID_ALPHA          — TF-IDF / embedding blend (default 0.65)
"""

from __future__ import annotations

import hashlib
import json
import os
import queue
import re
import sys
import threading
import time
import traceback
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any, Callable

import numpy as np

# ─────────────────────────────────────────────────────────────
# Logging helper
# ─────────────────────────────────────────────────────────────

def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# ─────────────────────────────────────────────────────────────
# Bootstrap: paths + config
# ─────────────────────────────────────────────────────────────

CONTEXT_ENGINE_PATH = os.environ.get(
    "OB2_CONTEXT_ENGINE_PATH",
    "/mnt/c/projects/context-engine",
)
if CONTEXT_ENGINE_PATH not in sys.path:
    sys.path.insert(0, CONTEXT_ENGINE_PATH)

# Make package-relative imports work no matter where we're invoked from
_SIDECAR_DIR = os.path.dirname(os.path.abspath(__file__))
_RETRIEVAL_PARENT = os.path.dirname(_SIDECAR_DIR)
if _RETRIEVAL_PARENT not in sys.path:
    sys.path.insert(0, _RETRIEVAL_PARENT)

EMBEDDING_MODEL = os.environ.get("OB2_EMBEDDING_MODEL", "all-MiniLM-L6-v2")
EMBEDDING_DIM = int(os.environ.get("OB2_EMBEDDING_DIM", "384"))
DEFAULT_TOKEN_BUDGET = int(os.environ.get("OB2_TOTAL_TOKEN_BUDGET", "2048"))
DEFAULT_TOP_K = int(os.environ.get("OB2_RETRIEVAL_TOP_K", "5"))
DEFAULT_ALPHA = float(os.environ.get("OB2_HYBRID_ALPHA", "0.65"))
STORAGE_BACKEND = os.environ.get("OB2_STORAGE_BACKEND", "two-tier")
SQLITE_PATH = os.environ.get("OB2_SQLITE_PATH", "./ob2.db")
PG_URL = os.environ.get("OB2_PG_URL", "")
SYNC_INTERVAL = float(os.environ.get("OB2_SYNC_INTERVAL_SEC", "5"))
SYNC_BATCH = int(os.environ.get("OB2_SYNC_BATCH_SIZE", "256"))


# ─────────────────────────────────────────────────────────────
# Embeddings (sentence-transformers, singleton)
# ─────────────────────────────────────────────────────────────

try:
    from sentence_transformers import SentenceTransformer
    from retrieval.embed_batcher import EmbedBatcher
    _st_model: SentenceTransformer | None = None
    _batcher: EmbedBatcher | None = None

    BATCH_FLUSH_MS = float(os.environ.get("OB2_BATCH_FLUSH_MS", "100"))
    BATCH_MAX_SIZE = int(os.environ.get("OB2_BATCH_MAX_SIZE", "32"))

    def _get_embedder() -> SentenceTransformer:
        global _st_model
        if _st_model is None:
            _st_model = SentenceTransformer(EMBEDDING_MODEL)
            log(f"embedder loaded: {EMBEDDING_MODEL} on {_st_model.device}")
        return _st_model

    def _get_batcher() -> EmbedBatcher:
        global _batcher
        if _batcher is None:
            _batcher = EmbedBatcher(
                _get_embedder(),
                flush_interval_ms=BATCH_FLUSH_MS,
                max_batch_size=BATCH_MAX_SIZE,
            )
        return _batcher

    def embed(text: str) -> np.ndarray:
        """Auto-batched embed: buffers for up to 100ms, then fires one GPU call."""
        return _get_batcher().embed(text)

    def embed_batch(texts: list[str]) -> np.ndarray:
        """Batch embed: for large batches (>max_batch_size), bypasses batcher
        and calls GPU directly for max throughput."""
        return _get_batcher().embed_batch(texts)

    _EMBEDDER_AVAILABLE = True
except ImportError:
    log("WARNING: sentence-transformers not installed; falling back to random embeddings")

    _rng = np.random.default_rng(0xDEADBEEF)

    def embed(text: str) -> np.ndarray:
        v = _rng.random(EMBEDDING_DIM).astype(np.float32)
        return v / np.linalg.norm(v)

    def embed_batch(texts: list[str]) -> np.ndarray:
        return np.stack([embed(t) for t in texts])

    _EMBEDDER_AVAILABLE = False
    _batcher = None


# ─────────────────────────────────────────────────────────────
# MarkItDown — single instance, lazily initialised so we don't pay
# for OCR/Whisper model loading until the first conversion.
# ─────────────────────────────────────────────────────────────
_markitdown = None

def _get_markitdown():
    global _markitdown
    if _markitdown is None:
        try:
            from markitdown import MarkItDown
            _markitdown = MarkItDown(enable_plugins=False)
            log("markitdown initialised")
        except ImportError as e:
            log(f"markitdown unavailable: {e}")
            _markitdown = False  # sentinel — distinct from None
    return _markitdown if _markitdown else None


# ─────────────────────────────────────────────────────────────
# Backend (SQLite or pgvector)
# ─────────────────────────────────────────────────────────────

from retrieval.storage.backend import DocRecord, StorageBackend  # noqa: E402

def _open_backend() -> StorageBackend:
    if STORAGE_BACKEND == "two-tier":
        if not PG_URL:
            raise RuntimeError("OB2_STORAGE_BACKEND=two-tier requires OB2_PG_URL")
        from retrieval.storage.two_tier import TwoTierBackend
        return TwoTierBackend(
            sqlite_path=SQLITE_PATH,
            pg_url=PG_URL,
            embedding_dim=EMBEDDING_DIM,
            sync_interval_sec=SYNC_INTERVAL,
            sync_batch_size=SYNC_BATCH,
        )
    if STORAGE_BACKEND == "sqlite":
        from retrieval.storage.sqlite_vec import SQLiteVecBackend
        return SQLiteVecBackend(SQLITE_PATH, embedding_dim=EMBEDDING_DIM)
    if STORAGE_BACKEND == "pgvector":
        if not PG_URL:
            raise RuntimeError("OB2_STORAGE_BACKEND=pgvector requires OB2_PG_URL")
        from retrieval.storage.pg_vector import PgVectorBackend
        return PgVectorBackend(PG_URL, embedding_dim=EMBEDDING_DIM)
    raise RuntimeError(f"unknown OB2_STORAGE_BACKEND: {STORAGE_BACKEND!r}")


_backend: StorageBackend = _open_backend()
log(f"storage backend: {STORAGE_BACKEND} (dim={EMBEDDING_DIM})")


# ─────────────────────────────────────────────────────────────
# Context-engine: in-memory retrieval cache per domain
# ─────────────────────────────────────────────────────────────

from context_engineering import ContextEngine  # type: ignore  # noqa: E402
from retriever import Document  # type: ignore  # noqa: E402

_engines: dict[str, ContextEngine] = {}
_hydrated_domains: set[str] = set()
_engine_lock = threading.Lock()


def _get_engine(domain: str) -> ContextEngine:
    """Lazy-load ContextEngine and hydrate from backend on first access."""
    with _engine_lock:
        if domain in _engines:
            return _engines[domain]
        engine = ContextEngine(
            total_token_budget=DEFAULT_TOKEN_BUDGET,
            retrieval_top_k=DEFAULT_TOP_K,
            retrieval_mode="hybrid",
            compression_strategy="extractive",
            hybrid_alpha=DEFAULT_ALPHA,
            system_prompt="Use the sources below. If not in sources, say you don't know.",
        )
        _engines[domain] = engine
        # Hydrate from backend
        count = 0
        for rec in _backend.list_docs(domain, limit=1_000_000):
            engine.add_document(Document(
                id=rec.doc_id,
                content=rec.text,
                source=rec.metadata.get("source", "backend") if isinstance(rec.metadata, dict) else "backend",
                tags=rec.metadata.get("tags", []) if isinstance(rec.metadata, dict) else [],
                created_at=rec.created_at,
                metadata=rec.metadata if isinstance(rec.metadata, dict) else {},
            ))
            count += 1
        _hydrated_domains.add(domain)
        if count > 0:
            log(f"hydrated domain {domain!r}: {count} docs loaded from backend")
        return engine


# ─────────────────────────────────────────────────────────────
# RPC methods
# ─────────────────────────────────────────────────────────────

def method_ping(_params: dict) -> dict:
    return {
        "pong": True,
        "embedder": _EMBEDDER_AVAILABLE,
        "backend": STORAGE_BACKEND,
        "batcher": _batcher.stats() if _batcher is not None else None,
    }


def method_capture(params: dict) -> dict:
    """Embed, persist to backend, and register with in-memory ContextEngine."""
    domain = params["domain"]
    doc_id = params["doc_id"]
    text = params["text"]
    tags = list(params.get("tags") or [])
    source = params.get("source") or "user"
    extra_metadata = params.get("metadata") or {}
    if not isinstance(extra_metadata, dict):
        raise ValueError("metadata must be an object")

    vec = embed(text)
    # Caller-supplied metadata fields override the defaults source/tags
    # only if explicitly set — the import path uses this to preserve
    # _ob2_import_source, _ob2_chunk_index, _ob2_breadcrumb, etc.
    metadata = {"source": source, "tags": tags, **extra_metadata}
    captured_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    _backend.upsert_doc(
        domain=domain,
        doc_id=doc_id,
        text=text,
        embedding=vec,
        metadata=metadata,
        source_hash="",
    )

    # Also register with in-memory engine if the domain is already hydrated.
    # If cold, next retrieve will hydrate from backend and pick it up.
    with _engine_lock:
        engine = _engines.get(domain)
    if engine is not None:
        engine.add_document(Document(id=doc_id, content=text, source=source, tags=tags, created_at=captured_at))

    # Fire async graph extraction (no-op if graph.extraction_enabled is false).
    _enqueue_extraction_if_enabled(domain, doc_id, text)

    stats = _backend.domain_stats(domain)
    return {"doc_id": doc_id, "domain": domain, "doc_count": stats.doc_count, "created_at": captured_at}


def method_capture_batch(params: dict) -> dict:
    """Bulk capture — embeds in batches on GPU for throughput.

    Params: domain, docs: [{doc_id, text, tags?, source?, source_hash?}, ...]
    """
    domain = params["domain"]
    doc_items: list[dict] = params["docs"]
    if not doc_items:
        return {"written": 0, "domain": domain}

    texts = [d["text"] for d in doc_items]
    vecs = embed_batch(texts)

    records = [
        DocRecord(
            doc_id=d["doc_id"],
            domain=domain,
            text=d["text"],
            embedding=vecs[i],
            metadata={
                "source": d.get("source") or "import",
                "tags": list(d.get("tags") or []),
            },
            source_hash=d.get("source_hash") or "",
        )
        for i, d in enumerate(doc_items)
    ]
    written = _backend.upsert_docs_batch(domain, records)

    # Invalidate/refresh in-memory engine if hydrated
    with _engine_lock:
        if domain in _engines:
            # Cheapest correct move: drop the cached engine; next retrieve re-hydrates.
            _engines.pop(domain, None)
            _hydrated_domains.discard(domain)

    # Fire async graph extraction for each new doc (no-op if disabled).
    for d in records:
        _enqueue_extraction_if_enabled(domain, d.doc_id, d.text)

    return {"written": written, "domain": domain}


def method_retrieve(params: dict) -> dict:
    domain = params["domain"]
    query = params["query"]
    top_k = int(params.get("top_k") or DEFAULT_TOP_K)
    alpha = float(params.get("alpha") or DEFAULT_ALPHA)

    stats = _backend.domain_stats(domain)
    if stats.doc_count == 0:
        return {"docs": [], "unknown_domain": True}

    engine = _get_engine(domain)
    hits = engine._retriever.retrieve(query, top_k=top_k, alpha=alpha)  # noqa: SLF001
    return {
        "docs": [
            {
                "doc_id": h.document.id,
                "content": h.document.content,
                "score": float(h.score),
                "match_reason": h.match_reason,
                "tags": list(h.document.tags),
                "source": h.document.source,
                "created_at": h.document.created_at,
            }
            for h in hits
        ],
    }


def _graph_rerank_single_domain(
    domain: str,
    retrieved_docs: list[dict],
    *,
    use_graph: bool | None,
    top_k: int = 8,
) -> list[dict]:
    """Optionally augment vector hits with graph neighbors.

    For each top hit, finds docs that share at least one entity (1-hop graph
    expansion), boosts their score, and merges them into the result list.
    Returns the original list unchanged when graph is disabled or no hits
    have been extracted yet.
    """
    cfg = _read_graph_config()
    enabled = use_graph if use_graph is not None else cfg.get("enabled")
    if not enabled or not retrieved_docs:
        return retrieved_docs

    anchor_ids = [d["doc_id"] for d in retrieved_docs[:top_k]]
    try:
        neighbors = _backend.find_neighbor_docs(domain, anchor_ids, limit=20)
    except Exception as e:
        log(f"graph: rerank lookup failed: {e}")
        return retrieved_docs
    if not neighbors:
        return retrieved_docs

    alpha = float(cfg.get("rerank_alpha") or 0.3)
    # Map anchor doc_id -> score so each neighbor gets boosted by its strongest
    # tie. We don't need entity mention counts here — rerank_alpha already
    # caps the influence relative to the vector score.
    anchor_scores = {d["doc_id"]: float(d.get("score") or 0.0) for d in retrieved_docs}
    existing = {d["doc_id"] for d in retrieved_docs}
    additions: list[dict] = []
    for n in neighbors:
        if n.doc_id in existing:
            continue
        # Crude attribution: pick max anchor score among the anchors that
        # share at least one of n.shared_entity_ids. Approximated as max
        # anchor score because we don't have per-anchor entity overlap here.
        boost = alpha * max(anchor_scores.values()) if anchor_scores else alpha
        meta = n.metadata if isinstance(n.metadata, dict) else {}
        additions.append({
            "doc_id": n.doc_id,
            "content": n.text or "",
            "score": float(boost),
            "match_reason": "graph",
            "tags": (meta.get("tags") if isinstance(meta.get("tags"), list) else []) or [],
            "source": meta.get("source") or "",
            "created_at": n.created_at,
            "_ob2_import_file_id": meta.get("_ob2_import_file_id"),
            "_ob2_import_filename": meta.get("_ob2_import_filename"),
            "_ob2_chunk_index": meta.get("_ob2_chunk_index"),
        })
    if not additions:
        return retrieved_docs
    pooled = list(retrieved_docs) + additions
    pooled.sort(key=lambda d: float(d.get("score") or 0.0), reverse=True)
    return pooled


def method_build_context(params: dict) -> dict:
    domain = params["domain"]
    query = params["query"]
    budget = int(params.get("budget_tokens") or DEFAULT_TOKEN_BUDGET)
    use_graph = params.get("use_graph")
    show_uploader = params.get("show_uploader_in_context", True)

    stats = _backend.domain_stats(domain)
    if stats.doc_count == 0:
        return {
            "compressed_text": "",
            "retrieved_docs": [],
            "unknown_domain": True,
        }

    engine = _get_engine(domain)
    engine.total_token_budget = budget
    packet = engine.build(query)
    retrieved = [
        {
            "doc_id": h.document.id,
            "content": h.document.content,
            "score": float(h.score),
            "match_reason": h.match_reason,
            "tags": list(h.document.tags),
            "source": h.document.source,
            "created_at": h.document.created_at,
            "_ob2_uploaded_by": h.document.metadata.get("_ob2_uploaded_by") if show_uploader else None,
        }
        for h in packet.retrieved_docs
    ]
    retrieved = _graph_rerank_single_domain(domain, retrieved, use_graph=use_graph)
    return {
        "compressed_text": packet.compressed_text,
        "retrieved_docs": retrieved,
        "budget_summary": {
            str(k): int(v) for k, v in packet.budget_summary.items()
            if not str(k).startswith("_")
        },
        "metadata": {str(k): v for k, v in packet.metadata.items()},
    }


def _ocr_pdf_to_text(pdf_path: str) -> str:
    """OCR an image-only PDF and return the recovered text.

    Uses ocrmypdf, which wraps tesseract + ghostscript + qpdf to produce
    a searchable PDF plus a sidecar text file. We discard the searchable
    PDF and return only the sidecar text.

    Returns "" on any failure; the caller treats that as "OCR didn't help"
    rather than an error.
    """
    import os
    import subprocess
    import tempfile

    if not os.path.isfile(pdf_path):
        return ""

    with tempfile.TemporaryDirectory() as td:
        out_pdf = os.path.join(td, "ocr.pdf")
        sidecar = os.path.join(td, "text.txt")
        # Invoke via `python -m ocrmypdf` (using the same Python the sidecar
        # is running under) so we don't depend on PATH containing the venv's
        # bin/ — the subprocess env doesn't always inherit it.
        #
        # Quality flags:
        #   --rotate-pages: auto-detect page rotation via OSD, normalise upright
        #   --deskew: straighten crooked scans
        #   --clean: run unpaper to remove borders/noise before OCR
        #   --oversample 300: upscale low-DPI sources to 300 DPI before OCR
        # Operational flags:
        #   --skip-text: skip pages that already have a text layer (mixed PDFs)
        #   --output-type pdf: keep output light; we don't read this file
        #   --quiet: ocrmypdf is chatty otherwise
        #   --jobs 2: a tiny bit of parallelism without hammering the box
        cmd = [
            sys.executable, "-m", "ocrmypdf",
            "--rotate-pages",
            "--deskew",
            "--clean",
            "--oversample", "300",
            "--skip-text",
            "--output-type", "pdf",
            "--sidecar", sidecar,
            "--quiet",
            "--jobs", "2",
            "-l", os.environ.get("OB2_OCR_LANGUAGE", "eng"),
            pdf_path,
            out_pdf,
        ]
        try:
            subprocess.run(cmd, check=True, capture_output=True, timeout=300)
        except subprocess.CalledProcessError as e:
            log(f"ocrmypdf failed (rc={e.returncode}): {e.stderr.decode('utf-8', 'replace')[:200]}")
            return ""
        except subprocess.TimeoutExpired:
            log("ocrmypdf timed out (>5min)")
            return ""

        try:
            with open(sidecar, "r", encoding="utf-8") as f:
                return f.read()
        except OSError:
            return ""


def method_convert_to_markdown(params: dict) -> dict:
    """
    Convert a local file path or URL to Markdown.

    Params:
      source: str — either an absolute filesystem path or http(s):// URL.

    Returns:
      {
        "markdown": str,
        "title": str | None,
        "source_format": str,
        "char_count": int,
        "warnings": list[str],
        "duration_ms": int,
      }
    """
    md = _get_markitdown()
    if md is None:
        raise ValueError("markitdown not installed")

    source = params.get("source")
    if not isinstance(source, str) or not source:
        raise ValueError("source must be a non-empty string")

    started = time.time()
    result = md.convert(source)
    text = (result.text_content or "").strip()
    title = getattr(result, "title", None)
    if source.startswith(("http://", "https://")):
        fmt = "url"
    else:
        fmt = source.rsplit(".", 1)[-1].lower() if "." in source else "unknown"
    warnings: list[str] = []
    if hasattr(result, "warnings") and result.warnings:
        warnings = [str(w) for w in result.warnings]

    # OCR fallback for scanned PDFs. MarkItDown's PDF path uses pdfminer,
    # which only reads embedded text layers — image-only PDFs (DoD-issued
    # forms, scanned receipts, etc.) come back with text_content=''. When
    # that happens, run ocrmypdf on the source and re-extract.
    if fmt == "pdf" and not text and not source.startswith(("http://", "https://")):
        try:
            ocr_text = _ocr_pdf_to_text(source)
            if ocr_text.strip():
                text = ocr_text.strip()
                warnings.append("PDF had no text layer; recovered via OCR (tesseract via ocrmypdf)")
        except Exception as e:
            warnings.append(f"OCR fallback failed: {e}")

    duration_ms = int((time.time() - started) * 1000)

    return {
        "markdown": text,
        "title": title,
        "source_format": fmt,
        "char_count": len(text),
        "warnings": warnings,
        "duration_ms": duration_ms,
    }


def method_build_multi_context(params: dict) -> dict:
    """Retrieve and pack context from multiple domains in a single pgvector scan.

    Used by the gateway's prefix-less chat path: rather than picking one domain
    via a classifier, it searches every domain the caller can read and lets
    cosine similarity rank them together. Top hits up to `budget_tokens` fill
    the compressed_text block; each hit carries its source domain in metadata.

    Params:
      domains:       list[str], non-empty — caller-scoped candidate domains
      query:         str
      budget_tokens: int, optional (default DEFAULT_TOKEN_BUDGET)
      top_k:         int, optional — how many raw hits to fetch before trimming
                     to the budget. Default 10.

    Returns same shape as method_build_context so the gateway can treat both
    paths identically.
    """
    domains = params.get("domains") or []
    if not isinstance(domains, list):
        raise ValueError("domains must be a list of strings")
    query = params["query"]
    budget = int(params.get("budget_tokens") or DEFAULT_TOKEN_BUDGET)
    top_k = int(params.get("top_k") or 10)
    show_uploader = params.get("show_uploader_in_context", True)

    # Filter out empty domains — searching an unknown/empty domain wastes no
    # time at pgvector level (just an index miss), but it's cleaner to report
    # "no_domains" up front if the caller's assigned set is all empty.
    populated = [d for d in domains if _backend.domain_stats(d).doc_count > 0]
    if not populated:
        return {
            "compressed_text": "",
            "retrieved_docs": [],
            "budget_summary": {"docs": 0, "total_chars": 0},
            "metadata": {"domains_searched": [], "no_domains": True},
        }

    q_emb = embed(query)
    hits = _backend.query_similar_multi(populated, q_emb, top_k)

    # Drop system docs (the seed doc that stores a domain's description).
    user_hits = [
        h for h in hits
        if not (isinstance(h.metadata, dict) and h.metadata.get("_ob2_system"))
    ]

    # Pack hits up to the budget. Rough char-to-token ratio ≈ 4:1 for English;
    # close enough for budgeting and lets us avoid a tokenizer round-trip.
    char_budget = max(200, budget * 4)
    sections: list[str] = []
    retrieved: list[dict] = []
    total_chars = 0
    for i, h in enumerate(user_hits, 1):
        meta = h.metadata if isinstance(h.metadata, dict) else {}
        source_domain = meta.get("_ob2_domain") or "?"
        date = h.created_at[:10] if h.created_at else ""
        src = (meta.get("source") or "").strip()
        origin = (src if src and src.lower() not in {"backend", "mcp", ""} else "")

        # Bake the date into the fact text itself, not as ambient metadata.
        # Stronger instruction-tuned models (Gemma 4 31B) treat header
        # fields as system metadata distinct from content, and refuse to
        # answer "when did I tell you?" from a 'captured=' field. Putting
        # the date inside the source body — as a sentence the user "said"
        # alongside the fact — closes that semantic gap and works for
        # weaker models too.
        text = h.text.strip()
        suffix_parts: list[str] = []
        if date:
            suffix_parts.append(f"Saved on {date}")
        if origin:
            suffix_parts.append(f"from {origin}")
        if show_uploader:
            uploader = meta.get("_ob2_uploaded_by") or ""
            if uploader:
                suffix_parts.append(f"uploaded by {uploader}")
        if suffix_parts:
            text = f"{text}\n  ({'; '.join(suffix_parts)}.)"
        block = f"[{i}] source=@{source_domain}\n{text}"
        if retrieved and total_chars + len(block) > char_budget:
            break
        sections.append(block)
        retrieved.append({
            "doc_id": h.doc_id,
            "content": h.text,
            "score": float(h.score),
            "match_reason": "similarity",
            "tags": [],
            "source": source_domain,
            "created_at": h.created_at,
            # File-traceability fields. The gateway uses these to build
            # signed download URLs and inject a "Sources" section into the
            # system prompt so the model can render citations as clickable
            # markdown links.
            "_ob2_import_file_id": meta.get("_ob2_import_file_id"),
            "_ob2_import_filename": meta.get("_ob2_import_filename"),
            "_ob2_chunk_index": meta.get("_ob2_chunk_index"),
            "_ob2_uploaded_by": meta.get("_ob2_uploaded_by"),
        })
        total_chars += len(block)

    # Optional graph-aware rerank. Group anchor doc_ids by domain (since the
    # graph is domain-scoped) and ask for neighbors within each. Boosted
    # neighbors are merged in and re-sorted alongside the vector hits before
    # the budget pass below.
    use_graph = params.get("use_graph")
    cfg = _read_graph_config()
    if (use_graph if use_graph is not None else cfg.get("enabled")) and retrieved:
        alpha = float(cfg.get("rerank_alpha") or 0.3)
        existing = {d["doc_id"] for d in retrieved}
        per_dom_anchors: dict[str, list[str]] = {}
        anchor_scores = {d["doc_id"]: float(d.get("score") or 0.0) for d in retrieved}
        for d in retrieved[:8]:
            per_dom_anchors.setdefault(d.get("source") or "", []).append(d["doc_id"])
        max_anchor = max(anchor_scores.values()) if anchor_scores else 0.0
        graph_additions: list[dict] = []
        for dom, ids in per_dom_anchors.items():
            if not dom:
                continue
            try:
                neighbors = _backend.find_neighbor_docs(dom, ids, limit=10)
            except Exception:
                continue
            for n in neighbors:
                if n.doc_id in existing:
                    continue
                meta = n.metadata if isinstance(n.metadata, dict) else {}
                graph_additions.append({
                    "doc_id": n.doc_id,
                    "content": n.text or "",
                    "score": alpha * max_anchor,
                    "match_reason": "graph",
                    "tags": [],
                    "source": dom,
                    "created_at": n.created_at,
                    "_ob2_import_file_id": meta.get("_ob2_import_file_id"),
                    "_ob2_import_filename": meta.get("_ob2_import_filename"),
                    "_ob2_chunk_index": meta.get("_ob2_chunk_index"),
                })
                existing.add(n.doc_id)
        if graph_additions:
            retrieved.extend(graph_additions)
            retrieved.sort(key=lambda d: float(d.get("score") or 0.0), reverse=True)

    return {
        "compressed_text": "\n\n".join(sections),
        "retrieved_docs": retrieved,
        "budget_summary": {"docs": len(retrieved), "total_chars": total_chars},
        "metadata": {
            "domains_searched": populated,
            "hits_total": len(user_hits),
        },
    }


def method_knowledge_stats(params: dict) -> dict:
    domain = params.get("domain")
    if domain is None:
        domains = _backend.list_domains()
        result = []
        for d in domains:
            stats = _backend.domain_stats(d)
            has_seed = _backend.get_doc(d, f"_ob2_domain_{d}") is not None
            result.append({
                "domain": d,
                "doc_count": max(0, stats.doc_count - (1 if has_seed else 0)),
                "description": _get_domain_description(d),
            })
        return {"domains": result}
    stats = _backend.domain_stats(domain)
    has_seed = _backend.get_doc(domain, f"_ob2_domain_{domain}") is not None
    corrected_count = max(0, stats.doc_count - (1 if has_seed else 0))
    return {
        "domain": domain,
        "doc_count": corrected_count,
        "total_bytes": stats.total_bytes,
        "oldest_at": stats.oldest_at,
        "newest_at": stats.newest_at,
        "exists": corrected_count > 0,
        "description": _get_domain_description(domain),
    }


def method_list_domains(_params: dict) -> dict:
    return {"domains": _backend.list_domains()}


def method_delete(params: dict) -> dict:
    domain = params["domain"]
    doc_id = params["doc_id"]
    ok = _backend.delete_doc(domain, doc_id)
    # Invalidate engine cache so retrieval doesn't surface deleted doc
    with _engine_lock:
        _engines.pop(domain, None)
        _hydrated_domains.discard(domain)
    return {"deleted": ok}


def method_delete_domain(params: dict) -> dict:
    """Delete all docs + aliases + source_imports for a domain."""
    domain = params["domain"]
    count = _backend.delete_domain(domain)
    # Invalidate cached engine so future queries see the empty domain
    with _engine_lock:
        _engines.pop(domain, None)
        _hydrated_domains.discard(domain)
    return {"deleted_count": count, "domain": domain}


# ─────────────────────────────────────────────────────────────
# Domain export / import — single-file .ob2bundle (tar.gz)
# Spec: docs/superpowers/specs/2026-04-25-domain-export-import-design.md
# ─────────────────────────────────────────────────────────────

BUNDLE_FORMAT = "ob2-domain-bundle"
BUNDLE_VERSION = 1
IMPORTS_ROOT = os.environ.get("OB2_IMPORTS_ROOT", "/data/imports")


def _b64_pack_embedding(vec: np.ndarray) -> str:
    """Pack a float32 embedding as base64 of its raw little-endian bytes."""
    import base64
    arr = np.asarray(vec, dtype=np.float32)
    # tobytes() is native byte order; numpy float32 is little-endian on x86 + ARM,
    # but force it explicitly so bundles round-trip across architectures.
    return base64.b64encode(arr.astype("<f4").tobytes()).decode("ascii")


def _b64_unpack_embedding(s: str, expected_dim: int) -> np.ndarray:
    import base64
    raw = base64.b64decode(s.encode("ascii"))
    arr = np.frombuffer(raw, dtype="<f4").astype(np.float32)
    if arr.shape[0] != expected_dim:
        raise ValueError(f"embedding dim mismatch: got {arr.shape[0]}, expected {expected_dim}")
    return arr


def method_export_domain(params: dict) -> dict:
    """Stream a domain's docs+aliases+files into a .ob2bundle at params['out_path'].

    Returns counts of what was packaged.
    """
    import tarfile
    import io

    domain = params["domain"]
    out_path = params["out_path"]

    # Validate the domain has at least the seed doc; otherwise it doesn't exist.
    seed = _backend.get_doc(domain, f"_ob2_domain_{domain}")
    if seed is None:
        # Could still be a domain with docs but no seed (legacy). Check list_docs.
        any_docs = _backend.list_docs(domain, limit=1)
        if not any_docs:
            return {"ok": False, "error": "domain_not_found", "domain": domain}

    description = _get_domain_description(domain)
    aliases = _backend.list_aliases(domain)

    # Pull all docs (skip system seed docs) — list_docs has no native iterator,
    # so we page through with a generous cap. Domains with millions of docs aren't
    # in scope; admin UI lists already cap at 10k.
    all_docs = _backend.list_docs(domain, limit=1_000_000)
    user_docs = [
        d for d in all_docs
        if not (isinstance(d.metadata, dict) and d.metadata.get("_ob2_system"))
    ]

    # Walk the imports directory for original files. Missing dir is fine — the
    # domain may have only text captures.
    files_dir = os.path.join(IMPORTS_ROOT, domain)
    file_entries: list[str] = []
    if os.path.isdir(files_dir):
        for name in sorted(os.listdir(files_dir)):
            full = os.path.join(files_dir, name)
            if os.path.isfile(full):
                file_entries.append(name)

    # ── graph data: entities + mentions + edges ──
    # entity_id is deterministic (sha1(domain|type|lower(name))[:16]) so on
    # import we can restore them under whatever target_domain the operator
    # picks — but only if we recompute the id under the new domain. We
    # serialize NAME+TYPE here (the ground truth) and let the importer
    # rebuild ids.
    g_entities = _backend.list_entities(domain, limit=1_000_000)
    entities_buf = io.BytesIO()
    for e in g_entities:
        row = {
            "entity_id": e.entity_id,
            "name": e.name,
            "type": e.type,
            "mention_count": e.mention_count,
            "first_seen": e.first_seen,
            "last_seen": e.last_seen,
        }
        entities_buf.write((json.dumps(row, ensure_ascii=False) + "\n").encode("utf-8"))
    entities_bytes = entities_buf.getvalue()

    mentions_buf = io.BytesIO()
    mention_total = 0
    for d in user_docs:
        eids = _backend.list_mentions(domain, d.doc_id)
        for eid in eids:
            mentions_buf.write((json.dumps({
                "doc_id": d.doc_id,
                "entity_id": eid,
            }) + "\n").encode("utf-8"))
            mention_total += 1
    mentions_bytes = mentions_buf.getvalue()

    g_edges = _backend.list_edges(domain, limit=1_000_000)
    edges_buf = io.BytesIO()
    for ed in g_edges:
        row = {
            "src_id": ed.src_id,
            "dst_id": ed.dst_id,
            "relation": ed.relation,
            "weight": ed.weight,
            "evidence_doc_id": ed.evidence_doc_id,
            "last_seen": ed.last_seen,
        }
        edges_buf.write((json.dumps(row, ensure_ascii=False) + "\n").encode("utf-8"))
    edges_bytes = edges_buf.getvalue()

    exported_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    manifest = {
        "format": BUNDLE_FORMAT,
        "version": BUNDLE_VERSION,
        "domain": domain,
        "embedding_model": EMBEDDING_MODEL,
        "embedding_dim": EMBEDDING_DIM,
        "exported_at": exported_at,
        "doc_count": len(user_docs),
        "alias_count": len(aliases),
        "file_count": len(file_entries),
        "graph_entity_count": len(g_entities),
        "graph_mention_count": mention_total,
        "graph_edge_count": len(g_edges),
    }
    domain_meta = {
        "description": description,
        "aliases": [{"alias": a, "canonical": c} for (a, c) in aliases],
    }

    # Stream documents.jsonl into an in-memory buffer; for the doc volumes we
    # actually expect (hundreds → low thousands) this is fine. If we ever care
    # about millions, swap for a tempfile + tar.add().
    docs_buf = io.BytesIO()
    for d in user_docs:
        row = {
            "doc_id": d.doc_id,
            "text": d.text,
            "tags": (d.metadata or {}).get("tags") or [],
            "source": (d.metadata or {}).get("source") or "",
            "created_at": d.created_at or "",
            "metadata": d.metadata or {},
            "embedding_b64": _b64_pack_embedding(d.embedding),
        }
        docs_buf.write((json.dumps(row, ensure_ascii=False) + "\n").encode("utf-8"))
    docs_bytes = docs_buf.getvalue()

    manifest_bytes = json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8")
    domain_bytes = json.dumps(domain_meta, ensure_ascii=False, indent=2).encode("utf-8")

    def _add_bytes(tar: "tarfile.TarFile", arcname: str, data: bytes) -> None:
        ti = tarfile.TarInfo(name=arcname)
        ti.size = len(data)
        ti.mtime = int(time.time())
        ti.mode = 0o644
        tar.addfile(ti, io.BytesIO(data))

    bytes_written = 0
    with tarfile.open(out_path, "w:gz", compresslevel=6) as tar:
        _add_bytes(tar, "manifest.json", manifest_bytes)
        _add_bytes(tar, "domain.json", domain_bytes)
        _add_bytes(tar, "documents.jsonl", docs_bytes)
        if entities_bytes:
            _add_bytes(tar, "entities.jsonl", entities_bytes)
        if mentions_bytes:
            _add_bytes(tar, "mentions.jsonl", mentions_bytes)
        if edges_bytes:
            _add_bytes(tar, "edges.jsonl", edges_bytes)
        for name in file_entries:
            tar.add(os.path.join(files_dir, name), arcname=f"files/{name}")
    bytes_written = os.path.getsize(out_path)

    return {
        "ok": True,
        "domain": domain,
        "doc_count": len(user_docs),
        "alias_count": len(aliases),
        "file_count": len(file_entries),
        "graph_entity_count": len(g_entities),
        "graph_mention_count": mention_total,
        "graph_edge_count": len(g_edges),
        "bytes_written": bytes_written,
        "exported_at": exported_at,
    }


def method_import_domain(params: dict) -> dict:
    """Restore a .ob2bundle from params['in_path']. Optional 'target_domain' override."""
    import tarfile

    in_path = params["in_path"]
    target_override = (params.get("target_domain") or "").strip().lower() or None

    if not os.path.isfile(in_path):
        return {"ok": False, "error": "bundle_invalid", "detail": "no such file"}

    try:
        tar = tarfile.open(in_path, "r:gz")
    except (tarfile.TarError, OSError) as e:
        return {"ok": False, "error": "bundle_invalid", "detail": f"not a tar.gz: {e}"}

    try:
        # ── manifest ────────────────────────────────────────────
        try:
            mf = tar.extractfile("manifest.json")
            if mf is None:
                return {"ok": False, "error": "bundle_invalid", "detail": "missing manifest.json"}
            manifest = json.loads(mf.read().decode("utf-8"))
        except (KeyError, json.JSONDecodeError) as e:
            return {"ok": False, "error": "bundle_invalid", "detail": f"bad manifest: {e}"}

        if manifest.get("format") != BUNDLE_FORMAT:
            return {"ok": False, "error": "bundle_invalid", "detail": "wrong format"}
        if manifest.get("version") != BUNDLE_VERSION:
            return {
                "ok": False,
                "error": "unsupported_bundle_version",
                "detail": f"got v{manifest.get('version')}, this build supports v{BUNDLE_VERSION}",
            }
        if manifest.get("embedding_model") != EMBEDDING_MODEL:
            return {
                "ok": False,
                "error": "embedding_model_mismatch",
                "detail": f"bundle was {manifest.get('embedding_model')!r}; this install uses {EMBEDDING_MODEL!r}",
            }
        if int(manifest.get("embedding_dim") or 0) != EMBEDDING_DIM:
            return {
                "ok": False,
                "error": "embedding_dim_mismatch",
                "detail": f"bundle dim={manifest.get('embedding_dim')}, install dim={EMBEDDING_DIM}",
            }

        target_domain = target_override or manifest["domain"]
        if not re.match(r"^[a-z0-9-]+$", target_domain) or len(target_domain) > 64:
            return {"ok": False, "error": "invalid_domain_name", "detail": target_domain}

        # ── refuse if domain already exists (any user doc, alias, or seed) ──
        seed_doc_id = f"_ob2_domain_{target_domain}"
        if _backend.get_doc(target_domain, seed_doc_id) is not None:
            return {"ok": False, "error": "domain_exists", "domain": target_domain}
        existing = _backend.list_docs(target_domain, limit=1)
        if existing:
            return {"ok": False, "error": "domain_exists", "domain": target_domain}
        existing_aliases = _backend.list_aliases(target_domain)
        if existing_aliases:
            return {"ok": False, "error": "domain_exists", "domain": target_domain}

        # ── domain.json (description + aliases) ────────────────
        try:
            df = tar.extractfile("domain.json")
            if df is None:
                return {"ok": False, "error": "bundle_invalid", "detail": "missing domain.json"}
            domain_meta = json.loads(df.read().decode("utf-8"))
        except (KeyError, json.JSONDecodeError) as e:
            return {"ok": False, "error": "bundle_invalid", "detail": f"bad domain.json: {e}"}

        description = domain_meta.get("description") or ""
        bundle_aliases = domain_meta.get("aliases") or []

        # ── seed doc first (so the domain registration is real even if the
        #    rest of the import fails partway and the operator wants to retry
        #    from a known-empty state). delete_domain wipes everything cleanly.
        seed_text = description or f"Domain: {target_domain}"
        seed_vec = embed(seed_text)
        _backend.upsert_doc(
            domain=target_domain,
            doc_id=seed_doc_id,
            text=seed_text,
            embedding=seed_vec,
            metadata={"_ob2_system": True, "_ob2_type": "domain_init", "description": description},
            source_hash="",
        )

        # ── documents.jsonl streamed in batches ────────────────
        docs_member = tar.extractfile("documents.jsonl")
        if docs_member is None:
            return {"ok": False, "error": "bundle_invalid", "detail": "missing documents.jsonl"}

        BATCH = 256
        batch: list[DocRecord] = []
        doc_count = 0

        def _flush() -> None:
            nonlocal batch, doc_count
            if not batch:
                return
            _backend.upsert_docs_batch(target_domain, batch)
            doc_count += len(batch)
            batch = []

        # doc_ids are globally UNIQUE in both backend schemas. If the source
        # domain still exists (or any other domain reuses these ids), reusing
        # the bundle's doc_ids would collide. Regenerate them with the same
        # timestamp+random format the MCP layer uses, and stash the original
        # under metadata._ob2_orig_doc_id for provenance.
        import secrets
        ts_base = int(time.time() * 1000)
        next_idx = [0]

        def _new_doc_id() -> str:
            # Mix in a per-row index + a fresh random tail so the id is unique
            # both within this batch and across concurrent imports.
            ts = format(ts_base + next_idx[0], "x")
            next_idx[0] += 1
            rnd = secrets.token_hex(3)
            return f"{ts}-{rnd}"

        # doc_id remap: needed for restoring graph mentions under the new ids.
        doc_id_remap: dict[str, str] = {}

        for raw_line in docs_member:
            line = raw_line.decode("utf-8").strip()
            if not line:
                continue
            try:
                row = json.loads(line)
                vec = _b64_unpack_embedding(row["embedding_b64"], EMBEDDING_DIM)
            except (KeyError, ValueError, json.JSONDecodeError) as e:
                # Roll back partial restore so the operator can retry cleanly.
                _backend.delete_domain(target_domain)
                return {"ok": False, "error": "bundle_invalid", "detail": f"bad document row: {e}"}
            orig_doc_id = row.get("doc_id") or ""
            new_doc_id = _new_doc_id()
            if orig_doc_id:
                doc_id_remap[orig_doc_id] = new_doc_id
            metadata = dict(row.get("metadata") or {})
            if orig_doc_id:
                metadata["_ob2_orig_doc_id"] = orig_doc_id
            batch.append(DocRecord(
                doc_id=new_doc_id,
                domain=target_domain,
                text=row.get("text") or "",
                embedding=vec,
                metadata=metadata,
                source_hash="",
                created_at=row.get("created_at") or "",
            ))
            if len(batch) >= BATCH:
                _flush()
        _flush()

        # ── aliases ────────────────────────────────────────────
        alias_count = 0
        for entry in bundle_aliases:
            alias = entry.get("alias")
            canonical = entry.get("canonical")
            if alias and canonical:
                _backend.upsert_alias(target_domain, alias, canonical)
                alias_count += 1

        # ── graph data: entities + mentions + edges ────────────
        # entity_id is hashed against (domain, type, name); when target_domain
        # differs from manifest.domain, all ids change. Build a remap from
        # bundle entity_id → new entity_id under target_domain.
        entity_id_remap: dict[str, str] = {}
        graph_entity_count = 0
        graph_mention_count = 0
        graph_edge_count = 0
        ent_member = None
        try:
            ent_member = tar.extractfile("entities.jsonl")
        except KeyError:
            ent_member = None
        if ent_member is not None:
            for raw_line in ent_member:
                line = raw_line.decode("utf-8").strip()
                if not line:
                    continue
                try:
                    er = json.loads(line)
                except json.JSONDecodeError:
                    continue
                bundle_eid = er.get("entity_id") or ""
                name = er.get("name") or ""
                typ = (er.get("type") or "").upper()
                if not name or typ not in VALID_ENTITY_TYPES:
                    continue
                new_eid = _entity_id(target_domain, typ, name)
                if bundle_eid:
                    entity_id_remap[bundle_eid] = new_eid
                _backend.upsert_entity(target_domain, new_eid, name, typ)
                # Restore mention_count via direct update if the bundle had it.
                # We'll let mentions.jsonl restoration drive the count instead —
                # cleaner than trusting denormalized counts.
                graph_entity_count += 1

        ment_member = None
        try:
            ment_member = tar.extractfile("mentions.jsonl")
        except KeyError:
            ment_member = None
        if ment_member is not None:
            for raw_line in ment_member:
                line = raw_line.decode("utf-8").strip()
                if not line:
                    continue
                try:
                    mr = json.loads(line)
                except json.JSONDecodeError:
                    continue
                bundle_doc = mr.get("doc_id") or ""
                bundle_eid = mr.get("entity_id") or ""
                new_doc = doc_id_remap.get(bundle_doc)
                new_eid = entity_id_remap.get(bundle_eid)
                if not new_doc or not new_eid:
                    continue
                _backend.upsert_mention(target_domain, new_doc, new_eid)
                graph_mention_count += 1
            # Sync entities.mention_count from the rows we just restored.
            try:
                _backend.recompute_mention_counts(target_domain)
            except Exception as e:
                log(f"graph: recompute_mention_counts failed for {target_domain}: {e}")

        edge_member = None
        try:
            edge_member = tar.extractfile("edges.jsonl")
        except KeyError:
            edge_member = None
        if edge_member is not None:
            for raw_line in edge_member:
                line = raw_line.decode("utf-8").strip()
                if not line:
                    continue
                try:
                    edr = json.loads(line)
                except json.JSONDecodeError:
                    continue
                src = entity_id_remap.get(edr.get("src_id") or "")
                dst = entity_id_remap.get(edr.get("dst_id") or "")
                rel = (edr.get("relation") or "").strip().lower()
                if not src or not dst or not rel:
                    continue
                evidence = doc_id_remap.get(edr.get("evidence_doc_id") or "") if edr.get("evidence_doc_id") else None
                _backend.upsert_edge(target_domain, src, dst, rel, evidence_doc_id=evidence)
                graph_edge_count += 1

        # ── files/ → /data/imports/<target_domain>/ ────────────
        files_root = os.path.join(IMPORTS_ROOT, target_domain)
        os.makedirs(files_root, exist_ok=True)
        file_count = 0
        for member in tar.getmembers():
            if not member.isfile():
                continue
            if not member.name.startswith("files/"):
                continue
            # Strip the "files/" prefix and reject any path that tries to escape.
            rel = member.name[len("files/"):]
            if not rel or rel.startswith("/") or ".." in rel.split("/"):
                continue
            dest = os.path.join(files_root, rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            src = tar.extractfile(member)
            if src is None:
                continue
            with open(dest, "wb") as out:
                while True:
                    chunk = src.read(64 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
            file_count += 1

        # Invalidate any cached in-memory engine for the new domain
        with _engine_lock:
            _engines.pop(target_domain, None)
            _hydrated_domains.discard(target_domain)

        return {
            "ok": True,
            "domain": target_domain,
            "source_domain": manifest["domain"],
            "doc_count": doc_count,
            "alias_count": alias_count,
            "file_count": file_count,
            "graph_entity_count": graph_entity_count,
            "graph_mention_count": graph_mention_count,
            "graph_edge_count": graph_edge_count,
        }
    finally:
        try:
            tar.close()
        except Exception:
            pass


def _get_domain_description(domain: str) -> str:
    """Return description stored in the domain's seed doc, or empty string."""
    seed_doc_id = f"_ob2_domain_{domain}"
    doc = _backend.get_doc(domain, seed_doc_id)
    if doc and isinstance(doc.metadata, dict):
        return doc.metadata.get("description") or ""
    return ""


def method_create_domain(params: dict) -> dict:
    """Create a domain by upserting a hidden seed doc with system metadata.

    Uses a deterministic doc_id so calling again with the same domain is
    idempotent (it just overwrites the seed doc).
    """
    domain = params["domain"]
    description = params.get("description") or ""

    if not re.match(r'^[a-z0-9-]+$', domain) or len(domain) > 64:
        return {"ok": False, "error": f"invalid domain name: {domain!r}"}

    seed_doc_id = f"_ob2_domain_{domain}"
    if _backend.get_doc(domain, seed_doc_id) is not None:
        return {"ok": False, "error": "already_exists", "domain": domain}
    text = description or f"Domain: {domain}"
    vec = embed(text)

    _backend.upsert_doc(
        domain=domain,
        doc_id=seed_doc_id,
        text=text,
        embedding=vec,
        metadata={"_ob2_system": True, "_ob2_type": "domain_init", "description": description},
        source_hash="",
    )
    with _engine_lock:
        _engines.pop(domain, None)
        _hydrated_domains.discard(domain)

    return {"ok": True, "domain": domain}


def method_list_docs(params: dict) -> dict:
    """List user docs in a domain (excludes system seed docs), newest first.

    Fetches up to 10 000 docs from the backend and filters _ob2_system entries
    in Python — fine for admin UI use where domains rarely exceed hundreds of docs.
    """
    domain = params["domain"]
    limit = int(params.get("limit", 100))
    offset = int(params.get("offset", 0))

    all_docs = _backend.list_docs(domain, limit=10_000)
    user_docs = [
        d for d in all_docs
        if not (isinstance(d.metadata, dict) and d.metadata.get("_ob2_system"))
    ]
    page = user_docs[offset:offset + limit]

    return {
        "docs": [
            {"doc_id": d.doc_id, "text": d.text, "metadata": d.metadata}
            for d in page
        ],
        "total": len(user_docs),
    }


def method_set_domain_description(params: dict) -> dict:
    """Update (or create) the description stored in a domain's seed doc."""
    domain = params["domain"]
    description = params.get("description") or ""

    seed_doc_id = f"_ob2_domain_{domain}"
    text = description or f"Domain: {domain}"
    vec = embed(text)

    _backend.upsert_doc(
        domain=domain,
        doc_id=seed_doc_id,
        text=text,
        embedding=vec,
        metadata={"_ob2_system": True, "_ob2_type": "domain_init", "description": description},
        source_hash="",
    )
    with _engine_lock:
        _engines.pop(domain, None)
        _hydrated_domains.discard(domain)
    return {"ok": True, "domain": domain, "description": description}


def method_has_source(params: dict) -> dict:
    return {
        "exists": _backend.has_source(
            params["domain"], params["source_id"], params["content_hash"],
        ),
    }


def method_record_source(params: dict) -> dict:
    _backend.record_source_import(
        params["domain"], params["source_id"],
        params["content_hash"], int(params.get("chunks_produced", 0)),
    )
    return {"ok": True}


def method_upsert_alias(params: dict) -> dict:
    _backend.upsert_alias(params["domain"], params["alias"], params["canonical"])
    return {"ok": True}


def method_resolve_alias(params: dict) -> dict:
    return {"canonical": _backend.resolve_alias(params["domain"], params["alias"])}


def method_list_aliases(params: dict) -> dict:
    domain = params["domain"]
    return {"aliases": [{"alias": a, "canonical": c} for a, c in _backend.list_aliases(domain)]}


def method_batcher_stats(_params: dict) -> dict:
    """Return auto-batcher stats for the admin dashboard."""
    if _batcher is None:
        return {"available": False}
    s = _batcher.stats()
    return {"available": True, **s}


# Rolling window of recent classifier decisions (for admin metrics).
import collections as _collections

_classifier_decisions: _collections.deque = _collections.deque(maxlen=100)
_classifier_counts = {"routed": 0, "passed": 0, "denied": 0}


def method_record_classifier_decision(params: dict) -> dict:
    """Store a classifier decision for later aggregation."""
    from datetime import datetime, timezone
    outcome = params.get("outcome", "passed")  # routed | passed | denied
    _classifier_decisions.append({
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "query": (params.get("query") or "")[:120],
        "domain": params.get("domain"),
        "confidence": params.get("confidence"),
        "outcome": outcome,
    })
    if outcome in _classifier_counts:
        _classifier_counts[outcome] += 1
    return {"ok": True}


def method_classifier_stats(_params: dict) -> dict:
    return {
        "counts": dict(_classifier_counts),
        "recent": list(_classifier_decisions),
    }


def method_test_pgvector(params: dict) -> dict:
    """Attempt a short connection to a pgvector URL. Returns reachable + error."""
    import time
    url = params.get("url") or os.environ.get("OB2_PG_URL", "")
    if not url:
        return {"reachable": False, "error": "no URL provided"}
    try:
        import psycopg
        t0 = time.perf_counter()
        with psycopg.connect(url, connect_timeout=5) as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT extversion FROM pg_extension WHERE extname = 'vector'")
                row = cur.fetchone()
                vec_version = row[0] if row else None
                cur.execute("SELECT COUNT(*) FROM docs")
                doc_count = cur.fetchone()[0]
        latency_ms = (time.perf_counter() - t0) * 1000
        return {
            "reachable": True,
            "latency_ms": round(latency_ms, 1),
            "pgvector_version": vec_version,
            "doc_count": int(doc_count),
        }
    except Exception as e:
        return {"reachable": False, "error": str(e)[:200]}


def method_suggest_domains(params: dict) -> dict:
    """Scan `text` against all domain alias tables; return domains whose
    aliases appear in text. Case-insensitive whole-word match.

    Used by gateway to softly suggest `@domain` prefixes when the user
    didn't specify one.
    """
    text = params.get("text", "") or ""
    if not text:
        return {"suggestions": []}
    text_lower = text.lower()
    suggestions: list[dict] = []
    for domain in _backend.list_domains():
        aliases = _backend.list_aliases(domain)
        matched: list[str] = []
        for alias, _canonical in aliases:
            alias_lower = alias.lower()
            # Whole-word match, boundary-aware
            if re.search(rf"\b{re.escape(alias_lower)}\b", text_lower):
                matched.append(alias)
        if matched:
            suggestions.append({"domain": domain, "matched_aliases": matched})
    return {"suggestions": suggestions}


# ─────────────────────────────────────────────────────────────
# Lightweight Graph RAG — entity extraction + graph-aware retrieval
# Spec: docs/superpowers/specs/2026-04-25-graph-rag-design.md (TBD)
# ─────────────────────────────────────────────────────────────

VALID_ENTITY_TYPES = {"PERSON", "ORG", "PLACE", "PRODUCT", "EVENT", "CONCEPT", "OTHER"}
RUNTIME_CONFIG_PATH = os.environ.get("OB2_RUNTIME_CONFIG_PATH", "/data/config.yaml")
OLLAMA_URL = os.environ.get("OB2_OLLAMA_URL", "http://localhost:11434")

_graph_cfg_cache: dict[str, Any] = {}
_graph_cfg_mtime: float = 0.0
_graph_cfg_lock = threading.Lock()


def _read_graph_config() -> dict[str, Any]:
    """Read graph config from /data/config.yaml. Mtime-cached for cheap repeat reads.

    Returns a dict with keys enabled, extraction_enabled, extraction_model,
    rerank_alpha. Falls back to defaults if file missing or parse fails.
    """
    global _graph_cfg_mtime, _graph_cfg_cache
    def _env(name: str, default: str = "") -> str:
        # os.environ.get returns "" for vars set to empty (compose default
        # `${X:-}` exports them as empty), which we treat as "unset" so the
        # caller's `default` wins.
        v = os.environ.get(name, default)
        return v if v not in (None, "") else default

    defaults = {
        "enabled": _env("OB2_GRAPH_ENABLED", "false").lower() in ("true", "1"),
        "extraction_enabled": _env("OB2_GRAPH_EXTRACTION_ENABLED", "false").lower() in ("true", "1"),
        "extraction_model": _env("OB2_GRAPH_EXTRACTION_MODEL", ""),
        "rerank_alpha": float(_env("OB2_GRAPH_RERANK_ALPHA", "0.3")),
        "ollama_model": _env("OB2_OLLAMA_MODEL", ""),
    }
    try:
        st = os.stat(RUNTIME_CONFIG_PATH)
    except OSError:
        return defaults
    with _graph_cfg_lock:
        if st.st_mtime <= _graph_cfg_mtime and _graph_cfg_cache:
            return _graph_cfg_cache
        try:
            import yaml  # PyYAML is in the sidecar venv via markitdown deps
            with open(RUNTIME_CONFIG_PATH) as f:
                data = yaml.safe_load(f) or {}
            graph = data.get("graph", {}) or {}
            ollama = data.get("ollama", {}) or {}
            cfg = {
                "enabled": bool(graph.get("enabled", defaults["enabled"])),
                "extraction_enabled": bool(graph.get("extraction_enabled", defaults["extraction_enabled"])),
                "extraction_model": str(graph.get("extraction_model") or defaults["extraction_model"]),
                "rerank_alpha": float(graph.get("rerank_alpha", defaults["rerank_alpha"])),
                "ollama_model": str(ollama.get("model") or defaults["ollama_model"]),
            }
            # Env vars win over file (mirrors runtime_config.ts precedence).
            for k, env in [
                ("enabled", "OB2_GRAPH_ENABLED"),
                ("extraction_enabled", "OB2_GRAPH_EXTRACTION_ENABLED"),
            ]:
                v = os.environ.get(env, "").strip()
                if v:
                    cfg[k] = v.lower() in ("true", "1")
            for k, env in [("extraction_model", "OB2_GRAPH_EXTRACTION_MODEL"), ("ollama_model", "OB2_OLLAMA_MODEL")]:
                v = os.environ.get(env, "").strip()
                if v:
                    cfg[k] = v
            v = os.environ.get("OB2_GRAPH_RERANK_ALPHA", "").strip()
            if v:
                try:
                    cfg["rerank_alpha"] = float(v)
                except ValueError:
                    pass
            _graph_cfg_mtime = st.st_mtime
            _graph_cfg_cache = cfg
            return cfg
        except Exception as e:
            log(f"graph: config read failed: {e}")
            return defaults


def _normalize_entity_name(s: str) -> str:
    """NFKC + collapse whitespace + strip surrounding punctuation. Idempotent."""
    s = unicodedata.normalize("NFKC", s).strip()
    s = re.sub(r"\s+", " ", s)
    s = s.strip(" .,:;-_'\"`()[]{}")
    return s


def _entity_id(domain: str, type_: str, name: str) -> str:
    """Stable id = sha1(domain|type|lower(name))[:16]. Deterministic across runs/installs."""
    h = hashlib.sha1(f"{domain}|{type_}|{name.lower()}".encode("utf-8")).hexdigest()
    return h[:16]


_GRAPH_PROMPT = """\
Extract named entities and relationships from the text below. Output ONLY valid JSON
matching this exact shape; no prose, no markdown fences, no comments.

{
  "entities": [
    {"name": "<canonical form>", "type": "PERSON" | "ORG" | "PLACE" | "PRODUCT" | "EVENT" | "CONCEPT" | "OTHER"}
  ],
  "relationships": [
    {"src": "<entity name>", "dst": "<entity name>", "relation": "<short snake_case>"}
  ]
}

Rules:
- Use ONLY the 7 types listed. Default to CONCEPT when unsure.
- Skip pronouns, generic nouns ("the company", "they"), bare dates, numbers.
- "src" and "dst" must each appear in your "entities" array.
- Empty arrays are fine for short or topical text.

TEXT:
{text}
"""


def _ollama_extract(model: str, text: str, timeout: float = 60.0) -> dict[str, Any]:
    """Call Ollama /api/chat with format=json and return parsed JSON. Raises on failure."""
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": _GRAPH_PROMPT.replace("{text}", text)}],
        "stream": False,
        "format": "json",
        "keep_alive": os.environ.get("OB2_OLLAMA_KEEP_ALIVE", "24h"),
        "options": {"temperature": 0, "num_predict": 1024},
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{OLLAMA_URL.rstrip('/')}/api/chat",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8")
    obj = json.loads(raw)
    content = obj.get("message", {}).get("content") or ""
    # Ollama in JSON mode returns valid JSON in `content`, but be defensive.
    return json.loads(content)


def method_extract_entities(params: dict) -> dict:
    """Extract entities + relationships from a doc, persist into the graph tables.

    Params: {domain, doc_id, text, model?}.
    Returns counts. Idempotent — re-running on the same doc_id replaces its mentions.
    """
    domain = params["domain"]
    doc_id = params["doc_id"]
    text = (params.get("text") or "").strip()
    if not text:
        return {"ok": True, "domain": domain, "doc_id": doc_id, "entity_count": 0,
                "edge_count": 0, "skipped": "empty_text"}

    cfg = _read_graph_config()
    model = (params.get("model") or cfg.get("extraction_model") or cfg.get("ollama_model") or "").strip()
    if not model:
        return {"ok": False, "error": "no_model_configured"}

    # Wipe stale mentions first so re-extraction is idempotent.
    _backend.delete_doc_graph(domain, doc_id)

    try:
        result = _ollama_extract(model, text)
    except Exception as e:
        log(f"graph: extraction failed for {domain}/{doc_id}: {type(e).__name__}: {e}")
        return {"ok": False, "error": "extraction_failed", "detail": str(e)}

    raw_entities = result.get("entities") or []
    raw_rels = result.get("relationships") or []

    # Resolve through aliases first; then dedup by (type, normalized name).
    name_to_eid: dict[str, str] = {}
    entity_count = 0
    for e in raw_entities:
        if not isinstance(e, dict):
            continue
        name = _normalize_entity_name(str(e.get("name") or ""))
        typ = str(e.get("type") or "").upper()
        if not name or typ not in VALID_ENTITY_TYPES:
            continue
        canonical = _backend.resolve_alias(domain, name) or name
        canonical = _normalize_entity_name(canonical)
        eid = _entity_id(domain, typ, canonical)
        _backend.upsert_entity(domain, eid, canonical, typ, increment_mentions=True)
        _backend.upsert_mention(domain, doc_id, eid, confidence=1.0)
        name_to_eid[name.lower()] = eid
        # Also map under the canonical so relationships can resolve either form.
        name_to_eid[canonical.lower()] = eid
        entity_count += 1

    edge_count = 0
    for r in raw_rels:
        if not isinstance(r, dict):
            continue
        src_name = _normalize_entity_name(str(r.get("src") or ""))
        dst_name = _normalize_entity_name(str(r.get("dst") or ""))
        relation = str(r.get("relation") or "").strip().lower().replace(" ", "_")[:64]
        if not src_name or not dst_name or not relation:
            continue
        src_eid = name_to_eid.get(src_name.lower())
        dst_eid = name_to_eid.get(dst_name.lower())
        if not src_eid or not dst_eid or src_eid == dst_eid:
            continue
        # Normalize edge direction so undirected pairs collapse to one row.
        if src_eid > dst_eid:
            src_eid, dst_eid = dst_eid, src_eid
        _backend.upsert_edge(domain, src_eid, dst_eid, relation, evidence_doc_id=doc_id)
        edge_count += 1

    # Stamp the doc so backfill knows it's done. Read current metadata first
    # to preserve other _ob2_* fields.
    try:
        existing = _backend.get_doc(domain, doc_id)
        if existing is not None:
            md = dict(existing.metadata or {})
            md["_ob2_graph_extracted_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
            md["_ob2_graph_extraction_model"] = model
            _backend.upsert_doc(
                domain=domain,
                doc_id=doc_id,
                text=existing.text,
                embedding=existing.embedding,
                metadata=md,
                source_hash=existing.source_hash or "",
            )
    except Exception as e:
        log(f"graph: failed to stamp extracted_at on {doc_id}: {e}")

    return {
        "ok": True,
        "domain": domain,
        "doc_id": doc_id,
        "entity_count": entity_count,
        "edge_count": edge_count,
        "model": model,
    }


# ── Async extraction worker ─────────────────────────────────────

_extract_queue: "queue.Queue[tuple[str, str, str]]" = queue.Queue()
_extract_worker_started = False
_extract_worker_lock = threading.Lock()


def _extract_worker_loop() -> None:
    log("graph: extraction worker started")
    while True:
        try:
            domain, doc_id, text = _extract_queue.get()
            try:
                method_extract_entities({"domain": domain, "doc_id": doc_id, "text": text})
            except Exception as e:
                log(f"graph: worker error on {domain}/{doc_id}: {e}")
            finally:
                _extract_queue.task_done()
        except Exception:
            log(traceback.format_exc())
            time.sleep(1.0)


def _ensure_extract_worker() -> None:
    global _extract_worker_started
    with _extract_worker_lock:
        if _extract_worker_started:
            return
        t = threading.Thread(target=_extract_worker_loop, name="graph-extract", daemon=True)
        t.start()
        _extract_worker_started = True


def _enqueue_extraction_if_enabled(domain: str, doc_id: str, text: str) -> None:
    """Push a doc onto the extraction queue iff graph.extraction_enabled is true.

    Reads runtime config on every call (mtime-cached) so dashboard toggles
    take effect immediately without restart.
    """
    cfg = _read_graph_config()
    if not cfg.get("extraction_enabled"):
        return
    _ensure_extract_worker()
    try:
        _extract_queue.put_nowait((domain, doc_id, text))
    except queue.Full:
        log(f"graph: queue full, dropping {domain}/{doc_id}")


def method_graph_stats(params: dict) -> dict:
    return _backend.graph_stats(params["domain"])


def method_list_entities(params: dict) -> dict:
    domain = params["domain"]
    rows = _backend.list_entities(
        domain,
        limit=int(params.get("limit", 200)),
        offset=int(params.get("offset", 0)),
        type_filter=params.get("type"),
        q=params.get("q"),
    )
    return {
        "entities": [
            {
                "entity_id": r.entity_id, "name": r.name, "type": r.type,
                "mention_count": r.mention_count,
                "first_seen": r.first_seen, "last_seen": r.last_seen,
            }
            for r in rows
        ],
    }


def method_list_edges(params: dict) -> dict:
    domain = params["domain"]
    rows = _backend.list_edges(
        domain, src_id=params.get("src_id"), limit=int(params.get("limit", 10000)),
    )
    return {
        "edges": [
            {
                "src_id": r.src_id, "dst_id": r.dst_id, "relation": r.relation,
                "weight": r.weight, "evidence_doc_id": r.evidence_doc_id,
            }
            for r in rows
        ],
    }


def method_docs_for_entity(params: dict) -> dict:
    domain = params["domain"]
    entity_id = params["entity_id"]
    doc_ids = _backend.docs_for_entity(domain, entity_id, limit=int(params.get("limit", 50)))
    if not doc_ids:
        return {"docs": []}
    out = []
    for did in doc_ids:
        d = _backend.get_doc(domain, did)
        if not d:
            continue
        snippet = (d.text or "")[:280]
        out.append({
            "doc_id": did,
            "snippet": snippet,
            "metadata": d.metadata or {},
            "created_at": d.created_at or "",
        })
    return {"docs": out}


def method_list_entities_multi(params: dict) -> dict:
    domains = params.get("domains") or []
    if not isinstance(domains, list) or not domains:
        return {"entities": []}
    rows = _backend.list_entities_multi(
        domains,
        name_substr=params.get("name_substr"),
        limit=int(params.get("limit", 500)),
    )
    # Group by (lower(name), type) so the dashboard can find entities that
    # appear in ≥2 domains.
    bucket: dict[tuple[str, str], list[dict]] = {}
    for r in rows:
        key = (r.name.lower(), r.type)
        bucket.setdefault(key, []).append({
            "entity_id": r.entity_id,
            "domain": r.domain,
            "name": r.name,
            "type": r.type,
            "mention_count": r.mention_count,
        })
    overlap = []
    for (lname, typ), members in bucket.items():
        if len(members) < 2:
            continue
        overlap.append({
            "name": members[0]["name"],
            "type": typ,
            "domains": members,
        })
    overlap.sort(key=lambda o: -sum(m["mention_count"] for m in o["domains"]))
    return {"overlap": overlap}


# ── Backfill jobs (sidecar-managed) ─────────────────────────────

_backfill_jobs: dict[str, dict] = {}
_backfill_lock = threading.Lock()


def _backfill_run(job_id: str, domain: str) -> None:
    job = _backfill_jobs[job_id]
    try:
        # Pull every user doc (skip system seeds) that hasn't been extracted yet.
        all_docs = _backend.list_docs(domain, limit=1_000_000)
        targets = [
            d for d in all_docs
            if not (isinstance(d.metadata, dict) and d.metadata.get("_ob2_system"))
        ]
        # Already-extracted docs can be retried — we'll re-run extraction for everything
        # to keep the API simple (delete_doc_graph runs first inside method_extract_entities).
        job["total_docs"] = len(targets)
        job["status"] = "running"
        job["message"] = f"extracting {len(targets)} docs"
        for i, d in enumerate(targets):
            if job.get("_cancel"):
                job["status"] = "canceled"
                job["message"] = "canceled"
                return
            try:
                method_extract_entities({"domain": domain, "doc_id": d.doc_id, "text": d.text or ""})
            except Exception as e:
                log(f"graph: backfill error on {d.doc_id}: {e}")
            job["completed_docs"] = i + 1
            if job["total_docs"]:
                job["percent"] = int((i + 1) / job["total_docs"] * 100)
            job["message"] = f"extracted {i + 1}/{job['total_docs']}"
        job["status"] = "done"
        job["message"] = "done"
        job["percent"] = 100
    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)
        job["message"] = "failed"
    finally:
        job["finished_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")


def method_graph_backfill_start(params: dict) -> dict:
    domain = params["domain"]
    # If a backfill for this domain is already running, return that one.
    with _backfill_lock:
        for j in _backfill_jobs.values():
            if j["domain"] == domain and j["status"] in ("pending", "running"):
                return j
        job_id = f"bf-{int(time.time() * 1000):x}-{os.urandom(3).hex()}"
        job = {
            "id": job_id,
            "domain": domain,
            "status": "pending",
            "message": "queued",
            "total_docs": 0,
            "completed_docs": 0,
            "percent": 0,
            "started_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "finished_at": None,
            "error": None,
            "_cancel": False,
        }
        _backfill_jobs[job_id] = job
    threading.Thread(target=_backfill_run, args=(job_id, domain), name=f"backfill-{job_id}", daemon=True).start()
    return {k: v for k, v in job.items() if not k.startswith("_")}


def method_graph_backfill_status(params: dict) -> dict:
    job = _backfill_jobs.get(params["job_id"])
    if not job:
        return {"ok": False, "error": "not_found"}
    return {k: v for k, v in job.items() if not k.startswith("_")}


def method_graph_backfill_cancel(params: dict) -> dict:
    job = _backfill_jobs.get(params["job_id"])
    if not job:
        return {"ok": False, "error": "not_found"}
    if job["status"] not in ("pending", "running"):
        return {"ok": False, "error": "not_running"}
    job["_cancel"] = True
    return {"ok": True}


def method_graph_backfill_list(_params: dict) -> dict:
    return {"jobs": [{k: v for k, v in j.items() if not k.startswith("_")} for j in _backfill_jobs.values()]}


METHODS: dict[str, Callable[[dict], Any]] = {
    "ping": method_ping,
    "capture": method_capture,
    "capture_batch": method_capture_batch,
    "retrieve": method_retrieve,
    "build_context": method_build_context,
    "build_multi_context": method_build_multi_context,
    "convert_to_markdown": method_convert_to_markdown,
    "knowledge_stats": method_knowledge_stats,
    "list_domains": method_list_domains,
    "delete": method_delete,
    "delete_domain": method_delete_domain,
    "export_domain": method_export_domain,
    "import_domain": method_import_domain,
    "create_domain": method_create_domain,
    "list_docs": method_list_docs,
    "set_domain_description": method_set_domain_description,
    "has_source": method_has_source,
    "record_source": method_record_source,
    "upsert_alias": method_upsert_alias,
    "resolve_alias": method_resolve_alias,
    "list_aliases": method_list_aliases,
    "suggest_domains": method_suggest_domains,
    "extract_entities": method_extract_entities,
    "graph_stats": method_graph_stats,
    "list_entities": method_list_entities,
    "list_edges": method_list_edges,
    "docs_for_entity": method_docs_for_entity,
    "list_entities_multi": method_list_entities_multi,
    "graph_backfill_start": method_graph_backfill_start,
    "graph_backfill_status": method_graph_backfill_status,
    "graph_backfill_cancel": method_graph_backfill_cancel,
    "graph_backfill_list": method_graph_backfill_list,
    "batcher_stats": method_batcher_stats,
    "record_classifier_decision": method_record_classifier_decision,
    "classifier_stats": method_classifier_stats,
    "test_pgvector": method_test_pgvector,
    "sync_status": lambda _: (
        _backend.sync_status
        if hasattr(_backend, "sync_status")
        else {"error": "not in two-tier mode"}
    ),
}


# ─────────────────────────────────────────────────────────────
# JSON-RPC loop
# ─────────────────────────────────────────────────────────────

def write_response(id_: Any, result: Any = None, error: dict | None = None) -> None:
    msg: dict[str, Any] = {"jsonrpc": "2.0", "id": id_}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def handle_line(line: str) -> None:
    try:
        req = json.loads(line)
    except json.JSONDecodeError as e:
        log(f"parse error: {e}")
        return

    id_ = req.get("id")
    method = req.get("method")
    params = req.get("params") or {}

    if not isinstance(method, str) or method not in METHODS:
        write_response(
            id_,
            error={"code": -32601, "message": f"method not found: {method}"},
        )
        return

    try:
        result = METHODS[method](params)
        write_response(id_, result=result)
    except KeyError as e:
        log(f"missing param in {method}: {e}")
        write_response(
            id_,
            error={"code": -32602, "message": f"missing param: {e}"},
        )
    except Exception as e:
        log(f"error in {method}: {e}\n{traceback.format_exc()}")
        write_response(
            id_,
            error={"code": -32603, "message": str(e)},
        )


def main() -> None:
    log(
        f"ob2-retrieval sidecar started "
        f"(backend={STORAGE_BACKEND}, dim={EMBEDDING_DIM}, "
        f"embedder={'sentence-transformers' if _EMBEDDER_AVAILABLE else 'random-fallback'}, "
        f"budget={DEFAULT_TOKEN_BUDGET}, top_k={DEFAULT_TOP_K}, alpha={DEFAULT_ALPHA})"
    )
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        handle_line(line)
    log("ob2-retrieval sidecar exiting")
    try:
        if _batcher is not None:
            _batcher.shutdown()
    except Exception:
        pass
    try:
        _backend.close()
    except Exception:
        pass


if __name__ == "__main__":
    main()
