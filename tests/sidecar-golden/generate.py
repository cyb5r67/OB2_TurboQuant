"""Regenerate golden fixtures by running requests through the Python sidecar.

Run once to populate fixtures initially; run with --regen to overwrite the
`expected` field in every fixture with the actual response captured right now.

Requires explicit operator intent (--regen) so accidental CI runs don't rewrite
golden files.

Usage:
    python tests/sidecar-golden/generate.py --regen
    python tests/sidecar-golden/generate.py --check   # dry-run
"""
from __future__ import annotations
import argparse
import json
import pathlib
import tempfile

from sidecar_client import SidecarClient

FIXTURES_DIR = pathlib.Path(__file__).parent / "fixtures"


def regen(check_only: bool) -> int:
    mismatched = 0
    total = 0
    for path in sorted(FIXTURES_DIR.glob("*.jsonl")):
        new_lines = []
        with open(path) as f:
            fixtures = [json.loads(line) for line in f if line.strip()]
        with tempfile.TemporaryDirectory() as tmp:
            sqlite_path = pathlib.Path(tmp) / "ob2.db"
            with SidecarClient(sqlite_path=sqlite_path) as client:
                for fx in fixtures:
                    for setup in fx.get("seed", []):
                        client.call(setup["method"], setup["params"])
                    resp = client.call(fx["request"]["method"], fx["request"]["params"])
                    new = {**fx, "expected": resp.get("result")}
                    if new != fx:
                        mismatched += 1
                    new_lines.append(new)
                    total += 1
        if not check_only:
            with open(path, "w") as f:
                for n in new_lines:
                    f.write(json.dumps(n, sort_keys=True) + "\n")
    print(f"fixtures processed: {total}, drift detected: {mismatched}")
    return 1 if (check_only and mismatched > 0) else 0


def main():
    p = argparse.ArgumentParser()
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--regen", action="store_true", help="rewrite expected fields")
    g.add_argument("--check", action="store_true", help="fail if drift detected")
    args = p.parse_args()
    raise SystemExit(regen(check_only=args.check))


if __name__ == "__main__":
    main()
