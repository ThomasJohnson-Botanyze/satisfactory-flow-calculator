'use strict';
const DATA = require('./data.json');
const LP = require('./solver-lp');
const SAVE = require('./save-reader');
const BMETA = require('./building-meta');

// ---------- support links ----------
const SUPPORT_LINKS = {
  kofi: 'https://ko-fi.com/satisfactoryflow',
};
// shell.openExternal in Electron; window.open fallback if ever bundled for web
let _shell = null;
try { ({ shell: _shell } = require('electron')); } catch (_) { /* non-Electron host */ }
const openExternal = (url) => { if (_shell && _shell.openExternal) _shell.openExternal(url); else window.open(url, '_blank', 'noopener'); };

// ---------- indexes ----------
const ITEMS = DATA.items;
const RECIPES = DATA.recipes;
const BUILDINGS = DATA.buildings;
const RESOURCES = new Set(DATA.resources);
const SVGNS = 'http://www.w3.org/2000/svg';

const itemName = (c) => (ITEMS[c] ? ITEMS[c].name : c);
const isFluid = (c) => !!(ITEMS[c] && ITEMS[c].liquid);
const isDeliverable = (c) => /Desc_SpaceElevatorPart_\d+_C/.test(c);

// exact Satisfactory Advanced Game Settings value lists
const GAME = {
  recipe: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
  power: [0.25, 0.5, 0.75, 1, 2, 5],
  space: [0.25, 0.5, 0.75, 1, 2, 5, 10, 25, 50, 100],
};

const recipesByProduct = {};
const recipesByPrimary = {};
for (const rc in RECIPES) {
  const r = RECIPES[rc];
  r.products.forEach((p, idx) => {
    (recipesByProduct[p.item] = recipesByProduct[p.item] || []).push(rc);
    if (idx === 0) (recipesByPrimary[p.item] = recipesByPrimary[p.item] || []).push(rc);
  });
}
function defaultRecipeClass(item) {
  const cands = recipesByPrimary[item] || [];
  return cands.filter((rc) => !RECIPES[rc].alternate)[0] || null;
}
// Is recipe rc usable given the unlocked-from-save filter? Standard recipes are
// always available; alternates only when no save is loaded (state.unlockedAlts
// null) or when present in the unlocked list.
function altUnlocked(rc) {
  const r = RECIPES[rc];
  if (!r || !r.alternate) return true;
  if (!state.unlockedAlts) return true;
  return state.unlockedAlts.includes(rc);
}
const ALT_CLASSES = Object.keys(RECIPES).filter((rc) => RECIPES[rc].alternate);
// Effective gate = unlocked by the save AND not manually excluded by the user.
function altEnabled(rc) {
  const r = RECIPES[rc];
  if (!r || !r.alternate) return true;
  if ((state.disabledAlts || []).includes(rc)) return false;
  return altUnlocked(rc);
}
// Set of alternates the solver may use, or null when there is no restriction at all.
function effectiveAltSet() {
  const disabled = state.disabledAlts || [];
  if (!state.unlockedAlts && !disabled.length) return null;
  const base = state.unlockedAlts || ALT_CLASSES;
  return new Set(base.filter((rc) => !disabled.includes(rc)));
}
const targetable = Object.keys(recipesByPrimary).map((c) => ({ c, n: itemName(c) })).sort((a, b) => a.n.localeCompare(b.n));
const resList = [...RESOURCES].map((c) => ({ c, n: itemName(c) })).sort((a, b) => a.n.localeCompare(b.n));
const nameToClass = (name) => {
  const k = (name || '').trim().toLowerCase();
  const hit = targetable.find((t) => t.n.toLowerCase() === k);
  return hit ? hit.c : '';
};

// ---------- state ----------
const defaultState = () => ({
  mode: 'planner',
  view: 'tables',
  targetItem: '',
  targetRate: 60,
  clock: 1.0,
  sloop: 1.0,
  recipeCost: 1,
  powerMult: 1,
  spaceMult: 1,
  picks: {},
  // Per-step overclock overrides, keyed by recipe className (rc -> clock fraction).
  // Absent = that step follows the global Overclock slider (state.clock).
  nodeClock: {},
  flowPos: {}, // saved flowchart node positions for this plan (nodeId -> {x,y})
  flowView: null, // saved flowchart zoom/pan for this plan ({k, tx, ty}); null = fit on render
  // null = no save loaded → every alternate available (original behavior).
  // [] = a save was read but no alternates unlocked. [...classNames] = restrict to these.
  unlockedAlts: null,
  saveName: '',
  // Alternate recipe classNames the user has manually excluded from this plan's
  // calculations (independent of unlock status — vetoes even unlocked/optimal ones).
  disabledAlts: [],
  opt: {
    outputs: [{ name: '', rate: 60 }],
    inputs: Object.fromEntries(resList.map((r) => [r.c, { on: true, cap: '' }])),
    objective: 'raw',
    alts: true,
  },
  max: { supply: [{ item: resList[0] ? resList[0].c : '', amount: 120 }], product: '', alts: true },
});
let state = defaultState();

// ---------- factory plans (multiple saved calculators) ----------
let plans = [];
let activeId = null;
const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const activePlan = () => plans.find((p) => p.id === activeId);

const LS_KEY = 'satisfactory-flow-plan-v3'; // legacy single-plan store (migration source)
const PLANS_KEY = 'satisfactory-factory-plans-v1'; // multi-plan store

// Settings that belong to the whole game/world rather than one factory — they
// carry over across every plan: the game-save unlocked alternates and the three
// cost multipliers. (disabledAlts stays per-plan: a manual veto for that factory.)
const GLOBAL_KEYS = ['recipeCost', 'powerMult', 'spaceMult', 'unlockedAlts', 'saveName'];
const cloneVal = (v) => (Array.isArray(v) ? v.slice() : v);
const pickGlobals = (s) => { const g = {}; for (const k of GLOBAL_KEYS) g[k] = cloneVal(s[k]); return g; };
const applyGlobals = (s, g) => { for (const k of GLOBAL_KEYS) if (k in g) s[k] = cloneVal(g[k]); };
// Mirror the active plan's global settings into every plan; returns the snapshot.
const syncGlobals = () => { const g = pickGlobals(state); for (const p of plans) applyGlobals(p.state, g); return g; };

function mergeState(s) {
  const m = Object.assign(defaultState(), s || {});
  m.opt = Object.assign(defaultState().opt, (s && s.opt) || {});
  m.max = Object.assign(defaultState().max, (s && s.max) || {});
  return m;
}
const save = () => {
  try {
    const globals = syncGlobals(); // keep world-level settings identical across plans
    localStorage.setItem(PLANS_KEY, JSON.stringify({ plans: plans.map((p) => ({ id: p.id, name: p.name, state: p.state })), activeId, globals }));
  } catch (e) {}
};
function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(PLANS_KEY));
    if (raw && Array.isArray(raw.plans) && raw.plans.length) {
      plans = raw.plans.map((p) => ({ id: p.id || newId(), name: p.name || 'Factory', state: mergeState(p.state) }));
      activeId = plans.some((p) => p.id === raw.activeId) ? raw.activeId : plans[0].id;
      state = activePlan().state;
      // Shared settings carry across plans: use the saved snapshot, else adopt the
      // active plan's values (first run after upgrade) and propagate to the rest.
      if (raw.globals) for (const p of plans) applyGlobals(p.state, raw.globals);
      else syncGlobals();
      return;
    }
  } catch (e) {}
  // migrate legacy single plan, else start with one blank plan
  let legacy = null;
  try { const s = JSON.parse(localStorage.getItem(LS_KEY)); if (s && typeof s === 'object') legacy = mergeState(s); } catch (e) {}
  plans = [{ id: newId(), name: 'Factory 1', state: legacy || defaultState() }];
  activeId = plans[0].id;
  state = plans[0].state;
}

function newPlan(name) {
  const p = { id: newId(), name: name || `Factory ${plans.length + 1}`, state: defaultState() };
  applyGlobals(p.state, pickGlobals(state)); // inherit shared game-save + cost settings
  plans.push(p);
  switchPlan(p.id);
}
function duplicatePlan(id) {
  const src = plans.find((p) => p.id === id) || activePlan();
  const p = { id: newId(), name: src.name + ' copy', state: mergeState(JSON.parse(JSON.stringify(src.state))) };
  plans.push(p);
  switchPlan(p.id);
}
function deletePlan(id) {
  const idx = plans.findIndex((p) => p.id === id);
  if (idx < 0) return;
  if (plans.length > 1 && typeof confirm === 'function' && !confirm(`Delete plan "${plans[idx].name}"?`)) return;
  plans.splice(idx, 1);
  if (!plans.length) plans.push({ id: newId(), name: 'Factory 1', state: defaultState() });
  if (id === activeId) activeId = plans[Math.max(0, idx - 1)].id;
  switchPlan(activeId);
}
function renamePlan(id, name) { const p = plans.find((x) => x.id === id); if (p && name) { p.name = name; save(); renderPlanBar(); } }
function switchPlan(id) {
  activeId = id;
  state = activePlan().state;
  save();
  renderPlanBar();
  applyStateToControls();
}

