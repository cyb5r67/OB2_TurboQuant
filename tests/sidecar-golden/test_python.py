"""Run every golden fixture through the Python sidecar, compare via comparator.

Each fixture line is:
    {"name": "descriptive-name",
     "seed": [{"method": "...", "params": {...}}, ...],   # optional setup calls
     "request": {"method": "...", "params": {...}},
     "expected": {...}}                                    # content of .result
"""
from __future__ import annotations
import json
import pathlib
import pytest

from comparator import compare
from sidecar_client import SidecarClient

FIXTURES_DIR = pathlib.Path(__file__).parent / "fixtures"


def _iter_fixtures():
    for path in sorted(FIXTURES_DIR.glob("*.jsonl")):
        with open(path) as f:
            for i, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                fx = json.loads(line)
                yield pytest.param(fx, id=f"{path.stem}:{fx.get('name', i)}")


@pytest.mark.parametrize("fx", list(_iter_fixtures()))
def test_python_sidecar(fx, tmp_path):
    sqlite_path = tmp_path / "ob2.db"
    with SidecarClient(sqlite_path=sqlite_path) as client:
        for setup in fx.get("seed", []):
            resp = client.call(setup["method"], setup["params"])
            assert "error" not in resp, f"seed failed: {resp.get('error')}"
        resp = client.call(fx["request"]["method"], fx["request"]["params"])
        assert "error" not in resp, f"request failed: {resp.get('error')}"
        diffs = compare(resp["result"], fx["expected"])
        assert not diffs, "\n".join(diffs)
