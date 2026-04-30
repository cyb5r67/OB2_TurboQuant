"""Run every golden fixture through the Rust sidecar, compare via comparator.

Mirrors `test_python.py` but targets the Rust binary. Both runtimes must
pass the same fixture set for the sidecar swap (Task 10) to be safe.

Task 8 — parametrized over storage backends:
  * `sqlite`   — always runs (tempfile-backed, no external deps)
  * `pgvector` — runs iff `OB2_PG_URL_TEST` is set. Must point at an empty
                 (or disposable) pgvector Postgres; the fixture drops and
                 recreates the `docs`, `source_imports`, `entity_aliases`
                 tables before each test to isolate state.

Task 9 — also runs `two-tier` when `OB2_PG_URL_TEST` is set. The sync
worker is dialled down to `OB2_SYNC_INTERVAL_SEC=1` and its background
drain happens transparently — reads fall back to tier-1 whenever the
pgvector side hasn't caught up yet, so the existing fixtures pass
unchanged (except `sync_status`, whose expected shape is backend-aware).
"""
from __future__ import annotations
import json
import os
import pathlib
import time

import pytest

from comparator import compare
from rust_sidecar_client import RustSidecarClient

FIXTURES_DIR = pathlib.Path(__file__).parent / "fixtures"

BACKENDS = ["sqlite"]
PG_URL_TEST = os.environ.get("OB2_PG_URL_TEST")
if PG_URL_TEST:
    BACKENDS.extend(["pgvector", "two-tier"])


def _iter_fixtures():
    for path in sorted(FIXTURES_DIR.glob("*.jsonl")):
        with open(path) as f:
            for i, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                fx = json.loads(line)
                yield pytest.param(fx, id=f"{path.stem}:{fx.get('name', i)}")


def _reset_pgvector(url: str) -> None:
    """Drop + recreate the three tables so each fixture starts clean.

    The Rust sidecar re-runs the full DDL on startup (CREATE ... IF NOT
    EXISTS), so dropping here is safe — the sidecar will recreate them
    before serving any requests.
    """
    import psycopg  # type: ignore

    with psycopg.connect(url, connect_timeout=5, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute("DROP TABLE IF EXISTS docs CASCADE")
            cur.execute("DROP TABLE IF EXISTS source_imports CASCADE")
            cur.execute("DROP TABLE IF EXISTS entity_aliases CASCADE")


@pytest.mark.parametrize("backend", BACKENDS)
@pytest.mark.parametrize("fx", list(_iter_fixtures()))
def test_rust_sidecar(backend, fx, tmp_path):
    extra_env: dict[str, str] = {}
    sqlite_path = tmp_path / "ob2.db"

    if backend in ("pgvector", "two-tier"):
        assert PG_URL_TEST, (
            f"{backend} parametrize should only run when OB2_PG_URL_TEST is set"
        )
        _reset_pgvector(PG_URL_TEST)
        extra_env["OB2_PG_URL"] = PG_URL_TEST
    if backend == "two-tier":
        # Dial the sync worker all the way down so seed captures drain
        # before the request under test reads them.
        extra_env["OB2_SYNC_INTERVAL_SEC"] = "1"
        extra_env["OB2_SYNC_BATCH_THRESHOLD"] = "32"

    request_method = fx["request"]["method"]
    expected = fx["expected"]

    # sync_status has a backend-specific response shape: sqlite + pgvector
    # return {"error": "not in two-tier mode"}, two-tier returns the live
    # worker status (whose fields are timing-sensitive). For two-tier just
    # assert on the stable shape (keys present, types sane).
    if request_method == "sync_status" and backend == "two-tier":
        with RustSidecarClient(
            sqlite_path=sqlite_path,
            storage_backend=backend,
            extra_env=extra_env,
        ) as client:
            resp = client.call("sync_status", {})
            assert "error" not in resp, f"sync_status failed: {resp.get('error')}"
            r = resp["result"]
            assert "error" not in r, f"two-tier sync_status should not error, got {r}"
            # Stable keys — Python's `SyncWorker.status()` shape.
            for key in (
                "pending_docs",
                "last_sync_at",
                "last_sync_docs",
                "last_sync_ms",
                "pgvector_reachable",
            ):
                assert key in r, f"sync_status missing {key}: {r}"
            assert isinstance(r["pending_docs"], int)
            assert isinstance(r["pgvector_reachable"], bool)
        return

    # The `ping` fixture hard-codes `backend: "sqlite"`. Normalise the
    # expected backend name to whichever backend this parametrize leg is
    # running against — everything else in the fixture must still match
    # byte-exact.
    if isinstance(expected, dict) and "backend" in expected:
        expected = {**expected, "backend": backend}

    with RustSidecarClient(
        sqlite_path=sqlite_path,
        storage_backend=backend,
        extra_env=extra_env,
    ) as client:
        for setup in fx.get("seed", []):
            resp = client.call(setup["method"], setup["params"])
            assert "error" not in resp, f"seed failed: {resp.get('error')}"
        # On two-tier, give the sync worker a moment to drain seed captures
        # into pgvector so reads served by tier-2 see them. If they haven't
        # drained yet the backend's read path falls back to tier-1 anyway,
        # but the brief wait stabilises responses that depend on pgvector's
        # canonical ordering (e.g. `created_at DESC`).
        if backend == "two-tier" and fx.get("seed"):
            time.sleep(1.2)
        resp = client.call(fx["request"]["method"], fx["request"]["params"])
        assert "error" not in resp, f"request failed: {resp.get('error')}"
        diffs = compare(resp["result"], expected)
        assert not diffs, "\n".join(diffs)
