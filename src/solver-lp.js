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
// Negligible per-activity cost folded into the optimizer objective so the solver never
// spins a zero-cost cycle. Reversible recipe pairs (package <-> unpackage a fluid) cancel
// to net zero and are FREE under the raw/power objectives, so a degenerate optimum can
// leave them recirculating forever. This is far smaller than any real objective gap, so
// it never changes the chosen plan — it only makes pointless recirculation strictly worse
// than not running it. The true objective value is recomputed for display, not read off
// the regularized score.
const EPS_ACTIVITY = 1e-6;

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

// Water by-product disposal via the "Wet Concrete" alternate (6 Limestone + 5 Water -> 4
// Concrete, in a Refinery). Water is a raw RESOURCE, so without this surplus by-product
// water just floats as a free input and silently vanishes from the plan — but in-game it
// backs up the pipes and forces a fragile recirculation loop (e.g. an aluminum refinery's
// scrap-step water fed back into its alumina step). When the optimizer's water-sink option
// is on, every recipe's water OUTPUT is diverted to a virtual waste item that ONLY this
// route consumes, turning surplus water into sinkable Concrete with no loop. Water INPUTS
// stay on the real item, drawn fresh from extractors.
const WATER = 'Desc_Water_C';
const WASTE_WATER = '__wastewater__';
const CONCRETE = 'Desc_Cement_C';
const LIMESTONE = 'Desc_Stone_C';
const WET_CONCRETE_RC = 'Recipe_Alternate_WetConcrete_C';

// Unpackage recipes (Packaged X -> X + container) merely reverse a packaging step. When
// the optimizer builds from raw resources they are never useful on their own — running one
// only makes sense to consume a Packaged X you already have, otherwise it just pairs with
// the matching package recipe to spin a pointless, machine-wasting Water<->Packaged Water
// (or fuel) cycle instead of using a real producer (e.g. Empty Canister from Plastic). So
// they're dropped from the pool unless their packaged input is supplied as a free input.
const UNPACKAGE = new Set(Object.keys(RECIPES).filter((rc) => /unpackage/i.test(rc) || /^Unpackage/i.test(RECIPES[rc].name || '')));

// Per-recipe base rates (per machine / min); the cost multiplier is applied per-solve.
const RC_INFO = {};
for (const rc in RECIPES) {
  const r = RECIPES[rc];
  const b = BUILDINGS[r.building] || { power: 0, speed: 1, exponent: 1.321929, name: r.building };
  const f = (60 / r.time) * (b.speed || 1); // recipe executions per machine per minute
  const out = {};
  const inn = {};    // ingredient rate per machine/min (amount * f)
  const innAmt = {}; // raw ingredient amount per recipe (the cost multiplier rounds THIS)
  for (const g of r.ingredients) { inn[g.item] = (inn[g.item] || 0) + g.amount * f; innAmt[g.item] = (innAmt[g.item] || 0) + g.amount; }
  for (const p of r.products) out[p.item] = (out[p.item] || 0) + p.amount * f;
  RC_INFO[rc] = {
    out, inn, innAmt, f,
    power: b.power || 0,
    building: r.building,
    buildingName: b.name,
    primary: r.products[0].item,
    primaryRate: r.products[0].amount * f,
  };
}

// Recipe Parts Cost Multiplier: scale each ingredient AMOUNT then round to a whole unit —
// mirroring the game, where part costs are integers. So a 1:1 recipe (1 ore -> 1 ingot)
// stays at 1 under 0.5x (round(0.5)=1) and only multi-part recipes (amount >= 2) shrink.
// cost===1 returns the exact amount, so vanilla and any fractional-fluid recipes are
// untouched; a needed ingredient never rounds away to free (floored at 1).
function effAmount(amt, cost) {
  if (!amt) return 0;
  if (cost === 1) return amt;
  const r = Math.round(amt * cost);
  return r < 1 ? 1 : r;
}
const effInnRate = (info, item, cost) => effAmount(info.innAmt[item] || 0, cost) * info.f;
const itemsOf = (info) => new Set([...Object.keys(info.out), ...Object.keys(info.inn)]);
// `sloop` is the step's Somersloop output multiplier (1×..2×). Per the game rule it
// amplifies OUTPUT only — inputs per machine are unchanged — so it must live in the
// material balance (unlike clock, which scales inputs and outputs equally and cancels).
const coefOf = (info, item, cost, sloop = 1) => (info.out[item] || 0) * sloop - effInnRate(info, item, cost);
const rawRateOf = (info, cost) => {
  let s = 0;
  for (const it in info.innAmt) if (RES.has(it)) s += effInnRate(info, it, cost);
  return s;
};

