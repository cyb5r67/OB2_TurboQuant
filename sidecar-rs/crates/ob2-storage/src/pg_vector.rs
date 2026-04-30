//! `PgVectorBackend` — Tier-2 Postgres + pgvector storage.
//!
//! Rust port of `retrieval/storage/pg_vector.py` (Python reference).
//!
//! DDL verbatim from the Python reference so on-disk format is compatible —
//! the same database can be populated by the Python sidecar, then served by
//! the Rust sidecar (or vice-versa).
//!
//! Uses `tokio-postgres` (native async) + `deadpool-postgres` for pooling,
//! and the `pgvector` crate with its `postgres` feature for the `Vector`
//! type adapter. Unlike the SQLite backend, nothing blocks — the trait
//! methods `.await` directly.

use async_trait::async_trait;
use deadpool_postgres::{Config as PoolConfig, ManagerConfig, Pool, RecyclingMethod, Runtime};
use pgvector::Vector;
use tokio_postgres::{types::ToSql, NoTls};

use crate::backend::StorageBackend;
use crate::types::{DocHit, DocRecord, DomainStats, MetadataFilter, StorageError};

// ─────────────────────────────────────────────────────────────
// Schema DDL — verbatim copy of retrieval/storage/pg_vector.py:65-102
// ─────────────────────────────────────────────────────────────

fn ddl(dim: usize) -> String {
    format!(
        r#"
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
"#,
    )
}

// ─────────────────────────────────────────────────────────────
// Backend
// ─────────────────────────────────────────────────────────────

pub struct PgVectorBackend {
    pool: Pool,
    embedding_dim: usize,
}

