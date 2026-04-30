// Dashboard JS — extracted from inline <script> blocks so CSP can forbid
// 'unsafe-inline' on script-src.
//
// Event wiring uses event delegation: markup declares intent via
// data-action="..." (+ other data-* payload attributes) and a single top-level
// click/change/toggle listener dispatches to the right handler. This lets us
// keep every user-data interpolation text-escaped (no more onclick="fn('${x}')"
// booby traps) while also eliminating the need for 'unsafe-inline' in CSP.

// ──────────────────────────────────────────────────────────────
// Escape helpers — call these on every server-data interpolation inside
// innerHTML template literals. escapeHtml for text nodes, escapeAttr for
// values going into attributes. (Both do the same thing: HTML entity encode.)
// ──────────────────────────────────────────────────────────────
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttr(s) { return escapeHtml(s); }

// ──────────────────────────────────────────────────────────────
// Boot + auth (session-cookie based; API keys are machine-only)
// ──────────────────────────────────────────────────────────────
const BASE = window.location.origin;
let WHOAMI = null;           // {username, global_admin, domains}
let USING_BOOTSTRAP = false; // true when logged in via _admin brain-key

// Tabs that require global_admin — hidden for regular users
const ADMIN_ONLY_TABS = new Set(['users', 'services', 'llms', 'config', 'processes']);

// Cache of user records keyed by username; populated when the users table
// renders so the "Edit" button can look the record up without having to
// embed JSON.stringify(user) in a data attribute.
const USER_CACHE = new Map();

function showLogin(errMsg) {
  document.getElementById('login-screen').classList.add('show');
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

function hideLogin() {
  document.getElementById('login-screen').classList.remove('show');
  document.getElementById('app').classList.add('show');
}

async function attemptLogin() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  if (!username || !password) {
    document.getElementById('login-error').textContent = 'Username and password required';
    return;
  }
  try {
    const r = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const body = await r.json().catch(() => ({}));
    if (r.status === 401) {
      document.getElementById('login-error').textContent = body.error || 'Invalid credentials';
      return;
    }
    if (!r.ok) {
      document.getElementById('login-error').textContent = body.error || `HTTP ${r.status}`;
      return;
    }
    USING_BOOTSTRAP = !!body.bootstrap;
    document.getElementById('login-password').value = '';
    hideLogin();
    // Re-fetch via /auth/me so WHOAMI carries every field init() cares
    // about (email, chat_enabled, ...), not just the subset the login
    // response happens to include. Falls back to the login body if /me
    // can't be reached for any reason.
    try {
      const me = await fetch(`${BASE}/auth/me`, { credentials: 'include' });
      WHOAMI = me.ok ? await me.json() : {
        username: body.username,
        global_admin: body.global_admin,
        domains: body.domains || {},
      };
    } catch {
      WHOAMI = {
        username: body.username,
        global_admin: body.global_admin,
        domains: body.domains || {},
      };
    }
    await init();
  } catch (e) {
    document.getElementById('login-error').textContent = `Server unreachable: ${e.message}`;
  }
}

function showForgotPasswordModal() {
  document.getElementById('forgot-email').value = '';
  document.getElementById('forgot-status').textContent = '';
  document.getElementById('forgot-modal').style.display = 'flex';
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

async function maybeShowReset() {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('token');
  if (!token) return false;
  // Hide other screens
  const loginEl = document.getElementById('login-screen');
  const appEl = document.getElementById('app');
  if (loginEl) loginEl.classList.remove('show');
  if (appEl) appEl.classList.remove('show');
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

async function signOut() {
  try { await fetch(`${BASE}/auth/logout`, { method: 'POST', credentials: 'include' }); }
  catch { /* best-effort */ }
  WHOAMI = null;
  USING_BOOTSTRAP = false;
  // Reload to reset all in-page state cleanly
  window.location.reload();
}
window.signOut = signOut;

for (const id of ['login-username', 'login-password']) {
  document.getElementById(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') attemptLogin();
  });
}

// ──────────────────────────────────────────────────────────────
// HTTP helpers (cookie-authenticated)
// ──────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  const r = await fetch(`${BASE}${path}`, { credentials: 'include', ...opts, headers });
  if (r.status === 401) {
    WHOAMI = null;
    showLogin('Session expired — please sign in again');
    throw new Error('not authenticated');
  }
  if (!r.ok) {
    const e = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(e.error || r.statusText);
  }
  return await r.json();
}

function toast(msg, kind = 'error') {
  const id = kind === 'error' ? 'error-toast' : 'success-toast';
  const el = document.getElementById(id);
  el.textContent = msg;
  el.style.display = 'block';
  setTimeout(() => { el.style.display = 'none'; }, 5000);
}
function showError(e) { toast(String(e.message || e), 'error'); }
function showSuccess(s) { toast(s, 'success'); }

function badge(text, color) {
  return `<span class="badge badge-${escapeAttr(color)}">${escapeHtml(text)}</span>`;
}

function openModal(html) {
  document.getElementById('modal-content').innerHTML = html;
  document.getElementById('modal-bg').classList.add('show');
}
function closeModal() { document.getElementById('modal-bg').classList.remove('show'); }

// ──────────────────────────────────────────────────────────────
// Tab switcher (hash-routed)
// ──────────────────────────────────────────────────────────────
const TABS = ['overview', 'domains', 'users', 'services', 'llms', 'graph', 'config', 'processes', 'profile'];
const LOADERS = {};

function switchTab(name) {
  if (!TABS.includes(name)) name = 'overview';
  for (const t of TABS) {
    document.getElementById(`tab-${t}`).classList.toggle('active', t === name);
  }
  for (const a of document.querySelectorAll('#nav a')) {
    a.classList.toggle('active', a.dataset.tab === name);
  }
  window.location.hash = name;
  if (LOADERS[name]) LOADERS[name]();
  // LLM badge stays fresh as the operator navigates — model can change between
  // tabs (especially when they hit Load on the LLMs tab).
  if (name === 'llms' || name === 'config') refreshLlmBadge();
}

document.querySelectorAll('#nav a').forEach(a => {
  a.addEventListener('click', () => switchTab(a.dataset.tab));
});

window.addEventListener('hashchange', () => switchTab(window.location.hash.slice(1)));

// ──────────────────────────────────────────────────────────────
// LLM provider badge in the header
// ──────────────────────────────────────────────────────────────
async function refreshLlmBadge() {
  try {
    const j = await api('/admin/llm/active');
    const badge = document.getElementById('llm-badge');
    document.getElementById('llm-badge-provider').textContent = j.provider || '?';
    document.getElementById('llm-badge-model').textContent = j.model ? `(${j.model})` : '';
    badge.style.display = '';
  } catch { /* leave badge hidden — common case when /admin/llm/active errors during sign-in */ }
}

document.getElementById('llm-badge').addEventListener('click', () => switchTab('config'));

// ──────────────────────────────────────────────────────────────
// OVERVIEW
// ──────────────────────────────────────────────────────────────
LOADERS.overview = async () => {
  try {
    const isAdmin = !!WHOAMI?.global_admin;
    const [health, stats, metrics] = await Promise.all([
      api('/health').catch(() => null),
      api('/admin/domains').catch(() => null),
      // /admin/metrics is system-level; only fetch for admins so non-admins
      // don't see global pending-sync / lifetime-embeddings counters either.
      isAdmin ? api('/admin/metrics').catch(() => null) : Promise.resolve(null),
    ]);

    // Scope the visible counts to domains the caller can actually read.
    // /admin/domains decorates each row with effective_permission (null when
    // the user has no access). Ignoring the null rows turns this into a
    // per-account dashboard rather than a system-wide one.
    const visibleDomains = (stats?.domains || []).filter((d) => d.effective_permission);
    const totalDocs = visibleDomains.reduce((s, d) => s + (d.doc_count || 0), 0);
    const domainCount = visibleDomains.length;
    const pending = metrics?.sync?.pending_docs ?? '—';
    const batchItems = metrics?.batcher?.total_items ?? 0;

    const adminCards = isAdmin ? `
      <div class="card"><h3>Pending sync</h3><div class="stat">${pending}</div></div>
      <div class="card"><h3>Embeddings (lifetime)</h3><div class="stat">${batchItems.toLocaleString()}</div></div>
    ` : '';

    const domainsLabel = isAdmin ? 'Domains' : 'Your domains';
    const docsLabel = isAdmin ? 'Total docs' : 'Your docs';

    document.getElementById('overview-grid').innerHTML = `
      <div class="card"><h3>Server</h3><div class="stat">${health?.server ? badge('UP', 'green') : badge('DOWN', 'red')}</div></div>
      <div class="card"><h3>Sidecar</h3><div class="stat">${health?.sidecar ? badge('UP', 'green') : badge('DOWN', 'red')}</div></div>
      <div class="card"><h3>${domainsLabel}</h3><div class="stat">${domainCount}</div></div>
      <div class="card"><h3>${docsLabel}</h3><div class="stat">${totalDocs.toLocaleString()}</div></div>
      ${adminCards}
    `;

    // Backend section (heading + card) is admin-only — pgvector reachability
    // and last-sync details are system-level operational data.
    const backendSection = document.getElementById('backend-section');
    const backendCard = document.getElementById('backend-card');
    if (isAdmin) {
      backendSection.style.display = '';
      backendCard.innerHTML = `
        <h3>Backend: <span class="mono">${escapeHtml(health?.backend || '—')}</span></h3>
        ${metrics?.sync?.pgvector_reachable !== undefined ? `<div>pgvector: ${metrics.sync.pgvector_reachable ? badge('reachable', 'green') : badge('unreachable', 'red')}</div>` : ''}
        ${metrics?.sync?.last_sync_at ? `<div class="stat-sub">Last sync: ${escapeHtml(metrics.sync.last_sync_at)} (${metrics.sync.last_sync_docs} docs in ${metrics.sync.last_sync_ms}ms)</div>` : ''}
      `;
    } else {
      backendSection.style.display = 'none';
    }
  } catch (e) { showError(e); }
};

