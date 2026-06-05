'use strict';
// Linear-programming recipe solver for Satisfactory.
// Variables = machine counts m_i (>=0, at 100% clock) per recipe.
// recipeCost scales every recipe's ingredient amounts (Recipe Parts Cost Multiplier).
// powerMult scales every building's power draw (Power Consumption Multiplier).
// javascript-lp-solver ships different export shapes per environment: the Node
// CJS build does `module.exports = solver` (so require() gives the instance with
// .Solve), but the browser ESM build does `export { solver as default }`. When
// esbuild bundles the renderer with --platform=browser it picks the browser
// build, and the interop hands back `{ default: solver }` — so a bare
// `solver.Solve` is undefined in the packaged app (planner/optimizer/max all
// silently throw "Solve is not a function"). Normalize to the instance that
// actually carries .Solve, covering both shapes.
const _lp = require('javascript-lp-solver');
const solver = (_lp && typeof _lp.Solve === 'function') ? _lp : ((_lp && _lp.default) || _lp);
const DATA = require('./data.json');

const RECIPES = DATA.recipes;
const BUILDINGS = DATA.buildings;
const RES = new Set(DATA.resources);
const ITEMS = DATA.items || {};
const GENERATORS = DATA.generators || {};
const BIG = 1e7;

// By-product disposal metadata. The Awesome Sink only accepts SOLIDS on belts, so a
// fluid's sink-point value is moot — only solids can be sunk. Liquid/gas fuels instead
// leave the system by being burned in a Fuel Generator for power. GEN_BURN flattens
// every (generator, fuel) pair into a disposal route: `burn` is units/min consumed per
// generator at 100 % clock, `power` the MW it yields.
const sinkPointsOf = (it) => (ITEMS[it] && !ITEMS[it].liquid ? (ITEMS[it].sinkPoints || 0) : 0);
const isSinkable = (it) => sinkPointsOf(it) > 0;
const GEN_BURN = [];
for (const g in GENERATORS) {
  const G = GENERATORS[g];
  for (const fuel in (G.fuels || {})) {
    GEN_BURN.push({ key: '__gen__' + g + '__' + fuel, gen: g, genName: G.name, fuel, burn: G.fuels[fuel], power: G.power || 0 });
  }
}

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

function buildModel({ outputs = {}, inputs = {}, objective = 'raw', allowAlternates = true, maxItem = null, recipeCost = 1, powerMult = 1, unlockedAlts = null, sinkByproducts = false }) {
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

  // Disposal routes (optimize only): let by-products leave the system the way they do
  // in-game — solids into the Awesome Sink, liquid/gas fuels burned in a Fuel Generator
  // for power. Each is a non-negative variable that *consumes* its item. Paired with the
  // net-zero by-product balance below, this forces the solver to route every surplus
  // by-product through a real recipe, the sink, or a generator — or report infeasible,
  // instead of letting it pile up as a phantom output that would deadlock the pipes.
  const disposal = { sinks: [], gens: [] };
  if (sinkByproducts && !maxItem) {
    for (const it of inPlay) {
      if (outputs[it] != null || inputs[it] != null || !isSinkable(it)) continue;
      const key = '__sink__' + it;
      variables[key] = { [it]: -1, _power: 0, _machines: 0, _raw: 0 };
      disposal.sinks.push({ key, item: it });
    }
    for (const gb of GEN_BURN) {
      if (!inPlay.has(gb.fuel) || outputs[gb.fuel] != null || inputs[gb.fuel] != null) continue;
      variables[gb.key] = { [gb.fuel]: -gb.burn, _power: 0, _machines: 1, _raw: 0 };
      disposal.gens.push(gb);
    }
  }

  const constraints = {};
  for (const it of inPlay) {
    if (!maxItem && outputs[it] != null) constraints[it] = { min: outputs[it] };
    else if (inputs[it] != null) constraints[it] = { min: -(isFinite(inputs[it]) ? inputs[it] : BIG) };
    else if (sinkByproducts && !maxItem) constraints[it] = { equal: 0 }; // by-product: produce == consume (no backup)
    else constraints[it] = { min: 0 };
  }

  return {
    model: { optimize: maxItem ? '_out' : '_' + objective, opType: maxItem ? 'max' : 'min', constraints, variables },
    pool, disposal,
  };
}