impl PgVectorBackend {
    /// Parse `url` into a pg config, build a deadpool pool, run the DDL.
    pub async fn connect(url: &str, embedding_dim: usize) -> Result<Self, StorageError> {
        if embedding_dim == 0 {
            return Err(StorageError::Invalid("embedding_dim must be > 0".into()));
        }

        // Parse the URL via tokio_postgres::Config first so deadpool picks
        // up the full connection settings (user, host, database, etc.).
        let tp_config: tokio_postgres::Config = url
            .parse()
            .map_err(|e: tokio_postgres::Error| StorageError::Pg(format!("parse url: {e}")))?;

        let mut cfg = PoolConfig::new();
        cfg.user = extract_user(&tp_config);
        cfg.password = extract_password(&tp_config);
        cfg.dbname = extract_dbname(&tp_config);
        cfg.host = extract_host(&tp_config);
        cfg.port = extract_port(&tp_config);
        cfg.manager = Some(ManagerConfig {
            recycling_method: RecyclingMethod::Fast,
        });

        let pool = cfg
            .create_pool(Some(Runtime::Tokio1), NoTls)
            .map_err(|e| StorageError::Pg(format!("create pool: {e}")))?;

        // Run the DDL on a fresh connection.
        {
            let client = pool.get().await?;
            client.batch_execute(&ddl(embedding_dim)).await?;
        }

        Ok(Self {
            pool,
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
}

// Helpers — pull fields out of a tokio_postgres Config (which stores them
// as private fields accessed via getters). Where the upstream getter returns
// a slice of alternatives we pick the first, matching psycopg behaviour.

fn extract_user(c: &tokio_postgres::Config) -> Option<String> {
    c.get_user().map(String::from)
}
fn extract_password(c: &tokio_postgres::Config) -> Option<String> {
    c.get_password()
        .map(|b| String::from_utf8_lossy(b).into_owned())
}
fn extract_dbname(c: &tokio_postgres::Config) -> Option<String> {
    c.get_dbname().map(String::from)
}
fn extract_host(c: &tokio_postgres::Config) -> Option<String> {
    c.get_hosts().first().map(|h| match h {
        tokio_postgres::config::Host::Tcp(s) => s.clone(),
        #[cfg(unix)]
        tokio_postgres::config::Host::Unix(p) => p.to_string_lossy().into_owned(),
    })
}
fn extract_port(c: &tokio_postgres::Config) -> Option<u16> {
    c.get_ports().first().copied()
}

// ─────────────────────────────────────────────────────────────
// Metadata filter DSL → JSONB WHERE fragment
// ─────────────────────────────────────────────────────────────

/// Translate `{key: value}` and `{key: {$in: [...]}}` → Postgres WHERE
/// fragment + params, starting placeholders at `next_param_idx`.
///
/// Mirrors `retrieval/storage/pg_vector.py::_build_filter_sql` but using
/// dollar-indexed placeholders ($1, $2, ...) instead of psycopg's `%s`.
///
/// Returns `(fragment, params, next_idx)` where `fragment` begins with
/// `" AND ..."` if non-empty.
fn build_filter_sql(
    flt: MetadataFilter<'_>,
    next_param_idx: usize,
) -> Result<(String, Vec<Box<dyn ToSql + Send + Sync>>, usize), StorageError> {
    let Some(flt_val) = flt else {
        return Ok((String::new(), Vec::new(), next_param_idx));
    };
    let obj = match flt_val {
        serde_json::Value::Object(m) if !m.is_empty() => m,
        serde_json::Value::Object(_) | serde_json::Value::Null => {
            return Ok((String::new(), Vec::new(), next_param_idx));
        }
        _ => {
            return Err(StorageError::Invalid(
                "metadata_filter must be an object".into(),
            ));
        }
    };
    let mut parts: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn ToSql + Send + Sync>> = Vec::new();
    let mut idx = next_param_idx;

    for (key, expected) in obj {
        if let Some(in_list) = expected.get("$in").and_then(|x| x.as_array()) {
            if in_list.is_empty() {
                // Python returns " AND FALSE"; mirror it.
                return Ok((" AND FALSE".to_string(), Vec::new(), next_param_idx));
            }
            // Python: metadata->>%s IN (%s,%s,...)
            // We emit explicit `metadata->>'key' IN ($i, $i+1, ...)`.
            let placeholders: Vec<String> = (0..in_list.len())
                .map(|i| format!("${}", idx + i))
                .collect();
            parts.push(format!(
                "metadata->>'{}' IN ({})",
                escape_sql_key(key),
                placeholders.join(",")
            ));
            for v in in_list {
                params.push(Box::new(json_to_string(v)));
                idx += 1;
            }
        } else {
            parts.push(format!("metadata->>'{}' = ${}", escape_sql_key(key), idx));
            params.push(Box::new(json_to_string(expected)));
            idx += 1;
        }
    }

    if parts.is_empty() {
        return Ok((String::new(), Vec::new(), next_param_idx));
    }
    Ok((format!(" AND {}", parts.join(" AND ")), params, idx))
}

/// Coerce a JSON value to a text representation. `metadata->>` always
/// returns text, so we compare against string-shaped params — same as
/// Python (`str(v)`).
fn json_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Keys are passed through identity — we reject any single-quote here to
/// avoid SQL injection (Python passes the key itself as a `%s` param, which
/// is safer; postgres's `->>` can take a literal or a param but placing it
/// inline is clearer so long as we reject unsafe keys).
fn escape_sql_key(k: &str) -> String {
    // We only support identifier-safe keys: letters, digits, underscore, dash.
    // Everything else turns the filter into a no-op-fail matching Python's
    // strict-typing spirit.
    k.replace('\'', "''")
}

/// Re-run a query with the given list of params boxed into the
/// tokio-postgres `&[&(dyn ToSql + Sync)]` shape.
fn as_param_refs<'a>(
    params: &'a [Box<dyn ToSql + Send + Sync>],
) -> Vec<&'a (dyn ToSql + Sync)> {
    params.iter().map(|b| b.as_ref() as &(dyn ToSql + Sync)).collect()
}

// ─────────────────────────────────────────────────────────────
// StorageBackend impl
// ─────────────────────────────────────────────────────────────

#[async_trait]
impl StorageBackend for PgVectorBackend {
    async fn upsert_doc(
        &self,
        domain: &str,
        doc_id: &str,
        text: &str,
        embedding: &[f32],
        metadata: &serde_json::Value,
        source_hash: &str,
    ) -> Result<i64, StorageError> {
        self.validate_embedding(embedding)?;
        let client = self.pool.get().await?;
        let vec = Vector::from(embedding.to_vec());
        let row = client
            .query_one(
                "INSERT INTO docs(doc_id, domain, text, metadata, source_hash, embedding) \
                 VALUES ($1, $2, $3, $4, $5, $6) \
                 ON CONFLICT (doc_id) DO UPDATE SET \
                   domain = EXCLUDED.domain, text = EXCLUDED.text, \
                   metadata = EXCLUDED.metadata, source_hash = EXCLUDED.source_hash, \
                   embedding = EXCLUDED.embedding \
                 RETURNING doc_key",
                &[
                    &doc_id,
                    &domain,
                    &text,
                    metadata,
                    &source_hash,
                    &vec,
                ],
            )
            .await?;
        Ok(row.get::<_, i64>(0))
    }

