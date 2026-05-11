# OB2 TurboQuant — System Diagrams

All diagrams are written in [Mermaid](https://mermaid.js.org/) and render natively on GitHub, GitLab, and in most Markdown previewers.

---

## 1. Container Topology

```mermaid
graph TB
    subgraph host["Host Machine (Windows / Linux)"]
        ollama["Ollama\n:11434"]
        browser["Browser / API Client"]
    end

    subgraph stack["Docker Compose — ob2_turboquant"]
        server["ob2-server\nDeno + Hono\n:7600 main\n:7601 OW proxy"]
        postgres["ob2-postgres\npgvector:pg17\n:5433→5432"]
        pgadmin["ob2-pgadmin\n:5051→80\n(optional)"]

        subgraph llamacpp["ob2-llamacpp (profile: llamacpp)"]
            manager["ob2-llamacpp-manager\nDeno\n:8081 control"]
            llama["llama-server\nTurboQuant fork\n:8080 chat"]
            manager -->|spawns / supervises| llama
        end

        subgraph openwebui["ob2-openwebui (profile: openwebui)"]
            owui["Open WebUI\n:8080 internal"]
        end
    end

    subgraph volumes["Docker Volumes"]
        ob2data["ob2_data\n/data"]
        pgdata["ob2_pgdata"]
        models["llamacpp_models\n/data/llamacpp/models"]
    end

    browser -->|HTTP| server
    server -->|pgvector| postgres
    server -->|control plane HTTP| manager
    server -->|chat /v1| llama
    server -->|proxy :7601| owui
    owui -->|/v1/chat| server
    server -->|host.docker.internal| ollama
    server --- ob2data
    postgres --- pgdata
    llama --- models
```

---

## 2. Chat Request Flow (RAG Pipeline)

```mermaid
sequenceDiagram
    participant C as Client
    participant GW as gateway.ts
    participant SC as Python Sidecar
    participant PG as pgvector
    participant LLM as llama-server

    C->>GW: POST /v1/chat/completions
    GW->>GW: bearerAuth + resolve @domain
    GW->>SC: build_context(domain, query, budget=2048)
    SC->>SC: embed(query) → 384-dim vector
    SC->>PG: HNSW cosine search top-5
    PG-->>SC: ranked chunks
    SC->>SC: hybrid rerank (TF-IDF + vector + graph)
    SC-->>GW: compressed_text (≤2048 tokens)
    GW->>GW: augmentWithContext (system prompt + sources)
    GW->>LLM: POST /v1/chat/completions (SSE)
    LLM-->>GW: token stream
    GW-->>C: OpenAI SSE response
```

---

## 3. TurboQuant KV Cache

```mermaid
flowchart LR
    subgraph inference["llama-server inference"]
        input["Input tokens\n(prompt + context)"]
        attn["Attention layers\n35B MoE — 3B active"]
        kv["KV Cache\n--cache-type-k turbo3\n--cache-type-v turbo3\n~3 bits/value"]
        out["Output tokens"]

        input --> attn
        attn <-->|read / write| kv
        attn --> out
    end

    subgraph cache["--cache-prompt (cross-request reuse)"]
        turn1["Turn 1\nfull prefill"]
        turn2["Turn 2\nnew tokens only"]
        turn3["Turn 3\nnew tokens only"]
        turn1 -->|KV cache preserved| turn2
        turn2 -->|KV cache preserved| turn3
    end
```

---

## 4. Knowledge Graph Extraction Pipeline

```mermaid
flowchart TD
    ingest["Document ingested\nmethod_convert_to_markdown"]
    chunk["Chunked + embedded\nstored in pgvector"]
    trigger{"graph.extraction\n_enabled?"}
    extract["method_extract_entities\n(async, per chunk)"]

    subgraph dispatch["Provider dispatch"]
        prov{"llm.provider?"}
        ollama_ext["_ollama_extract\nPOST /api/chat\nformat=json"]
        openai_ext["_openai_extract\nPOST /v1/chat/completions\nresponse_format=json_object\n/no_think for Qwen3"]
    end

    parse["Parse JSON\nraw_decode → ignore trailing text\nstrip think tags"]
    store["Upsert entities + edges\nstamp _ob2_graph_extracted_at"]
    rerank["Graph rerank\n(graph.enabled=true)\nboost chunks near\nmentioned entities"]

    ingest --> chunk
    chunk --> trigger
    trigger -->|yes| extract
    extract --> prov
    prov -->|ollama| ollama_ext
    prov -->|llamacpp| openai_ext
    ollama_ext --> parse
    openai_ext --> parse
    parse --> store
    store -.->|retrieval reranking| rerank
```

---

## 5. llamacpp Manager — Model Lifecycle

```mermaid
stateDiagram-v2
    [*] --> Idle : startup\n(no .last_loaded.json)
    [*] --> Loading : startup\n(.last_loaded.json found)

    Idle --> Loading : POST /v1/load\nPOST /v1/pull (then load)
    Loading --> Loaded : awaitHealth() OK\n(≤300s)
    Loading --> Idle : awaitHealth() timeout\nor llama-server crash
    Loaded --> Loading : POST /v1/load (swap)\nPOST /v1/restart
    Loaded --> Idle : POST /v1/unload
    Loaded --> Idle : llama-server crash\n(_watchExit detects)
```

---

## 6. Graph Backfill — Resume Logic

```mermaid
flowchart TD
    start["POST /admin/domains/:domain/graph/backfill\n{force?: bool}"]
    list["List all user docs\n(skip _ob2_system)"]
    filter{"force=true?"}
    all["Process ALL docs"]
    unextracted["Process only docs WITHOUT\n_ob2_graph_extracted_at"]
    extract["method_extract_entities\ndelete_doc_graph first"]
    stamp["stamp _ob2_graph_extracted_at\non success"]
    done["status: done"]

    start --> list
    list --> filter
    filter -->|yes| all
    filter -->|no| unextracted
    all --> extract
    unextracted --> extract
    extract --> stamp
    stamp -->|next doc| extract
    extract --> done
```

---

## 7. Dashboard LLMs Tab — llamacpp Mode

```mermaid
flowchart TD
    load["GET /admin/llm/capabilities\nprovider=llamacpp"]
    panel["Show llamacpp panel\n(hide Ollama panel)"]
    active["GET /admin/llm/active\n→ model label"]
    loaded["GET /admin/llm/loaded\n→ port + started_at"]
    models["GET /admin/llm/models\n→ GGUF list"]

    meta["Loaded model card\nfilename · port NNNN · loaded X min ago"]
    table["Available GGUFs table\nfilename · size · quant · status"]

    load --> panel
    panel --> active & models
    active --> loaded
    loaded --> meta
    models --> table

    pull["POST /admin/llm/pull\n{source: hf, repo, file}\nNDJSON progress stream\nformatBytes display"]
    loadbtn["POST /admin/llm/load\n{filename, ctx_size, gpu_layers}\nLoading… button state"]
    unload["POST /admin/llm/unload\nUnloading… button state"]
    restart["POST /admin/llm/restart\nRestart with new settings modal\n(no swap warning)"]

    table --> pull & loadbtn & unload & restart
```

---

## 8. Email / SMTP Subsystem

Three callers, one interface, two drivers, one external SMTP server. Driver selection and credentials are read fresh from `runtime_config` on every send — edits to the dashboard's **Config → Email** card hot-reload without a restart.

```mermaid
flowchart LR
    subgraph callers["Callers in server/routes"]
        invite["POST /admin/users/:u/invite<br/>renderInviteEmail()"]
        forgot["POST /auth/forgot-password<br/>renderResetEmail()"]
        test["POST /admin/smtp/test<br/>renderSmtpTestEmail()"]
    end

    subgraph mailer["server/mail"]
        iface["Mailer interface<br/>send() · isConfigured()"]
        log["LogMailer<br/>writes /data/mail-log.txt<br/>(refuses on public https)"]
        smtp["SmtpMailer<br/>opens socket per send<br/>via denomailer 1.6.0"]
        dispatch{{"getMailer()<br/>reads mail.driver"}}
        iface --- dispatch
        dispatch -->|driver=&quot;log&quot;| log
        dispatch -->|driver=&quot;smtp&quot;| smtp
    end

    cfg[("Runtime config<br/>/data/config.yaml<br/>+ OB2_SMTP_* env overrides<br/>(env wins)")]

    smtpserver["External SMTP server<br/>(Gmail · Titan · SES · …)"]

    callers --> iface
    cfg -.read on every send.-> smtp
    cfg -.read on every send.-> log
    smtp -->|TLS:465 / STARTTLS:587| smtpserver
```

**Configuration requirements per caller:**

```mermaid
flowchart TD
    test["POST /admin/smtp/test"]:::test
    invite["Invite / Reset flows"]:::link

    host["mail.host"]
    from["mail.from"]
    auth["mail.user + mail.pass<br/>(only if server requires)"]
    pub["mail.public_url<br/>(builds the clickable link)"]

    host --> test
    from --> test
    auth -.optional.-> test

    host --> invite
    from --> invite
    auth -.optional.-> invite
    pub --> invite

    classDef test fill:#dfd,stroke:#2a2
    classDef link fill:#ffd,stroke:#aa0
```

The test endpoint deliberately does **not** require `public_url` — it only opens a socket and sends one message, no URL building. Older versions checked `public_url` inside `SmtpMailer.isConfigured()` and rejected the test with a misleading `"mailer not configured"`; that check now lives only at the invite/reset call sites where it actually matters.

**`POST /admin/config/mail` write path** (merge, not clobber):

```mermaid
flowchart LR
    body["JSON body<br/>{driver, host, port, user,<br/>pass, secure, from, public_url}"]
    merge["Merge with current<br/>getRuntime().mail<br/>(empty/•••• pass → keep)"]
    validate["validateRuntime({mail: nextMail})"]
    overlay["...getFileConfig(),<br/>mail: nextMail"]
    write["writeRuntime() →<br/>yaml.dump /data/config.yaml"]
    reload["mtime watcher reloads<br/>on next getRuntime()"]

    body --> merge --> validate --> overlay --> write --> reload
```

The `getFileConfig()` overlay preserves every other section (`llm`, `llamacpp`, `openai`, `anthropic`, `gemini`, `graph`, `context`, …) that already lives in `/data/config.yaml`, so saving mail credentials never touches LLM provider settings or anything else.