// ──────────────────────────────────────────────────────────────
// DOMAINS
// ──────────────────────────────────────────────────────────────
LOADERS.domains = async () => {
  try {
    const d = await api('/admin/domains');
    const domains = d.domains || [];
    // Whether the caller can create domains. We expose +Create only to global
    // admins, identified by every entry having effective_permission === "admin".
    // (Empty domain list falls through to the empty-state branch below.)
    const isAdmin = domains.length > 0 && domains.every((e) => e.effective_permission === 'admin');

    const headerHtml = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem">
      <span style="color:var(--muted);font-size:0.85rem">${domains.length} domain${domains.length !== 1 ? 's' : ''}</span>
      ${isAdmin ? `<div style="display:flex;gap:0.5rem">
        <button class="small secondary" data-action="open-import-domain">Import Domain…</button>
        <button class="small" data-action="open-create-domain">+ Create Domain</button>
      </div>` : ''}
    </div>`;

    if (!domains.length) {
      document.getElementById('domains-container').innerHTML =
        headerHtml + '<div class="card" style="color:var(--muted)">No domains yet. Click <strong>+ Create Domain</strong> or use <code>capture_knowledge</code>.</div>';
      return;
    }

    let html = headerHtml + '<table><tr><th>Domain</th><th>Description</th><th>Docs</th><th>Actions</th></tr>';
    for (const dom of domains) {
      const perm = dom.effective_permission; // "admin" | "write" | "read" | null
      const desc = dom.description
        ? `<span style="color:var(--muted);font-size:0.85rem">${escapeHtml(dom.description)}</span>`
        : `<span style="color:var(--muted);font-size:0.78rem;font-style:italic">no description</span>`;
      const rowStyle = perm === null ? ' style="opacity:0.5"' : '';
      const action = perm === null
        ? `<span class="small" style="color:var(--muted);font-size:0.78rem;padding:2px 6px;border:1px solid var(--border);border-radius:3px">No access</span>`
        : `<button class="small secondary"
            data-action="open-manage-domain"
            data-domain="${escapeAttr(dom.domain)}"
            data-doc-count="${dom.doc_count}"
            data-description="${escapeAttr(dom.description || '')}"
            data-effective-permission="${escapeAttr(perm)}">Manage</button>`;
      html += `<tr${rowStyle}>
        <td class="mono">@${escapeHtml(dom.domain)}</td>
        <td>${desc}</td>
        <td>${dom.doc_count}</td>
        <td>${action}</td>
      </tr>`;
    }
    html += '</table>';
    document.getElementById('domains-container').innerHTML = html;
  } catch (e) { showError(e); }
};

function openCreateDomainModal() {
  openModal(`
    <h3>Create Domain</h3>
    <div style="margin-bottom:0.5rem">
      <label style="font-size:0.85rem;color:var(--muted);display:block;margin-bottom:0.3rem">Domain name</label>
      <div style="display:flex;align-items:center;gap:0.25rem">
        <span style="color:var(--muted);font-family:'JetBrains Mono',ui-monospace,monospace">@</span>
        <input id="create-domain-name" type="text" placeholder="e.g. infra, security, hr"
               autocomplete="off" autocapitalize="none" spellcheck="false" style="flex:1">
      </div>
      <div id="create-domain-name-error" style="color:var(--red);font-size:0.8rem;margin-top:0.2rem;display:none"></div>
      <div style="color:var(--muted);font-size:0.75rem;margin-top:0.2rem">lowercase letters, numbers, and hyphens only</div>
    </div>
    <div style="margin-bottom:0.75rem">
      <label style="font-size:0.85rem;color:var(--muted);display:block;margin-bottom:0.3rem">Description <span style="color:var(--muted)">(optional)</span></label>
      <input id="create-domain-desc" type="text" placeholder="What is this domain for?" style="width:100%">
    </div>
    <div class="modal-actions">
      <button class="secondary" data-action="close-modal">Cancel</button>
      <button data-action="submit-create-domain">Create</button>
    </div>
  `);
  document.getElementById('create-domain-name').focus();
}

async function submitCreateDomain() {
  const name = document.getElementById('create-domain-name').value.trim().toLowerCase();
  const desc = document.getElementById('create-domain-desc').value.trim();
  const errEl = document.getElementById('create-domain-name-error');
  errEl.style.display = 'none';

  if (!name) {
    errEl.textContent = 'Domain name is required.';
    errEl.style.display = 'block';
    return;
  }
  if (!/^[a-z0-9-]+$/.test(name) || name.length > 64) {
    errEl.textContent = 'Use lowercase letters, numbers, and hyphens only (max 64 chars).';
    errEl.style.display = 'block';
    return;
  }
  try {
    await api('/admin/domains', { method: 'POST', body: JSON.stringify({ domain: name, description: desc }) });
    closeModal();
    showSuccess(`@${name} created`);
    LOADERS.domains();
  } catch (e) {
    errEl.textContent = e.message || 'Failed to create domain.';
    errEl.style.display = 'block';
  }
}

// ── Import / Export domain ──────────────────────────────────────

function openImportDomainModal() {
  openModal(`
    <h3>Import Domain</h3>
    <p style="color:var(--muted);font-size:0.85rem;margin-top:0;margin-bottom:0.75rem">
      Restore a previously exported <code>.ob2bundle</code>. The target domain must not already exist.
    </p>
    <div style="margin-bottom:0.5rem">
      <label style="font-size:0.85rem;color:var(--muted);display:block;margin-bottom:0.3rem">Bundle file</label>
      <input id="import-domain-file" type="file" accept=".ob2bundle,.tar.gz,.tgz,application/octet-stream,application/gzip">
    </div>
    <div style="margin-bottom:0.75rem">
      <label style="font-size:0.85rem;color:var(--muted);display:block;margin-bottom:0.3rem">Target domain <span style="color:var(--muted)">(optional — defaults to original name)</span></label>
      <div style="display:flex;align-items:center;gap:0.25rem">
        <span style="color:var(--muted);font-family:'JetBrains Mono',ui-monospace,monospace">@</span>
        <input id="import-domain-target" type="text" placeholder="leave blank to keep original"
               autocomplete="off" autocapitalize="none" spellcheck="false" style="flex:1">
      </div>
    </div>
    <div id="import-domain-status" style="font-size:0.85rem;min-height:1rem;margin-bottom:0.5rem"></div>
    <div class="modal-actions">
      <button class="secondary" data-action="close-modal">Cancel</button>
      <button data-action="submit-import-domain">Import</button>
    </div>
  `);
}

async function submitImportDomain() {
  const fileInput = document.getElementById('import-domain-file');
  const targetInput = document.getElementById('import-domain-target');
  const statusEl = document.getElementById('import-domain-status');
  const file = fileInput.files?.[0];
  if (!file) {
    statusEl.textContent = 'Choose a bundle file first.';
    statusEl.style.color = 'var(--red)';
    return;
  }
  const target = targetInput.value.trim().toLowerCase();
  if (target && (!/^[a-z0-9-]+$/.test(target) || target.length > 64)) {
    statusEl.textContent = 'Target domain must be lowercase letters, numbers, hyphens (≤64).';
    statusEl.style.color = 'var(--red)';
    return;
  }
  const fd = new FormData();
  fd.append('bundle', file);
  if (target) fd.append('target_domain', target);

  statusEl.textContent = `Uploading ${file.name} (${(file.size/1024/1024).toFixed(1)} MB)…`;
  statusEl.style.color = 'var(--muted)';
  try {
    const r = await fetch(`${BASE}/admin/domains/import`, {
      method: 'POST',
      credentials: 'include',
      body: fd,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      const msg = data.detail
        ? `${data.error || 'import failed'} — ${data.detail}`
        : (data.error || 'import failed');
      statusEl.textContent = msg;
      statusEl.style.color = 'var(--red)';
      return;
    }
    closeModal();
    const lbl = data.source_domain && data.source_domain !== data.domain
      ? `@${data.domain} (from @${data.source_domain})`
      : `@${data.domain}`;
    showSuccess(`Imported ${lbl}: ${data.doc_count} doc(s), ${data.alias_count} alias(es), ${data.file_count} file(s)`);
    LOADERS.domains();
  } catch (e) {
    statusEl.textContent = e.message || 'Import failed.';
    statusEl.style.color = 'var(--red)';
  }
}

function exportCurrentDomain() {
  const { domain } = _manageDomain;
  // The browser reuses the dashboard's session cookie automatically; the
  // server responds with Content-Disposition: attachment so this triggers
  // a download rather than navigation.
  window.location.href = `${BASE}/admin/domains/${encodeURIComponent(domain)}/export`;
}

// ──────────────────────────────────────────────────────────────
// MANAGE DOMAIN MODAL
// ──────────────────────────────────────────────────────────────
let _manageDomain = null; // { domain, docCount, description }

async function openManageDomain(domain, docCount, description, effectivePermission) {
  // effectivePermission: "admin" | "write" | "read"  (null is filtered upstream)
  const perm = effectivePermission || 'admin';
  _manageDomain = { domain, docCount: Number(docCount), description, perm };
  // Tabs available per permission level:
  //   admin → all four (Docs, Aliases, Users, Settings)
  //   write → Docs, Aliases (read-only on aliases)
  //   read  → Docs (read-only), Aliases (read-only)
  const tabs = perm === 'admin'
    ? ['docs', 'aliases', 'users', 'settings']
    : ['docs', 'aliases'];
  const tabBtns = tabs.map((t) => {
    const label = t.charAt(0).toUpperCase() + t.slice(1);
    return `<button class="manage-tab-btn" data-action="switch-manage-tab" data-tab="${t}">${label}</button>`;
  }).join('');
  openModal(`
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.75rem">
      <div>
        <span style="font-weight:bold;font-family:'JetBrains Mono',ui-monospace,monospace">@${escapeHtml(domain)}</span>
        <span style="color:var(--muted);font-size:0.85rem;margin-left:0.5rem" id="manage-domain-doc-count">· ${Number(docCount)} doc${Number(docCount) !== 1 ? 's' : ''}</span>
        ${description ? `<span style="color:var(--muted);font-size:0.85rem"> · ${escapeHtml(description)}</span>` : ''}
        ${perm !== 'admin' ? `<span style="color:var(--muted);font-size:0.78rem;margin-left:0.5rem;border:1px solid var(--border);border-radius:3px;padding:1px 5px">${escapeHtml(perm)}-only</span>` : ''}
      </div>
    </div>
    <div style="display:flex;gap:0;border-bottom:1px solid var(--border);margin-bottom:0.75rem" id="manage-tabs">
      ${tabBtns}
    </div>
    <div id="manage-tab-content" style="min-height:120px"></div>
    <div class="modal-actions">
      <button class="secondary" data-action="close-modal">Close</button>
    </div>
  `);

  // Inject tab button styles inline (avoids needing CSS changes)
  for (const btn of document.querySelectorAll('.manage-tab-btn')) {
    Object.assign(btn.style, {
      padding: '6px 16px', border: 'none', background: 'none',
      color: 'var(--muted)', borderBottom: '2px solid transparent',
      cursor: 'pointer', fontSize: '0.85rem',
    });
  }
  switchManageTab('docs');
}

function switchManageTab(tab) {
  for (const btn of document.querySelectorAll('#manage-tabs .manage-tab-btn')) {
    const active = btn.dataset.tab === tab;
    btn.style.color = active ? 'var(--fg)' : 'var(--muted)';
    btn.style.borderBottom = active ? '2px solid var(--accent)' : '2px solid transparent';
  }
  const content = document.getElementById('manage-tab-content');
  if (!content) return;
  content.innerHTML = '<div style="color:var(--muted);font-size:0.85rem">Loading…</div>';
  if (tab === 'docs') loadManageDocs();
  else if (tab === 'aliases') loadManageAliases();
  else if (tab === 'users') loadManageUsers();
  else if (tab === 'settings') renderManageSettings();
}

async function loadManageDocs() {
  const { domain, perm } = _manageDomain;
  const canDeleteDocs = perm === 'admin'; // doc deletion requires admin on the domain
  const canImport = perm === 'admin' || perm === 'write';
  const content = document.getElementById('manage-tab-content');
  try {
    const d = await api(`/admin/domains/${encodeURIComponent(domain)}/docs?limit=200`);
    const docs = d.docs || [];

    let importHtml = '';
    if (canImport) {
      importHtml = `
        <div class="import-zone" id="import-zone-${escapeAttr(domain)}">
          <div>Drop a file here, click to browse, or paste a URL below.</div>
          <div class="formats">PDF · DOCX · PPTX · XLSX · MD · HTML · CSV · PNG · JPG · MP3 · WAV · ZIP · HTTP · YouTube</div>
          <input id="import-file-${escapeAttr(domain)}" type="file" style="display:none">
        </div>
        <div class="import-row">
          <input id="import-url-${escapeAttr(domain)}" type="url" placeholder="paste URL…" style="flex:1">
          <button class="small" data-action="import-url" data-domain="${escapeAttr(domain)}">Import URL</button>
        </div>
        <div class="import-recent" id="import-recent-${escapeAttr(domain)}"></div>
      `;
    }

    if (!docs.length) {
      content.innerHTML = importHtml + `<div style="color:var(--muted);font-size:0.85rem">No documents in this domain.</div>`;
    } else {
      let html = `<input type="text" id="manage-doc-search" placeholder="Search documents…"
                    style="width:100%;box-sizing:border-box;margin-bottom:0.5rem">`;
      html += `<div id="manage-docs-list"><table style="width:100%">
        <tr><th style="text-align:left;padding:4px 6px">Document</th>${canDeleteDocs ? '<th></th>' : ''}</tr>`;
      for (const doc of docs) {
        const preview = doc.text.slice(0, 120) + (doc.text.length > 120 ? '…' : '');
        const meta = doc.metadata || {};
        const fileId = meta._ob2_import_file_id;
        const filename = meta._ob2_import_filename || meta.source || '';
        const sourceLine = fileId
          ? `<a href="${BASE}/admin/domains/${encodeURIComponent(domain)}/imports/${encodeURIComponent(fileId)}"
                style="color:var(--accent); font-size:0.78rem"
                title="Download original file">↓ ${escapeHtml(filename)}</a>`
          : (filename
              ? `<span style="color:var(--muted); font-size:0.78rem">${escapeHtml(filename)}</span>`
              : '');
        const uploaderLine = meta._ob2_uploaded_by
          ? `<span style="color:var(--muted); font-size:0.78rem">↑ ${escapeHtml(meta._ob2_uploaded_by)}</span>`
          : '';
        const actionCell = canDeleteDocs
          ? `<td style="padding:4px 6px;white-space:nowrap">
               <button class="small danger" data-action="confirm-delete-domain-doc"
                 data-doc-id="${escapeAttr(doc.doc_id)}">Delete</button>
             </td>`
          : '';
        html += `<tr data-doc-id="${escapeAttr(doc.doc_id)}">
          <td style="padding:4px 6px;max-width:360px;word-break:break-word">
            <div>${escapeHtml(preview)}</div>
            ${sourceLine ? `<div style="margin-top:2px">${sourceLine}</div>` : ''}
            ${uploaderLine ? `<div style="margin-top:2px">${uploaderLine}</div>` : ''}
          </td>
          ${actionCell}
        </tr>`;
      }
      html += `</table></div>`;
      content.innerHTML = importHtml + html;

      document.getElementById('manage-doc-search').addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase();
        for (const row of document.querySelectorAll('#manage-docs-list tr[data-doc-id]')) {
          const text = row.querySelector('td')?.textContent?.toLowerCase() || '';
          row.style.display = text.includes(q) ? '' : 'none';
        }
      });
    }

    if (canImport) {
      const zone = document.getElementById(`import-zone-${domain}`);
      const fileInput = document.getElementById(`import-file-${domain}`);
      if (zone && fileInput) {
        zone.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => {
          const f = e.target.files?.[0];
          if (f) uploadImportFile(domain, f);
        });
        zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
        zone.addEventListener('drop', (e) => {
          e.preventDefault();
          zone.classList.remove('drag-over');
          const f = e.dataTransfer.files?.[0];
          if (f) uploadImportFile(domain, f);
        });
      }
    }
  } catch (e) {
    content.innerHTML = `<div style="color:var(--red)">${escapeHtml(String(e.message || e))}</div>`;
  }
}

function confirmDeleteDomainDoc(docId) {
  const row = document.querySelector(`#manage-docs-list tr[data-doc-id="${CSS.escape(docId)}"]`);
  if (!row) return;
  row.style.background = 'rgba(239,68,68,0.08)';
  row.querySelector('td:last-child').innerHTML = `
    <button class="small secondary" data-action="cancel-delete-domain-doc"
      data-doc-id="${escapeAttr(docId)}">Cancel</button>
    <button class="small danger" data-action="execute-delete-domain-doc"
      data-doc-id="${escapeAttr(docId)}">Confirm</button>`;
}

function cancelDeleteDomainDoc(docId) {
  const row = document.querySelector(`#manage-docs-list tr[data-doc-id="${CSS.escape(docId)}"]`);
  if (!row) return;
  row.style.background = '';
  row.querySelector('td:last-child').innerHTML =
    `<button class="small danger" data-action="confirm-delete-domain-doc"
      data-doc-id="${escapeAttr(docId)}">Delete</button>`;
}

async function executeDeleteDomainDoc(docId) {
  const { domain } = _manageDomain;
  try {
    await api(`/admin/domains/${encodeURIComponent(domain)}/docs/${encodeURIComponent(docId)}`,
      { method: 'DELETE' });
    const row = document.querySelector(`#manage-docs-list tr[data-doc-id="${CSS.escape(docId)}"]`);
    if (row) row.remove();
    _manageDomain.docCount = Math.max(0, _manageDomain.docCount - 1);
    const countEl = document.getElementById('manage-domain-doc-count');
    if (countEl) {
      countEl.textContent = `· ${_manageDomain.docCount} doc${_manageDomain.docCount !== 1 ? 's' : ''}`;
    }
    LOADERS.domains();
  } catch (e) { showError(e); }
}

// ── Aliases tab ──

async function loadManageAliases() {
  const { domain, perm } = _manageDomain;
  const canEditAliases = perm === 'admin'; // alias create/upsert requires admin
  const content = document.getElementById('manage-tab-content');
  try {
    const d = await api(`/admin/domains/${encodeURIComponent(domain)}/aliases`);
    const aliases = d.aliases || [];

    let html = canEditAliases
      ? `<div class="form-row" style="margin-bottom:0.75rem">
          <input id="manage-alias-name" placeholder="Alias" style="width:120px" autocomplete="off">
          <input id="manage-alias-canonical" placeholder="Canonical" style="width:160px" autocomplete="off">
          <button class="small" data-action="add-manage-alias">Add alias</button>
        </div>`
      : '';

    if (!aliases.length) {
      html += `<div id="manage-aliases-list" style="color:var(--muted);font-size:0.85rem">No aliases for @${escapeHtml(domain)}.</div>`;
    } else {
      html += `<div id="manage-aliases-list"><table style="width:100%">
        <tr><th style="text-align:left;padding:4px 6px">Alias</th><th style="text-align:left;padding:4px 6px">Canonical</th></tr>`;
      for (const a of aliases) {
        html += `<tr>
          <td class="mono" style="padding:4px 6px">${escapeHtml(a.alias)}</td>
          <td class="mono" style="padding:4px 6px">${escapeHtml(a.canonical)}</td>
        </tr>`;
      }
      html += `</table></div>`;
    }
    content.innerHTML = html;
  } catch (e) {
    content.innerHTML = `<div style="color:var(--red)">${escapeHtml(String(e.message || e))}</div>`;
  }
}

async function addManageAlias() {
  const { domain } = _manageDomain;
  const alias = document.getElementById('manage-alias-name').value.trim();
  const canonical = document.getElementById('manage-alias-canonical').value.trim();
  if (!alias || !canonical) return showError('fill alias + canonical');
  try {
    await api(`/admin/domains/${encodeURIComponent(domain)}/aliases`, {
      method: 'POST',
      body: JSON.stringify({ alias, canonical }),
    });
    document.getElementById('manage-alias-name').value = '';
    document.getElementById('manage-alias-canonical').value = '';
    showSuccess('alias added');
    loadManageAliases();
  } catch (e) { showError(e); }
}

// ── Users tab ──

async function loadManageUsers() {
  const { domain } = _manageDomain;
  const content = document.getElementById('manage-tab-content');
  try {
    const d = await api('/admin/users');
    const users = d.users || [];
    const relevant = users.filter(u =>
      u.global_admin || (u.domains && Object.prototype.hasOwnProperty.call(u.domains, domain))
    );

    if (!relevant.length) {
      content.innerHTML = `<div style="color:var(--muted);font-size:0.85rem">No users have access to @${escapeHtml(domain)}.</div>`;
      return;
    }

    const permColor = { read: 'muted', write: 'purple', admin: 'yellow' };
    let html = `<table style="width:100%">
      <tr><th style="text-align:left;padding:4px 6px">User</th><th style="text-align:left;padding:4px 6px">Permission</th></tr>`;
    for (const u of relevant) {
      const perm = u.global_admin ? 'global admin' : u.domains[domain];
      const color = u.global_admin ? 'yellow' : (permColor[perm] || 'muted');
      html += `<tr>
        <td class="mono" style="padding:4px 6px">${escapeHtml(u.username)}</td>
        <td style="padding:4px 6px">${badge(perm, color)}</td>
      </tr>`;
    }
    html += `</table>
      <div style="color:var(--muted);font-size:0.78rem;margin-top:0.5rem">
        To change permissions, edit the user from the Users tab.
      </div>`;
    content.innerHTML = html;
  } catch (e) {
    content.innerHTML = `<div style="color:var(--muted);font-size:0.85rem">Could not load users.</div>`;
  }
}

// ── Settings tab ──

function renderManageSettings() {
  const { domain, description } = _manageDomain;
  const content = document.getElementById('manage-tab-content');
  content.innerHTML = `
    <div style="margin-bottom:0.5rem">
      <label style="font-size:0.85rem;color:var(--muted);display:block;margin-bottom:0.3rem">Description</label>
      <div style="display:flex;gap:0.5rem">
        <input id="manage-desc-input" type="text" value="${escapeAttr(description)}"
               placeholder="What is this domain for?" style="flex:1">
        <button class="small" data-action="save-domain-description">Save</button>
      </div>
      <div id="manage-desc-status" style="font-size:0.8rem;margin-top:0.25rem;min-height:1rem"></div>
    </div>
    <hr style="border-color:var(--border);margin:1rem 0">
    <div style="color:var(--muted);font-size:0.85rem;margin-bottom:0.5rem">Backup</div>
    <button class="small secondary" data-action="export-current-domain">Export @${escapeHtml(domain)} as .ob2bundle</button>
    <div style="color:var(--muted);font-size:0.78rem;margin-top:0.3rem">
      Includes all documents (with embeddings), aliases, descriptions, and original uploaded files.
    </div>
    <hr style="border-color:var(--border);margin:1rem 0">
    <div style="color:var(--muted);font-size:0.85rem;margin-bottom:0.5rem">Danger zone</div>
    <button class="small danger" data-action="delete-current-domain">Delete @${escapeHtml(domain)}…</button>
  `;
}

async function saveDomainDescription() {
  const { domain } = _manageDomain;
  const desc = document.getElementById('manage-desc-input').value.trim();
  const status = document.getElementById('manage-desc-status');
  status.textContent = 'Saving…';
  status.style.color = 'var(--muted)';
  try {
    await api(`/admin/domains/${encodeURIComponent(domain)}`, {
      method: 'PATCH',
      body: JSON.stringify({ description: desc }),
    });
    _manageDomain.description = desc;
    status.textContent = '✓ Saved';
    status.style.color = 'var(--green)';
    LOADERS.domains();
  } catch (e) {
    status.textContent = String(e.message || e);
    status.style.color = 'var(--red)';
  }
}

function deleteCurrentDomain() {
  deleteDomain(_manageDomain.domain);
}

async function deleteDomain(domain) {
  openModal(`
    <h3>Delete @${escapeHtml(domain)}?</h3>
    <p>This removes all captured docs, aliases, and source-import history for this domain. Cannot be undone.</p>
    <div class="modal-actions">
      <button class="secondary" data-action="close-modal">Cancel</button>
      <button class="danger" data-action="confirm-delete-domain" data-domain="${escapeAttr(domain)}">Delete domain</button>
    </div>
  `);
}
async function confirmDeleteDomain(domain) {
  closeModal();
  try {
    await api(`/admin/domains/${encodeURIComponent(domain)}`, { method: 'DELETE' });
    showSuccess(`@${domain} deleted`);
    LOADERS.domains();
  } catch (e) { showError(e); }
}

// ──────────────────────────────────────────────────────────────
// USERS
// ──────────────────────────────────────────────────────────────
LOADERS.users = async () => {
  updateInviteRadioAvailability();
  try {
    const d = await api('/admin/users');
    USER_CACHE.clear();
    if (!d.users?.length) {
      document.getElementById('users-container').innerHTML = '<div class="card" style="color:var(--muted)">No users configured (single-key mode).</div>';
      return;
    }
    let html = '<table><tr><th>Username</th><th>Key</th><th>Admin</th><th>Permissions</th><th>Actions</th></tr>';
    const permLevelColor = { read: 'muted', write: 'purple', admin: 'yellow' };
    for (const u of d.users) {
      USER_CACHE.set(u.username, u);
      const doms = u.global_admin
        ? '<span style="color:var(--muted); font-size:0.8rem">all domains</span>'
        : Object.entries(u.domains).map(([d, p]) =>
            `<span class="perm-tag">@${escapeHtml(d)} ${badge(p, permLevelColor[p] || 'muted')}</span>`
          ).join(' ') || '<span style="color:var(--muted)">—</span>';
      const status = u.enabled === false ? badge('revoked', 'red') : '';
      const disabled = u.enabled === false ? 'disabled' : '';
      // Invite button is disabled when the user has no email — no point
      // sending an invite that has nowhere to land. Admin can fix via Edit.
      const inviteDisabled = (!u.email || u.enabled === false) ? 'disabled' : '';
      const inviteTitle = !u.email
        ? 'title="User has no email — set one in Edit first"'
        : '';
      html += `<tr>
        <td class="mono">${escapeHtml(u.username)} ${status}</td>
        <td class="mono">${escapeHtml(u.key)}</td>
        <td>${u.global_admin ? badge('admin', 'yellow') : ''}</td>
        <td>${doms}</td>
        <td>
          <button class="small secondary" data-action="edit-user" data-username="${escapeAttr(u.username)}" ${disabled}>Edit</button>
          <button class="small secondary" data-action="invite-user" data-username="${escapeAttr(u.username)}" ${inviteDisabled} ${inviteTitle}>Invite</button>
          <button class="small secondary" data-action="set-user-password" data-username="${escapeAttr(u.username)}" ${disabled}>Set password</button>
          <button class="small danger" data-action="revoke-user" data-username="${escapeAttr(u.username)}" ${disabled}>Revoke</button>
        </td>
      </tr>`;
    }
    document.getElementById('users-container').innerHTML = html + '</table>';
  } catch (e) { showError(e); }
};

async function createNewUser() {
  const username = document.getElementById('new-username').value.trim();
  const email = document.getElementById('new-user-email').value.trim();
  const global_admin = document.getElementById('new-user-admin').value === 'true';
  const mode = document.querySelector('input[name="new-user-init-mode"]:checked').value;
  const password = document.getElementById('new-user-password').value;
  const status = document.getElementById('new-user-status');
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
      global_admin,
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
      status.textContent = `Created '${username}'.`;
      if (body.invite) showInviteLinkModal(username, body.invite);
    }
    document.getElementById('new-username').value = '';
    document.getElementById('new-user-email').value = '';
    document.getElementById('new-user-password').value = '';
    if (typeof LOADERS !== 'undefined' && typeof LOADERS.users === 'function') LOADERS.users();
  } catch (e) { status.textContent = `Error: ${e.message}`; }
}

