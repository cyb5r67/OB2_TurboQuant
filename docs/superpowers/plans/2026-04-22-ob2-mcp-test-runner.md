# OB2 MCP Test Runner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `tests/mcp_runner.py`, a standalone Python script that exercises all four OB2 MCP tools with happy-path, retrieval-quality, Ollama, and negative-case assertions, then auto-cleans up all test domains.

**Architecture:** A single Python file using `httpx` for direct HTTP calls to `POST /mcp` (MCP tools) and `DELETE /admin/domains/:domain` (cleanup). Reads `OB2_BRAIN_KEY` and `OB2_PORT` from the root `.env`. Results are printed live to the console and written to `tests/results.json`. The script always exits with code `0` (all pass) or `1` (any fail).

**Tech Stack:** Python 3.10+, `httpx>=0.27`, `python-dotenv>=1.0`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `tests/requirements-runner.txt` | Create | Pin `httpx` and `python-dotenv` |
| `tests/mcp_runner.py` | Create | Full test runner (single file) |
| `tests/results.json` | Generated | Written on each run, not committed |

---

## MCP Protocol Notes

- **MCP endpoint:** `POST /mcp` — auth via `x-brain-key: {key}` header
- **Request format:** `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"<tool>","arguments":{...}}}`
- **Response format:** SSE stream — scan lines for `data: {json}` to find the JSON-RPC result
- **Admin endpoint:** `DELETE /admin/domains/:domain` — auth via `Authorization: Bearer {key}`
- **Domains auto-created** on first `capture_knowledge` call

---

## Task 1: Create requirements file

**Files:**
- Create: `tests/requirements-runner.txt`

- [ ] **Step 1: Write the file**

```
httpx>=0.27
python-dotenv>=1.0
```

- [ ] **Step 2: Install dependencies**

```bash
pip install -r tests/requirements-runner.txt
```

Expected output:
```
Successfully installed httpx-0.x.x python-dotenv-1.x.x ...
```

- [ ] **Step 3: Commit**

```bash
git add tests/requirements-runner.txt
git commit -m "feat(tests): add mcp runner requirements file"
```

---

## Task 2: Scaffold core infrastructure

**Files:**
- Create: `tests/mcp_runner.py`

- [ ] **Step 1: Write the complete infrastructure skeleton**

Create `tests/mcp_runner.py` with the following content:

