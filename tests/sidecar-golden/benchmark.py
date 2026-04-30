"""Benchmark the Python and Rust sidecars head-to-head.

Measures: cold start, RSS, per-operation latency, sustained throughput.

Usage:
    python tests/sidecar-golden/benchmark.py
"""
from __future__ import annotations
import json
import os
import pathlib
import statistics
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from queue import Queue, Empty

ROOT = Path(__file__).resolve().parents[2]
PY_SIDECAR = ROOT / "retrieval" / "sidecar.py"
PY_BIN = ROOT / "retrieval" / ".venv" / "bin" / "python"
RUST_BIN = ROOT / "sidecar-rs" / "target" / "release" / "ob2-sidecar"


@dataclass
class Bench:
    runtime: str
    cold_start_s: float
    rss_mb_warm: float
    ping_ms_avg: float
    capture_ms_avg: float
    capture_ms_p95: float
    retrieve_ms_avg: float
    retrieve_ms_p95: float
    throughput_caps_per_sec: float
    concurrent_caps_per_sec: float
    concurrent_cap_ms_avg: float
    sample_captures: int
    sample_retrieves: int


class Sidecar:
    def __init__(self, runtime: str, sqlite_path: Path):
        self.runtime = runtime
        self.sqlite_path = sqlite_path
        self.proc = None
        self._pending = {}
        self._next_id = 1
        self._reader = None

    def start(self) -> float:
        env = os.environ.copy()
        env["OB2_SQLITE_PATH"] = str(self.sqlite_path)
        env["OB2_STORAGE_BACKEND"] = "sqlite"
        env["OB2_EMBEDDING_MODEL"] = "all-MiniLM-L6-v2"
        env["OB2_USERS_FILE"] = str(self.sqlite_path.parent / "users.json")

        if self.runtime == "python":
            cmd = [str(PY_BIN), str(PY_SIDECAR)]
            cwd = str(ROOT / "retrieval")
        elif self.runtime == "rust":
            cmd = [str(RUST_BIN)]
            cwd = str(ROOT / "sidecar-rs")
            env["FASTEMBED_CACHE_PATH"] = str(
                ROOT / "sidecar-rs" / "crates" / "ob2-embedder" / ".fastembed_cache"
            )
        else:
            raise ValueError(self.runtime)

        t0 = time.monotonic()
        self.proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=env,
            cwd=cwd,
            text=True,
            bufsize=1,
        )
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()
        # Warmup ping — this forces model load on the Python side.
        _ = self.call("ping", {}, timeout_s=120.0)
        cold_start = time.monotonic() - t0
        return cold_start

    def _read_loop(self):
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            msg_id = msg.get("id")
            if msg_id in self._pending:
                self._pending[msg_id].put(msg)

    def call(self, method: str, params: dict, *, timeout_s: float = 30.0) -> dict:
        msg_id = self._next_id
        self._next_id += 1
        q = Queue(maxsize=1)
        self._pending[msg_id] = q
        req = {"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params}
        self.proc.stdin.write(json.dumps(req) + "\n")
        self.proc.stdin.flush()
        try:
            return q.get(timeout=timeout_s)
        finally:
            self._pending.pop(msg_id, None)

    def rss_mb(self) -> float:
        path = pathlib.Path(f"/proc/{self.proc.pid}/status")
        for line in path.read_text().splitlines():
            if line.startswith("VmRSS:"):
                kb = int(line.split()[1])
                return kb / 1024.0
        return 0.0

    def stop(self):
        if self.proc is None:
            return
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.proc = None


def benchmark(runtime: str, captures: int = 100, retrieves: int = 50) -> Bench:
    with tempfile.TemporaryDirectory() as tmp:
        sqlite_path = Path(tmp) / "ob2.db"
        sc = Sidecar(runtime, sqlite_path)
        cold = sc.start()

        # Ping latency — average of 20
        ping_times = []
        for _ in range(20):
            t0 = time.monotonic()
            sc.call("ping", {})
            ping_times.append((time.monotonic() - t0) * 1000)

        # Capture throughput + latency
        cap_times = []
        corpus = [f"document number {i} hostname host-{i} role {'web' if i % 3 else 'db'}" for i in range(captures)]
        t_batch = time.monotonic()
        for i, text in enumerate(corpus):
            t0 = time.monotonic()
            resp = sc.call("capture", {
                "domain": "bench",
                "doc_id": f"d{i}",
                "text": text,
                "tags": [],
            }, timeout_s=60.0)
            cap_times.append((time.monotonic() - t0) * 1000)
            if "error" in resp:
                print(f"  [!] capture error on i={i}: {resp['error']}", file=sys.stderr)
                break
        batch_elapsed = time.monotonic() - t_batch
        throughput = captures / batch_elapsed if batch_elapsed > 0 else 0.0

        # Concurrent capture throughput — sends 50 captures in parallel threads.
        # This is the realistic workload where the batcher can coalesce.
        import concurrent.futures
        concurrent_cap_times = []
        t_conc = time.monotonic()
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as ex:
            futures = []
            for i in range(50):
                def do_capture(idx=i):
                    t0 = time.monotonic()
                    sc.call("capture", {
                        "domain": "bench",
                        "doc_id": f"c{idx}",
                        "text": f"concurrent doc {idx} hostname host-{idx} role web",
                        "tags": [],
                    }, timeout_s=60.0)
                    return (time.monotonic() - t0) * 1000
                futures.append(ex.submit(do_capture))
            for f in concurrent.futures.as_completed(futures):
                concurrent_cap_times.append(f.result())
        conc_elapsed = time.monotonic() - t_conc
        conc_throughput = 50 / conc_elapsed if conc_elapsed > 0 else 0.0

        # Retrieve latency
        ret_times = []
        queries = ["postgres replica", "web host", "role db", "hostname", "document"]
        for i in range(retrieves):
            q = queries[i % len(queries)]
            t0 = time.monotonic()
            resp = sc.call("retrieve", {
                "domain": "bench",
                "query": q,
                "top_k": 5,
            }, timeout_s=60.0)
            ret_times.append((time.monotonic() - t0) * 1000)
            if "error" in resp:
                print(f"  [!] retrieve error on i={i}: {resp['error']}", file=sys.stderr)
                break

        # Sample RSS while warm
        rss = sc.rss_mb()

        sc.stop()

    def p95(xs):
        if not xs: return 0.0
        s = sorted(xs)
        return s[int(0.95 * (len(s) - 1))]

    return Bench(
        runtime=runtime,
        cold_start_s=cold,
        rss_mb_warm=rss,
        ping_ms_avg=statistics.mean(ping_times),
        capture_ms_avg=statistics.mean(cap_times) if cap_times else 0,
        capture_ms_p95=p95(cap_times),
        retrieve_ms_avg=statistics.mean(ret_times) if ret_times else 0,
        retrieve_ms_p95=p95(ret_times),
        throughput_caps_per_sec=throughput,
        concurrent_caps_per_sec=conc_throughput,
        concurrent_cap_ms_avg=statistics.mean(concurrent_cap_times) if concurrent_cap_times else 0,
        sample_captures=len(cap_times),
        sample_retrieves=len(ret_times),
    )


def main():
    results = []
    for runtime in ("python", "rust"):
        print(f"\n=== benchmarking {runtime} ===", flush=True)
        b = benchmark(runtime)
        results.append(b)
        print(f"  cold start:        {b.cold_start_s:.2f}s")
        print(f"  RSS (warm):        {b.rss_mb_warm:.1f} MB")
        print(f"  ping avg:          {b.ping_ms_avg:.2f} ms")
        print(f"  capture avg/p95:   {b.capture_ms_avg:.2f} / {b.capture_ms_p95:.2f} ms  ({b.sample_captures} samples)")
        print(f"  retrieve avg/p95:  {b.retrieve_ms_avg:.2f} / {b.retrieve_ms_p95:.2f} ms  ({b.sample_retrieves} samples)")
        print(f"  throughput (serial):    {b.throughput_caps_per_sec:.1f} caps/sec")
        print(f"  throughput (16 conc):   {b.concurrent_caps_per_sec:.1f} caps/sec  (avg latency {b.concurrent_cap_ms_avg:.1f} ms)")

    # Side-by-side
    py, rs = results
    def ratio(a, b):
        return "n/a" if b == 0 else f"{a/b:.2f}x"
    print("\n=== comparison ===")
    print(f"{'metric':<25}{'python':>14}{'rust':>14}{'speedup':>12}")
    print(f"{'cold start (s)':<25}{py.cold_start_s:>14.2f}{rs.cold_start_s:>14.2f}{ratio(py.cold_start_s, rs.cold_start_s):>12}")
    print(f"{'RSS warm (MB)':<25}{py.rss_mb_warm:>14.1f}{rs.rss_mb_warm:>14.1f}{ratio(py.rss_mb_warm, rs.rss_mb_warm):>12}")
    print(f"{'ping avg (ms)':<25}{py.ping_ms_avg:>14.2f}{rs.ping_ms_avg:>14.2f}{ratio(py.ping_ms_avg, rs.ping_ms_avg):>12}")
    print(f"{'capture avg (ms)':<25}{py.capture_ms_avg:>14.2f}{rs.capture_ms_avg:>14.2f}{ratio(py.capture_ms_avg, rs.capture_ms_avg):>12}")
    print(f"{'capture p95 (ms)':<25}{py.capture_ms_p95:>14.2f}{rs.capture_ms_p95:>14.2f}{ratio(py.capture_ms_p95, rs.capture_ms_p95):>12}")
    print(f"{'retrieve avg (ms)':<25}{py.retrieve_ms_avg:>14.2f}{rs.retrieve_ms_avg:>14.2f}{ratio(py.retrieve_ms_avg, rs.retrieve_ms_avg):>12}")
    print(f"{'retrieve p95 (ms)':<25}{py.retrieve_ms_p95:>14.2f}{rs.retrieve_ms_p95:>14.2f}{ratio(py.retrieve_ms_p95, rs.retrieve_ms_p95):>12}")
    print(f"{'caps/sec (serial)':<25}{py.throughput_caps_per_sec:>14.1f}{rs.throughput_caps_per_sec:>14.1f}{ratio(rs.throughput_caps_per_sec, py.throughput_caps_per_sec):>12}")
    print(f"{'caps/sec (16 conc)':<25}{py.concurrent_caps_per_sec:>14.1f}{rs.concurrent_caps_per_sec:>14.1f}{ratio(rs.concurrent_caps_per_sec, py.concurrent_caps_per_sec):>12}")


if __name__ == "__main__":
    main()