async function updateInviteRadioAvailability() {
  try {
    const r = await fetch(`${BASE}/admin/smtp-status`, { credentials: 'include' });
    if (!r.ok) return;
    const { configured } = await r.json();
    const radio = document.getElementById('new-user-invite-radio');
    const hint = document.getElementById('new-user-invite-hint');
    if (!radio || !hint) return;
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

// Cache of known domains used for the permission editor's datalist
let _knownDomains = [];
async function ensureKnownDomains() {
  try {
    const d = await api('/admin/domains');
    _knownDomains = (d.domains || []).map(x => x.domain);
  } catch { _knownDomains = []; }
}

const PERM_DESCRIPTIONS = {
  read:  'Read — search + chat',
  write: 'Write — capture (implies read)',
  admin: 'Admin — delete, aliases (implies write)',
};

function permRowHtml(domain = '', perm = 'read') {
  return `
    <div class="perm-row" style="display:flex; gap:0.5rem; margin-bottom:0.4rem; align-items:center">
      <span style="color:var(--muted); font-family:'JetBrains Mono',ui-monospace,monospace">@</span>
      <input type="text" class="perm-domain" list="domain-suggestions" value="${escapeAttr(domain)}"
             placeholder="domain" style="flex:1; min-width:140px"
             autocomplete="off" autocapitalize="none" spellcheck="false">
      <select class="perm-level" style="flex:1.2; min-width:180px">
        <option value="read" ${perm==='read'?'selected':''}>${escapeHtml(PERM_DESCRIPTIONS.read)}</option>
        <option value="write" ${perm==='write'?'selected':''}>${escapeHtml(PERM_DESCRIPTIONS.write)}</option>
        <option value="admin" ${perm==='admin'?'selected':''}>${escapeHtml(PERM_DESCRIPTIONS.admin)}</option>
      </select>
      <button type="button" class="small danger" data-action="remove-parent">Remove</button>
    </div>`;
}

async function editUser(user) {
  await ensureKnownDomains();
  const doms = user.domains || {};
  const rows = Object.keys(doms).length
    ? Object.entries(doms).map(([d, p]) => permRowHtml(d, p)).join('')
    : permRowHtml('', 'read');
  openModal(`
    <h3>Edit ${escapeHtml(user.username)}</h3>
    <label style="display:flex; align-items:center; gap:0.4rem; margin-bottom:0.75rem">
      <input type="checkbox" id="edit-global-admin" ${user.global_admin?'checked':''}>
      <span>Global admin</span>
      <span style="color:var(--muted); font-size:0.8rem">— full access to everything, no per-domain rules needed</span>
    </label>

    <div id="edit-perms-wrap" ${user.global_admin ? 'style="opacity:0.4; pointer-events:none"' : ''}>
      <div style="font-size:0.85rem; color:var(--muted); margin-bottom:0.4rem">
        Domain permissions — one row per domain.
      </div>
      <datalist id="domain-suggestions">
        ${_knownDomains.map(d => `<option value="${escapeAttr(d)}"></option>`).join('')}
      </datalist>
      <div id="perm-rows">${rows}</div>
      <button type="button" class="small secondary" data-action="add-perm-row" style="margin-top:0.25rem">+ Add permission</button>
    </div>

    <div class="modal-actions" style="justify-content:space-between">
      <button class="small secondary" data-action="invite-user"
        data-username="${escapeAttr(user.username)}"
        ${user.email ? '' : 'disabled title="User has no email — set one above first"'}>Send invite link</button>
      <span style="display:flex; gap:0.4rem">
        <button class="secondary" data-action="close-modal">Cancel</button>
        <button data-action="save-user-edit" data-username="${escapeAttr(user.username)}">Save</button>
      </span>
    </div>
  `);

  // Disable the permissions editor when global admin is ticked on
  document.getElementById('edit-global-admin').addEventListener('change', (e) => {
    const wrap = document.getElementById('edit-perms-wrap');
    wrap.style.opacity = e.target.checked ? '0.4' : '';
    wrap.style.pointerEvents = e.target.checked ? 'none' : '';
  });
}

function addPermRow() {
  document.getElementById('perm-rows').insertAdjacentHTML('beforeend', permRowHtml());
}

async function saveUserEdit(username) {
  const global_admin = document.getElementById('edit-global-admin').checked;
  const domains = {};
  for (const row of document.querySelectorAll('#perm-rows .perm-row')) {
    const domain = row.querySelector('.perm-domain').value.trim().replace(/^@/, '');
    const level = row.querySelector('.perm-level').value;
    if (!domain) continue;
    if (domains[domain]) return showError(`duplicate domain: @${domain}`);
    domains[domain] = level;
  }
  try {
    await api(`/admin/users/${username}`, {
      method: 'PATCH',
      body: JSON.stringify({ global_admin, domains }),
    });
    closeModal();
    showSuccess(`${username} updated`);
    LOADERS.users();
  } catch (e) { showError(e); }
}

async function inviteUser(username) {
  try {
    const r = await fetch(`${BASE}/admin/users/${encodeURIComponent(username)}/invite`, {
      method: 'POST',
      credentials: 'include',
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      showError(body.error || `invite failed: ${r.status}`);
      return;
    }
    showInviteLinkModal(username, body);
  } catch (e) { showError(e); }
}

// `payload` shape: { sent: bool, url: string, expires_at: ISO, send_error?: string }
function showInviteLinkModal(username, payload) {
  const sent = payload.sent === true;
  const sendError = payload.send_error || '';
  let banner;
  if (sent) {
    banner = `<div class="card" style="background:rgba(34,197,94,0.08); border:1px solid rgba(34,197,94,0.3); color:var(--green); margin-bottom:0.75rem">
      Email sent. The link below is your fallback if the email is lost.
    </div>`;
  } else if (sendError === 'smtp_not_configured') {
    banner = `<div class="card" style="background:rgba(245,158,11,0.08); border:1px solid rgba(245,158,11,0.3); margin-bottom:0.75rem">
      SMTP is not configured. Share this link directly.
    </div>`;
  } else {
    banner = `<div class="card" style="background:rgba(245,158,11,0.08); border:1px solid rgba(245,158,11,0.3); margin-bottom:0.75rem">
      Email send failed${sendError ? `: ${escapeHtml(sendError)}` : ''}. Share this link directly.
    </div>`;
  }
  const url = payload.url || '';
  const expiresAt = payload.expires_at ? new Date(payload.expires_at) : null;
  const expiresLine = expiresAt
    ? `<div style="color:var(--muted); font-size:0.78rem; margin-top:0.4rem">Expires ${escapeHtml(expiresAt.toLocaleString())}</div>`
    : '';
  openModal(`
    <h3>Invite link for ${escapeHtml(username)}</h3>
    ${banner}
    <div style="display:flex; gap:0.4rem; align-items:center">
      <input id="invite-link-url" type="text" readonly value="${escapeAttr(url)}"
        style="flex:1; font-family:'JetBrains Mono',ui-monospace,monospace; font-size:0.8rem">
      <button class="small" data-action="copy-invite-link">Copy</button>
    </div>
    ${expiresLine}
    <div class="modal-actions">
      <button data-action="close-modal">Close</button>
    </div>
  `);
}

async function copyInviteLink() {
  const input = document.getElementById('invite-link-url');
  if (!input) return;
  try {
    await navigator.clipboard.writeText(input.value);
    showSuccess('Invite link copied');
  } catch {
    // Fallback: select text so user can copy manually.
    input.select();
    showError('Could not access clipboard — text selected for manual copy');
  }
}

function setUserPassword(username) {
  openModal(`
    <h3>Set password for ${escapeHtml(username)}</h3>
    <p style="color:var(--muted); font-size:0.85rem">
      This replaces any existing password and signs out all of ${escapeHtml(username)}'s current sessions.
      Share the new password securely; the user can change it themselves under Profile.
    </p>
    <div class="form-row">
      <input id="admin-pw-new" type="password" placeholder="New password (min 8 chars)"
             autocomplete="new-password" style="flex:1; min-width:220px">
    </div>
    <div class="form-row">
      <input id="admin-pw-confirm" type="password" placeholder="Confirm new password"
             autocomplete="new-password" style="flex:1; min-width:220px">
    </div>
    <div class="modal-actions">
      <button class="secondary" data-action="close-modal">Cancel</button>
      <button data-action="confirm-set-user-password" data-username="${escapeAttr(username)}">Set password</button>
    </div>
  `);
}
async function confirmSetUserPassword(username) {
  const pw = document.getElementById('admin-pw-new').value;
  const confirm = document.getElementById('admin-pw-confirm').value;
  if (!pw || pw.length < 8) return showError('password must be at least 8 characters');
  if (pw !== confirm) return showError('passwords do not match');
  try {
    await api(`/admin/users/${username}/password`, { method: 'POST', body: JSON.stringify({ password: pw }) });
    closeModal();
    showSuccess(`password set for ${username}`);
  } catch (e) { showError(e); }
}

async function revokeUser(username) {
  openModal(`
    <h3>Revoke ${escapeHtml(username)}?</h3>
    <p>Their API key will stop working immediately. The user record is preserved (soft delete).</p>
    <div class="modal-actions">
      <button class="secondary" data-action="close-modal">Cancel</button>
      <button class="danger" data-action="confirm-revoke-user" data-username="${escapeAttr(username)}">Revoke</button>
    </div>
  `);
}
async function confirmRevokeUser(username) {
  closeModal();
  try {
    await api(`/admin/users/${username}`, { method: 'DELETE' });
    showSuccess(`${username} revoked`);
    LOADERS.users();
  } catch (e) { showError(e); }
}

let rawUsersMtime = null;

async function loadRawUsers() {
  const status = document.getElementById('raw-users-status');
  status.textContent = 'Loading…';
  try {
    const r = await fetch(`${BASE}/admin/users/raw`, { credentials: 'include' });
    if (r.status === 401) {
      showLogin('Session expired — please sign in again.');
      return;
    }
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
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, expected_mtime: rawUsersMtime }),
    });
    if (r.status === 401) {
      showLogin('Session expired — please sign in again.');
      return;
    }
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      status.textContent = `Save failed (${r.status}): ${body.error || 'unknown'}`;
      if (r.status === 409) status.textContent += ' — reload and retry.';
      return;
    }
    rawUsersMtime = body.mtime;
    status.textContent = `Saved (mtime ${rawUsersMtime})`;
    if (typeof LOADERS !== 'undefined' && typeof LOADERS.users === 'function') {
      LOADERS.users();
    }
  } catch (e) {
    status.textContent = `Save error: ${e.message}`;
  }
}

