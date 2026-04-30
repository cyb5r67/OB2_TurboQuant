"""StorageBackend — abstract interface every persistence backend must satisfy.

See plan Phase 3.1 for the contract. Concrete implementations live in:
- sqlite_vec.py    — Tier 1, SQLite + sqlite-vec (Task 18)
- pg_vector.py     — Tier 2, Postgres + pgvector (Task 19)

Contract guarantees every backend must uphold:

1. `upsert_docs_batch(...)` is ATOMIC. All docs in the batch are inserted together
   or none are. A crash mid-batch leaves the store in its pre-batch state.

2. `query_similar(...)` returns hits ordered by DESCENDING cosine similarity
   (highest score first). Backends are responsible for enforcing cosine as the
   distance metric regardless of underlying index type.

3. `metadata_filter` DSL support (minimum, may extend):
       {"key": value}                              — equality
       {"key": {"$in": [v1, v2, ...]}}             — set membership
   Filters are ANDed together across keys.

4. All methods are thread-safe. Backends are responsible for their own locking;
   callers may invoke any method from any thread without external synchronization.

5. `has_source(source_id, content_hash)` returns True iff that exact content
   was previously imported. Used by bulk importers to skip unchanged chunks.

6. Embeddings are numpy arrays. Backends normalize internally to whatever
   representation they store (e.g., float32 packed, F16, etc.), but return
   float32 arrays to callers.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Mapping

import numpy as np


# ─────────────────────────────────────────────────────────────
# Data types crossing the interface
# ─────────────────────────────────────────────────────────────

@dataclass
class DocRecord:
    """A document as stored and returned by the backend."""

    doc_id: str
    domain: str
    text: str
    embedding: np.ndarray  # shape (D,), dtype float32
    metadata: dict[str, Any] = field(default_factory=dict)
    source_hash: str = ""  # SHA-256 of source chunk, for dedup ("" if not from a source import)
    created_at: str = ""

    def __post_init__(self) -> None:
        if not self.doc_id:
            raise ValueError("doc_id must not be empty")
        if not self.domain:
            raise ValueError("domain must not be empty")
        if not isinstance(self.embedding, np.ndarray):
            raise TypeError(f"embedding must be np.ndarray, got {type(self.embedding).__name__}")


@dataclass
class DocHit:
    """A retrieval hit: doc + similarity score."""

    doc_id: str
    text: str
    metadata: dict[str, Any]
    score: float  # cosine similarity in [-1, 1]; backends should clip to [0, 1] after ReLU if desired
    created_at: str = ""


@dataclass
class DomainStats:
    """Aggregate info for one domain."""

    domain: str
    doc_count: int
    total_bytes: int
    # Optional: oldest/newest timestamps when backends track them
    oldest_at: str | None = None
    newest_at: str | None = None


@dataclass
class EntityRecord:
    """A graph node — a named thing extracted from doc text."""

    entity_id: str        # sha1(domain|type|lower(name))[:16]
    domain: str
    name: str
    type: str             # PERSON | ORG | PLACE | PRODUCT | EVENT | CONCEPT | OTHER
    mention_count: int = 0
    first_seen: str = ""
    last_seen: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class EdgeRecord:
    """A graph edge — a relationship between two entities."""

    domain: str
    src_id: str
    dst_id: str
    relation: str
    weight: int = 1
    evidence_doc_id: str | None = None
    last_seen: str = ""


@dataclass
class NeighborHit:
    """A doc surfaced by graph traversal during retrieval rerank."""

    doc_id: str
    text: str
    metadata: dict[str, Any]
    shared_entity_ids: list[str]   # entities in common with the anchor docs
    score: float = 0.0             # boost computed by sidecar; backend leaves at 0
    created_at: str = ""


# ─────────────────────────────────────────────────────────────
# Metadata filter DSL — small helper for uniform parsing
# ─────────────────────────────────────────────────────────────

MetadataFilter = Mapping[str, Any] | None


def _is_in_op(value: Any) -> bool:
    return isinstance(value, dict) and "$in" in value and isinstance(value["$in"], (list, tuple))


def filter_matches(record_meta: dict[str, Any], flt: MetadataFilter) -> bool:
    """In-memory filter evaluation helper for backends that don't push down filters.

    Backends that support native filter push-down (e.g., SQL WHERE) should implement
    it directly; this is a fallback for tests and simpler backends.
    """
    if not flt:
        return True
    for key, expected in flt.items():
        actual = record_meta.get(key)
        if _is_in_op(expected):
            if actual not in expected["$in"]:
                return False
        else:
            if actual != expected:
                return False
    return True


# ─────────────────────────────────────────────────────────────
# StorageBackend ABC
# ─────────────────────────────────────────────────────────────

class StorageBackend(ABC):
    """Persistence contract. All implementations must be thread-safe."""

    # ── doc writes ──────────────────────────────────────────

    @abstractmethod
    def upsert_doc(
        self,
        domain: str,
        doc_id: str,
        text: str,
        embedding: np.ndarray,
        metadata: dict[str, Any] | None = None,
        source_hash: str = "",
    ) -> None:
        """Insert or replace a single document in a domain."""
        ...

    @abstractmethod
    def upsert_docs_batch(self, domain: str, docs: list[DocRecord]) -> int:
        """Atomically insert/replace a batch of docs in a domain.

        Returns the count written. All docs must share the same domain (must match
        the `domain` arg). Backends may raise if not.

        MUST be transactional: on failure, no docs in the batch are persisted.
        """
        ...

    # ── doc reads ───────────────────────────────────────────

    @abstractmethod
    def query_similar(
        self,
        domain: str,
        query_embedding: np.ndarray,
        top_k: int,
        metadata_filter: MetadataFilter = None,
    ) -> list[DocHit]:
        """Cosine-similarity search within a domain.

        Returns up to `top_k` hits sorted by score DESC. Empty list if domain has no
        docs or no docs match the filter.
        """
        ...

    @abstractmethod
    def query_similar_multi(
        self,
        domains: list[str],
        query_embedding: np.ndarray,
        top_k: int,
        metadata_filter: MetadataFilter = None,
    ) -> list[DocHit]:
        """Cosine-similarity search across multiple domains in a single scan.

        Identical semantics to `query_similar` but the candidate docs are filtered
        by `domain IN (...)` rather than `domain = ?`. Used by the gateway's
        prefix-less chat path to search everything the caller can read in one
        SQL roundtrip. Returns up to `top_k` hits across all supplied domains,
        ranked together. Empty domains list returns [].
        """
        ...

    @abstractmethod
    def get_doc(self, domain: str, doc_id: str) -> DocRecord | None:
        """Fetch one doc by id. Returns None if not found."""
        ...

    @abstractmethod
    def list_docs(
        self,
        domain: str,
        limit: int = 100,
        offset: int = 0,
        metadata_filter: MetadataFilter = None,
    ) -> list[DocRecord]:
        """List docs in a domain, newest first. Useful for importers and admin UI."""
        ...

    # ── doc deletes ─────────────────────────────────────────

    @abstractmethod
    def delete_doc(self, domain: str, doc_id: str) -> bool:
        """Delete one doc. Returns True if deleted, False if not found."""
        ...

    @abstractmethod
    def delete_domain(self, domain: str) -> int:
        """Delete all docs and aliases for a domain. Returns count deleted.

        Used by admin to reset a domain. Irreversible.
        """
        ...

    # ── domain introspection ────────────────────────────────

    @abstractmethod
    def list_domains(self) -> list[str]:
        """All domains that have at least one doc."""
        ...

    @abstractmethod
    def domain_stats(self, domain: str) -> DomainStats:
        """Aggregate stats for a domain. Returns stats with doc_count=0 if unknown."""
        ...

    # ── source-hash dedup (for bulk importers) ─────────────

    @abstractmethod
    def has_source(self, domain: str, source_id: str, content_hash: str) -> bool:
        """True iff we've already ingested this exact chunk from this source.

        Used by `ob2 import` CLI tools to skip unchanged files on re-run.
        """
        ...

    @abstractmethod
    def record_source_import(
        self,
        domain: str,
        source_id: str,
        content_hash: str,
        chunks_produced: int,
    ) -> None:
        """Record that we imported `chunks_produced` chunks from (source_id, content_hash).

        Called by importers after a successful batch upsert.
        """
        ...

    # ── entity aliases (for Did-you-mean suggestions) ──────

    @abstractmethod
    def upsert_alias(self, domain: str, alias: str, canonical: str) -> None:
        """Map `alias` to `canonical` entity in a domain. Overwrites existing mappings."""
        ...

    @abstractmethod
    def resolve_alias(self, domain: str, alias: str) -> str | None:
        """Return the canonical form for `alias`, or None if no mapping exists."""
        ...

    @abstractmethod
    def list_aliases(self, domain: str) -> list[tuple[str, str]]:
        """All `(alias, canonical)` pairs for a domain."""
        ...

    # ── graph (entities / mentions / edges) ────────────────
    #
    # These power the lightweight graph-RAG layer. Entities are extracted
    # from doc text by the sidecar's `extract_entities` method; the backend
    # is a passive store. ACL is enforced ONE LAYER UP — backends that take
    # `domains: list[str]` always trust the caller has filtered to the
    # readable set, mirroring `query_similar_multi`.

    @abstractmethod
    def upsert_entity(
        self,
        domain: str,
        entity_id: str,
        name: str,
        type: str,
        *,
        increment_mentions: bool = False,
    ) -> None:
        """Upsert an entity. If `increment_mentions`, bump mention_count and last_seen."""
        ...

    @abstractmethod
    def upsert_mention(
        self,
        domain: str,
        doc_id: str,
        entity_id: str,
        span_start: int | None = None,
        span_end: int | None = None,
        confidence: float = 1.0,
    ) -> None:
        """Link a doc to an entity. (domain, doc_id, entity_id) is the PK; idempotent."""
        ...

    @abstractmethod
    def upsert_edge(
        self,
        domain: str,
        src_id: str,
        dst_id: str,
        relation: str,
        *,
        evidence_doc_id: str | None = None,
    ) -> None:
        """Upsert a relationship. Caller normalises src/dst order so undirected edges
        store once; backend bumps `weight` and `last_seen` on conflict."""
        ...

    @abstractmethod
    def delete_doc_graph(self, domain: str, doc_id: str) -> int:
        """Remove all mentions for a doc; orphan-prune entities whose mention_count
        drops to zero (and their edges). Returns mentions removed."""
        ...

    @abstractmethod
    def delete_domain_graph(self, domain: str) -> int:
        """Wipe entities/mentions/edges for a domain. Called from delete_domain."""
        ...

    @abstractmethod
    def get_entity(self, domain: str, entity_id: str) -> EntityRecord | None:
        ...

    @abstractmethod
    def list_entities(
        self,
        domain: str,
        *,
        limit: int = 200,
        offset: int = 0,
        type_filter: str | None = None,
        q: str | None = None,
    ) -> list[EntityRecord]:
        """List entities in a domain. Optional type filter; optional substring on name."""
        ...

    @abstractmethod
    def list_edges(
        self,
        domain: str,
        *,
        src_id: str | None = None,
        limit: int = 10000,
    ) -> list[EdgeRecord]:
        ...

    @abstractmethod
    def list_mentions(self, domain: str, doc_id: str) -> list[str]:
        """Entity ids mentioned by this doc."""
        ...

    @abstractmethod
    def find_neighbor_docs(
        self,
        domain: str,
        doc_ids: list[str],
        *,
        limit: int = 20,
    ) -> list["NeighborHit"]:
        """Docs that share at least one entity with any input doc, excluding inputs.
        Used by the graph-rerank step in retrieval."""
        ...

    @abstractmethod
    def docs_for_entity(
        self,
        domain: str,
        entity_id: str,
        *,
        limit: int = 50,
    ) -> list[str]:
        """Doc ids that mention this entity, newest first."""
        ...

    @abstractmethod
    def list_entities_multi(
        self,
        domains: list[str],
        *,
        name_substr: str | None = None,
        limit: int = 200,
    ) -> list[EntityRecord]:
        """Cross-domain entity browse. Caller MUST pre-filter `domains` to the
        readable set (same contract as `query_similar_multi`)."""
        ...

    @abstractmethod
    def graph_stats(self, domain: str) -> dict[str, Any]:
        """Aggregate graph counts for a domain. Returns {entity_count, edge_count,
        mention_count, last_extraction_at}."""
        ...

    @abstractmethod
    def recompute_mention_counts(self, domain: str) -> int:
        """Resync `entities.mention_count` from `entity_mentions` for a domain.
        Used by bundle import after mentions are restored. Returns rows updated."""
        ...

    # ── lifecycle ──────────────────────────────────────────

    @abstractmethod
    def close(self) -> None:
        """Release resources (connections, file handles). Idempotent."""
        ...
