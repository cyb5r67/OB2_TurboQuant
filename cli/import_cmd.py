"""ob2 import — bulk importers for CSV, markdown docs, wiki exports, and PDF.

Subcommands:
    csv     CSV/TSV → one doc per row, schema.yml maps columns to text/tags
    docs    Directory of .md files → chunked by heading

Design:
- Importers open the storage backend directly (no running OB2 server needed).
- Batch 256 chunks at a time; embed with sentence-transformers (CUDA if available).
- Source-hash dedup: skip chunks whose content_hash is already recorded.
- Resumable: interrupt at any time; re-run skips completed files.
- Transactional: each batch either fully commits or fully rolls back.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import os
import sys
import time
from pathlib import Path
from typing import TYPE_CHECKING, Iterable

if TYPE_CHECKING:
    from retrieval.storage.backend import StorageBackend

from cli.chunker import Chunk, markdown_chunks, paragraph_chunks, sha256_hex


# ─────────────────────────────────────────────────────────────
# Shared pipeline — chunks → embeddings → backend
# ─────────────────────────────────────────────────────────────

def _load_backend(embedding_dim: int) -> "StorageBackend":
    backend_name = os.environ.get("OB2_STORAGE_BACKEND", "two-tier")
    if backend_name == "two-tier":
        pg_url = os.environ.get("OB2_PG_URL", "")
        if not pg_url:
            raise SystemExit("OB2_STORAGE_BACKEND=two-tier requires OB2_PG_URL")
        from retrieval.storage.two_tier import TwoTierBackend
        return TwoTierBackend(
            sqlite_path=os.environ.get("OB2_SQLITE_PATH", "./ob2.db"),
            pg_url=pg_url,
            embedding_dim=embedding_dim,
            sync_interval_sec=float(os.environ.get("OB2_SYNC_INTERVAL_SEC", "2")),
            sync_batch_size=int(os.environ.get("OB2_SYNC_BATCH_SIZE", "256")),
        )
    if backend_name == "sqlite":
        from retrieval.storage.sqlite_vec import SQLiteVecBackend
        return SQLiteVecBackend(
            os.environ.get("OB2_SQLITE_PATH", "./ob2.db"),
            embedding_dim=embedding_dim,
        )
    if backend_name == "pgvector":
        from retrieval.storage.pg_vector import PgVectorBackend
        pg_url = os.environ.get("OB2_PG_URL", "")
        if not pg_url:
            raise SystemExit("OB2_STORAGE_BACKEND=pgvector requires OB2_PG_URL")
        return PgVectorBackend(pg_url, embedding_dim=embedding_dim)
    raise SystemExit(f"unknown OB2_STORAGE_BACKEND: {backend_name!r}")


def _load_embedder() -> tuple[object, int]:
    """Returns (model, dim). Always embeds on CUDA if available."""
    from sentence_transformers import SentenceTransformer
    name = os.environ.get("OB2_EMBEDDING_MODEL", "all-MiniLM-L6-v2")
    m = SentenceTransformer(name)
    dim = m.get_sentence_embedding_dimension()
    print(f"  embedder: {name} on {m.device} (dim={dim})", file=sys.stderr)
    return m, dim


def embed_and_upsert(
    backend: "StorageBackend",
    domain: str,
    chunks: list[Chunk],
    model: object,
    batch_size: int,
) -> int:
    """Embed chunks in batches and bulk-upsert. Returns count written."""
    if not chunks:
        return 0
    from retrieval.storage.backend import DocRecord
    import numpy as np

    written = 0
    for i in range(0, len(chunks), batch_size):
        batch = chunks[i:i + batch_size]
        texts = [c.text for c in batch]
        vecs = model.encode(texts, convert_to_numpy=True, batch_size=64, show_progress_bar=False)
        vecs = vecs.astype(np.float32)

        records = [
            DocRecord(
                doc_id=c.doc_id,
                domain=domain,
                text=c.text,
                embedding=vecs[j],
                metadata={"source": "import", "tags": c.tags},
                source_hash=c.source_hash,
            )
            for j, c in enumerate(batch)
        ]
        backend.upsert_docs_batch(domain, records)
        written += len(records)
    return written


# ─────────────────────────────────────────────────────────────
# Subcommand: csv
# ─────────────────────────────────────────────────────────────

def cmd_csv(args: argparse.Namespace) -> int:
    import yaml

    file_path = Path(args.file)
    if not file_path.is_file():
        print(f"ERROR: file not found: {file_path}", file=sys.stderr)
        return 2

    schema: dict = {}
    if args.schema:
        schema_path = Path(args.schema)
        if not schema_path.is_file():
            print(f"ERROR: schema not found: {schema_path}", file=sys.stderr)
            return 2
        with open(schema_path) as fh:
            schema = yaml.safe_load(fh) or {}

    doc_id_col = schema.get("doc_id_column")
    text_template: str | None = schema.get("text_template")
    tags_cols: list[str] = list(schema.get("tags_columns") or [])
    source_name = schema.get("source_name", file_path.name)

    model, dim = _load_embedder()
    backend = _load_backend(dim)

    t0 = time.time()
    total_rows = 0
    total_skipped = 0
    chunks_buf: list[Chunk] = []
    total_written = 0

    try:
        with open(file_path, newline="", encoding="utf-8") as fh:
            delim = "\t" if file_path.suffix == ".tsv" else ","
            reader = csv.DictReader(fh, delimiter=delim)
            for row_idx, row in enumerate(reader):
                total_rows += 1

                # Derive doc_id
                if doc_id_col and row.get(doc_id_col):
                    doc_id = f"{source_name}#{row[doc_id_col]}"
                else:
                    doc_id = f"{source_name}#row-{row_idx}"

                # Build text
                if text_template:
                    try:
                        text = text_template.format(**{k: v or "" for k, v in row.items()})
                    except KeyError as e:
                        print(f"WARN row {row_idx}: template key {e} not in row, skipping", file=sys.stderr)
                        total_skipped += 1
                        continue
                else:
                    # Fallback: render as key: value lines
                    text = "\n".join(f"{k}: {v}" for k, v in row.items() if v)
                if not text.strip():
                    total_skipped += 1
                    continue

                # Tags from columns
                tags = [str(row[c]) for c in tags_cols if c in row and row[c]]

                source_hash = sha256_hex(text)

                # Skip if already imported with same hash
                if backend.has_source(args.domain, doc_id, source_hash):
                    total_skipped += 1
                    continue

                chunks_buf.append(Chunk(
                    doc_id=doc_id, text=text, tags=tags, source_hash=source_hash,
                ))

                # Flush when buffer hits batch size
                if len(chunks_buf) >= args.batch_size:
                    n = embed_and_upsert(backend, args.domain, chunks_buf, model, args.batch_size)
                    for c in chunks_buf:
                        backend.record_source_import(args.domain, c.doc_id, c.source_hash, 1)
                    total_written += n
                    print(f"  written {total_written}/{total_rows} rows...", file=sys.stderr)
                    chunks_buf = []

        # Flush tail
        if chunks_buf:
            n = embed_and_upsert(backend, args.domain, chunks_buf, model, args.batch_size)
            for c in chunks_buf:
                backend.record_source_import(args.domain, c.doc_id, c.source_hash, 1)
            total_written += n
    finally:
        backend.close()

    dt = time.time() - t0
    rate = total_written / max(dt, 0.001)
    print(f"\nDone: {total_rows} rows read, {total_written} written, "
          f"{total_skipped} skipped in {dt:.1f}s ({rate:.0f} docs/sec)",
          file=sys.stderr)
    return 0


# ─────────────────────────────────────────────────────────────
# Subcommand: docs (markdown)
# ─────────────────────────────────────────────────────────────

def _iter_markdown(root: Path, recursive: bool) -> Iterable[Path]:
    if root.is_file():
        yield root
        return
    pattern = "**/*.md" if recursive else "*.md"
    for p in sorted(root.glob(pattern)):
        if p.is_file():
            yield p


def _content_hash(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(65536), b""):
            h.update(block)
    return h.hexdigest()


def cmd_docs(args: argparse.Namespace) -> int:
    root = Path(args.dir)
    if not root.exists():
        print(f"ERROR: path not found: {root}", file=sys.stderr)
        return 2

    model, dim = _load_embedder()
    backend = _load_backend(dim)

    t0 = time.time()
    total_files = 0
    total_files_skipped = 0
    total_chunks = 0
    total_written = 0

    try:
        for path in _iter_markdown(root, args.recursive):
            total_files += 1
            source_id = str(path.relative_to(root) if root.is_dir() else path.name)
            file_hash = _content_hash(path)

            # Whole-file dedup: if we've seen this (path, hash) before, skip
            if backend.has_source(args.domain, source_id, file_hash):
                total_files_skipped += 1
                continue

            text = path.read_text(encoding="utf-8", errors="replace")
            chunks = markdown_chunks(text, source_id=source_id, tags=args.tags or [])
            if not chunks:
                continue

            n = embed_and_upsert(backend, args.domain, chunks, model, args.batch_size)
            backend.record_source_import(args.domain, source_id, file_hash, len(chunks))
            total_chunks += len(chunks)
            total_written += n
            print(f"  {source_id}: {len(chunks)} chunks", file=sys.stderr)
    finally:
        backend.close()

    dt = time.time() - t0
    rate = total_written / max(dt, 0.001)
    print(f"\nDone: {total_files} files ({total_files_skipped} skipped unchanged), "
          f"{total_written} chunks written in {dt:.1f}s ({rate:.0f} chunks/sec)",
          file=sys.stderr)
    return 0


# ─────────────────────────────────────────────────────────────
# CLI wiring
# ─────────────────────────────────────────────────────────────

# ─────────────────────────────────────────────────────────────
# Subcommand: pdf
# ─────────────────────────────────────────────────────────────

def cmd_pdf(args: argparse.Namespace) -> int:
    import fitz  # pymupdf

    file_path = Path(args.file)
    if not file_path.is_file():
        print(f"ERROR: file not found: {file_path}", file=sys.stderr)
        return 2

    model, dim = _load_embedder()
    backend = _load_backend(dim)

    t0 = time.time()
    source_id = file_path.name
    file_hash = hashlib.sha256(file_path.read_bytes()).hexdigest()

    try:
        if backend.has_source(args.domain, source_id, file_hash):
            print(f"Skipped (unchanged): {source_id}", file=sys.stderr)
            return 0

        doc = fitz.open(str(file_path))
        chunks: list[Chunk] = []
        for page_num in range(len(doc)):
            page = doc[page_num]
            text = page.get_text("text").strip()
            if not text:
                continue
            chunks.append(Chunk(
                doc_id=f"{source_id}#page-{page_num + 1}",
                text=text,
                tags=list(args.tags or []),
                source_hash=sha256_hex(text),
            ))
        doc.close()

        if not chunks:
            print(f"No text extracted from {file_path}", file=sys.stderr)
            return 0

        n = embed_and_upsert(backend, args.domain, chunks, model, args.batch_size)
        backend.record_source_import(args.domain, source_id, file_hash, len(chunks))
    finally:
        backend.close()

    dt = time.time() - t0
    print(f"\nDone: {len(chunks)} pages, {n} chunks written in {dt:.1f}s", file=sys.stderr)
    return 0


# ─────────────────────────────────────────────────────────────
# Subcommand: wiki (Confluence HTML export / Notion markdown export)
# ─────────────────────────────────────────────────────────────

def _extract_confluence_html(html: str) -> str:
    """Extract readable text from Confluence HTML export page."""
    import re
    # Strip tags, decode entities
    text = re.sub(r"<script[^>]*>.*?</script>", "", html, flags=re.DOTALL)
    text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.DOTALL)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"&nbsp;", " ", text)
    text = re.sub(r"&amp;", "&", text)
    text = re.sub(r"&lt;", "<", text)
    text = re.sub(r"&gt;", ">", text)
    text = re.sub(r"&#\d+;", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def _iter_wiki_files(
    export_path: Path, source_type: str,
) -> Iterable[tuple[str, str]]:
    """Yield (relative_name, text_content) from a wiki export.

    Handles:
    - Directory of HTML/MD files
    - ZIP archive containing HTML/MD files
    """
    import zipfile

    extensions = (".html", ".htm") if source_type == "confluence" else (".md",)

    if export_path.is_dir():
        for ext in extensions:
            for p in sorted(export_path.rglob(f"*{ext}")):
                if p.is_file():
                    raw = p.read_text(encoding="utf-8", errors="replace")
                    text = _extract_confluence_html(raw) if ext in (".html", ".htm") else raw
                    if text.strip():
                        yield str(p.relative_to(export_path)), text

    elif export_path.suffix == ".zip":
        with zipfile.ZipFile(export_path) as zf:
            for name in sorted(zf.namelist()):
                if any(name.endswith(ext) for ext in extensions) and not name.startswith("__MACOSX"):
                    raw = zf.read(name).decode("utf-8", errors="replace")
                    text = _extract_confluence_html(raw) if any(name.endswith(e) for e in (".html", ".htm")) else raw
                    if text.strip():
                        yield name, text
    else:
        raise SystemExit(f"Export must be a directory or .zip file, got: {export_path}")


def cmd_wiki(args: argparse.Namespace) -> int:
    export_path = Path(args.export)
    if not export_path.exists():
        print(f"ERROR: path not found: {export_path}", file=sys.stderr)
        return 2

    model, dim = _load_embedder()
    backend = _load_backend(dim)

    t0 = time.time()
    total_files = 0
    total_skipped = 0
    total_chunks = 0
    total_written = 0

    try:
        for name, text in _iter_wiki_files(export_path, args.source):
            total_files += 1
            file_hash = sha256_hex(text)

            if backend.has_source(args.domain, name, file_hash):
                total_skipped += 1
                continue

            if args.source == "notion":
                chunks = markdown_chunks(text, source_id=name, tags=list(args.tags or []))
            else:
                # Confluence: paragraph-chunk the extracted plaintext
                chunks = paragraph_chunks(
                    text, source_id=name, tags=list(args.tags or []),
                    max_chars=2000, overlap=200,
                )

            if not chunks:
                continue

            n = embed_and_upsert(backend, args.domain, chunks, model, args.batch_size)
            backend.record_source_import(args.domain, name, file_hash, len(chunks))
            total_chunks += len(chunks)
            total_written += n
            print(f"  {name}: {len(chunks)} chunks", file=sys.stderr)
    finally:
        backend.close()

    dt = time.time() - t0
    rate = total_written / max(dt, 0.001)
    print(
        f"\nDone: {total_files} files ({total_skipped} skipped unchanged), "
        f"{total_written} chunks written in {dt:.1f}s ({rate:.0f} chunks/sec)",
        file=sys.stderr,
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        prog="ob2 import",
        description="Bulk-import domain knowledge into OB2.",
    )
    sp = ap.add_subparsers(dest="kind", required=True)

    p_csv = sp.add_parser("csv", help="Import a CSV/TSV; one row = one doc.")
    p_csv.add_argument("--domain", required=True)
    p_csv.add_argument("--file", required=True, help="Path to .csv or .tsv file")
    p_csv.add_argument("--schema", help="Optional schema.yml (doc_id_column, text_template, tags_columns).")
    p_csv.add_argument("--batch-size", type=int, default=256, dest="batch_size")
    p_csv.set_defaults(func=cmd_csv)

    p_docs = sp.add_parser("docs", help="Import markdown files/directory; chunked by heading.")
    p_docs.add_argument("--domain", required=True)
    p_docs.add_argument("--dir", required=True, help="File or directory of .md")
    p_docs.add_argument("--recursive", action="store_true")
    p_docs.add_argument("--tags", nargs="*", default=[])
    p_docs.add_argument("--batch-size", type=int, default=256, dest="batch_size")
    p_docs.set_defaults(func=cmd_docs)

    # PDF importer
    p_pdf = sp.add_parser("pdf", help="Import a PDF file; one chunk per page.")
    p_pdf.add_argument("--domain", required=True)
    p_pdf.add_argument("--file", required=True, help="Path to .pdf")
    p_pdf.add_argument("--tags", nargs="*", default=[])
    p_pdf.add_argument("--batch-size", type=int, default=256, dest="batch_size")
    p_pdf.set_defaults(func=cmd_pdf)

    # Wiki importer
    p_wiki = sp.add_parser("wiki", help="Import a Confluence HTML export or Notion markdown export.")
    p_wiki.add_argument("--domain", required=True)
    p_wiki.add_argument("--export", required=True, help="Path to .zip export or directory")
    p_wiki.add_argument("--source", choices=["confluence", "notion"], default="confluence")
    p_wiki.add_argument("--tags", nargs="*", default=[])
    p_wiki.add_argument("--batch-size", type=int, default=256, dest="batch_size")
    p_wiki.set_defaults(func=cmd_wiki)

    return ap


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