// Wire the "Advanced: edit users.json directly" <details> so opening it
// triggers an initial load. (Previously an inline ontoggle=... attribute.)
document.querySelector('.raw-editor')?.addEventListener('toggle', (e) => {
  if (e.target.open && !rawUsersMtime) loadRawUsers();
});

// ──────────────────────────────────────────────────────────────
// SERVICES
// ──────────────────────────────────────────────────────────────
LOADERS.services = async () => {
  renderOllama({ tested: false });
  renderPgvector({ tested: false });
};

function renderOllama(state) {
  const card = document.getElementById('ollama-card');
  const statusHtml = !state.tested
    ? '<span style="color:var(--muted)">Not tested yet</span>'
    : state.reachable
      ? `${badge('reachable', 'green')} <span class="stat-sub">${state.latency_ms}ms</span>`
      : `${badge('unreachable', 'red')} <span class="stat-sub">${escapeHtml(state.error || '')}</span>`;
  const modelsList = state.models?.length
    ? `<table style="margin-top:0.75rem"><tr><th>Model</th><th>Size</th></tr>${state.models.map(m => `<tr><td class="mono">${escapeHtml(m.name)}</td><td>${(m.size/1e9).toFixed(1)} GB</td></tr>`).join('')}</table>`
    : '';
  card.innerHTML = `
    <div class="form-row">
      <input id="ollama-url" placeholder="http://localhost:11434" style="flex:1; min-width:250px" value="${escapeAttr(state.url || '')}">
      <button data-action="test-ollama">Test connection</button>
    </div>
    <div style="margin-top:0.5rem">${statusHtml}</div>
    ${modelsList}
  `;
}

async function testOllama() {
  const url = document.getElementById('ollama-url').value.trim();
  try {
    const r = await api('/admin/config/test-ollama', { method: 'POST', body: JSON.stringify(url ? { url } : {}) });
    renderOllama({ ...r, url: r.url || url, tested: true });
  } catch (e) { showError(e); }
}

function renderPgvector(state) {
  const card = document.getElementById('pgvector-card');
  const statusHtml = !state.tested
    ? '<span style="color:var(--muted)">Not tested yet</span>'
    : state.reachable
      ? `${badge('reachable', 'green')} <span class="stat-sub">${state.latency_ms || '?'}ms · pgvector ${escapeHtml(state.pgvector_version || '?')} · ${state.doc_count || 0} docs</span>`
      : `${badge('unreachable', 'red')} <span class="stat-sub">${escapeHtml(state.error || '')}</span>`;
  card.innerHTML = `
    <div class="form-row">
      <input id="pg-url" placeholder="postgres://user:pass@host:5433/db (blank = use configured)" style="flex:1; min-width:300px">
      <button data-action="test-pgvector">Test connection</button>
    </div>
    <div style="margin-top:0.5rem">${statusHtml}</div>
  `;
}

async function testPgvector() {
  const url = document.getElementById('pg-url').value.trim();
  try {
    const r = await api('/admin/config/test-pgvector', { method: 'POST', body: JSON.stringify(url ? { url } : {}) });
    renderPgvector({ ...r, tested: true });
  } catch (e) { showError(e); }
}

// ──────────────────────────────────────────────────────────────
// LLM MANAGEMENT
// ──────────────────────────────────────────────────────────────

let _llmPullPoller = null;

LOADERS.llms = async () => {
  let caps;
  try { caps = await api('/admin/llm/capabilities'); }
  catch { caps = { provider: 'ollama', capabilities: {} }; }

  const provider = caps.provider || 'ollama';
  const ollamaEl = document.getElementById('llms-ollama-mode');
  const llamacppEl = document.getElementById('llms-llamacpp-mode');
  if (ollamaEl) ollamaEl.style.display = provider === 'ollama' ? '' : 'none';
  if (llamacppEl) llamacppEl.style.display = provider === 'llamacpp' ? '' : 'none';

  // Mode label in the title
  const modeLabel = document.getElementById('llms-mode-label');
  if (modeLabel) {
    modeLabel.textContent = provider === 'ollama'
      ? 'powered by Ollama'
      : 'powered by llama-server';
  }

  if (provider === 'ollama') {
    await loadOllamaLlmsTab();
  } else if (provider === 'llamacpp') {
    await loadLlamacppPanel();
  }
};

// Helper: the existing LOADERS.llms body, now only called in Ollama mode.
async function loadOllamaLlmsTab() {
  await renderLlmTab();
}

async function loadLlamacppPanel() {
  // Loaded model
  let active;
  try { active = await api('/admin/llm/active'); }
  catch { active = { model: '(error)' }; }
  document.getElementById('lc-loaded-model').textContent = active.model || '(unknown)';

  // GGUF list
  let list;
  try { list = await api('/admin/llm/models'); }
  catch { list = { models: [] }; }

  const tbody = document.querySelector('#llamacpp-models-table tbody');
  tbody.innerHTML = '';
  for (const m of (list.models || [])) {
    const tr = document.createElement('tr');
    const sizeMb = (m.size_bytes / (1024 * 1024)).toFixed(1);
    const quant = m.details?.parsed?.quant || '?';
    const isLoaded = m.details?.is_loaded || false;
    tr.innerHTML = `
      <td>${escapeHtml(m.name)}</td>
      <td class="mono">${sizeMb} MB</td>
      <td>${escapeHtml(quant)}</td>
      <td>${isLoaded ? '<span class="badge badge-green">loaded</span>' : '<span class="badge badge-muted">available</span>'}</td>
    `;
    tbody.appendChild(tr);
  }
  if ((list.models || []).length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="color:var(--muted)">No GGUF files found in the models directory.</td></tr>';
  }
}