```python
#!/usr/bin/env python3
"""OB2 MCP Test Runner — exercises all four MCP tools with quality and error assertions."""

import json
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import httpx
from dotenv import dotenv_values

# ─────────────────────────────────────────────────────────────
# Config
# ─────────────────────────────────────────────────────────────

ROOT = Path(__file__).parent.parent
RESULTS_PATH = Path(__file__).parent / "results.json"
TEST_DOMAINS = ["ob2-test-alpha", "ob2-test-beta", "ob2-test-gamma", "ob2-test-error"]


def load_config() -> dict:
    env = dotenv_values(ROOT / ".env")
    key = env.get("OB2_BRAIN_KEY", "")
    port = int(env.get("OB2_PORT", "7600"))
    if not key:
        print("ERROR: OB2_BRAIN_KEY not found in .env", file=sys.stderr)
        sys.exit(1)
    return {"key": key, "base_url": f"http://127.0.0.1:{port}"}


# ─────────────────────────────────────────────────────────────
# HTTP helpers
# ─────────────────────────────────────────────────────────────

def make_mcp_client(base_url: str, key: str) -> httpx.Client:
    return httpx.Client(
        base_url=base_url,
        headers={"x-brain-key": key, "Content-Type": "application/json"},
        timeout=90.0,
    )


def make_admin_client(base_url: str, key: str) -> httpx.Client:
    return httpx.Client(
        base_url=base_url,
        headers={"Authorization": f"Bearer {key}"},
        timeout=30.0,
    )


def mcp_call(client: httpx.Client, tool: str, arguments: dict, id: int = 1) -> dict:
    """POST to /mcp, parse SSE response, return the JSON-RPC result dict."""
    body = {
        "jsonrpc": "2.0",
        "id": id,
        "method": "tools/call",
        "params": {"name": tool, "arguments": arguments},
    }
    try:
        resp = client.post("/mcp", json=body)
    except httpx.RequestError as exc:
        return {"connection_error": str(exc)}

    if resp.status_code != 200:
        return {"http_error": resp.status_code, "body": resp.text[:300]}

    # Parse SSE: find "data: {json}" lines containing "result" or "error"
    for line in resp.text.splitlines():
        if line.startswith("data: "):
            try:
                parsed = json.loads(line[6:])
                if "result" in parsed:
                    return parsed["result"]
                if "error" in parsed:
                    return {"rpc_error": parsed["error"]}
            except json.JSONDecodeError:
                continue

    # Fallback: try the full body as plain JSON
    try:
        parsed = json.loads(resp.text)
        if "result" in parsed:
            return parsed["result"]
    except json.JSONDecodeError:
        pass

    return {"parse_error": "no_result_found", "raw": resp.text[:300]}


def extract_text(result: dict) -> str:
    """Extract the text string from an MCP tool result's content list."""
    content = result.get("content", [])
    if isinstance(content, list):
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                return item.get("text", "")
    return ""


def is_mcp_error(result: dict) -> bool:
    """True if the result is an error response of any kind."""
    return (
        result.get("isError", False)
        or "http_error" in result
        or "rpc_error" in result
        or "parse_error" in result
        or "connection_error" in result
    )


# ─────────────────────────────────────────────────────────────
# Test infrastructure
# ─────────────────────────────────────────────────────────────

@dataclass
class TestResult:
    name: str
    passed: bool
    expected: str
    actual: str
    duration_ms: float


class Runner:
    def __init__(self) -> None:
        self.results: list[TestResult] = []

    def record(self, result: TestResult) -> None:
        self.results.append(result)
        status = "\033[32m[PASS]\033[0m" if result.passed else "\033[31m[FAIL]\033[0m"
        print(f"  {status}  {result.name:<55} ({result.duration_ms:.0f}ms)")
        if not result.passed:
            print(f"           expected: {result.expected}")
            print(f"           actual:   {result.actual}")

    def summary(self) -> bool:
        total = len(self.results)
        passed = sum(1 for r in self.results if r.passed)
        failed = total - passed
        total_ms = sum(r.duration_ms for r in self.results)
        print("\n" + "=" * 70)
        print(
            f"Results: {passed}/{total} passed  |  {failed} failed  |  "
            f"total: {total_ms / 1000:.1f}s"
        )
        return failed == 0

    def write_json(self, path: Path) -> None:
        data = {
            "run_at": datetime.now(timezone.utc).isoformat(),
            "passed": sum(1 for r in self.results if r.passed),
            "failed": sum(1 for r in self.results if not r.passed),
            "total": len(self.results),
            "duration_ms": int(sum(r.duration_ms for r in self.results)),
            "tests": [
                {
                    "name": r.name,
                    "passed": r.passed,
                    "duration_ms": int(r.duration_ms),
                    "expected": r.expected,
                    "actual": r.actual,
                }
                for r in self.results
            ],
        }
        path.write_text(json.dumps(data, indent=2))
        print(f"Results written to {path}")


def run_test(runner: Runner, name: str, fn) -> TestResult:
    """Execute fn() -> (passed, expected, actual), record timing, catch exceptions."""
    t0 = time.monotonic()
    try:
        passed, expected, actual = fn()
    except Exception as exc:
        passed = False
        expected = "no exception"
        actual = f"{type(exc).__name__}: {exc}"
    ms = (time.monotonic() - t0) * 1000
    result = TestResult(name, passed, expected, actual, ms)
    runner.record(result)
    return result


# ─────────────────────────────────────────────────────────────
# Cleanup — always runs, even on test failure
# ─────────────────────────────────────────────────────────────

def cleanup(admin: httpx.Client, runner: Runner) -> None:
    print("\n── Cleanup ──")
    for domain in TEST_DOMAINS:
        def _make(d: str):
            def _test():
                try:
                    resp = admin.delete(f"/admin/domains/{d}")
                    # 200 = deleted, 404 = never existed — both are acceptable
                    passed = resp.status_code in (200, 404)
                    return passed, "HTTP 200 or 404", f"HTTP {resp.status_code}"
                except httpx.RequestError as exc:
                    return False, "no connection error", str(exc)
            return _test
        run_test(runner, f"cleanup -- delete @{domain}", _make(domain))


# ─────────────────────────────────────────────────────────────
# Placeholder for test groups — added in Tasks 3–5
# ─────────────────────────────────────────────────────────────

def run_suite(mcp: httpx.Client, admin: httpx.Client, runner: Runner) -> None:
    print("\nOB2 MCP Test Runner")
    print("=" * 70)
    # Test groups added here in Tasks 3–5
    try:
        pass  # groups wired in here during Tasks 3–5
    finally:
        cleanup(admin, runner)


def main() -> None:
    cfg = load_config()
    mcp = make_mcp_client(cfg["base_url"], cfg["key"])
    admin = make_admin_client(cfg["base_url"], cfg["key"])
    runner = Runner()
    try:
        run_suite(mcp, admin, runner)
    finally:
        runner.write_json(RESULTS_PATH)
        all_passed = runner.summary()
        sys.exit(0 if all_passed else 1)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Verify the skeleton runs without errors**

```bash
cd /mnt/c/projects/OB2 && python tests/mcp_runner.py
```

Expected output (no test groups yet, only cleanup):
```
OB2 MCP Test Runner
======================================================================
  [PASS]  cleanup — delete @ob2-test-alpha                             (Nms)
  ...
