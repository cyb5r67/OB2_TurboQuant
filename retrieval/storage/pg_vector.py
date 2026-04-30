"""Postgres + pgvector storage backend (Tier 2).

Shipped alongside the SQLite backend. Choice is a single env var:
`OB2_STORAGE_BACKEND=pgvector` + `OB2_PG_URL=postgres://...`.

Uses psycopg3 connection pooling (`psycopg_pool.ConnectionPool`) and pgvector's
HNSW cosine index. Thread safety is delegated to the pool (each method checks
out a connection, runs its SQL, returns it).

Schema matches the SQLite backend semantically. The embedding is an actual
column (unlike sqlite-vec's virtual-table trick), so there's no doc_key ↔
rowid coupling — doc_id alone is the natural key.

Migration from SQLite: see `cli/migrate.py` (Task 19 migration tool).
"""

from __future__ import annotations

import json
from typing import Any

import numpy as np
import psycopg
from pgvector.psycopg import register_vector
from psycopg.rows import tuple_row
from psycopg_pool import ConnectionPool

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


def _configure_connection(conn: psycopg.Connection[Any]) -> None:
    """Register pgvector adapters on each pooled connection."""
    register_vector(conn)


def _build_filter_sql(flt: MetadataFilter) -> tuple[str, list[Any]]:
    """Translate metadata filter DSL into a JSONB WHERE fragment + params."""
    if not flt:
        return "", []
    parts: list[str] = []
    params: list[Any] = []
    for key, expected in flt.items():
        if isinstance(expected, dict) and "$in" in expected:
            values = list(expected["$in"])
            if not values:
                return " AND FALSE", []
            placeholders = ",".join(["%s"] * len(values))
            parts.append(f"metadata->>%s IN ({placeholders})")
            params.append(key)
            # Convert all filter values to string (JSONB ->> returns text)
            params.extend(str(v) for v in values)
        else:
            parts.append("metadata->>%s = %s")
            params.append(key)
            params.append(str(expected))
    return " AND " + " AND ".join(parts), params


_DDL_TEMPLATE = """
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS docs (
    doc_key     BIGSERIAL PRIMARY KEY,
    doc_id      TEXT NOT NULL UNIQUE,
    domain      TEXT NOT NULL,
    text        TEXT NOT NULL,
    metadata    JSONB NOT NULL DEFAULT '{{}}'::jsonb,
    source_hash TEXT NOT NULL DEFAULT '',
    embedding   vector({dim}) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_docs_domain ON docs(domain);
CREATE INDEX IF NOT EXISTS idx_docs_source ON docs(domain, source_hash);

-- HNSW cosine index; fine for up to ~10M rows.
-- ivfflat is an alternative for very large collections.
CREATE INDEX IF NOT EXISTS idx_docs_embedding_cos
    ON docs USING hnsw (embedding vector_cosine_ops);

CREATE TABLE IF NOT EXISTS source_imports (
    source_id       TEXT NOT NULL,
    domain          TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    chunks_produced INTEGER NOT NULL,
    imported_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (source_id, domain)
);

CREATE TABLE IF NOT EXISTS entity_aliases (
    domain      TEXT NOT NULL,
    alias       TEXT NOT NULL,
    canonical   TEXT NOT NULL,
    PRIMARY KEY (domain, alias)
);

-- Knowledge-graph tables (lightweight graph RAG).
-- entity_id is sha1(domain|type|lower(name))[:16]; deterministic so it
-- round-trips through bundle export/import.
CREATE TABLE IF NOT EXISTS entities (
    entity_key      BIGSERIAL PRIMARY KEY,
    entity_id       TEXT NOT NULL,
    domain          TEXT NOT NULL,
    name            TEXT NOT NULL,
    type            TEXT NOT NULL,
    mention_count   INTEGER NOT NULL DEFAULT 0,
    first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata        JSONB NOT NULL DEFAULT '{{}}'::jsonb,
    UNIQUE (domain, type, name)
);
CREATE INDEX IF NOT EXISTS idx_entities_id ON entities(domain, entity_id);
CREATE INDEX IF NOT EXISTS idx_entities_domain ON entities(domain);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(domain, type);
CREATE INDEX IF NOT EXISTS idx_entities_global_name ON entities(type, lower(name));

CREATE TABLE IF NOT EXISTS entity_mentions (
    domain      TEXT NOT NULL,
    doc_id      TEXT NOT NULL,
    entity_id   TEXT NOT NULL,
    span_start  INTEGER,
    span_end    INTEGER,
    confidence  REAL NOT NULL DEFAULT 1.0,
    PRIMARY KEY (domain, doc_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_mentions_doc ON entity_mentions(domain, doc_id);
CREATE INDEX IF NOT EXISTS idx_mentions_entity ON entity_mentions(domain, entity_id);

CREATE TABLE IF NOT EXISTS entity_edges (
    domain          TEXT NOT NULL,
    src_id          TEXT NOT NULL,
    dst_id          TEXT NOT NULL,
    relation        TEXT NOT NULL,
    weight          INTEGER NOT NULL DEFAULT 1,
    evidence_doc_id TEXT,
    last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (domain, src_id, dst_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_edges_src ON entity_edges(domain, src_id);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON entity_edges(domain, dst_id);
"""