async function renderLlmTab() {
  try {
    const r = await api('/admin/ollama/models');
    const urlEl = document.getElementById('llms-ollama-url');
    if (urlEl) urlEl.textContent = r.ollama_url || '';
    const modeLabel = document.getElementById('llms-mode-label');
    if (modeLabel && r.ollama_url) {
      modeLabel.textContent = `powered by Ollama at ${r.ollama_url}`;
    }

    // ── Active model card ──────────────────────────────────────
    document.getElementById('llms-active-name').textContent = r.active_model || '(none configured)';
    const activeEntry = (r.installed || []).find((m) => m.name === r.active_model);
    const loadedEntry = (r.loaded || []).find((m) => m.name === r.active_model);
    const meta = [];
    if (activeEntry) {
      meta.push(`${formatBytes(activeEntry.size_bytes)} on disk`);
      if (activeEntry.parameter_size) meta.push(activeEntry.parameter_size);
      if (activeEntry.quantization) meta.push(activeEntry.quantization);
    }
    if (loadedEntry) {
      meta.push(`<span style="color:var(--green)">in VRAM (${formatBytes(loadedEntry.size_vram)})</span>`);
    } else if (activeEntry) {
      meta.push('<span style="color:var(--muted)">not loaded</span>');
    } else {
      meta.push('<span style="color:var(--red)">not installed — pull it or pick another</span>');
    }
    document.getElementById('llms-active-meta').innerHTML = meta.join(' · ');

    const warnEl = document.getElementById('llms-env-pinned-warning');
    if (r.env_pinned) {
      warnEl.innerHTML = `<strong>Pinned by env var:</strong> <code>${r.env_var}</code> is set in the
        container's environment, which always wins over the runtime config.
        To use the dashboard switcher, remove <code>${r.env_var}</code> from your <code>.env</code>
        file and run <code>scripts/docker-restart.sh</code>.`;
      warnEl.style.display = 'block';
    } else {
      warnEl.style.display = 'none';
    }

    // ── Switch dropdown ───────────────────────────────────────
    const sel = document.getElementById('llms-switch-select');
    sel.innerHTML = '';
    const installed = r.installed || [];
    if (!installed.length) {
      sel.innerHTML = '<option value="">No models installed — pull one below</option>';
      sel.disabled = true;
    } else {
      sel.disabled = !!r.env_pinned;
      for (const m of installed) {
        const opt = document.createElement('option');
        opt.value = m.name;
        opt.textContent = `${m.name}  ·  ${formatBytes(m.size_bytes)}` +
          (m.loaded ? '  ·  in VRAM' : '');
        if (m.name === r.active_model) opt.selected = true;
        sel.appendChild(opt);
      }
    }
    if (r.env_pinned) {
      const btn = document.querySelector('[data-action="apply-llm-switch"]');
      if (btn) btn.disabled = true;
    } else {
      const btn = document.querySelector('[data-action="apply-llm-switch"]');
      if (btn) btn.disabled = false;
    }

    // ── Installed table ───────────────────────────────────────
    const cont = document.getElementById('llms-installed-container');
    if (!installed.length) {
      cont.innerHTML = '<div class="card" style="color:var(--muted)">Nothing installed. Pull a model above.</div>';
    } else {
      let html = '<table><tr><th>Name</th><th>Size</th><th>Params</th><th>Quant</th><th>Status</th><th>Actions</th></tr>';
      for (const m of installed) {
        const isActive = m.name === r.active_model;
        const status = isActive
          ? badge('active', 'green')
          : (m.loaded ? badge('loaded', 'purple') : '<span style="color:var(--muted)">cold</span>');
        const actions = [
          isActive
            ? '<span style="color:var(--muted);font-size:0.78rem">— active —</span>'
            : `<button class="small" data-action="activate-llm" data-model="${escapeAttr(m.name)}" ${r.env_pinned ? 'disabled title="env-pinned"' : ''}>Activate</button>`,
          isActive
            ? ''
            : `<button class="small danger" data-action="delete-llm" data-model="${escapeAttr(m.name)}">Delete</button>`,
        ].filter(Boolean).join(' ');
        html += `<tr>
          <td class="mono">${escapeHtml(m.name)}</td>
          <td>${formatBytes(m.size_bytes)}</td>
          <td>${escapeHtml(m.parameter_size || '—')}</td>
          <td>${escapeHtml(m.quantization || '—')}</td>
          <td>${status}</td>
          <td style="white-space:nowrap">${actions}</td>
        </tr>`;
      }
      html += '</table>';
      cont.innerHTML = html;
    }

    // ── Pull jobs ─────────────────────────────────────────────
    renderPullJobs(r.active_pulls || []);

    // Start a poller if any pulls are still running.
    const stillRunning = (r.active_pulls || []).some((j) => j.status === 'running' || j.status === 'pending');
    if (stillRunning && !_llmPullPoller) {
      _llmPullPoller = setInterval(() => {
        const onTab = document.querySelector('#nav a.active')?.dataset.tab === 'llms';
        if (!onTab) return;
        renderLlmTab().catch(() => {});
      }, 1500);
    } else if (!stillRunning && _llmPullPoller) {
      clearInterval(_llmPullPoller);
      _llmPullPoller = null;
    }
  } catch (e) {
    document.getElementById('llms-active-meta').innerHTML =
      `<span style="color:var(--red)">Ollama unreachable: ${escapeHtml(e.message || String(e))}</span>`;
  }
}

function renderPullJobs(jobs) {
  const el = document.getElementById('llms-pull-jobs');
  if (!jobs.length) {
    el.innerHTML = '';
    return;
  }
  let html = '<div style="font-size:0.85rem;color:var(--muted);margin-bottom:0.4rem">Active pulls</div>';
  for (const j of jobs) {
    const pct = Math.max(0, Math.min(100, j.percent || 0));
    const sub = j.total_bytes
      ? `${formatBytes(j.completed_bytes)} / ${formatBytes(j.total_bytes)}`
      : (j.message || '');
    html += `<div style="margin-bottom:0.5rem">
      <div style="display:flex;justify-content:space-between;font-size:0.85rem">
        <span class="mono">${escapeHtml(j.model)}</span>
        <span style="color:var(--muted)">${escapeHtml(j.message || '')} · ${pct}%</span>
      </div>
      <div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden;margin-top:3px">
        <div style="height:100%;width:${pct}%;background:var(--accent);transition:width 0.3s"></div>
      </div>
      <div style="font-size:0.78rem;color:var(--muted);margin-top:2px;display:flex;justify-content:space-between">
        <span>${escapeHtml(sub)}</span>
        <button class="small secondary" data-action="cancel-llm-pull" data-job-id="${escapeAttr(j.id)}">Cancel</button>
      </div>
    </div>`;
  }
  el.innerHTML = html;
}

function formatBytes(n) {
  if (!n && n !== 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n/1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n/1024/1024).toFixed(1)} MB`;
  return `${(n/1024/1024/1024).toFixed(2)} GB`;
}

async function applyLlmSwitch() {
  const sel = document.getElementById('llms-switch-select');
  const status = document.getElementById('llms-switch-status');
  const target = sel.value;
  if (!target) {
    status.textContent = 'Pick a model first.';
    status.style.color = 'var(--red)';
    return;
  }
  status.textContent = `Switching to ${target}… (warming model — first run can take 5–30 s)`;
  status.style.color = 'var(--muted)';
  try {
    const r = await api('/admin/ollama/model', {
      method: 'POST',
      body: JSON.stringify({ model: target }),
    });
    if (r.warmed) {
      status.textContent = `✓ Active model: ${r.model}`;
      status.style.color = 'var(--green)';
    } else {
      status.textContent = `Switched to ${r.model}, but warmup failed: ${r.warm_error || 'unknown'}`;
      status.style.color = 'var(--yellow)';
    }
    await renderLlmTab();
  } catch (e) {
    status.textContent = e.message || 'Switch failed.';
    status.style.color = 'var(--red)';
  }
}

async function activateLlm(model) {
  const sel = document.getElementById('llms-switch-select');
  if (sel) sel.value = model;
  await applyLlmSwitch();
}

async function deleteLlm(model) {
  openModal(`
    <h3>Delete <span class="mono">${escapeHtml(model)}</span>?</h3>
    <p style="color:var(--muted);font-size:0.85rem">
      Frees up disk space on the Ollama host. Cannot be undone — re-pulling
      will re-download the full model.
    </p>
    <div class="modal-actions">
      <button class="secondary" data-action="close-modal">Cancel</button>
      <button class="danger" data-action="confirm-delete-llm" data-model="${escapeAttr(model)}">Delete</button>
    </div>
  `);
}

async function confirmDeleteLlm(model) {
  closeModal();
  try {
    await api(`/admin/ollama/models/${encodeURIComponent(model)}`, { method: 'DELETE' });
    showSuccess(`Deleted ${model}`);
    await renderLlmTab();
  } catch (e) { showError(e); }
}

async function startLlmPull() {
  const input = document.getElementById('llms-pull-input');
  const model = input.value.trim();
  if (!model) return;
  try {
    await api('/admin/ollama/pull', {
      method: 'POST',
      body: JSON.stringify({ model }),
    });
    input.value = '';
    showSuccess(`Pulling ${model}…`);
    await renderLlmTab();
  } catch (e) { showError(e); }
}

async function cancelLlmPull(jobId) {
  try {
    await api(`/admin/ollama/pull/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
    await renderLlmTab();
  } catch (e) { showError(e); }
}

// ──────────────────────────────────────────────────────────────
// KNOWLEDGE GRAPH
// ──────────────────────────────────────────────────────────────

let _graphCy = null;
let _graphBackfillPoller = null;
const GRAPH_TYPE_COLORS = {
  PERSON:  '#60a5fa',  // blue
  ORG:     '#fbbf24',  // amber
  PLACE:   '#34d399',  // green
  PRODUCT: '#f472b6',  // pink
  EVENT:   '#a78bfa',  // violet
  CONCEPT: '#9ca3af',  // grey
  OTHER:   '#6b7280',  // dim grey
};

LOADERS.graph = async () => {
  await renderGraphTab();
};

async function renderGraphTab() {
  // Populate the domain dropdown from /admin/domains. Filter to readable.
  let doms;
  try {
    doms = await api('/admin/domains');
  } catch (e) {
    document.getElementById('graph-status-line').textContent = 'failed to load domains';
    return;
  }
  const readable = (doms.domains || []).filter((d) => d.effective_permission);
  const permByDomain = new Map(readable.map((d) => [d.domain, d.effective_permission]));
  const sel = document.getElementById('graph-domain-select');
  const current = sel.value;
  sel.innerHTML = '';
  if (!readable.length) {
    sel.innerHTML = '<option value="">(no readable domains)</option>';
  } else {
    for (const d of readable) {
      const opt = document.createElement('option');
      opt.value = d.domain;
      opt.textContent = `@${d.domain} (${d.doc_count} doc${d.doc_count !== 1 ? 's' : ''})`;
      if (d.domain === current) opt.selected = true;
      sel.appendChild(opt);
    }
    if (!current) sel.value = readable[0].domain;
  }

  // Backfill is admin-on-domain only. Hide it for read/write users so the
  // UI doesn't dangle a button that would 403.
  const backfillBtn = document.querySelector('[data-action="start-graph-backfill"]');
  if (backfillBtn) {
    const perm = permByDomain.get(sel.value) || '';
    backfillBtn.style.display = perm === 'admin' ? '' : 'none';
  }

  // Keep full-screen and GEXF export links in sync with the selected domain.
  const domainVal = sel.value;
  const fsLink = document.getElementById('graph-fullscreen-link');
  if (fsLink && domainVal) fsLink.href = `/graph?domain=${encodeURIComponent(domainVal)}`;
  const gexfLink = document.getElementById('graph-gexf-link');
  if (gexfLink && domainVal) {
    gexfLink.href = `/admin/domains/${encodeURIComponent(domainVal)}/graph/export.gexf`;
    gexfLink.setAttribute('download', `${domainVal}-graph.gexf`);
  }

  const view = document.getElementById('graph-view-select').value;
  if (view === 'overlap') {
    await renderOverlapGraph(readable.map((d) => d.domain));
  } else {
    await renderDomainGraph(sel.value);
  }
}