// ---------- planner solver ----------
function chosenRecipeClass(item) {
  const pick = state.picks[item];
  if (pick === 'RAW') return null;
  // A picked alternate that's locked by the save or manually excluded falls back to default.
  if (pick && RECIPES[pick] && altEnabled(pick)) return pick;
  if (RESOURCES.has(item)) return null;
  return defaultRecipeClass(item);
}
// Overclock applied to one step: its per-step override, else the global slider.
function effectiveClock(rc) {
  const o = state.nodeClock && state.nodeClock[rc];
  return o != null && isFinite(o) && o > 0 ? o : state.clock;
}
function computePlanner() {
  const target = state.targetItem;
  const tRate = state.targetRate * (isDeliverable(target) ? state.spaceMult : 1);
  const empty = { ok: !!target, feasible: true, recipes: [], raw: [], surplus: [], totalPower: 0, totalMachines: 0, targets: target ? { [target]: tRate } : {} };
  if (!target || !(tRate > 0)) return empty;

  // Walk the chosen-recipe graph from the target. We track visited *items* (not a
  // DFS path), so loops terminate instead of being cut — the LP then balances the
  // whole graph at once, crediting by-products and resolving recycle cycles.
  const usedRc = new Set();
  const rawItems = new Set();
  const chosenItemOf = {}; // rc -> the item whose dropdown selected it (row label)
  const seen = new Set();
  const stack = [target];
  while (stack.length) {
    const item = stack.pop();
    if (seen.has(item)) continue;
    seen.add(item);
    const rc = chosenRecipeClass(item);
    if (!rc) { rawItems.add(item); continue; } // resource or ⛏ Raw input
    if (chosenItemOf[rc] == null) chosenItemOf[rc] = item;
    if (!usedRc.has(rc)) {
      usedRc.add(rc);
      for (const ing of RECIPES[rc].ingredients) if (!seen.has(ing.item)) stack.push(ing.item);
    }
  }
  // Target is itself a raw/imported item — nothing to build.
  if (!usedRc.size) return Object.assign({}, empty, { raw: [{ item: target, rate: tRate }] });

  const sol = LP.planner({ target, rate: tRate, recipes: [...usedRc], rawItems: [...rawItems], recipeCost: state.recipeCost });
  if (!sol.feasible) return Object.assign({}, empty, { feasible: false });

  let totalPower = 0;
  let totalMachines = 0;
  const recipes = sol.recipes.filter((s) => s.machines > 1e-9).map((s) => {
    const r = RECIPES[s.rc];
    const b = BUILDINGS[r.building] || { name: r.building, power: 0, exponent: 1.321929, speed: 1 };
    const item = chosenItemOf[s.rc] || s.item;
    const m100 = s.machines; // machine-equivalents at 100 % clock / 1× sloop
    const ck = effectiveClock(s.rc);
    const machines = m100 / (ck * state.sloop);
    const powerPer = b.power * Math.pow(ck, b.exponent) * Math.pow(state.sloop, 2) * state.powerMult;
    const power = machines * powerPer;
    const rate = (LP.RC_INFO[s.rc].out[item] || 0) * m100; // gross /min of the row's item
    totalPower += power;
    totalMachines += Math.ceil(machines - 1e-9);
    return { item, rc: s.rc, machines, building: r.building, buildingName: b.name, rate, power, clock: ck, interactive: true };
  });
  return {
    ok: true,
    feasible: true,
    recipes,
    raw: (sol.raw || []).filter((r) => r.rate > 1e-4),
    surplus: (sol.outputs || []).filter((o) => o.item !== target && o.rate > 1e-4),
    totalPower,
    totalMachines,
    targets: { [target]: tRate },
  };
}

// ---------- formatting ----------
function fmt(n, d = 2) {
  if (!isFinite(n)) return '∞';
  return (Math.round(n * 10 ** d) / 10 ** d).toLocaleString(undefined, { maximumFractionDigits: d });
}
const fmtPower = (mw) => (mw >= 1000 ? fmt(mw / 1000, 2) + ' GW' : fmt(mw, 1) + ' MW');
const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

// ---------- table rendering ----------
function recipeOptionLabel(rc) {
  const r = RECIPES[rc];
  const ing = r.ingredients.map((i) => `${fmt(i.amount, 0)} ${itemName(i.item)}`).join(' + ');
  return `${r.alternate ? '★ ' : ''}${r.name}  (${ing || 'raw'})`;
}
function recipeSelect(item, currentRc) {
  const sel = el('select', 'recipe-select');
  const cands = (recipesByProduct[item] || []).filter((rc) => altEnabled(rc) || rc === currentRc).sort((a, b) => {
    const ra = RECIPES[a], rb = RECIPES[b];
    if (ra.alternate !== rb.alternate) return ra.alternate ? 1 : -1;
    return ra.name.localeCompare(rb.name);
  });
  for (const rc of cands) {
    const o = el('option', null, recipeOptionLabel(rc));
    o.value = rc;
    if (rc === currentRc) o.selected = true;
    sel.appendChild(o);
  }
  const rawO = el('option', null, '⛏ Raw input (do not produce)');
  rawO.value = 'RAW';
  if (state.picks[item] === 'RAW') rawO.selected = true;
  sel.appendChild(rawO);
  if (currentRc && RECIPES[currentRc] && RECIPES[currentRc].alternate) sel.classList.add('alt');
  sel.addEventListener('change', () => { state.picks[item] = sel.value; save(); solveAndRender(); });
  return sel;
}
function itemCell(item) {
  const span = el('span', 'item-cell');
  span.appendChild(el('span', 'dot' + (isFluid(item) ? ' fluid' : '')));
  span.appendChild(document.createTextNode(itemName(item)));
  return span;
}
// Per-step overclock editor (Planner rows). Typing the global value clears the
// override so the step tracks the global slider again.
function clockCell(s) {
  const td = el('td', 'num');
  if (!s.interactive) { td.textContent = '—'; return td; }
  const inp = el('input', 'clock-input');
  inp.type = 'number'; inp.min = '1'; inp.max = '250'; inp.step = '1';
  inp.value = Math.round((s.clock || state.clock) * 100);
  inp.title = 'Overclock this step independently of the global slider';
  const apply = () => {
    let v = Math.round(parseFloat(inp.value) || 100);
    v = Math.max(1, Math.min(250, v));
    inp.value = v;
    state.nodeClock = state.nodeClock || {};
    if (v === Math.round(state.clock * 100)) delete state.nodeClock[s.rc];
    else state.nodeClock[s.rc] = v / 100;
    save();
    solveAndRender();
  };
  inp.addEventListener('change', apply);
  td.appendChild(inp);
  td.appendChild(document.createTextNode(' %'));
  return td;
}
function renderTables(res) {
  const tb = $('prodTable').querySelector('tbody');
  tb.innerHTML = '';
  res.recipes.slice().sort((a, b) => itemName(a.item).localeCompare(itemName(b.item))).forEach((s) => {
    const tr = el('tr');
    const tdItem = el('td'); tdItem.appendChild(itemCell(s.item)); tr.appendChild(tdItem);
    const tdRec = el('td');
    if (s.interactive) tdRec.appendChild(recipeSelect(s.item, s.rc));
    else { const r = RECIPES[s.rc]; tdRec.appendChild(el('span', null, r.name)); if (r.alternate) tdRec.appendChild(el('span', 'tag-alt', 'ALT')); }
    tr.appendChild(tdRec);
    tr.appendChild(el('td', 'num', `${fmt(s.rate)} ${isFluid(s.item) ? 'm³' : ''}/min`));
    const tdM = el('td', 'num');
    tdM.innerHTML = `<span class="mach-main">${fmt(Math.ceil(s.machines - 1e-9), 0)}×</span> <span class="mach-sub">(${fmt(s.machines)})</span>`;
    tr.appendChild(tdM);
    tr.appendChild(clockCell(s));
    tr.appendChild(el('td', null, s.buildingName));
    tr.appendChild(el('td', 'num', fmtPower(s.power)));
    tb.appendChild(tr);
  });

  const rtb = $('rawTable').querySelector('tbody');
  rtb.innerHTML = '';
  res.raw.slice().sort((a, b) => itemName(a.item).localeCompare(itemName(b.item))).forEach((r) => {
    const tr = el('tr');
    const td = el('td'); td.appendChild(itemCell(r.item)); tr.appendChild(td);
    tr.appendChild(el('td', 'num', fmt(r.rate)));
    rtb.appendChild(tr);
  });
  if (!res.raw.length) rtb.innerHTML = '<tr><td colspan="2" style="color:var(--muted)">None</td></tr>';

  const bld = {};
  for (const s of res.recipes) {
    bld[s.building] = bld[s.building] || { name: s.buildingName, count: 0, power: 0 };
    bld[s.building].count += s.machines;
    bld[s.building].power += s.power;
  }
  const btb = $('bldTable').querySelector('tbody');
  btb.innerHTML = '';
  Object.values(bld).sort((a, b) => b.power - a.power).forEach((b) => {
    const tr = el('tr');
    tr.appendChild(el('td', null, b.name));
    const c = el('td', 'num'); c.innerHTML = `${fmt(Math.ceil(b.count - 1e-9), 0)}× <span class="mach-sub">(${fmt(b.count)})</span>`;
    tr.appendChild(c);
    tr.appendChild(el('td', 'num', fmtPower(b.power)));
    btb.appendChild(tr);
  });
  if (!Object.keys(bld).length) btb.innerHTML = '<tr><td colspan="3" style="color:var(--muted)">None</td></tr>';

  const sur = res.surplus || [];
  $('byprodWrap').hidden = sur.length === 0;
  const ytb = $('byprodTable').querySelector('tbody');
  ytb.innerHTML = '';
  sur.slice().sort((a, b) => itemName(a.item).localeCompare(itemName(b.item))).forEach((s) => {
    const tr = el('tr');
    const td = el('td'); td.appendChild(itemCell(s.item)); tr.appendChild(td);
    tr.appendChild(el('td', 'num', fmt(s.rate)));
    ytb.appendChild(tr);
  });

  $('sumPower').textContent = fmtPower(res.totalPower);
  $('sumMachines').textContent = fmt(res.totalMachines, 0);
}

// ---------- flowchart ----------
let lastResult = null;
let lastTargets = null;
let currentFlow = null; // last laid-out flow, for zoom/fit buttons to re-apply without rebuilding