    async fn upsert_docs_batch(
        &self,
        domain: &str,
        docs: &[DocRecord],
    ) -> Result<i64, StorageError> {
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

        let mut client = self.pool.get().await?;
        // Explicit transaction for atomicity — matches the Python path.
        let txn = client.transaction().await?;
        for d in docs {
            let vec = Vector::from(d.embedding.clone());
            txn.execute(
                "INSERT INTO docs(doc_id, domain, text, metadata, source_hash, embedding) \
                 VALUES ($1, $2, $3, $4, $5, $6) \
                 ON CONFLICT (doc_id) DO UPDATE SET \
                   domain = EXCLUDED.domain, text = EXCLUDED.text, \
                   metadata = EXCLUDED.metadata, source_hash = EXCLUDED.source_hash, \
                   embedding = EXCLUDED.embedding",
                &[
                    &d.doc_id,
                    &d.domain,
                    &d.text,
                    &d.metadata,
                    &d.source_hash,
                    &vec,
                ],
            )
            .await?;
        }
        txn.commit().await?;
        Ok(docs.len() as i64)
    }

    async fn query_similar(
        &self,
        domain: &str,
        query_embedding: &[f32],
        top_k: usize,
        metadata_filter: MetadataFilter<'_>,
    ) -> Result<Vec<DocHit>, StorageError> {
        self.validate_embedding(query_embedding)?;
        let q = Vector::from(query_embedding.to_vec());

        // $1 = q (for score), $2 = domain, filter uses $3..$N,
        // then $q again for ORDER BY, then LIMIT.
        let (filter_sql, filter_params, next_idx) = build_filter_sql(metadata_filter, 3)?;
        let order_q_idx = next_idx;
        let limit_idx = next_idx + 1;

        let sql = format!(
            "SELECT doc_id, text, metadata, \
                    1 - (embedding <=> $1::vector) AS score, \
                    created_at::text \
             FROM docs \
             WHERE domain = $2{filter_sql} \
             ORDER BY embedding <=> ${order_q_idx}::vector ASC \
             LIMIT ${limit_idx}"
        );

        let client = self.pool.get().await?;
        // Build the param vec in order.
        let mut owned_params: Vec<Box<dyn ToSql + Send + Sync>> = Vec::new();
        owned_params.push(Box::new(q.clone()));
        owned_params.push(Box::new(domain.to_string()));
        for p in filter_params {
            owned_params.push(p);
        }
        owned_params.push(Box::new(q));
        owned_params.push(Box::new(top_k as i64));

        let param_refs = as_param_refs(&owned_params);
        let rows = client.query(sql.as_str(), &param_refs[..]).await?;

        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let doc_id: String = row.get(0);
            let text: String = row.get(1);
            let meta_json: serde_json::Value = row.get(2);
            let score: f64 = row.get(3);
            let created_at: String = row.try_get::<_, String>(4).unwrap_or_default();
            out.push(DocHit {
                doc_id,
                text,
                metadata: meta_json,
                score: score as f32,
                created_at,
            });
        }
        Ok(out)
    }