// unlockedAlts: optional Set of unlocked alternate recipe classNames (from a save
// file). null/undefined = no restriction (every alternate allowed, original behavior).
// blockedRecipes: optional Set of recipe classNames the user has forbidden outright —
// applies to EVERY recipe (standard or alternate) and to whole buildings (the renderer
// expands a disabled building into all its recipe classNames before calling). A blocked
// recipe is simply absent from the pool, so the optimizer/max can never use it.
function recipePool(allowAlternates, unlockedAlts, blockedRecipes) {
  return Object.keys(RECIPES).filter((rc) => {
    if (blockedRecipes && blockedRecipes.has(rc)) return false;
    if (!RECIPES[rc].alternate) return true;
    if (!allowAlternates) return false;
    return !unlockedAlts || unlockedAlts.has(rc);
  });
}

function buildModel({ outputs = {}, inputs = {}, objective = 'raw', allowAlternates = true, maxItem = null, recipeCost = 1, powerMult = 1, unlockedAlts = null, blockedRecipes = null, sinkByproducts = false, waterSink = false, sloopMult = null }) {
  // Keep an unpackage recipe only when its packaged input is actually supplied; otherwise
  // it can only form a degenerate package<->unpackage loop (see UNPACKAGE note above).
  const pool = recipePool(allowAlternates, unlockedAlts, blockedRecipes).filter(
    (rc) => !UNPACKAGE.has(rc) || RECIPES[rc].ingredients.some((g) => inputs[g.item] != null)
  );
  const inPlay = new Set();
  for (const rc of pool) for (const it of itemsOf(RC_INFO[rc])) inPlay.add(it);

  // Water-sink route availability: the optimizer may divert surplus by-product water into
  // Wet Concrete (-> sinkable Concrete) instead of letting it loop or float. Gated to the
  // optimizer (not max), to the recipe being present and allowed (respects block + save
  // unlock, but NOT the alternates toggle — enabling this is an explicit opt-in to that
  // recipe), and skipped when the user actually wants Water itself as a product.
  const wetAvail = waterSink && !maxItem && RC_INFO[WET_CONCRETE_RC]
    && outputs[WATER] == null
    && !(blockedRecipes && blockedRecipes.has(WET_CONCRETE_RC))
    && !(unlockedAlts && !unlockedAlts.has(WET_CONCRETE_RC));
  if (wetAvail) inPlay.add(CONCRETE); // the route's Concrete output needs a constraint (sink / output)

  const variables = {};
  for (const rc of pool) {
    const info = RC_INFO[rc];
    const sl = (sloopMult && sloopMult[rc]) || 1;
    const v = { _power: info.power * powerMult, _machines: 1, _raw: rawRateOf(info, recipeCost) };
    for (const it of itemsOf(info)) v[it] = coefOf(info, it, recipeCost, sl);
    if (maxItem) v._out = coefOf(info, maxItem, recipeCost, sl);
    variables[rc] = v;
  }

  // Divert every recipe's water OUTPUT to the virtual waste item so it can't net against
  // fresh-water demand — that netting IS the recirculation loop we're breaking. Water
  // INPUTS keep their real-item coefficient and are met fresh from extractors.
  if (wetAvail) {
    for (const rc of pool) {
      const sl = (sloopMult && sloopMult[rc]) || 1;
      const wOut = (RC_INFO[rc].out[WATER] || 0) * sl;
      if (wOut <= 1e-12) continue;
      const v = variables[rc];
      v[WASTE_WATER] = (v[WASTE_WATER] || 0) + wOut;
      v[WATER] = (v[WATER] || 0) - wOut;
      if (Math.abs(v[WATER]) < 1e-12) delete v[WATER];
    }
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
  // Wet Concrete water route: consumes the diverted waste water + raw Limestone and emits
  // Concrete (a solid, so the sink loop above can route it onward / it floats as output if
  // sinking is off). Added whenever wetAvail, independent of the solid/fuel sink toggle.
  if (wetAvail) {
    const info = RC_INFO[WET_CONCRETE_RC];
    const waterIn = effInnRate(info, WATER, recipeCost);
    const stoneIn = effInnRate(info, LIMESTONE, recipeCost);
    const cementOut = info.out[CONCRETE] || 0;
    const power = info.power * powerMult;
    variables['__wet__'] = { [WASTE_WATER]: -waterIn, [LIMESTONE]: -stoneIn, [CONCRETE]: cementOut, _power: power, _machines: 1, _raw: stoneIn };
    disposal.wet = { key: '__wet__', waterIn, stoneIn, cementOut, power };
  }

  const constraints = {};
  for (const it of inPlay) {
    // An item can be BOTH demanded and supplied (e.g. an Optimizer plan that project-links
    // a part it also outputs): net the supply against the demand instead of ignoring it.
    if (!maxItem && outputs[it] != null) constraints[it] = { min: outputs[it] - (inputs[it] != null ? (isFinite(inputs[it]) ? inputs[it] : BIG) : 0) };
    else if (inputs[it] != null) constraints[it] = { min: -(isFinite(inputs[it]) ? inputs[it] : BIG) };
    else if (sinkByproducts && !maxItem) constraints[it] = { equal: 0 }; // by-product: produce == consume (no backup)
    else constraints[it] = { min: 0 };
  }
  if (wetAvail) constraints[WASTE_WATER] = { equal: 0 }; // all diverted water must leave via the Wet Concrete route

  // Minimization carries the chosen objective plus the tiny activity tie-break in one key
  // (`_score`), so a free package<->unpackage cycle can never spin. Max-throughput keeps a
  // pure `_out` objective (cycles there are bounded by supply and add no output anyway).
  const objKey = '_' + objective;
  if (!maxItem) for (const k in variables) variables[k]._score = (variables[k][objKey] || 0) + EPS_ACTIVITY;

  return {
    model: { optimize: maxItem ? '_out' : '_score', opType: maxItem ? 'max' : 'min', constraints, variables },
    pool, disposal,
  };
}

function summarize(res, pool, recipeCost, powerMult, disposal, sloopMult) {
  const recipes = [];
  const net = {};
  let totalPower = 0;
  let totalMachines = 0;
  let fracMachines = 0; // un-rounded machine-equivalents, for reporting the true objective
  for (const rc of pool) {
    const m = res[rc];
    if (!m || m < 1e-6) continue;
    const info = RC_INFO[rc];
    const sl = (sloopMult && sloopMult[rc]) || 1;
    const power = m * info.power * powerMult;
    totalPower += power;
    totalMachines += Math.ceil(m - 1e-9);
    fracMachines += m;
    for (const it of itemsOf(info)) net[it] = (net[it] || 0) + coefOf(info, it, recipeCost, sl) * m;
    recipes.push({ rc, item: info.primary, machines: m, building: info.building, buildingName: info.buildingName, rate: info.primaryRate * sl * m, power });
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
      fracMachines += v;
      burned.push({ item: g.fuel, rate: v * g.burn, machines: v, gen: g.gen, genName: g.genName, mw });
    }
  }
  // Wet Concrete water route: not a pool recipe, so fold its raw Limestone draw and
  // Concrete output into `net` by hand and tally its refineries' machines/power.
  const watered = [];
  if (disposal && disposal.wet) {
    const v = res[disposal.wet.key];
    if (v && v > 1e-6) {
      const w = disposal.wet;
      // summarize rebuilds `net` from each recipe's ORIGINAL water output, so it re-credits
      // the diverted water to net[WATER]; cancel that here (it physically left as Concrete).
      // The WASTE_WATER balance guarantees waterIn*v == the total diverted output, leaving
      // net[WATER] = -(fresh draw) only — no phantom surplus for downstream links to grab.
      net[WATER] = (net[WATER] || 0) - w.waterIn * v;
      net[LIMESTONE] = (net[LIMESTONE] || 0) - w.stoneIn * v;
      net[CONCRETE] = (net[CONCRETE] || 0) + w.cementOut * v;
      totalMachines += Math.ceil(v - 1e-9);
      fracMachines += v;
      totalPower += w.power * v;
      watered.push({ item: WATER, rate: w.waterIn * v, concrete: w.cementOut * v, limestone: w.stoneIn * v, machines: v });
    }
  }
  const raw = [];
  const outputs = [];
  let rawTotal = 0;
  for (const it in net) {
    const v = net[it];
    if (v > 1e-6 && !RES.has(it)) outputs.push({ item: it, rate: v });
    else if (v < -1e-6) { raw.push({ item: it, rate: -v }); rawTotal += -v; }
  }
  return { recipes, raw, outputs, net, totalPower, totalMachines, fracMachines, rawTotal, sunk, burned, recoveredPower, watered };
}