function buildFlow(res, targets) {
  const nodes = [];
  const byId = {};
  const edges = [];
  const addNode = (id, kind, title, sub) => {
    if (!byId[id]) { const n = { id, kind, title, sub, ins: [], outs: [] }; nodes.push(n); byId[id] = n; }
    return byId[id];
  };
  // stable id keyed by recipe class so saved drag positions survive re-solves
  res.recipes.forEach((s, i) => {
    s._nid = 'mac|' + (s.rc || i);
    const r = RECIPES[s.rc];
    // Alternate recipes show the recipe name; standard recipes show the output item.
    const title = r && r.alternate ? '★ ' + r.name.replace(/^Alternate:\s*/, '') : itemName(s.item);
    // Exact (fractional) machine count for perfect-ratio / 100%-uptime planning,
    // e.g. "7.5× Assembler" = 7 machines at 100% + 1 at 50%. Append the clock only
    // when this step is overclocked away from the global slider.
    const oc = s.clock != null && Math.abs(s.clock - state.clock) > 1e-9 ? ` · ${Math.round(s.clock * 100)}%` : '';
    addNode(s._nid, 'machine', title, `${fmt(s.machines)}× ${s.buildingName}${oc}`);
  });
  res.raw.forEach((r) => addNode('raw|' + r.item, 'raw', itemName(r.item), fmt(r.rate) + '/min'));
  const producers = {};
  res.recipes.forEach((s) => { (producers[s.item] = producers[s.item] || []).push(s); });
  const addEdge = (srcId, dstId, item, rate) => {
    if (!byId[srcId] || !byId[dstId]) return;
    const e = { src: srcId, dst: dstId, label: `${itemName(item)} ${fmt(rate)}/min` };
    edges.push(e); byId[srcId].outs.push(e); byId[dstId].ins.push(e);
  };
  res.recipes.forEach((s) => {
    const r = RECIPES[s.rc];
    const prod = r.products.find((p) => p.item === s.item) || r.products[0];
    r.ingredients.forEach((ing) => {
      const total = (s.rate / prod.amount) * ing.amount * state.recipeCost;
      const provs = producers[ing.item];
      if (provs && provs.length) {
        const tot = provs.reduce((a, p) => a + p.rate, 0) || 1;
        provs.forEach((p) => addEdge(p._nid, s._nid, ing.item, total * (p.rate / tot)));
      } else addEdge('raw|' + ing.item, s._nid, ing.item, total);
    });
  });
  const outs = Object.assign({}, targets || {});
  (res.surplus || []).forEach((s) => { if (outs[s.item] == null) outs[s.item] = s.rate; });
  for (const item in outs) {
    const oid = 'out|' + item;
    addNode(oid, 'out', itemName(item), fmt(outs[item]) + '/min');
    const provs = producers[item];
    if (provs && provs.length) { const tot = provs.reduce((a, p) => a + p.rate, 0) || 1; provs.forEach((p) => addEdge(p._nid, oid, item, outs[item] * (p.rate / tot))); }
  }
  return { nodes, byId, edges };
}

function layoutFlow(flow) {
  const { nodes, byId } = flow;
  const col = {};
  const indeg = {};
  nodes.forEach((n) => (indeg[n.id] = n.ins.length));
  const q = nodes.filter((n) => indeg[n.id] === 0);
  q.forEach((n) => (col[n.id] = 0));
  let qi = 0;
  while (qi < q.length) {
    const n = q[qi++];
    n.outs.forEach((e) => {
      const d = byId[e.dst];
      col[d.id] = Math.max(col[d.id] || 0, (col[n.id] || 0) + 1);
      if (--indeg[d.id] === 0) q.push(d);
    });
  }
  nodes.forEach((n) => { if (col[n.id] == null) col[n.id] = 0; });
  const cols = {};
  nodes.forEach((n) => (cols[col[n.id]] = cols[col[n.id]] || []).push(n));
  // Wider columns so the per-minute edge labels fit between nodes; taller rows reduce label overlap.
  const COLW = 300, ROWH = 96, NW = 168, NH = 52, PADX = 28, PADY = 28;
  const saved = state.flowPos || {};
  Object.keys(cols).map(Number).sort((a, b) => a - b).forEach((c) => {
    cols[c].forEach((n, i) => {
      n.w = NW; n.h = NH;
      const sp = saved[n.id];
      if (sp && isFinite(sp.x) && isFinite(sp.y)) { n.x = sp.x; n.y = sp.y; }
      else { n.x = PADX + c * COLW; n.y = PADY + i * ROWH; }
    });
  });
  // size canvas to actual node extents (covers nodes dragged outside the grid)
  let mx = 0, my = 0;
  nodes.forEach((n) => { mx = Math.max(mx, n.x + n.w); my = Math.max(my, n.y + n.h); });
  flow.width = mx + PADX;
  flow.height = my + PADY;
  return flow;
}

function edgePath(e, byId) {
  const s = byId[e.src], d = byId[e.dst];
  const sx = s.x + s.w, sy = s.y + s.h / 2, dx = d.x, dy = d.y + d.h / 2;
  const mx = (sx + dx) / 2;
  return { d: `M ${sx} ${sy} C ${sx + 50} ${sy} ${dx - 50} ${dy} ${dx} ${dy}`, lx: mx, ly: (sy + dy) / 2 - 5 };
}

function drawFlow(flow) {
  const svg = $('flowSvg');
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  // SVG fills the container (1 user unit = 1px); zoom/pan is a transform on the root
  // <g> so the graph scales to the window instead of running off the right edge.
  svg.removeAttribute('viewBox');
  const root = document.createElementNS(SVGNS, 'g');
  root.setAttribute('id', 'flowRoot');
  const gEdges = document.createElementNS(SVGNS, 'g');
  const gNodes = document.createElementNS(SVGNS, 'g');
  root.appendChild(gEdges); root.appendChild(gNodes);
  svg.appendChild(root);

  flow.edges.forEach((e) => {
    const p = edgePath(e, flow.byId);
    const path = document.createElementNS(SVGNS, 'path');
    path.setAttribute('class', 'edge-path');
    path.setAttribute('d', p.d);
    gEdges.appendChild(path);
    const t = document.createElementNS(SVGNS, 'text');
    t.setAttribute('class', 'edge-label');
    t.setAttribute('x', p.lx); t.setAttribute('y', p.ly);
    t.setAttribute('text-anchor', 'middle');
    t.textContent = e.label;
    gEdges.appendChild(t);
    e._path = path; e._label = t;
  });

  flow.nodes.forEach((n) => {
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('class', 'node ' + n.kind);
    g.setAttribute('transform', `translate(${n.x},${n.y})`);
    const rect = document.createElementNS(SVGNS, 'rect');
    rect.setAttribute('width', n.w); rect.setAttribute('height', n.h);
    rect.setAttribute('rx', '7');
    g.appendChild(rect);
    const t1 = document.createElementNS(SVGNS, 'text');
    t1.setAttribute('class', 'n-title'); t1.setAttribute('x', 10); t1.setAttribute('y', 19);
    t1.textContent = n.title.length > 25 ? n.title.slice(0, 24) + '…' : n.title;
    g.appendChild(t1);
    const t2 = document.createElementNS(SVGNS, 'text');
    t2.setAttribute('class', 'n-sub'); t2.setAttribute('x', 10); t2.setAttribute('y', 35);
    t2.textContent = n.sub;
    g.appendChild(t2);
    n._g = g;
    gNodes.appendChild(g);
    attachDrag(g, n, flow);
  });
  ensureFlowControls();
}

function attachDrag(g, node, flow) {
  let last = null;
  g.addEventListener('pointerdown', (ev) => { last = { x: ev.clientX, y: ev.clientY }; g.setPointerCapture(ev.pointerId); g.classList.add('dragging'); ev.preventDefault(); });
  g.addEventListener('pointermove', (ev) => {
    if (!last) return;
    const k = (state.flowView && state.flowView.k) || 1; // screen px → world units under zoom
    node.x += (ev.clientX - last.x) / k;
    node.y += (ev.clientY - last.y) / k;
    last = { x: ev.clientX, y: ev.clientY };
    g.setAttribute('transform', `translate(${node.x},${node.y})`);
    [...node.ins, ...node.outs].forEach((e) => {
      const p = edgePath(e, flow.byId);
      e._path.setAttribute('d', p.d);
      e._label.setAttribute('x', p.lx); e._label.setAttribute('y', p.ly);
    });
  });
  const end = (ev) => {
    if (last) { state.flowPos = state.flowPos || {}; state.flowPos[node.id] = { x: node.x, y: node.y }; save(); }
    last = null; g.classList.remove('dragging');
    try { g.releasePointerCapture(ev.pointerId); } catch (e) {}
  };
  g.addEventListener('pointerup', end);
  g.addEventListener('pointercancel', end);
}

// ---------- flowchart zoom / pan ----------
const FLOW_MINK = 0.12, FLOW_MAXK = 2;
const clampFlowK = (k) => Math.max(FLOW_MINK, Math.min(FLOW_MAXK, k));
let flowSaveT = null;
const saveFlowViewSoon = () => { if (flowSaveT) return; flowSaveT = setTimeout(() => { flowSaveT = null; save(); }, 250); };

function applyFlowTransform() {
  const root = $('flowRoot'); if (!root) return;
  const v = state.flowView || { k: 1, tx: 0, ty: 0 };
  root.setAttribute('transform', `translate(${v.tx},${v.ty}) scale(${v.k})`);
  const pct = $('flowZoomPct'); if (pct) pct.textContent = Math.round(v.k * 100) + '%';
}

function flowViewport() {
  const svg = $('flowSvg'); if (!svg) return { w: 800, h: 440, left: 0, top: 0 };
  const r = svg.getBoundingClientRect();
  return { w: r.width || 800, h: r.height || 440, left: r.left, top: r.top };
}

// Scale the whole graph to fit the visible area, centered — never upscaled past 100% —
// so even big factories show end-to-end with nothing clipped off the right.
function fitFlow(flow) {
  if (!flow) return;
  const vp = flowViewport(), m = 24;
  const k = clampFlowK(Math.min((vp.w - 2 * m) / Math.max(1, flow.width), (vp.h - 2 * m) / Math.max(1, flow.height), 1));
  state.flowView = { k, tx: (vp.w - k * flow.width) / 2, ty: (vp.h - k * flow.height) / 2 };
  applyFlowTransform();
}

// Zoom by `factor` keeping the world point under (sx,sy) — screen px from the svg
// top-left — fixed on screen, so it zooms toward the cursor.
function zoomFlowAt(sx, sy, factor) {
  const v = state.flowView || { k: 1, tx: 0, ty: 0 };
  const nk = clampFlowK(v.k * factor);
  state.flowView = { k: nk, tx: sx - nk * (sx - v.tx) / v.k, ty: sy - nk * (sy - v.ty) / v.k };
  applyFlowTransform();
  saveFlowViewSoon();
}
function zoomFlowCenter(factor) { const vp = flowViewport(); zoomFlowAt(vp.w / 2, vp.h / 2, factor); }