async function renderDomainGraph(domain) {
  const statusLine = document.getElementById('graph-status-line');
  const sidePanel = document.getElementById('graph-side-panel');
  if (!domain) {
    statusLine.textContent = '(no domain selected)';
    return;
  }

  const stats = await api(`/admin/domains/${encodeURIComponent(domain)}/graph/stats`).catch(() => null);
  if (stats) {
    const last = stats.last_extraction_at || '(never extracted)';
    statusLine.innerHTML =
      `<strong>@${escapeHtml(domain)}</strong> — ` +
      `${stats.entity_count} entities · ${stats.mention_count} mentions · ${stats.edge_count} edges · ` +
      `last extraction: <span class="mono">${escapeHtml(String(last))}</span>`;
  }

  const [eRes, edRes] = await Promise.all([
    api(`/admin/domains/${encodeURIComponent(domain)}/graph/entities?limit=500`),
    api(`/admin/domains/${encodeURIComponent(domain)}/graph/edges?limit=2000`),
  ]).catch(() => [null, null]);

  const entities = (eRes && eRes.entities) || [];
  const edges = (edRes && edRes.edges) || [];

  if (!entities.length) {
    document.getElementById('graph-canvas').innerHTML =
      '<div style="padding:1rem;color:var(--muted)">No entities yet. Toggle <code>graph.extraction_enabled</code> in Config and capture some docs, or click <strong>Backfill</strong>.</div>';
    sidePanel.innerHTML = '<div style="color:var(--muted)">Click a node to see details.</div>';
    drawLegend(false);
    return;
  }

  const elements = [
    ...entities.map((e) => ({
      data: {
        id: e.entity_id,
        label: e.name,
        type: e.type,
        mention_count: e.mention_count,
        domain,
      },
    })),
    ...edges.map((ed, i) => ({
      data: {
        id: `e${i}`,
        source: ed.src_id,
        target: ed.dst_id,
        relation: ed.relation,
        weight: ed.weight,
      },
    })),
  ];

  buildCytoscape(elements, { layout: 'cose' });

  _graphCy.on('tap', 'node', async (evt) => {
    const node = evt.target;
    const eid = node.data('id');
    sidePanel.innerHTML = '<div style="color:var(--muted)">Loading…</div>';
    try {
      const r = await api(`/admin/domains/${encodeURIComponent(domain)}/graph/entities/${encodeURIComponent(eid)}/docs?limit=20`);
      const docs = (r && r.docs) || [];
      const docsHtml = docs.length
        ? docs.map((d) => `<div style="padding:0.4rem 0;border-bottom:1px solid var(--border)">
            <div class="mono" style="font-size:0.78rem;color:var(--muted)">${escapeHtml(d.doc_id)}</div>
            <div style="margin-top:0.2rem">${escapeHtml(d.snippet || '')}</div>
            <div style="font-size:0.78rem;color:var(--muted);margin-top:0.2rem">${escapeHtml(d.created_at || '')}</div>
          </div>`).join('')
        : '<div style="color:var(--muted)">No docs found.</div>';
      sidePanel.innerHTML = `
        <div style="font-weight:bold">${escapeHtml(node.data('label'))}</div>
        <div style="color:var(--muted);font-size:0.78rem">${escapeHtml(node.data('type'))} · ${node.data('mention_count')} mentions</div>
        <hr style="border-color:var(--border);margin:0.5rem 0">
        ${docsHtml}
      `;
    } catch (err) {
      sidePanel.innerHTML = `<div style="color:var(--red)">${escapeHtml(err.message || String(err))}</div>`;
    }
  });

  drawLegend(true);
}

async function renderOverlapGraph(domains) {
  const statusLine = document.getElementById('graph-status-line');
  const sidePanel = document.getElementById('graph-side-panel');
  if (!domains || !domains.length) {
    statusLine.textContent = 'No readable domains';
    document.getElementById('graph-canvas').innerHTML = '';
    return;
  }

  const r = await api(`/admin/graph/overlap?domains=${encodeURIComponent(domains.join(','))}&limit=500`)
    .catch((e) => ({ overlap: [], error: e.message }));
  const overlap = r.overlap || [];

  statusLine.innerHTML = `<strong>Cross-domain overlap</strong> across ${domains.length} domain${domains.length !== 1 ? 's' : ''} — ` +
    `${overlap.length} entities appear in 2+ domains`;

  if (!overlap.length) {
    document.getElementById('graph-canvas').innerHTML =
      '<div style="padding:1rem;color:var(--muted)">No overlapping entities. Each entity is unique to its domain, or no extraction has run.</div>';
    drawLegend(false);
    sidePanel.innerHTML = '<div style="color:var(--muted)">Click a node to see details.</div>';
    return;
  }

  // Build a star-graph: each "concept" entity in the middle, connected to one
  // node per domain that mentions it.
  const elements = [];
  const seenDomainNode = new Set();
  for (const o of overlap) {
    const conceptId = `concept::${o.type}::${o.name.toLowerCase()}`;
    elements.push({
      data: {
        id: conceptId,
        label: o.name,
        type: o.type,
        is_concept: true,
        mention_count: o.domains.reduce((s, m) => s + (m.mention_count || 0), 0),
      },
    });
    for (const m of o.domains) {
      const domNode = `dom::${m.domain}`;
      if (!seenDomainNode.has(domNode)) {
        seenDomainNode.add(domNode);
        elements.push({
          data: { id: domNode, label: `@${m.domain}`, type: 'DOMAIN', is_domain: true },
        });
      }
      elements.push({
        data: {
          id: `${conceptId}->${domNode}`,
          source: conceptId,
          target: domNode,
          relation: 'mentioned_in',
          weight: m.mention_count || 1,
        },
      });
    }
  }
  buildCytoscape(elements, { layout: 'cose' });
  drawLegend(true);

  _graphCy.on('tap', 'node', (evt) => {
    const node = evt.target;
    if (node.data('is_domain')) {
      sidePanel.innerHTML = `<div style="font-weight:bold">${escapeHtml(node.data('label'))}</div>
        <div style="color:var(--muted);font-size:0.85rem;margin-top:0.5rem">Switch to Per-domain view to explore this domain.</div>`;
      return;
    }
    const matched = overlap.find((o) =>
      `concept::${o.type}::${o.name.toLowerCase()}` === node.data('id'));
    if (!matched) return;
    sidePanel.innerHTML = `
      <div style="font-weight:bold">${escapeHtml(matched.name)}</div>
      <div style="color:var(--muted);font-size:0.78rem">${escapeHtml(matched.type)}</div>
      <hr style="border-color:var(--border);margin:0.5rem 0">
      <div>Appears in:</div>
      ${matched.domains.map((m) =>
        `<div style="padding:0.3rem 0">
          <span class="mono">@${escapeHtml(m.domain)}</span>
          <span style="color:var(--muted);font-size:0.78rem">— ${m.mention_count} mentions</span>
         </div>`).join('')}
    `;
  });
}

function buildCytoscape(elements, opts) {
  const cyContainer = document.getElementById('graph-canvas');
  cyContainer.innerHTML = '';
  if (typeof cytoscape !== 'function') {
    cyContainer.innerHTML = '<div style="padding:1rem;color:var(--red)">cytoscape.min.js failed to load</div>';
    return;
  }
  if (_graphCy) { try { _graphCy.destroy(); } catch { /* ignore */ } _graphCy = null; }
  _graphCy = cytoscape({
    container: cyContainer,
    elements,
    style: [
      {
        selector: 'node',
        style: {
          'background-color': (ele) => GRAPH_TYPE_COLORS[ele.data('type')] || GRAPH_TYPE_COLORS.OTHER,
          'label': 'data(label)',
          'color': '#e2e8f0',
          'font-size': 11,
          'text-valign': 'center',
          'text-halign': 'center',
          'text-wrap': 'wrap',
          'text-max-width': 90,
          'width': (ele) => 18 + Math.log(1 + (ele.data('mention_count') || 1)) * 10,
          'height': (ele) => 18 + Math.log(1 + (ele.data('mention_count') || 1)) * 10,
          'border-width': 1,
          'border-color': '#0a0e16',
        },
      },
      {
        selector: 'node[is_domain]',
        style: {
          'background-color': '#1e293b',
          'border-color': '#475569',
          'border-width': 2,
          'shape': 'rectangle',
          'width': 80,
          'height': 30,
        },
      },
      {
        selector: 'edge',
        style: {
          'width': 1,
          'line-color': '#334155',
          'curve-style': 'bezier',
          'label': 'data(relation)',
          'font-size': 8,
          'color': '#64748b',
          'text-rotation': 'autorotate',
          'text-margin-y': -4,
          'target-arrow-shape': 'none',
        },
      },
    ],
    layout: { name: opts.layout || 'cose', animate: false, fit: true, padding: 30 },
    minZoom: 0.2,
    maxZoom: 3,
    wheelSensitivity: 0.2,
  });
}

function drawLegend(show) {
  const el = document.getElementById('graph-legend');
  if (!show) { el.innerHTML = ''; return; }
  el.innerHTML = Object.entries(GRAPH_TYPE_COLORS).map(([t, c]) =>
    `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${c};margin-right:0.25rem;vertical-align:middle"></span>${t}`).join('  &nbsp; ');
}

async function reloadGraph() {
  await renderGraphTab();
}

async function startGraphBackfill() {
  const domain = document.getElementById('graph-domain-select').value;
  if (!domain) return;
  const status = document.getElementById('graph-backfill-status');
  status.textContent = `Starting backfill for @${domain}…`;
  status.style.color = 'var(--muted)';
  try {
    const job = await api(`/admin/domains/${encodeURIComponent(domain)}/graph/backfill`, { method: 'POST' });
    const jobId = job.id;
    status.textContent = `Backfill running (${job.message || 'queued'})…`;
    if (_graphBackfillPoller) clearInterval(_graphBackfillPoller);
    _graphBackfillPoller = setInterval(async () => {
      try {
        const j = await api(`/admin/graph/backfills/${encodeURIComponent(jobId)}`);
        const pct = j.percent || 0;
        status.innerHTML = `Backfill <span class="mono">${escapeHtml(jobId)}</span>: ${escapeHtml(j.status)} — ${escapeHtml(j.message || '')} (${pct}%)`;
        if (j.status === 'done' || j.status === 'error' || j.status === 'canceled') {
          clearInterval(_graphBackfillPoller);
          _graphBackfillPoller = null;
          status.style.color = j.status === 'done' ? 'var(--green)' : 'var(--red)';
          await renderGraphTab();
        }
      } catch (e) {
        clearInterval(_graphBackfillPoller);
        _graphBackfillPoller = null;
        status.textContent = 'poll failed: ' + (e.message || e);
        status.style.color = 'var(--red)';
      }
    }, 2000);
  } catch (e) {
    status.textContent = 'backfill failed: ' + (e.message || e);
    status.style.color = 'var(--red)';
  }
}

// Wire view-select and domain-select onchange (idempotent — runs once at init)
document.addEventListener('DOMContentLoaded', () => {
  const view = document.getElementById('graph-view-select');
  const dom = document.getElementById('graph-domain-select');
  const ctrls = document.getElementById('graph-domain-controls');
  if (view) {
    view.addEventListener('change', async () => {
      if (ctrls) ctrls.style.display = view.value === 'overlap' ? 'none' : '';
      await renderGraphTab();
    });
  }
  if (dom) dom.addEventListener('change', async () => { await renderGraphTab(); });
});

// ──────────────────────────────────────────────────────────────
// CONFIG
// ──────────────────────────────────────────────────────────────
async function loadConfig() {
  try {
    const r = await api('/admin/config');
    document.getElementById('config-yaml').value = r.yaml;
    document.getElementById('config-path').textContent = r.path;
    document.getElementById('config-status').textContent = '';
    const envs = Object.entries(r.env_overrides);
    if (!envs.length) {
      document.getElementById('env-overrides-container').innerHTML = '<div style="color:var(--muted); font-size:0.85rem">No env vars override file config.</div>';
    } else {
      let html = '<table><tr><th>Path</th><th>Env var value</th></tr>';
      for (const [path, val] of envs) html += `<tr><td class="mono">${escapeHtml(path)}</td><td class="mono">${escapeHtml(val)}</td></tr>`;
      document.getElementById('env-overrides-container').innerHTML = html + '</table>';
    }
  } catch (e) { showError(e); }
}
LOADERS.config = () => {
  loadConfig();
  loadSmtpStatus();
  loadMailConfig();
  loadProviderSettings();
  loadClassifierSettings();
};

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

async function loadMailConfig() {
  const status = document.getElementById('mail-save-status');
  if (status) status.textContent = '';
  try {
    const r = await fetch(`${BASE}/admin/config/mail`, { credentials: 'include' });
    if (!r.ok) return;
    const { mail, env_locked } = await r.json();
    const set = (id, value, lockedField) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.value = value ?? '';
      el.disabled = !!env_locked[lockedField];
      el.title = env_locked[lockedField] ? `Pinned by env var (OB2_${lockedField.toUpperCase()}) — edit there or unset to enable this field.` : '';
    };
    set('mail-driver', mail.driver, 'driver');
    set('mail-host', mail.host, 'host');
    set('mail-port', mail.port, 'port');
    set('mail-user', mail.user, 'user');
    // Password field: if env-locked, show placeholder text and disable.
    const passEl = document.getElementById('mail-pass');
    if (passEl) {
      passEl.value = '';
      passEl.placeholder = env_locked.pass ? 'Pinned by OB2_SMTP_PASS env var' : (mail.pass ? 'Leave blank to keep current' : 'Not set');
      passEl.disabled = !!env_locked.pass;
      passEl.title = env_locked.pass ? 'Pinned by env var (OB2_SMTP_PASS) — edit there or unset to enable this field.' : '';
    }
    set('mail-secure', mail.secure, 'secure');
    set('mail-from', mail.from, 'from');
    set('mail-public-url', mail.public_url, 'public_url');
  } catch { /* non-fatal */ }
}

async function saveMailConfig() {
  const status = document.getElementById('mail-save-status');
  status.textContent = 'Saving…';
  const readField = (id) => {
    const el = document.getElementById(id);
    return el && !el.disabled ? el.value : undefined;
  };
  const port = readField('mail-port');
  const body = {
    driver: readField('mail-driver'),
    host: readField('mail-host'),
    port: port !== undefined ? Number(port) : undefined,
    user: readField('mail-user'),
    pass: readField('mail-pass'),
    secure: readField('mail-secure'),
    from: readField('mail-from'),
    public_url: readField('mail-public-url'),
  };
  // Strip undefined so the server preserves env-locked values.
  Object.keys(body).forEach((k) => body[k] === undefined && delete body[k]);
  try {
    const r = await fetch(`${BASE}/admin/config/mail`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const respBody = await r.json().catch(() => ({}));
    if (!r.ok) { status.textContent = `Failed: ${respBody.error || r.status}`; return; }
    status.textContent = 'Saved. Reloading…';
    // Reload so the password field resets and env_locked is re-evaluated.
    await loadMailConfig();
    // Refresh the status indicator at top of the card.
    await loadSmtpStatus();
    status.textContent = 'Saved.';
  } catch (e) { status.textContent = `Error: ${e.message}`; }
}

async function saveConfig() {
  const text = document.getElementById('config-yaml').value;
  try {
    await fetch(`${BASE}/admin/config`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-yaml' },
      body: text,
    }).then(async r => { if (!r.ok) { const e = await r.json().catch(()=>({error:r.statusText})); throw new Error(e.error || r.statusText); } return r.json(); });
    document.getElementById('config-status').textContent = '✓ saved';
    document.getElementById('config-status').style.color = 'var(--green)';
    showSuccess('config saved and reloaded');
    loadConfig();
  } catch (e) { showError(e); }
}

