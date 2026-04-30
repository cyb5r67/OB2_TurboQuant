//! `SqliteVecBackend` — Tier-1 SQLite + sqlite-vec storage.
//!
//! Direct port of `retrieval/storage/sqlite_vec.py` (SQLiteVecBackend).
//!
//! On-disk format is byte-compatible with the Python sidecar (same DDL, same
//! vec0 blob layout) so operators can flip `OB2_SIDECAR_RUNTIME` between
//! `python` and `rust` without touching the DB.
//!
//! Task 8: the `StorageBackend` trait is now async. Since rusqlite is a
//! fundamentally blocking API, each trait method here wraps the sync body
//! in `tokio::task::spawn_blocking`. The real work lives in `*_sync` helpers.
//! `SqliteVecBackend` is `Clone` (DB handle behind `Arc<Mutex<Connection>>`)
//! so it moves into the `spawn_blocking` closure cheaply.

use std::path::Path;
use std::sync::Arc;
use std::sync::Once;

use async_trait::async_trait;
use chrono::Utc;
use parking_lot::Mutex;
use rusqlite::{params_from_iter, Connection, OpenFlags};

use crate::backend::StorageBackend;
use crate::types::{DocHit, DocRecord, DomainStats, MetadataFilter, StorageError};

// ─────────────────────────────────────────────────────────────
// Schema DDL — verbatim copy of retrieval/storage/sqlite_vec.py:48-78
// ─────────────────────────────────────────────────────────────

const DDL_MAIN: &str = r#"
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
"#;

const PRAGMAS: &str =
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;";

// ─────────────────────────────────────────────────────────────
// sqlite-vec extension bootstrap
// ─────────────────────────────────────────────────────────────

fn ensure_sqlite_vec_registered() {
    static INIT: Once = Once::new();
    INIT.call_once(|| {
        // SAFETY: `sqlite3_auto_extension` stores a function pointer that will
        // be invoked against every new sqlite3 connection. `sqlite3_vec_init`
        // has the correct C signature for an entry point.
        unsafe {
            let init_fn: unsafe extern "C" fn() = sqlite_vec::sqlite3_vec_init;
            type XEntryPoint = unsafe extern "C" fn(
                db: *mut rusqlite::ffi::sqlite3,
                pz_err_msg: *mut *mut std::os::raw::c_char,
                p_thunk: *const rusqlite::ffi::sqlite3_api_routines,
            ) -> std::os::raw::c_int;
            let transmuted: XEntryPoint = std::mem::transmute(init_fn as *const ());
            rusqlite::ffi::sqlite3_auto_extension(Some(transmuted));
        }
    });
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

fn now_iso() -> String {
    // Python: datetime.now(timezone.utc).isoformat(timespec="seconds")
    let now = Utc::now();
    now.format("%Y-%m-%dT%H:%M:%S+00:00").to_string()
}

fn serialize_float32(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for x in v {
        out.extend_from_slice(&x.to_le_bytes());
    }
    out
}

fn deserialize_float32(bytes: &[u8]) -> Vec<f32> {
    let mut out = Vec::with_capacity(bytes.len() / 4);
    for chunk in bytes.chunks_exact(4) {
        out.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    out
}

fn canonical_json(v: &serde_json::Value) -> Result<String, StorageError> {
    fn rebuild(v: &serde_json::Value) -> serde_json::Value {
        match v {
            serde_json::Value::Object(m) => {
                let mut keys: Vec<&String> = m.keys().collect();
                keys.sort();
                let mut out = serde_json::Map::with_capacity(m.len());
                for k in keys {
                    out.insert(k.clone(), rebuild(&m[k]));
                }
                serde_json::Value::Object(out)
            }
            serde_json::Value::Array(a) => {
                serde_json::Value::Array(a.iter().map(rebuild).collect())
            }
            other => other.clone(),
        }
    }
    Ok(serde_json::to_string(&rebuild(v))?)
}

fn build_filter_sql(
    flt: MetadataFilter<'_>,
) -> Result<(String, Vec<rusqlite::types::Value>), StorageError> {
    use rusqlite::types::Value as SqlVal;
    let Some(flt_val) = flt else { return Ok((String::new(), Vec::new())); };
    let obj = match flt_val {
        serde_json::Value::Object(m) if !m.is_empty() => m,
        serde_json::Value::Object(_) => return Ok((String::new(), Vec::new())),
        serde_json::Value::Null => return Ok((String::new(), Vec::new())),
        _ => return Err(StorageError::Invalid("metadata_filter must be an object".into())),
    };
    let mut parts: Vec<String> = Vec::new();
    let mut params: Vec<SqlVal> = Vec::new();
    for (key, expected) in obj {
        if let Some(in_list) = expected.get("$in").and_then(|x| x.as_array()) {
            if in_list.is_empty() {
                return Ok((" AND 1=0".to_string(), Vec::new()));
            }
            let placeholders = std::iter::repeat("?").take(in_list.len()).collect::<Vec<_>>().join(",");
            parts.push(format!(
                "json_extract(metadata, '$.{}') IN ({})",
                key, placeholders
            ));
            for v in in_list {
                params.push(json_to_sql(v)?);
            }
        } else {
            parts.push(format!("json_extract(metadata, '$.{}') = ?", key));
            params.push(json_to_sql(expected)?);
        }
    }
    if parts.is_empty() {
        return Ok((String::new(), Vec::new()));
    }
    Ok((format!(" AND {}", parts.join(" AND ")), params))
}

fn json_to_sql(v: &serde_json::Value) -> Result<rusqlite::types::Value, StorageError> {
    use rusqlite::types::Value;
    Ok(match v {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(b) => Value::Integer(if *b { 1 } else { 0 }),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::Integer(i)
            } else if let Some(f) = n.as_f64() {
                Value::Real(f)
            } else {
                return Err(StorageError::Invalid(format!(
                    "unrepresentable number in filter: {}",
                    n
                )));
            }
        }
        serde_json::Value::String(s) => Value::Text(s.clone()),
        other => {
            return Err(StorageError::Invalid(format!(
                "unsupported filter value type: {:?}",
                other
            )))
        }
    })
}

