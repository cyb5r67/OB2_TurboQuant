# OB2 Sidecar Golden Fixtures

This directory holds the compatibility contract between the Python retrieval sidecar and its future Rust replacement. Each fixture captures a JSON-RPC request and the expected response; both runtimes must produce byte-identical output (with timestamp redaction and 1e-4 float tolerance for scores).

## Layout

- `fixtures/<method>.jsonl` — one file per JSON-RPC method, one fixture per line.
- `comparator.py` — diffing logic, redacts timestamps, tolerates float drift in scores.
- `sidecar_client.py` — Popen-based client for driving a sidecar subprocess.
- `generate.py` — regenerate `expected` fields from the current Python sidecar. **Requires explicit `--regen` or `--check`.** Never auto-run in CI.
- `test_python.py` — pytest suite; one test per fixture against the Python sidecar.
- `test_rust.py` — (Task 10) pytest suite against the Rust binary.

## Fixture format

```json
{
  "name": "descriptive name",
  "seed": [{"method": "capture", "params": {...}}, ...],
  "request": {"method": "retrieve", "params": {...}},
  "expected": {...}
}
```

- `seed`: optional setup calls run in order before `request`. Each must return without error.
- `request`: the RPC whose result is validated.
- `expected`: the content of `result` (not the full JSON-RPC envelope).

## Adding a new method

1. Add one or more fixtures under `fixtures/<method>.jsonl`.
2. Leave `expected: {}` initially.
3. Run `python tests/sidecar-golden/generate.py --regen` to populate from the Python sidecar.
4. Commit the file with a note about what's being tested.

## Running the suite

```bash
cd /mnt/c/projects/OB2
pytest tests/sidecar-golden/test_python.py -v
```

## CI gating

Per the spec (`docs/superpowers/specs/2026-04-19-rust-sidecar-design.md`), the parity job runs this suite against both Python and Rust on every PR touching `retrieval/`, `context-engine/`, `sidecar-rs/`, or these fixtures. Drift fails the build. New methods require fixture additions to both sides in the same PR.
