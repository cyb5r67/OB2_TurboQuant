"""Fixture comparison shared by Python + Rust harnesses.

Redacts timestamp fields, applies float tolerance to score-like fields.
Everything else must match byte-exact.
"""
from __future__ import annotations
import math
from typing import Any

TIMESTAMP_KEYS = {"at", "last_sync_at", "oldest_at", "newest_at", "imported_at", "created_at"}
FLOAT_TOLERANCE = 1e-4


def redact_timestamps(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: (None if k in TIMESTAMP_KEYS else redact_timestamps(v)) for k, v in obj.items()}
    if isinstance(obj, list):
        return [redact_timestamps(x) for x in obj]
    return obj


def compare(actual: Any, expected: Any, path: str = "") -> list[str]:
    """Return a list of human-readable mismatches; empty list = pass."""
    actual = redact_timestamps(actual)
    expected = redact_timestamps(expected)
    return _diff(actual, expected, path)


def _diff(a: Any, e: Any, path: str) -> list[str]:
    if isinstance(e, dict):
        if not isinstance(a, dict):
            return [f"{path}: expected dict, got {type(a).__name__}"]
        errs = []
        for k in set(a.keys()) | set(e.keys()):
            p = f"{path}.{k}" if path else k
            if k not in a:
                errs.append(f"{p}: missing in actual")
            elif k not in e:
                errs.append(f"{p}: unexpected in actual")
            else:
                errs += _diff(a[k], e[k], p)
        return errs
    if isinstance(e, list):
        if not isinstance(a, list) or len(a) != len(e):
            return [f"{path}: list length differs (got {len(a) if isinstance(a, list) else 'non-list'}, want {len(e)})"]
        errs = []
        for i, (x, y) in enumerate(zip(a, e)):
            errs += _diff(x, y, f"{path}[{i}]")
        return errs
    if isinstance(e, float):
        if not isinstance(a, (int, float)) or not math.isfinite(float(a)) or abs(float(a) - e) > FLOAT_TOLERANCE:
            return [f"{path}: float mismatch (got {a}, want {e} ± {FLOAT_TOLERANCE})"]
        return []
    if a != e:
        return [f"{path}: mismatch (got {a!r}, want {e!r})"]
    return []
