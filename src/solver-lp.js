'use strict';
// Linear-programming recipe solver for Satisfactory.
// Variables = machine counts m_i (>=0, at 100% clock) per recipe.
// recipeCost scales every recipe's ingredient amounts (Recipe Parts Cost Multiplier).
// powerMult scales every building's power draw (Power Consumption Multiplier).
const solver = require('javascript-lp-solver');
const DATA = require('./data.json');

const RECIPES = DATA.recipes;
const BUILDINGS = DATA.buildings;
const RES = new Set(DATA.resources);
const BIG = 1e7;

// Per-recipe base rates (per machine / min), cost-multiplier applied later.
const RC_INFO = {};
for (const rc in RECIPES) {
  const r = RECIPES[rc];
  const b = BUILDINGS[r.building] || { power: 0, speed: 1, exponent: 1.321929, name: r.building };
  const f = (60 / r.time) * (b.speed || 1);
  const out = {};
  const inn = {};
  for (const g of r.ingredients) inn[g.item] = (inn[g.item] || 0) + g.amount * f;
  for (const p of r.products) out[p.item] = (out[p.item] || 0) + p.amount * f;
  RC_INFO[rc] = {
    out,
    inn,
    power: b.power || 0,
    building: r.building,
    buildingName: b.name,
    primary: r.products[0].item,
    primaryRate: r.products[0].amount * f,
  };
}

const itemsOf = (info) => new Set([...Object.keys(info.out), ...Object.keys(info.inn)]);
const coefOf = (info, item, cost) => (info.out[item] || 0) - (info.inn[item] || 0) * cost;
const rawRateOf = (info, cost) => {
  let s = 0;
  for (const it in info.inn) if (RES.has(it)) s += info.inn[it] * cost;
  return s;
};

// unlockedAlts: optional Set of unlocked alternate recipe classNames (from a save
// file). null/undefined = no restriction (every alternate allowed, original behavior).
function recipePool(allowAlternates, unlockedAlts) {
  return Object.keys(RECIPES).filter((rc) => {
    if (!RECIPES[rc].alternate) return true;
    if (!allowAlternates) return false;
    return !unlockedAlts || unlockedAlts.has(rc);
  });
}

function buildModel({ outputs = {}, inputs = {}, objective = 'raw', allowAlternates = true, maxItem = null, recipeCost = 1, powerMult = 1, unlockedAlts = null }) {
  const pool = recipePool(allowAlternates, unlockedAlts);
  const inPlay = new Set();
  for (const rc of pool) for (const it of itemsOf(RC_INFO[rc])) inPlay.add(it);

  const variables = {};
  for (const rc of pool) {
    const info = RC_INFO[rc];
    const v = { _power: info.power * powerMult, _machines: 1, _raw: rawRateOf(info, recipeCost) };
    for (const it of itemsOf(info)) v[it] = coefOf(info, it, recipeCost);
    if (maxItem) v._out = coefOf(info, maxItem, recipeCost);
    variables[rc] = v;
  }

  const constraints = {};
  for (const it of inPlay) {
    if (!maxItem && outputs[it] != null) constraints[it] = { min: outputs[it] };
    else if (inputs[it] != null) constraints[it] = { min: -(isFinite(inputs[it]) ? inputs[it] : BIG) };
    else constraints[it] = { min: 0 };
  }

  return {
    model: { optimize: maxItem ? '_out' : '_' + objective, opType: maxItem ? 'max' : 'min', constraints, variables },
    pool,
  };
}

function summarize(res, pool, recipeCost, powerMult) {
  const recipes = [];
  const net = {};
  let totalPower = 0;
  let totalMachines = 0;
  for (const rc of pool) {
    const m = res[rc];
    if (!m || m < 1e-6) continue;
    const info = RC_INFO[rc];
    const power = m * info.power * powerMult;
    totalPower += power;
    totalMachines += Math.ceil(m - 1e-9);
    for (const it of itemsOf(info)) net[it] = (net[it] || 0) + coefOf(info, it, recipeCost) * m;
    recipes.push({ rc, item: info.primary, machines: m, building: info.building, buildingName: info.buildingName, rate: info.primaryRate * m, power });
  }
  const raw = [];
  const outputs = [];
  for (const it in net) {
    const v = net[it];
    if (v > 1e-6 && !RES.has(it)) outputs.push({ item: it, rate: v });
    else if (v < -1e-6) raw.push({ item: it, rate: -v });
  }
  return { recipes, raw, outputs, net, totalPower, totalMachines };
}

function optimize({ outputs, allowedInputs, objective = 'raw', allowAlternates = true, recipeCost = 1, powerMult = 1, unlockedAlts = null }) {
  const inputs = {};
  for (const it in allowedInputs) inputs[it] = allowedInputs[it];
  const { model, pool } = buildModel({ outputs, inputs, objective, allowAlternates, recipeCost, powerMult, unlockedAlts });
  const res = solver.Solve(model);
  if (!res.feasible) return { feasible: false };
  const sum = summarize(res, pool, recipeCost, powerMult);
  sum.feasible = true;
  sum.objective = objective;
  sum.objectiveValue = res.result;
  return sum;
}

function maxThroughput({ product, supply, allowAlternates = true, recipeCost = 1, powerMult = 1, unlockedAlts = null }) {
  const { model, pool } = buildModel({ inputs: supply, maxItem: product, allowAlternates, recipeCost, powerMult, unlockedAlts });
  const res = solver.Solve(model);
  if (!res.feasible || !(res.result > 1e-6)) return { feasible: false };
  const sum = summarize(res, pool, recipeCost, powerMult);
  sum.feasible = true;
  sum.maxOutput = res.result;
  sum.utilization = [];
  for (const it in supply) {
    const avail = supply[it];
    const used = sum.net[it] != null ? Math.max(0, -sum.net[it]) : 0;
    sum.utilization.push({ item: it, avail, used, pct: avail > 0 ? used / avail : 0 });
  }
  sum.utilization.sort((a, b) => b.pct - a.pct);
  sum.binding = sum.utilization.filter((u) => u.pct >= 0.999).map((u) => u.item);
  return sum;
}

module.exports = { optimize, maxThroughput, RC_INFO, RES };
