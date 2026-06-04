'use strict';
// Linear-programming recipe solver for Satisfactory.
// Variables = machine counts m_i (>=0, at 100% clock) per recipe.
// Item balance coefficient (per machine, per minute) = (producedAmt - consumedAmt) * 60 / time * speed.
const solver = require('javascript-lp-solver');
const DATA = require('./data.json');

const RECIPES = DATA.recipes;
const BUILDINGS = DATA.buildings;
const RES = new Set(DATA.resources);
const BIG = 1e7;

// Pre-compute per-recipe coefficient tables once.
const RC_INFO = {};
for (const rc in RECIPES) {
  const r = RECIPES[rc];
  const b = BUILDINGS[r.building] || { power: 0, speed: 1, exponent: 1.321929, name: r.building };
  const f = (60 / r.time) * (b.speed || 1);
  const coef = {}; // item -> net per machine/min
  let rawRate = 0; // raw resource units consumed per machine/min
  for (const g of r.ingredients) {
    coef[g.item] = (coef[g.item] || 0) - g.amount * f;
    if (RES.has(g.item)) rawRate += g.amount * f;
  }
  for (const p of r.products) coef[p.item] = (coef[p.item] || 0) + p.amount * f;
  RC_INFO[rc] = {
    coef,
    rawRate,
    power: b.power || 0,
    building: r.building,
    buildingName: b.name,
    primary: r.products[0].item,
    primaryRate: r.products[0].amount * f,
  };
}

function recipePool(allowAlternates) {
  return Object.keys(RECIPES).filter((rc) => allowAlternates || !RECIPES[rc].alternate);
}

function itemsInPlay(pool) {
  const s = new Set();
  for (const rc of pool) for (const it in RC_INFO[rc].coef) s.add(it);
  return s;
}

// Build the jsLPSolver model.
//  outputs: { itemClass: minRatePerMin }      (optimize mode targets)
//  inputs:  { itemClass: maxAvailPerMin }     (allowed raws / provided supply; Infinity ok)
//  objective: 'raw' | 'power' | 'machines'    (min modes)
//  maxItem: itemClass                          (if set -> maximize its net output instead)
function buildModel({ outputs = {}, inputs = {}, objective = 'raw', allowAlternates = true, maxItem = null }) {
  const pool = recipePool(allowAlternates);
  const inPlay = itemsInPlay(pool);

  const variables = {};
  for (const rc of pool) {
    const info = RC_INFO[rc];
    const v = { _power: info.power, _machines: 1, _raw: info.rawRate };
    for (const it in info.coef) v[it] = info.coef[it];
    if (maxItem) v._out = info.coef[maxItem] || 0;
    variables[rc] = v;
  }

  const constraints = {};
  for (const it of inPlay) {
    if (!maxItem && outputs[it] != null) {
      constraints[it] = { min: outputs[it] }; // must produce at least this much net
    } else if (inputs[it] != null) {
      const cap = isFinite(inputs[it]) ? inputs[it] : BIG;
      constraints[it] = { min: -cap }; // consumption (negative net) bounded by availability
    } else {
      constraints[it] = { min: 0 }; // intermediates: surplus ok, no pulling from nothing
    }
  }

  const model = {
    optimize: maxItem ? '_out' : '_' + objective,
    opType: maxItem ? 'max' : 'min',
    constraints,
    variables,
  };
  return { model, pool, inPlay };
}

// Summarise a solved result into rows/totals.
function summarize(res, pool) {
  const recipes = [];
  const net = {}; // item -> net rate
  let totalPower = 0;
  let totalMachines = 0;

  for (const rc of pool) {
    const m = res[rc];
    if (!m || m < 1e-6) continue;
    const info = RC_INFO[rc];
    const power = m * info.power;
    totalPower += power;
    totalMachines += Math.ceil(m - 1e-9);
    for (const it in info.coef) net[it] = (net[it] || 0) + info.coef[it] * m;
    recipes.push({
      rc,
      item: info.primary,
      machines: m,
      building: info.building,
      buildingName: info.buildingName,
      rate: info.primaryRate * m,
      power,
    });
  }

  const raw = [];
  const outputs = [];
  const byproducts = [];
  for (const it in net) {
    const v = net[it];
    if (v < -1e-6 && RES.has(it)) raw.push({ item: it, rate: -v });
    else if (v > 1e-6 && !RES.has(it)) outputs.push({ item: it, rate: v });
    else if (v < -1e-6) raw.push({ item: it, rate: -v }); // consumed non-resource pulled as input
  }

  return { recipes, raw, outputs, byproducts, net, totalPower, totalMachines };
}

// ---- public: optimize recipe selection ----
function optimize({ outputs, allowedInputs, objective = 'raw', allowAlternates = true }) {
  const inputs = {};
  for (const it in allowedInputs) inputs[it] = allowedInputs[it]; // value = cap (Infinity -> unlimited)
  const { model, pool } = buildModel({ outputs, inputs, objective, allowAlternates });
  const res = solver.Solve(model);
  if (!res.feasible) return { feasible: false };
  const sum = summarize(res, pool);
  sum.feasible = true;
  sum.objective = objective;
  sum.objectiveValue = res.result;
  return sum;
}

// ---- public: maximize throughput of one product from given supply ----
function maxThroughput({ product, supply, allowAlternates = true }) {
  const { model, pool } = buildModel({ inputs: supply, maxItem: product, allowAlternates });
  const res = solver.Solve(model);
  if (!res.feasible || !(res.result > 1e-6)) return { feasible: false };
  const sum = summarize(res, pool);
  sum.feasible = true;
  sum.maxOutput = res.result;
  // input utilisation + limiting factor
  sum.utilization = [];
  for (const it in supply) {
    const avail = supply[it];
    const used = sum.net[it] != null ? Math.max(0, -sum.net[it]) : 0;
    const pct = avail > 0 ? used / avail : 0;
    sum.utilization.push({ item: it, avail, used, pct });
  }
  sum.utilization.sort((a, b) => b.pct - a.pct);
  sum.binding = sum.utilization.filter((u) => u.pct >= 0.999).map((u) => u.item);
  return sum;
}

module.exports = { optimize, maxThroughput, RC_INFO, RES };
