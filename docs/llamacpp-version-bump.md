# Bumping `LLAMA_CPP_REF`

The `ob2-llamacpp` container builds llama.cpp from source against a pinned tag.
Operators control bump cadence — there's no automatic upgrade.

## When to bump

- A new llama.cpp release fixes a bug you're hitting (check
  https://github.com/ggerganov/llama.cpp/releases).
- A new GGUF format requires a newer llama.cpp.
- A new model architecture (e.g. a new Qwen, Llama, or Gemma generation) needs newer
  llama.cpp support.

If none of the above apply, **don't bump.** A pinned ref that works today will keep
working forever; the only reason to upgrade is when something specific demands it.

## How to bump

1. **Find the new ref.** Pick a tag from
   https://github.com/ggerganov/llama.cpp/tags. Use the latest stable release
   (avoid `master` — pin to a tag).

2. **Update the Dockerfile.** Edit `docker/Dockerfile.llamacpp`:
   ```dockerfile
   ARG LLAMA_CPP_REF=b4404         # ← change this line to the new tag
   ```
   And `docker/docker-compose.yml`:
   ```yaml
   build:
     args:
       LLAMA_CPP_REF: "b4404"      # ← keep in sync with the Dockerfile default
   ```

3. **Rebuild:**
   ```bash
   cd /path/to/OB2_TurboQuant
   docker compose -f docker/docker-compose.yml --profile llamacpp build ob2-llamacpp
   ```
   First build is ~5–10 min; subsequent builds are ~1 min thanks to layer caching.

4. **Smoke test:**
   ```bash
   scripts/docker-start.sh --with-llamacpp
   # Wait ~30s for the new container to come up.
   curl -s http://localhost:8081/healthz | grep version
   # Load a model:
   curl -s -X POST -H "Authorization: Bearer $OB2_LLAMACPP_MANAGER_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"filename":"<your-test-model>.gguf"}' \
     http://localhost:8081/v1/load
   # Send a test chat through OB2:
   curl -N -H "Authorization: Bearer $OB2_BRAIN_KEY" -H "Content-Type: application/json" \
     -d '{"model":"ob2","messages":[{"role":"user","content":"say hi"}],"stream":true}' \
     http://localhost:7600/v1/chat/completions | head -10
   ```
   Expected: a streaming SSE response. If you get a non-empty `content` delta, the bump worked.

5. **Commit the change** (single-line diff):
   ```bash
   git add docker/Dockerfile.llamacpp docker/docker-compose.yml
   git commit -m "chore(docker): bump LLAMA_CPP_REF to bNNNN"
   ```

## Rollback

If the new ref regresses:

1. Revert the commit: `git revert <commit-sha>`.
2. Rebuild: `docker compose --profile llamacpp build ob2-llamacpp`.
3. Restart: `scripts/docker-stop.sh --with-llamacpp && scripts/docker-start.sh --with-llamacpp`.

## Known compatibility notes

- **GGUF v3 → v4:** llama.cpp may bump the GGUF major version. Older quants stop loading.
  Re-quantize the model with the matching `convert_hf_to_gguf.py` script, or pin to an
  older `LLAMA_CPP_REF` until you can re-quantize.
- **CUDA driver requirements:** new releases sometimes require newer NVIDIA drivers. If
  the container fails on `cudaErrorInsufficientDriver`, update your host's NVIDIA driver.

## Don't bump

- Mid-incident: pin first, debug second.
- Without testing on a non-production stack first if you have one.
