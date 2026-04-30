# llama.cpp host-mode setup (Windows / macOS)

This guide covers running `llama-server` directly on a Windows or Mac host using the
prebuilt `turboquant_plus` binaries, with `ob2-llamacpp-manager` supervising it. OB2
(running in Docker) reaches the manager and llama-server via `host.docker.internal`.

If you're on Linux with Docker GPU support, use `scripts/docker-start.sh --with-llamacpp`
instead — that runs everything in containers.

## Step 1: Get the prebuilt binaries

### Windows (CUDA 12.4)

1. Download `turboquant-plus--windows-x64-cuda12.4.zip` from
   https://github.com/TheTom/turboquant_plus/releases/latest.
2. Unzip into `C:\turboquant\`.
3. Download `ob2-llamacpp-manager-windows-x64.zip` from this project's releases page
   (https://github.com/<your-org>/OB2_TurboQuant/releases/latest) and unzip its contents
   into the same `C:\turboquant\` folder. You should now have both `llama-server.exe`
   and `ob2-llamacpp-manager.exe` next to each other.
4. Create a `models` subdirectory: `mkdir C:\turboquant\models`.
5. Drop your `.gguf` files into `C:\turboquant\models\` (or use the manager to pull them
   later).

### macOS (Apple Silicon, Metal)

1. Download `turboquant-plus--macos-arm64-metal.tar.gz` and extract to `~/turboquant/`.
2. Download `ob2-llamacpp-manager-macos-arm64.tar.gz` from this project's releases and
   extract into the same folder.
3. `mkdir ~/turboquant/models` and drop GGUFs into it.

## Step 2: Start the manager

### Windows: create `ob2-llamacpp.bat`

Save this as `C:\turboquant\ob2-llamacpp.bat`:

```bat
@echo off
set OB2_LLAMA_SERVER_BIN=%~dp0llama-server.exe
set OB2_LLAMACPP_MODELS_DIR=%~dp0models
set OB2_LLAMACPP_MANAGER_PORT=8081
set OB2_LLAMACPP_CHAT_PORT=8080
if "%OB2_LLAMACPP_MANAGER_TOKEN%"=="" (
  echo ERROR: set OB2_LLAMACPP_MANAGER_TOKEN env var first
  echo   PowerShell:  $env:OB2_LLAMACPP_MANAGER_TOKEN = "your-token"
  pause
  exit /b 1
)
"%~dp0ob2-llamacpp-manager.exe"
```

Generate a random token (PowerShell):
```powershell
$bytes = New-Object Byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
[Convert]::ToHexString($bytes).ToLower()
```

Copy that token to your `OB2_TurboQuant/.env`:
```
OB2_LLM_PROVIDER=llamacpp
OB2_LLAMACPP_MANAGER_URL=http://host.docker.internal:8081
OB2_LLAMACPP_CHAT_URL=http://host.docker.internal:8080
OB2_LLAMACPP_MANAGER_TOKEN=<paste here>
```

In PowerShell, set the same token:
```powershell
$env:OB2_LLAMACPP_MANAGER_TOKEN = "<paste here>"
```

Then double-click `ob2-llamacpp.bat`.

### macOS: create `ob2-llamacpp.command`

Save as `~/turboquant/ob2-llamacpp.command`:

```bash
#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
export OB2_LLAMA_SERVER_BIN="$DIR/llama-server"
export OB2_LLAMACPP_MODELS_DIR="$DIR/models"
export OB2_LLAMACPP_MANAGER_PORT=8081
export OB2_LLAMACPP_CHAT_PORT=8080
if [ -z "$OB2_LLAMACPP_MANAGER_TOKEN" ]; then
  echo "ERROR: set OB2_LLAMACPP_MANAGER_TOKEN env var first"
  echo "  export OB2_LLAMACPP_MANAGER_TOKEN=\$(openssl rand -hex 32)"
  exit 1
fi
exec "$DIR/ob2-llamacpp-manager"
```

Make executable: `chmod +x ~/turboquant/ob2-llamacpp.command`.

Generate token + run:
```bash
export OB2_LLAMACPP_MANAGER_TOKEN=$(openssl rand -hex 32)
echo $OB2_LLAMACPP_MANAGER_TOKEN  # paste this into OB2's .env too
~/turboquant/ob2-llamacpp.command
```

## Step 3: Configure OB2 (Docker side)

In `OB2_TurboQuant/.env`:
```
OB2_LLM_PROVIDER=llamacpp
OB2_LLAMACPP_MANAGER_URL=http://host.docker.internal:8081
OB2_LLAMACPP_CHAT_URL=http://host.docker.internal:8080
OB2_LLAMACPP_MANAGER_TOKEN=<the token from Step 2>
```

Then run: `scripts/docker-start.sh` (without `--with-llamacpp` — that flag is for the
containerized mode; in host mode the manager runs on the host).

Verify: `curl http://localhost:8081/healthz` should return JSON with `ok: true`.

## Step 4: Load a model

```bash
curl -X POST -H "Authorization: Bearer $OB2_LLAMACPP_MANAGER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"filename":"qwen2.5-7b-instruct.Q4_K_M.gguf"}' \
  http://localhost:8081/v1/load
```

This swaps in the model. Subsequent chat through OB2 (e.g. via Open WebUI) hits this
loaded model.

## Troubleshooting

- **Manager logs:** stdout/stderr of the launcher. Redirect to a file if you prefer.
- **Llama-server logs:** captured by the manager and surfaced in `/v1/load` error
  responses (last 4 KB of stderr).
- **`/healthz` shows `running: false`** after a successful load: usually means the model
  fell over post-spawn (OOM, bad GGUF). Check the load response's `stderr_tail` field.
- **Connection refused from OB2 → manager:** Docker Desktop must support `host.docker.internal`.
  On Linux + Docker Engine, you may need to add `extra_hosts: ["host.docker.internal:host-gateway"]`
  to the `ob2-server` service.
