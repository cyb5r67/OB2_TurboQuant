"""Subprocess-based client for the Python retrieval sidecar.

Usage:
    with SidecarClient(sqlite_path=Path("/tmp/ob2.db")) as client:
        resp = client.call("ping", {})
        assert resp["result"]["pong"] is True
"""
from __future__ import annotations
import json
import os
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from queue import Queue, Empty
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[2]
SIDECAR_SCRIPT = PROJECT_ROOT / "retrieval" / "sidecar.py"
VENV_PYTHON = PROJECT_ROOT / "retrieval" / ".venv" / "bin" / "python"


@dataclass
class SidecarClient:
    sqlite_path: Path
    storage_backend: str = "sqlite"
    embedding_model: str = "all-MiniLM-L6-v2"
    extra_env: dict[str, str] = field(default_factory=dict)
    startup_timeout_s: float = 60.0
    call_timeout_s: float = 30.0

    _proc: subprocess.Popen | None = None
    _next_id: int = 1
    _pending: dict[int, Queue] = field(default_factory=dict)
    _reader_thread: threading.Thread | None = None
    _stop: threading.Event = field(default_factory=threading.Event)

    def __enter__(self) -> "SidecarClient":
        self.start()
        return self

    def __exit__(self, *_exc) -> None:
        self.stop()

    def start(self) -> None:
        if self._proc is not None:
            return
        env = os.environ.copy()
        env["OB2_SQLITE_PATH"] = str(self.sqlite_path)
        env["OB2_STORAGE_BACKEND"] = self.storage_backend
        env["OB2_EMBEDDING_MODEL"] = self.embedding_model
        env["OB2_USERS_FILE"] = str(self.sqlite_path.parent / "users.json")
        env.update(self.extra_env)
        # Prefer venv Python; fall back to python3.
        python_bin = str(VENV_PYTHON) if VENV_PYTHON.exists() else "python3"
        self._proc = subprocess.Popen(
            [python_bin, str(SIDECAR_SCRIPT)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            cwd=str(PROJECT_ROOT / "retrieval"),
            text=True,
            bufsize=1,
        )
        self._reader_thread = threading.Thread(target=self._read_loop, daemon=True)
        self._reader_thread.start()
        # Warmup ping with a long timeout (model load is slow).
        self.call("ping", {}, timeout_s=self.startup_timeout_s)

    def stop(self) -> None:
        if self._proc is None:
            return
        self._stop.set()
        try:
            self._proc.stdin.close()
        except Exception:
            pass
        try:
            self._proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self._proc.kill()
        self._proc = None

    def _read_loop(self) -> None:
        assert self._proc is not None
        for line in self._proc.stdout:
            if self._stop.is_set():
                return
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                # Log and skip unparseable lines
                continue
            msg_id = msg.get("id")
            if msg_id in self._pending:
                self._pending[msg_id].put(msg)

    def call(self, method: str, params: dict, *, timeout_s: float | None = None) -> dict:
        """Send a JSON-RPC request, return the parsed response dict.

        Response includes either 'result' or 'error'. Callers can inspect
        whichever they expected.
        """
        assert self._proc is not None and self._proc.stdin is not None
        timeout_s = timeout_s or self.call_timeout_s
        msg_id = self._next_id
        self._next_id += 1
        queue: Queue = Queue(maxsize=1)
        self._pending[msg_id] = queue
        req = {"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params}
        line = json.dumps(req) + "\n"
        self._proc.stdin.write(line)
        self._proc.stdin.flush()
        try:
            return queue.get(timeout=timeout_s)
        except Empty:
            raise TimeoutError(f"sidecar did not respond to {method} within {timeout_s}s")
        finally:
            self._pending.pop(msg_id, None)