function optimize({ outputs, allowedInputs, objective = 'raw', allowAlternates = true, recipeCost = 1, powerMult = 1, unlockedAlts = null, blockedRecipes = null, sinkByproducts = false, waterSink = false, sloopMult = null }) {
  const inputs = {};
  for (const it in allowedInputs) inputs[it] = allowedInputs[it];
  const { model, pool, disposal } = buildModel({ outputs, inputs, objective, allowAlternates, recipeCost, powerMult, unlockedAlts, blockedRecipes, sinkByproducts, waterSink, sloopMult });
  // A demanded item no pooled recipe produces (every producer blocked / not unlocked)
  // would otherwise be silently dropped from the constraints — the solver would return a
  // feasible EMPTY plan. Detect it and report infeasible with the orphaned items named,
  // unless the demand is already covered by a supplied input (netting above handles that).
  const noProducer = Object.keys(outputs).filter((it) => {
    if (!(outputs[it] > 0)) return false;
    if (inputs[it] != null && (!isFinite(inputs[it]) || inputs[it] >= outputs[it])) return false;
    return !pool.some((rc) => (RC_INFO[rc].out[it] || 0) > 0);
  });
  if (noProducer.length) return { feasible: false, noProducer };
  const res = solver.Solve(model);
  if (!res.feasible) {
    // Tell "can't make the outputs at all" apart from "a by-product would back up": if
    // the same request solves once the net-zero balance is relaxed, the blocker is a
    // surplus by-product that can't be sunk (a fluid with no consumer) — name it so the
    // UI can point the user at a recipe that consumes it.
    if (sinkByproducts) {
      const relaxed = buildModel({ outputs, inputs, objective, allowAlternates, recipeCost, powerMult, unlockedAlts, blockedRecipes, sinkByproducts: false, waterSink, sloopMult });
      const rres = solver.Solve(relaxed.model);
      if (rres.feasible) {
        const rsum = summarize(rres, relaxed.pool, recipeCost, powerMult, relaxed.disposal, sloopMult);
        const backup = rsum.outputs.filter((o) => outputs[o.item] == null && !isSinkable(o.item)).map((o) => o.item);
        if (backup.length) return { feasible: false, backup };
      }
    }
    return { feasible: false };
  }
  const sum = summarize(res, pool, recipeCost, powerMult, disposal, sloopMult);
  sum.feasible = true;
  sum.objective = objective;
  // Report the true objective, not the regularized score (res.result carries the tiny
  // EPS_ACTIVITY tie-break added in buildModel).
  sum.objectiveValue = objective === 'raw' ? sum.rawTotal : objective === 'power' ? sum.totalPower : sum.fracMachines;
  return sum;
}