// ──────────────────────────────────────────────────────────────
// LLM provider settings (Config tab)
// ──────────────────────────────────────────────────────────────
//
// PUT /admin/config replaces the entire file config (see writeRuntime in
// server/runtime_config.ts), so we always read-modify-write the full file
// section instead of sending a partial patch. Effective config (with
// defaults filled in) drives the read side; file config is the merge base
// for writes.
async function loadProviderSettings() {
  let cfg;
  try { cfg = await api('/admin/config'); }
  catch { return; }
  const eff = cfg.effective || {};
  const provider = eff.llm?.provider || 'ollama';
  for (const radio of document.querySelectorAll('input[name="llm-provider"]')) {
    radio.checked = radio.value === provider;
  }
  document.getElementById('llamacpp-settings').style.display = provider === 'llamacpp' ? '' : 'none';

  const lc = eff.llamacpp || {};
  document.getElementById('lc-manager-url').value = lc.manager_url || '';
  document.getElementById('lc-chat-url').value = lc.chat_url || '';
  document.getElementById('lc-models-dir').value = lc.models_dir || '';
  document.getElementById('lc-default-model').value = lc.default_model || '';
  document.getElementById('lc-ctx-size').value = lc.ctx_size ?? 8192;
  document.getElementById('lc-gpu-layers').value = lc.gpu_layers ?? -1;
  document.getElementById('lc-parallel-slots').value = lc.parallel_slots ?? 1;
}

async function loadClassifierSettings() {
  let cfg;
  try { cfg = await api('/admin/config'); }
  catch { return; }
  // Use `effective` so default values populate even on a fresh config.
  const eff = cfg.effective || cfg;  // fallback for older shape

  const chatProvider = eff.llm?.provider || 'ollama';
  const cls = eff.llm?.classifier_provider || '';
  const effectiveCls = cls === '' ? chatProvider : cls;

  // Set the radio
  for (const radio of document.querySelectorAll('input[name="classifier-provider"]')) {
    radio.checked = radio.value === cls;
  }

  // Effective configuration display
  const ollamaModel = eff.ollama?.model || '?';
  const ollamaClassifierModel = eff.ollama?.classifier_model || ollamaModel;
  const llamacppLabel = eff.llamacpp?.default_model || '(loaded model)';

  document.getElementById('cls-chat').textContent =
    chatProvider === 'ollama'
      ? `Ollama → ${ollamaModel}`
      : `llama-server → ${llamacppLabel}`;
  document.getElementById('cls-classifier').textContent =
    effectiveCls === 'ollama'
      ? `Ollama → ${ollamaClassifierModel}`
      : `llama-server → ${llamacppLabel}`;

  // Show classifier-model input only when the resolved classifier is Ollama
  document.getElementById('classifier-model-row').style.display = effectiveCls === 'ollama' ? '' : 'none';
  document.getElementById('classifier-llamacpp-note').style.display = effectiveCls === 'llamacpp' ? '' : 'none';

  // Populate the input value (always — it's persisted regardless of which provider is active)
  document.getElementById('classifier-model-input').value = eff.ollama?.classifier_model || '';
}

// PUT a merged file config — fetch current `file`, overlay the patch sections,
// then send as JSON. PUT /admin/config parses the body with js-yaml on the
// server, and JSON is a strict subset of YAML so this round-trips cleanly.
async function _putRuntimeConfigPatch(patch) {
  const cfg = await api('/admin/config');
  const next = { ...(cfg.file || {}) };
  for (const [section, values] of Object.entries(patch)) {
    next[section] = { ...(next[section] || {}), ...values };
  }
  const r = await fetch(`${BASE}/admin/config`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-yaml' },
    body: JSON.stringify(next),
  });
  if (r.status === 401) {
    WHOAMI = null;
    showLogin('Session expired — please sign in again');
    throw new Error('not authenticated');
  }
  if (!r.ok) {
    const e = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error(e.error || r.statusText);
  }
  return await r.json();
}

// Provider radio change → patch llm.provider, refresh badge + panel.
document.addEventListener('DOMContentLoaded', () => {
  for (const radio of document.querySelectorAll('input[name="llm-provider"]')) {
    radio.addEventListener('change', async () => {
      const v = document.querySelector('input[name="llm-provider"]:checked').value;
      document.getElementById('llamacpp-settings').style.display = v === 'llamacpp' ? '' : 'none';
      try {
        await _putRuntimeConfigPatch({ llm: { provider: v } });
        refreshLlmBadge();
        // Reload YAML editor so the operator sees the persisted change.
        loadConfig();
      } catch (e) {
        alert('Failed to switch provider: ' + e.message);
      }
    });
  }
});

// Save llama-server settings button.
document.body.addEventListener('click', async (e) => {
  if (e.target?.dataset?.action !== 'save-llamacpp-config') return;
  const status = document.getElementById('llamacpp-save-status');
  status.textContent = 'Saving…';
  const patch = {
    llamacpp: {
      manager_url: document.getElementById('lc-manager-url').value,
      chat_url: document.getElementById('lc-chat-url').value,
      default_model: document.getElementById('lc-default-model').value,
      ctx_size: Number(document.getElementById('lc-ctx-size').value),
      gpu_layers: Number(document.getElementById('lc-gpu-layers').value),
      parallel_slots: Number(document.getElementById('lc-parallel-slots').value),
    },
  };
  try {
    await _putRuntimeConfigPatch(patch);
    status.textContent = 'Saved.';
    refreshLlmBadge();
    // Reload YAML editor + provider form so the operator sees persisted state.
    loadConfig();
    loadProviderSettings();
    setTimeout(() => { status.textContent = ''; }, 2000);
  } catch (err) {
    status.textContent = 'Save failed: ' + err.message;
  }
});

// Classifier-provider radio change → patch llm.classifier_provider, refresh the section
document.addEventListener('DOMContentLoaded', () => {
  for (const radio of document.querySelectorAll('input[name="classifier-provider"]')) {
    radio.addEventListener('change', async () => {
      const v = document.querySelector('input[name="classifier-provider"]:checked').value;
      try {
        await _putRuntimeConfigPatch({ llm: { classifier_provider: v } });
        await loadClassifierSettings();
        refreshLlmBadge();
      } catch (e) {
        alert('Failed to set classifier provider: ' + e.message);
      }
    });
  }
});

// Save classifier-model button (Ollama-only field)
document.body.addEventListener('click', async (e) => {
  if (e.target?.dataset?.action !== 'save-classifier-model') return;
  const status = document.getElementById('classifier-model-status');
  status.textContent = 'Saving…';
  const v = document.getElementById('classifier-model-input').value;
  try {
    await _putRuntimeConfigPatch({ ollama: { classifier_model: v } });
    status.textContent = 'Saved.';
    await loadClassifierSettings();
    setTimeout(() => { status.textContent = ''; }, 2000);
  } catch (err) {
    status.textContent = 'Save failed: ' + err.message;
  }
});

// ──────────────────────────────────────────────────────────────
// PROCESSES
// ──────────────────────────────────────────────────────────────
LOADERS.processes = async () => {
  try {
    const m = await api('/admin/metrics');

    // Batcher
    const b = m.batcher || {};
    document.getElementById('batcher-grid').innerHTML = `
      <div class="card"><h3>Total batches</h3><div class="stat">${(b.total_batches || 0).toLocaleString()}</div></div>
      <div class="card"><h3>Total items embedded</h3><div class="stat">${(b.total_items || 0).toLocaleString()}</div></div>
      <div class="card"><h3>Avg batch ms</h3><div class="stat small">${b.avg_batch_ms || 0} ms</div></div>
      <div class="card"><h3>Avg items / batch</h3><div class="stat small">${b.avg_items_per_batch || 0}</div></div>
    `;

    // Sync
    const s = m.sync || {};
    const reach = s.pgvector_reachable !== undefined ? (s.pgvector_reachable ? badge('reachable', 'green') : badge('unreachable', 'red')) : badge('n/a', 'muted');
    document.getElementById('sync-grid').innerHTML = `
      <div class="card"><h3>Pending docs</h3><div class="stat">${s.pending_docs ?? '—'}</div></div>
      <div class="card"><h3>pgvector</h3><div class="stat">${reach}</div></div>
      <div class="card"><h3>Last sync</h3><div class="stat small">${s.last_sync_docs || 0} docs</div><div class="stat-sub">${escapeHtml(s.last_sync_at || 'never')}</div></div>
      <div class="card"><h3>Last sync duration</h3><div class="stat small">${s.last_sync_ms || 0} ms</div></div>
    `;

    // Classifier
    const c = m.classifier?.counts || {};
    const total = (c.routed || 0) + (c.passed || 0) + (c.denied || 0);
    document.getElementById('classifier-grid').innerHTML = `
      <div class="card"><h3>Auto-routed</h3><div class="stat">${c.routed || 0}</div></div>
      <div class="card"><h3>Passed through</h3><div class="stat">${c.passed || 0}</div></div>
      <div class="card"><h3>Denied / low-conf</h3><div class="stat">${c.denied || 0}</div></div>
      <div class="card"><h3>Total queries</h3><div class="stat">${total}</div></div>
    `;

    const recent = m.classifier?.recent || [];
    if (recent.length) {
      let html = '<table><tr><th>Time</th><th>Query</th><th>Domain</th><th>Outcome</th></tr>';
      for (const d of recent.slice().reverse().slice(0, 20)) {
        html += `<tr><td class="mono">${escapeHtml(d.at)}</td><td>${escapeHtml((d.query || '').slice(0, 60))}</td><td class="mono">${escapeHtml(d.domain || '—')}</td><td>${badge(d.outcome, d.outcome==='routed'?'purple':'muted')}</td></tr>`;
      }
      document.getElementById('classifier-recent').innerHTML = html + '</table>';
    } else {
      document.getElementById('classifier-recent').innerHTML = '<div style="color:var(--muted); font-size:0.85rem">No classifier decisions recorded yet.</div>';
    }
  } catch (e) { showError(e); }
};

// ──────────────────────────────────────────────────────────────
// PROFILE
// ──────────────────────────────────────────────────────────────
function isBootstrapUser() {
  // _admin is a synthetic user created by the brain-key bootstrap path;
  // it can't own a password or an API key. Detect it by username so this
  // also works after a page refresh (USING_BOOTSTRAP only set on fresh login).
  return (WHOAMI?.username || '') === '_admin';
}

LOADERS.profile = async () => {
  loadProfileEmail();
  const w = WHOAMI || {};
  const adminBadge = w.global_admin ? `<span class="badge badge-yellow">global admin</span>` : '';
  const domEntries = Object.entries(w.domains || {});
  const domsHtml = w.global_admin
    ? '<span style="color:var(--muted)">Global admin — all domains</span>'
    : (domEntries.length
        ? domEntries.map(([d, p]) => `<span class="perm-tag">@${escapeHtml(d)} (${escapeHtml(p)})</span>`).join(' ')
        : '<span style="color:var(--muted)">No domains assigned. Contact an administrator.</span>');
  const bootstrap = isBootstrapUser();
  const bootstrapBanner = bootstrap
    ? `<div class="card" style="background: rgba(251,191,36,0.08); border-color: var(--yellow); margin-top: 0.75rem">
         <strong style="color:var(--yellow)">Bootstrap account — read-only profile</strong>
         <div style="color:var(--muted); font-size:0.85rem; margin-top:0.25rem">
           You signed in via the <code>OB2_BRAIN_KEY</code>. This account can't hold a password or an API key.
           Go to the <a href="#users" style="color:var(--accent)">Users</a> tab, create a real admin user,
           use <strong>Set password</strong> on their row, then sign out and back in as that user.
         </div>
       </div>`
    : '';
  document.getElementById('profile-summary').innerHTML = `
    <div><strong>Signed in as</strong> <code>${escapeHtml(w.username || '?')}</code> ${adminBadge}</div>
    <div style="margin-top:0.4rem"><strong>Your domain access:</strong> ${domsHtml}</div>
    ${bootstrapBanner}
  `;

  // Address the password + API-key cards by id (bootstrap inserts extra .card
  // markup inside the summary, which breaks positional querying)
  const pwCard = document.getElementById('profile-pw-card');
  const pwHeading = document.getElementById('profile-pw-heading');
  const keyCard = document.getElementById('profile-key-card');
  const keyHeading = document.getElementById('profile-key-heading');
  for (const el of [pwCard, pwHeading, keyCard, keyHeading]) {
    el.style.display = bootstrap ? 'none' : '';
  }
  if (!bootstrap) {
    document.getElementById('profile-pw-hint').textContent =
      'Leave "Current password" blank if your admin just seeded one for you.';
    // Clear any leftover status from a previous visit
    document.getElementById('profile-pw-status').textContent = '';
    document.getElementById('profile-pw-status').style.color = 'var(--muted)';
    document.getElementById('profile-key-status').textContent = '';
    document.getElementById('profile-key-status').style.color = 'var(--muted)';
  }
};

