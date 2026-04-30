# OB2 MCP Test Runner — Design Spec
**Date:** 2026-04-22  
**Status:** Approved

## Overview

A standalone Python integration test runner (`tests/mcp_runner.py`) that exercises all four OB2 MCP tools via direct HTTP calls to `POST /mcp`. Triggered from Claude Desktop via the Bash tool. Outputs a live console summary and a structured `tests/results.json`. Auto-cleans up all test domains at the end of every run.

## Goals

- Verify the full MCP tool surface is working (capture, search, stats, chat)
- Assert retrieval quality — captured facts must appear in top search results
- Cover negative/error cases — bad auth, missing domain, bad input
- Always include Ollama (`chat_knowledge`) since it is part of the standard stack
- Leave no test data behind after a run

## Non-Goals

- Unit testing internal Python/Rust sidecar logic (covered by `tests/sidecar-golden/`)
- Load or performance testing
- Testing the web dashboard or admin HTTP routes (except the domain DELETE used for cleanup)

## Architecture

### Single file: `tests/mcp_runner.py`

```
mcp_runner.py
├── load_env()           — reads OB2_BRAIN_KEY + OB2_PORT from root .env
├── mcp_call()           — POST /mcp with tool name + arguments, returns parsed JSON
├── TestResult           — dataclass: name, passed, expected, actual, duration_ms
├── Runner               — collects results, prints live console output, writes results.json
├── test_*()             — individual test functions, each returns TestResult
├── run_suite()          — orchestrates test groups in order
└── cleanup()            — deletes all test domains via DELETE /api/domains/:name
```

### Dependencies

- `httpx` — HTTP client (sync)
- `python-dotenv` — reads root `.env`
- Both are already available in the retrieval Python environment

### Connection

- Endpoint: `http://127.0.0.1:{OB2_PORT}/mcp` (default port 7600)
- Auth header: `x-brain-key: {OB2_BRAIN_KEY}` (loaded from `.env`)
- Cleanup endpoint: `DELETE http://127.0.0.1:{OB2_PORT}/api/domains/{name}` with same auth header

## Test Domains

Four isolated domains are created implicitly via the first `capture_knowledge` call into each, and deleted at the end:

| Domain | Purpose |
|--------|---------|
| `@ob2-test-alpha` | Happy path — capture, search, stats |
| `@ob2-test-beta` | Retrieval quality — keyword and semantic assertions |
| `@ob2-test-gamma` | Ollama integration — `chat_knowledge` |
| `@ob2-test-error` | Negative cases — seeded with one doc so the domain exists; negative tests target a bad key, a never-created domain name (`@ob2-test-nonexistent`), bad input, and an off-topic question |

## Test Inventory

### Group 1 — Happy Path (`@ob2-test-alpha`)

1. **capture_knowledge — basic** — capture a fact, assert `doc_id` is present and `doc_count >= 1`
2. **search_knowledge — basic retrieval** — search for the captured fact's keyword, assert `>= 1` result returned
3. **knowledge_stats — single domain** — assert domain appears with correct doc count
4. **knowledge_stats — all domains** — omit domain arg, assert `@ob2-test-alpha` is in the list

### Group 2 — Retrieval Quality (`@ob2-test-beta`)

5. **capture 3 distinct facts** — each with a unique keyword unlikely to appear elsewhere
6. **search — keyword match** — search each keyword, assert its matching fact is in top 3 results
7. **search — semantic match** — query phrased differently from the captured text, assert correct doc in top 5
8. **search — tagged doc** — capture a fact with tags, assert it is retrievable by content search

### Group 3 — Ollama / chat (`@ob2-test-gamma`)

9. **chat_knowledge — grounded answer** — capture a specific fact, ask a question whose answer is that fact, assert response is non-empty and contains the expected keyword
10. **chat_knowledge — off-domain question** — ask a question unrelated to captured content, assert a graceful response (no crash, no content from other domains leaking in)

### Group 4 — Negative Cases (`@ob2-test-error`)

11. **bad API key** — send `x-brain-key: ob2_invalid`, assert 401 or MCP error response
12. **missing domain** — `search_knowledge` on `@ob2-test-nonexistent` (never created), assert structured error (not a 500 crash)
13. **missing required field** — `capture_knowledge` with no `text` field, assert validation error
14. **off-topic chat** — `chat_knowledge` on `@ob2-test-error` with a question unrelated to its seeded content, assert graceful response (non-empty, no crash, no content from other domains)

### Cleanup (always runs, even on test failure)

15. **delete test domains** — `DELETE /api/domains/@ob2-test-{alpha,beta,gamma,error}`, assert 200 for each

## Output

### Console (live, printed as each test runs)

```
OB2 MCP Test Runner
===================
[PASS]  capture_knowledge — basic                (142ms)
[PASS]  search_knowledge — basic retrieval       (89ms)
[FAIL]  chat_knowledge — grounded answer         (2341ms)
        expected: response contains "mitochondria"
        actual:   "I don't have enough information..."
...
===================
Results: 13/15 passed  |  2 failed  |  total: 4.2s
```

### `tests/results.json`

```json
{
  "run_at": "2026-04-22T14:03:11Z",
  "passed": 13,
  "failed": 2,
  "total": 15,
  "duration_ms": 4201,
  "tests": [
    {
      "name": "capture_knowledge — basic",
      "passed": true,
      "duration_ms": 142,
      "expected": "doc_id present, doc_count >= 1",
      "actual": "doc_id: abc123, doc_count: 1"
    }
  ]
}
```

### Exit Codes

- `0` — all tests passed
- `1` — one or more tests failed (Claude Desktop detects this from Bash tool exit code)

## How to Trigger from Claude Desktop

Ask Claude: *"Run the OB2 test suite"* — Claude executes:

```bash
cd /mnt/c/projects/OB2 && python tests/mcp_runner.py
```

Claude reads the console output and `tests/results.json`, then summarizes pass/fail in the chat.
