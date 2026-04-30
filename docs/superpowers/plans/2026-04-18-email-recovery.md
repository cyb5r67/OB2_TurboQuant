# Email-Based Recovery & Onboarding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add email-based password recovery and invite-based onboarding to OB2. Users self-serve via a "Forgot password?" link. Admins create users without typing initial passwords; the user sets their own via an emailed invite link.

**Architecture:** New `server/mail/` module with a `Mailer` interface and two drivers (`SmtpMailer` using `denomailer`, `LogMailer` for tests). New `server/auth/reset-tokens.ts` for single-use, TTL-bounded, hashed-at-rest tokens. New `server/auth/rate-limit.ts` for per-key in-memory throttling. Three new public endpoints (`/auth/forgot-password`, `/auth/reset-password`, `/auth/reset-token-info`) plus four authenticated ones (`/auth/email`, `/admin/users/:name/invite`, `/admin/smtp/test`, plus extensions to existing admin routes). Dashboard UI gains a forgot-password modal, a reset/invite form, a Profile email card, a Users tab radio group for invite-vs-initial-password, and a Config tab SMTP section.

**Tech Stack:** Deno + Hono (TypeScript), vanilla JS dashboard, `denomailer` for SMTP, argon2id via `hash-wasm` (already in use), bash/curl e2e tests.

**Spec:** `docs/superpowers/specs/2026-04-18-email-recovery-design.md`

---

## Conventions

- Working directory: `/mnt/c/projects/OB2`. Implementer should start on a new feature branch `email-recovery` off `master`.
- Verification policy: **typecheck-only** during implementation (`cd server && $HOME/.deno/bin/deno check index.ts`). The full e2e suite is run at the end (Task 22) by the user against the live Docker stack.
- Commit policy: one commit per task. Conventional-style messages. No `--no-verify`, no `--amend`. Each commit ends with the Co-Authored-By line.
- Module naming: `server/mail/*.ts` for mailer, `server/auth/*.ts` for auth-adjacent (tokens, rate-limit). Follow the existing pattern of small focused files.
- Test file: all new assertions append to `tests/e2e.sh` as a new `── Step 13: Email recovery ──` section, inserted before the Summary block. Rely on existing helpers: `assert_contains`, `assert_status`, `$KEY`, `$BOB_KEY`, `$BASE`, `$PROJECT_DIR`, `$DENO`.

---

## File structure

Created:
- `server/mail/mailer.ts` — Mailer interface + createMailer factory + module-level singleton getter.
- `server/mail/smtp.ts` — SmtpMailer wrapping denomailer.
- `server/mail/log.ts` — LogMailer that writes to `server/data/mail-log.txt`.
- `server/mail/templates.ts` — renderResetEmail, renderInviteEmail, renderSmtpTestEmail.
- `server/auth/reset-tokens.ts` — token store (file-backed JSON, same pattern as users.ts).
- `server/auth/rate-limit.ts` — in-memory limiter.
- `server/data/` — directory for reset-tokens.json + mail-log.txt (runtime-written, not committed).

Modified:
- `server/config.ts` — new SMTP + publicUrl fields.
- `server/users.ts` — optional `email` field + validation + setEmail function.
- `server/routes/auth.ts` — three new public endpoints + one authenticated endpoint.
- `server/routes/admin.ts` — three new authenticated endpoints + extension to POST /users.
- `server/static/dashboard.html` — forgot-password modal, reset form, Profile email card, Users create radio, Config SMTP section.
- `tests/e2e.sh` — new Step 13 block with 12 assertions.
- `docs/user-guide.md` — email recovery section, troubleshooting.
- `.gitignore` — add `server/data/reset-tokens.json` and `server/data/mail-log.txt`.

---

## Task 0: Branch + gitignore

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Create branch**

```bash
cd /mnt/c/projects/OB2
git checkout master
git pull --ff-only 2>/dev/null || true
git checkout -b email-recovery
```

- [ ] **Step 2: Append gitignore entries**

Read `.gitignore` first to see existing content. Append at the end:

```
# Runtime-written email recovery state
server/data/reset-tokens.json
server/data/reset-tokens.json.tmp.*
server/data/mail-log.txt
```

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "$(cat <<'EOF'
Add email-recovery branch setup

Ignore runtime state files that the upcoming reset-tokens store and
LogMailer will write to server/data/.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 1: Config additions (SMTP + publicUrl)

**Files:**
- Modify: `server/config.ts`

- [ ] **Step 1: Extend `Config` interface and `loadConfig`**

Replace the entire contents of `server/config.ts` with:

```ts
// Central config. All env vars parsed here, with defaults and validation.

export interface Config {
  brainKey: string;
  port: number;
  host: string;
  storageBackend: "sqlite" | "pgvector" | "two-tier";
  sqlitePath: string;
  pgUrl: string;
  ollamaUrl: string;
  ollamaModel: string;
  autoRoute: boolean;
  classifierModel: string;
  usersFile: string;
  runtimeConfigPath: string;
  python: string;
  sidecarScript: string;
  // Email recovery (spec 2)
  smtpDriver: "smtp" | "log" | "";   // "" = disabled
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpSecure: "tls" | "starttls" | "none";
  smtpFrom: string;
  publicUrl: string;
}

function required(name: string): string {
  const v = Deno.env.get(name);
  if (!v) {
    throw new Error(`missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  return Deno.env.get(name) ?? fallback;
}