// ─────────────────────────────────────────────────────────────
// Backend
// ─────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct SqliteVecBackend {
    conn: Arc<Mutex<Connection>>,
    embedding_dim: usize,
}

impl SqliteVecBackend {
    pub fn open(path: &str, embedding_dim: usize) -> Result<Self, StorageError> {
        if embedding_dim == 0 {
            return Err(StorageError::Invalid("embedding_dim must be > 0".into()));
        }

        ensure_sqlite_vec_registered();

        if let Some(parent) = Path::new(path).parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    StorageError::Invalid(format!("mkdir {:?}: {}", parent, e))
                })?;
            }
        }

        let flags = OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_URI;
        let conn = Connection::open_with_flags(path, flags).map_err(StorageError::Db)?;

        conn.execute_batch(PRAGMAS)?;
        conn.execute_batch(DDL_MAIN)?;
        conn.execute_batch(&format!(
            "CREATE VIRTUAL TABLE IF NOT EXISTS docs_vec USING vec0(embedding FLOAT[{}]);",
            embedding_dim
        ))?;

        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            embedding_dim,
        })
    }

    fn validate_embedding(&self, emb: &[f32]) -> Result<(), StorageError> {
        if emb.len() != self.embedding_dim {
            return Err(StorageError::DimMismatch {
                got: emb.len(),
                want: self.embedding_dim,
            });
        }
        Ok(())
    }

    fn upsert_one_txn(
        tx: &rusqlite::Transaction<'_>,
        domain: &str,
        doc_id: &str,
        text: &str,
        embedding: &[f32],
        metadata: &serde_json::Value,
        source_hash: &str,
    ) -> Result<i64, StorageError> {
        let meta_json = canonical_json(metadata)?;
        let now = now_iso();
        let blob = serialize_float32(embedding);

        let existing: Option<i64> = tx
            .query_row(
                "SELECT doc_key FROM docs WHERE doc_id = ?1",
                [doc_id],
                |row| row.get::<_, i64>(0),
            )
            .ok();

        let doc_key = match existing {
            None => {
                tx.execute(
                    "INSERT INTO docs(doc_id, domain, text, metadata, source_hash, created_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    rusqlite::params![doc_id, domain, text, meta_json, source_hash, now],
                )?;
                let key = tx.last_insert_rowid();
                tx.execute(
                    "INSERT INTO docs_vec(rowid, embedding) VALUES (?1, ?2)",
                    rusqlite::params![key, blob],
                )?;
                key
            }
            Some(key) => {
                tx.execute(
                    "UPDATE docs SET domain=?1, text=?2, metadata=?3, source_hash=?4 WHERE doc_key=?5",
                    rusqlite::params![domain, text, meta_json, source_hash, key],
                )?;
                tx.execute("DELETE FROM docs_vec WHERE rowid = ?1", [key])?;
                tx.execute(
                    "INSERT INTO docs_vec(rowid, embedding) VALUES (?1, ?2)",
                    rusqlite::params![key, blob],
                )?;
                key
            }
        };
        Ok(doc_key)
    }

    fn row_to_doc(row: &rusqlite::Row<'_>) -> Result<DocRecord, StorageError> {
        let doc_id: String = row.get(0)?;
        let domain: String = row.get(1)?;
        let text: String = row.get(2)?;
        let meta_json: String = row.get(3)?;
        let source_hash: String = row.get::<_, Option<String>>(4)?.unwrap_or_default();
        let emb_blob: Vec<u8> = row.get(5)?;
        let metadata: serde_json::Value = if meta_json.is_empty() {
            serde_json::json!({})
        } else {
            serde_json::from_str(&meta_json).unwrap_or_else(|_| serde_json::json!({}))
        };
        Ok(DocRecord {
            doc_id,
            domain,
            text,
            metadata,
            source_hash,
            embedding: deserialize_float32(&emb_blob),
        })
    }

    // ─────────────────────────────────────────────────────────
    // Sync helpers — the actual work. Each wraps in `*_sync` so the
    // async trait methods can spawn_blocking the exact same body.
    // ─────────────────────────────────────────────────────────

    fn upsert_doc_sync(
        &self,
        domain: &str,
        doc_id: &str,
        text: &str,
        embedding: &[f32],
        metadata: &serde_json::Value,
        source_hash: &str,
    ) -> Result<i64, StorageError> {
        self.validate_embedding(embedding)?;
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        let key = Self::upsert_one_txn(&tx, domain, doc_id, text, embedding, metadata, source_hash)?;
        tx.commit()?;
        Ok(key)
    }

    fn upsert_docs_batch_sync(&self, domain: &str, docs: &[DocRecord]) -> Result<i64, StorageError> {
        if docs.is_empty() {
            return Ok(0);
        }
        for d in docs {
            if d.domain != domain {
                return Err(StorageError::Invalid(format!(
                    "doc {:?} has domain {:?}, batch is for {:?}",
                    d.doc_id, d.domain, domain
                )));
            }
            self.validate_embedding(&d.embedding)?;
        }
        let mut conn = self.conn.lock();
        let tx = conn.transaction()?;
        for d in docs {
            Self::upsert_one_txn(
                &tx, &d.domain, &d.doc_id, &d.text, &d.embedding, &d.metadata, &d.source_hash,
            )?;
        }
        tx.commit()?;
        Ok(docs.len() as i64)
    }

    fn query_similar_sync(
        &self,
        domain: &str,
        query_embedding: &[f32],
        top_k: usize,
        metadata_filter: MetadataFilter<'_>,
    ) -> Result<Vec<DocHit>, StorageError> {
        self.validate_embedding(query_embedding)?;
        let qblob = serialize_float32(query_embedding);
        let (filter_sql, filter_params) = build_filter_sql(metadata_filter)?;

        let sql = format!(
            "SELECT d.doc_id, d.text, d.metadata, vec_distance_cosine(v.embedding, ?) AS dist, \
                    d.created_at \
             FROM docs d JOIN docs_vec v ON v.rowid = d.doc_key \
             WHERE d.domain = ?{filter_sql} \
             ORDER BY dist ASC \
             LIMIT ?"
        );

        let conn = self.conn.lock();
        let mut stmt = conn.prepare(&sql)?;

        let mut all_params: Vec<rusqlite::types::Value> = Vec::new();
        all_params.push(rusqlite::types::Value::Blob(qblob));
        all_params.push(rusqlite::types::Value::Text(domain.to_string()));
        all_params.extend(filter_params);
        all_params.push(rusqlite::types::Value::Integer(top_k as i64));

        let rows = stmt
            .query_map(params_from_iter(all_params.iter()), |row| {
                let doc_id: String = row.get(0)?;
                let text: String = row.get(1)?;
                let meta_json: String = row.get(2)?;
                let dist: f64 = row.get(3)?;
                let created_at: String = row.get::<_, Option<String>>(4)?.unwrap_or_default();
                Ok((doc_id, text, meta_json, dist, created_at))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut hits = Vec::with_capacity(rows.len());
        for (doc_id, text, meta_json, dist, created_at) in rows {
            let metadata = if meta_json.is_empty() {
                serde_json::json!({})
            } else {
                serde_json::from_str(&meta_json).unwrap_or_else(|_| serde_json::json!({}))
            };
            let score = 1.0_f32 - (dist as f32);
            hits.push(DocHit { doc_id, text, metadata, score, created_at });
        }
        Ok(hits)
    }

    fn get_doc_sync(&self, domain: &str, doc_id: &str) -> Result<Option<DocRecord>, StorageError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT d.doc_id, d.domain, d.text, d.metadata, d.source_hash, v.embedding \
             FROM docs d JOIN docs_vec v ON v.rowid = d.doc_key \
             WHERE d.domain = ?1 AND d.doc_id = ?2",
        )?;
        let mut rows = stmt.query(rusqlite::params![domain, doc_id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(Self::row_to_doc(row)?))
        } else {
            Ok(None)
        }
    }

    fn list_docs_sync(
        &self,
        domain: &str,
        limit: i64,
        offset: i64,
        metadata_filter: MetadataFilter<'_>,
    ) -> Result<Vec<DocRecord>, StorageError> {
        let (filter_sql, filter_params) = build_filter_sql(metadata_filter)?;
        let sql = format!(
            "SELECT d.doc_id, d.domain, d.text, d.metadata, d.source_hash, v.embedding \
             FROM docs d JOIN docs_vec v ON v.rowid = d.doc_key \
             WHERE d.domain = ?{filter_sql} \
             ORDER BY d.doc_key DESC \
             LIMIT ? OFFSET ?"
        );
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(&sql)?;

        let mut all_params: Vec<rusqlite::types::Value> = Vec::new();
        all_params.push(rusqlite::types::Value::Text(domain.to_string()));
        all_params.extend(filter_params);
        all_params.push(rusqlite::types::Value::Integer(limit));
        all_params.push(rusqlite::types::Value::Integer(offset));

        let rows = stmt
            .query_map(params_from_iter(all_params.iter()), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    row.get::<_, Vec<u8>>(5)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut out = Vec::with_capacity(rows.len());
        for (doc_id, domain, text, meta_json, source_hash, emb_blob) in rows {
            let metadata = if meta_json.is_empty() {
                serde_json::json!({})
            } else {
                serde_json::from_str(&meta_json).unwrap_or_else(|_| serde_json::json!({}))
            };
            out.push(DocRecord {
                doc_id,
                domain,
                text,
                metadata,
                source_hash,
                embedding: deserialize_float32(&emb_blob),
            });
        }
        Ok(out)
    }

    fn delete_doc_sync(&self, domain: &str, doc_id: &str) -> Result<bool, StorageError> {
        let mut conn = self.conn.lock();
        let key: Option<i64> = conn
            .query_row(
                "SELECT doc_key FROM docs WHERE domain = ?1 AND doc_id = ?2",
                rusqlite::params![domain, doc_id],
                |row| row.get::<_, i64>(0),
            )
            .ok();
        let Some(key) = key else {
            return Ok(false);
        };
        let tx = conn.transaction()?;
        tx.execute("DELETE FROM docs_vec WHERE rowid = ?1", [key])?;
        tx.execute("DELETE FROM docs WHERE doc_key = ?1", [key])?;
        tx.commit()?;
        Ok(true)
    }

    fn delete_domain_sync(&self, domain: &str) -> Result<i64, StorageError> {
        let mut conn = self.conn.lock();
        let keys: Vec<i64> = {
            let mut stmt = conn.prepare("SELECT doc_key FROM docs WHERE domain = ?1")?;
            let iter = stmt.query_map([domain], |row| row.get::<_, i64>(0))?;
            iter.collect::<Result<Vec<_>, _>>()?
        };
        if keys.is_empty() {
            conn.execute("DELETE FROM entity_aliases WHERE domain = ?1", [domain])?;
            conn.execute("DELETE FROM source_imports WHERE domain = ?1", [domain])?;
            return Ok(0);
        }
        let tx = conn.transaction()?;
        let placeholders = std::iter::repeat("?").take(keys.len()).collect::<Vec<_>>().join(",");
        tx.execute(
            &format!("DELETE FROM docs_vec WHERE rowid IN ({})", placeholders),
            params_from_iter(keys.iter()),
        )?;
        tx.execute("DELETE FROM docs WHERE domain = ?1", [domain])?;
        tx.execute("DELETE FROM entity_aliases WHERE domain = ?1", [domain])?;
        tx.execute("DELETE FROM source_imports WHERE domain = ?1", [domain])?;
        tx.commit()?;
        Ok(keys.len() as i64)
    }

    fn list_domains_sync(&self) -> Result<Vec<String>, StorageError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare("SELECT DISTINCT domain FROM docs ORDER BY domain")?;
        let iter = stmt.query_map([], |row| row.get::<_, String>(0))?;
        Ok(iter.collect::<Result<Vec<_>, _>>()?)
    }

    fn domain_stats_sync(&self, domain: &str) -> Result<DomainStats, StorageError> {
        let conn = self.conn.lock();
        let row = conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(LENGTH(text)), 0), MIN(created_at), MAX(created_at) \
             FROM docs WHERE domain = ?1",
            [domain],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            },
        )?;
        Ok(DomainStats {
            domain: domain.to_string(),
            doc_count: row.0,
            total_bytes: row.1,
            oldest_at: row.2,
            newest_at: row.3,
        })
    }

    fn has_source_sync(
        &self,
        domain: &str,
        source_id: &str,
        content_hash: &str,
    ) -> Result<bool, StorageError> {
        let conn = self.conn.lock();
        let found: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM source_imports \
                 WHERE domain = ?1 AND source_id = ?2 AND content_hash = ?3 LIMIT 1",
                rusqlite::params![domain, source_id, content_hash],
                |r| r.get::<_, i64>(0),
            )
            .ok();
        Ok(found.is_some())
    }

    fn record_source_import_sync(
        &self,
        domain: &str,
        source_id: &str,
        content_hash: &str,
        chunks_produced: i64,
    ) -> Result<(), StorageError> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO source_imports(source_id, domain, content_hash, chunks_produced, imported_at) \
             VALUES (?1, ?2, ?3, ?4, ?5) \
             ON CONFLICT(source_id, domain) DO UPDATE SET \
               content_hash = excluded.content_hash, \
               chunks_produced = excluded.chunks_produced, \
               imported_at = excluded.imported_at",
            rusqlite::params![source_id, domain, content_hash, chunks_produced, now_iso()],
        )?;
        Ok(())
    }

    fn upsert_alias_sync(
        &self,
        domain: &str,
        alias: &str,
        canonical: &str,
    ) -> Result<(), StorageError> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO entity_aliases(domain, alias, canonical) VALUES (?1, ?2, ?3) \
             ON CONFLICT(domain, alias) DO UPDATE SET canonical = excluded.canonical",
            rusqlite::params![domain, alias, canonical],
        )?;
        Ok(())
    }

    fn resolve_alias_sync(
        &self,
        domain: &str,
        alias: &str,
    ) -> Result<Option<String>, StorageError> {
        let conn = self.conn.lock();
        let row: Option<String> = conn
            .query_row(
                "SELECT canonical FROM entity_aliases WHERE domain = ?1 AND alias = ?2",
                rusqlite::params![domain, alias],
                |r| r.get::<_, String>(0),
            )
            .ok();
        Ok(row)
    }

    fn list_aliases_sync(&self, domain: &str) -> Result<Vec<(String, String)>, StorageError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT alias, canonical FROM entity_aliases WHERE domain = ?1 ORDER BY alias",
        )?;
        let iter =
            stmt.query_map([domain], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
        Ok(iter.collect::<Result<Vec<_>, _>>()?)
    }

    fn list_unsynced_sync(&self, limit: i64) -> Result<Vec<DocRecord>, StorageError> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT d.doc_id, d.domain, d.text, d.metadata, d.source_hash, v.embedding \
             FROM docs d JOIN docs_vec v ON v.rowid = d.doc_key \
             WHERE d.synced_at IS NULL \
             ORDER BY d.doc_key ASC LIMIT ?1",
        )?;
        let rows = stmt
            .query_map([limit], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    row.get::<_, Vec<u8>>(5)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        let mut out = Vec::with_capacity(rows.len());
        for (doc_id, domain, text, meta_json, source_hash, emb_blob) in rows {
            let metadata = if meta_json.is_empty() {
                serde_json::json!({})
            } else {
                serde_json::from_str(&meta_json).unwrap_or_else(|_| serde_json::json!({}))
            };
            out.push(DocRecord {
                doc_id,
                domain,
                text,
                metadata,
                source_hash,
                embedding: deserialize_float32(&emb_blob),
            });
        }
        Ok(out)
    }

    fn mark_synced_sync(&self, doc_ids: &[String]) -> Result<i64, StorageError> {
        if doc_ids.is_empty() {
            return Ok(0);
        }
        let conn = self.conn.lock();
        let placeholders = std::iter::repeat("?").take(doc_ids.len()).collect::<Vec<_>>().join(",");
        let sql = format!(
            "UPDATE docs SET synced_at = ? WHERE doc_id IN ({})",
            placeholders
        );
        let now = now_iso();
        let mut params: Vec<rusqlite::types::Value> = Vec::with_capacity(doc_ids.len() + 1);
        params.push(rusqlite::types::Value::Text(now));
        for id in doc_ids {
            params.push(rusqlite::types::Value::Text(id.clone()));
        }
        let changed = conn.execute(&sql, params_from_iter(params.iter()))?;
        Ok(changed as i64)
    }

    /// Count docs with `synced_at IS NULL`. Mirrors Python
    /// `pending_sync_count` — not part of the trait (two-tier-only).
    pub fn pending_sync_count(&self) -> Result<i64, StorageError> {
        let conn = self.conn.lock();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM docs WHERE synced_at IS NULL", [], |r| r.get(0))?;
        Ok(count)
    }
}

