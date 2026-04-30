//! EmbedBatcher — auto-batched embedding requests.
//!
//! Ports /mnt/c/projects/OB2/retrieval/embed_batcher.py to Tokio. Callers send
//! a single text via `embed_one(text)` and await a `Vec<f32>`. The batcher
//! collects requests and flushes whenever:
//!   - the buffer reaches `max_batch` items, OR
//!   - `flush_interval` elapses since the first buffered request.

use crate::model::SharedEmbedder;
use crate::stats::BatcherStats;
use anyhow::Result;
use parking_lot::Mutex;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot, Notify};

pub struct EmbedBatcher {
    tx: mpsc::Sender<Req>,
    stats: Arc<Mutex<BatcherStats>>,
    shutdown: Arc<Notify>,
}

struct Req {
    text: String,
    reply: oneshot::Sender<Result<Vec<f32>>>,
}

pub struct BatcherConfig {
    pub flush_interval: Duration,
    pub max_batch: usize,
    pub channel_capacity: usize,
}

impl Default for BatcherConfig {
    fn default() -> Self {
        Self {
            flush_interval: Duration::from_millis(100),
            max_batch: 32,
            channel_capacity: 1024,
        }
    }
}

impl EmbedBatcher {
    /// Spawn the background task. Returns a handle; callers can `.shutdown()`
    /// to signal the worker to drain and exit.
    pub fn spawn(embedder: SharedEmbedder, config: BatcherConfig) -> Self {
        let (tx, rx) = mpsc::channel::<Req>(config.channel_capacity);
        let stats = Arc::new(Mutex::new(BatcherStats {
            available: true,
            ..Default::default()
        }));
        let shutdown = Arc::new(Notify::new());
        let stats_w = stats.clone();
        let shutdown_w = shutdown.clone();
        tokio::spawn(run_loop(
            embedder,
            rx,
            stats_w,
            shutdown_w,
            config.flush_interval,
            config.max_batch,
        ));
        Self {
            tx,
            stats,
            shutdown,
        }
    }

    /// Submit a single text. Awaiting the returned future yields the 384-dim vec.
    pub async fn embed_one(&self, text: String) -> Result<Vec<f32>> {
        let (rtx, rrx) = oneshot::channel();
        self.tx
            .send(Req { text, reply: rtx })
            .await
            .map_err(|e| anyhow::anyhow!("batcher closed: {e}"))?;
        rrx.await
            .map_err(|e| anyhow::anyhow!("batcher worker dropped reply: {e}"))?
    }

    pub fn stats(&self) -> BatcherStats {
        self.stats.lock().clone()
    }

    /// Signal the worker to drain and exit. Idempotent.
    pub fn shutdown(&self) {
        self.shutdown.notify_waiters();
    }
}

async fn run_loop(
    embedder: SharedEmbedder,
    mut rx: mpsc::Receiver<Req>,
    stats: Arc<Mutex<BatcherStats>>,
    shutdown: Arc<Notify>,
    flush_interval: Duration,
    max_batch: usize,
) {
    let mut buf: Vec<Req> = Vec::with_capacity(max_batch);
    let mut deadline: Option<Instant> = None;
    loop {
        let sleep = async {
            match deadline {
                Some(d) => {
                    tokio::time::sleep_until(d.into()).await;
                }
                None => {
                    // Nothing buffered — sleep forever until a new request or shutdown.
                    std::future::pending::<()>().await;
                }
            }
        };
        tokio::select! {
            biased;
            _ = shutdown.notified() => {
                if !buf.is_empty() {
                    flush(&embedder, &mut buf, &stats).await;
                }
                return;
            }
            maybe = rx.recv() => {
                match maybe {
                    Some(req) => {
                        if buf.is_empty() {
                            deadline = Some(Instant::now() + flush_interval);
                        }
                        buf.push(req);
                        if buf.len() >= max_batch {
                            flush(&embedder, &mut buf, &stats).await;
                            deadline = None;
                        }
                    }
                    None => {
                        if !buf.is_empty() {
                            flush(&embedder, &mut buf, &stats).await;
                        }
                        return;
                    }
                }
            }
            _ = sleep => {
                if !buf.is_empty() {
                    flush(&embedder, &mut buf, &stats).await;
                }
                deadline = None;
            }
        }
    }
}

async fn flush(
    embedder: &SharedEmbedder,
    buf: &mut Vec<Req>,
    stats: &Arc<Mutex<BatcherStats>>,
) {
    let start = Instant::now();
    let texts: Vec<String> = buf.iter().map(|r| r.text.clone()).collect();
    let n = texts.len();
    let embedder_clone = embedder.clone();
    let result =
        tokio::task::spawn_blocking(move || embedder_clone.embed(texts)).await;
    let elapsed_ms = start.elapsed().as_millis() as f64;
    match result {
        Ok(Ok(vecs)) => {
            for (req, vec) in buf.drain(..).zip(vecs) {
                let _ = req.reply.send(Ok(vec));
            }
        }
        Ok(Err(e)) => {
            let msg = e.to_string();
            for req in buf.drain(..) {
                let _ = req
                    .reply
                    .send(Err(anyhow::anyhow!("embed failed: {msg}")));
            }
        }
        Err(join_err) => {
            let msg = join_err.to_string();
            for req in buf.drain(..) {
                let _ = req
                    .reply
                    .send(Err(anyhow::anyhow!("batcher join error: {msg}")));
            }
        }
    }
    let mut s = stats.lock();
    s.total_batches += 1;
    s.total_items += n as u64;
    s.avg_batch_ms = (s.avg_batch_ms * (s.total_batches - 1) as f64 + elapsed_ms)
        / s.total_batches as f64;
    s.avg_items_per_batch = s.total_items as f64 / s.total_batches as f64;
}