======================================================================
Results: 4/4 passed  |  0 failed  |  total: 0.Xs
Results written to tests/results.json
```

If the server is not running, cleanup will fail with `connection_error` — that is acceptable at this stage.

- [ ] **Step 3: Commit**

```bash
git add tests/mcp_runner.py
git commit -m "feat(tests): scaffold mcp_runner with infrastructure and cleanup"
```

---

## Task 3: Implement Group 1 — Happy Path

**Files:**
- Modify: `tests/mcp_runner.py`

- [ ] **Step 1: Add the group1 function**

Insert this function above `run_suite` in `tests/mcp_runner.py`:

```python
# ─────────────────────────────────────────────────────────────
# Group 1: Happy path (@ob2-test-alpha)
# ─────────────────────────────────────────────────────────────

_ALPHA_TEXT = (
    "The capital of France is Paris. "
    "The Eiffel Tower stands 330 metres tall and was completed in 1889."
)


def group1_happy_path(mcp: httpx.Client, runner: Runner) -> None:
    print("\n── Group 1: Happy Path (@ob2-test-alpha) ──")

    def test_capture():
        r = mcp_call(mcp, "capture_knowledge", {
            "domain": "ob2-test-alpha",
            "text": _ALPHA_TEXT,
            "tags": ["geography", "france"],
        })
        text = extract_text(r)
        passed = not is_mcp_error(r) and "Captured" in text
        return passed, "response contains 'Captured'", text[:120] or repr(r)

    run_test(runner, "capture_knowledge -- basic", test_capture)

    def test_search():
        r = mcp_call(mcp, "search_knowledge", {
            "domain": "ob2-test-alpha",
            "query": "France capital city",
            "top_k": 3,
        })
        text = extract_text(r)
        passed = not is_mcp_error(r) and len(text) > 0
        return passed, "at least 1 result returned", text[:120] or repr(r)

    run_test(runner, "search_knowledge -- basic retrieval", test_search)

    def test_stats_single():
        r = mcp_call(mcp, "knowledge_stats", {"domain": "ob2-test-alpha"})
        text = extract_text(r)
        passed = not is_mcp_error(r) and "ob2-test-alpha" in text
        return passed, "domain name appears in stats", text[:120] or repr(r)

    run_test(runner, "knowledge_stats -- single domain", test_stats_single)

    def test_stats_all():
        r = mcp_call(mcp, "knowledge_stats", {})
        text = extract_text(r)
        passed = not is_mcp_error(r) and "ob2-test-alpha" in text
        return passed, "@ob2-test-alpha appears in all-domains list", text[:200] or repr(r)

    run_test(runner, "knowledge_stats -- all domains", test_stats_all)
