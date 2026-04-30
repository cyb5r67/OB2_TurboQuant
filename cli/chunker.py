"""Chunking helpers for bulk importers.

Two strategies:
- markdown_chunks: split by heading, preserving heading as part of chunk
- paragraph_chunks: fixed-size chunks with overlap (for unstructured text / PDF)
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass


@dataclass
class Chunk:
    """One unit ready for upsert."""
    doc_id: str
    text: str
    tags: list[str]
    source_hash: str  # SHA-256 of the chunk text


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


# ─────────────────────────────────────────────────────────────
# Markdown: split on H1/H2/H3 boundaries
# ─────────────────────────────────────────────────────────────

_HEADING_RE = re.compile(r"^(#{1,3})\s+(.+?)\s*$", re.MULTILINE)


def markdown_chunks(text: str, source_id: str, tags: list[str] | None = None) -> list[Chunk]:
    """Split markdown into sections by heading.

    doc_id = f"{source_id}#{slug(heading)}"
    If text has no headings, returns one chunk using source_id as doc_id.
    """
    tags = list(tags or [])
    matches = list(_HEADING_RE.finditer(text))
    if not matches:
        clean = text.strip()
        if not clean:
            return []
        return [Chunk(
            doc_id=source_id,
            text=clean,
            tags=tags,
            source_hash=sha256_hex(clean),
        )]

    chunks: list[Chunk] = []
    for i, m in enumerate(matches):
        heading = m.group(2).strip()
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[start:end].strip()
        if not body:
            continue
        slug = re.sub(r"[^a-z0-9]+", "-", heading.lower()).strip("-") or f"section-{i}"
        chunks.append(Chunk(
            doc_id=f"{source_id}#{slug}",
            text=body,
            tags=tags,
            source_hash=sha256_hex(body),
        ))
    return chunks


# ─────────────────────────────────────────────────────────────
# Paragraph fallback (simple size-based chunking)
# ─────────────────────────────────────────────────────────────

def paragraph_chunks(
    text: str,
    source_id: str,
    tags: list[str] | None = None,
    max_chars: int = 2000,
    overlap: int = 200,
) -> list[Chunk]:
    """Fixed-size chunks with overlap. For unstructured text."""
    tags = list(tags or [])
    text = text.strip()
    if not text:
        return []
    if len(text) <= max_chars:
        return [Chunk(
            doc_id=source_id,
            text=text,
            tags=tags,
            source_hash=sha256_hex(text),
        )]

    step = max_chars - overlap
    chunks: list[Chunk] = []
    for i, start in enumerate(range(0, len(text), step)):
        end = min(start + max_chars, len(text))
        body = text[start:end].strip()
        if not body:
            continue
        chunks.append(Chunk(
            doc_id=f"{source_id}#c{i}",
            text=body,
            tags=tags,
            source_hash=sha256_hex(body),
        ))
        if end == len(text):
            break
    return chunks
