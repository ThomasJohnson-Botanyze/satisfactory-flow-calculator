'use strict';
const DATA = require('./data.json');
const LP = require('./solver-lp');

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
  opt: {
    outputs: [{ name: '', rate: 60 }],
    inputs: Object.fromEntries(resList.map((r) => [r.c, { on: true, cap: '' }])),
    objective: 'raw',
    alts: true,
  },
  max: { supply: [{ item: resList[0] ? resList[0].c : '', amount: 120 }], product: '', alts: true },
});
let state = defaultState();

const LS_KEY = 'satisfactory-flow-plan-v3';
const save = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {} };
function load() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY));
    if (s && typeof s === 'object') {
      state = Object.assign(defaultState(), s);
      state.opt = Object.assign(defaultState().opt, s.opt || {});
      state.max = Object.assign(defaultState().max, s.max || {});
    }
  } catch (e) {}
}

// ---------- planner solver ----------
function chosenRecipeClass(item) {
  const pick = state.picks[item];
  if (pick === 'RAW') return null;
  if (pick && RECIPES[pick]) return pick;
  if (RESOURCES.has(item)) return null;
  return defaultRecipeClass(item);
}
function computePlanner() {
  const demand = {};
  const path = new Set();
  let cycle = false;
  function add(item, rate) {
    demand[item] = (demand[item] || 0) + rate;
    if (path.has(item)) { cycle = true; return; }
    const rc = chosenRecipeClass(item);
    if (!rc) return;
    const r = RECIPES[rc];
    const prod = r.products.find((p) => p.item === item) || r.products[0];
    const ratio = rate / prod.amount;
    path.add(item);
    for (const ing of r.ingredients) add(ing.item, ratio * ing.amount * state.recipeCost);
    path.delete(item);
  }
  const tRate = state.targetRate * (isDeliverable(state.targetItem) ? state.spaceMult : 1);
  if (state.targetItem && tRate > 0) add(state.targetItem, tRate);

  const recipes = [];
  const raw = [];
  const surplus = {};
  let totalPower = 0;
  let totalMachines = 0;
  for (const item of Object.keys(demand)) {
    const rc = chosenRecipeClass(item);
    if (!rc) { if (demand[item] > 1e-9) raw.push({ item, rate: demand[item] }); continue; }
    const r = RECIPES[rc];
    const prod = r.products.find((p) => p.item === item) || r.products[0];
    const b = BUILDINGS[r.building] || { name: r.building, power: 0, exponent: 1.321929, speed: 1 };
    const perMachine = prod.amount * (60 / r.time) * (b.speed || 1) * state.clock * state.sloop;
    const machines = demand[item] / perMachine;
    const powerPer = b.power * Math.pow(state.clock, b.exponent) * Math.pow(state.sloop, 2) * state.powerMult;
    const power = machines * powerPer;
    totalPower += power;
    totalMachines += Math.ceil(machines - 1e-9);
    r.products.forEach((p) => { if (p.item !== item) surplus[p.item] = (surplus[p.item] || 0) + (demand[item] / prod.amount) * p.amount; });
    recipes.push({ item, rc, machines, building: r.building, buildingName: b.name, rate: demand[item], power, interactive: true });
  }
  return {
    ok: !!state.targetItem,
    cycle,
    recipes,
    raw,
    surplus: Object.entries(surplus).filter(([, v]) => v > 1e-9).map(([item, rate]) => ({ item, rate })),
    totalPower,
    totalMachines,
    targets: state.targetItem ? { [state.targetItem]: tRate } : {},
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
  const cands = (recipesByProduct[item] || []).slice().sort((a, b) => {
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

function buildFlow(res, targets) {
  const nodes = [];
  const byId = {};
  const edges = [];
  const addNode = (id, kind, title, sub) => {
    if (!byId[id]) { const n = { id, kind, title, sub, ins: [], outs: [] }; nodes.push(n); byId[id] = n; }
    return byId[id];
  };
  res.recipes.forEach((s, i) => { s._nid = 'mac' + i; addNode(s._nid, 'machine', itemName(s.item), `${fmt(Math.ceil(s.machines - 1e-9), 0)}× ${s.buildingName}`); });
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
  const COLW = 215, ROWH = 72, NW = 150, NH = 48, PADX = 24, PADY = 24;
  let maxRows = 0, maxCol = 0;
  Object.keys(cols).map(Number).sort((a, b) => a - b).forEach((c) => {
    cols[c].forEach((n, i) => { n.x = PADX + c * COLW; n.y = PADY + i * ROWH; n.w = NW; n.h = NH; });
    maxRows = Math.max(maxRows, cols[c].length);
    maxCol = Math.max(maxCol, c);
  });
  flow.width = PADX * 2 + maxCol * COLW + NW;
  flow.height = PADY * 2 + Math.max(1, maxRows) * ROWH;
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
  svg.setAttribute('width', flow.width);
  svg.setAttribute('height', flow.height);
  svg.setAttribute('viewBox', `0 0 ${flow.width} ${flow.height}`);
  const gEdges = document.createElementNS(SVGNS, 'g');
  const gNodes = document.createElementNS(SVGNS, 'g');
  svg.appendChild(gEdges); svg.appendChild(gNodes);

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
    t1.textContent = n.title.length > 22 ? n.title.slice(0, 21) + '…' : n.title;
    g.appendChild(t1);
    const t2 = document.createElementNS(SVGNS, 'text');
    t2.setAttribute('class', 'n-sub'); t2.setAttribute('x', 10); t2.setAttribute('y', 35);
    t2.textContent = n.sub;
    g.appendChild(t2);
    n._g = g;
    gNodes.appendChild(g);
    attachDrag(g, n, flow);
  });
}

function attachDrag(g, node, flow) {
  let last = null;
  g.addEventListener('pointerdown', (ev) => { last = { x: ev.clientX, y: ev.clientY }; g.setPointerCapture(ev.pointerId); g.classList.add('dragging'); ev.preventDefault(); });
  g.addEventListener('pointermove', (ev) => {
    if (!last) return;
    node.x += ev.clientX - last.x;
    node.y += ev.clientY - last.y;
    last = { x: ev.clientX, y: ev.clientY };
    g.setAttribute('transform', `translate(${node.x},${node.y})`);
    [...node.ins, ...node.outs].forEach((e) => {
      const p = edgePath(e, flow.byId);
      e._path.setAttribute('d', p.d);
      e._label.setAttribute('x', p.lx); e._label.setAttribute('y', p.ly);
    });
  });
  const end = (ev) => { last = null; g.classList.remove('dragging'); try { g.releasePointerCapture(ev.pointerId); } catch (e) {} };
  g.addEventListener('pointerup', end);
  g.addEventListener('pointercancel', end);
}

function renderFlowView() {
  if (!lastResult) return;
  const flow = layoutFlow(buildFlow(lastResult, lastTargets));
  drawFlow(flow);
}
function applyView() {
  const flow = state.view === 'flow';
  $('flowView').hidden = !flow;
  $('tableView').hidden = flow;
  $('viewFlow').classList.toggle('active', flow);
  $('viewTables').classList.toggle('active', !flow);
  if (flow) renderFlowView();
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
  const res = computePlanner();
  present(res, res.targets);
  $('sumRaw').textContent = fmt(res.raw.length, 0);
  if (res.cycle) { $('warnBox').hidden = false; $('warnBox').textContent = '⚠ Recipe loop detected — a selected recipe feeds itself. Tree was cut; switch one alternate to break the cycle.'; }
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

  const res = LP.optimize({ outputs, allowedInputs, objective: state.opt.objective, allowAlternates: state.opt.alts, recipeCost: state.recipeCost, powerMult: state.powerMult });
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
  const res = LP.maxThroughput({ product, supply, allowAlternates: state.max.alts, recipeCost: state.recipeCost, powerMult: state.powerMult });
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
    name.addEventListener('input', () => { o.name = name.value; save(); solveAndRender(); });
    rate.addEventListener('input', () => { o.rate = parseFloat(rate.value) || 0; save(); solveAndRender(); });
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
function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  document.querySelectorAll('.mode-panel').forEach((p) => { p.hidden = p.dataset.mode !== mode; });
  $('btnReset').style.display = mode === 'planner' ? '' : 'none';
  save();
  solveAndRender();
}

// ---------- wiring ----------
function syncSliderLabels() {
  $('clockOut').textContent = Math.round(state.clock * 100) + '%';
  $('sloopOut').textContent = fmt(state.sloop, 1) + '×';
}
function init() {
  load();
  buildItemList();
  buildOptOutputs();
  buildOptInputs();
  buildMaxSupply();
  buildGameSelect('mRecipe', GAME.recipe, state.recipeCost);
  buildGameSelect('mPower', GAME.power, state.powerMult);
  buildGameSelect('mSpace', GAME.space, state.spaceMult);

  if (state.targetItem) $('targetItem').value = itemName(state.targetItem);
  $('targetRate').value = state.targetRate;
  $('clock').value = Math.round(state.clock * 100);
  $('sloop').value = Math.round(state.sloop * 100);
  $('rateUnit').textContent = state.targetItem && isFluid(state.targetItem) ? 'm³ / min' : '/ min';
  syncSliderLabels();
  $('optObjective').value = state.opt.objective;
  $('optAlts').checked = state.opt.alts;
  $('maxProduct').value = state.max.product ? itemName(state.max.product) : '';
  $('maxAlts').checked = state.max.alts;

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setMode(t.dataset.mode)));
  $('viewTables').addEventListener('click', () => { state.view = 'tables'; save(); applyView(); });
  $('viewFlow').addEventListener('click', () => { state.view = 'flow'; save(); applyView(); });

  const onTarget = (v) => { const c = nameToClass(v); state.targetItem = c; $('rateUnit').textContent = c && isFluid(c) ? 'm³ / min' : '/ min'; save(); solveAndRender(); };
  $('targetItem').addEventListener('change', (e) => onTarget(e.target.value));
  $('targetItem').addEventListener('input', (e) => { if (nameToClass(e.target.value)) onTarget(e.target.value); });
  $('targetRate').addEventListener('input', (e) => { state.targetRate = parseFloat(e.target.value) || 0; save(); solveAndRender(); });
  $('clock').addEventListener('input', (e) => { state.clock = (parseFloat(e.target.value) || 100) / 100; syncSliderLabels(); save(); solveAndRender(); });
  $('sloop').addEventListener('input', (e) => { state.sloop = (parseFloat(e.target.value) || 100) / 100; syncSliderLabels(); save(); solveAndRender(); });

  $('mRecipe').addEventListener('change', (e) => { state.recipeCost = Number(e.target.value); save(); solveAndRender(); });
  $('mPower').addEventListener('change', (e) => { state.powerMult = Number(e.target.value); save(); solveAndRender(); });
  $('mSpace').addEventListener('change', (e) => { state.spaceMult = Number(e.target.value); save(); solveAndRender(); });

  $('optAddOutput').addEventListener('click', () => { state.opt.outputs.push({ name: '', rate: 60 }); save(); buildOptOutputs(); });
  $('optObjective').addEventListener('change', (e) => { state.opt.objective = e.target.value; save(); solveAndRender(); });
  $('optAlts').addEventListener('change', (e) => { state.opt.alts = e.target.checked; save(); solveAndRender(); });
  $('optAllInputs').addEventListener('click', () => { resList.forEach((r) => (state.opt.inputs[r.c].on = true)); save(); buildOptInputs(); solveAndRender(); });
  $('optNoInputs').addEventListener('click', () => { resList.forEach((r) => (state.opt.inputs[r.c].on = false)); save(); buildOptInputs(); solveAndRender(); });

  $('maxAddSupply').addEventListener('click', () => { state.max.supply.push({ item: resList[0].c, amount: 60 }); save(); buildMaxSupply(); });
  const onProduct = (v) => { state.max.product = nameToClass(v); save(); solveAndRender(); };
  $('maxProduct').addEventListener('change', (e) => onProduct(e.target.value));
  $('maxProduct').addEventListener('input', (e) => { if (nameToClass(e.target.value)) onProduct(e.target.value); });
  $('maxAlts').addEventListener('change', (e) => { state.max.alts = e.target.checked; save(); solveAndRender(); });

  $('btnReset').addEventListener('click', () => { state.picks = {}; save(); solveAndRender(); });
  $('btnClear').addEventListener('click', () => { localStorage.removeItem(LS_KEY); location.reload(); });

  setMode(state.mode);
}
window.addEventListener('DOMContentLoaded', init);