```

- [ ] **Step 2: Wire group1 into run_suite**

Replace the `run_suite` function body:

```python
def run_suite(mcp: httpx.Client, admin: httpx.Client, runner: Runner) -> None:
    print("\nOB2 MCP Test Runner")
    print("=" * 70)
    try:
        group1_happy_path(mcp, runner)
    finally:
        cleanup(admin, runner)
```

- [ ] **Step 3: Run with OB2 server running**

```bash
cd /mnt/c/projects/OB2 && python tests/mcp_runner.py
```

Expected:
```
── Group 1: Happy Path (@ob2-test-alpha) ──
  [PASS]  capture_knowledge -- basic                                  (142ms)
  [PASS]  search_knowledge -- basic retrieval                         (89ms)
  [PASS]  knowledge_stats -- single domain                            (34ms)
  [PASS]  knowledge_stats -- all domains                              (28ms)
```

- [ ] **Step 4: Commit**

```bash
git add tests/mcp_runner.py
git commit -m "feat(tests): add Group 1 happy-path tests to mcp_runner"
```

---

## Task 4: Implement Group 2 — Retrieval Quality

**Files:**
- Modify: `tests/mcp_runner.py`

- [ ] **Step 1: Add the group2 function**

Insert this function directly below `group1_happy_path` in `tests/mcp_runner.py`:

```python
# ─────────────────────────────────────────────────────────────
# Group 2: Retrieval quality (@ob2-test-beta)
# ─────────────────────────────────────────────────────────────

# Unique identifiers prevent collisions with real domain content
_BETA_FACTS = [
    (
        "ZXQV-001",
        "ZXQV-001: The primary database cluster runs PostgreSQL 16 with "
        "connection pooling via PgBouncer on port 6432.",
        ["database", "postgres"],
    ),
    (
        "ZXQV-002",
        "ZXQV-002: The caching layer uses Redis 7.2 with a 24-hour TTL for "
        "session tokens and a 5-minute TTL for API responses.",
        ["cache", "redis"],
    ),
    (
        "ZXQV-003",
        "ZXQV-003: The message queue uses RabbitMQ 3.12 with a dead letter "
        "exchange for routing failed background jobs to a retry queue.",
        ["queue", "rabbitmq"],
    ),
]
_BETA_TAGGED_ID = "ZXQV-TAG-9876"
_BETA_TAGGED_TEXT = (
    f"{_BETA_TAGGED_ID}: Database connection retry limit is 3 attempts "
    "with exponential backoff starting at 100ms."
)


def group2_retrieval_quality(mcp: httpx.Client, runner: Runner) -> None:
    print("\n── Group 2: Retrieval Quality (@ob2-test-beta) ──")

    # Capture all facts first
    for uid, text, tags in _BETA_FACTS:
        mcp_call(mcp, "capture_knowledge", {
            "domain": "ob2-test-beta",
            "text": text,
            "tags": tags,
        })

    # Keyword match: each unique ID must appear in top-3 results
    for uid, text, _ in _BETA_FACTS:
        def _make_keyword_test(search_id, expected_text):
            def test():
                r = mcp_call(mcp, "search_knowledge", {
                    "domain": "ob2-test-beta",
                    "query": search_id,
                    "top_k": 3,
                })
                result_text = extract_text(r)
                passed = not is_mcp_error(r) and search_id in result_text
                return (
                    passed,
                    f"result contains '{search_id}'",
                    result_text[:150] or repr(r),
                )
            return test
        run_test(runner, f"search -- keyword match ({uid})", _make_keyword_test(uid, text))

    # Semantic match: question phrased differently from captured text
    def test_semantic():
        r = mcp_call(mcp, "search_knowledge", {
            "domain": "ob2-test-beta",
            "query": "Where do undeliverable tasks end up when a worker cannot process them?",
            "top_k": 5,
        })
        result_text = extract_text(r)
        # ZXQV-003 is about RabbitMQ dead letter exchange for failed jobs
        passed = not is_mcp_error(r) and "ZXQV-003" in result_text
        return passed, "ZXQV-003 (RabbitMQ) in top-5 semantic results", result_text[:200] or repr(r)

    run_test(runner, "search -- semantic match (failed jobs -> ZXQV-003)", test_semantic)

    # Tagged doc: capture with unique tag, assert findable by content
    mcp_call(mcp, "capture_knowledge", {
        "domain": "ob2-test-beta",
        "text": _BETA_TAGGED_TEXT,
        "tags": ["ob2-runner-tag-9876"],
    })

    def test_tagged():
        r = mcp_call(mcp, "search_knowledge", {
            "domain": "ob2-test-beta",
            "query": _BETA_TAGGED_ID,
            "top_k": 3,
        })
        result_text = extract_text(r)
        passed = not is_mcp_error(r) and _BETA_TAGGED_ID in result_text
        return passed, f"tagged doc '{_BETA_TAGGED_ID}' found in top-3", result_text[:150] or repr(r)

    run_test(runner, "search -- tagged doc retrieval", test_tagged)