// Wire pan (drag empty background) + wheel-zoom on the svg, once per element.
function ensureFlowControls() {
  const svg = $('flowSvg');
  if (!svg || svg._fcWired) return;
  svg._fcWired = true;
  let pan = null;
  svg.addEventListener('pointerdown', (ev) => {
    if (ev.target !== svg) return; // nodes handle their own drag; only blank space pans
    const v = state.flowView || { k: 1, tx: 0, ty: 0 };
    pan = { x: ev.clientX, y: ev.clientY, tx: v.tx, ty: v.ty };
    svg.setPointerCapture(ev.pointerId); svg.classList.add('panning');
  });
  svg.addEventListener('pointermove', (ev) => {
    if (!pan) return;
    const v = state.flowView || { k: 1, tx: 0, ty: 0 };
    state.flowView = { k: v.k, tx: pan.tx + (ev.clientX - pan.x), ty: pan.ty + (ev.clientY - pan.y) };
    applyFlowTransform();
  });
  const endPan = (ev) => {
    if (!pan) return;
    pan = null; svg.classList.remove('panning');
    try { svg.releasePointerCapture(ev.pointerId); } catch (_) {}
    save();
  };
  svg.addEventListener('pointerup', endPan);
  svg.addEventListener('pointercancel', endPan);
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const vp = flowViewport();
    zoomFlowAt(ev.clientX - vp.left, ev.clientY - vp.top, ev.deltaY < 0 ? 1.12 : 1 / 1.12);
  }, { passive: false });
}

function renderFlowView() {
  if (!lastResult) return;
  currentFlow = layoutFlow(buildFlow(lastResult, lastTargets));
  drawFlow(currentFlow);
  // Keep the saved zoom/pan across tab toggles; first render of a plan fits to window.
  if (state.flowView && isFinite(state.flowView.k)) applyFlowTransform();
  else {
    fitFlow(currentFlow); // first pass — may run before the just-shown panel has its final size
    // Re-fit next frame once layout settled, but only if the user hasn't taken over yet.
    const flow = currentFlow;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { if (flow === currentFlow) fitFlow(flow); });
  }
}
function applyView() {
  const flow = state.view === 'flow';
  $('flowView').hidden = !flow;
  $('tableView').hidden = flow;
  $('viewFlow').classList.toggle('active', flow);
  $('viewTables').classList.toggle('active', !flow);
  if (flow) renderFlowView();
}

// ---------- resource map ----------
// World coordinate bounds of the bundled 5000x5000 map render (Satisfactory Wiki).
// North is -Y, so the image top edge = MAP_BOUNDS.north. Values are the community
// standard used by the in-game map / SCIM (centimetres).
const MAP_BOUNDS = { west: -324698.832031, east: 425301.832031, north: -375000, south: 375000 };
const MAP_IMG_W = 5000, MAP_IMG_H = 5000;
const RES_COLORS = {
  Desc_OreIron_C: '#c2693f', Desc_OreCopper_C: '#e08a3a', Desc_Stone_C: '#cdbf95',
  Desc_Coal_C: '#586271', Desc_OreGold_C: '#e8c84a', Desc_RawQuartz_C: '#e08ad6',
  Desc_Sulfur_C: '#e6db4a', Desc_OreBauxite_C: '#b07a52', Desc_OreUranium_C: '#5fd35f',
  Desc_SAM_C: '#9b5fd3', Desc_LiquidOil_C: '#a98bd0', Desc_NitrogenGas_C: '#6fc0cf',
  Desc_Water_C: '#3f8fd9',
};
const KIND_COLOR = { geyser: '#efe9ff', frackingCore: '#a98bd0', frackingSatellite: '#8d79b8', deposit: '#9aa0a8', node: '#c9cdd3' };
const KIND_LABEL = { node: 'Resource node', geyser: 'Geyser', frackingCore: 'Resource well', frackingSatellite: 'Well satellite', deposit: 'Small deposit' };
const PURITY_R = { Pure: 6, Normal: 4.6, Impure: 3.4 };

let mapImg = null, mapImgReady = false;
let mapNodes = [];                 // resource nodes from the loaded save
let mapResOn = null;               // Set of enabled resourceClass keys ('__unknown' bucket allowed)
let mapKindOn = { geyser: true, frackingCore: true, deposit: false };
let mapV = { s: 1, ox: 0, oy: 0, ready: false };  // view transform: image px -> css px (screen = img*s + o)
let mapFitS = 1;                   // scale at which the whole map fits (zoom clamp reference)
let mapDrag = null;
let mapRAF = 0;

// ---------- factory buildings overlay (Cartograph-style) ----------
// Buildings are drawn as vectors every frame (not baked to an offscreen) so that
// thin belts/wires stay one screen-pixel wide at any zoom — exactly how the node
// markers keep a constant screen size. Image-space px per world cm (uniform on
// both axes): the 5000px render spans MAP_BOUNDS east-west = ~750000 cm.
const IMG_PX_PER_CM = MAP_IMG_W / (MAP_BOUNDS.east - MAP_BOUNDS.west);
// Default in-game customization swatch slot -> approximate paint color. Used only
// in "By paint" color mode; unknown/custom swatches fall back to a neutral grey.
const SWATCH_COLORS = {
  SwatchDesc_Slot0_C: '#e8a33d', SwatchDesc_Slot1_C: '#c64a3b', SwatchDesc_Slot2_C: '#d98b3a',
  SwatchDesc_Slot3_C: '#e0c84a', SwatchDesc_Slot4_C: '#7bbf48', SwatchDesc_Slot5_C: '#46b06a',
  SwatchDesc_Slot6_C: '#3fb59b', SwatchDesc_Slot7_C: '#3f9fd9', SwatchDesc_Slot8_C: '#4a6fd0',
  SwatchDesc_Slot9_C: '#7a5fd3', SwatchDesc_Slot10_C: '#b05fd0', SwatchDesc_Slot11_C: '#d05f9f',
  SwatchDesc_Slot12_C: '#8a939e', SwatchDesc_Slot13_C: '#5c6670', SwatchDesc_Slot14_C: '#3a4048',
  SwatchDesc_Slot15_C: '#cfd4da', SwatchDesc_Slot16_C: '#9a8c7a', SwatchDesc_Slot17_C: '#6b5b45',
  SwatchDesc_FoundationModern_C: '#9aa0a8', SwatchDesc_ProjectAssembly_C: '#e08a3a',
};
const CAT_LABEL = {
  production: 'Production', extraction: 'Extraction', power: 'Power', logistics: 'Logistics',
  storage: 'Storage', foundation: 'Foundations', vehicle: 'Vehicles', organization: 'Organization',
  decoration: 'Decoration', other: 'Other',
};
// Stroke width (screen px) per path kind; machine footprints use a min screen size.
const PATH_W = { belt: 1.7, pipe: 1.7, wire: 0.9 };
const MACHINE_MIN_PX = 3;          // smallest a footprint is drawn, so it stays visible when zoomed out

let mapBuildings = [];             // building records from the loaded save
let mapBuildShow = true;           // master overlay toggle
let mapBuildOpacity = 0.9;
let mapCatOn = null;               // Set of enabled categories (null => all on)
let mapColorMode = 'category';     // 'category' | 'paint'
let mapMarkClock = false;          // ring machines that are overclocked / somerslooped

function catVisible(cat) { return !mapCatOn || mapCatOn.has(cat); }
function buildingColor(b) {
  if (mapColorMode === 'paint') return SWATCH_COLORS[b.swatch] || '#8a8f98';
  return b._catColor || BMETA.buildingMeta(b.className).color;
}
// Annotate raw building records with stable render fields (category/footprint/
// color) once at load, so the per-frame draw loop does no metadata lookups.
function annotateBuildings(list) {
  for (const b of list) {
    const m = BMETA.buildingMeta(b.className);
    b._cat = m.category; b._w = m.w; b._d = m.d; b._catColor = m.color;
  }
  return list;
}
function buildingDisplayName(cn) {
  if (BUILDINGS[cn] && BUILDINGS[cn].name) return BUILDINGS[cn].name;
  return String(cn).replace(/^Build_/, '').replace(/_C$/, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\bMk(\d)/, 'Mk $1').trim();
}

function ensureMapImg() {
  if (mapImg) return;
  mapImg = new Image();
  mapImg.onload = () => { mapImgReady = true; if (state.mode === 'map') { if (!mapV.ready) fitMapView(); drawMap(); } };
  mapImg.onerror = () => { mapImgReady = false; if (state.mode === 'map') drawMap(); };
  mapImg.src = 'map.jpg'; // same dir as index.html -> same-origin, satisfies CSP 'self'
}
function worldToImgX(x) { return (x - MAP_BOUNDS.west) / (MAP_BOUNDS.east - MAP_BOUNDS.west) * MAP_IMG_W; }
function worldToImgY(y) { return (y - MAP_BOUNDS.north) / (MAP_BOUNDS.south - MAP_BOUNDS.north) * MAP_IMG_H; }
function resourceColor(n) { return (n.resourceClass && RES_COLORS[n.resourceClass]) || KIND_COLOR[n.kind] || '#bbb'; }

function resOn(n) {
  if (!mapResOn) return true;
  return mapResOn.has(n.resourceClass || '__unknown');
}
function nodeVisible(n) {
  switch (n.kind) {
    case 'geyser': return mapKindOn.geyser;
    case 'frackingCore':
    case 'frackingSatellite': return mapKindOn.frackingCore;
    case 'deposit': return mapKindOn.deposit && resOn(n);
    default: return resOn(n); // mineable 'node'
  }
}

function resizeMapCanvas() {
  const wrap = $('mapWrap'), cv = $('mapCanvas');
  const dpr = window.devicePixelRatio || 1;
  const cw = wrap.clientWidth || 1, ch = wrap.clientHeight || 1;
  cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
  cv.style.width = cw + 'px'; cv.style.height = ch + 'px';
  return { cw, ch, dpr };
}
function fitMapView() {
  const wrap = $('mapWrap'); if (!wrap) return;
  const cw = wrap.clientWidth || 800, ch = wrap.clientHeight || 600;
  const s = Math.min(cw / MAP_IMG_W, ch / MAP_IMG_H) * 0.98;
  mapFitS = s;
  mapV = { s, ox: (cw - MAP_IMG_W * s) / 2, oy: (ch - MAP_IMG_H * s) / 2, ready: true };
}
function scheduleMapDraw() { if (mapRAF) return; mapRAF = requestAnimationFrame(() => { mapRAF = 0; drawMap(); }); }