function maxThroughput({ product, supply, allowAlternates = true, recipeCost = 1, powerMult = 1, unlockedAlts = null, blockedRecipes = null }) {
  const { model, pool } = buildModel({ inputs: supply, maxItem: product, allowAlternates, recipeCost, powerMult, unlockedAlts, blockedRecipes });
  const res = solver.Solve(model);
  // An unbounded objective (e.g. a cost multiplier < 1 rounding a package<->unpackage
  // pair matter-positive) reports as feasible with result = Infinity — surface it as
  // its own failure instead of presenting "Infinity/min" to the user.
  if (res.feasible && !isFinite(res.result)) return { feasible: false, unbounded: true };
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
// rescales machines & power for clock afterwards (clock scales inputs and outputs
// equally, so it cancels in the material ratios). Somersloop does NOT cancel — it
// amplifies output only — so each step's sloop multiplier (`sloopMult`, rc -> 1..2)
// is folded into the balance here: a slooped step needs fewer machines AND less
// input for the same output, which correctly shrinks the upstream chain and raw.
function planner({ target, rate, targets = null, recipes = [], rawItems = [], recipeCost = 1, sloopMult = null }) {
  const demand = targets || (target != null ? { [target]: rate } : {});
  const pool = recipes.filter((rc) => RECIPES[rc]);
  if (!pool.length) return { feasible: false };
  const free = new Set(rawItems);
  const inPlay = new Set();
  for (const rc of pool) for (const it of itemsOf(RC_INFO[rc])) inPlay.add(it);

  const variables = {};
  for (const rc of pool) {
    const info = RC_INFO[rc];
    const sl = (sloopMult && sloopMult[rc]) || 1;
    const v = { _machines: 1 };
    for (const it of itemsOf(info)) v[it] = coefOf(info, it, recipeCost, sl);
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
  const sum = summarize(res, pool, recipeCost, 1, null, sloopMult);
  sum.feasible = true;
  return sum;
}

module.exports = { optimize, maxThroughput, planner, RC_INFO, RES, effAmount };