async function changePassword() {
  if (isBootstrapUser()) {
    return showError('Bootstrap _admin cannot have a password. Create a real user first.');
  }
  const current = document.getElementById('profile-pw-current').value;
  const next = document.getElementById('profile-pw-next').value;
  const confirmPw = document.getElementById('profile-pw-confirm').value;
  const status = document.getElementById('profile-pw-status');
  status.textContent = '';
  status.style.color = 'var(--muted)';
  if (!next || next.length < 8) {
    status.textContent = 'New password must be at least 8 characters.';
    status.style.color = 'var(--red)';
    return;
  }
  if (next !== confirmPw) {
    status.textContent = 'New password and confirmation do not match.';
    status.style.color = 'var(--red)';
    return;
  }
  try {
    await api('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ current, next }),
    });
    document.getElementById('profile-pw-current').value = '';
    document.getElementById('profile-pw-next').value = '';
    document.getElementById('profile-pw-confirm').value = '';
    status.textContent = '✓ Password updated. Other sessions have been signed out.';
    status.style.color = 'var(--green)';
    showSuccess('password updated');
  } catch (e) {
    status.textContent = String(e.message || e);
    status.style.color = 'var(--red)';
  }
}

async function rotateKey() {
  if (isBootstrapUser()) {
    return showError('Bootstrap _admin has no API key. Create a real user first.');
  }
  openModal(`
    <h3>Rotate API key?</h3>
    <p>Your current API key will stop working immediately. Any MCP or CLI client using it will need the new value.</p>
    <div class="modal-actions">
      <button class="secondary" data-action="close-modal">Cancel</button>
      <button class="danger" data-action="confirm-rotate-key">Rotate</button>
    </div>
  `);
}
async function confirmRotateKey() {
  closeModal();
  const status = document.getElementById('profile-key-status');
  try {
    const r = await api('/auth/rotate-key', { method: 'POST' });
    openModal(`
      <h3>New API key</h3>
      <p>Save this now — it will not be shown again:</p>
      <pre style="color:var(--green); user-select:all">${escapeHtml(r.key)}</pre>
      <div class="modal-actions">
        <button data-action="close-modal">OK</button>
      </div>
    `);
    status.textContent = '✓ API key rotated.';
    status.style.color = 'var(--green)';
  } catch (e) {
    status.textContent = String(e.message || e);
    status.style.color = 'var(--red)';
  }
}

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

// ──────────────────────────────────────────────────────────────
// Global event delegation — the single click listener that dispatches
// every [data-action] handler. This replaces the old inline onclick=
// attributes that CSP's 'unsafe-inline' used to allow through.
// ──────────────────────────────────────────────────────────────
async function uploadImportFile(domain, file) {
  const recent = document.getElementById(`import-recent-${domain}`);
  const row = document.createElement('div');
  row.className = 'row pending';
  row.textContent = `⏳ ${file.name} — uploading…`;
  recent?.prepend(row);
  try {
    const fd = new FormData();
    fd.append('file', file);
    const r = await fetch(`${BASE}/admin/domains/${encodeURIComponent(domain)}/import`, {
      method: 'POST',
      credentials: 'include',
      body: fd,
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      row.className = 'row err';
      row.textContent = `✗ ${file.name} — ${body.error?.message || `HTTP ${r.status}`}`;
      return;
    }
    if (body.job_id) {
      row.className = 'row pending';
      row.textContent = `⏳ ${file.name} — queued (job ${body.job_id})`;
      pollImportJob(domain, body.job_id, file.name, row);
      return;
    }
    row.className = 'row ok';
    row.textContent = `✓ ${file.name} — ${body.chunks_captured} chunk(s) captured`;
    if (typeof loadManageDocs === 'function') loadManageDocs();
  } catch (e) {
    row.className = 'row err';
    row.textContent = `✗ ${file.name} — ${e.message}`;
  }
}

async function importUrl(domain) {
  const input = document.getElementById(`import-url-${domain}`);
  if (!input) return;
  const url = input.value.trim();
  if (!url) return;
  const recent = document.getElementById(`import-recent-${domain}`);
  const row = document.createElement('div');
  row.className = 'row pending';
  row.textContent = `⏳ ${url} — fetching…`;
  recent?.prepend(row);
  input.value = '';
  try {
    const r = await fetch(`${BASE}/admin/domains/${encodeURIComponent(domain)}/import/url`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      row.className = 'row err';
      row.textContent = `✗ ${url} — ${body.error?.message || `HTTP ${r.status}`}`;
      return;
    }
    if (body.job_id) {
      row.className = 'row pending';
      row.textContent = `⏳ ${url} — queued (job ${body.job_id})`;
      pollImportJob(domain, body.job_id, url, row);
      return;
    }
    row.className = 'row ok';
    row.textContent = `✓ ${url} — ${body.chunks_captured} chunk(s) captured`;
    if (typeof loadManageDocs === 'function') loadManageDocs();
  } catch (e) {
    row.className = 'row err';
    row.textContent = `✗ ${url} — ${e.message}`;
  }
}

async function pollImportJob(domain, jobId, label, row) {
  let delay = 2000;
  while (true) {
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(10000, Math.round(delay * 1.3));
    try {
      const r = await fetch(`${BASE}/admin/domains/${encodeURIComponent(domain)}/import/jobs/${jobId}`, {
        credentials: 'include',
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        row.className = 'row err';
        row.textContent = `✗ ${label} — job poll ${r.status}`;
        return;
      }
      if (body.status === 'done') {
        row.className = 'row ok';
        row.textContent = `✓ ${label} — ${body.result?.chunks_captured ?? '?'} chunk(s) captured`;
        if (typeof loadManageDocs === 'function') loadManageDocs();
        return;
      }
      if (body.status === 'error' || body.status === 'interrupted') {
        row.className = 'row err';
        row.textContent = `✗ ${label} — ${body.error?.message || body.status}`;
        return;
      }
      row.textContent = `⏳ ${label} — ${body.status}${body.progress != null ? ` ${Math.round(body.progress * 100)}%` : ''}`;
    } catch (e) {
      row.className = 'row err';
      row.textContent = `✗ ${label} — ${e.message}`;
      return;
    }
  }
}

document.addEventListener('click', (e) => {
  // Modal backdrop: close when clicking on the background itself (not the card).
  const modalBg = e.target.closest('#modal-bg');
  if (modalBg && e.target === modalBg) {
    closeModal();
    return;
  }

  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;

  switch (action) {
    // ── Auth / login ──
    case 'attempt-login': return attemptLogin();
    case 'show-forgot-password': e.preventDefault(); return showForgotPasswordModal();
    case 'close-forgot-modal': return closeForgotModal();
    case 'send-forgot-request': return sendForgotRequest();
    case 'submit-reset': return submitReset();
    case 'sign-out': e.preventDefault(); return signOut();

    // ── Modal ──
    case 'close-modal': return closeModal();

    // ── Domains ──
    case 'open-create-domain': return openCreateDomainModal();
    case 'submit-create-domain': return submitCreateDomain();
    case 'open-import-domain': return openImportDomainModal();
    case 'submit-import-domain': return submitImportDomain();
    case 'export-current-domain': return exportCurrentDomain();

    // ── LLM management ──
    case 'apply-llm-switch': return applyLlmSwitch();
    case 'activate-llm': return activateLlm(el.dataset.model);
    case 'delete-llm': return deleteLlm(el.dataset.model);
    case 'confirm-delete-llm': return confirmDeleteLlm(el.dataset.model);
    case 'start-llm-pull': return startLlmPull();
    case 'cancel-llm-pull': return cancelLlmPull(el.dataset.jobId);

    // ── Graph ──
    case 'reload-graph': return reloadGraph();
    case 'start-graph-backfill': return startGraphBackfill();
    case 'delete-domain': return deleteDomain(el.dataset.domain);
    case 'confirm-delete-domain': return confirmDeleteDomain(el.dataset.domain);
    case 'open-manage-domain':
      return openManageDomain(
        el.dataset.domain,
        el.dataset.docCount,
        el.dataset.description,
        el.dataset.effectivePermission || 'admin',
      );
    case 'switch-manage-tab': return switchManageTab(el.dataset.tab);
    case 'confirm-delete-domain-doc': return confirmDeleteDomainDoc(el.dataset.docId);
    case 'cancel-delete-domain-doc': return cancelDeleteDomainDoc(el.dataset.docId);
    case 'execute-delete-domain-doc': return executeDeleteDomainDoc(el.dataset.docId);
    case 'add-manage-alias': return addManageAlias();
    case 'save-domain-description': return saveDomainDescription();
    case 'delete-current-domain': return deleteCurrentDomain();

    // ── Users ──
    case 'create-new-user': return createNewUser();
    case 'edit-user': {
      const u = USER_CACHE.get(el.dataset.username);
      if (u) return editUser(u);
      return showError('user record not found — reload the page');
    }
    case 'set-user-password': return setUserPassword(el.dataset.username);
    case 'invite-user': return inviteUser(el.dataset.username);
    case 'copy-invite-link': return copyInviteLink();
    case 'revoke-user': return revokeUser(el.dataset.username);
    case 'save-user-edit': return saveUserEdit(el.dataset.username);
    case 'confirm-set-user-password': return confirmSetUserPassword(el.dataset.username);
    case 'confirm-revoke-user': return confirmRevokeUser(el.dataset.username);
    case 'add-perm-row': return addPermRow();
    case 'remove-parent': {
      el.parentElement?.remove();
      return;
    }

    // ── Raw users editor ──
    case 'save-raw-users': return saveRawUsers();
    case 'load-raw-users': return loadRawUsers();

    // ── Services ──
    case 'test-ollama': return testOllama();
    case 'test-pgvector': return testPgvector();

    // ── Config ──
    case 'save-config': return saveConfig();
    case 'load-config': return loadConfig();
    case 'save-mail-config': return saveMailConfig();
    case 'load-mail-config': return loadMailConfig();
    case 'send-smtp-test': return sendSmtpTest();

    // ── Profile ──
    case 'save-profile-email': return saveProfileEmail();
    case 'clear-profile-email': return clearProfileEmail();
    case 'change-password': return changePassword();
    case 'rotate-key': return rotateKey();
    case 'confirm-rotate-key': return confirmRotateKey();

    // ── Import ──
    case 'import-url': return importUrl(el.dataset.domain);
  }
});

// ──────────────────────────────────────────────────────────────
// Init
// ──────────────────────────────────────────────────────────────
let _initStarted = false;
async function init() {
  if (_initStarted) return;
  _initStarted = true;

  // Build header with user info and sign-out
  const w = WHOAMI || {};
  const adminBadge = w.global_admin ? `<span class="badge badge-yellow">admin</span>` : '';
  const domainCount = Object.keys(w.domains || {}).length;
  const domainSummary = w.global_admin
    ? 'all domains'
    : domainCount
      ? `${domainCount} domain${domainCount > 1 ? 's' : ''}`
      : 'no domain access';
  document.getElementById('whoami').innerHTML =
    `<code>${escapeHtml(w.username || '?')}</code> ${adminBadge} &middot; ${escapeHtml(domainSummary)} &middot; ` +
    `<a href="#" data-action="sign-out" style="color:var(--muted)">Sign out</a>`;

  // Hide admin-only tabs for regular users
  if (!w.global_admin) {
    for (const tabName of ADMIN_ONLY_TABS) {
      const link = document.querySelector(`#nav a[data-tab="${tabName}"]`);
      if (link) link.style.display = 'none';
    }
  }

  // Populate the LLM provider badge once on sign-in. switchTab() refreshes it
  // when the operator navigates to LLMs or Config (where the model may change).
  refreshLlmBadge();

  // Show the Chat link iff the server reports chat_enabled. The link points
  // to /auth/openwebui-handoff (full-window navigation, not an iframe), which
  // signs a short-lived SSO token and 302s to the Open WebUI proxy origin.
  const chatLink = document.getElementById('nav-chat');
  if (chatLink && w.chat_enabled) chatLink.style.display = '';

  // Warn when signed in via the bootstrap brain-key (no real user yet)
  if (isBootstrapUser()) {
    const header = document.querySelector('header');
    const warn = document.createElement('div');
    warn.className = 'card';
    warn.style.cssText = 'background: rgba(251,191,36,0.08); border-color: var(--yellow); margin-bottom: 1rem';
    warn.innerHTML = `<strong style="color:var(--yellow)">⚠ Signed in with the bootstrap brain-key.</strong>
      <div style="color:var(--muted); font-size:0.85rem; margin-top:0.25rem">
        Create a real admin user under the <strong>Users</strong> tab and sign in as that user.
        The bootstrap account cannot set a password or hold an API key.
      </div>`;
    header.insertAdjacentElement('afterend', warn);
  }

  // Route to current tab (fall through to overview if admin-only was requested by a non-admin)
  const requested = window.location.hash.slice(1) || 'overview';
  const target = (!w.global_admin && ADMIN_ONLY_TABS.has(requested)) ? 'overview' : requested;
  switchTab(target);

  // Auto-refresh overview + processes every 10s
  setInterval(() => {
    const active = document.querySelector('#nav a.active')?.dataset.tab;
    if (active === 'overview' || active === 'processes') LOADERS[active]?.();
  }, 10000);
}

// Boot: ask the server who we are via session cookie; show login if unauthenticated
(async function boot() {
  if (await maybeShowReset()) return;
  try {
    const r = await fetch(`${BASE}/auth/me`, { credentials: 'include' });
    if (r.status === 401) { showLogin(); return; }
    if (!r.ok) { showLogin(`Auth check failed: HTTP ${r.status}`); return; }
    WHOAMI = await r.json();
    // Can't distinguish bootstrap from a real _admin user here; assume real unless
    // the user just logged in as bootstrap (then USING_BOOTSTRAP was set in attemptLogin).
    hideLogin();
    await init();
  } catch (e) {
    showLogin(`Server unreachable: ${e.message}`);
  }
})();