```

- [ ] **Step 2: Wire group2 into run_suite**

```python
def run_suite(mcp: httpx.Client, admin: httpx.Client, runner: Runner) -> None:
    print("\nOB2 MCP Test Runner")
    print("=" * 70)
    try:
        group1_happy_path(mcp, runner)
        group2_retrieval_quality(mcp, runner)
    finally:
        cleanup(admin, runner)
```

- [ ] **Step 3: Run and verify retrieval quality tests**

```bash
cd /mnt/c/projects/OB2 && python tests/mcp_runner.py
```

Expected (new tests):
```
── Group 2: Retrieval Quality (@ob2-test-beta) ──
  [PASS]  search -- keyword match (ZXQV-001)                         (95ms)
  [PASS]  search -- keyword match (ZXQV-002)                         (88ms)
  [PASS]  search -- keyword match (ZXQV-003)                         (91ms)
  [PASS]  search -- semantic match (failed jobs -> ZXQV-003)         (110ms)
  [PASS]  search -- tagged doc retrieval                              (87ms)
```

If the semantic match fails, the hybrid_alpha in `config.yaml` may be too low — this is a signal, not a bug in the runner.

- [ ] **Step 4: Commit**

```bash
git add tests/mcp_runner.py
git commit -m "feat(tests): add Group 2 retrieval-quality tests to mcp_runner"
```

---

## Task 5: Implement Group 3 — Ollama / chat_knowledge

**Files:**
- Modify: `tests/mcp_runner.py`

- [ ] **Step 1: Add the group3 function**

Insert this function directly below `group2_retrieval_quality` in `tests/mcp_runner.py`:

```python
# ─────────────────────────────────────────────────────────────
# Group 3: Ollama / chat_knowledge (@ob2-test-gamma)
# ─────────────────────────────────────────────────────────────

_GAMMA_SECRET = "FOXTROT-SIERRA-7749"
_GAMMA_TEXT = (
    f"The deployment passphrase for the staging environment is {_GAMMA_SECRET}. "
    "Only devops leads are authorised to use this passphrase."
)


def group3_ollama_chat(mcp: httpx.Client, runner: Runner) -> None:
    print("\n── Group 3: Ollama / chat_knowledge (@ob2-test-gamma) ──")

    mcp_call(mcp, "capture_knowledge", {
        "domain": "ob2-test-gamma",
        "text": _GAMMA_TEXT,
        "tags": ["deployment", "secret"],
    })

    def test_grounded_answer():
        r = mcp_call(mcp, "chat_knowledge", {
            "domain": "ob2-test-gamma",
            "question": "What is the staging deployment passphrase?",
        })
        text = extract_text(r)
        passed = not is_mcp_error(r) and _GAMMA_SECRET in text
        return (
            passed,
            f"response contains '{_GAMMA_SECRET}'",
            text[:200] or repr(r),
        )

    run_test(runner, "chat_knowledge -- grounded answer", test_grounded_answer)

    def test_off_topic():
        r = mcp_call(mcp, "chat_knowledge", {
            "domain": "ob2-test-gamma",
            "question": "What is the population of South Korea?",
        })
        text = extract_text(r)
        # Must return a non-empty response without crashing; must not leak gamma content
        passed = (
            not is_mcp_error(r)
            and len(text) > 0
            and _GAMMA_SECRET not in text
        )
        return (
            passed,
            "non-empty response, no passphrase leaked",
            text[:200] or repr(r),
        )

    run_test(runner, "chat_knowledge -- off-topic (no content leak)", test_off_topic)
