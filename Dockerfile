# ------------------------------------------------------------------
# rust-builder stage — compiles ob2-sidecar (CUDA-enabled).
# We compile with --features cuda so the ORT CUDA execution provider
# is registered at runtime when a GPU is present; the binary still
# falls back to CPU on GPU-less hosts, because register_providers()
# probes CUDA::is_available() first.
#
# The embedder crate uses ort's `load-dynamic` feature (not
# `download-binaries`) so the onnxruntime binary is dlopen'd at
# runtime from $ORT_DYLIB_PATH. This lets us ship Microsoft's
# official ORT 1.24.4 CUDA 13 build — which includes sm_120 kernels
# required by Blackwell GPUs (RTX 5090, compute capability 12.0) —
# instead of ort's prebuilt artifacts which top out at sm_90 and
# raise `cudaErrorNoKernelImageForDevice` on first inference.
# ------------------------------------------------------------------
FROM rust:1.88-slim-trixie AS rust-builder
WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev ca-certificates \
    g++ libstdc++-12-dev \
 && rm -rf /var/lib/apt/lists/*
COPY sidecar-rs/ ./sidecar-rs/
RUN cd sidecar-rs && cargo build --release --bin ob2-sidecar --features cuda

# ------------------------------------------------------------------
# ort-dist stage — downloads Microsoft's official ORT 1.24.4 CUDA 13
# Linux x64 tarball. We use the upstream tarball because its CUDA
# provider ships PTX for sm_120 (Blackwell), which ort's own prebuilt
# binaries don't yet (as of ort 2.0.0-rc.12 / early 2026).
# ------------------------------------------------------------------
FROM debian:trixie-slim AS ort-dist
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl && rm -rf /var/lib/apt/lists/*
WORKDIR /ort
RUN curl -sSL \
      "https://github.com/microsoft/onnxruntime/releases/download/v1.24.4/onnxruntime-linux-x64-gpu_cuda13-1.24.4.tgz" \
      -o ort.tgz \
 && tar xzf ort.tgz --strip-components=1 \
 && rm ort.tgz

# ------------------------------------------------------------------
# model-cache stage — populates the on-disk ONNX model + tokenizer
# cache so first runtime call doesn't hit HuggingFace. Uses the ORT
# 1.24.4 CPU-side code paths; no GPU needed in builders.
# ------------------------------------------------------------------
FROM debian:trixie-slim AS model-cache
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libstdc++6 libgomp1 && rm -rf /var/lib/apt/lists/*
COPY --from=rust-builder /build/sidecar-rs/target/release/ob2-sidecar /usr/local/bin/ob2-sidecar
COPY --from=ort-dist    /ort/lib/libonnxruntime.so.1.24.4            /opt/ort/libonnxruntime.so.1.24.4
COPY --from=ort-dist    /ort/lib/libonnxruntime_providers_shared.so  /opt/ort/
COPY --from=ort-dist    /ort/lib/libonnxruntime_providers_cuda.so    /opt/ort/
RUN ln -s libonnxruntime.so.1.24.4 /opt/ort/libonnxruntime.so.1 \
 && ln -s libonnxruntime.so.1      /opt/ort/libonnxruntime.so
# Prewarm runs CPU-only — `CUDA::is_available()` reports false here
# because the builder has no driver, so register_providers() falls
# back to CPU silently. Goal is just to fill the on-disk model cache.
RUN mkdir -p /opt/fastembed-cache \
 && FASTEMBED_CACHE_PATH=/opt/fastembed-cache \
    ORT_DYLIB_PATH=/opt/ort/libonnxruntime.so \
    LD_LIBRARY_PATH=/opt/ort \
    /usr/local/bin/ob2-sidecar --warm-embedder \
    || echo "pre-warm skipped; first-run will download"

# ------------------------------------------------------------------
# cuda-libs stage — source for the CUDA 13 + cuDNN 9 runtime .so
# files the ORT CUDA execution provider dlopens. We only COPY from
# this image, never run it. nvidia-container-toolkit on the host
# injects driver-level libs (libcuda, libnvidia-ml) automatically,
# but the userspace runtime (libcudart, cuBLAS, cuDNN, cuFFT,
# cuRAND) must ship inside the image.
# ------------------------------------------------------------------
FROM nvidia/cuda:13.0.0-cudnn-runtime-ubuntu22.04 AS cuda-libs

# ------------------------------------------------------------------
# Runtime stage — Deno + Python venv + Rust binary, one image
# ------------------------------------------------------------------
FROM denoland/deno:2.3.3 AS deno-base

# Install Python + system deps in the Deno image. libgomp1 is
# required by the ONNX Runtime shared library that the Rust
# sidecar loads at startup.
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-venv python3-pip python3-dev \
    build-essential \
    curl \
    libgomp1 \
    tesseract-ocr tesseract-ocr-eng tesseract-ocr-osd libtesseract-dev ffmpeg libreoffice-common \
    poppler-utils ghostscript unpaper qpdf \
    && rm -rf /var/lib/apt/lists/*

# Replace the apt-installed tesseract "fast" English model with the higher-
# accuracy LSTM "best" trained data from upstream. The fast model ships
# int8-quantized for size/speed; the best model is fp32 and is noticeably
# more accurate on stylized fonts and low-DPI scans (DoD forms, faxes,
# legal docs). Costs ~16 MB and a small per-page slowdown — worth it for
# the OCR fallback path which only fires on image-only PDFs.
RUN TESSDATA_DIR=$(dirname "$(find /usr/share -name eng.traineddata 2>/dev/null | head -1)") && \
    if [ -n "$TESSDATA_DIR" ]; then \
        curl -sSL -o "$TESSDATA_DIR/eng.traineddata" \
            https://github.com/tesseract-ocr/tessdata_best/raw/main/eng.traineddata && \
        echo "Replaced eng.traineddata with tessdata_best (size $(stat -c%s "$TESSDATA_DIR/eng.traineddata"))"; \
    else \
        echo "tessdata directory not found — apt package layout changed?" && exit 1; \
    fi

WORKDIR /app

# Python venv + deps
COPY retrieval/pyproject.toml retrieval/
RUN python3 -m venv /app/retrieval/.venv \
    && /app/retrieval/.venv/bin/pip install --no-cache-dir \
       numpy sqlite-vec sentence-transformers pyyaml \
       "psycopg[binary,pool]" pgvector pymupdf \
       "markitdown[all]>=0.1.5,<0.2" \
       ocrmypdf

# Cache Deno deps
COPY server/deno.json server/deno.lock server/
RUN cd server && deno cache --lock=deno.lock deno.json

# Copy application code
COPY server/ server/
COPY retrieval/ retrieval/
COPY cli/ cli/

# Copy context-engine (bundled into image)
COPY context-engine/ context-engine/

# Pre-download the embedding model so first request isn't slow
RUN /app/retrieval/.venv/bin/python -c "\
from sentence_transformers import SentenceTransformer; \
m = SentenceTransformer('all-MiniLM-L6-v2'); \
print(f'Model cached: {m.get_sentence_embedding_dimension()}d on {m.device}')"

# Rust sidecar binary + pre-warmed embedding cache + ORT dynamic lib.
# ORT's CUDA provider plug-in (libonnxruntime_providers_cuda.so) is
# dlopen'd by libonnxruntime.so from the same directory, so we colocate
# all three .so files.
COPY --from=rust-builder /build/sidecar-rs/target/release/ob2-sidecar     /app/sidecar-rs/ob2-sidecar
COPY --from=ort-dist     /ort/lib/libonnxruntime.so.1.24.4                /app/sidecar-rs/
COPY --from=ort-dist     /ort/lib/libonnxruntime_providers_shared.so      /app/sidecar-rs/
COPY --from=ort-dist     /ort/lib/libonnxruntime_providers_cuda.so        /app/sidecar-rs/
RUN ln -s libonnxruntime.so.1.24.4 /app/sidecar-rs/libonnxruntime.so.1 \
 && ln -s libonnxruntime.so.1      /app/sidecar-rs/libonnxruntime.so
COPY --from=model-cache /opt/fastembed-cache /app/.cache/fastembed
ENV FASTEMBED_CACHE_PATH=/app/.cache/fastembed
# ort's load-dynamic feature reads this env var to locate the onnxruntime
# shared library. Must point at the versioned .so; the plug-ins next to it
# are found automatically.
ENV ORT_DYLIB_PATH=/app/sidecar-rs/libonnxruntime.so

# CUDA 13 + cuDNN 9 userspace libs needed by libonnxruntime_providers_cuda.so.
# Driver-level libs (libcuda.so, libnvidia-ml.so) are injected by the NVIDIA
# Container Toolkit at run time; everything below ships with the image.
# ldd'ing libonnxruntime_providers_cuda.so from the ORT 1.24.4 CUDA 13 build
# shows these six transitive SONAMEs.
COPY --from=cuda-libs /usr/local/cuda-13.0/targets/x86_64-linux/lib/libcudart.so.13    /usr/local/cuda/lib64/
COPY --from=cuda-libs /usr/local/cuda-13.0/targets/x86_64-linux/lib/libcublas.so.13    /usr/local/cuda/lib64/
COPY --from=cuda-libs /usr/local/cuda-13.0/targets/x86_64-linux/lib/libcublasLt.so.13  /usr/local/cuda/lib64/
COPY --from=cuda-libs /usr/local/cuda-13.0/targets/x86_64-linux/lib/libcurand.so.10    /usr/local/cuda/lib64/
COPY --from=cuda-libs /usr/local/cuda-13.0/targets/x86_64-linux/lib/libcufft.so.12     /usr/local/cuda/lib64/
COPY --from=cuda-libs /usr/lib/x86_64-linux-gnu/libcudnn.so.9                          /usr/local/cuda/lib64/
# cuDNN 9 sublibs — libcudnn.so.9 dlopens these lazily, but if absent the
# first CUDA inference call dies with "cudnnGraphAPI: library not found".
COPY --from=cuda-libs /usr/lib/x86_64-linux-gnu/libcudnn_graph.so.9                    /usr/local/cuda/lib64/
COPY --from=cuda-libs /usr/lib/x86_64-linux-gnu/libcudnn_ops.so.9                      /usr/local/cuda/lib64/
COPY --from=cuda-libs /usr/lib/x86_64-linux-gnu/libcudnn_cnn.so.9                      /usr/local/cuda/lib64/
COPY --from=cuda-libs /usr/lib/x86_64-linux-gnu/libcudnn_adv.so.9                      /usr/local/cuda/lib64/
COPY --from=cuda-libs /usr/lib/x86_64-linux-gnu/libcudnn_heuristic.so.9                /usr/local/cuda/lib64/
COPY --from=cuda-libs /usr/lib/x86_64-linux-gnu/libcudnn_engines_precompiled.so.9      /usr/local/cuda/lib64/
COPY --from=cuda-libs /usr/lib/x86_64-linux-gnu/libcudnn_engines_runtime_compiled.so.9 /usr/local/cuda/lib64/
ENV LD_LIBRARY_PATH=/usr/local/cuda/lib64:/app/sidecar-rs:${LD_LIBRARY_PATH}

EXPOSE 7600

ENV OB2_HOST=0.0.0.0
ENV OB2_PORT=7600
ENV OB2_PYTHON=/app/retrieval/.venv/bin/python
ENV OB2_SIDECAR_SCRIPT=/app/retrieval/sidecar.py
ENV OB2_RUST_SIDECAR_BIN=/app/sidecar-rs/ob2-sidecar
ENV OB2_CONTEXT_ENGINE_PATH=/app/context-engine
ENV OB2_SQLITE_PATH=/data/ob2.db
ENV OB2_STORAGE_BACKEND=two-tier
ENV OB2_USERS_FILE=/data/users.json
ENV OB2_RUNTIME_CONFIG_PATH=/data/config.yaml

VOLUME ["/data"]

WORKDIR /app/server
CMD ["deno", "task", "start"]