// ─────────────────────────────────────────────────────────────
// Async trait impl — each method is the sync body on a blocking pool.
// ─────────────────────────────────────────────────────────────

/// Small helper to turn a `JoinError` into a `StorageError`.
fn join_err(e: tokio::task::JoinError) -> StorageError {
    StorageError::Invalid(format!("spawn_blocking join: {e}"))
}

#[async_trait]
impl StorageBackend for SqliteVecBackend {
    async fn upsert_doc(
        &self,
        domain: &str,
        doc_id: &str,
        text: &str,
        embedding: &[f32],
        metadata: &serde_json::Value,
        source_hash: &str,
    ) -> Result<i64, StorageError> {
        let this = self.clone();
        let domain = domain.to_string();
        let doc_id = doc_id.to_string();
        let text = text.to_string();
        let embedding = embedding.to_vec();
        let metadata = metadata.clone();
        let source_hash = source_hash.to_string();
        tokio::task::spawn_blocking(move || {
            this.upsert_doc_sync(&domain, &doc_id, &text, &embedding, &metadata, &source_hash)
        })
        .await
        .map_err(join_err)?
    }

    async fn upsert_docs_batch(
        &self,
        domain: &str,
        docs: &[DocRecord],
    ) -> Result<i64, StorageError> {
        let this = self.clone();
        let domain = domain.to_string();
        let docs = docs.to_vec();
        tokio::task::spawn_blocking(move || this.upsert_docs_batch_sync(&domain, &docs))
            .await
            .map_err(join_err)?
    }