function drawMarker(ctx, n, ix, iy, s) {
  const base = PURITY_R[n.purity] || 4;
  const screenR = n.kind === 'deposit' ? 2.4 : n.kind === 'frackingSatellite' ? 3 : base;
  const r = screenR / s;
  ctx.beginPath();
  if (n.kind === 'geyser') { ctx.moveTo(ix, iy - r); ctx.lineTo(ix + r, iy); ctx.lineTo(ix, iy + r); ctx.lineTo(ix - r, iy); ctx.closePath(); }
  else if (n.kind === 'frackingCore') { ctx.rect(ix - r, iy - r, 2 * r, 2 * r); }
  else { ctx.arc(ix, iy, r, 0, Math.PI * 2); }
  ctx.fillStyle = resourceColor(n);
  ctx.fill();
  ctx.lineWidth = 1.3 / s; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.stroke();
  if (n.purity === 'Pure') { ctx.beginPath(); ctx.arc(ix, iy, r + 2.4 / s, 0, Math.PI * 2); ctx.lineWidth = 1.3 / s; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke(); }
}
// Visible image-space rect (with margin) for viewport culling. screen = img*s + o.
function visibleImgRect(cw, ch, mar) {
  const s = mapV.s;
  return {
    x0: (0 - mapV.ox) / s - mar, x1: (cw - mapV.ox) / s + mar,
    y0: (0 - mapV.oy) / s - mar, y1: (ch - mapV.oy) / s + mar,
  };
}
// Draw the factory-buildings overlay in IMAGE space (ctx already carries the map
// transform). Vector every frame, viewport-culled, with screen-constant stroke
// widths and a minimum footprint size so the layer reads at any zoom.
function drawBuildings(ctx, s, cw, ch) {
  if (!mapBuildShow || !mapBuildings.length) return;
  const vr = visibleImgRect(cw, ch, 200 / s);
  ctx.save();
  ctx.globalAlpha = mapBuildOpacity;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';

  // Pass 1: paths (belts / pipes / wires), under the machines.
  for (const b of mapBuildings) {
    if (b.kind === 'machine' || !b.path) continue;
    if (!catVisible(b._cat)) continue;
    const ax = worldToImgX(b.x), ay = worldToImgY(b.y);
    if (ax < vr.x0 || ax > vr.x1 || ay < vr.y0 || ay > vr.y1) continue; // cull by anchor point
    ctx.beginPath();
    for (let i = 0; i < b.path.length; i++) {
      const px = worldToImgX(b.path[i].x), py = worldToImgY(b.path[i].y);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = buildingColor(b);
    ctx.lineWidth = (PATH_W[b.kind] || 1.2) / s;
    ctx.stroke();
  }

  // Pass 2: machine footprints (rotated rectangles) on top.
  const minHalf = (MACHINE_MIN_PX / 2) / s;
  for (const b of mapBuildings) {
    if (b.kind !== 'machine') continue;
    if (!catVisible(b._cat)) continue;
    const ix = worldToImgX(b.x), iy = worldToImgY(b.y);
    if (ix < vr.x0 || ix > vr.x1 || iy < vr.y0 || iy > vr.y1) continue;
    const hw = Math.max(minHalf, (b._w * IMG_PX_PER_CM * (b.sx || 1)) / 2);
    const hd = Math.max(minHalf, (b._d * IMG_PX_PER_CM * (b.sy || 1)) / 2);
    ctx.save();
    ctx.translate(ix, iy);
    if (b.yaw) ctx.rotate(b.yaw);
    ctx.fillStyle = buildingColor(b);
    ctx.fillRect(-hw, -hd, 2 * hw, 2 * hd);
    ctx.lineWidth = 0.7 / s; ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.strokeRect(-hw, -hd, 2 * hw, 2 * hd);
    ctx.restore();
    if (mapMarkClock && (Math.abs((b.overclock || 1) - 1) > 1e-3 || (b.boost || 0) > 0)) {
      ctx.beginPath();
      ctx.arc(ix, iy, Math.max(hw, hd) + 2.2 / s, 0, Math.PI * 2);
      ctx.lineWidth = 1.4 / s;
      ctx.strokeStyle = (b.boost || 0) > 0 ? 'rgba(236,99,60,0.95)' : 'rgba(255,255,255,0.9)';
      ctx.stroke();
    }
  }
  ctx.restore();
}
function drawMap() {
  const cv = $('mapCanvas'); if (!cv) return;
  const { cw, ch, dpr } = resizeMapCanvas();
  const ctx = cv.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#10141b'; ctx.fillRect(0, 0, cv.width, cv.height);
  if (!mapV.ready) fitMapView();
  ctx.setTransform(dpr * mapV.s, 0, 0, dpr * mapV.s, dpr * mapV.ox, dpr * mapV.oy);
  if (mapImgReady) ctx.drawImage(mapImg, 0, 0, MAP_IMG_W, MAP_IMG_H);
  else { ctx.fillStyle = '#1b2230'; ctx.fillRect(0, 0, MAP_IMG_W, MAP_IMG_H); }
  const s = mapV.s;
  drawBuildings(ctx, s, cw, ch);
  for (const n of mapNodes) {
    if (!nodeVisible(n)) continue;
    drawMarker(ctx, n, worldToImgX(n.x), worldToImgY(n.y), s);
  }
  updateMapCount();
}
function updateMapCount() {
  const c = $('mapCount'); if (!c) return;
  if (!mapNodes.length && !mapBuildings.length) { c.textContent = 'No save loaded.'; return; }
  const parts = [];
  if (mapNodes.length) {
    const vis = mapNodes.reduce((a, n) => a + (nodeVisible(n) ? 1 : 0), 0);
    parts.push(`${vis} / ${mapNodes.length} nodes`);
  }
  if (mapBuildings.length) {
    const vis = mapBuildShow ? mapBuildings.reduce((a, b) => a + (catVisible(b._cat) ? 1 : 0), 0) : 0;
    parts.push(`${vis} / ${mapBuildings.length} buildings`);
  }
  c.textContent = parts.join(' · ');
}

function buildMapResFilter() {
  const box = $('mapResFilter'); if (!box) return;
  box.innerHTML = '';
  const counts = new Map();
  for (const n of mapNodes) { if (n.kind !== 'node' && n.kind !== 'deposit') continue; const k = n.resourceClass || '__unknown'; counts.set(k, (counts.get(k) || 0) + 1); }
  if (!counts.size) { box.appendChild(el('small', 'hint', 'No mineable nodes in this save.')); return; }
  // Default: every known resource on, the unknown/vanilla bucket off (it is mostly noise).
  if (!mapResOn) mapResOn = new Set([...counts.keys()].filter((k) => k !== '__unknown'));
  const keys = [...counts.keys()].sort((a, b) => {
    const an = a === '__unknown' ? '￿' : itemName(a), bn = b === '__unknown' ? '￿' : itemName(b);
    return an.localeCompare(bn);
  });
  for (const k of keys) {
    const row = el('label', 'check map-res-row');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = mapResOn.has(k); cb.dataset.res = k;
    cb.addEventListener('change', () => { if (cb.checked) mapResOn.add(k); else mapResOn.delete(k); scheduleMapDraw(); });
    const sw = el('span', 'map-swatch'); sw.style.background = k === '__unknown' ? '#888' : (RES_COLORS[k] || '#bbb');
    row.appendChild(cb); row.appendChild(sw);
    row.appendChild(document.createTextNode(' ' + (k === '__unknown' ? 'Unknown / vanilla' : itemName(k)) + ' (' + counts.get(k) + ')'));
    box.appendChild(row);
  }
}
function setAllMapRes(on) {
  const box = $('mapResFilter'); if (!box) return;
  mapResOn = new Set();
  box.querySelectorAll('input[type=checkbox]').forEach((cb) => { cb.checked = on; if (on) mapResOn.add(cb.dataset.res); });
  scheduleMapDraw();
}

// Category filter for the buildings overlay: checkbox + color swatch + count per
// category present in the loaded save. Mirrors buildMapResFilter.
function buildBuildingCatFilter() {
  const box = $('mapCatFilter'); if (!box) return;
  box.innerHTML = '';
  const counts = new Map();
  for (const b of mapBuildings) counts.set(b._cat, (counts.get(b._cat) || 0) + 1);
  if (!counts.size) { box.appendChild(el('small', 'hint', 'No buildings in this save.')); return; }
  if (!mapCatOn) mapCatOn = new Set(counts.keys()); // default: every category on
  const order = ['production', 'extraction', 'power', 'logistics', 'storage', 'foundation', 'vehicle', 'organization', 'decoration', 'other'];
  const keys = [...counts.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  for (const k of keys) {
    const row = el('label', 'check map-res-row');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = mapCatOn.has(k); cb.dataset.cat = k;
    cb.addEventListener('change', () => { if (cb.checked) mapCatOn.add(k); else mapCatOn.delete(k); scheduleMapDraw(); });
    const sw = el('span', 'map-swatch'); sw.style.background = BMETA.CATEGORY_COLORS[k] || '#888';
    row.appendChild(cb); row.appendChild(sw);
    row.appendChild(document.createTextNode(' ' + (CAT_LABEL[k] || k) + ' (' + counts.get(k) + ')'));
    box.appendChild(row);
  }
}
function setAllMapCat(on) {
  const box = $('mapCatFilter'); if (!box) return;
  mapCatOn = new Set();
  box.querySelectorAll('input[type=checkbox]').forEach((cb) => { cb.checked = on; if (on) mapCatOn.add(cb.dataset.cat); });
  scheduleMapDraw();
}
function buildPurityLegend() {
  const box = $('mapPurityLegend'); if (!box || box.dataset.built) return;
  box.dataset.built = '1';
  [['pure', 'Pure — larger + white ring'], ['normal', 'Normal — medium'], ['impure', 'Impure — small']].forEach(([cls, txt]) => {
    const row = el('div', 'map-legend-row');
    row.appendChild(el('span', 'map-legend-dot map-pur-' + cls));
    row.appendChild(el('span', 'map-legend-txt', txt));
    box.appendChild(row);
  });
}

function loadMapFromSave() {
  const sel = $('mapSaveSelect'), st = $('mapStatus');
  if (!sel || !sel.value) { if (st) st.textContent = 'No save selected.'; return; }
  st.classList.remove('warn-text'); st.textContent = 'Parsing save…';
  const file = sel.value;
  // Defer so "Parsing…" paints before the synchronous parse blocks the thread.
  setTimeout(() => {
    let res;
    try { res = SAVE.readMap(file); }
    catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
    if (!res.ok) { st.textContent = '⚠ ' + res.error; st.classList.add('warn-text'); return; }
    mapNodes = res.nodes; mapResOn = null;
    mapBuildings = annotateBuildings(res.buildings || []); mapCatOn = null;
    buildMapResFilter(); buildPurityLegend(); buildBuildingCatFilter();
    const nc = res.nodeCounts || {};
    const bt = (res.buildingCounts && res.buildingCounts.total) || 0;
    st.textContent = `${res.saveName}: ${nc.node || 0} nodes · ${nc.geyser || 0} geysers · ${nc.frackingCore || 0} wells · ${bt} buildings`;
    $('mapEmpty').hidden = true;
    ensureMapImg(); fitMapView(); drawMap();
  }, 20);
}

function mapTipHtml(n) {
  const title = n.name || KIND_LABEL[n.kind] || 'Resource node';
  const sub = [];
  if (n.kind !== 'node' && KIND_LABEL[n.kind]) sub.push(KIND_LABEL[n.kind]);
  if (n.purity) sub.push(n.purity);
  const co = `X ${Math.round(n.x / 100)} · Y ${Math.round(n.y / 100)}`;
  return `<b>${title}</b>` + (sub.length ? `<br><span class="map-tip-sub">${sub.join(' · ')}</span>` : '') + `<br><span class="map-tip-co">${co}</span>`;
}
// Nearest machine whose footprint is under the cursor (screen-space). Paths
// (belts/pipes/wires) aren't hit-tested — only the machines carry useful detail.
function pickMachineAt(sx, sy) {
  const s = mapV.s;
  let best = null, bestD = Infinity;
  for (const b of mapBuildings) {
    if (b.kind !== 'machine' || !catVisible(b._cat)) continue;
    const px = worldToImgX(b.x) * s + mapV.ox, py = worldToImgY(b.y) * s + mapV.oy;
    const dx = px - sx, dy = py - sy;
    const reach = Math.max(6, Math.max(b._w, b._d) * IMG_PX_PER_CM * s * 0.6);
    const d = dx * dx + dy * dy;
    if (d <= reach * reach && d < bestD) { bestD = d; best = b; }
  }
  return best;
}
function buildingTipHtml(b) {
  const sub = [CAT_LABEL[b._cat] || b._cat];
  if (Math.abs((b.overclock || 1) - 1) > 1e-3) sub.push('OC ' + Math.round(b.overclock * 100) + '%');
  if ((b.boost || 0) > 0) sub.push('Somerslooped');
  const slot = b.swatch && b.swatch.match(/Slot(\d+)/);
  if (slot) sub.push('Paint ' + slot[1]); else if (b.swatch) sub.push('Painted');
  const co = `X ${Math.round(b.x / 100)} · Y ${Math.round(b.y / 100)}`;
  return `<b>${buildingDisplayName(b.className)}</b><br><span class="map-tip-sub">${sub.join(' · ')}</span><br><span class="map-tip-co">${co}</span>`;
}
function mapHover(e) {
  const cv = $('mapCanvas'), tip = $('mapTip'); if (!cv || !tip) return;
  const r = cv.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  let best = null, bestD = 11 * 11; // markers are constant screen-size, so hit-test in screen px
  for (const n of mapNodes) {
    if (!nodeVisible(n)) continue;
    const px = worldToImgX(n.x) * mapV.s + mapV.ox, py = worldToImgY(n.y) * mapV.s + mapV.oy;
    const d = (px - sx) * (px - sx) + (py - sy) * (py - sy);
    if (d < bestD) { bestD = d; best = n; }
  }
  // Resource nodes win ties (they're the smaller, more precise target); fall back
  // to a machine footprint under the cursor when no node is close.
  let html = best ? mapTipHtml(best) : null;
  if (!html && mapBuildShow && mapBuildings.length) {
    const mb = pickMachineAt(sx, sy);
    if (mb) html = buildingTipHtml(mb);
  }
  if (!html) { tip.hidden = true; return; }
  tip.innerHTML = html;
  tip.hidden = false;
  const wrapR = $('mapWrap').getBoundingClientRect();
  tip.style.left = (e.clientX - wrapR.left + 14) + 'px';
  tip.style.top = (e.clientY - wrapR.top + 14) + 'px';
}
function zoomMapAt(sx, sy, f) {
  const ns = Math.max(mapFitS * 0.5, Math.min(mapFitS * 60, mapV.s * f));
  const k = ns / mapV.s;
  mapV.ox = sx - (sx - mapV.ox) * k; mapV.oy = sy - (sy - mapV.oy) * k; mapV.s = ns;
  $('mapTip').hidden = true; scheduleMapDraw();
}
function wireMap() {
  const cv = $('mapCanvas'); if (!cv) return;
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    zoomMapAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });
  cv.addEventListener('pointerdown', (e) => { mapDrag = { x: e.clientX, y: e.clientY, ox: mapV.ox, oy: mapV.oy }; try { cv.setPointerCapture(e.pointerId); } catch (_) {} });
  cv.addEventListener('pointermove', (e) => {
    if (mapDrag) { mapV.ox = mapDrag.ox + (e.clientX - mapDrag.x); mapV.oy = mapDrag.oy + (e.clientY - mapDrag.y); $('mapTip').hidden = true; scheduleMapDraw(); }
    else mapHover(e);
  });
  const up = (e) => { if (mapDrag) { try { cv.releasePointerCapture(e.pointerId); } catch (_) {} mapDrag = null; } };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('pointerleave', () => { $('mapTip').hidden = true; });
  window.addEventListener('resize', () => {
    if (state.mode === 'map') scheduleMapDraw();
    if (state.view === 'flow' && $('flowView') && !$('flowView').hidden) applyFlowTransform();
  });
}
function renderMap() {
  ensureMapImg();
  if (!$('mapWrap')) return;
  $('mapEmpty').hidden = mapNodes.length > 0;
  if (mapNodes.length && !mapV.ready) fitMapView();
  drawMap();
}