```

- [ ] **Step 2: Wire group3 into run_suite**

```python
def run_suite(mcp: httpx.Client, admin: httpx.Client, runner: Runner) -> None:
    print("\nOB2 MCP Test Runner")
    print("=" * 70)
    try:
        group1_happy_path(mcp, runner)
        group2_retrieval_quality(mcp, runner)
        group3_ollama_chat(mcp, runner)
    finally:
        cleanup(admin, runner)
```

- [ ] **Step 3: Run and verify (Ollama must be running)**

```bash
cd /mnt/c/projects/OB2 && python tests/mcp_runner.py
```

Expected (new tests, Ollama will take a few seconds):
```
── Group 3: Ollama / chat_knowledge (@ob2-test-gamma) ──
  [PASS]  chat_knowledge -- grounded answer                           (3200ms)
  [PASS]  chat_knowledge -- off-topic (no content leak)               (2800ms)
```

If `chat_knowledge -- grounded answer` fails: Ollama is running but the model didn't reproduce the exact string. Check the `actual` output — if Ollama paraphrased the passphrase, adjust `_GAMMA_SECRET` to a word rather than a code phrase, or loosen the assertion to `_GAMMA_SECRET.lower() in text.lower()`.

- [ ] **Step 4: Commit**

```bash
git add tests/mcp_runner.py
git commit -m "feat(tests): add Group 3 Ollama chat_knowledge tests to mcp_runner"
```

---

## Task 6: Implement Group 4 — Negative Cases + Cleanup + Main

**Files:**
- Modify: `tests/mcp_runner.py`

- [ ] **Step 1: Add the group4 function**

Insert this function directly below `group3_ollama_chat` in `tests/mcp_runner.py`:

```python
# ─────────────────────────────────────────────────────────────
# Group 4: Negative cases (@ob2-test-error)
# ─────────────────────────────────────────────────────────────

def group4_negative_cases(mcp: httpx.Client, runner: Runner) -> None:
    print("\n── Group 4: Negative Cases ──")

    # Seed @ob2-test-error so the domain exists for test 14
    mcp_call(mcp, "capture_knowledge", {
        "domain": "ob2-test-error",
        "text": "ZXQV-ERROR-SEED: This document exists only to initialise the error-test domain.",
    })

    def test_bad_key():
        # One-off client with an invalid key
        bad = httpx.Client(
            base_url=str(mcp.base_url),
            headers={"x-brain-key": "ob2_badbadbadbadbadbadbadbadbadbadbadbad00"},
            timeout=10.0,
        )
        r = mcp_call(bad, "search_knowledge", {"domain": "ob2-test-alpha", "query": "test"})
        bad.close()
        # Expect HTTP 401 or an isError MCP response
        passed = r.get("http_error") == 401 or is_mcp_error(r)
        return passed, "HTTP 401 or MCP error for invalid key", repr(r)[:150]

    run_test(runner, "auth -- bad API key returns 401", test_bad_key)

    def test_missing_domain():
        r = mcp_call(mcp, "search_knowledge", {
            "domain": "ob2-test-nonexistent",
            "query": "anything",
            "top_k": 1,
        })
        # Sidecar returns unknown_domain -> mcp.ts returns isError: true
        passed = is_mcp_error(r) or "unknown" in extract_text(r).lower()
        return passed, "isError or 'unknown' in response text", extract_text(r)[:150] or repr(r)

    run_test(runner, "search -- missing domain returns error", test_missing_domain)

    def test_missing_text_field():
        # Send capture_knowledge without the required 'text' argument
        r = mcp_call(mcp, "capture_knowledge", {"domain": "ob2-test-error"})
        passed = is_mcp_error(r)
        return passed, "error response for missing 'text' field", extract_text(r)[:150] or repr(r)

    run_test(runner, "capture -- missing required field returns error", test_missing_text_field)

    def test_off_topic_chat():
        r = mcp_call(mcp, "chat_knowledge", {
            "domain": "ob2-test-error",
            "question": "What is the boiling point of tungsten?",
        })
        text = extract_text(r)
        # Must not crash; must return a non-empty response
        passed = not r.get("connection_error") and len(text) > 0
        return passed, "graceful non-empty response for off-topic chat", text[:200] or repr(r)

    run_test(runner, "chat -- off-topic on sparse domain is graceful", test_off_topic_chat)