    async fn query_similar(
        &self,
        domain: &str,
        query_embedding: &[f32],
        top_k: usize,
        metadata_filter: MetadataFilter<'_>,
    ) -> Result<Vec<DocHit>, StorageError> {
        let this = self.clone();
        let domain = domain.to_string();
        let query_embedding = query_embedding.to_vec();
        let filter_owned = metadata_filter.cloned();
        tokio::task::spawn_blocking(move || {
            this.query_similar_sync(&domain, &query_embedding, top_k, filter_owned.as_ref())
        })
        .await
        .map_err(join_err)?
    }

    async fn get_doc(
        &self,
        domain: &str,
        doc_id: &str,
    ) -> Result<Option<DocRecord>, StorageError> {
        let this = self.clone();
        let domain = domain.to_string();
        let doc_id = doc_id.to_string();
        tokio::task::spawn_blocking(move || this.get_doc_sync(&domain, &doc_id))
            .await
            .map_err(join_err)?
    }

    async fn list_docs(
        &self,
        domain: &str,
        limit: i64,
        offset: i64,
        metadata_filter: MetadataFilter<'_>,
    ) -> Result<Vec<DocRecord>, StorageError> {
        let this = self.clone();
        let domain = domain.to_string();
        let filter_owned = metadata_filter.cloned();
        tokio::task::spawn_blocking(move || {
            this.list_docs_sync(&domain, limit, offset, filter_owned.as_ref())
        })
        .await
        .map_err(join_err)?
    }