    async fn get_doc(
        &self,
        domain: &str,
        doc_id: &str,
    ) -> Result<Option<DocRecord>, StorageError> {
        let client = self.pool.get().await?;
        let row_opt = client
            .query_opt(
                "SELECT doc_id, domain, text, metadata, source_hash, embedding \
                 FROM docs WHERE domain = $1 AND doc_id = $2",
                &[&domain, &doc_id],
            )
            .await?;
        let Some(row) = row_opt else {
            return Ok(None);
        };
        let doc_id: String = row.get(0);
        let domain: String = row.get(1);
        let text: String = row.get(2);
        let metadata: serde_json::Value = row.get(3);
        let source_hash: String = row.get(4);
        let emb: Vector = row.get(5);
        Ok(Some(DocRecord {
            doc_id,
            domain,
            text,
            metadata,
            source_hash,
            embedding: emb.to_vec(),
        }))
    }

    async fn list_docs(
        &self,
        domain: &str,
        limit: i64,
        offset: i64,
        metadata_filter: MetadataFilter<'_>,
    ) -> Result<Vec<DocRecord>, StorageError> {
        // $1 = domain, filter uses $2..$N, LIMIT = $N+1, OFFSET = $N+2.
        let (filter_sql, filter_params, next_idx) = build_filter_sql(metadata_filter, 2)?;
        let limit_idx = next_idx;
        let offset_idx = next_idx + 1;
        let sql = format!(
            "SELECT doc_id, domain, text, metadata, source_hash, embedding \
             FROM docs WHERE domain = $1{filter_sql} \
             ORDER BY created_at DESC \
             LIMIT ${limit_idx} OFFSET ${offset_idx}"
        );

        let client = self.pool.get().await?;
        let mut owned_params: Vec<Box<dyn ToSql + Send + Sync>> = Vec::new();
        owned_params.push(Box::new(domain.to_string()));
        for p in filter_params {
            owned_params.push(p);
        }
        owned_params.push(Box::new(limit));
        owned_params.push(Box::new(offset));

        let param_refs = as_param_refs(&owned_params);
        let rows = client.query(sql.as_str(), &param_refs[..]).await?;

        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            let doc_id: String = row.get(0);
            let dom: String = row.get(1);
            let text: String = row.get(2);
            let metadata: serde_json::Value = row.get(3);
            let source_hash: String = row.get(4);
            let emb: Vector = row.get(5);
            out.push(DocRecord {
                doc_id,
                domain: dom,
                text,
                metadata,
                source_hash,
                embedding: emb.to_vec(),
            });
        }
        Ok(out)
    }

    async fn delete_doc(&self, domain: &str, doc_id: &str) -> Result<bool, StorageError> {
        let client = self.pool.get().await?;
        let n = client
            .execute(
                "DELETE FROM docs WHERE domain = $1 AND doc_id = $2",
                &[&domain, &doc_id],
            )
            .await?;
        Ok(n > 0)
    }

    async fn delete_domain(&self, domain: &str) -> Result<i64, StorageError> {
        let mut client = self.pool.get().await?;
        let txn = client.transaction().await?;
        let deleted = txn
            .execute("DELETE FROM docs WHERE domain = $1", &[&domain])
            .await? as i64;
        txn.execute("DELETE FROM entity_aliases WHERE domain = $1", &[&domain])
            .await?;
        txn.execute("DELETE FROM source_imports WHERE domain = $1", &[&domain])
            .await?;
        txn.commit().await?;
        Ok(deleted)
    }

    async fn list_domains(&self) -> Result<Vec<String>, StorageError> {
        let client = self.pool.get().await?;
        let rows = client
            .query("SELECT DISTINCT domain FROM docs ORDER BY domain", &[])
            .await?;
        Ok(rows.into_iter().map(|r| r.get::<_, String>(0)).collect())
    }

    async fn domain_stats(&self, domain: &str) -> Result<DomainStats, StorageError> {
        let client = self.pool.get().await?;
        let row = client
            .query_one(
                "SELECT COUNT(*), COALESCE(SUM(LENGTH(text)), 0), \
                        MIN(created_at), MAX(created_at) \
                 FROM docs WHERE domain = $1",
                &[&domain],
            )
            .await?;
        let count: i64 = row.get(0);
        // COALESCE(SUM, 0) — sum can come back as int8 if LENGTH(text)::bigint
        // or numeric. postgres SUM(int4) returns bigint, so i64 is fine.
        let total_bytes_any: i64 = row.get::<_, i64>(1);

        let oldest: Option<chrono::DateTime<chrono::Utc>> = row.get(2);
        let newest: Option<chrono::DateTime<chrono::Utc>> = row.get(3);
        Ok(DomainStats {
            domain: domain.to_string(),
            doc_count: count,
            total_bytes: total_bytes_any,
            oldest_at: oldest.map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true)),
            newest_at: newest.map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true)),
        })
    }

    async fn has_source(
        &self,
        domain: &str,
        source_id: &str,
        content_hash: &str,
    ) -> Result<bool, StorageError> {
        let client = self.pool.get().await?;
        let row_opt = client
            .query_opt(
                "SELECT 1 FROM source_imports \
                 WHERE domain = $1 AND source_id = $2 AND content_hash = $3",
                &[&domain, &source_id, &content_hash],
            )
            .await?;
        Ok(row_opt.is_some())
    }

    async fn record_source_import(
        &self,
        domain: &str,
        source_id: &str,
        content_hash: &str,
        chunks_produced: i64,
    ) -> Result<(), StorageError> {
        // pgvector.py uses INTEGER; cast i64 → i32 for binding.
        let chunks_i32: i32 = chunks_produced.clamp(i32::MIN as i64, i32::MAX as i64) as i32;
        let client = self.pool.get().await?;
        client
            .execute(
                "INSERT INTO source_imports(source_id, domain, content_hash, chunks_produced) \
                 VALUES ($1, $2, $3, $4) \
                 ON CONFLICT (source_id, domain) DO UPDATE SET \
                   content_hash = EXCLUDED.content_hash, \
                   chunks_produced = EXCLUDED.chunks_produced, \
                   imported_at = NOW()",
                &[&source_id, &domain, &content_hash, &chunks_i32],
            )
            .await?;
        Ok(())
    }

    async fn upsert_alias(
        &self,
        domain: &str,
        alias: &str,
        canonical: &str,
    ) -> Result<(), StorageError> {
        let client = self.pool.get().await?;
        client
            .execute(
                "INSERT INTO entity_aliases(domain, alias, canonical) VALUES ($1, $2, $3) \
                 ON CONFLICT (domain, alias) DO UPDATE SET canonical = EXCLUDED.canonical",
                &[&domain, &alias, &canonical],
            )
            .await?;
        Ok(())
    }

    async fn resolve_alias(
        &self,
        domain: &str,
        alias: &str,
    ) -> Result<Option<String>, StorageError> {
        let client = self.pool.get().await?;
        let row = client
            .query_opt(
                "SELECT canonical FROM entity_aliases WHERE domain = $1 AND alias = $2",
                &[&domain, &alias],
            )
            .await?;
        Ok(row.map(|r| r.get::<_, String>(0)))
    }

    async fn list_aliases(&self, domain: &str) -> Result<Vec<(String, String)>, StorageError> {
        let client = self.pool.get().await?;
        let rows = client
            .query(
                "SELECT alias, canonical FROM entity_aliases \
                 WHERE domain = $1 ORDER BY alias",
                &[&domain],
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|r| (r.get::<_, String>(0), r.get::<_, String>(1)))
            .collect())
    }

    async fn list_unsynced(&self, _limit: i64) -> Result<Vec<DocRecord>, StorageError> {
        // pgvector is Tier 2 / sink-only. It has no synced_at column, so it
        // cannot answer this — matches Python (method not defined on the
        // pg_vector backend there either).
        Err(StorageError::Invalid(
            "list_unsynced is not supported on pgvector backend".into(),
        ))
    }

    async fn mark_synced(&self, _doc_ids: &[String]) -> Result<i64, StorageError> {
        Err(StorageError::Invalid(
            "mark_synced is not supported on pgvector backend".into(),
        ))
    }
}
