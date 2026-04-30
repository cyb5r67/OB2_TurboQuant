# Close the `_admin` Bootstrap Path — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `OB2_BRAIN_KEY` stop authenticating anywhere once a real global admin exists in `users.json`. Add a safety rail that prevents the admin from locking everyone out, a raw `users.json` editor in the GUI, and a shell break-glass script for solo-admin recovery.

**Architecture:** One predicate (`hasRealGlobalAdmin()`) gates all three brain-key auth paths. A second predicate (`wouldLeaveZeroAdmins()`) rails every write path. A new pair of endpoints (`GET/POST /admin/users/raw`) backs a collapsible raw editor in the Users tab. A standalone Deno script provides file-level admin recovery without needing the server up.

**Tech Stack:** Deno + Hono (TypeScript server), vanilla JS dashboard, argon2id via `hash-wasm`, bash/curl e2e tests.

**Spec:** `docs/superpowers/specs/2026-04-18-close-admin-bootstrap-design.md`

---

## Conventions for this plan

- Server base URL in tests: `$BASE` (set by `tests/e2e.sh` to `http://127.0.0.1:${OB2_PORT:-7600}`).
- Tests live in `tests/e2e.sh`. We add new assertions at the end, after Step 11 ("Multi-user ACL enforcement"). New section header: `Step 12: Bootstrap close-down`.
- Existing helpers in the test file: `assert_contains`, `assert_status`, `PASS`, `FAIL`, `TESTS`, `$KEY` (the brain-key), `$USERS_FILE` (resolved path).
- "Commit" steps use the project's existing conventional messages (no `[skip ci]`, no `--amend`). Each task gets one commit.
- `Deno` binary: `$HOME/.deno/bin/deno` per `tests/e2e.sh` line 23.
- Run the full e2e suite with: `cd /mnt/c/projects/OB2 && bash tests/e2e.sh`.

---

## Task 0: Drop the stale WIP stash

The stash `stash@{0}` ("WIP: _admin auto-disable...") partially implements §1 of the spec but has no tests and doesn't cover the Bearer/MCP close, safety rail, raw editor, or shell script. This plan rebuilds all of it cleanly with tests. We drop the stash to avoid divergent implementations.

**Files:** none (stash only).

- [ ] **Step 1: Verify stash content matches the expected WIP**

Run: `git stash show stash@{0}`
Expected: shows a diff touching `server/routes/admin.ts`, `server/routes/auth.ts`, `server/static/dashboard.html`, `server/users.ts`. The message is `WIP: _admin auto-disable when real global admin exists (awaiting user decision on admin password seeding)`.

- [ ] **Step 2: Drop the stash**

Run: `git stash drop stash@{0}`
Expected: `Dropped stash@{0} (<hash>)`.

Verify: `git stash list` → empty.

- [ ] **Step 3: No commit needed**

Nothing changed in the working tree.

---

## Task 1: `hasRealGlobalAdmin()` helper

Adds the single predicate that all three brain-key auth gates will use.

**Files:**
- Modify: `server/users.ts` (add export after `generateApiKey`, roughly line 242)

- [ ] **Step 1: Add the helper**

Insert after the `generateApiKey` function in `server/users.ts` (just before `export function listUsers`):

```ts
/** True when users.json contains at least one enabled user with
 * global_admin=true. Used to gate the brain-key bootstrap — once a real
 * global admin exists, the brain-key stops authenticating anywhere. */
export function hasRealGlobalAdmin(): boolean {
  _reloadIfChanged();
  for (const u of _users.values()) {
    if (
      u.enabled !== false &&
      u.global_admin === true &&
      u.username !== "_admin"
    ) {
      return true;
    }
  }
  return false;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd server && $HOME/.deno/bin/deno check index.ts`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add server/users.ts
git commit -m "$(cat <<'EOF'
Add hasRealGlobalAdmin() predicate

Single source of truth for "is bootstrap still needed?" — returns true
when users.json contains at least one enabled, non-_admin user with
global_admin=true. Used by upcoming auth gates.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Close brain-key dashboard login (`POST /auth/login`)

TDD: add the failing e2e assertion first, then implement.

**Files:**
- Modify: `tests/e2e.sh` (new Step 12 section)
- Modify: `server/routes/auth.ts` (lines 72–84 area)

- [ ] **Step 1: Append the failing assertion to `tests/e2e.sh`**

Insert this new section before the `# ── Summary ──` block (around line 310):

```bash
# ─────────────────────────────────────────────
echo
echo "── Step 12: Bootstrap close-down ──"

# At this point, users.json already contains bob (created in Step 11), but
# bob is not a global admin. Promote him so hasRealGlobalAdmin() returns true.
curl -s -X PATCH "$BASE/admin/users/bob" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"global_admin":true}' > /dev/null

# 12.1: dashboard login as _admin + brain-key is refused (403)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"_admin\",\"password\":\"$KEY\"}")
assert_status "_admin dashboard login refused after real admin exists" "$STATUS" "403"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /mnt/c/projects/OB2 && bash tests/e2e.sh 2>&1 | tail -40`
Expected: `FAIL: _admin dashboard login refused after real admin exists — expected '403' in response` (the current code returns 200 because the bootstrap path always mints a session on correct brain-key).

- [ ] **Step 3: Modify `POST /auth/login` to gate the bootstrap path**

In `server/routes/auth.ts`, update the import block (around line 21) to include `hasRealGlobalAdmin`:

```ts
import {
  bearerAuthMulti,
  type AuthContext,
  verifyPassword,
  setPassword,
  rotateApiKey,
  listUsers,
  hasRealGlobalAdmin,
} from "../users.ts";
```

Then replace the bootstrap block (lines 72–84, the `if (username === "_admin" && password === config.brainKey) { ... }` section) with:

```ts
    // Bootstrap: allow "_admin" + OB2_BRAIN_KEY ONLY when no real global
    // admin exists yet. Once a real global admin is provisioned, this path
    // closes. See docs/superpowers/specs/2026-04-18-close-admin-bootstrap-design.md
    if (username === "_admin") {
      if (password !== config.brainKey) {
        return c.json({ error: "invalid credentials" }, 401);
      }
      if (hasRealGlobalAdmin()) {
        return c.json({
          error:
            "bootstrap _admin is disabled because a real global admin exists. Sign in as that user instead.",
        }, 403);
      }
      const { token } = await createSession("_admin");
      const cookie = buildCookie(token, SESSION_TTL_SEC, isHttps(c));
      c.header("Set-Cookie", cookie);
      return c.json({
        ok: true,
        username: "_admin",
        global_admin: true,
        bootstrap: true,
      });
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /mnt/c/projects/OB2 && bash tests/e2e.sh 2>&1 | tail -30`
Expected: `PASS: _admin dashboard login refused after real admin exists`. Summary line shows one more PASS than before, zero FAIL.