// ---------- mode dispatch ----------
function present(res, targets) {
  lastResult = res; lastTargets = targets;
  showOutput();
  renderTables(res);
  if (state.view === 'flow') renderFlowView();
}
function solveAndRender() {
  $('modeExtras').innerHTML = '';
  $('maxBanner').hidden = true;
  $('warnBox').hidden = true;
  if (state.mode === 'planner') return renderPlanner();
  if (state.mode === 'optimize') return renderOptimize();
  if (state.mode === 'max') return renderMax();
}
function showEmpty(msg) {
  lastResult = null;
  $('empty').hidden = false;
  $('output').hidden = true;
  $('emptyMsg').textContent = msg;
  $('sumPower').textContent = '—'; $('sumMachines').textContent = '—'; $('sumRaw').textContent = '—';
}
function showOutput() { $('empty').hidden = true; $('output').hidden = false; applyView(); }

function renderPlanner() {
  $('sumExtraLabel').textContent = 'Raw resource types';
  if (!state.targetItem) return showEmpty('Pick a target item to build a production flow.');
  if (!(state.targetRate > 0)) return showEmpty('Set a target rate above 0.');
  const res = computePlanner();
  if (!res.feasible) return showEmpty('No feasible plan: the selected recipes can’t balance — a recycle loop that consumes more than it makes. Switch one alternate to break it.');
  present(res, res.targets);
  $('sumRaw').textContent = fmt(res.raw.length, 0);
}

function renderOptimize() {
  $('sumExtraLabel').textContent = 'Raw resource types';
  const outputs = {};
  let n = 0;
  for (const o of state.opt.outputs) {
    const c = nameToClass(o.name);
    if (c && o.rate > 0) { outputs[c] = (outputs[c] || 0) + Number(o.rate) * (isDeliverable(c) ? state.spaceMult : 1); n++; }
  }
  if (!n) return showEmpty('Add at least one desired output item to optimize.');
  const allowedInputs = {};
  for (const r of resList) { const cfg = state.opt.inputs[r.c]; if (cfg && cfg.on) allowedInputs[r.c] = cfg.cap === '' || cfg.cap == null ? Infinity : Number(cfg.cap); }
  if (!Object.keys(allowedInputs).length) return showEmpty('Allow at least one input resource.');

  const res = LP.optimize({ outputs, allowedInputs, objective: state.opt.objective, allowAlternates: state.opt.alts, recipeCost: state.recipeCost, powerMult: state.powerMult, unlockedAlts: effectiveAltSet() });
  if (!res.feasible) return showEmpty('No feasible recipe set: those outputs cannot be made from the allowed inputs. Enable more resources or alternate recipes.');
  res.surplus = res.outputs.filter((o) => !outputs[o.item]);
  present(res, outputs);
  $('sumRaw').textContent = fmt(res.raw.length, 0);

  const labels = { raw: 'raw resources /min', power: 'MW', machines: 'machines' };
  const ex = el('div', 'extras-card');
  ex.appendChild(el('div', 'extras-title', '✓ Optimized recipe selection'));
  const alts = res.recipes.filter((x) => RECIPES[x.rc].alternate).length;
  ex.appendChild(el('div', 'extras-line', `Minimized ${state.opt.objective} = ${fmt(res.objectiveValue)} ${labels[state.opt.objective]} · ${alts} alternate recipe(s) chosen`));
  $('modeExtras').appendChild(ex);
}

