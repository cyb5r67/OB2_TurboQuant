"""CUDA-accelerated embedding auto-batcher.

Collects embedding requests from concurrent captures into a buffer, fires one
batched GPU call every `flush_interval_ms` OR when the buffer reaches
`max_batch_size` — whichever comes first. Each caller gets a Future that
resolves when the batch completes.

Under light load (1 capture at a time), behaves like synchronous embed() with
~100ms added latency. Under heavy load (bulk MCP captures, concurrent users),
amortizes the GPU call overhead across N documents.

Usage:
    batcher = EmbedBatcher(model, flush_interval_ms=100, max_batch_size=32)
    vec = batcher.embed("some text")       # blocks until batch fires
    vecs = batcher.embed_batch(["a", "b"]) # batch shortcut

    batcher.shutdown()                     # drain + stop
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Optional

import numpy as np

logger = logging.getLogger(__name__)


class EmbedBatcher:
    def __init__(
        self,
        model: object,  # SentenceTransformer instance
        flush_interval_ms: float = 100.0,
        max_batch_size: int = 32,
    ) -> None:
        self._model = model
        self._flush_interval = flush_interval_ms / 1000.0
        self._max_batch = max_batch_size

        self._lock = threading.Lock()
        self._buffer: list[tuple[str, threading.Event, list]] = []
        # Each entry: (text, done_event, result_holder)
        # result_holder[0] is the np.ndarray on success
        # result_holder[1] is an Exception on failure (or None on success)

        self._stop = threading.Event()
        self._has_work = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True, name="ob2-embed-batcher")
        self._thread.start()

        # Stats
        self.total_batches = 0
        self.total_items = 0
        self.total_batch_ms = 0.0

        logger.info(
            "EmbedBatcher started (flush=%.0fms, max_batch=%d, device=%s)",
            flush_interval_ms, max_batch_size,
            getattr(model, 'device', 'unknown'),
        )

    def embed(self, text: str) -> np.ndarray:
        """Embed a single text. Blocks until the next batch fires."""
        event = threading.Event()
        # holder: [result_array, exception_or_none]
        holder: list[Any] = [None, None]
        with self._lock:
            self._buffer.append((text, event, holder))
            if len(self._buffer) >= self._max_batch:
                self._has_work.set()
        self._has_work.set()  # wake the flush thread
        event.wait()
        if holder[1] is not None:
            raise holder[1]  # re-raise the actual exception
        if holder[0] is None:
            raise RuntimeError("embed failed — batch did not produce a result")
        return holder[0]

    def embed_batch(self, texts: list[str]) -> np.ndarray:
        """Embed multiple texts. All go into the buffer together.

        For bulk operations (CLI importers), this is more efficient than
        N individual embed() calls because it bypasses the batcher entirely
        and calls the model directly.
        """
        if not texts:
            return np.empty((0, 0), dtype=np.float32)
        # For batches larger than max_batch, call model directly (skip batcher overhead)
        if len(texts) > self._max_batch:
            return self._encode_direct(texts)

        events = []
        holders: list[list[Any]] = []
        with self._lock:
            for t in texts:
                event = threading.Event()
                holder: list[Any] = [None, None]
                self._buffer.append((t, event, holder))
                events.append(event)
                holders.append(holder)
            if len(self._buffer) >= self._max_batch:
                self._has_work.set()
        self._has_work.set()
        for e in events:
            e.wait()
        # Re-raise first exception found
        for h in holders:
            if h[1] is not None:
                raise h[1]
        return np.stack([h[0] for h in holders])

    def _encode_direct(self, texts: list[str]) -> np.ndarray:
        """Bypass batcher for large batches (CLI importers)."""
        vecs = self._model.encode(
            texts, convert_to_numpy=True, batch_size=64, show_progress_bar=False,
        )
        return vecs.astype(np.float32)

    def _run(self) -> None:
        """Flush thread: fires a batch every flush_interval or when buffer is full."""
        while not self._stop.is_set():
            self._has_work.wait(timeout=self._flush_interval)
            self._has_work.clear()
            self._flush()

    def _flush(self) -> None:
        with self._lock:
            if not self._buffer:
                return
            batch = self._buffer[: self._max_batch]
            self._buffer = self._buffer[self._max_batch :]

        texts = [b[0] for b in batch]
        t0 = time.perf_counter()
        try:
            vecs = self._model.encode(
                texts, convert_to_numpy=True, batch_size=len(texts), show_progress_bar=False,
            ).astype(np.float32)
        except Exception as e:
            logger.error("embed batch failed: %s", e)
            for _, event, holder in batch:
                holder[0] = None
                holder[1] = e  # propagate exception to waiters
                event.set()
            return

        elapsed_ms = (time.perf_counter() - t0) * 1000
        self.total_batches += 1
        self.total_items += len(batch)
        self.total_batch_ms += elapsed_ms

        for i, (_, event, holder) in enumerate(batch):
            holder[0] = vecs[i]
            event.set()

        if len(batch) > 1:
            logger.debug("batch %d: embedded %d texts in %.0fms", self.total_batches, len(batch), elapsed_ms)

        # If more items remain, re-trigger
        with self._lock:
            if self._buffer:
                self._has_work.set()

    def stats(self) -> dict:
        avg_ms = (self.total_batch_ms / max(self.total_batches, 1))
        return {
            "total_batches": self.total_batches,
            "total_items": self.total_items,
            "avg_batch_ms": round(avg_ms, 1),
            "avg_items_per_batch": round(self.total_items / max(self.total_batches, 1), 1),
        }

    def shutdown(self, timeout: float = 5.0) -> None:
        self._stop.set()
        self._has_work.set()  # wake thread so it exits
        self._thread.join(timeout=timeout)
        self._flush()  # drain remaining
        logger.info("EmbedBatcher stopped: %s", self.stats())