    async fn delete_doc(&self, domain: &str, doc_id: &str) -> Result<bool, StorageError> {
        let this = self.clone();
        let domain = domain.to_string();
        let doc_id = doc_id.to_string();
        tokio::task::spawn_blocking(move || this.delete_doc_sync(&domain, &doc_id))
            .await
            .map_err(join_err)?
    }

    async fn delete_domain(&self, domain: &str) -> Result<i64, StorageError> {
        let this = self.clone();
        let domain = domain.to_string();
        tokio::task::spawn_blocking(move || this.delete_domain_sync(&domain))
            .await
            .map_err(join_err)?
    }

    async fn list_domains(&self) -> Result<Vec<String>, StorageError> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || this.list_domains_sync())
            .await
            .map_err(join_err)?
    }

    async fn domain_stats(&self, domain: &str) -> Result<DomainStats, StorageError> {
        let this = self.clone();
        let domain = domain.to_string();
        tokio::task::spawn_blocking(move || this.domain_stats_sync(&domain))
            .await
            .map_err(join_err)?
    }

    async fn has_source(
        &self,
        domain: &str,
        source_id: &str,
        content_hash: &str,
    ) -> Result<bool, StorageError> {
        let this = self.clone();
        let domain = domain.to_string();
        let source_id = source_id.to_string();
        let content_hash = content_hash.to_string();
        tokio::task::spawn_blocking(move || this.has_source_sync(&domain, &source_id, &content_hash))
            .await
            .map_err(join_err)?
    }

    async fn record_source_import(
        &self,
        domain: &str,
        source_id: &str,
        content_hash: &str,
        chunks_produced: i64,
    ) -> Result<(), StorageError> {
        let this = self.clone();
        let domain = domain.to_string();
        let source_id = source_id.to_string();
        let content_hash = content_hash.to_string();
        tokio::task::spawn_blocking(move || {
            this.record_source_import_sync(&domain, &source_id, &content_hash, chunks_produced)
        })
        .await
        .map_err(join_err)?
    }

    async fn upsert_alias(
        &self,
        domain: &str,
        alias: &str,
        canonical: &str,
    ) -> Result<(), StorageError> {
        let this = self.clone();
        let domain = domain.to_string();
        let alias = alias.to_string();
        let canonical = canonical.to_string();
        tokio::task::spawn_blocking(move || this.upsert_alias_sync(&domain, &alias, &canonical))
            .await
            .map_err(join_err)?
    }

    async fn resolve_alias(
        &self,
        domain: &str,
        alias: &str,
    ) -> Result<Option<String>, StorageError> {
        let this = self.clone();
        let domain = domain.to_string();
        let alias = alias.to_string();
        tokio::task::spawn_blocking(move || this.resolve_alias_sync(&domain, &alias))
            .await
            .map_err(join_err)?
    }

    async fn list_aliases(&self, domain: &str) -> Result<Vec<(String, String)>, StorageError> {
        let this = self.clone();
        let domain = domain.to_string();
        tokio::task::spawn_blocking(move || this.list_aliases_sync(&domain))
            .await
            .map_err(join_err)?
    }

    async fn list_unsynced(&self, limit: i64) -> Result<Vec<DocRecord>, StorageError> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || this.list_unsynced_sync(limit))
            .await
            .map_err(join_err)?
    }

    async fn mark_synced(&self, doc_ids: &[String]) -> Result<i64, StorageError> {
        let this = self.clone();
        let doc_ids = doc_ids.to_vec();
        tokio::task::spawn_blocking(move || this.mark_synced_sync(&doc_ids))
            .await
            .map_err(join_err)?
    }
}