```

- [ ] **Step 2: Wire group4 into run_suite**

Replace the `run_suite` function with the complete final version (cleanup was already defined in the scaffold):

```python
def run_suite(mcp: httpx.Client, admin: httpx.Client, runner: Runner) -> None:
    print("\nOB2 MCP Test Runner")
    print("=" * 70)
    try:
        group1_happy_path(mcp, runner)
        group2_retrieval_quality(mcp, runner)
        group3_ollama_chat(mcp, runner)
        group4_negative_cases(mcp, runner)
    finally:
        cleanup(admin, runner)
```

- [ ] **Step 4: Run the complete suite**

```bash
cd /mnt/c/projects/OB2 && python tests/mcp_runner.py
```

Expected final output:
```
OB2 MCP Test Runner
======================================================================

── Group 1: Happy Path (@ob2-test-alpha) ──
  [PASS]  capture_knowledge -- basic                                  (142ms)
  [PASS]  search_knowledge -- basic retrieval                         (89ms)
  [PASS]  knowledge_stats -- single domain                            (34ms)
  [PASS]  knowledge_stats -- all domains                              (28ms)

── Group 2: Retrieval Quality (@ob2-test-beta) ──
  [PASS]  search -- keyword match (ZXQV-001)                         (95ms)
  [PASS]  search -- keyword match (ZXQV-002)                         (88ms)
  [PASS]  search -- keyword match (ZXQV-003)                         (91ms)
  [PASS]  search -- semantic match (failed jobs -> ZXQV-003)         (110ms)
  [PASS]  search -- tagged doc retrieval                              (87ms)

── Group 3: Ollama / chat_knowledge (@ob2-test-gamma) ──
  [PASS]  chat_knowledge -- grounded answer                           (3200ms)
  [PASS]  chat_knowledge -- off-topic (no content leak)               (2800ms)

── Group 4: Negative Cases ──
  [PASS]  auth -- bad API key returns 401                             (45ms)
  [PASS]  search -- missing domain returns error                      (67ms)
  [PASS]  capture -- missing required field returns error             (38ms)
  [PASS]  chat -- off-topic on sparse domain is graceful              (2100ms)

── Cleanup ──
  [PASS]  cleanup -- delete @ob2-test-alpha                           (52ms)
  [PASS]  cleanup -- delete @ob2-test-beta                            (48ms)
  [PASS]  cleanup -- delete @ob2-test-gamma                           (51ms)
  [PASS]  cleanup -- delete @ob2-test-error                           (49ms)

======================================================================
Results: 19/19 passed  |  0 failed  |  total: 12.3s
Results written to tests/results.json
```

- [ ] **Step 5: Verify results.json was written correctly**

```bash
python -m json.tool tests/results.json | head -20
```

Expected:
```json
{
  "run_at": "2026-04-22T...",
  "passed": 19,
  "failed": 0,
  "total": 19,
  "duration_ms": 12300,
  "tests": [
    ...
  ]
}
```

- [ ] **Step 6: Commit**

```bash
git add tests/mcp_runner.py
git commit -m "feat(tests): complete mcp_runner with negative cases, cleanup, and full suite"
```

---

## Task 7: Add results.json to .gitignore

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Exclude generated results file**

Add to `.gitignore`:

```
tests/results.json
```

- [ ] **Step 2: Commit**

```bash
git add .gitignore
git commit -m "chore: ignore tests/results.json (generated on each run)"
```

---

## How to Trigger from Claude Desktop

Ask Claude: *"Run the OB2 test suite"*

Claude will execute:
```bash
cd /mnt/c/projects/OB2 && python tests/mcp_runner.py
```

And summarize the pass/fail results from the console output and `tests/results.json`.
