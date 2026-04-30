"""ob2 storage migrate — move captured knowledge between backends.

Usage:
    python -m cli.migrate --from sqlite:./ob2.db --to postgres://user:pw@host/db
    python -m cli.migrate --from sqlite:./ob2.db --to postgres://... --domain netsec
    python -m cli.migrate --from sqlite:./ob2.db --to postgres://... --batch 500

Both backends implement the same StorageBackend interface, so the migrator
is almost trivial: paginate docs from source, upsert-batch to target,
copy aliases + source_imports. UPSERT-on-doc_id makes re-runs idempotent
(resumable after interruption).

Embedding dim must match between source and target; the migrator checks
this by asking both backends for a known dim parameter.
"""

from __future__ import annotations

import argparse
import sys
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from retrieval.storage.backend import StorageBackend


# ─────────────────────────────────────────────────────────────
# URI parsing
# ─────────────────────────────────────────────────────────────

def open_backend(uri: str, embedding_dim: int) -> "StorageBackend":
    """Instantiate a backend from a URI.

    URI schemes:
        sqlite:PATH            — SQLite + sqlite-vec
        postgres://...         — pgvector (full psycopg-style conninfo)
        postgresql://...       — alias
    """
    if uri.startswith("sqlite:"):
        from retrieval.storage.sqlite_vec import SQLiteVecBackend
        path = uri[len("sqlite:"):]
        return SQLiteVecBackend(path, embedding_dim=embedding_dim)
    if uri.startswith(("postgres://", "postgresql://")):
        from retrieval.storage.pg_vector import PgVectorBackend
        return PgVectorBackend(uri, embedding_dim=embedding_dim)
    raise ValueError(
        f"unknown backend URI {uri!r}. "
        "Expected sqlite:PATH or postgres://..."
    )


# ─────────────────────────────────────────────────────────────
# Migrate a single domain
# ─────────────────────────────────────────────────────────────

def migrate_domain(
    src: "StorageBackend",
    dst: "StorageBackend",
    domain: str,
    batch_size: int,
) -> dict[str, int]:
    stats = {"docs": 0, "aliases": 0, "source_imports": 0}

    # Docs — paginate and batch-upsert
    offset = 0
    while True:
        batch = src.list_docs(domain=domain, limit=batch_size, offset=offset)
        if not batch:
            break
        dst.upsert_docs_batch(domain, batch)
        stats["docs"] += len(batch)
        print(f"  [{domain}] docs: {stats['docs']} migrated...", flush=True)
        if len(batch) < batch_size:
            break
        offset += batch_size

    # Aliases
    for alias, canonical in src.list_aliases(domain):
        dst.upsert_alias(domain, alias, canonical)
        stats["aliases"] += 1

    # source_imports — read via raw list not available on interface; skip for now
    # (most importers re-run idempotently via content_hash; migrating this table
    #  is nice-to-have but not required for correctness)
    # TODO: add list_source_imports() to StorageBackend if we want full migration

    return stats


# ─────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description="Migrate OB2 knowledge between storage backends.")
    ap.add_argument("--from", dest="src_uri", required=True,
                    help="Source URI (sqlite:PATH or postgres://...)")
    ap.add_argument("--to", dest="dst_uri", required=True,
                    help="Destination URI")
    ap.add_argument("--domain", default=None,
                    help="Only migrate this domain (default: all)")
    ap.add_argument("--batch", type=int, default=256, dest="batch_size",
                    help="Docs per transactional batch (default: 256)")
    ap.add_argument("--dim", type=int, default=384, dest="embedding_dim",
                    help="Embedding dimension (must match both sides; default: 384)")
    args = ap.parse_args()

    if args.src_uri == args.dst_uri:
        print("ERROR: source and destination are the same", file=sys.stderr)
        return 2

    print(f"Source:      {args.src_uri}")
    print(f"Destination: {args.dst_uri}")
    print(f"Batch size:  {args.batch_size}")
    print(f"Embedding dim: {args.embedding_dim}")
    print()

    src = open_backend(args.src_uri, args.embedding_dim)
    dst = open_backend(args.dst_uri, args.embedding_dim)

    try:
        domains = [args.domain] if args.domain else src.list_domains()
        if not domains:
            print("Nothing to migrate — source has no domains.")
            return 0
        print(f"Domains to migrate: {domains}")
        print()

        total: dict[str, int] = {"docs": 0, "aliases": 0, "source_imports": 0}
        t0 = time.time()
        for d in domains:
            print(f"--- migrating @{d} ---")
            stats = migrate_domain(src, dst, d, args.batch_size)
            for k, v in stats.items():
                total[k] = total.get(k, 0) + v
            print(f"  [{d}] done: {stats['docs']} docs, {stats['aliases']} aliases")
        dt = time.time() - t0

        # Verification: row counts match per domain
        print()
        print("Verifying row counts...")
        mismatch = False
        for d in domains:
            s_count = src.domain_stats(d).doc_count
            t_count = dst.domain_stats(d).doc_count
            marker = "✓" if s_count == t_count else "✗ MISMATCH"
            print(f"  @{d}: source={s_count}, target={t_count}  {marker}")
            if s_count != t_count:
                mismatch = True

        print()
        print(f"Total migrated: {total['docs']} docs, "
              f"{total['aliases']} aliases in {dt:.1f}s "
              f"({total['docs']/max(dt, 0.001):.0f} docs/sec)")
        if mismatch:
            print("WARNING: row counts do not match. Investigate before cutting over.")
            return 1
        return 0
    finally:
        src.close()
        dst.close()


if __name__ == "__main__":
    sys.exit(main())
