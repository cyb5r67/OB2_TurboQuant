"""SQLite + sqlite-vec storage backend (Tier 1).

Single-file DB, no server required. WAL mode enables concurrent readers during
writes. All operations serialized through an instance-level lock for thread
safety.

Schema:
  docs            — doc_key (PK), doc_id (UNIQUE), domain, text, metadata, source_hash, created_at, synced_at
  docs_vec        — virtual vec0 table, rowid linked to docs.doc_key, FLOAT[dim]
  source_imports  — (source_id, domain, content_hash) → chunks_produced, imported_at
  entity_aliases  — (domain, alias) → canonical

Two-tier mode: synced_at is NULL for docs not yet synced to pgvector.
list_unsynced() and mark_synced() support the SyncWorker in two_tier.py.

Usage:
    backend = SQLiteVecBackend("./ob2.db", embedding_dim=384)
    backend.upsert_doc(...)
    hits = backend.query_similar(...)
    backend.close()
"""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import sqlite_vec

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


# ─────────────────────────────────────────────────────────────
# Schema DDL
# ─────────────────────────────────────────────────────────────

_DDL_MAIN = """
CREATE TABLE IF NOT EXISTS docs (
    doc_key     INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id      TEXT NOT NULL UNIQUE,
    domain      TEXT NOT NULL,
    text        TEXT NOT NULL,
    metadata    TEXT NOT NULL DEFAULT '{}',
    source_hash TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    synced_at   TEXT            -- NULL = not yet synced to pgvector (two-tier mode)
);
CREATE INDEX IF NOT EXISTS idx_docs_domain ON docs(domain);
CREATE INDEX IF NOT EXISTS idx_docs_source_hash ON docs(domain, source_hash);
CREATE INDEX IF NOT EXISTS idx_docs_unsynced ON docs(synced_at) WHERE synced_at IS NULL;

CREATE TABLE IF NOT EXISTS source_imports (
    source_id       TEXT NOT NULL,
    domain          TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    chunks_produced INTEGER NOT NULL,
    imported_at     TEXT NOT NULL,
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
    entity_key      INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id       TEXT NOT NULL,
    domain          TEXT NOT NULL,
    name            TEXT NOT NULL,
    type            TEXT NOT NULL,
    mention_count   INTEGER NOT NULL DEFAULT 0,
    first_seen      TEXT NOT NULL,
    last_seen       TEXT NOT NULL,
    metadata        TEXT NOT NULL DEFAULT '{}',
    UNIQUE (domain, type, name)
);
CREATE INDEX IF NOT EXISTS idx_entities_id ON entities(domain, entity_id);
CREATE INDEX IF NOT EXISTS idx_entities_domain ON entities(domain);
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(domain, type);
-- Cross-domain overlap view filters by lower(name)+type:
CREATE INDEX IF NOT EXISTS idx_entities_global_name ON entities(type, name);

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

-- Symmetric edges normalized so src_id < dst_id; relation labels are free-form
-- snake_case strings produced by the LLM extractor.
CREATE TABLE IF NOT EXISTS entity_edges (
    domain          TEXT NOT NULL,
    src_id          TEXT NOT NULL,
    dst_id          TEXT NOT NULL,
    relation        TEXT NOT NULL,
    weight          INTEGER NOT NULL DEFAULT 1,
    evidence_doc_id TEXT,
    last_seen       TEXT NOT NULL,
    PRIMARY KEY (domain, src_id, dst_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_edges_src ON entity_edges(domain, src_id);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON entity_edges(domain, dst_id);
"""


# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _build_filter_sql(flt: MetadataFilter) -> tuple[str, list[Any]]:
    """Translate metadata filter DSL into SQL WHERE fragment + params.

    Uses json_extract on the `metadata` column. ANDed across keys.
    Returns ("", []) for empty filter.
    """
    if not flt:
        return "", []
    parts: list[str] = []
    params: list[Any] = []
    for key, expected in flt.items():
        if isinstance(expected, dict) and "$in" in expected:
            values = list(expected["$in"])
            if not values:
                # $in of empty list matches nothing
                return " AND 1=0", []
            placeholders = ",".join(["?"] * len(values))
            parts.append(f"json_extract(metadata, '$.{key}') IN ({placeholders})")
            params.extend(values)
        else:
            parts.append(f"json_extract(metadata, '$.{key}') = ?")
            params.append(expected)
    if not parts:
        return "", []
    return " AND " + " AND ".join(parts), params