function renderMax() {
  $('sumExtraLabel').textContent = 'Inputs at 100%';
  const product = state.max.product;
  if (!product) return showEmpty('Choose a product to maximize.');
  const supply = {};
  let n = 0;
  for (const s of state.max.supply) if (s.item && s.amount > 0) { supply[s.item] = (supply[s.item] || 0) + Number(s.amount); n++; }
  if (!n) return showEmpty('Add at least one available input with an amount.');
  const res = LP.maxThroughput({ product, supply, allowAlternates: state.max.alts, recipeCost: state.recipeCost, powerMult: state.powerMult, unlockedAlts: effectiveAltSet() });
  if (!res.feasible) return showEmpty(`Cannot produce ${itemName(product)} from the given inputs.`);
  res.surplus = res.outputs.filter((o) => o.item !== product);
  present(res, { [product]: res.maxOutput });

  const b = $('maxBanner');
  b.hidden = false;
  b.innerHTML = `<span class="banner-num">${fmt(res.maxOutput)}</span> <span class="banner-unit">${isFluid(product) ? 'm³' : ''}/min ${itemName(product)}</span>`;
  $('sumRaw').textContent = res.binding.length ? '✓' : '—';
  const ex = el('div', 'extras-card');
  ex.appendChild(el('div', 'extras-title', `Limiting factor: ${res.binding.length ? res.binding.map(itemName).join(', ') : '—'}`));
  const tbl = el('table', 'util-table');
  tbl.innerHTML = '<thead><tr><th>Input</th><th class="num">Used</th><th class="num">Avail</th><th>Utilization</th></tr></thead>';
  const tbody = el('tbody');
  res.utilization.forEach((u) => {
    const tr = el('tr');
    const td = el('td'); td.appendChild(itemCell(u.item)); tr.appendChild(td);
    tr.appendChild(el('td', 'num', fmt(u.used)));
    tr.appendChild(el('td', 'num', fmt(u.avail)));
    const bar = el('td'); const wrap = el('div', 'bar');
    const fill = el('div', 'bar-fill' + (u.pct >= 0.999 ? ' full' : ''));
    fill.style.width = Math.min(100, u.pct * 100) + '%';
    fill.textContent = Math.round(u.pct * 100) + '%';
    wrap.appendChild(fill); bar.appendChild(wrap); tr.appendChild(bar);
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody); ex.appendChild(tbl);
  $('modeExtras').appendChild(ex);
}

// ---------- control builders ----------
function buildItemList() {
  const dl = $('itemList');
  dl.innerHTML = '';
  for (const it of targetable) { const o = el('option'); o.value = it.n; dl.appendChild(o); }
}
function buildGameSelect(id, values, cur) {
  const sel = $(id);
  sel.innerHTML = '';
  for (const v of values) { const o = el('option', null, v === 1 ? '1 (Default)' : String(v)); o.value = String(v); if (v === cur) o.selected = true; sel.appendChild(o); }
}
function buildOptOutputs() {
  const box = $('optOutputs');
  box.innerHTML = '';
  state.opt.outputs.forEach((o, i) => {
    const row = el('div', 'row');
    const name = el('input', 'row-item'); name.setAttribute('list', 'itemList'); name.placeholder = 'item…'; name.value = o.name; name.autocomplete = 'off';
    const rate = el('input', 'row-rate'); rate.type = 'number'; rate.min = '0'; rate.step = 'any'; rate.value = o.rate;
    const rm = el('button', 'row-rm', '×');
    name.addEventListener('input', () => { o.name = name.value; if (i === 0 && nameToClass(name.value)) { state.targetItem = nameToClass(name.value); reflectPrimary('optimize'); } save(); solveAndRender(); });
    rate.addEventListener('input', () => { o.rate = parseFloat(rate.value) || 0; if (i === 0) { state.targetRate = o.rate; reflectPrimary('optimize'); } save(); solveAndRender(); });
    rm.addEventListener('click', () => { state.opt.outputs.splice(i, 1); if (!state.opt.outputs.length) state.opt.outputs.push({ name: '', rate: 60 }); save(); buildOptOutputs(); solveAndRender(); });
    row.append(name, rate, rm);
    box.appendChild(row);
  });
}
function buildOptInputs() {
  const box = $('optInputs');
  box.innerHTML = '';
  for (const r of resList) {
    const cfg = state.opt.inputs[r.c] || (state.opt.inputs[r.c] = { on: true, cap: '' });
    const row = el('div', 'res-row');
    const lab = el('label', 'res-name');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = cfg.on;
    lab.appendChild(cb); lab.appendChild(document.createTextNode(' ' + r.n));
    const cap = el('input', 'res-cap'); cap.type = 'number'; cap.min = '0'; cap.step = 'any'; cap.placeholder = '∞'; cap.value = cfg.cap;
    cb.addEventListener('change', () => { cfg.on = cb.checked; save(); solveAndRender(); });
    cap.addEventListener('input', () => { cfg.cap = cap.value; save(); solveAndRender(); });
    row.append(lab, cap);
    box.appendChild(row);
  }
}
function buildMaxSupply() {
  const box = $('maxSupply');
  box.innerHTML = '';
  state.max.supply.forEach((s, i) => {
    const row = el('div', 'row');
    const sel = el('select', 'row-item');
    for (const r of resList) { const o = el('option', null, r.n); o.value = r.c; if (r.c === s.item) o.selected = true; sel.appendChild(o); }
    const amt = el('input', 'row-rate'); amt.type = 'number'; amt.min = '0'; amt.step = 'any'; amt.value = s.amount;
    const rm = el('button', 'row-rm', '×');
    sel.addEventListener('change', () => { s.item = sel.value; save(); solveAndRender(); });
    amt.addEventListener('input', () => { s.amount = parseFloat(amt.value) || 0; save(); solveAndRender(); });
    rm.addEventListener('click', () => { state.max.supply.splice(i, 1); if (!state.max.supply.length) state.max.supply.push({ item: resList[0].c, amount: 120 }); save(); buildMaxSupply(); solveAndRender(); });
    row.append(sel, amt, rm);
    box.appendChild(row);
  });
}
// ---------- unlocked alternates from save file ----------
function fillSaveSelect(sel, info) {
  if (!sel) return;
  sel.innerHTML = '';
  if (!info.saves.length) {
    const o = el('option', null, info.exists ? 'No .sav files found' : 'Save folder not found');
    o.value = '';
    sel.appendChild(o);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const s of info.saves) {
    const o = el('option', null, (s.folder ? s.folder.slice(0, 8) + '…/' : '') + s.name);
    o.value = s.file;
    sel.appendChild(o);
  }
}
function buildSaveList() {
  let info;
  try { info = SAVE.listSaves(); } catch (e) { info = { exists: false, saves: [] }; }
  fillSaveSelect($('saveSelect'), info);
  fillSaveSelect($('mapSaveSelect'), info);
}
let altSearch = '';
// Alternates the user can manage: the unlocked set when a save is loaded, else all.
function altUniverse() {
  return (state.unlockedAlts ? state.unlockedAlts : ALT_CLASSES).slice();
}
// Renders the save status line AND the per-recipe enable/disable checkbox list.
// (Called by applyStateToControls on plan switch, so the list tracks the plan.)
function renderSaveStatus() {
  const st = $('saveStatus');
  if (st) {
    st.classList.remove('warn-text');
    st.textContent = !state.unlockedAlts
      ? 'No save loaded — all alternates available. Untick any to exclude it.'
      : `${state.unlockedAlts.length} alternate${state.unlockedAlts.length === 1 ? '' : 's'} unlocked${state.saveName ? ' · ' + state.saveName : ''}.`;
  }
  const list = $('altList');
  if (!list) return;
  const disabled = state.disabledAlts || [];
  const universe = altUniverse()
    .map((rc) => ({ rc, name: RECIPES[rc] ? RECIPES[rc].name.replace(/^Alternate:\s*/, '') : rc }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const cnt = $('altCount');
  if (cnt) cnt.textContent = `${universe.filter((u) => !disabled.includes(u.rc)).length}/${universe.length} on`;
  const q = altSearch.trim().toLowerCase();
  const shown = q ? universe.filter((u) => u.name.toLowerCase().includes(q)) : universe;
  list.innerHTML = '';
  for (const u of shown) {
    const row = el('label', 'alt-row');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !disabled.includes(u.rc);
    cb.addEventListener('change', () => {
      const arr = state.disabledAlts || (state.disabledAlts = []);
      const i = arr.indexOf(u.rc);
      if (cb.checked) { if (i >= 0) arr.splice(i, 1); }
      else if (i < 0) arr.push(u.rc);
      save();
      renderSaveStatus();
      solveAndRender();
    });
    row.appendChild(cb);
    row.appendChild(document.createTextNode(' ' + u.name));
    list.appendChild(row);
  }
  if (!shown.length) list.appendChild(el('div', 'hint', q ? 'No matches.' : 'No alternates.'));
}
// Enable (on=true) or exclude (on=false) every alternate currently in the list.
function setAllAlts(on) {
  const uni = altUniverse();
  const arr = state.disabledAlts || (state.disabledAlts = []);
  if (on) state.disabledAlts = arr.filter((rc) => !uni.includes(rc));
  else { const s = new Set(arr); uni.forEach((rc) => s.add(rc)); state.disabledAlts = [...s]; }
  save();
  renderSaveStatus();
  solveAndRender();
}
function loadFromSelectedSave() {
  const sel = $('saveSelect');
  const st = $('saveStatus');
  if (!sel || !sel.value) return;
  st.classList.remove('warn-text');
  st.textContent = 'Parsing save…';
  const file = sel.value;
  // Defer so "Parsing…" paints before the synchronous parse blocks the thread.
  setTimeout(() => {
    let res;
    try { res = SAVE.readUnlockedAlternates(file); }
    catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
    if (!res.ok) { st.textContent = '⚠ ' + res.error; st.classList.add('warn-text'); return; }
    state.unlockedAlts = res.recognized.map((r) => r.className);
    state.saveName = res.saveName || '';
    for (const item in state.picks) {
      const p = state.picks[item];
      if (p && p !== 'RAW' && RECIPES[p] && RECIPES[p].alternate && !state.unlockedAlts.includes(p)) delete state.picks[item];
    }
    save();
    renderSaveStatus();
    if (res.unknown && res.unknown.length) {
      st.textContent += ` (+${res.unknown.length} not in app data)`;
    }
    solveAndRender();
  }, 20);
}
function clearUnlockedFilter() {
  state.unlockedAlts = null;
  state.saveName = '';
  save();
  renderSaveStatus();
  solveAndRender();
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  document.querySelectorAll('.mode-panel').forEach((p) => { p.hidden = p.dataset.mode !== mode; });
  const isMap = mode === 'map';
  document.querySelectorAll('.calc-only').forEach((e) => { e.style.display = isMap ? 'none' : ''; });
  $('btnReset').style.display = mode === 'planner' ? '' : 'none';
  // The alternate list auto-selects recipes only in Optimizer/Max. Planner builds
  // from the per-row dropdowns, so spell that out instead of letting users expect a
  // re-solve when they untick an alt here.
  const altHelp = $('altHelp');
  if (altHelp) altHelp.textContent = mode === 'planner'
    ? 'Planner uses the recipe picked in each row below. This list filters those row dropdowns; it auto-selects recipes only in Recipe Optimizer & Max Throughput.'
    : 'Untick a recipe to stop the optimizer using it — even if unlocked or optimal.';
  $('mapView').hidden = !isMap;
  save();
  if (isMap) { $('empty').hidden = true; $('output').hidden = true; renderMap(); }
  else solveAndRender();
}

// ---------- plan bar ----------
function renderPlanBar() {
  const box = $('planTabs');
  if (!box) return;
  box.innerHTML = '';
  plans.forEach((p) => {
    const tab = el('div', 'plan-tab' + (p.id === activeId ? ' active' : ''));
    const lab = el('span', 'plan-name', p.name);
    lab.title = 'Click to open · double-click to rename';
    lab.addEventListener('click', () => { if (p.id !== activeId) switchPlan(p.id); });
    lab.addEventListener('dblclick', () => startRename(tab, lab, p));
    tab.appendChild(lab);
    const x = el('button', 'plan-close', '×');
    x.title = 'Delete this plan';
    x.addEventListener('click', (e) => { e.stopPropagation(); deletePlan(p.id); });
    tab.appendChild(x);
    box.appendChild(tab);
  });
}
function startRename(tab, lab, p) {
  const inp = el('input', 'plan-rename');
  inp.value = p.name;
  tab.replaceChild(inp, lab);
  inp.focus(); inp.select();
  let done = false;
  const commit = () => { if (done) return; done = true; renamePlan(p.id, inp.value.trim() || p.name); };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') { done = true; renderPlanBar(); } });
  inp.addEventListener('blur', commit);
}

// ---------- wiring ----------
function syncSliderLabels() {
  $('clockOut').textContent = Math.round(state.clock * 100) + '%';
  $('sloopOut').textContent = fmt(state.sloop, 1) + '×';
}
// Carry the primary desired output (item + rate) across the Planner target,
// the Optimizer's first output row, and the Max product. `except` is the mode
// being edited; its own control is left untouched so typing isn't disrupted.
// Canonical source = state.targetItem + state.targetRate.
function reflectPrimary(except) {
  const item = state.targetItem;
  const disp = item ? itemName(item) : '';
  state.max.product = item || '';
  const o0 = state.opt.outputs[0] || (state.opt.outputs[0] = { name: '', rate: 60 });
  o0.name = disp;
  o0.rate = state.targetRate;
  if (except !== 'planner') {
    if ($('targetItem')) $('targetItem').value = disp;
    if ($('targetRate')) $('targetRate').value = state.targetRate;
    if ($('rateUnit')) $('rateUnit').textContent = item && isFluid(item) ? 'm³ / min' : '/ min';
  }
  if (except !== 'max' && $('maxProduct')) $('maxProduct').value = disp;
  if (except !== 'optimize') buildOptOutputs();
}
// Push the active plan's state into every control, then render.
function applyStateToControls() {
  buildOptOutputs();
  buildOptInputs();
  buildMaxSupply();
  buildGameSelect('mRecipe', GAME.recipe, state.recipeCost);
  buildGameSelect('mPower', GAME.power, state.powerMult);
  buildGameSelect('mSpace', GAME.space, state.spaceMult);
  renderSaveStatus();
  $('targetItem').value = state.targetItem ? itemName(state.targetItem) : '';
  $('targetRate').value = state.targetRate;
  $('clock').value = Math.round(state.clock * 100);
  $('sloop').value = Math.round(state.sloop * 100);
  $('rateUnit').textContent = state.targetItem && isFluid(state.targetItem) ? 'm³ / min' : '/ min';
  syncSliderLabels();
  $('optObjective').value = state.opt.objective;
  $('optAlts').checked = state.opt.alts;
  $('maxProduct').value = state.max.product ? itemName(state.max.product) : '';
  $('maxAlts').checked = state.max.alts;
  setMode(state.mode);
}
function init() {
  load();
  buildItemList();
  buildSaveList();
  window.addEventListener('beforeunload', save); // belt-and-suspenders autosave on close

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setMode(t.dataset.mode)));
  $('viewTables').addEventListener('click', () => { state.view = 'tables'; save(); applyView(); });
  $('viewFlow').addEventListener('click', () => { state.view = 'flow'; save(); applyView(); });
  $('flowReset').addEventListener('click', () => { state.flowPos = {}; state.flowView = null; save(); renderFlowView(); });
  $('flowFit').addEventListener('click', () => { fitFlow(currentFlow); save(); });
  $('flowZoomIn').addEventListener('click', () => zoomFlowCenter(1.2));
  $('flowZoomOut').addEventListener('click', () => zoomFlowCenter(1 / 1.2));

  const onTarget = (v) => { const c = nameToClass(v); state.targetItem = c; $('rateUnit').textContent = c && isFluid(c) ? 'm³ / min' : '/ min'; reflectPrimary('planner'); save(); solveAndRender(); };
  $('targetItem').addEventListener('change', (e) => onTarget(e.target.value));
  $('targetItem').addEventListener('input', (e) => { if (nameToClass(e.target.value)) onTarget(e.target.value); });
  $('targetRate').addEventListener('input', (e) => { state.targetRate = parseFloat(e.target.value) || 0; reflectPrimary('planner'); save(); solveAndRender(); });
  $('clock').addEventListener('input', (e) => { state.clock = (parseFloat(e.target.value) || 100) / 100; syncSliderLabels(); save(); solveAndRender(); });
  $('sloop').addEventListener('input', (e) => { state.sloop = (parseFloat(e.target.value) || 100) / 100; syncSliderLabels(); save(); solveAndRender(); });

  $('mRecipe').addEventListener('change', (e) => { state.recipeCost = Number(e.target.value); save(); solveAndRender(); });
  $('mPower').addEventListener('change', (e) => { state.powerMult = Number(e.target.value); save(); solveAndRender(); });
  $('mSpace').addEventListener('change', (e) => { state.spaceMult = Number(e.target.value); save(); solveAndRender(); });

  $('saveLoad').addEventListener('click', loadFromSelectedSave);
  $('saveRefresh').addEventListener('click', buildSaveList);
  $('saveClear').addEventListener('click', clearUnlockedFilter);
  $('altSearch').addEventListener('input', (e) => { altSearch = e.target.value; renderSaveStatus(); });
  $('altAllOn').addEventListener('click', () => setAllAlts(true));
  $('altAllOff').addEventListener('click', () => setAllAlts(false));

  // resource map
  wireMap();
  $('mapLoad').addEventListener('click', loadMapFromSave);
  $('mapRefresh').addEventListener('click', buildSaveList);
  $('mapResetView').addEventListener('click', () => { fitMapView(); drawMap(); });
  $('mapAllRes').addEventListener('click', () => setAllMapRes(true));
  $('mapNoRes').addEventListener('click', () => setAllMapRes(false));
  $('mapShowGeyser').addEventListener('change', (e) => { mapKindOn.geyser = e.target.checked; scheduleMapDraw(); });
  $('mapShowFrack').addEventListener('change', (e) => { mapKindOn.frackingCore = e.target.checked; scheduleMapDraw(); });
  $('mapShowDeposit').addEventListener('change', (e) => { mapKindOn.deposit = e.target.checked; scheduleMapDraw(); });
  $('mapBuildShow').addEventListener('change', (e) => { mapBuildShow = e.target.checked; scheduleMapDraw(); });
  $('mapBuildOpacity').addEventListener('input', (e) => { mapBuildOpacity = (Number(e.target.value) || 0) / 100; scheduleMapDraw(); });
  $('mapColorMode').addEventListener('change', (e) => { mapColorMode = e.target.value; scheduleMapDraw(); });
  $('mapMarkClock').addEventListener('change', (e) => { mapMarkClock = e.target.checked; scheduleMapDraw(); });
  $('mapAllCat').addEventListener('click', () => setAllMapCat(true));
  $('mapNoCat').addEventListener('click', () => setAllMapCat(false));

  $('optAddOutput').addEventListener('click', () => { state.opt.outputs.push({ name: '', rate: 60 }); save(); buildOptOutputs(); });
  $('optObjective').addEventListener('change', (e) => { state.opt.objective = e.target.value; save(); solveAndRender(); });
  $('optAlts').addEventListener('change', (e) => { state.opt.alts = e.target.checked; save(); solveAndRender(); });
  $('optAllInputs').addEventListener('click', () => { resList.forEach((r) => (state.opt.inputs[r.c].on = true)); save(); buildOptInputs(); solveAndRender(); });
  $('optNoInputs').addEventListener('click', () => { resList.forEach((r) => (state.opt.inputs[r.c].on = false)); save(); buildOptInputs(); solveAndRender(); });

  $('maxAddSupply').addEventListener('click', () => { state.max.supply.push({ item: resList[0].c, amount: 60 }); save(); buildMaxSupply(); });
  const onProduct = (v) => { const c = nameToClass(v); state.max.product = c; if (c) { state.targetItem = c; reflectPrimary('max'); } save(); solveAndRender(); };
  $('maxProduct').addEventListener('change', (e) => onProduct(e.target.value));
  $('maxProduct').addEventListener('input', (e) => { if (nameToClass(e.target.value)) onProduct(e.target.value); });
  $('maxAlts').addEventListener('change', (e) => { state.max.alts = e.target.checked; save(); solveAndRender(); });

  $('planNew').addEventListener('click', () => newPlan());
  $('planDup').addEventListener('click', () => duplicatePlan(activeId));
  $('btnReset').addEventListener('click', () => { state.picks = {}; state.nodeClock = {}; save(); solveAndRender(); });
  $('btnClear').addEventListener('click', () => { const p = activePlan(); const g = pickGlobals(p.state); p.state = defaultState(); applyGlobals(p.state, g); state = p.state; save(); applyStateToControls(); });

  // support modal
  const supportModal = $('supportModal');
  const closeSupport = () => { supportModal.hidden = true; };
  $('btnSupport').addEventListener('click', () => { supportModal.hidden = false; });
  $('supportClose').addEventListener('click', closeSupport);
  supportModal.addEventListener('click', (e) => { if (e.target === supportModal) closeSupport(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !supportModal.hidden) closeSupport(); });
  supportModal.querySelectorAll('[data-url]').forEach((el) =>
    el.addEventListener('click', () => { const u = SUPPORT_LINKS[el.dataset.url]; if (u) openExternal(u); closeSupport(); })
  );

  renderPlanBar();
  applyStateToControls();
}
window.addEventListener('DOMContentLoaded', init);