function summarize(res, pool, recipeCost, powerMult, disposal) {
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
  // Fold disposal consumption back into the balance so sunk/burned by-products net to
  // zero (not reported as phantom outputs), and tally what left via each channel.
  const sunk = [];
  const burned = [];
  let recoveredPower = 0;
  if (disposal) {
    for (const s of disposal.sinks) {
      const v = res[s.key];
      if (!v || v < 1e-6) continue;
      net[s.item] = (net[s.item] || 0) - v;
      sunk.push({ item: s.item, rate: v, points: v * sinkPointsOf(s.item) });
    }
    for (const g of disposal.gens) {
      const v = res[g.key];
      if (!v || v < 1e-6) continue;
      net[g.fuel] = (net[g.fuel] || 0) - v * g.burn;
      const mw = v * g.power;
      recoveredPower += mw;
      totalMachines += Math.ceil(v - 1e-9);
      burned.push({ item: g.fuel, rate: v * g.burn, machines: v, gen: g.gen, genName: g.genName, mw });
    }
  }
  const raw = [];
  const outputs = [];
  for (const it in net) {
    const v = net[it];
    if (v > 1e-6 && !RES.has(it)) outputs.push({ item: it, rate: v });
    else if (v < -1e-6) raw.push({ item: it, rate: -v });
  }
  return { recipes, raw, outputs, net, totalPower, totalMachines, sunk, burned, recoveredPower };
}

function optimize({ outputs, allowedInputs, objective = 'raw', allowAlternates = true, recipeCost = 1, powerMult = 1, unlockedAlts = null, sinkByproducts = false }) {
  const inputs = {};
  for (const it in allowedInputs) inputs[it] = allowedInputs[it];
  const { model, pool, disposal } = buildModel({ outputs, inputs, objective, allowAlternates, recipeCost, powerMult, unlockedAlts, sinkByproducts });
  const res = solver.Solve(model);
  if (!res.feasible) {
    // Tell "can't make the outputs at all" apart from "a by-product would back up": if
    // the same request solves once the net-zero balance is relaxed, the blocker is a
    // surplus by-product that can't be sunk (a fluid with no consumer) — name it so the
    // UI can point the user at a recipe that consumes it.
    if (sinkByproducts) {
      const relaxed = buildModel({ outputs, inputs, objective, allowAlternates, recipeCost, powerMult, unlockedAlts, sinkByproducts: false });
      const rres = solver.Solve(relaxed.model);
      if (rres.feasible) {
        const rsum = summarize(rres, relaxed.pool, recipeCost, powerMult, relaxed.disposal);
        const backup = rsum.outputs.filter((o) => outputs[o.item] == null && !isSinkable(o.item)).map((o) => o.item);
        if (backup.length) return { feasible: false, backup };
      }
    }
    return { feasible: false };
  }
  const sum = summarize(res, pool, recipeCost, powerMult, disposal);
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

// Fixed-recipe material balance for the Planner. `recipes` is the exact set of
// chosen recipe classNames (one per produced item); the LP finds machine counts
// that meet the demanded rate of each target while crediting by-products and
// resolving loops — both impossible with naive tree recursion. Demand is given as
// `targets` (a {item: rate} map for one or more desired outputs); the legacy
// single `target`/`rate` pair is still accepted. `rawItems` are treated as free
// inputs (map resources are always free). Solved at 100 % clock; the renderer
// rescales machines & power for clock / somersloop afterwards (those cancel in
// the material ratios, so they don't belong in the balance).
function planner({ target, rate, targets = null, recipes = [], rawItems = [], recipeCost = 1 }) {
  const demand = targets || (target != null ? { [target]: rate } : {});
  const pool = recipes.filter((rc) => RECIPES[rc]);
  if (!pool.length) return { feasible: false };
  const free = new Set(rawItems);
  const inPlay = new Set();
  for (const rc of pool) for (const it of itemsOf(RC_INFO[rc])) inPlay.add(it);

  const variables = {};
  for (const rc of pool) {
    const info = RC_INFO[rc];
    const v = { _machines: 1 };
    for (const it of itemsOf(info)) v[it] = coefOf(info, it, recipeCost);
    variables[rc] = v;
  }
  const constraints = {};
  for (const it of inPlay) {
    if (demand[it] != null) constraints[it] = { min: demand[it] }; // meet each target's demand
    else if (RES.has(it) || free.has(it)) constraints[it] = { min: -BIG }; // free input
    else constraints[it] = { min: 0 }; // intermediates: produce ≥ consume (surplus ok)
  }
  // Minimise total machines so by-products are consumed before extra machines are
  // built; whatever is over-produced floats up as genuine surplus.
  const res = solver.Solve({ optimize: '_machines', opType: 'min', constraints, variables });
  if (!res.feasible) return { feasible: false };
  const sum = summarize(res, pool, recipeCost, 1);
  sum.feasible = true;
  return sum;
}

module.exports = { optimize, maxThroughput, planner, RC_INFO, RES };