# ─────────────────────────────────────────────────────────────
# Backend
# ─────────────────────────────────────────────────────────────

class SQLiteVecBackend(StorageBackend):
    def __init__(self, db_path: str, embedding_dim: int = 384) -> None:
        self.db_path = db_path
        self.embedding_dim = embedding_dim
        self._lock = threading.Lock()

        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(db_path, check_same_thread=False, isolation_level=None)
        # Load sqlite-vec extension
        self._conn.enable_load_extension(True)
        sqlite_vec.load(self._conn)
        self._conn.enable_load_extension(False)

        # Pragmas for performance + concurrency
        self._conn.executescript(
            "PRAGMA journal_mode=WAL; "
            "PRAGMA synchronous=NORMAL; "
            "PRAGMA foreign_keys=ON;"
        )

        # Main schema
        self._conn.executescript(_DDL_MAIN)

        # Vector virtual table — dim is embedded in DDL
        self._conn.execute(
            f"CREATE VIRTUAL TABLE IF NOT EXISTS docs_vec "
            f"USING vec0(embedding FLOAT[{embedding_dim}])"
        )

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
        with self._lock:
            self._upsert_one_locked(domain, doc_id, text, embedding, metadata or {}, source_hash)

    def upsert_docs_batch(self, domain: str, docs: list[DocRecord]) -> int:
        if not docs:
            return 0
        for d in docs:
            if d.domain != domain:
                raise ValueError(
                    f"doc {d.doc_id!r} has domain {d.domain!r}, batch is for {domain!r}"
                )
            self._validate_embedding(d.embedding)
        with self._lock:
            self._conn.execute("BEGIN")
            try:
                for d in docs:
                    self._upsert_one_locked(
                        d.domain, d.doc_id, d.text, d.embedding, d.metadata, d.source_hash
                    )
                self._conn.execute("COMMIT")
            except Exception:
                self._conn.execute("ROLLBACK")
                raise
        return len(docs)

    def _upsert_one_locked(
        self,
        domain: str,
        doc_id: str,
        text: str,
        embedding: np.ndarray,
        metadata: dict[str, Any],
        source_hash: str,
    ) -> None:
        """MUST be called with self._lock held."""
        meta_json = json.dumps(metadata, ensure_ascii=False, sort_keys=True)
        now = _now_iso()

        # Upsert into docs, then sync docs_vec for the matching doc_key.
        cur = self._conn.execute(
            "SELECT doc_key FROM docs WHERE doc_id = ?",
            (doc_id,),
        )
        row = cur.fetchone()
        if row is None:
            cur = self._conn.execute(
                "INSERT INTO docs(doc_id, domain, text, metadata, source_hash, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (doc_id, domain, text, meta_json, source_hash, now),
            )
            doc_key = cur.lastrowid
            self._conn.execute(
                "INSERT INTO docs_vec(rowid, embedding) VALUES (?, ?)",
                (doc_key, sqlite_vec.serialize_float32(embedding.astype(np.float32))),
            )
        else:
            doc_key = row[0]
            # Reset synced_at so the SyncWorker re-pushes the updated row to
            # pgvector. Without this, post-ingest metadata stamps (e.g. graph
            # extraction's _ob2_graph_extracted_at) never make it to the Tier-2
            # canonical store.
            self._conn.execute(
                "UPDATE docs SET domain=?, text=?, metadata=?, source_hash=?, synced_at=NULL "
                "WHERE doc_key=?",
                (domain, text, meta_json, source_hash, doc_key),
            )
            # docs_vec has no UPDATE in vec0; DELETE + INSERT is required
            self._conn.execute("DELETE FROM docs_vec WHERE rowid = ?", (doc_key,))
            self._conn.execute(
                "INSERT INTO docs_vec(rowid, embedding) VALUES (?, ?)",
                (doc_key, sqlite_vec.serialize_float32(embedding.astype(np.float32))),
            )

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
        qblob = sqlite_vec.serialize_float32(query_embedding.astype(np.float32))

        # Strategy: use sqlite-vec MATCH with k set high enough to cover post-filter.
        # For small-scale use the straight cosine scan against domain-filtered rows
        # is simpler and correct. Use vec_distance_cosine directly.
        filter_sql, filter_params = _build_filter_sql(metadata_filter)

        sql = f"""
            SELECT d.doc_id, d.text, d.metadata, vec_distance_cosine(v.embedding, ?) AS dist, d.created_at
            FROM docs d
            JOIN docs_vec v ON v.rowid = d.doc_key
            WHERE d.domain = ?{filter_sql}
            ORDER BY dist ASC
            LIMIT ?
        """
        params: list[Any] = [qblob, domain, *filter_params, int(top_k)]

        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()

        hits: list[DocHit] = []
        for doc_id, text, meta_json, dist, created_at in rows:
            try:
                meta = json.loads(meta_json) if meta_json else {}
            except json.JSONDecodeError:
                meta = {}
            # vec_distance_cosine returns (1 - cosine_similarity) in [0, 2].
            # Convert to similarity in [-1, 1]; callers can clip/threshold.
            score = 1.0 - float(dist)
            hits.append(DocHit(doc_id=doc_id, text=text, metadata=meta, score=score, created_at=created_at or ""))
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
        qblob = sqlite_vec.serialize_float32(query_embedding.astype(np.float32))
        filter_sql, filter_params = _build_filter_sql(metadata_filter)

        # Build a parameterized IN clause for SQLite.
        placeholders = ",".join("?" * len(domains))
        sql = f"""
            SELECT d.doc_id, d.text, d.metadata, d.domain,
                   vec_distance_cosine(v.embedding, ?) AS dist, d.created_at
            FROM docs d
            JOIN docs_vec v ON v.rowid = d.doc_key
            WHERE d.domain IN ({placeholders}){filter_sql}
            ORDER BY dist ASC
            LIMIT ?
        """
        params: list[Any] = [qblob, *list(domains), *filter_params, int(top_k)]

        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()

        hits: list[DocHit] = []
        for doc_id, text, meta_json, domain, dist, created_at in rows:
            try:
                meta = json.loads(meta_json) if meta_json else {}
            except json.JSONDecodeError:
                meta = {}
            meta.setdefault("_ob2_domain", domain)
            score = 1.0 - float(dist)
            hits.append(DocHit(
                doc_id=doc_id, text=text, metadata=meta,
                score=score, created_at=created_at or "",
            ))
        return hits

    def get_doc(self, domain: str, doc_id: str) -> DocRecord | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT d.doc_id, d.domain, d.text, d.metadata, d.source_hash, v.embedding "
                "FROM docs d JOIN docs_vec v ON v.rowid = d.doc_key "
                "WHERE d.domain = ? AND d.doc_id = ?",
                (domain, doc_id),
            ).fetchone()
        if not row:
            return None
        doc_id_, dom, text, meta_json, src_hash, emb_blob = row
        emb = np.frombuffer(emb_blob, dtype=np.float32).copy()
        meta = json.loads(meta_json) if meta_json else {}
        return DocRecord(
            doc_id=doc_id_, domain=dom, text=text, embedding=emb,
            metadata=meta, source_hash=src_hash or "",
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
            SELECT d.doc_id, d.domain, d.text, d.metadata, d.source_hash, v.embedding, d.created_at
            FROM docs d JOIN docs_vec v ON v.rowid = d.doc_key
            WHERE d.domain = ?{filter_sql}
            ORDER BY d.doc_key DESC
            LIMIT ? OFFSET ?
        """
        params: list[Any] = [domain, *filter_params, int(limit), int(offset)]
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        out: list[DocRecord] = []
        for doc_id, dom, text, meta_json, src_hash, emb_blob, created_at in rows:
            emb = np.frombuffer(emb_blob, dtype=np.float32).copy()
            meta = json.loads(meta_json) if meta_json else {}
            out.append(DocRecord(
                doc_id=doc_id, domain=dom, text=text, embedding=emb,
                metadata=meta, source_hash=src_hash or "", created_at=created_at or "",
            ))
        return out

    # ── deletes ─────────────────────────────────────────────

    def delete_doc(self, domain: str, doc_id: str) -> bool:
        # Cascade graph mentions for this doc BEFORE deleting it (delete_doc_graph
        # snapshots entity_ids and recomputes mention counts).
        try:
            self.delete_doc_graph(domain, doc_id)
        except Exception:
            pass
        with self._lock:
            row = self._conn.execute(
                "SELECT doc_key FROM docs WHERE domain = ? AND doc_id = ?",
                (domain, doc_id),
            ).fetchone()
            if not row:
                return False
            doc_key = row[0]
            self._conn.execute("BEGIN")
            try:
                self._conn.execute("DELETE FROM docs_vec WHERE rowid = ?", (doc_key,))
                self._conn.execute("DELETE FROM docs WHERE doc_key = ?", (doc_key,))
                self._conn.execute("COMMIT")
            except Exception:
                self._conn.execute("ROLLBACK")
                raise
            return True

    def delete_domain(self, domain: str) -> int:
        with self._lock:
            keys = [r[0] for r in self._conn.execute(
                "SELECT doc_key FROM docs WHERE domain = ?", (domain,),
            ).fetchall()]
            if not keys:
                # Still clean up aliases + source_imports + graph
                self._conn.execute("DELETE FROM entity_aliases WHERE domain = ?", (domain,))
                self._conn.execute("DELETE FROM source_imports WHERE domain = ?", (domain,))
                self._conn.execute("DELETE FROM entity_mentions WHERE domain = ?", (domain,))
                self._conn.execute("DELETE FROM entity_edges WHERE domain = ?", (domain,))
                self._conn.execute("DELETE FROM entities WHERE domain = ?", (domain,))
                return 0
            self._conn.execute("BEGIN")
            try:
                placeholders = ",".join(["?"] * len(keys))
                self._conn.execute(f"DELETE FROM docs_vec WHERE rowid IN ({placeholders})", keys)
                self._conn.execute("DELETE FROM docs WHERE domain = ?", (domain,))
                self._conn.execute("DELETE FROM entity_aliases WHERE domain = ?", (domain,))
                self._conn.execute("DELETE FROM source_imports WHERE domain = ?", (domain,))
                self._conn.execute("DELETE FROM entity_mentions WHERE domain = ?", (domain,))
                self._conn.execute("DELETE FROM entity_edges WHERE domain = ?", (domain,))
                self._conn.execute("DELETE FROM entities WHERE domain = ?", (domain,))
                self._conn.execute("COMMIT")
            except Exception:
                self._conn.execute("ROLLBACK")
                raise
            return len(keys)

    # ── introspection ───────────────────────────────────────

    def list_domains(self) -> list[str]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT DISTINCT domain FROM docs ORDER BY domain"
            ).fetchall()
        return [r[0] for r in rows]

    def domain_stats(self, domain: str) -> DomainStats:
        with self._lock:
            row = self._conn.execute(
                "SELECT COUNT(*), COALESCE(SUM(LENGTH(text)), 0), "
                "MIN(created_at), MAX(created_at) "
                "FROM docs WHERE domain = ?",
                (domain,),
            ).fetchone()
        count, total_bytes, oldest, newest = row
        return DomainStats(
            domain=domain,
            doc_count=int(count),
            total_bytes=int(total_bytes),
            oldest_at=oldest,
            newest_at=newest,
        )

    # ── source-hash dedup ───────────────────────────────────

    def has_source(self, domain: str, source_id: str, content_hash: str) -> bool:
        with self._lock:
            row = self._conn.execute(
                "SELECT 1 FROM source_imports "
                "WHERE domain = ? AND source_id = ? AND content_hash = ? LIMIT 1",
                (domain, source_id, content_hash),
            ).fetchone()
        return row is not None

    def record_source_import(
        self,
        domain: str,
        source_id: str,
        content_hash: str,
        chunks_produced: int,
    ) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO source_imports(source_id, domain, content_hash, "
                "chunks_produced, imported_at) VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(source_id, domain) DO UPDATE SET "
                "content_hash = excluded.content_hash, "
                "chunks_produced = excluded.chunks_produced, "
                "imported_at = excluded.imported_at",
                (source_id, domain, content_hash, chunks_produced, _now_iso()),
            )

    # ── aliases ─────────────────────────────────────────────

    def upsert_alias(self, domain: str, alias: str, canonical: str) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO entity_aliases(domain, alias, canonical) VALUES (?, ?, ?) "
                "ON CONFLICT(domain, alias) DO UPDATE SET canonical = excluded.canonical",
                (domain, alias, canonical),
            )

    def resolve_alias(self, domain: str, alias: str) -> str | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT canonical FROM entity_aliases WHERE domain = ? AND alias = ?",
                (domain, alias),
            ).fetchone()
        return row[0] if row else None

    def list_aliases(self, domain: str) -> list[tuple[str, str]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT alias, canonical FROM entity_aliases WHERE domain = ? ORDER BY alias",
                (domain,),
            ).fetchall()
        return [(r[0], r[1]) for r in rows]

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
        now = _now_iso()
        with self._lock:
            if increment_mentions:
                self._conn.execute(
                    "INSERT INTO entities(entity_id, domain, name, type, mention_count, "
                    "first_seen, last_seen, metadata) VALUES (?, ?, ?, ?, 1, ?, ?, '{}') "
                    "ON CONFLICT(domain, type, name) DO UPDATE SET "
                    "mention_count = entities.mention_count + 1, "
                    "last_seen = excluded.last_seen",
                    (entity_id, domain, name, type, now, now),
                )
            else:
                self._conn.execute(
                    "INSERT INTO entities(entity_id, domain, name, type, mention_count, "
                    "first_seen, last_seen, metadata) VALUES (?, ?, ?, ?, 0, ?, ?, '{}') "
                    "ON CONFLICT(domain, type, name) DO NOTHING",
                    (entity_id, domain, name, type, now, now),
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
        with self._lock:
            self._conn.execute(
                "INSERT INTO entity_mentions(domain, doc_id, entity_id, span_start, "
                "span_end, confidence) VALUES (?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(domain, doc_id, entity_id) DO UPDATE SET "
                "span_start = excluded.span_start, "
                "span_end = excluded.span_end, "
                "confidence = excluded.confidence",
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
        now = _now_iso()
        with self._lock:
            self._conn.execute(
                "INSERT INTO entity_edges(domain, src_id, dst_id, relation, weight, "
                "evidence_doc_id, last_seen) VALUES (?, ?, ?, ?, 1, ?, ?) "
                "ON CONFLICT(domain, src_id, dst_id, relation) DO UPDATE SET "
                "weight = entity_edges.weight + 1, "
                "evidence_doc_id = COALESCE(excluded.evidence_doc_id, entity_edges.evidence_doc_id), "
                "last_seen = excluded.last_seen",
                (domain, src_id, dst_id, relation, evidence_doc_id, now),
            )

    def delete_doc_graph(self, domain: str, doc_id: str) -> int:
        # Snapshot the entities this doc mentions before nuking the rows so we
        # can decrement counts and orphan-prune in one txn.
        with self._lock:
            self._conn.execute("BEGIN")
            try:
                rows = self._conn.execute(
                    "SELECT entity_id FROM entity_mentions WHERE domain = ? AND doc_id = ?",
                    (domain, doc_id),
                ).fetchall()
                entity_ids = [r[0] for r in rows]
                cur = self._conn.execute(
                    "DELETE FROM entity_mentions WHERE domain = ? AND doc_id = ?",
                    (domain, doc_id),
                )
                removed = cur.rowcount
                # Recompute mention_count for the affected entities — simpler than
                # bookkeeping deltas and stays consistent if doc_id has multiple
                # mentions of the same entity (which it shouldn't after dedup).
                for eid in entity_ids:
                    new_count = self._conn.execute(
                        "SELECT COUNT(*) FROM entity_mentions WHERE domain = ? AND entity_id = ?",
                        (domain, eid),
                    ).fetchone()[0]
                    if new_count == 0:
                        self._conn.execute(
                            "DELETE FROM entity_edges WHERE domain = ? AND (src_id = ? OR dst_id = ?)",
                            (domain, eid, eid),
                        )
                        self._conn.execute(
                            "DELETE FROM entities WHERE domain = ? AND entity_id = ?",
                            (domain, eid),
                        )
                    else:
                        self._conn.execute(
                            "UPDATE entities SET mention_count = ? WHERE domain = ? AND entity_id = ?",
                            (new_count, domain, eid),
                        )
                self._conn.execute("COMMIT")
                return int(removed or 0)
            except Exception:
                self._conn.execute("ROLLBACK")
                raise

    def delete_domain_graph(self, domain: str) -> int:
        with self._lock:
            self._conn.execute("BEGIN")
            try:
                cur = self._conn.execute(
                    "DELETE FROM entity_mentions WHERE domain = ?", (domain,),
                )
                removed = cur.rowcount or 0
                self._conn.execute("DELETE FROM entity_edges WHERE domain = ?", (domain,))
                self._conn.execute("DELETE FROM entities WHERE domain = ?", (domain,))
                self._conn.execute("COMMIT")
                return int(removed)
            except Exception:
                self._conn.execute("ROLLBACK")
                raise

    def get_entity(self, domain: str, entity_id: str) -> EntityRecord | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT entity_id, domain, name, type, mention_count, first_seen, last_seen, metadata "
                "FROM entities WHERE domain = ? AND entity_id = ?",
                (domain, entity_id),
            ).fetchone()
        if not row:
            return None
        eid, dom, name, typ, mc, first, last, meta_json = row
        return EntityRecord(
            entity_id=eid, domain=dom, name=name, type=typ,
            mention_count=int(mc or 0),
            first_seen=first or "", last_seen=last or "",
            metadata=json.loads(meta_json) if meta_json else {},
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
               "FROM entities WHERE domain = ?")
        params: list[Any] = [domain]
        if type_filter:
            sql += " AND type = ?"
            params.append(type_filter)
        if q:
            sql += " AND lower(name) LIKE ?"
            params.append(f"%{q.lower()}%")
        sql += " ORDER BY mention_count DESC, name ASC LIMIT ? OFFSET ?"
        params.extend([int(limit), int(offset)])
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return [
            EntityRecord(
                entity_id=r[0], domain=r[1], name=r[2], type=r[3],
                mention_count=int(r[4] or 0),
                first_seen=r[5] or "", last_seen=r[6] or "",
                metadata=json.loads(r[7]) if r[7] else {},
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
                   "FROM entity_edges WHERE domain = ? AND (src_id = ? OR dst_id = ?) "
                   "ORDER BY weight DESC LIMIT ?")
            params = [domain, src_id, src_id, int(limit)]
        else:
            sql = ("SELECT domain, src_id, dst_id, relation, weight, evidence_doc_id, last_seen "
                   "FROM entity_edges WHERE domain = ? ORDER BY weight DESC LIMIT ?")
            params = [domain, int(limit)]
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return [
            EdgeRecord(
                domain=r[0], src_id=r[1], dst_id=r[2], relation=r[3],
                weight=int(r[4] or 1), evidence_doc_id=r[5],
                last_seen=r[6] or "",
            )
            for r in rows
        ]

    def list_mentions(self, domain: str, doc_id: str) -> list[str]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT entity_id FROM entity_mentions WHERE domain = ? AND doc_id = ?",
                (domain, doc_id),
            ).fetchall()
        return [r[0] for r in rows]

    def find_neighbor_docs(
        self,
        domain: str,
        doc_ids: list[str],
        *,
        limit: int = 20,
    ) -> list[NeighborHit]:
        if not doc_ids:
            return []
        placeholders = ",".join("?" * len(doc_ids))
        # Find docs that share entities with any input doc, excluding the inputs.
        # The GROUP_CONCAT collects which entities tied them together so the
        # rerank can boost by per-entity weight.
        sql = (
            "SELECT m2.doc_id, d.text, d.metadata, d.created_at, "
            "       GROUP_CONCAT(DISTINCT m1.entity_id) AS shared_eids "
            "FROM entity_mentions m1 "
            "JOIN entity_mentions m2 "
            "  ON m1.domain = m2.domain AND m1.entity_id = m2.entity_id "
            "JOIN docs d ON d.doc_id = m2.doc_id "
            f"WHERE m1.domain = ? AND m1.doc_id IN ({placeholders}) "
            f"AND m2.doc_id NOT IN ({placeholders}) "
            "GROUP BY m2.doc_id, d.text, d.metadata, d.created_at "
            "LIMIT ?"
        )
        params: list[Any] = [domain, *doc_ids, *doc_ids, int(limit)]
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        out: list[NeighborHit] = []
        for doc_id, text, meta_json, created_at, shared_csv in rows:
            shared = (shared_csv or "").split(",") if shared_csv else []
            try:
                meta = json.loads(meta_json) if meta_json else {}
            except json.JSONDecodeError:
                meta = {}
            out.append(NeighborHit(
                doc_id=doc_id, text=text, metadata=meta,
                shared_entity_ids=shared, created_at=created_at or "",
            ))
        return out

    def docs_for_entity(
        self,
        domain: str,
        entity_id: str,
        *,
        limit: int = 50,
    ) -> list[str]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT m.doc_id FROM entity_mentions m "
                "JOIN docs d ON d.doc_id = m.doc_id "
                "WHERE m.domain = ? AND m.entity_id = ? "
                "ORDER BY d.created_at DESC LIMIT ?",
                (domain, entity_id, int(limit)),
            ).fetchall()
        return [r[0] for r in rows]

    def list_entities_multi(
        self,
        domains: list[str],
        *,
        name_substr: str | None = None,
        limit: int = 200,
    ) -> list[EntityRecord]:
        if not domains:
            return []
        placeholders = ",".join("?" * len(domains))
        sql = (
            "SELECT entity_id, domain, name, type, mention_count, first_seen, last_seen, metadata "
            f"FROM entities WHERE domain IN ({placeholders})"
        )
        params: list[Any] = [*domains]
        if name_substr:
            sql += " AND lower(name) LIKE ?"
            params.append(f"%{name_substr.lower()}%")
        sql += " ORDER BY mention_count DESC, name ASC LIMIT ?"
        params.append(int(limit))
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return [
            EntityRecord(
                entity_id=r[0], domain=r[1], name=r[2], type=r[3],
                mention_count=int(r[4] or 0),
                first_seen=r[5] or "", last_seen=r[6] or "",
                metadata=json.loads(r[7]) if r[7] else {},
            )
            for r in rows
        ]

    def recompute_mention_counts(self, domain: str) -> int:
        with self._lock:
            cur = self._conn.execute(
                "UPDATE entities SET mention_count = ("
                "  SELECT COUNT(*) FROM entity_mentions "
                "  WHERE entity_mentions.domain = entities.domain "
                "    AND entity_mentions.entity_id = entities.entity_id"
                ") WHERE domain = ?",
                (domain,),
            )
            return int(cur.rowcount or 0)

    def graph_stats(self, domain: str) -> dict[str, Any]:
        with self._lock:
            ec = self._conn.execute(
                "SELECT COUNT(*) FROM entities WHERE domain = ?", (domain,),
            ).fetchone()[0]
            mc = self._conn.execute(
                "SELECT COUNT(*) FROM entity_mentions WHERE domain = ?", (domain,),
            ).fetchone()[0]
            edc = self._conn.execute(
                "SELECT COUNT(*) FROM entity_edges WHERE domain = ?", (domain,),
            ).fetchone()[0]
            last_extract = self._conn.execute(
                "SELECT MAX(json_extract(metadata, '$._ob2_graph_extracted_at')) "
                "FROM docs WHERE domain = ?", (domain,),
            ).fetchone()[0]
        return {
            "domain": domain,
            "entity_count": int(ec or 0),
            "mention_count": int(mc or 0),
            "edge_count": int(edc or 0),
            "last_extraction_at": last_extract,
        }

    # ── two-tier sync helpers ──────────────────────────────

    def list_unsynced(self, limit: int = 256) -> list[DocRecord]:
        """Return docs with synced_at IS NULL, oldest first. Used by SyncWorker."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT d.doc_id, d.domain, d.text, d.metadata, d.source_hash, v.embedding "
                "FROM docs d JOIN docs_vec v ON v.rowid = d.doc_key "
                "WHERE d.synced_at IS NULL "
                "ORDER BY d.doc_key ASC LIMIT ?",
                (int(limit),),
            ).fetchall()
        out: list[DocRecord] = []
        for doc_id, dom, text, meta_json, src_hash, emb_blob in rows:
            emb = np.frombuffer(emb_blob, dtype=np.float32).copy()
            meta = json.loads(meta_json) if meta_json else {}
            out.append(DocRecord(
                doc_id=doc_id, domain=dom, text=text, embedding=emb,
                metadata=meta, source_hash=src_hash or "",
            ))
        return out

    def mark_synced(self, doc_ids: list[str]) -> int:
        """Set synced_at = NOW for the given doc_ids. Returns count updated."""
        if not doc_ids:
            return 0
        now = _now_iso()
        with self._lock:
            placeholders = ",".join(["?"] * len(doc_ids))
            cur = self._conn.execute(
                f"UPDATE docs SET synced_at = ? WHERE doc_id IN ({placeholders})",
                [now, *doc_ids],
            )
            return cur.rowcount or 0

    def pending_sync_count(self) -> int:
        """Count of docs with synced_at IS NULL."""
        with self._lock:
            row = self._conn.execute(
                "SELECT COUNT(*) FROM docs WHERE synced_at IS NULL"
            ).fetchone()
        return int(row[0])

    # ── lifecycle ───────────────────────────────────────────

    def close(self) -> None:
        with self._lock:
            try:
                self._conn.close()
            except sqlite3.Error:
                pass