class PgVectorBackend(StorageBackend):
    def __init__(
        self,
        conninfo: str,
        embedding_dim: int = 384,
        min_pool_size: int = 1,
        max_pool_size: int = 10,
    ) -> None:
        self.embedding_dim = embedding_dim
        self._pool = ConnectionPool(
            conninfo=conninfo,
            min_size=min_pool_size,
            max_size=max_pool_size,
            configure=_configure_connection,
            kwargs={"autocommit": True, "row_factory": tuple_row},
            open=True,
        )
        self._pool.wait(timeout=30.0)
        with self._pool.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(_DDL_TEMPLATE.format(dim=embedding_dim))

    # ── writes ──────────────────────────────────────────────

    def upsert_doc(
        self,
        domain: str,
        doc_id: str,
        text: str,
        embedding: np.ndarray,
        metadata: dict[str, Any] | None = None,
        source_hash: str = "",
    ) -> None:
        self._validate_embedding(embedding)
        meta = metadata or {}
        with self._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO docs(doc_id, domain, text, metadata, source_hash, embedding) "
                "VALUES (%s, %s, %s, %s::jsonb, %s, %s) "
                "ON CONFLICT (doc_id) DO UPDATE SET "
                "domain = EXCLUDED.domain, text = EXCLUDED.text, "
                "metadata = EXCLUDED.metadata, source_hash = EXCLUDED.source_hash, "
                "embedding = EXCLUDED.embedding",
                (
                    doc_id, domain, text,
                    json.dumps(meta, ensure_ascii=False, sort_keys=True),
                    source_hash,
                    embedding.astype(np.float32),
                ),
            )

    def upsert_docs_batch(self, domain: str, docs: list[DocRecord]) -> int:
        if not docs:
            return 0
        for d in docs:
            if d.domain != domain:
                raise ValueError(
                    f"doc {d.doc_id!r} has domain {d.domain!r}, batch is for {domain!r}"
                )
            self._validate_embedding(d.embedding)

        with self._pool.connection() as conn:
            # Temporary autocommit=False for atomic batch
            conn.autocommit = False
            try:
                with conn.cursor() as cur:
                    for d in docs:
                        cur.execute(
                            "INSERT INTO docs(doc_id, domain, text, metadata, source_hash, embedding) "
                            "VALUES (%s, %s, %s, %s::jsonb, %s, %s) "
                            "ON CONFLICT (doc_id) DO UPDATE SET "
                            "domain = EXCLUDED.domain, text = EXCLUDED.text, "
                            "metadata = EXCLUDED.metadata, source_hash = EXCLUDED.source_hash, "
                            "embedding = EXCLUDED.embedding",
                            (
                                d.doc_id, d.domain, d.text,
                                json.dumps(d.metadata, ensure_ascii=False, sort_keys=True),
                                d.source_hash,
                                d.embedding.astype(np.float32),
                            ),
                        )
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.autocommit = True
        return len(docs)

    def _validate_embedding(self, embedding: np.ndarray) -> None:
        if not isinstance(embedding, np.ndarray):
            raise TypeError(f"embedding must be np.ndarray, got {type(embedding).__name__}")
        if embedding.ndim != 1 or embedding.shape[0] != self.embedding_dim:
            raise ValueError(
                f"embedding shape {embedding.shape} incompatible with dim {self.embedding_dim}"
            )

    # ── reads ───────────────────────────────────────────────

    def query_similar(
        self,
        domain: str,
        query_embedding: np.ndarray,
        top_k: int,
        metadata_filter: MetadataFilter = None,
    ) -> list[DocHit]:
        self._validate_embedding(query_embedding)
        filter_sql, filter_params = _build_filter_sql(metadata_filter)

        sql = f"""
            SELECT doc_id, text, metadata,
                   1 - (embedding <=> %s::vector) AS score,
                   created_at
            FROM docs
            WHERE domain = %s{filter_sql}
            ORDER BY embedding <=> %s::vector ASC
            LIMIT %s
        """
        q = query_embedding.astype(np.float32)
        params: list[Any] = [q, domain, *filter_params, q, int(top_k)]

        with self._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()

        hits: list[DocHit] = []
        for doc_id, text, meta, score, created_at in rows:
            # psycopg returns JSONB as dict already
            metadata = meta if isinstance(meta, dict) else json.loads(meta or "{}")
            hits.append(DocHit(
                doc_id=doc_id, text=text, metadata=metadata,
                score=float(score),
                created_at=str(created_at) if created_at else "",
            ))
        return hits

    def query_similar_multi(
        self,
        domains: list[str],
        query_embedding: np.ndarray,
        top_k: int,
        metadata_filter: MetadataFilter = None,
    ) -> list[DocHit]:
        if not domains:
            return []
        self._validate_embedding(query_embedding)
        filter_sql, filter_params = _build_filter_sql(metadata_filter)

        # Single scan with WHERE domain = ANY(%s) — results ranked across all
        # supplied domains by cosine distance, with the HNSW index still
        # accelerating the vector comparison.
        sql = f"""
            SELECT doc_id, text, metadata, domain,
                   1 - (embedding <=> %s::vector) AS score,
                   created_at
            FROM docs
            WHERE domain = ANY(%s){filter_sql}
            ORDER BY embedding <=> %s::vector ASC
            LIMIT %s
        """
        q = query_embedding.astype(np.float32)
        params: list[Any] = [q, list(domains), *filter_params, q, int(top_k)]

        with self._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()

        hits: list[DocHit] = []
        for doc_id, text, meta, domain, score, created_at in rows:
            metadata = meta if isinstance(meta, dict) else json.loads(meta or "{}")
            # Stamp the source domain into metadata so downstream callers can
            # cite which domain each hit came from without re-querying.
            metadata = dict(metadata)
            metadata.setdefault("_ob2_domain", domain)
            hits.append(DocHit(
                doc_id=doc_id, text=text, metadata=metadata,
                score=float(score),
                created_at=str(created_at) if created_at else "",
            ))
        return hits

    def get_doc(self, domain: str, doc_id: str) -> DocRecord | None:
        with self._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT doc_id, domain, text, metadata, source_hash, embedding "
                "FROM docs WHERE domain = %s AND doc_id = %s",
                (domain, doc_id),
            )
            row = cur.fetchone()
        if not row:
            return None
        doc_id_, dom, text, meta, src_hash, emb = row
        metadata = meta if isinstance(meta, dict) else json.loads(meta or "{}")
        emb_arr = np.asarray(emb, dtype=np.float32)
        return DocRecord(
            doc_id=doc_id_, domain=dom, text=text, embedding=emb_arr,
            metadata=metadata, source_hash=src_hash or "",
        )

    def list_docs(
        self,
        domain: str,
        limit: int = 100,
        offset: int = 0,
        metadata_filter: MetadataFilter = None,
    ) -> list[DocRecord]:
        filter_sql, filter_params = _build_filter_sql(metadata_filter)
        sql = f"""
            SELECT doc_id, domain, text, metadata, source_hash, embedding, created_at
            FROM docs
            WHERE domain = %s{filter_sql}
            ORDER BY created_at DESC
            LIMIT %s OFFSET %s
        """
        params: list[Any] = [domain, *filter_params, int(limit), int(offset)]
        with self._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()

        out: list[DocRecord] = []
        for doc_id, dom, text, meta, src_hash, emb, created_at in rows:
            metadata = meta if isinstance(meta, dict) else json.loads(meta or "{}")
            emb_arr = np.asarray(emb, dtype=np.float32)
            out.append(DocRecord(
                doc_id=doc_id, domain=dom, text=text, embedding=emb_arr,
                metadata=metadata, source_hash=src_hash or "",
                created_at=str(created_at) if created_at else "",
            ))
        return out

    # ── deletes ─────────────────────────────────────────────

    def delete_doc(self, domain: str, doc_id: str) -> bool:
        # Cascade graph mentions before deleting the doc itself.
        try:
            self.delete_doc_graph(domain, doc_id)
        except Exception:
            pass
        with self._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "DELETE FROM docs WHERE domain = %s AND doc_id = %s",
                (domain, doc_id),
            )
            return (cur.rowcount or 0) > 0

    def delete_domain(self, domain: str) -> int:
        with self._pool.connection() as conn:
            conn.autocommit = False
            try:
                with conn.cursor() as cur:
                    cur.execute("DELETE FROM docs WHERE domain = %s", (domain,))
                    deleted = cur.rowcount or 0
                    cur.execute("DELETE FROM entity_aliases WHERE domain = %s", (domain,))
                    cur.execute("DELETE FROM source_imports WHERE domain = %s", (domain,))
                    cur.execute("DELETE FROM entity_mentions WHERE domain = %s", (domain,))
                    cur.execute("DELETE FROM entity_edges WHERE domain = %s", (domain,))
                    cur.execute("DELETE FROM entities WHERE domain = %s", (domain,))
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.autocommit = True
        return int(deleted)

    # ── introspection ───────────────────────────────────────

    def list_domains(self) -> list[str]:
        with self._pool.connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT DISTINCT domain FROM docs ORDER BY domain")
            return [r[0] for r in cur.fetchall()]

    def domain_stats(self, domain: str) -> DomainStats:
        with self._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*), COALESCE(SUM(LENGTH(text)), 0), "
                "MIN(created_at), MAX(created_at) "
                "FROM docs WHERE domain = %s",
                (domain,),
            )
            count, total_bytes, oldest, newest = cur.fetchone()
        return DomainStats(
            domain=domain,
            doc_count=int(count),
            total_bytes=int(total_bytes),
            oldest_at=oldest.isoformat() if oldest else None,
            newest_at=newest.isoformat() if newest else None,
        )

    # ── source-hash dedup ───────────────────────────────────

    def has_source(self, domain: str, source_id: str, content_hash: str) -> bool:
        with self._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM source_imports "
                "WHERE domain = %s AND source_id = %s AND content_hash = %s",
                (domain, source_id, content_hash),
            )
            return cur.fetchone() is not None

    def record_source_import(
        self,
        domain: str,
        source_id: str,
        content_hash: str,
        chunks_produced: int,
    ) -> None:
        with self._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO source_imports(source_id, domain, content_hash, chunks_produced) "
                "VALUES (%s, %s, %s, %s) "
                "ON CONFLICT (source_id, domain) DO UPDATE SET "
                "content_hash = EXCLUDED.content_hash, "
                "chunks_produced = EXCLUDED.chunks_produced, "
                "imported_at = NOW()",
                (source_id, domain, content_hash, chunks_produced),
            )

    # ── aliases ─────────────────────────────────────────────

    def upsert_alias(self, domain: str, alias: str, canonical: str) -> None:
        with self._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO entity_aliases(domain, alias, canonical) VALUES (%s, %s, %s) "
                "ON CONFLICT (domain, alias) DO UPDATE SET canonical = EXCLUDED.canonical",
                (domain, alias, canonical),
            )

    def resolve_alias(self, domain: str, alias: str) -> str | None:
        with self._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT canonical FROM entity_aliases WHERE domain = %s AND alias = %s",
                (domain, alias),
            )
            row = cur.fetchone()
        return row[0] if row else None

    def list_aliases(self, domain: str) -> list[tuple[str, str]]:
        with self._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT alias, canonical FROM entity_aliases "
                "WHERE domain = %s ORDER BY alias",
                (domain,),
            )
            return [(r[0], r[1]) for r in cur.fetchall()]

    # ── graph (entities / mentions / edges) ────────────────

    def upsert_entity(
        self,
        domain: str,
        entity_id: str,
        name: str,
        type: str,
        *,
        increment_mentions: bool = False,
    ) -> None:
        with self._pool.connection() as conn, conn.cursor() as cur:
            if increment_mentions:
                cur.execute(
                    "INSERT INTO entities(entity_id, domain, name, type, mention_count) "
                    "VALUES (%s, %s, %s, %s, 1) "
                    "ON CONFLICT (domain, type, name) DO UPDATE SET "
                    "mention_count = entities.mention_count + 1, "
                    "last_seen = NOW()",
                    (entity_id, domain, name, type),
                )
            else:
                cur.execute(
                    "INSERT INTO entities(entity_id, domain, name, type, mention_count) "
                    "VALUES (%s, %s, %s, %s, 0) "
                    "ON CONFLICT (domain, type, name) DO NOTHING",
                    (entity_id, domain, name, type),
                )

    def upsert_mention(
        self,
        domain: str,
        doc_id: str,
        entity_id: str,
        span_start: int | None = None,
        span_end: int | None = None,
        confidence: float = 1.0,
    ) -> None:
        with self._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO entity_mentions(domain, doc_id, entity_id, span_start, "
                "span_end, confidence) VALUES (%s, %s, %s, %s, %s, %s) "
                "ON CONFLICT (domain, doc_id, entity_id) DO UPDATE SET "
                "span_start = EXCLUDED.span_start, "
                "span_end = EXCLUDED.span_end, "
                "confidence = EXCLUDED.confidence",
                (domain, doc_id, entity_id, span_start, span_end, float(confidence)),
            )

    def upsert_edge(
        self,
        domain: str,
        src_id: str,
        dst_id: str,
        relation: str,
        *,
        evidence_doc_id: str | None = None,
    ) -> None:
        with self._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "INSERT INTO entity_edges(domain, src_id, dst_id, relation, weight, "
                "evidence_doc_id) VALUES (%s, %s, %s, %s, 1, %s) "
                "ON CONFLICT (domain, src_id, dst_id, relation) DO UPDATE SET "
                "weight = entity_edges.weight + 1, "
                "evidence_doc_id = COALESCE(EXCLUDED.evidence_doc_id, entity_edges.evidence_doc_id), "
                "last_seen = NOW()",
                (domain, src_id, dst_id, relation, evidence_doc_id),
            )

    def delete_doc_graph(self, domain: str, doc_id: str) -> int:
        with self._pool.connection() as conn:
            conn.autocommit = False
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT entity_id FROM entity_mentions "
                        "WHERE domain = %s AND doc_id = %s",
                        (domain, doc_id),
                    )
                    entity_ids = [r[0] for r in cur.fetchall()]
                    cur.execute(
                        "DELETE FROM entity_mentions WHERE domain = %s AND doc_id = %s",
                        (domain, doc_id),
                    )
                    removed = cur.rowcount or 0
                    for eid in entity_ids:
                        cur.execute(
                            "SELECT COUNT(*) FROM entity_mentions "
                            "WHERE domain = %s AND entity_id = %s",
                            (domain, eid),
                        )
                        new_count = cur.fetchone()[0]
                        if new_count == 0:
                            cur.execute(
                                "DELETE FROM entity_edges WHERE domain = %s AND (src_id = %s OR dst_id = %s)",
                                (domain, eid, eid),
                            )
                            cur.execute(
                                "DELETE FROM entities WHERE domain = %s AND entity_id = %s",
                                (domain, eid),
                            )
                        else:
                            cur.execute(
                                "UPDATE entities SET mention_count = %s "
                                "WHERE domain = %s AND entity_id = %s",
                                (new_count, domain, eid),
                            )
                conn.commit()
                return int(removed)
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.autocommit = True

    def delete_domain_graph(self, domain: str) -> int:
        with self._pool.connection() as conn:
            conn.autocommit = False
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        "DELETE FROM entity_mentions WHERE domain = %s", (domain,),
                    )
                    removed = cur.rowcount or 0
                    cur.execute("DELETE FROM entity_edges WHERE domain = %s", (domain,))
                    cur.execute("DELETE FROM entities WHERE domain = %s", (domain,))
                conn.commit()
                return int(removed)
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.autocommit = True

    def get_entity(self, domain: str, entity_id: str) -> EntityRecord | None:
        with self._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT entity_id, domain, name, type, mention_count, first_seen, last_seen, metadata "
                "FROM entities WHERE domain = %s AND entity_id = %s",
                (domain, entity_id),
            )
            row = cur.fetchone()
        if not row:
            return None
        eid, dom, name, typ, mc, first, last, meta = row
        return EntityRecord(
            entity_id=eid, domain=dom, name=name, type=typ,
            mention_count=int(mc or 0),
            first_seen=first.isoformat() if first else "",
            last_seen=last.isoformat() if last else "",
            metadata=meta if isinstance(meta, dict) else (json.loads(meta) if meta else {}),
        )

    def list_entities(
        self,
        domain: str,
        *,
        limit: int = 200,
        offset: int = 0,
        type_filter: str | None = None,
        q: str | None = None,
    ) -> list[EntityRecord]:
        sql = ("SELECT entity_id, domain, name, type, mention_count, first_seen, last_seen, metadata "
               "FROM entities WHERE domain = %s")
        params: list[Any] = [domain]
        if type_filter:
            sql += " AND type = %s"
            params.append(type_filter)
        if q:
            sql += " AND lower(name) LIKE %s"
            params.append(f"%{q.lower()}%")
        sql += " ORDER BY mention_count DESC, name ASC LIMIT %s OFFSET %s"
        params.extend([int(limit), int(offset)])
        with self._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()
        return [
            EntityRecord(
                entity_id=r[0], domain=r[1], name=r[2], type=r[3],
                mention_count=int(r[4] or 0),
                first_seen=r[5].isoformat() if r[5] else "",
                last_seen=r[6].isoformat() if r[6] else "",
                metadata=r[7] if isinstance(r[7], dict) else (json.loads(r[7]) if r[7] else {}),
            )
            for r in rows
        ]

    def list_edges(
        self,
        domain: str,
        *,
        src_id: str | None = None,
        limit: int = 10000,
    ) -> list[EdgeRecord]:
        if src_id:
            sql = ("SELECT domain, src_id, dst_id, relation, weight, evidence_doc_id, last_seen "
                   "FROM entity_edges WHERE domain = %s AND (src_id = %s OR dst_id = %s) "
                   "ORDER BY weight DESC LIMIT %s")
            params = [domain, src_id, src_id, int(limit)]
        else:
            sql = ("SELECT domain, src_id, dst_id, relation, weight, evidence_doc_id, last_seen "
                   "FROM entity_edges WHERE domain = %s ORDER BY weight DESC LIMIT %s")
            params = [domain, int(limit)]
        with self._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()
        return [
            EdgeRecord(
                domain=r[0], src_id=r[1], dst_id=r[2], relation=r[3],
                weight=int(r[4] or 1), evidence_doc_id=r[5],
                last_seen=r[6].isoformat() if r[6] else "",
            )
            for r in rows
        ]

    def list_mentions(self, domain: str, doc_id: str) -> list[str]:
        with self._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT entity_id FROM entity_mentions WHERE domain = %s AND doc_id = %s",
                (domain, doc_id),
            )
            return [r[0] for r in cur.fetchall()]

    def find_neighbor_docs(
        self,
        domain: str,
        doc_ids: list[str],
        *,
        limit: int = 20,
    ) -> list[NeighborHit]:
        if not doc_ids:
            return []
        sql = (
            "SELECT m2.doc_id, d.text, d.metadata, d.created_at, "
            "       array_agg(DISTINCT m1.entity_id) AS shared_eids "
            "FROM entity_mentions m1 "
            "JOIN entity_mentions m2 "
            "  ON m1.domain = m2.domain AND m1.entity_id = m2.entity_id "
            "JOIN docs d ON d.doc_id = m2.doc_id "
            "WHERE m1.domain = %s AND m1.doc_id = ANY(%s) "
            "AND m2.doc_id <> ALL(%s) "
            "GROUP BY m2.doc_id, d.text, d.metadata, d.created_at "
            "LIMIT %s"
        )
        with self._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(sql, (domain, doc_ids, doc_ids, int(limit)))
            rows = cur.fetchall()
        out: list[NeighborHit] = []
        for doc_id, text, meta, created_at, shared in rows:
            meta_d = meta if isinstance(meta, dict) else (json.loads(meta) if meta else {})
            out.append(NeighborHit(
                doc_id=doc_id, text=text, metadata=meta_d,
                shared_entity_ids=list(shared or []),
                created_at=created_at.isoformat() if created_at else "",
            ))
        return out

    def docs_for_entity(
        self,
        domain: str,
        entity_id: str,
        *,
        limit: int = 50,
    ) -> list[str]:
        with self._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT m.doc_id FROM entity_mentions m "
                "JOIN docs d ON d.doc_id = m.doc_id "
                "WHERE m.domain = %s AND m.entity_id = %s "
                "ORDER BY d.created_at DESC LIMIT %s",
                (domain, entity_id, int(limit)),
            )
            return [r[0] for r in cur.fetchall()]

    def list_entities_multi(
        self,
        domains: list[str],
        *,
        name_substr: str | None = None,
        limit: int = 200,
    ) -> list[EntityRecord]:
        if not domains:
            return []
        sql = (
            "SELECT entity_id, domain, name, type, mention_count, first_seen, last_seen, metadata "
            "FROM entities WHERE domain = ANY(%s)"
        )
        params: list[Any] = [domains]
        if name_substr:
            sql += " AND lower(name) LIKE %s"
            params.append(f"%{name_substr.lower()}%")
        sql += " ORDER BY mention_count DESC, name ASC LIMIT %s"
        params.append(int(limit))
        with self._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(sql, params)
            rows = cur.fetchall()
        return [
            EntityRecord(
                entity_id=r[0], domain=r[1], name=r[2], type=r[3],
                mention_count=int(r[4] or 0),
                first_seen=r[5].isoformat() if r[5] else "",
                last_seen=r[6].isoformat() if r[6] else "",
                metadata=r[7] if isinstance(r[7], dict) else (json.loads(r[7]) if r[7] else {}),
            )
            for r in rows
        ]

    def recompute_mention_counts(self, domain: str) -> int:
        with self._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "UPDATE entities SET mention_count = ("
                "  SELECT COUNT(*) FROM entity_mentions "
                "  WHERE entity_mentions.domain = entities.domain "
                "    AND entity_mentions.entity_id = entities.entity_id"
                ") WHERE domain = %s",
                (domain,),
            )
            return int(cur.rowcount or 0)

    def graph_stats(self, domain: str) -> dict[str, Any]:
        with self._pool.connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT (SELECT COUNT(*) FROM entities WHERE domain = %s), "
                "       (SELECT COUNT(*) FROM entity_mentions WHERE domain = %s), "
                "       (SELECT COUNT(*) FROM entity_edges WHERE domain = %s), "
                "       (SELECT MAX(metadata->>'_ob2_graph_extracted_at') FROM docs WHERE domain = %s)",
                (domain, domain, domain, domain),
            )
            ec, mc, edc, last_extract = cur.fetchone()
        return {
            "domain": domain,
            "entity_count": int(ec or 0),
            "mention_count": int(mc or 0),
            "edge_count": int(edc or 0),
            "last_extraction_at": last_extract,
        }

    # ── lifecycle ───────────────────────────────────────────

    def close(self) -> None:
        try:
            self._pool.close()
        except Exception:
            pass