export function loadConfig(): Config {
  const backend = optional("OB2_STORAGE_BACKEND", "two-tier");
  if (backend !== "sqlite" && backend !== "pgvector" && backend !== "two-tier") {
    throw new Error(`OB2_STORAGE_BACKEND must be 'sqlite', 'pgvector', or 'two-tier', got '${backend}'`);
  }

  const smtpDriverRaw = optional("OB2_SMTP_DRIVER", "");
  let smtpDriver: Config["smtpDriver"];
  if (smtpDriverRaw === "smtp" || smtpDriverRaw === "log" || smtpDriverRaw === "") {
    smtpDriver = smtpDriverRaw;
  } else {
    throw new Error(`OB2_SMTP_DRIVER must be 'smtp', 'log', or unset, got '${smtpDriverRaw}'`);
  }

  const smtpSecureRaw = optional("OB2_SMTP_SECURE", "starttls");
  if (smtpSecureRaw !== "tls" && smtpSecureRaw !== "starttls" && smtpSecureRaw !== "none") {
    throw new Error(`OB2_SMTP_SECURE must be 'tls', 'starttls', or 'none', got '${smtpSecureRaw}'`);
  }

  const cfg: Config = {
    brainKey: required("OB2_BRAIN_KEY"),
    port: parseInt(optional("OB2_PORT", "7600"), 10),
    host: optional("OB2_HOST", "127.0.0.1"),
    storageBackend: backend,
    sqlitePath: optional("OB2_SQLITE_PATH", "./ob2.db"),
    pgUrl: optional("OB2_PG_URL", ""),
    ollamaUrl: optional("OB2_OLLAMA_URL", "http://localhost:11434"),
    ollamaModel: optional("OB2_OLLAMA_MODEL", "gemma3:4b"),
    autoRoute: optional("OB2_AUTO_ROUTE", "false") === "true",
    classifierModel: optional("OB2_CLASSIFIER_MODEL", ""),
    usersFile: optional("OB2_USERS_FILE", "../users.json"),
    runtimeConfigPath: optional("OB2_RUNTIME_CONFIG_PATH", "../config.yaml"),
    python: optional("OB2_PYTHON", "python3"),
    sidecarScript: optional("OB2_SIDECAR_SCRIPT", "../retrieval/sidecar.py"),
    smtpDriver,
    smtpHost: optional("OB2_SMTP_HOST", ""),
    smtpPort: parseInt(optional("OB2_SMTP_PORT", "587"), 10),
    smtpUser: optional("OB2_SMTP_USER", ""),
    smtpPass: optional("OB2_SMTP_PASS", ""),
    smtpSecure: smtpSecureRaw,
    smtpFrom: optional("OB2_SMTP_FROM", ""),
    publicUrl: optional("OB2_PUBLIC_URL", ""),
  };

  // Non-fatal warnings
  const smtpAnySet = cfg.smtpHost || cfg.smtpUser || cfg.smtpPass || cfg.smtpFrom;
  if (smtpAnySet && !cfg.publicUrl) {
    console.warn(
      "WARN: SMTP configured but OB2_PUBLIC_URL unset — email-based recovery disabled",
    );
  }
  if (cfg.publicUrl && !cfg.publicUrl.startsWith("http://") && !cfg.publicUrl.startsWith("https://")) {
    console.warn(`WARN: OB2_PUBLIC_URL should start with http:// or https:// (got '${cfg.publicUrl}')`);
  }
  if (cfg.publicUrl.endsWith("/")) {
    console.warn(`WARN: OB2_PUBLIC_URL should not end with '/' (got '${cfg.publicUrl}')`);
  }

  return cfg;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd server && $HOME/.deno/bin/deno check index.ts`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/config.ts
git commit -m "$(cat <<'EOF'
Add SMTP + publicUrl config fields

Extend Config with smtpDriver/Host/Port/User/Pass/Secure/From and
publicUrl. All env-driven with sensible defaults; strict validation
on the enum fields. Emits startup warnings when SMTP is partially
configured or publicUrl is malformed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Mailer interface + LogMailer

**Files:**
- Create: `server/mail/mailer.ts`
- Create: `server/mail/log.ts`

- [ ] **Step 1: Create `server/mail/` directory**

```bash
mkdir -p server/mail server/data
```

- [ ] **Step 2: Write `server/mail/mailer.ts`**

```ts
// Mailer interface + driver dispatch.
//
// Drivers currently shipped:
//   - SmtpMailer: production RFC-5321 SMTP via denomailer.
//   - LogMailer:  test-only — writes outbound mail to server/data/mail-log.txt.
//
// Adding a provider-specific HTTP driver (Sendgrid, SES, Mailgun) means a new
// file under server/mail/, a new case in createMailer, and a new allowed value
// on Config.smtpDriver.

import type { Config } from "../config.ts";
import { LogMailer } from "./log.ts";
import { SmtpMailer } from "./smtp.ts";

export interface Mailer {
  send(msg: { to: string; subject: string; text: string; html: string }): Promise<void>;
  isConfigured(): boolean;
}

let _mailer: Mailer | null = null;

export function initMailer(config: Config): void {
  _mailer = createMailer(config);
}

export function getMailer(): Mailer | null {
  return _mailer;
}

function createMailer(config: Config): Mailer | null {
  if (config.smtpDriver === "log") return new LogMailer();
  if (config.smtpDriver === "smtp" || config.smtpHost) return new SmtpMailer(config);
  return null;
}
```

- [ ] **Step 3: Write `server/mail/log.ts`**

```ts
// Test-only mailer. Writes every outbound email to server/data/mail-log.txt
// and echoes a one-line summary to stdout. Used by tests via OB2_SMTP_DRIVER=log.
//
// Never enable in production — password-reset URLs would be logged in plaintext.

import type { Mailer } from "./mailer.ts";

const LOG_PATH = "../server/data/mail-log.txt";

export class LogMailer implements Mailer {
  isConfigured(): boolean {
    return true;
  }

  async send(msg: { to: string; subject: string; text: string; html: string }): Promise<void> {
    const line = `[MAIL to=${msg.to} subject=${JSON.stringify(msg.subject)}]`;
    console.log(line);
    const stamp = new Date().toISOString();
    const body =
      `\n===== ${stamp} =====\n` +
      `To: ${msg.to}\n` +
      `Subject: ${msg.subject}\n` +
      `\n--- text ---\n${msg.text}\n` +
      `\n--- html ---\n${msg.html}\n`;
    try {
      await Deno.mkdir("../server/data", { recursive: true });
    } catch { /* already exists */ }
    await Deno.writeTextFile(LOG_PATH, body, { append: true });
  }
}
```

- [ ] **Step 4: Write a stub `server/mail/smtp.ts` (fleshed out in Task 3)**

This stub lets the factory typecheck before Task 3 lands the real implementation.

```ts
// Stub — real implementation in Task 3.
import type { Config } from "../config.ts";
import type { Mailer } from "./mailer.ts";

export class SmtpMailer implements Mailer {
  // deno-lint-ignore no-unused-vars
  constructor(private config: Config) {}

  isConfigured(): boolean {
    return !!this.config.smtpHost;
  }

  // deno-lint-ignore require-await
  async send(_msg: { to: string; subject: string; text: string; html: string }): Promise<void> {
    throw new Error("SmtpMailer: not yet implemented (see Task 3)");
  }
}
```

- [ ] **Step 5: Typecheck**

Run: `cd server && $HOME/.deno/bin/deno check index.ts`
Expected: no errors. (Note: `initMailer` is declared but not yet called; that's fine — it's an exported function, Deno won't flag it.)

- [ ] **Step 6: Commit**

```bash
git add server/mail/mailer.ts server/mail/log.ts server/mail/smtp.ts
git commit -m "$(cat <<'EOF'
Add Mailer interface + LogMailer

Driver-agnostic interface (Mailer.send + isConfigured). LogMailer
writes outbound mail to server/data/mail-log.txt for test use via
OB2_SMTP_DRIVER=log. SmtpMailer stubbed — fleshed out next task.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: SmtpMailer with denomailer

**Files:**
- Modify: `server/mail/smtp.ts`
- Modify: `server/deno.json` (add denomailer import)

- [ ] **Step 1: Add denomailer to deno.json imports**

Read `server/deno.json`. Add `"denomailer": "https://deno.land/x/denomailer@1.6.0/mod.ts"` to the `imports` object. The result should look like:

```json
{
  "imports": {
    "@hono/mcp": "npm:@hono/mcp@0.1.1",
    "@modelcontextprotocol/sdk": "npm:@modelcontextprotocol/sdk@1.24.3",
    "hono": "npm:hono@4.9.2",
    "zod": "npm:zod@4.1.13",
    "denomailer": "https://deno.land/x/denomailer@1.6.0/mod.ts"
  },
  "tasks": {
    "dev": "deno run --allow-net --allow-env --allow-read --allow-write --allow-run --watch index.ts",
    "start": "deno run --allow-net --allow-env --allow-read --allow-write --allow-run index.ts"
  },
  "compilerOptions": {
    "strict": true,
    "lib": ["deno.ns", "dom"]
  }
}
```

- [ ] **Step 2: Replace `server/mail/smtp.ts`**

```ts
// Production SMTP driver. Wraps denomailer for RFC-5321 transport.
//
// Connection lifecycle: open-per-send. For password-reset volume (≪1/sec) this
// is fine. If volume ever grows, introduce a persistent client here — interface
// is unchanged.

import { SMTPClient } from "denomailer";
import type { Config } from "../config.ts";
import type { Mailer } from "./mailer.ts";

export class SmtpMailer implements Mailer {
  constructor(private config: Config) {}

  isConfigured(): boolean {
    return !!(this.config.smtpHost && this.config.smtpFrom && this.config.publicUrl);
  }

  async send(msg: { to: string; subject: string; text: string; html: string }): Promise<void> {
    if (!this.isConfigured()) {
      throw new Error("SmtpMailer: missing host, from, or publicUrl");
    }

    const client = new SMTPClient({
      connection: {
        hostname: this.config.smtpHost,
        port: this.config.smtpPort,
        tls: this.config.smtpSecure === "tls",
        auth: this.config.smtpUser
          ? { username: this.config.smtpUser, password: this.config.smtpPass }
          : undefined,
      },
    });

    try {
      await client.send({
        from: this.config.smtpFrom,
        to: msg.to,
        subject: msg.subject,
        content: msg.text,
        html: msg.html,
      });
    } finally {
      await client.close();
    }
  }
}
```

- [ ] **Step 3: Typecheck + vendor the dependency**

Run: `cd server && $HOME/.deno/bin/deno check index.ts`
Expected: first run may download denomailer; subsequent runs are cached. No type errors.

- [ ] **Step 4: Commit**

```bash
git add server/mail/smtp.ts server/deno.json server/deno.lock
git commit -m "$(cat <<'EOF'
Add SmtpMailer using denomailer

RFC-5321 driver. Open-per-send connection (sufficient for
password-reset volume). TLS, STARTTLS, and no-auth all supported
via config. isConfigured() reflects the full set of requirements:
host + from + publicUrl.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Email templates

**Files:**
- Create: `server/mail/templates.ts`

- [ ] **Step 1: Write `server/mail/templates.ts`**

```ts
// Email body templates. Each exported function returns a triple
// { subject, text, html } suitable for direct consumption by Mailer.send.
//
// HTML is intentionally minimal: inline styles only, no external assets, no
// tracking pixels, no logos. A single centered container with a button-styled
// anchor link.

interface EmailTriple {
  subject: string;
  text: string;
  html: string;
}

function htmlShell(bodyInner: string): string {
  return `<!DOCTYPE html>
<html><body style="font-family:system-ui,-apple-system,sans-serif;background:#f4f4f6;margin:0;padding:24px">
<div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #e5e5e9;border-radius:8px;padding:24px;color:#1c1c1e">
${bodyInner}
</div>
</body></html>`;
}

function htmlButton(label: string, href: string): string {
  return `<a href="${href}" style="display:inline-block;background:#0a84ff;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:600">${label}</a>`;
}

export function renderResetEmail(args: {
  username: string;
  url: string;
  ttlHours: number;
}): EmailTriple {
  const subject = "OB2 password reset";
  const text =
    `Hi ${args.username},\n\n` +
    `Someone requested a password reset for your OB2 account. If it was you, follow this link to choose a new password:\n\n` +
    `  ${args.url}\n\n` +
    `This link expires in ${args.ttlHours} hour${args.ttlHours === 1 ? "" : "s"} and can only be used once.\n\n` +
    `If you did not request this, you can safely ignore this email.\n`;
  const html = htmlShell(
    `<h2 style="margin-top:0">OB2 password reset</h2>` +
    `<p>Hi <strong>${args.username}</strong>,</p>` +
    `<p>Someone requested a password reset for your OB2 account. If it was you, click the button below to choose a new password.</p>` +
    `<p style="text-align:center;margin:24px 0">${htmlButton("Reset password", args.url)}</p>` +
    `<p style="color:#6a6a72;font-size:13px">Link expires in ${args.ttlHours} hour${args.ttlHours === 1 ? "" : "s"} and can only be used once.</p>` +
    `<p style="color:#6a6a72;font-size:13px">If you did not request this, ignore this email.</p>`
  );
  return { subject, text, html };
}

export function renderInviteEmail(args: {
  username: string;
  url: string;
  ttlDays: number;
}): EmailTriple {
  const subject = "You've been invited to OB2";
  const text =
    `An administrator has created an OB2 account for you (${args.username}).\n\n` +
    `Follow this link to set your password and sign in:\n\n` +
    `  ${args.url}\n\n` +
    `This link expires in ${args.ttlDays} day${args.ttlDays === 1 ? "" : "s"} and can only be used once.\n`;
  const html = htmlShell(
    `<h2 style="margin-top:0">You've been invited to OB2</h2>` +
    `<p>An administrator created an OB2 account for you (<strong>${args.username}</strong>).</p>` +
    `<p>Click below to set your password and sign in.</p>` +
    `<p style="text-align:center;margin:24px 0">${htmlButton("Set password", args.url)}</p>` +
    `<p style="color:#6a6a72;font-size:13px">Link expires in ${args.ttlDays} day${args.ttlDays === 1 ? "" : "s"}.</p>`
  );
  return { subject, text, html };
}

export function renderSmtpTestEmail(): EmailTriple {
  const subject = "OB2 SMTP test";
  const text = `If you received this, OB2 can reach your SMTP server.\n`;
  const html = htmlShell(
    `<h2 style="margin-top:0">OB2 SMTP test</h2>` +
    `<p>If you received this, OB2 can reach your SMTP server.</p>`
  );
  return { subject, text, html };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd server && $HOME/.deno/bin/deno check index.ts`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/mail/templates.ts
git commit -m "$(cat <<'EOF'
Add email templates (reset, invite, smtp-test)

Each exported function returns { subject, text, html }. HTML is
inline-styled, no external assets, no tracking pixels. Single
centered container with a button-styled anchor.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Reset-tokens module

**Files:**
- Create: `server/auth/reset-tokens.ts`

- [ ] **Step 1: Write `server/auth/reset-tokens.ts`**

```ts
// Reset + invite token store. File-backed, hot-reloading, atomic writes.
// Plaintext never stored — sha256(plaintext) only.
//
// File path: server/data/reset-tokens.json (relative to the server CWD).
//
// TTLs:
//   - reset:  1 hour
//   - invite: 7 days
//
// Tokens are single-use. consumeToken deletes the record on success.
// revokeUserTokens clears every token for a username.

type TokenKind = "reset" | "invite";

interface ResetToken {
  token_hash: string;
  username: string;
  kind: TokenKind;
  expires_at: string; // ISO-8601
  created_at: string;
}

interface TokenStore {
  tokens: ResetToken[];
}

const STORE_PATH = "../server/data/reset-tokens.json";
const RESET_TTL_MS = 60 * 60 * 1000;          // 1 hour
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let _tokens: ResetToken[] = [];
let _lastMtime = 0;
let _loaded = false;

async function _ensureDir(): Promise<void> {
  try {
    await Deno.mkdir("../server/data", { recursive: true });
  } catch { /* already exists */ }
}

async function _loadIfChanged(): Promise<void> {
  try {
    const stat = await Deno.stat(STORE_PATH);
    const mtime = stat.mtime?.getTime() ?? 0;
    if (_loaded && mtime <= _lastMtime) return;
    _lastMtime = mtime;
    const text = await Deno.readTextFile(STORE_PATH);
    const data = JSON.parse(text) as TokenStore;
    _tokens = Array.isArray(data.tokens) ? data.tokens : [];
    _loaded = true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) {
      _tokens = [];
      _loaded = true;
      return;
    }
    console.error(`reset-tokens: load failed: ${e}`);
  }
}

async function _atomicWrite(): Promise<void> {
  await _ensureDir();
  const tmp = `${STORE_PATH}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  await Deno.writeTextFile(tmp, JSON.stringify({ tokens: _tokens }, null, 2));
  await Deno.rename(tmp, STORE_PATH);
  _lastMtime = 0; // force reload on next call
}

async function _sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function _generatePlaintext(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface IssuedToken {
  plaintext: string;
  expiresAt: string;
}

export async function generateToken(
  username: string,
  kind: TokenKind,
): Promise<IssuedToken> {
  await _loadIfChanged();
  const plaintext = _generatePlaintext();
  const now = Date.now();
  const ttl = kind === "invite" ? INVITE_TTL_MS : RESET_TTL_MS;
  const expiresAt = new Date(now + ttl).toISOString();
  const hash = await _sha256Hex(plaintext);
  _tokens.push({
    token_hash: hash,
    username,
    kind,
    expires_at: expiresAt,
    created_at: new Date(now).toISOString(),
  });
  // Sweep expired on every write.
  _tokens = _tokens.filter((t) => Date.parse(t.expires_at) > now);
  await _atomicWrite();
  return { plaintext, expiresAt };
}

export async function consumeToken(
  plaintext: string,
): Promise<{ username: string; kind: TokenKind } | null> {
  await _loadIfChanged();
  const hash = await _sha256Hex(plaintext);
  const now = Date.now();
  const idx = _tokens.findIndex((t) => t.token_hash === hash);
  if (idx === -1) return null;
  const tok = _tokens[idx];
  if (Date.parse(tok.expires_at) <= now) {
    // Expired — delete lazily.
    _tokens.splice(idx, 1);
    await _atomicWrite();
    return null;
  }
  _tokens.splice(idx, 1); // single-use
  await _atomicWrite();
  return { username: tok.username, kind: tok.kind };
}

export async function peekToken(
  plaintext: string,
): Promise<{ username: string; kind: TokenKind } | null> {
  // Non-destructive — used by /auth/reset-token-info to let the UI pick copy.
  await _loadIfChanged();
  const hash = await _sha256Hex(plaintext);
  const now = Date.now();
  const tok = _tokens.find((t) => t.token_hash === hash);
  if (!tok) return null;
  if (Date.parse(tok.expires_at) <= now) return null;
  return { username: tok.username, kind: tok.kind };
}

export async function revokeUserTokens(username: string): Promise<number> {
  await _loadIfChanged();
  const before = _tokens.length;
  _tokens = _tokens.filter((t) => t.username !== username);
  const removed = before - _tokens.length;
  if (removed > 0) await _atomicWrite();
  return removed;
}

export async function sweepExpired(): Promise<number> {
  await _loadIfChanged();
  const now = Date.now();
  const before = _tokens.length;
  _tokens = _tokens.filter((t) => Date.parse(t.expires_at) > now);
  const removed = before - _tokens.length;
  if (removed > 0) await _atomicWrite();
  return removed;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd server && $HOME/.deno/bin/deno check index.ts`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/auth/reset-tokens.ts
git commit -m "$(cat <<'EOF'
Add reset-tokens token store

File-backed, hot-reloading, atomic writes. Plaintext never stored —
sha256(plaintext) only. Single-use: consumeToken deletes on success.
TTLs: 1h reset, 7d invite. Helpers: generate, consume, peek,
revokeUserTokens, sweepExpired. Sweeps on every write.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Rate limiter

**Files:**
- Create: `server/auth/rate-limit.ts`

- [ ] **Step 1: Write `server/auth/rate-limit.ts`**

```ts
// Simple in-memory rate limiter. Single-process, resets on restart.
// Callers pass a key (e.g. "ip:1.2.3.4", "user:alice", "token:abc123"),
// a limit (number of allowed events), and a window in milliseconds.

interface Bucket {
  count: number;
  resetAt: number;
}

const _buckets = new Map<string, Bucket>();

export function check(key: string, limit: number, windowMs: number): {
  allowed: boolean;
  retryAfterMs: number;
} {
  const now = Date.now();
  const existing = _buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    _buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterMs: 0 };
  }
  if (existing.count < limit) {
    existing.count++;
    return { allowed: true, retryAfterMs: 0 };
  }
  return { allowed: false, retryAfterMs: existing.resetAt - now };
}

export function reset(key: string): void {
  _buckets.delete(key);
}

/** Periodic sweep of stale buckets — optional, called from index.ts. */
export function sweep(): number {
  const now = Date.now();
  let removed = 0;
  for (const [k, b] of _buckets.entries()) {
    if (b.resetAt <= now) {
      _buckets.delete(k);
      removed++;
    }
  }
  return removed;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd server && $HOME/.deno/bin/deno check index.ts`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/auth/rate-limit.ts
git commit -m "$(cat <<'EOF'
Add in-memory rate limiter

Key + limit + windowMs → {allowed, retryAfterMs}. Used for
forgot-password and reset-password throttling. Resets on server
restart (acceptable — keys are all short-lived).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Email field on `UserRecord`

**Files:**
- Modify: `server/users.ts`

- [ ] **Step 1: Add email field to `UserRecord` interface**

In `server/users.ts`, find the `UserRecord` interface (near line 33). Replace it with:

```ts
export interface UserRecord {
  username: string;
  key: string;
  email?: string;                        // optional recovery email
  password_hash?: string;
  global_admin: boolean;
  domains: Record<string, Permission>;
  created_at: string;
  enabled: boolean;
}
```

- [ ] **Step 2: Add email validator helper**

Just below the `UserRecord` interface (after `UsersConfig`), add:

```ts
const _emailRe = /^\S+@\S+\.\S+$/;

export function isValidEmail(s: unknown): boolean {
  return typeof s === "string" && s.length > 0 && s.length <= 254 && _emailRe.test(s);
}
```

- [ ] **Step 3: Extend `UserPatch` to accept email**

Find the `UserPatch` interface (near line 276). Replace with:

```ts
export interface UserPatch {
  domains?: Record<string, Permission>;
  global_admin?: boolean;
  email?: string | null;  // null = clear
}
```

- [ ] **Step 4: Apply email in `updateUser`**

Find the `updateUser` function. Find the block that applies patch fields:

```ts
  if (patch.domains !== undefined) u.domains = patch.domains;
  if (patch.global_admin !== undefined) u.global_admin = patch.global_admin;
```

Add the email handling BEFORE that block:

```ts
  if (patch.email !== undefined) {
    if (patch.email === null) {
      delete u.email;
    } else {
      if (!isValidEmail(patch.email)) {
        throw new Error("invalid email format");
      }
      u.email = patch.email;
    }
  }
  if (patch.domains !== undefined) u.domains = patch.domains;
  if (patch.global_admin !== undefined) u.global_admin = patch.global_admin;
```

Also update the `prev` capture at the top of `updateUser` to include email:

Current:
```ts
  const prev = { domains: u.domains, global_admin: u.global_admin };
```

Replace with:
```ts
  const prev = { domains: u.domains, global_admin: u.global_admin, email: u.email };
```

And update the rollback branch:

Current:
```ts
    u.domains = prev.domains;
    u.global_admin = prev.global_admin;
```

Replace with:
```ts
    u.domains = prev.domains;
    u.global_admin = prev.global_admin;
    if (prev.email === undefined) delete u.email; else u.email = prev.email;
```

- [ ] **Step 5: Extend `createUser` to accept email**

Find `createUser`. Replace its signature and body with:

```ts
export function createUser(
  username: string,
  domains: Record<string, Permission>,
  global_admin: boolean = false,
  email?: string,
): UserRecord {
  if (email !== undefined && !isValidEmail(email)) {
    throw new Error("invalid email format");
  }
  const user: UserRecord = {
    username,
    key: generateApiKey(),
    global_admin,
    domains,
    created_at: new Date().toISOString(),
    enabled: true,
  };
  if (email) user.email = email;

  const data = _loadFile();
  if (data.users.some((u) => u.username === username)) {
    throw new Error(`username '${username}' already exists`);
  }
  data.users.push(user);
  _atomicWrite(data);
  return user;
}
```

- [ ] **Step 6: Add `setEmail` helper**

After `rotateApiKey` function, add:

```ts
/** Set or clear a user's recovery email. Pass null to clear. */
export function setEmail(username: string, email: string | null): UserRecord {
  const data = _loadFile();
  const idx = data.users.findIndex((u) => u.username === username);
  if (idx === -1) throw new Error(`user '${username}' not found`);
  if (email === null) {
    delete data.users[idx].email;
  } else {
    if (!isValidEmail(email)) throw new Error("invalid email format");
    data.users[idx].email = email;
  }
  _atomicWrite(data);
  return data.users[idx];
}

/** Look up a user by their registered email address. Returns the full record
 * (with plaintext key) — callers must not expose it directly. */
export function findUserByEmail(email: string): UserRecord | null {
  _reloadIfChanged();
  for (const u of _users.values()) {
    if (u.email && u.email.toLowerCase() === email.toLowerCase()) {
      return u;
    }
  }
  return null;
}
```

- [ ] **Step 7: Extend raw-editor schema validation in `saveRawUsersFile`**

Find `saveRawUsersFile` in `server/users.ts`. In the schema validation loop (the `for (const [i, u] of next.entries())` block), after the `u.domains` validation, add an email check:

```ts
    if (u.email !== undefined && !isValidEmail(u.email)) {
      throw new TypeError(`users[${i}].email: invalid format`);
    }
```

- [ ] **Step 8: Typecheck**

Run: `cd server && $HOME/.deno/bin/deno check index.ts`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add server/users.ts
git commit -m "$(cat <<'EOF'
Add optional email field to UserRecord

New optional email string with simple-regex validation (format only,
no deliverability check). createUser, updateUser, raw-save all
accept it. setEmail helper for self-serve updates; findUserByEmail
for the forgot-password lookup. Existing users without email keep
working unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Initialize mailer + token sweeper on boot

**Files:**
- Modify: `server/index.ts`

- [ ] **Step 1: Inspect `server/index.ts`**

Read `server/index.ts`. Identify where `loadConfig()` is called and where top-level wiring happens.

- [ ] **Step 2: Add mailer init + token sweep interval**

Add these imports at the top of `server/index.ts` (next to other imports):

```ts
import { initMailer } from "./mail/mailer.ts";
import { sweepExpired } from "./auth/reset-tokens.ts";
```

Find the line immediately after `const config = loadConfig();` (or wherever config is first available). Add:

```ts
initMailer(config);

// Periodic token sweep — every 10 minutes. Cheap: in-memory filter + atomic
// write only if something was removed.
setInterval(() => {
  sweepExpired().catch((e) => console.error(`sweepExpired failed: ${e}`));
}, 10 * 60 * 1000);
```

- [ ] **Step 3: Typecheck**

Run: `cd server && $HOME/.deno/bin/deno check index.ts`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/index.ts
git commit -m "$(cat <<'EOF'
Initialize mailer + schedule token sweep on boot

initMailer(config) once at startup so any subsequent getMailer()
call returns the configured driver. setInterval runs sweepExpired
every 10 minutes to purge expired reset/invite tokens from the
store.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Extend `tests/e2e.sh` with Step 13 scaffolding

**Files:**
- Modify: `tests/e2e.sh`

This task sets up the test harness for all subsequent email-flow tasks. It adds the Step 13 header, seeds bob with an email, and defines helpers the later assertions will use.

- [ ] **Step 1: Insert Step 13 scaffolding**

In `tests/e2e.sh`, find the `# ── Summary ──` block (around line 430). Insert this NEW section immediately before it:

```bash
# ─────────────────────────────────────────────
echo
echo "── Step 13: Email recovery ──"

# Ensure the server was started with OB2_SMTP_DRIVER=log for this suite.
# If the driver isn't log, all email asserts SKIP.
if [ "${OB2_SMTP_DRIVER:-}" != "log" ]; then
  echo "  SKIP: OB2_SMTP_DRIVER=log not set — email tests require the log driver"
else
  MAIL_LOG="$SERVER_DIR/data/mail-log.txt"
  : > "$MAIL_LOG"  # truncate so later greps see only this-suite events

  # 13.0 precondition: give bob an email (bob is the sole global admin at this point).
  BOB_EMAIL="bob@example.com"
  curl -s -X PATCH "$BASE/admin/users/bob" \
    -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
    -d "{\"email\":\"$BOB_EMAIL\"}" > /dev/null
fi
```

- [ ] **Step 2: Typecheck the server still builds (the scaffolding is shell, but sanity-check)**

Run: `cd server && $HOME/.deno/bin/deno check index.ts`
Expected: no errors (nothing server-side changed, but it's cheap to confirm).

- [ ] **Step 3: Commit**

```bash
git add tests/e2e.sh
git commit -m "$(cat <<'EOF'
Add Step 13 scaffolding for email recovery tests

Header + driver guard (SKIP when not using OB2_SMTP_DRIVER=log) +
precondition PATCH that sets bob's email to bob@example.com.
Subsequent tasks append assertions to this block.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: `POST /auth/forgot-password`

**Files:**
- Modify: `server/routes/auth.ts`
- Modify: `tests/e2e.sh`

- [ ] **Step 1: Add new imports at the top of `server/routes/auth.ts`**

Find the existing import block (around line 21–28). Add these imports from new files:

```ts
import { getMailer } from "../mail/mailer.ts";
import { renderResetEmail } from "../mail/templates.ts";
import { generateToken } from "../auth/reset-tokens.ts";
import { check as rateLimit } from "../auth/rate-limit.ts";
import { findUserByEmail } from "../users.ts";
```

`findUserByEmail` is exported in Task 7. If it isn't already in the destructured import from `../users.ts`, add it there instead of a separate import line.

- [ ] **Step 2: Add the endpoint inside `authRoutes`**

In `server/routes/auth.ts`, find the function `authRoutes` and look for the `// ── POST /auth/login ──` comment. Immediately before the `// ── POST /auth/logout ──` block (or after `login` and before `logout`), add:

```ts
  // ── POST /auth/forgot-password ── (public, anti-enumeration)
  app.post("/forgot-password", async (c) => {
    let body: { email?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const email = (body.email || "").trim().toLowerCase();
    if (!email) {
      return c.json({ error: "email required" }, 400);
    }
    // Rate-limit by IP and by target email
    const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() || "unknown";
    const ipCheck = rateLimit(`ip:${ip}`, 5, 15 * 60 * 1000);
    if (!ipCheck.allowed) {
      return c.json({ error: "rate limited" }, 429);
    }
    const userCheck = rateLimit(`user:${email}`, 3, 60 * 60 * 1000);
    if (!userCheck.allowed) {
      return c.json({ error: "rate limited" }, 429);
    }

    // Anti-enumeration: always 200.
    const mailer = getMailer();
    const user = findUserByEmail(email);
    if (user && user.email && mailer?.isConfigured() && config.publicUrl) {
      try {
        const { plaintext } = await generateToken(user.username, "reset");
        const url = `${config.publicUrl}/dashboard?token=${plaintext}`;
        const { subject, text, html } = renderResetEmail({
          username: user.username,
          url,
          ttlHours: 1,
        });
        await mailer.send({ to: user.email, subject, text, html });
      } catch (e) {
        console.error(`forgot-password: send failed for ${user.username}: ${(e as Error).message}`);
      }
    } else if (!mailer?.isConfigured() || !config.publicUrl) {
      console.warn(
        "forgot-password attempted but email infra not configured (mailer or publicUrl missing)",
      );
    }
    return c.json({ ok: true });
  });
```

- [ ] **Step 3: Append e2e assertions to the Step 13 block**

In `tests/e2e.sh`, inside the Step 13 block (after the `BOB_EMAIL` precondition), append:

```bash
  # 13.1: forgot-password for unknown email — 200, no mail
  RESP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/forgot-password" \
    -H "Content-Type: application/json" \
    -d '{"email":"ghost@nowhere.invalid"}')
  assert_status "forgot-password unknown email returns 200" "$RESP" "200"
  COUNT=$(grep -c "ghost@nowhere.invalid" "$MAIL_LOG" 2>/dev/null || echo 0)
  TESTS=$((TESTS + 1))
  if [ "$COUNT" = "0" ]; then
    echo "  PASS: no mail sent for unknown email"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: mail log mentions unknown email"
    FAIL=$((FAIL + 1))
  fi

  # 13.2: forgot-password for valid email — 200, mail logged
  RESP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/forgot-password" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$BOB_EMAIL\"}")
  assert_status "forgot-password valid email returns 200" "$RESP" "200"
  sleep 0.2  # flush the append
  MAIL_TO=$(grep "^To: " "$MAIL_LOG" | tail -1)
  MAIL_SUBJ=$(grep "^Subject: " "$MAIL_LOG" | tail -1)
  assert_contains "mail log has bob's email" "$MAIL_TO" "$BOB_EMAIL"
  assert_contains "mail log has reset subject" "$MAIL_SUBJ" "OB2 password reset"
fi  # close the OB2_SMTP_DRIVER guard from Step 13 scaffolding
```

Wait — the guard `fi` was opened in Task 9 but not yet closed. The `fi` goes AFTER all Step 13 assertions are added. For now, remove the last `fi` line from this step; subsequent tasks will append inside the guard and the very last task (Task 22 or similar) will close it.

Actually: the cleanest approach is to close `fi` at the END of step 13, which means each new task appends BEFORE the `fi`. To avoid rewriting the guard each time, the implementer should:

1. Find the `fi  # close the OB2_SMTP_DRIVER guard` line (added in this task if not present).
2. Insert new assertions BEFORE it.

So in this task, add the `fi  # close the OB2_SMTP_DRIVER guard from Step 13 scaffolding` line AFTER the 13.1 and 13.2 assertion blocks. Subsequent tasks insert BEFORE that line.

- [ ] **Step 4: Typecheck + sanity**

Run: `cd server && $HOME/.deno/bin/deno check index.ts`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server/routes/auth.ts tests/e2e.sh
git commit -m "$(cat <<'EOF'
Add POST /auth/forgot-password

Anti-enumeration: always returns 200. IP- and user-keyed rate
limits. If the email matches a user with an email set AND mailer
configured AND publicUrl set, sends a reset link (1h TTL, single-
use). Send failures are logged but never surface to the caller.
E2E covers unknown-email no-op and valid-email send.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: `POST /auth/reset-password` + `GET /auth/reset-token-info`

**Files:**
- Modify: `server/routes/auth.ts`
- Modify: `tests/e2e.sh`

- [ ] **Step 1: Add imports**

In `server/routes/auth.ts`, extend the existing `../auth/reset-tokens.ts` import to also bring in `consumeToken` and `peekToken`:

```ts
import { generateToken, consumeToken, peekToken, revokeUserTokens } from "../auth/reset-tokens.ts";
```

Also extend the `../users.ts` import to add `setPassword` (it may already be there — verify first by grepping):

```ts
// Ensure setPassword is in the users import list
```

- [ ] **Step 2: Add `POST /auth/reset-password`**

Add after the `forgot-password` endpoint:

```ts
  // ── POST /auth/reset-password ── (public)
  app.post("/reset-password", async (c) => {
    let body: { token?: string; new_password?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const token = (body.token || "").trim();
    const newPassword = body.new_password || "";
    if (!token) return c.json({ error: "token required" }, 400);

    // Rate-limit per token
    const tokenCheck = rateLimit(`token:${token}`, 10, 60 * 60 * 1000);
    if (!tokenCheck.allowed) {
      return c.json({ error: "rate limited" }, 429);
    }

    const err = validatePasswordStrength(newPassword);
    if (err) return c.json({ error: err }, 400);

    const result = await consumeToken(token);
    if (!result) return c.json({ error: "invalid or expired token" }, 401);

    try {
      await setPassword(result.username, newPassword);
      revokeUserSessions(result.username);
      await revokeUserTokens(result.username);
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }

    if (result.kind === "invite") {
      // Auto-login for invite flow.
      const { token: sessionToken } = await createSession(result.username);
      c.header("Set-Cookie", buildCookie(sessionToken, SESSION_TTL_SEC, isHttps(c)));
      return c.json({ ok: true, auto_signed_in: true, username: result.username });
    }
    return c.json({ ok: true });
  });
```

- [ ] **Step 3: Add `GET /auth/reset-token-info`**

Add after `reset-password`:

```ts
  // ── GET /auth/reset-token-info ── (public, non-destructive)
  app.get("/reset-token-info", async (c) => {
    const token = c.req.query("token")?.trim() || "";
    if (!token) return c.json({ valid: false });
    // Light rate-limit so scanners don't hammer this.
    const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() || "unknown";
    const ipCheck = rateLimit(`info:${ip}`, 30, 5 * 60 * 1000);
    if (!ipCheck.allowed) {
      return c.json({ valid: false, rate_limited: true });
    }
    const info = await peekToken(token);
    if (!info) return c.json({ valid: false });
    return c.json({ valid: true, kind: info.kind, username: info.username });
  });
```

- [ ] **Step 4: Append e2e assertions**

In `tests/e2e.sh`, inside the Step 13 block and BEFORE the closing `fi`, append:

```bash
  # 13.3: extract the reset token from the mail log, complete the reset
  RESET_TOKEN=$(grep -oE '\?token=[0-9a-f]{64}' "$MAIL_LOG" | tail -1 | sed 's/^\?token=//')
  TESTS=$((TESTS + 1))
  if [ -n "$RESET_TOKEN" ]; then
    echo "  PASS: reset token extracted from mail log"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: no reset token found in mail log"
    FAIL=$((FAIL + 1))
  fi

  # 13.4: reset-token-info returns kind=reset
  INFO=$(curl -s "$BASE/auth/reset-token-info?token=$RESET_TOKEN")
  assert_contains "reset-token-info reports kind=reset" "$INFO" '"kind":"reset"'

  # 13.5: POST reset-password with the token
  NEW_BOB_PW="bob-reset-pw-12345"
  RESP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/reset-password" \
    -H "Content-Type: application/json" \
    -d "{\"token\":\"$RESET_TOKEN\",\"new_password\":\"$NEW_BOB_PW\"}")
  assert_status "reset-password happy path" "$RESP" "200"

  # 13.6: bob can log in with the new password
  LOGIN_RES=$(curl -s -X POST "$BASE/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"bob\",\"password\":\"$NEW_BOB_PW\"}")
  assert_contains "bob signs in with new password" "$LOGIN_RES" '"ok":true'

  # 13.7: reusing the same token returns 401
  RESP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/reset-password" \
    -H "Content-Type: application/json" \
    -d "{\"token\":\"$RESET_TOKEN\",\"new_password\":\"$NEW_BOB_PW\"}")
  assert_status "reset token reuse returns 401" "$RESP" "401"

  # 13.8: weak password rejected with 400
  # First, request another reset token.
  curl -s -X POST "$BASE/auth/forgot-password" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$BOB_EMAIL\"}" > /dev/null
  sleep 0.2
  RESET_TOKEN=$(grep -oE '\?token=[0-9a-f]{64}' "$MAIL_LOG" | tail -1 | sed 's/^\?token=//')
  RESP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/reset-password" \
    -H "Content-Type: application/json" \
    -d "{\"token\":\"$RESET_TOKEN\",\"new_password\":\"x\"}")
  assert_status "weak password rejected" "$RESP" "400"

  # 13.9: unknown token returns 401
  RESP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/reset-password" \
    -H "Content-Type: application/json" \
    -d '{"token":"0000000000000000000000000000000000000000000000000000000000000000","new_password":"some-ok-password"}')
  assert_status "unknown token returns 401" "$RESP" "401"
```

- [ ] **Step 5: Typecheck**

Run: `cd server && $HOME/.deno/bin/deno check index.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/routes/auth.ts tests/e2e.sh
git commit -m "$(cat <<'EOF'
Add /auth/reset-password + /auth/reset-token-info

POST /auth/reset-password consumes a token, sets the password,
revokes all outstanding sessions + tokens for that user. Invite
kind auto-logs-in with a session cookie. GET /auth/reset-token-info
is non-destructive (peek) so the UI can show appropriate copy
(reset vs invite).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: `POST /auth/email` (self-serve)

**Files:**
- Modify: `server/routes/auth.ts`
- Modify: `tests/e2e.sh`

- [ ] **Step 1: Import `setEmail` and `isValidEmail`**

In the `../users.ts` import block at the top of `server/routes/auth.ts`, add `setEmail` and `isValidEmail` to the destructured list.

- [ ] **Step 2: Add the endpoint**

`POST /auth/email` must be authenticated (the calling user sets their own email). It belongs in the authed sub-app. Find the `authed = new Hono<AppEnv>()` block and where `/me` is defined. Add `/email` immediately after `/me`:

```ts
  // ── POST /auth/email ── (authenticated — user sets their own email)
  authed.post("/email", async (c) => {
    const auth = c.get("auth");
    if (!auth) return c.json({ error: "not authenticated" }, 401);
    if (auth.username === "_admin") {
      return c.json({ error: "bootstrap admin cannot set email" }, 400);
    }
    let body: { email?: string | null };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const email = body.email === null ? null : (body.email || "").trim();
    if (email !== null && !isValidEmail(email)) {
      return c.json({ error: "invalid email format" }, 400);
    }
    try {
      setEmail(auth.username, email);
      return c.json({ ok: true, email });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });
```

- [ ] **Step 3: Append e2e assertion**

Append inside the Step 13 block, before the closing `fi`:

```bash
  # 13.10: self-serve email update via /auth/email
  # Sign in as bob, get cookie, update email to a new address, confirm via /auth/me.
  NEW_EMAIL="bob-alt@example.com"
  # Re-login — bob's password was changed by 13.5/13.8 sequence; use the latest.
  # (weak-password test at 13.8 failed so password remains as 13.5 set it)
  CJ=$(mktemp)
  curl -s -c "$CJ" -X POST "$BASE/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"bob\",\"password\":\"$NEW_BOB_PW\"}" > /dev/null
  RESP=$(curl -s -b "$CJ" -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/email" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$NEW_EMAIL\"}")
  assert_status "/auth/email self-serve update" "$RESP" "200"
  ME=$(curl -s -b "$CJ" "$BASE/auth/me")
  assert_contains "/auth/me reflects new email" "$ME" "$NEW_EMAIL"
  rm -f "$CJ"
```

- [ ] **Step 4: Typecheck**

Run: `cd server && $HOME/.deno/bin/deno check index.ts`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server/routes/auth.ts tests/e2e.sh
git commit -m "$(cat <<'EOF'
Add POST /auth/email self-serve endpoint

Authenticated. User sets or clears their own recovery email. _admin
is blocked (bootstrap account can't own state). Validates format,
persists via setEmail, returns the new value so the UI can rerender.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Extend `/auth/me` to include email

**Files:**
- Modify: `server/routes/auth.ts`
- Modify: `server/users.ts` (AuthContext extension)

- [ ] **Step 1: Add email to `AuthContext`**

In `server/users.ts`, find the `AuthContext` interface. Replace with:

```ts
export interface AuthContext {
  username: string;
  email?: string;
  global_admin: boolean;
  domains: Record<string, Permission>;
}
```

Then update every function that builds an `AuthContext`: `_resolveAuth` (line ~93) and `_resolveAuthByUsername` (line ~197). In each, when returning a non-`_admin` user's AuthContext, include `email: u.email`.

Specifically in `_resolveAuth`:

```ts
  const user = _users.get(key);
  if (user) {
    return {
      username: user.username,
      email: user.email,
      global_admin: user.global_admin,
      domains: user.domains,
    };
  }
```

And in `_resolveAuthByUsername`:

```ts
  for (const u of _users.values()) {
    if (u.username === username) {
      return {
        username: u.username,
        email: u.email,
        global_admin: u.global_admin,
        domains: u.domains,
      };
    }
  }
```

The `_admin` branch in each stays as-is (no email).

- [ ] **Step 2: Update `/auth/me` response**

In `server/routes/auth.ts`, find the `/me` handler (`authed.get("/me", ...)`). Replace with:

```ts
  authed.get("/me", (c) => {
    const auth = c.get("auth");
    if (!auth) return c.json({ error: "not authenticated" }, 401);
    return c.json({
      username: auth.username,
      email: auth.email,
      global_admin: auth.global_admin,
      domains: auth.domains,
    });
  });
```

- [ ] **Step 3: Typecheck**

Run: `cd server && $HOME/.deno/bin/deno check index.ts`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/users.ts server/routes/auth.ts
git commit -m "$(cat <<'EOF'
Include email in /auth/me response

AuthContext gains an optional email field. Populated from
UserRecord in both the Bearer and cookie resolution paths. /auth/me
returns it so the dashboard can render a truthful "Recovery email"
card on Profile without an extra lookup.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 14: Admin invite endpoint

**Files:**
- Modify: `server/routes/admin.ts`
- Modify: `tests/e2e.sh`

- [ ] **Step 1: Add imports to `server/routes/admin.ts`**

At the top, extend the existing `../users.ts` import to include `isValidEmail` (if not already), and add the new email/template imports:

```ts
import { getMailer } from "../mail/mailer.ts";
import { renderInviteEmail, renderSmtpTestEmail } from "../mail/templates.ts";
import { generateToken, revokeUserTokens } from "../auth/reset-tokens.ts";
```

- [ ] **Step 2: Accept `config` in `adminRoutes`**

The existing signature is `export function adminRoutes(config: Config, sidecar: Sidecar)`. `config` is already available — no change needed.

- [ ] **Step 3: Add `POST /admin/users/:username/invite`**

Inside `adminRoutes`, after the existing `POST /users/:username/password` handler and before `DELETE /users/:username`, insert:

```ts
  // ── POST /admin/users/:username/invite ── (global admin only)
  app.post("/users/:username/invite", async (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    const username = c.req.param("username");
    const users = listUsers();
    const target = users.find((u) => u.username === username);
    if (!target) return c.json({ error: `user '${username}' not found` }, 404);
    if (!target.email) {
      return c.json({ error: "target user has no email address" }, 400);
    }
    const mailer = getMailer();
    if (!mailer?.isConfigured() || !config.publicUrl) {
      return c.json({ error: "email infrastructure not configured" }, 400);
    }
    try {
      const { plaintext } = await generateToken(username, "invite");
      const url = `${config.publicUrl}/dashboard?token=${plaintext}`;
      const { subject, text, html } = renderInviteEmail({ username, url, ttlDays: 7 });
      await mailer.send({ to: target.email, subject, text, html });
      return c.json({ ok: true });
    } catch (e) {
      // Generate the token anyway so admin can share out-of-band. Re-generate
      // since the prior token (if any) was written to disk already.
      const { plaintext } = await generateToken(username, "invite");
      const url = `${config.publicUrl}/dashboard?token=${plaintext}`;
      return c.json({
        error: `SMTP send failed: ${(e as Error).message}`,
        invite_url: url,
      }, 500);
    }
  });
```

Note: on send-failure, the rollback strategy is "leave the token in the store; admin can copy-paste the URL." The token naturally expires in 7 days. A second `generateToken` in the catch block is slightly wasteful but makes the fallback behavior unambiguous.

- [ ] **Step 4: Append e2e assertions**

In `tests/e2e.sh`, inside Step 13, before the closing `fi`:

```bash
  # 13.11: admin invites a new user, invite link appears in mail log
  # First create charlie (no password, has email).
  : > "$MAIL_LOG"  # clear the log so grep picks up only this batch
  curl -s -X POST "$BASE/admin/users" \
    -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
    -d '{"username":"dana","domains":{},"email":"dana@example.com"}' > /dev/null
  RESP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/admin/users/dana/invite" \
    -H "Authorization: Bearer $BOB_KEY")
  assert_status "admin invite returns 200" "$RESP" "200"
  sleep 0.2
  MAIL_SUBJ=$(grep "^Subject: " "$MAIL_LOG" | tail -1)
  assert_contains "invite email subject" "$MAIL_SUBJ" "invited to OB2"

  # 13.12: dana follows the invite link, sets a password, auto-login
  INVITE_TOKEN=$(grep -oE '\?token=[0-9a-f]{64}' "$MAIL_LOG" | tail -1 | sed 's/^\?token=//')
  DANA_PW="dana-new-pass-987"
  RESP_BODY=$(curl -s -X POST "$BASE/auth/reset-password" \
    -H "Content-Type: application/json" \
    -d "{\"token\":\"$INVITE_TOKEN\",\"new_password\":\"$DANA_PW\"}")
  assert_contains "invite accept auto-signs-in" "$RESP_BODY" '"auto_signed_in":true'

  # 13.13: dana can sign in normally with the new password
  LOGIN_RES=$(curl -s -X POST "$BASE/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"dana\",\"password\":\"$DANA_PW\"}")
  assert_contains "dana signs in with chosen password" "$LOGIN_RES" '"ok":true'
```

- [ ] **Step 5: Typecheck**

Run: `cd server && $HOME/.deno/bin/deno check index.ts`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/routes/admin.ts tests/e2e.sh
git commit -m "$(cat <<'EOF'
Add POST /admin/users/:name/invite

Global-admin only. Requires target email + mailer configured. On
success, emails an invite URL (7-day TTL, single-use). On SMTP
failure, returns 500 with an invite_url fallback so the admin can
share out-of-band. E2E covers the create → invite → set-password
→ auto-login → normal-login flow.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 15: `POST /admin/smtp/test`

**Files:**
- Modify: `server/routes/admin.ts`
- Modify: `tests/e2e.sh`

- [ ] **Step 1: Add the endpoint**

In `server/routes/admin.ts`, inside `adminRoutes`, after the `/users/:username/invite` handler, add:

```ts
  // ── POST /admin/smtp/test ── (global admin only)
  app.post("/smtp/test", async (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    let body: { to?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const to = (body.to || "").trim();
    if (!to) return c.json({ error: "to required" }, 400);
    const mailer = getMailer();
    if (!mailer?.isConfigured()) {
      return c.json({ error: "mailer not configured" }, 400);
    }
    try {
      const { subject, text, html } = renderSmtpTestEmail();
      await mailer.send({ to, subject, text, html });
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: `SMTP send failed: ${(e as Error).message}` }, 500);
    }
  });
```

- [ ] **Step 2: Append e2e assertion**

In `tests/e2e.sh`, inside Step 13, before the closing `fi`:

```bash
  # 13.14: SMTP test endpoint reaches mailer
  : > "$MAIL_LOG"
  RESP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/admin/smtp/test" \
    -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
    -d '{"to":"diagnostic@example.com"}')
  assert_status "SMTP test endpoint returns 200" "$RESP" "200"
  sleep 0.2
  MAIL_SUBJ=$(grep "^Subject: " "$MAIL_LOG" | tail -1)
  assert_contains "SMTP test email subject" "$MAIL_SUBJ" "OB2 SMTP test"
```

- [ ] **Step 3: Typecheck**

Run: `cd server && $HOME/.deno/bin/deno check index.ts`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add server/routes/admin.ts tests/e2e.sh
git commit -m "$(cat <<'EOF'
Add POST /admin/smtp/test diagnostic endpoint

Global-admin only. Sends "OB2 SMTP test" to a caller-supplied
address. Used by the Config tab's test button; surfaces the
underlying denomailer error on failure so admins can debug bad
credentials / wrong port / DMARC rejects without hunting logs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 16: Extend `POST /admin/users` with email + send_invite

**Files:**
- Modify: `server/routes/admin.ts`
- Modify: `server/users.ts` (createUser already accepts email per Task 7 — verify)

- [ ] **Step 1: Extend request body handling in `POST /admin/users`**

In `server/routes/admin.ts`, find the `POST /users` handler (around line 189). Replace it with:

```ts
  // POST /admin/users — create a new user (global admin only)
  app.post("/users", async (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    let body: {
      username?: string;
      domains?: Record<string, string>;
      global_admin?: boolean;
      email?: string;
      send_invite?: boolean;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    if (!body.username) {
      return c.json({ error: "username required" }, 400);
    }
    if (body.send_invite && !body.email) {
      return c.json({ error: "send_invite requires an email" }, 400);
    }
    const mailer = getMailer();
    if (body.send_invite && (!mailer?.isConfigured() || !config.publicUrl)) {
      return c.json({ error: "email infrastructure not configured" }, 400);
    }
    try {
      const user = createUser(
        body.username,
        (body.domains ?? {}) as Record<string, Permission>,
        body.global_admin ?? false,
        body.email,
      );
      if (user.global_admin) revokeUserSessions("_admin");

      let inviteInfo: { invite_sent?: boolean; invite_error?: string; invite_url?: string } = {};
      if (body.send_invite) {
        try {
          const { plaintext } = await generateToken(user.username, "invite");
          const url = `${config.publicUrl}/dashboard?token=${plaintext}`;
          const { subject, text, html } = renderInviteEmail({
            username: user.username,
            url,
            ttlDays: 7,
          });
          await mailer!.send({ to: user.email!, subject, text, html });
          inviteInfo = { invite_sent: true };
        } catch (e) {
          // Token already generated — surface URL for out-of-band share.
          const { plaintext } = await generateToken(user.username, "invite");
          const url = `${config.publicUrl}/dashboard?token=${plaintext}`;
          inviteInfo = { invite_error: (e as Error).message, invite_url: url };
        }
      }

      return c.json({
        ok: true,
        username: user.username,
        key: user.key,
        email: user.email,
        domains: user.domains,
        global_admin: user.global_admin,
        ...inviteInfo,
      }, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });
```

Note: `revokeUserTokens` import already present from Task 14. `generateToken` and `renderInviteEmail` likewise.

- [ ] **Step 2: Typecheck**

Run: `cd server && $HOME/.deno/bin/deno check index.ts`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/routes/admin.ts
git commit -m "$(cat <<'EOF'
Extend POST /admin/users with email + send_invite

Body gains optional email (passes through to createUser) and
send_invite boolean. When send_invite is true, validates email +
mailer, creates the user, then issues + emails an invite token. On
SMTP failure, returns 201 with the created user plus invite_error
+ invite_url so admin can share out-of-band. Unchanged behavior
when send_invite is absent or false.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: UI — Login page "Forgot password?" modal

**Files:**
- Modify: `server/static/dashboard.html`

No e2e (UI tests are out of scope for this plan).

- [ ] **Step 1: Add "Forgot password?" link under the Sign In button**

In `server/static/dashboard.html`, find the login form. After the Sign In button but still inside the login box, add a link:

```html
<button onclick="attemptLogin()">Sign in</button>
<div id="login-error"></div>
<div style="margin-top:0.75rem">
  <a href="#" onclick="showForgotPasswordModal();return false;" style="color:var(--accent);font-size:0.9rem">Forgot password?</a>
</div>
<div id="login-hint"></div>
```

- [ ] **Step 2: Add the modal markup**

After the login `<div id="login">` block, add:

```html
<div id="forgot-modal" class="modal" style="display:none">
  <div class="modal-content" style="max-width:420px">
    <h3 style="margin-top:0">Reset your password</h3>
    <p style="color:var(--muted);font-size:0.9rem">Enter your recovery email. We'll send a link to choose a new password.</p>
    <input id="forgot-email" type="email" placeholder="you@example.com" style="width:100%;margin-bottom:0.75rem">
    <div id="forgot-status" style="color:var(--muted);font-size:0.85rem;min-height:1.2em;margin-bottom:0.5rem"></div>
    <div style="display:flex;justify-content:flex-end;gap:0.5rem">
      <button class="secondary" onclick="closeForgotModal()">Cancel</button>
      <button onclick="sendForgotRequest()">Send link</button>
    </div>
  </div>
</div>
```

(If `.modal` and `.modal-content` CSS classes don't already exist in the file, look at an existing modal pattern — e.g. the create-user dialog — and either reuse that class structure or add minimal inline styles.)

- [ ] **Step 3: Add the JS handlers**

In the `<script>` block, near other admin/auth helpers:

```js
function showForgotPasswordModal() {
  document.getElementById('forgot-email').value = '';
  document.getElementById('forgot-status').textContent = '';
  document.getElementById('forgot-modal').style.display = 'block';
}

function closeForgotModal() {
  document.getElementById('forgot-modal').style.display = 'none';
}

async function sendForgotRequest() {
  const email = document.getElementById('forgot-email').value.trim();
  const status = document.getElementById('forgot-status');
  if (!email) {
    status.textContent = 'Enter an email address.';
    return;
  }
  status.textContent = 'Sending…';
  try {
    const r = await fetch(`${BASE}/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    if (r.status === 429) {
      status.textContent = 'Too many requests — try again later.';
      return;
    }
    // Anti-enumeration: always show the same success copy regardless of match.
    status.textContent = 'If that email matches an account, a reset link is on its way.';
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add server/static/dashboard.html
git commit -m "$(cat <<'EOF'
Add Forgot Password modal on login page

Link below Sign In opens a modal that POSTs /auth/forgot-password.
Always shows the anti-enumeration success copy regardless of
whether the email matched a user. Handles 429 with a try-again
message.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 18: UI — Reset / invite form

**Files:**
- Modify: `server/static/dashboard.html`

- [ ] **Step 1: Add reset-form markup**

Add a new section inside the body, after the `login` div, before the main `app` div:

```html
<div id="reset-screen" style="display:none;position:fixed;inset:0;background:var(--bg);z-index:100;padding-top:10vh">
  <div style="max-width:420px;margin:0 auto;background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:1.5rem">
    <h2 id="reset-heading" style="margin-top:0">Reset your password</h2>
    <p id="reset-subtitle" style="color:var(--muted);font-size:0.9rem;margin-top:0.25rem"></p>
    <label for="reset-new-password" style="font-size:0.85rem;color:var(--muted)">New password</label>
    <input id="reset-new-password" type="password" autocomplete="new-password" style="width:100%;margin-bottom:0.75rem">
    <label for="reset-confirm" style="font-size:0.85rem;color:var(--muted)">Confirm password</label>
    <input id="reset-confirm" type="password" autocomplete="new-password" style="width:100%;margin-bottom:0.75rem">
    <div id="reset-status" style="color:var(--muted);font-size:0.85rem;min-height:1.2em;margin-bottom:0.5rem"></div>
    <button onclick="submitReset()" style="width:100%">Set password</button>
  </div>
</div>
```

- [ ] **Step 2: Add JS to detect the token on load and show the reset screen**

In the existing `boot()` / page-init logic, before the normal login-or-app routing, add a token check. Near the top of the script block (or wherever existing URL parsing happens), add:

```js
async function maybeShowReset() {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('token');
  if (!token) return false;
  // Hide other screens
  document.getElementById('login').classList.remove('show');
  document.getElementById('app').classList.remove('show');
  const screen = document.getElementById('reset-screen');
  screen.style.display = 'block';
  // Ask server what kind of token this is.
  let info = { valid: false };
  try {
    const r = await fetch(`${BASE}/auth/reset-token-info?token=${encodeURIComponent(token)}`);
    info = await r.json();
  } catch { /* treat as invalid */ }
  const heading = document.getElementById('reset-heading');
  const subtitle = document.getElementById('reset-subtitle');
  if (!info.valid) {
    heading.textContent = 'Link expired or invalid';
    subtitle.textContent = 'Request a new reset link from the sign-in page.';
    document.getElementById('reset-new-password').disabled = true;
    document.getElementById('reset-confirm').disabled = true;
  } else if (info.kind === 'invite') {
    heading.textContent = `Welcome, ${info.username}`;
    subtitle.textContent = 'Set a password to activate your account.';
  } else {
    heading.textContent = 'Reset your password';
    subtitle.textContent = `Choose a new password for ${info.username}.`;
  }
  // Stash the token for submitReset.
  window._resetToken = token;
  return true;
}

async function submitReset() {
  const token = window._resetToken;
  const pw = document.getElementById('reset-new-password').value;
  const confirm = document.getElementById('reset-confirm').value;
  const status = document.getElementById('reset-status');
  if (pw !== confirm) { status.textContent = 'Passwords do not match.'; return; }
  if (pw.length < 8) { status.textContent = 'Password must be at least 8 characters.'; return; }
  status.textContent = 'Saving…';
  try {
    const r = await fetch(`${BASE}/auth/reset-password`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, new_password: pw }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      status.textContent = `Failed: ${body.error || r.status}`;
      return;
    }
    if (body.auto_signed_in) {
      // Invite flow — cookie is set; go to the dashboard.
      window.location.href = window.location.pathname;
    } else {
      // Reset flow — send to login.
      status.textContent = 'Password updated. Sign in below.';
      setTimeout(() => { window.location.href = window.location.pathname; }, 1200);
    }
  } catch (e) {
    status.textContent = `Error: ${e.message}`;
  }
}
```

- [ ] **Step 3: Call `maybeShowReset` in boot**

Find the existing boot/init function (usually at the bottom of the `<script>` block — it might be called `boot()`, `init()`, or an IIFE). At the very top of that function, before any other routing, add:

```js
  if (await maybeShowReset()) return;
```

If the init function isn't async, wrap the call in a standalone async IIFE or make init async (typical existing pattern).

- [ ] **Step 4: Commit**

```bash
git add server/static/dashboard.html
git commit -m "$(cat <<'EOF'
Add reset/invite form to dashboard

Detects ?token=... in the URL on page load, queries
/auth/reset-token-info for kind + username, shows a form with
context-appropriate copy ("Welcome, alice" for invite; "Reset your
password" for reset). On submit POSTs /auth/reset-password;
invite-kind auto-login sends the user directly to the dashboard;
reset-kind redirects to sign-in.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 19: UI — Profile email card

**Files:**
- Modify: `server/static/dashboard.html`

- [ ] **Step 1: Add the Recovery Email card to the Profile tab**

In the Profile tab section, after the existing Account card (password + API key), add:

```html
<h2 style="margin-top:1.5rem">Recovery email</h2>
<div class="card">
  <div id="profile-email-display" style="font-family:monospace;color:var(--muted)">—</div>
  <div id="profile-email-banner" style="display:none;background:var(--warn-bg,#fff3cd);border:1px solid var(--warn-border,#ffe69c);padding:0.5rem 0.75rem;border-radius:4px;margin:0.5rem 0;font-size:0.9rem">
    No recovery email set. You won't be able to reset your password without an admin.
  </div>
  <div class="form-row" style="margin-top:0.5rem">
    <input id="profile-email-input" type="email" placeholder="you@example.com" style="flex:1">
    <button onclick="saveProfileEmail()">Save</button>
    <button class="secondary" onclick="clearProfileEmail()">Clear</button>
    <span id="profile-email-status" style="color:var(--muted);font-size:0.8rem"></span>
  </div>
</div>
```

- [ ] **Step 2: Populate + wire the card**

Find the existing Profile tab loader (it's likely `LOADERS.profile` or similar — look for what runs when the Profile tab activates). Extend it to fetch `/auth/me` and populate the email card. Add these functions:

```js
async function loadProfileEmail() {
  try {
    const r = await fetch(`${BASE}/auth/me`, { credentials: 'include' });
    if (!r.ok) return;
    const me = await r.json();
    const display = document.getElementById('profile-email-display');
    const banner = document.getElementById('profile-email-banner');
    const input = document.getElementById('profile-email-input');
    if (me.email) {
      display.textContent = me.email;
      banner.style.display = 'none';
      input.value = me.email;
    } else {
      display.textContent = 'not set';
      banner.style.display = 'block';
      input.value = '';
    }
  } catch { /* non-fatal */ }
}

async function saveProfileEmail() {
  const input = document.getElementById('profile-email-input');
  const status = document.getElementById('profile-email-status');
  const email = input.value.trim();
  if (!email) { status.textContent = 'Enter an email.'; return; }
  status.textContent = 'Saving…';
  try {
    const r = await fetch(`${BASE}/auth/email`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { status.textContent = `Failed: ${body.error || r.status}`; return; }
    status.textContent = 'Saved.';
    await loadProfileEmail();
  } catch (e) { status.textContent = `Error: ${e.message}`; }
}

async function clearProfileEmail() {
  if (!confirm('Clear your recovery email? You will not be able to reset your password without an admin.')) return;
  const status = document.getElementById('profile-email-status');
  status.textContent = 'Saving…';
  try {
    const r = await fetch(`${BASE}/auth/email`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: null }),
    });
    if (!r.ok) { status.textContent = `Failed: ${r.status}`; return; }
    status.textContent = 'Cleared.';
    await loadProfileEmail();
  } catch (e) { status.textContent = `Error: ${e.message}`; }
}
```

Add `loadProfileEmail()` to whatever loader runs when the Profile tab is shown (likely `LOADERS.profile = () => { loadWhoami(); loadProfileEmail(); ... }` — adapt to existing shape).

- [ ] **Step 3: Commit**

```bash
git add server/static/dashboard.html
git commit -m "$(cat <<'EOF'
Add Recovery email card to Profile tab

Shows current email or a "not set" warning banner. Save posts
/auth/email; Clear confirms first, then posts {email: null}.
Banner reminds the user why this matters (forgot-password won't
work without it).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 20: UI — Users tab create dialog (email + invite radio) + Config tab SMTP section

**Files:**
- Modify: `server/static/dashboard.html`

This is the largest UI task — two surfaces combined because they share helpers.

- [ ] **Step 1: Extend the "Create user" form**

Find the create-user form in the Users tab. Find its HTML — typically a form-row with username, domain picker, and "Create" button. Before the "Create" button, add an email input and a radio group:

```html
<label style="font-size:0.85rem;color:var(--muted);margin-top:0.5rem">Email (optional)</label>
<input id="new-user-email" type="email" placeholder="user@example.com" style="flex:1">

<label style="font-size:0.85rem;color:var(--muted);margin-top:0.5rem">Initial sign-in</label>
<div id="new-user-init" style="display:flex;gap:1rem;font-size:0.9rem">
  <label><input type="radio" name="new-user-init-mode" value="password" checked> Set password now</label>
  <label><input type="radio" name="new-user-init-mode" value="invite" id="new-user-invite-radio"> Send invite email</label>
</div>
<div id="new-user-password-wrap">
  <input id="new-user-password" type="password" placeholder="initial password (8+ chars)" style="width:100%">
</div>
<div id="new-user-invite-hint" style="display:none;color:var(--muted);font-size:0.85rem"></div>
```

- [ ] **Step 2: Extend the submit handler**

Find the existing create-user submit handler (likely `createNewUser()` or similar). Replace with:

```js
async function createNewUser() {
  const username = document.getElementById('new-user-username').value.trim();
  const email = document.getElementById('new-user-email').value.trim();
  const mode = document.querySelector('input[name="new-user-init-mode"]:checked').value;
  const password = document.getElementById('new-user-password').value;
  const status = document.getElementById('new-user-status'); // existing
  if (!username) { status.textContent = 'Username required.'; return; }
  if (mode === 'password' && password.length < 8) {
    status.textContent = 'Password must be at least 8 characters.'; return;
  }
  if (mode === 'invite' && !email) {
    status.textContent = 'Invite requires an email address.'; return;
  }
  status.textContent = 'Creating…';
  try {
    const createBody = {
      username,
      domains: {},
      global_admin: false,
      email: email || undefined,
      send_invite: mode === 'invite',
    };
    const r = await fetch(`${BASE}/admin/users`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(createBody),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { status.textContent = `Failed: ${body.error || r.status}`; return; }
    if (mode === 'password') {
      // Set initial password via the admin endpoint now that the user exists.
      await fetch(`${BASE}/admin/users/${encodeURIComponent(username)}/password`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      status.textContent = `Created '${username}'. Key shown in the list.`;
    } else {
      if (body.invite_sent) status.textContent = `Created '${username}', invite sent.`;
      else if (body.invite_url) status.textContent = `Created '${username}'. Invite email failed; share this URL manually: ${body.invite_url}`;
      else status.textContent = `Created '${username}'.`;
    }
    if (typeof LOADERS !== 'undefined' && typeof LOADERS.users === 'function') LOADERS.users();
  } catch (e) { status.textContent = `Error: ${e.message}`; }
}
```

- [ ] **Step 3: Wire the radio group**

Add a toggle that shows/hides the password field based on the radio selection. Also disable "Send invite" if SMTP isn't configured (via a status check):

```js
async function updateInviteRadioAvailability() {
  try {
    const r = await fetch(`${BASE}/admin/smtp-status`, { credentials: 'include' });
    if (!r.ok) return;
    const { configured } = await r.json();
    const radio = document.getElementById('new-user-invite-radio');
    const hint = document.getElementById('new-user-invite-hint');
    radio.disabled = !configured;
    hint.style.display = configured ? 'none' : 'block';
    hint.textContent = configured ? '' : 'Invite email requires SMTP configuration (Config tab → Email).';
  } catch { /* assume unavailable */ }
}

document.querySelectorAll('input[name="new-user-init-mode"]').forEach((el) => {
  el.addEventListener('change', () => {
    const mode = document.querySelector('input[name="new-user-init-mode"]:checked').value;
    document.getElementById('new-user-password-wrap').style.display = mode === 'password' ? 'block' : 'none';
  });
});
```

Note: `/admin/smtp-status` doesn't exist yet — add a tiny GET variant next:

- [ ] **Step 4: Add `GET /admin/smtp-status` in `server/routes/admin.ts`**

Inside `adminRoutes`, before the catch-all:

```ts
  // GET /admin/smtp-status — minimal "is email infra ready?" for the UI.
  app.get("/smtp-status", (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    const mailer = getMailer();
    return c.json({ configured: !!(mailer?.isConfigured() && config.publicUrl) });
  });
```

- [ ] **Step 5: Config tab SMTP section**

Find the Config tab (`<section id="tab-config">`). After the existing YAML textarea + env overrides section, add:

```html
<h2 style="margin-top:1.5rem">Email (SMTP)</h2>
<div class="card">
  <div id="smtp-status-indicator" style="margin-bottom:0.5rem;font-size:0.9rem"></div>
  <div style="color:var(--muted);font-size:0.85rem;margin-bottom:0.5rem">
    Edit these via environment variables (<code>OB2_SMTP_*</code>, <code>OB2_PUBLIC_URL</code>)
    or the YAML above. Changes hot-reload. This panel is diagnostic only.
  </div>
  <div class="form-row" style="margin-top:0.5rem">
    <input id="smtp-test-to" type="email" placeholder="send a diagnostic to you@example.com" style="flex:1">
    <button onclick="sendSmtpTest()">Send test email</button>
    <span id="smtp-test-status" style="color:var(--muted);font-size:0.8rem"></span>
  </div>
</div>
```

JS to populate the indicator and handle the button:

```js
async function loadSmtpStatus() {
  try {
    const r = await fetch(`${BASE}/admin/smtp-status`, { credentials: 'include' });
    if (!r.ok) return;
    const { configured } = await r.json();
    const ind = document.getElementById('smtp-status-indicator');
    if (configured) {
      ind.innerHTML = '<span style="color:#28a745">●</span> SMTP + public URL configured.';
    } else {
      ind.innerHTML = '<span style="color:#ffc107">●</span> SMTP or OB2_PUBLIC_URL not fully configured — email flows disabled.';
    }
  } catch { /* noop */ }
}

async function sendSmtpTest() {
  const to = document.getElementById('smtp-test-to').value.trim();
  const status = document.getElementById('smtp-test-status');
  if (!to) { status.textContent = 'Enter a destination address.'; return; }
  status.textContent = 'Sending…';
  try {
    const r = await fetch(`${BASE}/admin/smtp/test`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { status.textContent = `Failed: ${body.error || r.status}`; return; }
    status.textContent = 'Sent. Check the recipient inbox.';
  } catch (e) { status.textContent = `Error: ${e.message}`; }
}
```

Wire `loadSmtpStatus()` and `updateInviteRadioAvailability()` into the Config and Users tab loaders respectively.

- [ ] **Step 6: Commit**

```bash
git add server/routes/admin.ts server/static/dashboard.html
git commit -m "$(cat <<'EOF'
Users create dialog + Config tab SMTP section

Create-user dialog gains an email field and a radio toggle between
"Set initial password now" and "Send invite email." Invite option
is disabled (with hint) if SMTP+publicUrl aren't configured.

Config tab gains an Email (SMTP) card with a green/yellow status
indicator and a test-email button. Backed by a new GET
/admin/smtp-status endpoint that reports configuration state
without exposing secrets.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 21: Documentation updates

**Files:**
- Modify: `docs/user-guide.md`

- [ ] **Step 1: Add the "Email recovery & onboarding" top-level section**

Find a sensible spot after the existing Users/Profile sections. Insert a new `##` section:

```markdown
## Email recovery & onboarding

Once you configure SMTP, OB2 supports two email flows:

- **Forgot-password** — users click "Forgot password?" on the sign-in page, receive a link, set a new password.
- **Invite** — admins create a user without typing an initial password; the user receives an email with a link to set their own.

### Enabling SMTP

Set these environment variables (or their equivalents in `config.yaml`):

```
OB2_SMTP_HOST=smtp.yourprovider.com
OB2_SMTP_PORT=587
OB2_SMTP_USER=yourusername
OB2_SMTP_PASS=yourpassword
OB2_SMTP_SECURE=starttls     # or "tls" (port 465) or "none"
OB2_SMTP_FROM="OB2 <noreply@yourdomain.com>"
OB2_PUBLIC_URL=https://ob2.yourdomain.com
```

The `OB2_PUBLIC_URL` is used to build the links in outbound emails — it must be absolute and reachable by your users.

**Gmail**: use an app-password, not your account password. Host `smtp.gmail.com`, port `587`, secure `starttls`.

**Sendgrid/SES/Mailgun**: all three publish SMTP endpoints. Use those. OB2 does not (yet) ship provider-specific HTTP drivers.

### Verifying it works

Open **Config → Email (SMTP)**. The status indicator shows green if everything is configured. Click "Send test email" with your own address; you should receive an "OB2 SMTP test" message within seconds.

### Inviting a new user

Users tab → Create. Select "Send invite email," enter the user's address, click Create. They'll receive an email with a link (7-day TTL, single-use). Clicking the link lands them on a "Set password" form; on submit they're signed in automatically.

If SMTP fails at send time, OB2 returns the invite URL in the UI so you can share it manually (Slack, SMS, etc.).

### Forgot-password

Users: sign-in page → "Forgot password?" → enter your recovery email. Link expires in 1 hour, single-use. If the email matches an account, you receive a reset link; the server responds the same way whether or not the address matched (anti-enumeration).

### Rate limits

- Forgot-password: 5 requests / 15 min per IP, 3 / hour per target email.
- Reset-password: 10 attempts / hour per token (protects against brute-force on the token).

Resets are per-process and clear when the server restarts.

### What if SMTP is down?

- Forgot-password silently no-ops (user sees the usual "if that email matches..." message).
- Admin invite surfaces the invite URL in the response so you can share out-of-band.
- Last-resort: the shell break-glass script (`server/scripts/reset-admin.ts`) still works for sole-admin lockouts.

### Troubleshooting

| Symptom | Likely cause |
|---|---|
| Test email returns 400 "mailer not configured" | `OB2_SMTP_HOST`/`_FROM`/`OB2_PUBLIC_URL` not all set. Check Config tab. |
| Test email 500 with connection refused | Wrong port or SMTP host. Gmail: 587 with starttls. |
| Test email 500 with auth failed | Wrong user/pass. Gmail: enable 2FA then create an app-password. |
| Test email sent but not received | Check spam. Verify `from` domain matches DMARC/SPF. |
| "email infrastructure not configured" on admin invite | `publicUrl` unset, or mailer driver returns false from `isConfigured()`. |
```

- [ ] **Step 2: Commit**

```bash
git add docs/user-guide.md
git commit -m "$(cat <<'EOF'
Document email recovery & onboarding

New section covers SMTP config (env vars + YAML), test-email
workflow, invite + forgot-password flows, rate limits, SMTP-down
fallbacks, and a troubleshooting table for the common gotchas
(Gmail app-password, DMARC, port 587 vs 465).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 22: Final e2e run + test-results refresh

**Files:**
- Modify: `docs/test-results.md` (after the run)

This task is for the **user** to execute. Subagents cannot run the e2e suite because it requires the live Docker stack (Ollama + pgvector).

- [ ] **Step 1: User — stop docker ob2-server, run e2e with log mailer**

```bash
cd /mnt/c/projects/OB2
docker stop ob2-server
rm -f server/users.json users.json 2>/dev/null
OB2_SMTP_DRIVER=log bash tests/e2e.sh 2>&1 | tee /tmp/e2e-email.log | tail -30
```

Expected: summary shows 49 / 49 PASS (37 prior + 12 new). If any assertions FAIL, share the relevant excerpt and the next iteration fixes it.

- [ ] **Step 2: Restart docker**

```bash
cd docker && docker compose up -d --force-recreate ob2-server
```

- [ ] **Step 3: User — update `docs/test-results.md`**

Append a new Suite 4 section to `docs/test-results.md`:

```markdown
## Suite 4 — Email recovery (`tests/e2e.sh` Step 13, `OB2_SMTP_DRIVER=log`)

Added by branch `email-recovery` (spec / plan under `docs/superpowers/`). Exercises forgot-password anti-enumeration, reset-password happy path + reuse + expired + weak-password, self-serve email update via `/auth/email`, admin invite with auto-login on accept, and SMTP test endpoint.

\`\`\`
[paste the 12 PASS lines from /tmp/e2e-email.log's Step 13 section here]
\`\`\`

**Suite 4 result: 12 / 12 assertions PASS.**

## Combined: 49 / 49 assertions PASS
```

- [ ] **Step 4: Commit the docs refresh**

```bash
git add docs/test-results.md
git commit -m "$(cat <<'EOF'
test-results: Add Suite 4 (Email recovery) — 49/49 PASS

Captures the 12 new e2e assertions added by the email-recovery
branch: forgot-password anti-enumeration, reset-password flows,
invite auto-login, SMTP test endpoint, self-serve email update.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage:**
- §1 module layout: Tasks 2, 3, 4, 5, 6 (mail + auth modules).
- §2 Mailer interface: Task 2.
- §3 SmtpMailer: Task 3.
- §4 LogMailer: Task 2 (ships in the same commit as the interface).
- §5 Templates: Task 4.
- §6 Token store: Task 5.
- §7 Config: Task 1.
- §8 Rate limiter: Task 6.
- §9 Email field on UserRecord: Task 7.
- §10 Public endpoints: Tasks 10 (forgot-password), 11 (reset-password + reset-token-info).
- §11 Authed endpoints: Tasks 12 (/auth/email), 14 (/admin/users/:name/invite), 15 (/admin/smtp/test), plus /auth/me extension in Task 13.
- §12 Admin create-user flow: Task 16 (backend) + Task 20 (UI).
- §13 UI: Tasks 17 (forgot modal), 18 (reset form), 19 (profile card), 20 (users tab + config SMTP).
- §14 Tests: integrated into each task's e2e additions; final assembly in Task 22.
- §15 Docs: Task 21.

**Type consistency:**
- `Mailer` interface used everywhere; signature stable across Tasks 2, 3, 10, 14, 15.
- `IssuedToken` / `consumeToken` return shape stable between Task 5 definition and consumers (11, 14, 16).
- `AuthContext.email` added in Task 13; consumers (`/auth/me`, UI) in Tasks 13 + 19.
- `UserPatch.email` defined in Task 7; consumed by `updateUser` + raw editor + `setEmail`.
- `OB2_SMTP_DRIVER` env and Config.smtpDriver accept `"smtp" | "log" | ""` consistently across Tasks 1, 2, 9.

**Placeholder scan:** no TBDs, no "similar to Task N," no `Add error handling` hand-waves. All code shown.

**Cross-task sequencing hazards (noted for implementer):**
- Task 7 must land before Task 11 (reset-password needs `setPassword` + users gain email field for findUserByEmail).
- Task 8 must land before Task 10 (mailer init before any endpoint uses getMailer).
- Task 9 must land before any assertion-adding task (Step 13 scaffolding opens the `if` guard; subsequent tasks insert before its closing `fi`).
- Task 13 (AuthContext.email) should land before Task 19 (Profile card reads it); they are sequenced correctly.
- Task 20 creates `GET /admin/smtp-status`; Task 20 itself adds it in Step 4. No earlier task references it.

**Known limitations (flagged for follow-up, not blockers):**
- Rate limiter is per-process. Multi-process deployments would need shared state (Redis, etc.). OB2 runs as a single process today.
- `mail-log.txt` is unbounded — test driver only, acceptable.
- No invite-cancellation UI (admin can invite, but can't revoke before expiry except by deleting the user). `revokeUserTokens` exists server-side; UI can be added in a later spec.
