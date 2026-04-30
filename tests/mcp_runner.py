#!/usr/bin/env python3
"""OB2 MCP Test Runner — exercises all four MCP tools with quality and error assertions."""

import json
import sys
import time
from collections.abc import Callable
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
    # In multi-user mode (users.json has real global admins), OB2_BRAIN_KEY no
    # longer authenticates. Set OB2_MCP_KEY to a real user's API key instead.
    mcp_key = env.get("OB2_MCP_KEY") or env.get("OB2_BRAIN_KEY", "")
    admin_key = env.get("OB2_ADMIN_KEY") or mcp_key
    try:
        port = int(env.get("OB2_PORT", "7600"))
    except ValueError:
        print("ERROR: OB2_PORT must be an integer", file=sys.stderr)
        sys.exit(1)
    if not mcp_key:
        print(
            "ERROR: OB2_MCP_KEY (or OB2_BRAIN_KEY) not found in .env\n"
            "  In multi-user mode, set OB2_MCP_KEY to a global-admin user's API key.",
            file=sys.stderr,
        )
        sys.exit(1)
    return {"mcp_key": mcp_key, "admin_key": admin_key, "base_url": f"http://127.0.0.1:{port}"}


# ─────────────────────────────────────────────────────────────
# HTTP helpers
# ─────────────────────────────────────────────────────────────

def make_mcp_client(base_url: str, key: str) -> httpx.Client:
    return httpx.Client(
        base_url=base_url,
        headers={
            "x-brain-key": key,
            "Content-Type": "application/json",
            # @hono/mcp v0.1.1 requires both content types in Accept or returns 406
            "Accept": "application/json, text/event-stream",
        },
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


def run_test(runner: Runner, name: str, fn: Callable[[], tuple[bool, str, str]]) -> TestResult:
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
        passed = not is_mcp_error(r) and "Paris" in text
        return passed, "result contains 'Paris'", text[:120] or repr(r)

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
        return passed, "ob2-test-alpha appears in all-domains list", text[:200] or repr(r)

    run_test(runner, "knowledge_stats -- all domains", test_stats_all)


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
    f"with exponential backoff starting at 100ms."
)


def group2_retrieval_quality(mcp: httpx.Client, runner: Runner) -> None:
    print("\n── Group 2: Retrieval Quality (@ob2-test-beta) ──")

    # Capture all facts first
    for uid, text, tags in _BETA_FACTS:
        r = mcp_call(mcp, "capture_knowledge", {
            "domain": "ob2-test-beta",
            "text": text,
            "tags": tags,
        })
        if is_mcp_error(r):
            print(f"  [WARN] capture failed for {uid}: {extract_text(r) or repr(r)}")

    # Keyword match: each unique ID must appear in top-3 results
    def _make_keyword_test(search_id: str):
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

    for uid, _, _ in _BETA_FACTS:
        run_test(runner, f"search -- keyword match ({uid})", _make_keyword_test(uid))

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


# ─────────────────────────────────────────────────────────────
# Group 3: Ollama / chat_knowledge (@ob2-test-gamma)
# ─────────────────────────────────────────────────────────────

_GAMMA_SECRET = "FOXTROT-SIERRA-7749"
_GAMMA_TEXT = (
    f"The deployment passphrase for the staging environment is {_GAMMA_SECRET}. "
    f"Only devops leads are authorised to use this passphrase."
)


def group3_ollama_chat(mcp: httpx.Client, runner: Runner) -> None:
    print("\n── Group 3: Ollama / chat_knowledge (@ob2-test-gamma) ──")

    r = mcp_call(mcp, "capture_knowledge", {
        "domain": "ob2-test-gamma",
        "text": _GAMMA_TEXT,
        "tags": ["deployment", "secret"],
    })
    if is_mcp_error(r):
        print(f"  [WARN] capture failed for gamma domain: {extract_text(r) or repr(r)}")

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


# ─────────────────────────────────────────────────────────────
# Group 4: Negative cases (@ob2-test-error)
# ─────────────────────────────────────────────────────────────

def group4_negative_cases(mcp: httpx.Client, runner: Runner) -> None:
    print("\n── Group 4: Negative Cases ──")

    # Seed @ob2-test-error so the domain exists for test 14
    r = mcp_call(mcp, "capture_knowledge", {
        "domain": "ob2-test-error",
        "text": "ZXQV-ERROR-SEED: This document exists only to initialise the error-test domain.",
    })
    if is_mcp_error(r):
        print(f"  [WARN] capture failed for error domain: {extract_text(r) or repr(r)}")

    def test_bad_key():
        with httpx.Client(
            base_url=str(mcp.base_url),
            headers={"x-brain-key": "ob2_badbadbadbadbadbadbadbadbadbadbadbad00"},
            timeout=10.0,
        ) as bad:
            r = mcp_call(bad, "search_knowledge", {"domain": "ob2-test-alpha", "query": "test"})
        passed = r.get("http_error") == 401
        return passed, "HTTP 401 for invalid key", repr(r)[:150]

    run_test(runner, "auth -- bad API key returns 401", test_bad_key)

    def test_missing_domain():
        r = mcp_call(mcp, "search_knowledge", {
            "domain": "ob2-test-nonexistent",
            "query": "anything",
            "top_k": 1,
        })
        # Server returns "No knowledge stored in domain @... yet." (not isError)
        passed = is_mcp_error(r) or "no knowledge" in extract_text(r).lower()
        return passed, "isError or 'no knowledge' in response text", extract_text(r)[:150] or repr(r)

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
        passed = not is_mcp_error(r) and len(text) > 0
        return passed, "graceful non-empty response for off-topic chat", text[:200] or repr(r)

    run_test(runner, "chat -- off-topic on sparse domain is graceful", test_off_topic_chat)


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


def main() -> None:
    cfg = load_config()
    runner = Runner()
    with (
        make_mcp_client(cfg["base_url"], cfg["mcp_key"]) as mcp,
        make_admin_client(cfg["base_url"], cfg["admin_key"]) as admin,
    ):
        try:
            run_suite(mcp, admin, runner)
        finally:
            runner.write_json(RESULTS_PATH)
            all_passed = runner.summary()
    sys.exit(0 if all_passed else 1)


if __name__ == "__main__":
    main()
