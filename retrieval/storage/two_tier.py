"""Two-tier storage: SQLite write cache + pgvector query store.

Writes land in SQLite (151µs) and return immediately. A background SyncWorker
thread drains unsync'd docs to pgvector every N seconds or when the buffer
hits a batch threshold. Reads always hit pgvector (2.3ms HNSW queries) with
automatic fallback to SQLite if pgvector is unreachable.

Usage:
    backend = TwoTierBackend(
        sqlite_path="./ob2.db",
        pg_url="postgres://ob2:secret@localhost:5433/ob2",
        embedding_dim=384,
    )
    backend.upsert_doc(...)       # → SQLite (fast)
    backend.query_similar(...)    # → pgvector (HNSW) or SQLite fallback
    backend.close()               # stops SyncWorker, flushes, closes both
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any

import numpy as np

from .backend import (
    DocHit,
    DocRecord,
    DomainStats,
    EdgeRecord,
    EntityRecord,
    MetadataFilter,
    NeighborHit,
    StorageBackend,
)
from .sqlite_vec import SQLiteVecBackend
from .pg_vector import PgVectorBackend

logger = logging.getLogger(__name__)


class SyncWorker:
    """Background thread that drains SQLite → pgvector."""

    def __init__(
        self,
        sqlite: SQLiteVecBackend,
        pgvec: PgVectorBackend,
        interval_sec: float = 5.0,
        batch_size: int = 256,
    ) -> None:
        self._sqlite = sqlite
        self._pgvec = pgvec
        self._interval = interval_sec
        self._batch_size = batch_size
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True, name="ob2-sync")
        self._lock = threading.Lock()

        # Stats
        self.last_sync_at: str | None = None
        self.last_sync_docs: int = 0
        self.last_sync_ms: float = 0
        self.pg_reachable: bool = True
        self._backoff_sec: float = 1.0

    def start(self) -> None:
        self._thread.start()
        logger.info("SyncWorker started (interval=%.1fs, batch=%d)", self._interval, self._batch_size)

    def stop(self, timeout: float = 10.0) -> None:
        self._stop.set()
        self._thread.join(timeout=timeout)
        # Final drain attempt
        self._drain_once()
        logger.info("SyncWorker stopped")

    def _run(self) -> None:
        while not self._stop.is_set():
            self._drain_once()
            self._stop.wait(timeout=self._interval)

    def _drain_once(self) -> None:
        with self._lock:
            try:
                unsynced = self._sqlite.list_unsynced(limit=self._batch_size)
                if not unsynced:
                    return

                # Group by domain for transactional batches
                by_domain: dict[str, list[DocRecord]] = {}
                for doc in unsynced:
                    by_domain.setdefault(doc.domain, []).append(doc)

                t0 = time.perf_counter()
                synced_ids: list[str] = []
                for domain, docs in by_domain.items():
                    self._pgvec.upsert_docs_batch(domain, docs)
                    synced_ids.extend(d.doc_id for d in docs)

                self._sqlite.mark_synced(synced_ids)
                elapsed_ms = (time.perf_counter() - t0) * 1000

                self.last_sync_at = time.strftime("%Y-%m-%dT%H:%M:%S%z")
                self.last_sync_docs = len(synced_ids)
                self.last_sync_ms = elapsed_ms
                self.pg_reachable = True
                self._backoff_sec = 1.0

                if synced_ids:
                    logger.info("synced %d docs to pgvector in %.0fms", len(synced_ids), elapsed_ms)

            except Exception as e:
                self.pg_reachable = False
                pending = self._sqlite.pending_sync_count()
                logger.warning(
                    "pgvector unreachable (%s), %d docs pending sync (backoff %.0fs)",
                    e, pending, self._backoff_sec,
                )
                # Exponential backoff capped at 60s
                time.sleep(self._backoff_sec)
                self._backoff_sec = min(self._backoff_sec * 2, 60.0)

    def status(self) -> dict[str, Any]:
        return {
            "pending_docs": self._sqlite.pending_sync_count(),
            "last_sync_at": self.last_sync_at,
            "last_sync_docs": self.last_sync_docs,
            "last_sync_ms": round(self.last_sync_ms, 1),
            "pgvector_reachable": self.pg_reachable,
        }


class TwoTierBackend(StorageBackend):
    """SQLite for writes, pgvector for reads, SyncWorker bridges them."""

    def __init__(
        self,
        sqlite_path: str,
        pg_url: str,
        embedding_dim: int = 384,
        sync_interval_sec: float = 5.0,
        sync_batch_size: int = 256,
    ) -> None:
        self._sqlite = SQLiteVecBackend(sqlite_path, embedding_dim=embedding_dim)
        self._pgvec = PgVectorBackend(pg_url, embedding_dim=embedding_dim)
        self._sync = SyncWorker(
            self._sqlite, self._pgvec,
            interval_sec=sync_interval_sec,
            batch_size=sync_batch_size,
        )
        self._sync.start()

    @property
    def sync_status(self) -> dict[str, Any]:
        return self._sync.status()

    # ── writes → SQLite (fast) ──────────────────────────────

    def upsert_doc(
        self,
        domain: str,
        doc_id: str,
        text: str,
        embedding: np.ndarray,
        metadata: dict[str, Any] | None = None,
        source_hash: str = "",
    ) -> None:
        self._sqlite.upsert_doc(domain, doc_id, text, embedding, metadata, source_hash)

    def upsert_docs_batch(self, domain: str, docs: list[DocRecord]) -> int:
        return self._sqlite.upsert_docs_batch(domain, docs)

    # ── reads → pgvector (HNSW) with SQLite fallback ───────

    def query_similar(
        self,
        domain: str,
        query_embedding: np.ndarray,
        top_k: int,
        metadata_filter: MetadataFilter = None,
    ) -> list[DocHit]:
        try:
            hits = self._pgvec.query_similar(domain, query_embedding, top_k, metadata_filter)
            if hits:
                return hits
            # pgvector returned empty — maybe docs haven't synced yet; try SQLite
            return self._sqlite.query_similar(domain, query_embedding, top_k, metadata_filter)
        except Exception:
            # pgvector unreachable — fall back to SQLite
            logger.warning("pgvector query failed, falling back to SQLite")
            return self._sqlite.query_similar(domain, query_embedding, top_k, metadata_filter)

    def query_similar_multi(
        self,
        domains: list[str],
        query_embedding: np.ndarray,
        top_k: int,
        metadata_filter: MetadataFilter = None,
    ) -> list[DocHit]:
        if not domains:
            return []
        try:
            hits = self._pgvec.query_similar_multi(domains, query_embedding, top_k, metadata_filter)
            if hits:
                return hits
            # pgvector returned empty for every requested domain — could be
            # unsynced recent writes. Fall back to SQLite for completeness.
            return self._sqlite.query_similar_multi(domains, query_embedding, top_k, metadata_filter)
        except Exception:
            logger.warning("pgvector multi-domain query failed, falling back to SQLite")
            return self._sqlite.query_similar_multi(domains, query_embedding, top_k, metadata_filter)

    def get_doc(self, domain: str, doc_id: str) -> DocRecord | None:
        try:
            doc = self._pgvec.get_doc(domain, doc_id)
            if doc:
                return doc
        except Exception:
            pass
        return self._sqlite.get_doc(domain, doc_id)

    def list_docs(
        self,
        domain: str,
        limit: int = 100,
        offset: int = 0,
        metadata_filter: MetadataFilter = None,
    ) -> list[DocRecord]:
        try:
            docs = self._pgvec.list_docs(domain, limit, offset, metadata_filter)
            if docs:
                return docs
        except Exception:
            pass
        return self._sqlite.list_docs(domain, limit, offset, metadata_filter)

    # ── deletes → both ──────────────────────────────────────

    def delete_doc(self, domain: str, doc_id: str) -> bool:
        pg_ok = False
        try:
            pg_ok = self._pgvec.delete_doc(domain, doc_id)
        except Exception:
            pass
        sq_ok = self._sqlite.delete_doc(domain, doc_id)
        return pg_ok or sq_ok

    def delete_domain(self, domain: str) -> int:
        pg_count = 0
        try:
            pg_count = self._pgvec.delete_domain(domain)
        except Exception:
            pass
        sq_count = self._sqlite.delete_domain(domain)
        return max(pg_count, sq_count)

    # ── introspection → pgvector (canonical) with fallback ──

    def list_domains(self) -> list[str]:
        try:
            domains = self._pgvec.list_domains()
            # Merge any SQLite-only domains (unsync'd new domains)
            sq_domains = set(self._sqlite.list_domains())
            merged = list(dict.fromkeys(domains + sorted(sq_domains - set(domains))))
            return merged
        except Exception:
            return self._sqlite.list_domains()

    def domain_stats(self, domain: str) -> DomainStats:
        try:
            stats = self._pgvec.domain_stats(domain)
            # Add pending unsync'd count from SQLite
            pending = len(self._sqlite.list_unsynced(limit=100000))
            pending_for_domain = sum(
                1 for d in self._sqlite.list_unsynced(limit=100000)
                if d.domain == domain
            )
            if pending_for_domain > 0:
                stats = DomainStats(
                    domain=stats.domain,
                    doc_count=stats.doc_count + pending_for_domain,
                    total_bytes=stats.total_bytes,
                    oldest_at=stats.oldest_at,
                    newest_at=stats.newest_at,
                )
            return stats
        except Exception:
            return self._sqlite.domain_stats(domain)

    # ── source dedup → pgvector (canonical) ─────────────────

    def has_source(self, domain: str, source_id: str, content_hash: str) -> bool:
        try:
            if self._pgvec.has_source(domain, source_id, content_hash):
                return True
        except Exception:
            pass
        return self._sqlite.has_source(domain, source_id, content_hash)

    def record_source_import(
        self,
        domain: str,
        source_id: str,
        content_hash: str,
        chunks_produced: int,
    ) -> None:
        # Record in both so dedup works regardless of which backend is queried
        try:
            self._pgvec.record_source_import(domain, source_id, content_hash, chunks_produced)
        except Exception:
            pass
        self._sqlite.record_source_import(domain, source_id, content_hash, chunks_produced)

    # ── aliases → pgvector (canonical) ──────────────────────

    def upsert_alias(self, domain: str, alias: str, canonical: str) -> None:
        try:
            self._pgvec.upsert_alias(domain, alias, canonical)
        except Exception:
            pass
        self._sqlite.upsert_alias(domain, alias, canonical)

    def resolve_alias(self, domain: str, alias: str) -> str | None:
        try:
            r = self._pgvec.resolve_alias(domain, alias)
            if r:
                return r
        except Exception:
            pass
        return self._sqlite.resolve_alias(domain, alias)

    def list_aliases(self, domain: str) -> list[tuple[str, str]]:
        try:
            return self._pgvec.list_aliases(domain)
        except Exception:
            return self._sqlite.list_aliases(domain)

    # ── graph (entities / mentions / edges) → pgvector primary,
    #    sqlite mirror so single-tier reads still work after restart ──

    def upsert_entity(
        self,
        domain: str,
        entity_id: str,
        name: str,
        type: str,
        *,
        increment_mentions: bool = False,
    ) -> None:
        try:
            self._pgvec.upsert_entity(domain, entity_id, name, type, increment_mentions=increment_mentions)
        except Exception:
            pass
        self._sqlite.upsert_entity(domain, entity_id, name, type, increment_mentions=increment_mentions)

    def upsert_mention(
        self,
        domain: str,
        doc_id: str,
        entity_id: str,
        span_start: int | None = None,
        span_end: int | None = None,
        confidence: float = 1.0,
    ) -> None:
        try:
            self._pgvec.upsert_mention(domain, doc_id, entity_id, span_start, span_end, confidence)
        except Exception:
            pass
        self._sqlite.upsert_mention(domain, doc_id, entity_id, span_start, span_end, confidence)

    def upsert_edge(
        self,
        domain: str,
        src_id: str,
        dst_id: str,
        relation: str,
        *,
        evidence_doc_id: str | None = None,
    ) -> None:
        try:
            self._pgvec.upsert_edge(domain, src_id, dst_id, relation, evidence_doc_id=evidence_doc_id)
        except Exception:
            pass
        self._sqlite.upsert_edge(domain, src_id, dst_id, relation, evidence_doc_id=evidence_doc_id)

    def delete_doc_graph(self, domain: str, doc_id: str) -> int:
        pg_n = 0
        try:
            pg_n = self._pgvec.delete_doc_graph(domain, doc_id)
        except Exception:
            pass
        sq_n = self._sqlite.delete_doc_graph(domain, doc_id)
        return max(pg_n, sq_n)

    def delete_domain_graph(self, domain: str) -> int:
        pg_n = 0
        try:
            pg_n = self._pgvec.delete_domain_graph(domain)
        except Exception:
            pass
        sq_n = self._sqlite.delete_domain_graph(domain)
        return max(pg_n, sq_n)

    def get_entity(self, domain: str, entity_id: str) -> EntityRecord | None:
        try:
            r = self._pgvec.get_entity(domain, entity_id)
            if r is not None:
                return r
        except Exception:
            pass
        return self._sqlite.get_entity(domain, entity_id)

    def list_entities(
        self,
        domain: str,
        *,
        limit: int = 200,
        offset: int = 0,
        type_filter: str | None = None,
        q: str | None = None,
    ) -> list[EntityRecord]:
        try:
            r = self._pgvec.list_entities(domain, limit=limit, offset=offset, type_filter=type_filter, q=q)
            if r:
                return r
        except Exception:
            pass
        return self._sqlite.list_entities(domain, limit=limit, offset=offset, type_filter=type_filter, q=q)

    def list_edges(
        self,
        domain: str,
        *,
        src_id: str | None = None,
        limit: int = 10000,
    ) -> list[EdgeRecord]:
        try:
            r = self._pgvec.list_edges(domain, src_id=src_id, limit=limit)
            if r:
                return r
        except Exception:
            pass
        return self._sqlite.list_edges(domain, src_id=src_id, limit=limit)

    def list_mentions(self, domain: str, doc_id: str) -> list[str]:
        try:
            r = self._pgvec.list_mentions(domain, doc_id)
            if r:
                return r
        except Exception:
            pass
        return self._sqlite.list_mentions(domain, doc_id)

    def find_neighbor_docs(
        self,
        domain: str,
        doc_ids: list[str],
        *,
        limit: int = 20,
    ) -> list[NeighborHit]:
        try:
            r = self._pgvec.find_neighbor_docs(domain, doc_ids, limit=limit)
            if r:
                return r
        except Exception:
            pass
        return self._sqlite.find_neighbor_docs(domain, doc_ids, limit=limit)

    def docs_for_entity(
        self,
        domain: str,
        entity_id: str,
        *,
        limit: int = 50,
    ) -> list[str]:
        try:
            r = self._pgvec.docs_for_entity(domain, entity_id, limit=limit)
            if r:
                return r
        except Exception:
            pass
        return self._sqlite.docs_for_entity(domain, entity_id, limit=limit)

    def list_entities_multi(
        self,
        domains: list[str],
        *,
        name_substr: str | None = None,
        limit: int = 200,
    ) -> list[EntityRecord]:
        try:
            r = self._pgvec.list_entities_multi(domains, name_substr=name_substr, limit=limit)
            if r:
                return r
        except Exception:
            pass
        return self._sqlite.list_entities_multi(domains, name_substr=name_substr, limit=limit)

    def graph_stats(self, domain: str) -> dict[str, Any]:
        try:
            return self._pgvec.graph_stats(domain)
        except Exception:
            return self._sqlite.graph_stats(domain)

    def recompute_mention_counts(self, domain: str) -> int:
        pg_n = 0
        try:
            pg_n = self._pgvec.recompute_mention_counts(domain)
        except Exception:
            pass
        sq_n = self._sqlite.recompute_mention_counts(domain)
        return max(pg_n, sq_n)

    # ── lifecycle ───────────────────────────────────────────

    def close(self) -> None:
        self._sync.stop()
        self._sqlite.close()
        self._pgvec.close()
