// OB2 Graph Explorer — full-screen Cytoscape.js + fcose layout
// Auth uses the same cookie-based pattern as dashboard.js.

const BASE = window.location.origin;

const GRAPH_TYPE_COLORS = {
  PERSON:  '#60a5fa',
  ORG:     '#fbbf24',
  PLACE:   '#34d399',
  PRODUCT: '#f472b6',
  EVENT:   '#a78bfa',
  CONCEPT: '#9ca3af',
  OTHER:   '#6b7280',
};
const ALL_TYPES = Object.keys(GRAPH_TYPE_COLORS);

let WHOAMI = null;
let cy = null;
let currentDomain = null;
let rawEntities = [];
let rawEdges = [];

// ─── Boot ──────────────────────────────────────────────────────────────────

(async function boot() {
  const r = await fetch(`${BASE}/auth/me`, { credentials: 'include' });
  if (!r.ok) { window.location.href = '/dashboard'; return; }
  WHOAMI = await r.json();
  await initPage();
})();

// ─── Init ──────────────────────────────────────────────────────────────────

async function initPage() {
  // Populate domain dropdown
  let doms;
  try {
    const r = await fetch(`${BASE}/admin/domains`, { credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    doms = await r.json();
  } catch (e) {
    setStatus(`Failed to load domains: ${e.message}`);
    return;
  }

  const readable = (doms.domains || []).filter((d) => d.effective_permission);
  const sel = document.getElementById('domain-select');
  if (!readable.length) {
    sel.innerHTML = '<option value="">(no readable domains)</option>';
    setStatus('No readable domains.');
    return;
  }
  for (const d of readable) {
    const opt = document.createElement('option');
    opt.value = d.domain;
    opt.textContent = `@${d.domain}`;
    sel.appendChild(opt);
  }

  // Pre-select from ?domain= query param
  const params = new URLSearchParams(window.location.search);
  const requested = params.get('domain');
  if (requested && readable.some((d) => d.domain === requested)) {
    sel.value = requested;
  }

  // Render type filter checkboxes
  const tf = document.getElementById('type-filters');
  for (const type of ALL_TYPES) {
    const id = `tf-${type}`;
    const lbl = document.createElement('label');
    lbl.htmlFor = id;
    lbl.innerHTML =
      `<input type="checkbox" id="${id}" value="${type}" checked>` +
      `<span class="dot" style="background:${GRAPH_TYPE_COLORS[type]}"></span>${type}`;
    tf.appendChild(lbl);
    lbl.querySelector('input').addEventListener('change', applyFilters);
  }

  // Event listeners
  sel.addEventListener('change', () => loadGraph(sel.value));
  document.getElementById('search-box').addEventListener('input', applyFilters);
  document.getElementById('layout-btn').addEventListener('click', runLayout);

  await loadGraph(sel.value);
}

// ─── Load ──────────────────────────────────────────────────────────────────

async function loadGraph(domain) {
  if (!domain) return;
  currentDomain = domain;
  setStatus('Loading graph…');
  document.getElementById('panel-content').innerHTML =
    '<div style="color:var(--muted)">Click a node to see details.</div>';

  // Update GEXF export link
  const gexfBtn = document.getElementById('export-gexf-btn');
  gexfBtn.href = `${BASE}/admin/domains/${encodeURIComponent(domain)}/graph/export.gexf`;
  gexfBtn.setAttribute('download', `${domain}-graph.gexf`);

  try {
    const [eRes, edRes] = await Promise.all([
      fetchJson(`/admin/domains/${encodeURIComponent(domain)}/graph/entities?limit=500`),
      fetchJson(`/admin/domains/${encodeURIComponent(domain)}/graph/edges?limit=2000`),
    ]);
    rawEntities = (eRes && eRes.entities) || [];
    rawEdges = (edRes && edRes.edges) || [];
  } catch (e) {
    setStatus(`Error: ${e.message}`);
    return;
  }

  applyFilters();
}

// ─── Filter + render ───────────────────────────────────────────────────────

function applyFilters() {
  const checkedTypes = new Set(
    [...document.querySelectorAll('#type-filters input:checked')].map((el) => el.value),
  );
  const q = (document.getElementById('search-box').value || '').toLowerCase().trim();

  const entities = rawEntities.filter(
    (e) => checkedTypes.has(e.type) && (!q || e.name.toLowerCase().includes(q)),
  );
  const entityIds = new Set(entities.map((e) => e.entity_id));
  const edges = rawEdges.filter((e) => entityIds.has(e.src_id) && entityIds.has(e.dst_id));

  buildCytoscape(entities, edges);
  setStatus(`${entities.length} nodes · ${edges.length} edges`);
}

// ─── Cytoscape ─────────────────────────────────────────────────────────────

function buildCytoscape(entities, edges) {
  const container = document.getElementById('graph-canvas');
  if (cy) { try { cy.destroy(); } catch { /* ignore */ } cy = null; }

  if (!entities.length) {
    container.innerHTML =
      '<div style="padding:2rem;color:var(--muted)">No entities match the current filter.</div>';
    drawLegend();
    return;
  }
  container.innerHTML = '';

  const elements = [
    ...entities.map((e) => ({
      data: {
        id: e.entity_id,
        label: e.name,
        type: e.type,
        mention_count: e.mention_count,
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

  cy = cytoscape({
    container,
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
        selector: 'node.highlighted',
        style: { 'border-width': 3, 'border-color': '#38bdf8' },
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
    layout: {
      name: 'cose',
      animate: false,
      numIter: 500,
      nodeRepulsion: 400000,
      idealEdgeLength: 100,
      edgeElasticity: 100,
      gravity: 80,
      fit: true,
      padding: 40,
    },
    minZoom: 0.05,
    maxZoom: 5,
    wheelSensitivity: 0.2,
  });

  cy.on('tap', 'node', (evt) => handleNodeClick(evt.target));

  drawLegend();
}

// ─── Re-layout ─────────────────────────────────────────────────────────────

function runLayout() {
  if (!cy) return;
  const btn = document.getElementById('layout-btn');
  btn.disabled = true;
  btn.textContent = 'Running…';
  cy.layout({
    name: 'cose',
    animate: false,
    numIter: 2000,
    nodeRepulsion: 400000,
    idealEdgeLength: 100,
    edgeElasticity: 100,
    gravity: 80,
    fit: true,
    padding: 40,
    stop: () => {
      btn.disabled = false;
      btn.textContent = 'Run Layout';
    },
  }).run();
}

// ─── Node click ────────────────────────────────────────────────────────────

async function handleNodeClick(node) {
  // Highlight selected node
  cy.nodes().removeClass('highlighted');
  node.addClass('highlighted');

  const panel = document.getElementById('panel-content');
  panel.innerHTML = '<div style="color:var(--muted)">Loading…</div>';

  const eid = node.data('id');
  const domain = currentDomain;
  try {
    const r = await fetchJson(
      `/admin/domains/${encodeURIComponent(domain)}/graph/entities/${encodeURIComponent(eid)}/docs?limit=20`,
    );
    const docs = (r && r.docs) || [];
    const docsHtml = docs.length
      ? docs.map((d) =>
          `<div style="padding:0.4rem 0;border-bottom:1px solid var(--border)">` +
          `<div style="font-family:monospace;font-size:0.72rem;color:var(--muted)">${escHtml(d.doc_id)}</div>` +
          `<div style="margin-top:0.2rem;font-size:0.83rem">${escHtml(d.snippet || '')}</div>` +
          `<div style="font-size:0.72rem;color:var(--muted);margin-top:0.2rem">${escHtml(d.created_at || '')}</div>` +
          `</div>`,
        ).join('')
      : '<div style="color:var(--muted)">No docs found.</div>';
    panel.innerHTML =
      `<div style="font-weight:bold;font-size:0.95rem">${escHtml(node.data('label'))}</div>` +
      `<div style="color:var(--muted);font-size:0.8rem;margin-top:0.15rem">` +
      `${escHtml(node.data('type'))} · ${node.data('mention_count')} mentions</div>` +
      `<hr style="border-color:var(--border);margin:0.5rem 0">` +
      docsHtml;
  } catch (err) {
    panel.innerHTML = `<div style="color:#f87171">${escHtml(err.message || String(err))}</div>`;
  }
}

// ─── Legend ────────────────────────────────────────────────────────────────

function drawLegend() {
  const el = document.getElementById('legend');
  el.innerHTML = ALL_TYPES.map(
    (t) =>
      `<span><span class="dot" style="background:${GRAPH_TYPE_COLORS[t]}"></span>${t}</span>`,
  ).join('');
}

// ─── Helpers ───────────────────────────────────────────────────────────────

async function fetchJson(path) {
  const r = await fetch(`${BASE}${path}`, { credentials: 'include' });
  if (!r.ok) throw new Error(`HTTP ${r.status} on ${path}`);
  return r.json();
}

function setStatus(msg) {
  const el = document.getElementById('status-text');
  if (el) el.textContent = msg;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