- [ ] **Step 5: Commit**

```bash
git add server/routes/auth.ts tests/e2e.sh
git commit -m "$(cat <<'EOF'
Close _admin dashboard login once a real global admin exists

POST /auth/login with username=_admin now returns 403 when
hasRealGlobalAdmin() is true. Bad passwords still get 401 so the
error surface doesn't leak the gate state. E2E asserts the 403.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Close brain-key Bearer + MCP paths (`_resolveAuth`)

Same gate, applied to `server/users.ts:108`. This is the spec's §1 third and most important bullet — without it, the dashboard close is bypassable by any API client.

**Files:**
- Modify: `tests/e2e.sh`
- Modify: `server/users.ts` (lines 107–114)

- [ ] **Step 1: Append two failing assertions to `tests/e2e.sh`**

Insert directly after the 12.1 assertion block:

```bash
# 12.2: Authorization: Bearer <brain-key> on /admin is refused (401)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer $KEY" "$BASE/admin/domains")
assert_status "brain-key Bearer refused on /admin after real admin exists" "$STATUS" "401"

# 12.3: x-brain-key MCP header with brain-key is refused (401)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/mcp" \
  -H "x-brain-key: $KEY" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
assert_status "brain-key x-brain-key refused on /mcp after real admin exists" "$STATUS" "401"
```

- [ ] **Step 2: Run to verify both fail**

Run: `cd /mnt/c/projects/OB2 && bash tests/e2e.sh 2>&1 | tail -30`
Expected: Two new FAILs (both return 200 today because `_resolveAuth` resolves brain-key to the virtual `_admin` unconditionally).

- [ ] **Step 3: Gate the single-key fallback in `_resolveAuth`**

In `server/users.ts`, locate the block around lines 107–114:

```ts
  // Fallback: single-key mode (backwards compat)
  if (key === config.brainKey) {
    return {
      username: "_admin",
      global_admin: true,
      domains: {},
    };
  }
```

Replace with:

```ts
  // Fallback: single-key mode (backwards compat). Closed once a real
  // global admin exists — brain-key then authenticates nothing.
  if (key === config.brainKey) {
    if (hasRealGlobalAdmin()) return null;
    return {
      username: "_admin",
      global_admin: true,
      domains: {},
    };
  }
```

Note: `hasRealGlobalAdmin` is already exported in the same file (Task 1). No import needed.

- [ ] **Step 4: Run to verify both pass**

Run: `cd /mnt/c/projects/OB2 && bash tests/e2e.sh 2>&1 | tail -30`
Expected: Both 12.2 and 12.3 now PASS. Earlier Step 11 assertions (bob with his own API key) still PASS, because bob's key goes through the multi-user lookup branch, not the brain-key fallback.

- [ ] **Step 5: Commit**

```bash
git add server/users.ts tests/e2e.sh
git commit -m "$(cat <<'EOF'
Close brain-key Bearer + MCP auth once real admin exists

_resolveAuth's single-key fallback now returns null when
hasRealGlobalAdmin() is true, closing both Authorization: Bearer
<brain-key> and x-brain-key: <brain-key> against MCP. Multi-user
lookup is unaffected so existing user API keys still work.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Public `GET /auth/status` + dynamic login hint

The dashboard login hint currently reads *"sign in as `_admin` with your `OB2_BRAIN_KEY`..."* — which is a lie after Task 2. We add an unauthenticated status endpoint and update the hint to reflect reality.

**Files:**
- Modify: `tests/e2e.sh`
- Modify: `server/routes/auth.ts`
- Modify: `server/static/dashboard.html`

- [ ] **Step 1: Append failing assertion to `tests/e2e.sh`**

Insert after 12.3:

```bash
# 12.4: /auth/status reflects that bootstrap is no longer available
STATUS_JSON=$(curl -s "$BASE/auth/status")
assert_contains "/auth/status bootstrap_available=false after real admin" "$STATUS_JSON" '"bootstrap_available":false'
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /mnt/c/projects/OB2 && bash tests/e2e.sh 2>&1 | tail -30`
Expected: FAIL — endpoint is 404, response doesn't contain the string.

- [ ] **Step 3: Add the endpoint**

In `server/routes/auth.ts`, insert this block immediately before the `// ── POST /auth/login ──` comment (around line 58):

```ts
  // ── GET /auth/status ── (public, no auth)
  // Lets unauthenticated clients (the login page in particular) render
  // truthful hint text. Exposes only a boolean — no secrets.
  app.get("/status", (c) => {
    return c.json({ bootstrap_available: !hasRealGlobalAdmin() });
  });
```

- [ ] **Step 4: Run the e2e to verify 12.4 passes**

Run: `cd /mnt/c/projects/OB2 && bash tests/e2e.sh 2>&1 | tail -30`
Expected: 12.4 PASS.

- [ ] **Step 5: Update the dashboard login hint to use the endpoint**

In `server/static/dashboard.html`, find the block (around line 100–104):

```html
    <div id="login-hint">
      First-time setup: sign in as <code>_admin</code> with your <code>OB2_BRAIN_KEY</code>, then create real users under the Users tab.
    </div>
```

Replace with:

```html
    <div id="login-hint"></div>
```

Then find the `function showLogin(errMsg)` function (around line 268 — grep for `showLogin`) and append a call to `updateLoginHint()` before the closing brace:

Find:
```js
function showLogin(errMsg) {
  document.getElementById('login').classList.add('show');
  document.getElementById('app').classList.remove('show');
  document.getElementById('login-error').textContent = errMsg || '';
  document.getElementById('login-username').focus();
}
```

Replace with:

```js
function showLogin(errMsg) {
  document.getElementById('login').classList.add('show');
  document.getElementById('app').classList.remove('show');
  document.getElementById('login-error').textContent = errMsg || '';
  document.getElementById('login-username').focus();
  updateLoginHint();
}

async function updateLoginHint() {
  const hint = document.getElementById('login-hint');
  try {
    const r = await fetch(`${BASE}/auth/status`);
    const { bootstrap_available } = await r.json();
    hint.innerHTML = bootstrap_available
      ? `First-time setup: sign in as <code>_admin</code> with your <code>OB2_BRAIN_KEY</code>, then create real users under the Users tab.`
      : `Sign in with your OB2 account. The <code>_admin</code> bootstrap path is closed because a real global admin exists.`;
  } catch {
    hint.textContent = '';
  }
}
```

- [ ] **Step 6: Manual UI verification**

With the server running: open `http://127.0.0.1:7600/` in a browser, open DevTools → Network tab, confirm `/auth/status` returns `{bootstrap_available: true}` on a fresh deployment and the hint reads "First-time setup...". After creating a real global admin, hard-refresh and confirm the hint reads "...bootstrap path is closed...".

If you can't start the server locally, skip this step and note it in the commit message.

- [ ] **Step 7: Commit**

```bash
git add server/routes/auth.ts server/static/dashboard.html tests/e2e.sh
git commit -m "$(cat <<'EOF'
Add GET /auth/status and make login hint reflect bootstrap state

Unauthenticated endpoint exposes bootstrap_available as a boolean so
the dashboard can render a truthful login hint. No secrets leaked.
Login hint now pulls dynamically and switches between bootstrap-mode
and steady-state copy.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Auto-revoke `_admin` sessions on real-admin create/promote

Without this, a logged-in `_admin` session survives after a real admin is created — effectively keeping the bootstrap path alive for as long as that browser tab is open.

**Files:**
- Modify: `server/routes/admin.ts`

- [ ] **Step 1: Revoke sessions when creating a global-admin user**

In `server/routes/admin.ts`, locate the `POST /users` handler (around line 189). Find the success branch:

```ts
    try {
      const user = createUser(
        body.username,
        (body.domains ?? {}) as Record<string, Permission>,
        body.global_admin ?? false,
      );
      return c.json({
        ok: true,
        username: user.username,
        key: user.key,
        domains: user.domains,
        global_admin: user.global_admin,
      }, 201);
```

Insert one line between `createUser(...)` and `return c.json(...)`:

```ts
    try {
      const user = createUser(
        body.username,
        (body.domains ?? {}) as Record<string, Permission>,
        body.global_admin ?? false,
      );
      // Creating a real global admin retires the bootstrap path — evict
      // any live _admin sessions so the transition is immediate.
      if (user.global_admin) revokeUserSessions("_admin");
      return c.json({
        ok: true,
        username: user.username,
        key: user.key,
        domains: user.domains,
        global_admin: user.global_admin,
      }, 201);
```

- [ ] **Step 2: Revoke sessions when promoting a user to global admin**

In the same file, locate the `PATCH /users/:username` handler (around line 224). Find the success branch:

```ts
    try {
      const updated = updateUser(username, body);
      return c.json({ ok: true, user: updated });
```

Insert one line between `updateUser(...)` and `return c.json(...)`:

```ts
    try {
      const updated = updateUser(username, body);
      // Promoting to global admin retires the bootstrap path.
      if (body.global_admin === true) revokeUserSessions("_admin");
      return c.json({ ok: true, user: updated });
```

- [ ] **Step 3: Typecheck**

Run: `cd server && $HOME/.deno/bin/deno check index.ts`
Expected: no errors. (`revokeUserSessions` is already imported at the top of `admin.ts` from `../auth/sessions.ts`.)

- [ ] **Step 4: Smoke-run the e2e**

Run: `cd /mnt/c/projects/OB2 && bash tests/e2e.sh 2>&1 | tail -10`
Expected: summary shows zero FAIL. No new assertions in this task — this behavior is defense-in-depth and is covered implicitly by the gate tests in Tasks 2/3 (once the gate is active, any leftover session is irrelevant to future logins).

- [ ] **Step 5: Commit**

```bash
git add server/routes/admin.ts
git commit -m "$(cat <<'EOF'
Revoke _admin sessions on real-admin create/promote

When a user is created with global_admin=true or promoted to it via
PATCH, evict any live _admin sessions. Pairs with the brain-key gate:
the bootstrap browser session dies the moment the gate closes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `wouldLeaveZeroAdmins()` safety rail

Applied to `updateUser` (demote/disable) and `revokeUser` (soft-delete). Prevents the admin from accidentally locking out everyone, which is critical once Task 3 has closed the brain-key.

**Files:**
- Modify: `tests/e2e.sh`
- Modify: `server/users.ts`
- Modify: `server/routes/admin.ts`

- [ ] **Step 1: Append two failing assertions to `tests/e2e.sh`**

At this point in the test flow, `bob` is the sole global admin (promoted in Step 12.1). Try to demote him — must be refused.

Insert after 12.4:

```bash
# 12.5: PATCH last global admin (demote) is refused (409)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/admin/users/bob" \
  -H "Authorization: Bearer $KEY_FAIL" -H "Content-Type: application/json" \
  -d '{"global_admin":false}')
# Note: we intentionally use an invalid key here first — brain-key is now closed.
# We need a real global-admin credential to even reach the handler. Switch to
# bob's API key (from Step 11) which IS global admin.
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE/admin/users/bob" \
  -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
  -d '{"global_admin":false}')
assert_status "cannot demote last global admin" "$STATUS" "409"

# 12.6: DELETE last global admin is refused (409)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE/admin/users/bob" \
  -H "Authorization: Bearer $BOB_KEY")
assert_status "cannot revoke last global admin" "$STATUS" "409"
```

- [ ] **Step 2: Run to verify both fail**

Run: `cd /mnt/c/projects/OB2 && bash tests/e2e.sh 2>&1 | tail -30`
Expected: 12.5 and 12.6 both FAIL (today, updateUser and revokeUser silently succeed and lock out everyone — the tests will often cascade-fail because subsequent requests lose auth).

Heads-up: since 12.6 would actually disable bob if the rail weren't there, running this test without the rail corrupts `$USERS_FILE` for the rest of the suite. That's fine — the suite starts from `rm -f "$USERS_FILE"` on the next run. If you want a clean failure run, invoke: `rm -f "$USERS_FILE" && bash tests/e2e.sh` each time.

- [ ] **Step 3: Add `wouldLeaveZeroAdmins()` and integrate it**

In `server/users.ts`, add a helper after `hasRealGlobalAdmin` (from Task 1):

```ts
/** Internal: returns true if the proposed users array would have zero
 * enabled, non-_admin global admins. Used as a rail on writes that
 * demote, disable, or soft-delete users. */
function _wouldLeaveZeroAdmins(users: UserRecord[]): boolean {
  for (const u of users) {
    if (
      u.enabled !== false &&
      u.global_admin === true &&
      u.username !== "_admin"
    ) {
      return false;
    }
  }
  return true;
}

/** Thrown by updateUser/revokeUser/raw-save when the proposed state
 * would leave zero enabled global admins. The route layer translates
 * this to HTTP 409. */
export class ZeroAdminError extends Error {
  constructor() {
    super("refusing to save — would leave no enabled global admin");
    this.name = "ZeroAdminError";
  }
}
```

Then modify `updateUser` (around line 281) to call the helper against the patched state:

```ts
export function updateUser(username: string, patch: UserPatch): UserRecord {
  const data = _loadFile();
  const idx = data.users.findIndex((u) => u.username === username);
  if (idx === -1) throw new Error(`user '${username}' not found`);
  const u = data.users[idx];
  // Simulate the patch in-place, then validate the rail, then commit.
  const prev = { domains: u.domains, global_admin: u.global_admin };
  if (patch.domains !== undefined) u.domains = patch.domains;
  if (patch.global_admin !== undefined) u.global_admin = patch.global_admin;
  if (_wouldLeaveZeroAdmins(data.users)) {
    // Roll back the in-memory mutation so _loadFile's contract (returns
    // current disk state) is preserved for any subsequent call.
    u.domains = prev.domains;
    u.global_admin = prev.global_admin;
    throw new ZeroAdminError();
  }
  _atomicWrite(data);
  return { ...u, key: u.key.slice(0, 8) + "..." + u.key.slice(-4) };
}
```

And modify `revokeUser` (around line 293) similarly:

```ts
export function revokeUser(username: string): UserRecord {
  const data = _loadFile();
  const idx = data.users.findIndex((u) => u.username === username);
  if (idx === -1) throw new Error(`user '${username}' not found`);
  const prev = data.users[idx].enabled;
  data.users[idx].enabled = false;
  if (_wouldLeaveZeroAdmins(data.users)) {
    data.users[idx].enabled = prev;
    throw new ZeroAdminError();
  }
  _atomicWrite(data);
  return { ...data.users[idx], key: "***revoked***" };
}
```

- [ ] **Step 4: Translate `ZeroAdminError` to HTTP 409 in the routes**

In `server/routes/admin.ts`, update the import of user-management functions (around line 16) to include the error class:

```ts
import {
  bearerAuthMulti,
  listUsers,
  createUser,
  updateUser,
  revokeUser,
  setPassword,
  type Permission,
  type AuthContext,
  hasPermission,
  ZeroAdminError,
} from "../users.ts";
```

Update the `PATCH /users/:username` error branch (around line 237) to map the error:

```ts
    try {
      const updated = updateUser(username, body);
      if (body.global_admin === true) revokeUserSessions("_admin");
      return c.json({ ok: true, user: updated });
    } catch (err) {
      if (err instanceof ZeroAdminError) {
        return c.json({ error: err.message }, 409);
      }
      return c.json({ error: (err as Error).message }, 400);
    }
```

Update `DELETE /users/:username` (around line 266) similarly:

```ts
  app.delete("/users/:username", (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    const username = c.req.param("username");
    try {
      const revoked = revokeUser(username);
      return c.json({ ok: true, user: revoked });
    } catch (err) {
      if (err instanceof ZeroAdminError) {
        return c.json({ error: err.message }, 409);
      }
      return c.json({ error: (err as Error).message }, 400);
    }
  });
```

- [ ] **Step 5: Run the e2e**

Run: `rm -f "$USERS_FILE" 2>/dev/null; cd /mnt/c/projects/OB2 && bash tests/e2e.sh 2>&1 | tail -30`
Expected: 12.5 and 12.6 both PASS. No regressions in earlier assertions.

- [ ] **Step 6: Typecheck**

Run: `cd server && $HOME/.deno/bin/deno check index.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add server/users.ts server/routes/admin.ts tests/e2e.sh
git commit -m "$(cat <<'EOF'
Add zero-admin safety rail on user mutations

updateUser and revokeUser now refuse to commit any change that would
leave zero enabled global admins. A new ZeroAdminError is translated
to HTTP 409 at the route layer. Prevents the "demoted myself, locked
everyone out" foot-gun now that the brain-key is closed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Raw `users.json` editor — backend

Two endpoints: `GET /admin/users/raw` returns the file verbatim with mtime, `POST /admin/users/raw` validates, applies the zero-admin rail, and writes atomically with mtime-based conflict detection.

**Files:**
- Modify: `tests/e2e.sh`
- Modify: `server/users.ts` (add a raw-save function)
- Modify: `server/routes/admin.ts` (add the two endpoints)

- [ ] **Step 1: Append failing assertions to `tests/e2e.sh`**

Insert after 12.6:

```bash
# 12.7: GET /admin/users/raw returns file contents + mtime
RAW_RES=$(curl -s -H "Authorization: Bearer $BOB_KEY" "$BASE/admin/users/raw")
assert_contains "raw editor GET returns content field" "$RAW_RES" '"content"'
assert_contains "raw editor GET returns mtime field" "$RAW_RES" '"mtime"'

# Extract mtime for the next tests
RAW_MTIME=$(echo "$RAW_RES" | python3 -c "import sys,json; print(json.load(sys.stdin)['mtime'])")
RAW_CONTENT=$(echo "$RAW_RES" | python3 -c "import sys,json; print(json.load(sys.stdin)['content'])")

# 12.8: POST with stale mtime returns 409
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/admin/users/raw" \
  -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
  -d "{\"content\":$(echo "$RAW_CONTENT" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))"),\"expected_mtime\":\"1999-01-01T00:00:00.000Z\"}")
assert_status "raw editor rejects stale mtime" "$STATUS" "409"

# 12.9: POST with payload that removes last global admin returns 400
# Build a payload that strips global_admin from bob.
STRIPPED=$(echo "$RAW_CONTENT" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
for u in d['users']:
    u['global_admin'] = False
print(json.dumps(d))
")
BODY=$(python3 -c "
import sys, json
content = sys.argv[1]
mtime = sys.argv[2]
print(json.dumps({'content': content, 'expected_mtime': mtime}))
" "$STRIPPED" "$RAW_MTIME")
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/admin/users/raw" \
  -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
  -d "$BODY")
assert_status "raw editor rejects zero-admin payload" "$STATUS" "400"

# 12.10: POST with malformed JSON content returns 400
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/admin/users/raw" \
  -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
  -d "{\"content\":\"not valid json {{{\",\"expected_mtime\":\"$RAW_MTIME\"}")
assert_status "raw editor rejects malformed JSON" "$STATUS" "400"

# 12.11: happy-path save — add a @logs read permission to bob
PATCHED=$(echo "$RAW_CONTENT" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
for u in d['users']:
    if u['username'] == 'bob':
        u['domains']['logs'] = 'read'
print(json.dumps(d, indent=2))
")
BODY=$(python3 -c "
import sys, json
print(json.dumps({'content': sys.argv[1], 'expected_mtime': sys.argv[2]}))
" "$PATCHED" "$RAW_MTIME")
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/admin/users/raw" \
  -H "Authorization: Bearer $BOB_KEY" -H "Content-Type: application/json" \
  -d "$BODY")
assert_status "raw editor happy-path save" "$STATUS" "200"

# Verify the change via typed endpoint
USERS_AFTER=$(curl -s -H "Authorization: Bearer $BOB_KEY" "$BASE/admin/users")
assert_contains "raw edit is reflected in /admin/users" "$USERS_AFTER" '"logs":"read"'
```

- [ ] **Step 2: Run to verify failures**

Run: `rm -f "$USERS_FILE" 2>/dev/null; cd /mnt/c/projects/OB2 && bash tests/e2e.sh 2>&1 | tail -40`
Expected: All 12.7–12.11 assertions FAIL (endpoints don't exist → 404).

- [ ] **Step 3: Add the raw-save function in `server/users.ts`**

Insert after `_atomicWrite` (around line 351, the last function in the file):

```ts
/** Raw-editor save path. Validates content as valid JSON matching the
 * UsersConfig shape, applies the zero-admin rail, then writes atomically
 * if the on-disk mtime matches expected_mtime.
 *
 * Throws:
 *  - SyntaxError  for malformed JSON (caller → 400)
 *  - TypeError    for schema violations (caller → 400)
 *  - ZeroAdminError for zero-global-admin payloads (caller → 400)
 *  - RawMtimeConflictError when on-disk mtime ≠ expected (caller → 409) */
export class RawMtimeConflictError extends Error {
  constructor() {
    super("users.json was modified by someone else — reload and retry");
    this.name = "RawMtimeConflictError";
  }
}

export function getRawUsersFile(): { content: string; path: string; mtime: string } {
  const text = Deno.readTextFileSync(_usersFile);
  const stat = Deno.statSync(_usersFile);
  const mtime = (stat.mtime ?? new Date(0)).toISOString();
  return { content: text, path: _usersFile, mtime };
}

export function saveRawUsersFile(content: string, expectedMtime: string): { mtime: string } {
  // 1. Parse + validate schema
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new SyntaxError(`invalid JSON: ${(e as Error).message}`);
  }
  if (
    !parsed || typeof parsed !== "object" ||
    !Array.isArray((parsed as UsersConfig).users)
  ) {
    throw new TypeError("expected shape { users: [...] }");
  }
  const next = (parsed as UsersConfig).users;
  const validPerms = new Set(["read", "write", "admin"]);
  for (const [i, u] of next.entries()) {
    if (!u || typeof u !== "object") {
      throw new TypeError(`users[${i}]: expected object`);
    }
    if (typeof u.username !== "string" || u.username.length === 0) {
      throw new TypeError(`users[${i}].username: required non-empty string`);
    }
    if (u.domains && typeof u.domains === "object") {
      for (const [d, p] of Object.entries(u.domains)) {
        if (!validPerms.has(p as string)) {
          throw new TypeError(`users[${i}].domains["${d}"]: must be read|write|admin`);
        }
      }
    }
  }

  // 2. Zero-admin rail
  if (_wouldLeaveZeroAdmins(next)) {
    throw new ZeroAdminError();
  }

  // 3. mtime conflict check
  const stat = Deno.statSync(_usersFile);
  const currentMtime = (stat.mtime ?? new Date(0)).toISOString();
  if (currentMtime !== expectedMtime) {
    throw new RawMtimeConflictError();
  }

  // 4. Atomic write + reload
  _atomicWrite({ users: next });

  // 5. Report the fresh mtime so the caller's editor has a valid handle
  const newStat = Deno.statSync(_usersFile);
  return { mtime: (newStat.mtime ?? new Date()).toISOString() };
}
```

Note: `_wouldLeaveZeroAdmins` accepts `UserRecord[]` (arrays) — the helper defined in Task 6 already matches.

- [ ] **Step 4: Add the routes in `server/routes/admin.ts`**

Update the import block (around line 16) to pull in the new helpers and errors:

```ts
import {
  bearerAuthMulti,
  listUsers,
  createUser,
  updateUser,
  revokeUser,
  setPassword,
  type Permission,
  type AuthContext,
  hasPermission,
  ZeroAdminError,
  getRawUsersFile,
  saveRawUsersFile,
  RawMtimeConflictError,
} from "../users.ts";
```

Add the two endpoints inside `adminRoutes(...)`, after `DELETE /users/:username` (after the block at line 276). Place them before `return app;`:

```ts
  // ── Raw users.json editor (global admin only) ──

  // GET /admin/users/raw — return the file verbatim + mtime
  app.get("/users/raw", (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    try {
      return c.json(getRawUsersFile());
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // POST /admin/users/raw — validate + zero-admin rail + atomic write
  app.post("/users/raw", async (c) => {
    const denied = requireGlobalAdmin(c);
    if (denied) return denied;
    let body: { content?: string; expected_mtime?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON in request body" }, 400);
    }
    if (typeof body.content !== "string" || typeof body.expected_mtime !== "string") {
      return c.json({ error: "body requires { content: string, expected_mtime: string }" }, 400);
    }
    try {
      const { mtime } = saveRawUsersFile(body.content, body.expected_mtime);
      return c.json({ ok: true, mtime });
    } catch (err) {
      if (err instanceof RawMtimeConflictError) {
        return c.json({ error: err.message }, 409);
      }
      if (err instanceof ZeroAdminError) {
        return c.json({ error: err.message }, 400);
      }
      if (err instanceof SyntaxError || err instanceof TypeError) {
        return c.json({ error: err.message }, 400);
      }
      return c.json({ error: (err as Error).message }, 500);
    }
  });
```

- [ ] **Step 5: Run the e2e**

Run: `rm -f "$USERS_FILE" 2>/dev/null; cd /mnt/c/projects/OB2 && bash tests/e2e.sh 2>&1 | tail -40`
Expected: 12.7 through 12.11 all PASS.

- [ ] **Step 6: Typecheck**

Run: `cd server && $HOME/.deno/bin/deno check index.ts`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add server/users.ts server/routes/admin.ts tests/e2e.sh
git commit -m "$(cat <<'EOF'
Add raw users.json editor endpoints

GET /admin/users/raw returns the file verbatim with mtime;
POST /admin/users/raw validates JSON + schema, applies the
zero-admin rail, and writes atomically only when the on-disk mtime
matches expected_mtime. Mismatches return 409 so concurrent admins
can't clobber each other.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Raw editor UI (Users tab)

**Files:**
- Modify: `server/static/dashboard.html`

No automated test — this is a UI that wraps the endpoints from Task 7, which are already covered.

- [ ] **Step 1: Add the collapsible raw editor section**

In `server/static/dashboard.html`, find the Users tab section (starts around line 164 with `<h2 style="margin-top:1.5rem">Users</h2>`). Add a new `<details>` block immediately before the `</section>` tag that closes `tab-users`:

```html
    <details class="raw-editor" style="margin-top:2rem; border:1px solid var(--border); border-radius:4px; padding:0.75rem">
      <summary style="cursor:pointer; color:var(--muted); font-size:0.9rem">
        Advanced: edit <code>users.json</code> directly
      </summary>
      <div style="color:var(--muted); font-size:0.85rem; margin:0.5rem 0">
        Shown to global admins only. Edits bypass typed validation beyond JSON schema.
        Passwords and API-key hashes are shown as-is. The zero-global-admin rail still applies.
      </div>
      <textarea id="raw-users-yaml" spellcheck="false" style="width:100%; min-height:300px; font-family:monospace; font-size:0.85rem"></textarea>
      <div class="form-row" style="margin-top:0.5rem">
        <button onclick="saveRawUsers()">Save</button>
        <button class="secondary" onclick="loadRawUsers()">Reload</button>
        <span id="raw-users-status" style="color:var(--muted); font-size:0.8rem"></span>
      </div>
    </details>
```

- [ ] **Step 2: Add the JS handlers**

Find the Users tab JS block — search for `function renderUsers` or the closest user-tab function. Append these functions inside the main `<script>` block (near the other admin helpers):

```js
let rawUsersMtime = null;

async function loadRawUsers() {
  const status = document.getElementById('raw-users-status');
  status.textContent = 'Loading…';
  try {
    const r = await fetch(`${BASE}/admin/users/raw`, { credentials: 'same-origin' });
    if (!r.ok) {
      status.textContent = `Load failed: ${r.status}`;
      return;
    }
    const { content, mtime } = await r.json();
    document.getElementById('raw-users-yaml').value = content;
    rawUsersMtime = mtime;
    status.textContent = `Loaded (mtime ${mtime})`;
  } catch (e) {
    status.textContent = `Load error: ${e.message}`;
  }
}

async function saveRawUsers() {
  const status = document.getElementById('raw-users-status');
  const content = document.getElementById('raw-users-yaml').value;
  if (!rawUsersMtime) {
    status.textContent = 'Click Reload first to fetch the current mtime.';
    return;
  }
  status.textContent = 'Saving…';
  try {
    const r = await fetch(`${BASE}/admin/users/raw`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, expected_mtime: rawUsersMtime }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      status.textContent = `Save failed (${r.status}): ${body.error || 'unknown'}`;
      if (r.status === 409) status.textContent += ' — reload and retry.';
      return;
    }
    rawUsersMtime = body.mtime;
    status.textContent = `Saved (mtime ${rawUsersMtime})`;
    // Refresh the typed user list so the UI matches disk.
    if (typeof renderUsers === 'function') renderUsers();
  } catch (e) {
    status.textContent = `Save error: ${e.message}`;
  }
}
```

- [ ] **Step 3: Auto-load the raw content when the `<details>` is first expanded**

Find the section where the Users tab is rendered/initialized. Add a one-liner on the `<details>` open event. Replace the opening `<details class="raw-editor" ...>` with:

```html
    <details class="raw-editor" ontoggle="if(this.open && !rawUsersMtime) loadRawUsers()" style="margin-top:2rem; border:1px solid var(--border); border-radius:4px; padding:0.75rem">
```

- [ ] **Step 4: Manual UI verification**

With the server running and logged in as a global admin:
1. Open the Users tab.
2. Expand "Advanced: edit `users.json` directly." Confirm the textarea populates with the JSON content and the status shows the mtime.
3. Make a trivial edit (add a space in the permissions object). Click Save. Status should update to "Saved (mtime ...)". The Users list above should still show correctly.
4. Try to paste garbage. Click Save. Status should show a 400 error.
5. Open two browser tabs, both on Users. Edit and Save in tab A. In tab B, Save without reloading. Status should show a 409 "reload and retry."

If you can't run the UI locally, note it in the commit.

- [ ] **Step 5: Commit**

```bash
git add server/static/dashboard.html
git commit -m "$(cat <<'EOF'
Add raw users.json editor UI to Users tab

Collapsed <details> block under the typed user list. Reloads on
expand, shows mtime, surfaces 400/409 errors from the backend. Zero
automated test — it's a thin wrapper over /admin/users/raw, which
has full E2E coverage.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Shell break-glass script

A standalone Deno script that manipulates `users.json` directly. Runs even when the server is crash-looping.

**Files:**
- Create: `server/scripts/reset-admin.ts`
- Modify: `tests/e2e.sh`

- [ ] **Step 1: Append failing assertion to `tests/e2e.sh`**

Insert after 12.11:

```bash
# 12.12: shell break-glass script — promote a new user from the CLI, then
# verify login with that user's password.
CHARLIE_PW="charlie-pw-1234"
OB2_USERS_FILE="$USERS_FILE" $DENO run --allow-read --allow-write \
  "$PROJECT_DIR/server/scripts/reset-admin.ts" charlie --password "$CHARLIE_PW" --promote > /tmp/reset-admin.log 2>&1
RC=$?
TESTS=$((TESTS + 1))
if [ "$RC" -eq 0 ]; then
  echo "  PASS: reset-admin script exits 0"
  PASS=$((PASS + 1))
else
  echo "  FAIL: reset-admin script exited $RC"
  cat /tmp/reset-admin.log
  FAIL=$((FAIL + 1))
fi

# Server auto-reloads on file change. Verify login works.
LOGIN_RES=$(curl -s -X POST "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"charlie\",\"password\":\"$CHARLIE_PW\"}")
assert_contains "charlie (promoted by script) can log in" "$LOGIN_RES" '"ok":true'
```

- [ ] **Step 2: Run to verify failure**

Run: `rm -f "$USERS_FILE" 2>/dev/null; cd /mnt/c/projects/OB2 && bash tests/e2e.sh 2>&1 | tail -30`
Expected: 12.12 FAILs (script file doesn't exist).

- [ ] **Step 3: Create `server/scripts/reset-admin.ts`**

```ts
// Standalone break-glass utility to create or reset a global-admin user
// by directly editing users.json. Runs without the OB2 server up.
//
// Usage (typically via `docker exec`):
//
//   deno run --allow-read --allow-write \
//     server/scripts/reset-admin.ts <username> \
//     [--password <pw>] [--promote]
//
// Behavior:
//   - Resolves the users.json path from OB2_USERS_FILE env, else
//     ../users.json relative to this script.
//   - If --password is omitted, reads from stdin (echo disabled).
//   - If --promote is set, ensures the user has global_admin=true and
//     enabled=true. Creates the user (with an empty domain set) if
//     they don't exist.
//   - Atomic write via tmp+rename.

import { hashPassword, validatePasswordStrength } from "../auth/passwords.ts";

interface UserRecord {
  username: string;
  key: string;
  password_hash?: string;
  global_admin: boolean;
  domains: Record<string, "read" | "write" | "admin">;
  created_at: string;
  enabled: boolean;
}

interface UsersConfig {
  users: UserRecord[];
}

function parseArgs(argv: string[]): {
  username: string;
  password?: string;
  promote: boolean;
} {
  const rest: string[] = [];
  let password: string | undefined;
  let promote = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--password") {
      password = argv[++i];
      if (!password) die("--password requires a value");
    } else if (a === "--promote") {
      promote = true;
    } else if (a.startsWith("--")) {
      die(`unknown flag: ${a}`);
    } else {
      rest.push(a);
    }
  }
  if (rest.length !== 1) die("usage: reset-admin.ts <username> [--password <pw>] [--promote]");
  return { username: rest[0], password, promote };
}

function die(msg: string): never {
  console.error(`reset-admin: ${msg}`);
  Deno.exit(2);
}

function resolveUsersFile(): string {
  const envPath = Deno.env.get("OB2_USERS_FILE");
  if (envPath) return envPath;
  // Fallback: ../users.json relative to this script (matches server default).
  const scriptUrl = new URL(import.meta.url);
  const scriptDir = scriptUrl.pathname.replace(/\/[^/]+$/, "");
  return `${scriptDir}/../../users.json`;
}

function generateApiKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `ob2_${hex}`;
}

async function readPasswordFromStdin(): Promise<string> {
  const enc = new TextEncoder();
  await Deno.stdout.write(enc.encode("password: "));
  // Best-effort hide-echo via stty; fall through if unavailable.
  try {
    await new Deno.Command("stty", { args: ["-echo"] }).output();
  } catch { /* noop */ }
  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf) ?? 0;
  try {
    await new Deno.Command("stty", { args: ["echo"] }).output();
  } catch { /* noop */ }
  await Deno.stdout.write(enc.encode("\n"));
  return new TextDecoder().decode(buf.subarray(0, n)).replace(/\r?\n$/, "");
}

function loadUsers(path: string): UsersConfig {
  try {
    return JSON.parse(Deno.readTextFileSync(path)) as UsersConfig;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return { users: [] };
    throw e;
  }
}

function atomicWrite(path: string, data: UsersConfig): void {
  const tmp = `${path}.tmp.${Date.now()}`;
  Deno.writeTextFileSync(tmp, JSON.stringify(data, null, 2));
  Deno.renameSync(tmp, path);
}

async function main() {
  const args = parseArgs(Deno.args);
  const password = args.password ?? await readPasswordFromStdin();
  const pwErr = validatePasswordStrength(password);
  if (pwErr) die(pwErr);

  const path = resolveUsersFile();
  const data = loadUsers(path);
  const hash = await hashPassword(password);

  const idx = data.users.findIndex((u) => u.username === args.username);
  if (idx === -1) {
    if (!args.promote) {
      die(`user '${args.username}' not found. Pass --promote to create as global admin.`);
    }
    data.users.push({
      username: args.username,
      key: generateApiKey(),
      password_hash: hash,
      global_admin: true,
      domains: {},
      created_at: new Date().toISOString(),
      enabled: true,
    });
    console.log(`reset-admin: created new global-admin user '${args.username}'`);
  } else {
    data.users[idx].password_hash = hash;
    data.users[idx].enabled = true;
    if (args.promote) data.users[idx].global_admin = true;
    console.log(`reset-admin: updated user '${args.username}' (promote=${args.promote})`);
  }

  atomicWrite(path, data);
  console.log(`reset-admin: wrote ${path}`);
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    console.error(`reset-admin: ${(e as Error).message}`);
    Deno.exit(1);
  }
}
```

- [ ] **Step 4: Make the script discoverable**

Run: `ls server/scripts/reset-admin.ts`
Expected: file listed.

- [ ] **Step 5: Typecheck the script standalone**

Run: `$HOME/.deno/bin/deno check server/scripts/reset-admin.ts`
Expected: no errors.

- [ ] **Step 6: Run the e2e**

Run: `rm -f "$USERS_FILE" 2>/dev/null; cd /mnt/c/projects/OB2 && bash tests/e2e.sh 2>&1 | tail -30`
Expected: 12.12 (both assertions) PASS.

- [ ] **Step 7: Commit**

```bash
git add server/scripts/reset-admin.ts tests/e2e.sh
git commit -m "$(cat <<'EOF'
Add reset-admin.ts break-glass script

Standalone Deno script that creates or resets a global-admin user by
directly editing users.json. Runs without the server up, works via
docker exec, reuses auth/passwords.ts so argon2id params stay in
sync. E2E verifies a promoted user can log in.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Documentation updates

**Files:**
- Modify: `docs/user-guide.md`

- [ ] **Step 1: Update the "Making `_admin` unreachable" section**

Open `docs/user-guide.md`. Find the section starting with `### "How do I make ` + "`" + `_admin` + "`" + ` unreachable?"` (around line 281) and replace it entirely through the end of its content (the numbered list of two options) with:

```markdown
### "How do I make `_admin` unreachable?"

It's automatic. As soon as you create (or promote) a real global admin,
the brain-key stops authenticating *everywhere*:

- Dashboard `POST /auth/login` as `_admin` → 403.
- `Authorization: Bearer <OB2_BRAIN_KEY>` against `/admin/*` → 401.
- `x-brain-key: <OB2_BRAIN_KEY>` against MCP → 401.

Live `_admin` browser sessions are evicted the moment a real global
admin is provisioned, so there's no "still logged in" loophole.

The gate is reversible: if every enabled non-`_admin` global admin is
later removed or disabled (directly in `users.json`), the brain-key
auto-reopens so you can re-bootstrap.

### "I locked myself out — how do I get back in?"

If **another global admin exists**, they can reset your password via
the Users tab (`POST /admin/users/<you>/password`).

If you're the **sole global admin** and can't sign in (lost password,
etc.), shell into the container and run the break-glass script:

```bash
docker exec -it ob2 \
  /app/.deno/bin/deno run --allow-read --allow-write \
  /app/server/scripts/reset-admin.ts <your-username> \
  --password '<new-password>' --promote
```

The script writes `users.json` directly — no server restart needed
(the server hot-reloads on file change).
```

- [ ] **Step 2: Add a paragraph about the raw editor**

Find the Users tab section (grep for `Users tab` or `#### Users`) and append a new sub-heading:

```markdown
#### Advanced: editing `users.json` directly

The Users tab has a collapsible section ("Advanced: edit `users.json`
directly") that exposes the file verbatim in a textarea. Reload pulls
the current content and mtime; Save rejects with 409 if someone else
edited the file in between. The zero-global-admin rail applies: you
can't save a file that would leave no one in charge.

Use this for bulk changes or when the typed UI doesn't expose what
you need. Everything you can do here can also be done via the typed
list above — the raw editor is a power-user escape hatch, not a
replacement.
```

- [ ] **Step 3: Commit**

```bash
git add docs/user-guide.md
git commit -m "$(cat <<'EOF'
Update user-guide for closed brain-key + break-glass script

Replaces the "WIP, ask the maintainer" section with the now-shipped
auto-disable behavior. Documents the three paths the brain-key is
now closed on, the reversibility, and the break-glass recovery
workflow. Adds a short paragraph on the raw users.json editor.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Full e2e run and refresh `docs/test-results.md`

**Files:**
- Modify: `docs/test-results.md`

- [ ] **Step 1: Clean-slate run**

Run: `rm -f "$USERS_FILE" 2>/dev/null; cd /mnt/c/projects/OB2 && bash tests/e2e.sh 2>&1 | tee /tmp/e2e-final.log | tail -40`
Expected: summary line showing all new assertions PASS, zero FAIL. Specifically: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7 (two asserts), 12.8, 12.9, 12.10, 12.11 (two asserts), 12.12 (two asserts).

Count: 14 new assertions. Prior 22/22 → now 36/36.

- [ ] **Step 2: Update `docs/test-results.md`**

Open the existing file. Find the summary line (currently `22/22 PASS`). Update to reflect the new count and add a new "Suite 3: Bootstrap close-down" section listing the 14 new assertions with one-line outcomes each. Copy relevant lines from `/tmp/e2e-final.log` for authenticity.

Keep the existing Suite 1 and Suite 2 sections unchanged.

- [ ] **Step 3: Commit**

```bash
git add docs/test-results.md
git commit -m "$(cat <<'EOF'
Refresh test-results: 36/36 PASS with bootstrap close-down suite

Adds Suite 3 (Bootstrap close-down) documenting the 14 new e2e
assertions that cover the brain-key gate on all three auth paths,
the zero-admin safety rail, raw users.json editor edge cases, and
the break-glass script.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review notes

**Spec coverage:**
- §1 auth gates: Tasks 2 (login), 3 (Bearer/MCP), 4 (status + hint), 5 (session revoke) — all covered.
- §2 zero-admin rail on PATCH + DELETE: Task 6.
- §2 zero-admin rail on raw save: inside Task 7 (`saveRawUsersFile` calls `_wouldLeaveZeroAdmins`).
- §3 raw editor: Tasks 7 (backend) + 8 (UI).
- §4 shell script: Task 9.
- §5 docs: Task 10.
- §6 tests: assertions are spread across Tasks 2, 3, 4, 6, 7, 9; final count refreshed in Task 11.

**Type consistency:**
- `hasRealGlobalAdmin` defined in Task 1, used in Tasks 2, 3, 4.
- `_wouldLeaveZeroAdmins` (private helper on `UserRecord[]`) used in Tasks 6 and 7.
- `ZeroAdminError` defined in Task 6, re-thrown in Task 7 (raw-save path), imported in admin.ts in both.
- `RawMtimeConflictError` defined in Task 7 and only used there.
- Shell script (Task 9) imports `hashPassword` and `validatePasswordStrength` from `../auth/passwords.ts` — both already exported there (verified).

**Known caveats:**
- Task 6's test 12.5/12.6 require a non-brain-key admin credential. We use `$BOB_KEY` after promoting bob in 12.1. If the promotion fails, subsequent tests will cascade-fail in an obvious way (pointing at the real regression).
- UI tasks (4 step 6, 8 step 4) can't be asserted automatically. The endpoints they wrap are fully tested; manual UI verification is explicitly called out.
