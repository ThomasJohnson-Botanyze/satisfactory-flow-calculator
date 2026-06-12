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
require('./nuclear-burn'); // injects the reactor burn pseudo-recipes BEFORE the pool scan below
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
// Packaged-water disposal (the LOOPS-ALLOWED alternative to Wet Concrete): by-product
// water keeps netting against local demand — the aluminum backfeed stays — and only the
// plan's NET surplus must leave, packaged into sinkable Packaged Water by ordinary pool
// recipes (Packager + an in-plan Empty Canister chain, so the canister inputs and their
// crafting steps show up as real machines). Enforced with a single extra constraint:
// net water ≤ 0 (a plan may draw fresh water, never accumulate it).
const PKG_WATER_RC = 'Recipe_PackagedWater_C';

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
    // Generator burn steps are physics, not crafting — the Recipe Parts Cost Multiplier
    // must not round their fuel/water draw (see nuclear-burn.js).
    noCost: !!r.burner,
  };
}

// Recipe Parts Cost Multiplier: scale each ingredient AMOUNT then round to a whole unit
// of that item's NATIVE granularity — mirroring the game, where SOLID part costs are
// integers but FLUIDS are stored in mL (1 m³ = 1000), so a fluid's cost rounds at the
// mL: 3 m³ Crude Oil at 0.5× is exactly 1.5 m³ (the game shows 15/min for the Heavy Oil
// Residue alternate), NOT round(1.5)=2. So a 1:1 solid recipe (1 ore -> 1 ingot) stays
// at 1 under 0.5x and only multi-part solid recipes shrink. cost===1 returns the exact
// amount; a needed ingredient never rounds away to free (floored at 1 unit / 1 mL).
function effAmount(amt, cost, liquid = false) {
  if (!amt) return 0;
  if (cost === 1) return amt;
  if (liquid) {
    const r = Math.round(amt * 1000 * cost);
    return (r < 1 ? 1 : r) / 1000;
  }
  const r = Math.round(amt * cost);
  return r < 1 ? 1 : r;
}
const effInnRate = (info, item, cost) => effAmount(info.innAmt[item] || 0, info.noCost ? 1 : cost, !!(ITEMS[item] && ITEMS[item].liquid)) * info.f;
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

function buildModel({ outputs = {}, inputs = {}, objective = 'raw', allowAlternates = true, maxItem = null, recipeCost = 1, powerMult = 1, unlockedAlts = null, blockedRecipes = null, sinkByproducts = false, waterSink = false, packageWater = false, exportWaste = false, sloopMult = null }) {
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
    else if (sinkByproducts && !maxItem) {
      // No-backup rule: a by-product must leave through a real consumer, the sink, or a
      // generator (produce == consume). OPT-IN EXCEPTION (exportWaste) — an UNSINKABLE
      // SOLID (nuclear waste: zero sink points, not a fluid) can't deadlock a pipe and
      // can be belted out to storage or a linked factory, so it floats up as exportable
      // surplus (min 0) instead of being forced through in-plan reprocessing (or turning
      // the plan infeasible). Off by default: the forced no-waste loop is the safer
      // single-factory answer. Virtual items (reactor MW) stay forced either way.
      const exportable = exportWaste && ITEMS[it] && !ITEMS[it].liquid && !ITEMS[it].virtual && !isSinkable(it);
      constraints[it] = exportable ? { min: 0 } : { equal: 0 };
    } else constraints[it] = { min: 0 };
  }
  if (wetAvail) constraints[WASTE_WATER] = { equal: 0 }; // all diverted water must leave via the Wet Concrete route

  // Packaged-water route (see PKG_WATER_RC note): cap NET water at ≤ 0 so a genuine
  // surplus is forced through the ordinary Packaged Water pool recipe (and its in-plan
  // canister chain) instead of silently floating. By-product water still nets against
  // local consumers first — recirculation loops stay legal, only the leftovers leave.
  // Skipped when the user demands Water itself, when Wet Concrete already diverts every
  // water output, or when the recipe is vetoed; an `equal` constraint is already ≤ 0.
  const pkgAvail = packageWater && !maxItem && RECIPES[PKG_WATER_RC]
    && outputs[WATER] == null && !wetAvail
    && !(blockedRecipes && blockedRecipes.has(PKG_WATER_RC));
  if (pkgAvail && constraints[WATER] && constraints[WATER].equal == null) constraints[WATER].max = 0;

  // Minimization carries the chosen objective plus the tiny activity tie-break in one key
  // (`_score`), so a free package<->unpackage cycle can never spin. Max-throughput keeps a
  // pure `_out` objective (cycles there are bounded by supply and add no output anyway).
  // 'machinesLP' is the INTERNAL fractional machine objective — the public 'machines'
  // objective is whole-machine greedy refinement over it (see optimizeWholeMachines).
  const objKey = '_' + (objective === 'machinesLP' ? 'machines' : objective);
  if (!maxItem) for (const k in variables) variables[k]._score = (variables[k][objKey] || 0) + EPS_ACTIVITY;

  return {
    model: { optimize: maxItem ? '_out' : '_score', opType: maxItem ? 'max' : 'min', constraints, variables },
    pool, disposal,
  };
}

function summarize(res, pool, recipeCost, powerMult, disposal, sloopMult) {
  const recipes = [];
  const net = {};
  const gross = {}; // Σ production + consumption per item — sets the scale solver noise lives at
  let totalPower = 0;
  let totalMachines = 0;
  let fracMachines = 0; // un-rounded machine-equivalents, for reporting the true objective
  for (const rc of pool) {
    let m = res[rc];
    if (!m || m < 1e-6) continue;
    // Simplex dust can land a machine count at 42.0000000001, which Math.ceil would
    // silently inflate to 43 whole machines — snap counts that are within noise of an
    // integer (the tolerance scales with the count, like the dust does).
    const mr = Math.round(m);
    if (Math.abs(m - mr) <= 1e-7 + m * 1e-9) m = mr;
    if (!m) continue;
    const info = RC_INFO[rc];
    const sl = (sloopMult && sloopMult[rc]) || 1;
    const power = m * info.power * powerMult;
    totalPower += power;
    totalMachines += Math.ceil(m - 1e-9);
    fracMachines += m;
    for (const it of itemsOf(info)) {
      const o = (info.out[it] || 0) * sl * m;
      const i = effInnRate(info, it, recipeCost) * m;
      net[it] = (net[it] || 0) + (o - i);
      gross[it] = (gross[it] || 0) + o + i;
    }
    recipes.push({ rc, item: info.primary, machines: m, building: info.building, buildingName: info.buildingName, rate: info.primaryRate * sl * m, power });
  }
  // Float-noise cutoff for an item's net balance. The simplex residue scales with the
  // rates flowing through the item (measured: ~2e-10 of gross, e.g. +2.4e-6 Alumina
  // Solution on a 12,000/min balance), so a fixed absolute cutoff can't work — 1e-6 sat
  // INSIDE the noise band of big plans and let phantom "0/min" outputs / raw inputs
  // through. Real flows are never below ~1e-8 of gross (the smallest by-product of even
  // a 100k/min plan is whole units/min), leaving 4+ orders of margin between the two.
  const epsOf = (it) => Math.max(1e-6, (gross[it] || 0) * 1e-8);
  // Fold disposal consumption back into the balance so sunk/burned by-products net to
  // zero (not reported as phantom outputs), and tally what left via each channel.
  const sunk = [];
  const burned = [];
  let recoveredPower = 0;
  if (disposal) {
    for (const s of disposal.sinks) {
      const v = res[s.key];
      if (!v || v <= epsOf(s.item)) continue; // noise-sized sink activity: no real by-product behind it
      net[s.item] = (net[s.item] || 0) - v;
      sunk.push({ item: s.item, rate: v, points: v * sinkPointsOf(s.item) });
    }
    for (const g of disposal.gens) {
      const v = res[g.key];
      if (!v || v < 1e-6 || v * g.burn <= epsOf(g.fuel)) continue;
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
    if (v && v > 1e-6 && v * disposal.wet.waterIn > epsOf(WATER)) {
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
  const resSurplus = []; // raw RESOURCES the plan over-produces (e.g. by-product water with no consumer) — they back up in-game, so they must be reported, not silently dropped
  let rawTotal = 0;
  for (const it in net) {
    if (Math.abs(net[it]) <= epsOf(it)) { net[it] = 0; continue; } // snap dust to an exact zero
    const v = net[it];
    if (v > 0 && !RES.has(it)) outputs.push({ item: it, rate: v });
    else if (v > 0) resSurplus.push({ item: it, rate: v });
    else if (v < 0) { raw.push({ item: it, rate: -v }); rawTotal += -v; }
  }
  return { recipes, raw, outputs, net, totalPower, totalMachines, fracMachines, rawTotal, sunk, burned, recoveredPower, watered, resSurplus };
}

function optimize({ outputs, allowedInputs, objective = 'raw', allowAlternates = true, recipeCost = 1, powerMult = 1, unlockedAlts = null, blockedRecipes = null, sinkByproducts = false, waterSink = false, packageWater = false, exportWaste = false, sloopMult = null }) {
  if (objective === 'recipes') {
    return optimizeFewestRecipes({ outputs, allowedInputs, allowAlternates, recipeCost, powerMult, unlockedAlts, blockedRecipes, sinkByproducts, waterSink, packageWater, exportWaste, sloopMult });
  }
  if (objective === 'inputs') {
    return optimizeFewestInputs({ outputs, allowedInputs, allowAlternates, recipeCost, powerMult, unlockedAlts, blockedRecipes, sinkByproducts, waterSink, packageWater, exportWaste, sloopMult });
  }
  if (objective === 'machines') {
    return optimizeWholeMachines({ outputs, allowedInputs, allowAlternates, recipeCost, powerMult, unlockedAlts, blockedRecipes, sinkByproducts, waterSink, packageWater, exportWaste, sloopMult });
  }
  if (objective === 'edges') {
    return optimizeFewestEdges({ outputs, allowedInputs, allowAlternates, recipeCost, powerMult, unlockedAlts, blockedRecipes, sinkByproducts, waterSink, packageWater, exportWaste, sloopMult });
  }
  if (objective === 'loops') {
    return optimizeFewestLoops({ outputs, allowedInputs, allowAlternates, recipeCost, powerMult, unlockedAlts, blockedRecipes, sinkByproducts, waterSink, packageWater, exportWaste, sloopMult });
  }
  if (objective === 'clean') {
    return optimizeCleanest({ outputs, allowedInputs, objective: 'clean', allowAlternates, recipeCost, powerMult, unlockedAlts, blockedRecipes, sinkByproducts, waterSink, packageWater, exportWaste, sloopMult });
  }
  const inputs = {};
  for (const it in allowedInputs) inputs[it] = allowedInputs[it];
  const { model, pool, disposal } = buildModel({ outputs, inputs, objective, allowAlternates, recipeCost, powerMult, unlockedAlts, blockedRecipes, sinkByproducts, waterSink, packageWater, exportWaste, sloopMult });
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
    // Packaged-water diagnosis first (most specific): if dropping ONLY the net-water cap
    // solves, the blocker is the packaging chain itself (canisters / plastic unavailable
    // under the allowed inputs) — name it instead of a generic infeasible.
    if (packageWater) {
      const noPkg = buildModel({ outputs, inputs, objective, allowAlternates, recipeCost, powerMult, unlockedAlts, blockedRecipes, sinkByproducts, waterSink, packageWater: false, exportWaste, sloopMult });
      const rp = solver.Solve(noPkg.model);
      if (rp.feasible) return { feasible: false, waterPackaging: true };
    }
    // Tell "can't make the outputs at all" apart from "a by-product would back up": if
    // the same request solves once the net-zero balance is relaxed, the blocker is a
    // surplus by-product that can't be sunk (a fluid with no consumer) — name it so the
    // UI can point the user at a recipe that consumes it.
    if (sinkByproducts) {
      // Diagnosis solve: drop BOTH the by-product balance and the net-water cap, so the
      // would-be surplus can float and be named (water lands in resSurplus, fluids in outputs).
      const relaxed = buildModel({ outputs, inputs, objective, allowAlternates, recipeCost, powerMult, unlockedAlts, blockedRecipes, sinkByproducts: false, waterSink, packageWater: false, exportWaste, sloopMult });
      const rres = solver.Solve(relaxed.model);
      if (rres.feasible) {
        const rsum = summarize(rres, relaxed.pool, recipeCost, powerMult, relaxed.disposal, sloopMult);
        // Fluid raw resources (water) land in resSurplus, not outputs — they back up too.
        const backup = rsum.outputs.filter((o) => outputs[o.item] == null && !isSinkable(o.item)).map((o) => o.item)
          .concat((rsum.resSurplus || []).filter((o) => outputs[o.item] == null && ITEMS[o.item] && ITEMS[o.item].liquid).map((o) => o.item));
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

// "Fewest recipes" objective: minimize the NUMBER OF DISTINCT RECIPES (build steps),
// not a linear rate — true cardinality minimization is a MILP (one binary per recipe),
// far too slow for the embedded simplex solver. Greedy elimination instead: start from
// the fewest-machines plan, then repeatedly try BLOCKING one currently-used recipe and
// re-solving; keep any block that strictly shrinks the distinct-recipe count, restart
// until no single block helps. Locally minimal (no one recipe can be dropped), runs in
// at most a few dozen LP solves, and ties (same count) resolve toward fewer machines
// because that stays the inner objective.
function optimizeFewestRecipes(params) {
  const inner = Object.assign({}, params, { objective: 'machinesLP' });
  const finish = (sum) => { sum.objective = 'recipes'; if (sum.feasible) sum.objectiveValue = sum.recipes.length; return sum; };
  let best = optimize(inner);
  if (!best.feasible) return finish(best);
  const blocked = new Set(params.blockedRecipes ? [...params.blockedRecipes] : []);
  let budget = 160; // hard cap on probe solves — keeps worst-case latency bounded
  let progress = true;
  while (progress && budget > 0) {
    progress = false;
    // Probe cheapest-contribution recipes first: a sliver of a machine is the most
    // likely candidate to be replaceable by the recipes already in the plan.
    const used = best.recipes.slice().sort((a, b) => a.machines - b.machines);
    for (const cand of used) {
      if (budget-- <= 0) break;
      const tryBlocked = new Set(blocked); tryBlocked.add(cand.rc);
      const probe = optimize(Object.assign({}, inner, { blockedRecipes: tryBlocked }));
      if (probe.feasible && probe.recipes.length < best.recipes.length) {
        blocked.add(cand.rc);
        best = probe;
        progress = true;
        break; // plan changed — re-rank the survivors and scan again
      }
    }
  }
  return finish(best);
}

// "Fewest input types" objective: minimize the number of DISTINCT RAW RESOURCES the
// factory draws (simplest logistics — fewer belts/trains/pipes into the site), even at
// the cost of pulling MORE of the survivors. Same greedy-elimination shape as
// optimizeFewestRecipes, but the candidate being banned is an allowed INPUT rather
// than a recipe: try removing each currently-drawn input (smallest draw first — the
// trickle feeds are the ones alternates can usually replace), re-solve, keep any
// removal that strictly shrinks the distinct-input count, stop when no single removal
// helps. Ties resolve toward fewer machines (the inner objective).
function optimizeFewestInputs(params) {
  const inner = Object.assign({}, params, { objective: 'machinesLP' });
  const finish = (sum) => { sum.objective = 'inputs'; if (sum.feasible) sum.objectiveValue = sum.raw.length; return sum; };
  let allowed = Object.assign({}, params.allowedInputs);
  let best = optimize(Object.assign({}, inner, { allowedInputs: allowed }));
  if (!best.feasible) return finish(best);
  let budget = 80;
  let progress = true;
  while (progress && budget > 0) {
    progress = false;
    const candidates = best.raw.slice().sort((a, b) => a.rate - b.rate);
    for (const cand of candidates) {
      if (!(cand.item in allowed) || budget-- <= 0) continue;
      const tryAllowed = Object.assign({}, allowed);
      delete tryAllowed[cand.item];
      const probe = optimize(Object.assign({}, inner, { allowedInputs: tryAllowed }));
      if (probe.feasible && probe.raw.length < best.raw.length) {
        allowed = tryAllowed;
        best = probe;
        progress = true;
        break; // input set changed — re-rank what's still drawn and scan again
      }
    }
  }
  return finish(best);
}

// "Fewest machines" objective, WHOLE machines: in the game you build whole machines
// and underclock the last one, so a recipe used at 0.05 machine-equivalents still
// costs a full machine. The LP can only minimize the fractional sum (Σ ceil is not
// linear), so refine greedily: start from the fractional optimum, then try BLOCKING
// each used recipe — most idle capacity (ceil − frac) first, those slivers are the
// likely losers — re-solve, and keep any block that strictly lowers the whole-machine
// count Σ ceil(machines). Stops when no single block helps.
function optimizeWholeMachines(params) {
  const inner = Object.assign({}, params, { objective: 'machinesLP' });
  // totalMachines is summarize()'s Σ ceil across pool recipes AND disposal machinery
  // (fuel generators, Wet Concrete refineries) — those are real buildings too; counting
  // recipes alone would make "burn it" look free and invert the comparison.
  const whole = (sum) => sum.totalMachines;
  const finish = (sum) => { sum.objective = 'machines'; if (sum.feasible) sum.objectiveValue = whole(sum); return sum; };
  let best = optimize(inner);
  if (!best.feasible) return finish(best);
  const blocked = new Set(params.blockedRecipes ? [...params.blockedRecipes] : []);
  let budget = 120;
  let progress = true;
  while (progress && budget > 0) {
    progress = false;
    const waste = (r) => Math.ceil(r.machines - 1e-9) - r.machines; // idle capacity bought by the ceil
    const used = best.recipes.slice().sort((a, b) => waste(b) - waste(a));
    for (const cand of used) {
      if (budget-- <= 0) break;
      const tryBlocked = new Set(blocked); tryBlocked.add(cand.rc);
      const probe = optimize(Object.assign({}, inner, { blockedRecipes: tryBlocked }));
      if (probe.feasible && whole(probe) < whole(best)) {
        blocked.add(cand.rc);
        best = probe;
        progress = true;
        break; // plan changed — re-rank the survivors and scan again
      }
    }
  }
  return finish(best);
}

// Count the LINES a solved plan draws in the flowchart — the belt/pipe connections the
// player actually has to route. Mirrors the renderer's edge construction: every producer
// of an item connects to every consumer of it (P×C per item), each raw item's extractor
// feeds each of its consumers, each net output / sunk / burned item drains from each of
// its producers. This is the logistics-complexity metric for the 'edges' objective.
function edgeCountOf(sum) {
  const producers = {}, consumers = {};
  for (const r of sum.recipes) {
    const info = RC_INFO[r.rc];
    for (const it in info.out) (producers[it] = producers[it] || []).push(r.rc);
    for (const it in info.inn) (consumers[it] = consumers[it] || []).push(r.rc);
  }
  let edges = 0;
  const items = new Set([...Object.keys(producers), ...Object.keys(consumers)]);
  for (const it of items) {
    const P = (producers[it] || []).length, C = (consumers[it] || []).length;
    if (P && C) edges += P * C; // machine -> machine lines
  }
  for (const r of sum.raw) edges += (consumers[r.item] || []).length;       // extractor -> machine
  for (const o of sum.outputs) edges += (producers[o.item] || []).length;   // machine -> output
  for (const s of (sum.sunk || [])) edges += (producers[s.item] || []).length;   // machine -> sink
  for (const b of (sum.burned || [])) edges += (producers[b.item] || []).length; // machine -> generator
  for (const w of (sum.watered || [])) edges += 2; // diverted water in + limestone in (its Concrete is counted via producers above)
  return edges;
}

// Count the plan's LOOP edges — machine→machine item links that sit inside a recycle
// cycle. Two flavours both count (each is a line the player must prime and that can
// deadlock): a SELF-loop, where one recipe both consumes and produces the same item
// (e.g. standard Encased Uranium Cell's sulfuric acid in + out), and a CYCLE across
// recipes (e.g. Recycled Rubber <-> Recycled Plastic), found as edges within a
// non-trivial strongly connected component of the recipe graph. Disposal routes
// (sink / generator / Wet Concrete) are terminals and can never close a cycle.
function loopEdgeCountOf(sum) {
  const rcs = sum.recipes.map((r) => r.rc);
  const idx = new Map(rcs.map((rc, i) => [rc, i]));
  const producers = {}, consumers = {};
  let selfLoops = 0;
  for (const rc of rcs) {
    const info = RC_INFO[rc];
    for (const it in info.out) {
      (producers[it] = producers[it] || []).push(rc);
      if (info.inn[it]) selfLoops++; // same recipe makes and eats it: a backfeed line
    }
    for (const it in info.inn) (consumers[it] = consumers[it] || []).push(rc);
  }
  // Adjacency (deduped) for Tarjan; remember each cross-recipe edge per item so loop
  // edges are counted like the flowchart draws them (one line per item per pair).
  const adj = rcs.map(() => new Set());
  const edges = [];
  for (const it in producers) {
    if (!consumers[it]) continue;
    for (const p of producers[it]) for (const c of consumers[it]) {
      if (p === c) continue; // self-loop already counted above
      adj[idx.get(p)].add(idx.get(c));
      edges.push([idx.get(p), idx.get(c)]);
    }
  }
  // Tarjan SCC, iterative (recipe graphs are tiny, but no recursion-depth surprises).
  const N = rcs.length;
  const low = new Array(N).fill(0), num = new Array(N).fill(-1), comp = new Array(N).fill(-1), onStk = new Array(N).fill(false);
  const stk = [];
  let counter = 0, ncomp = 0;
  for (let s = 0; s < N; s++) {
    if (num[s] !== -1) continue;
    const call = [[s, 0, null]];
    while (call.length) {
      const fr = call[call.length - 1];
      const [v] = fr;
      if (fr[1] === 0) { num[v] = low[v] = counter++; stk.push(v); onStk[v] = true; }
      const nbrs = [...adj[v]];
      if (fr[1] < nbrs.length) {
        const w = nbrs[fr[1]++];
        if (num[w] === -1) call.push([w, 0, v]);
        else if (onStk[w]) low[v] = Math.min(low[v], num[w]);
      } else {
        if (low[v] === num[v]) {
          for (;;) { const w = stk.pop(); onStk[w] = false; comp[w] = ncomp; if (w === v) break; }
          ncomp++;
        }
        call.pop();
        const parent = fr[2];
        if (parent != null) low[parent] = Math.min(low[parent], low[v]);
      }
    }
  }
  let cyc = 0;
  for (const [a, b] of edges) if (comp[a] === comp[b]) cyc++;
  return selfLoops + cyc;
}

// Structural loop-bait in the recipe POOL, independent of any particular plan:
//  - SELF-loopers: a recipe that consumes an item it also produces (std Encased Uranium
//    Cell's sulfuric acid in + out) — a guaranteed backfeed line if used.
//  - Alternate 2-cycle pairs: two ALTERNATES that each consume the other's product
//    (Recycled Rubber <-> Recycled Plastic) — the classic recirculation bait the
//    fractional-machines LP loves, because the pair is cheap per machine.
// Each is only pruned when its primary product keeps at least one other (unpruned)
// producer, so the prune alone never makes an item unproducible. Standard 2-cycle pairs
// (e.g. Aluminum Scrap's water returning to Alumina Solution) are left alone — pruning
// those can cascade a whole chain away; the greedy refinement handles what it can.
function loopBaitPrune(pool) {
  const inPool = new Set(pool);
  const pruned = new Set();
  const producersOf = (item) => pool.filter((rc) => !pruned.has(rc) && (RC_INFO[rc].out[item] || 0) > 0);
  const tryPrune = (rc) => {
    if (pruned.has(rc)) return;
    if (producersOf(RC_INFO[rc].primary).length < 2) return; // sole producer — must stay
    pruned.add(rc);
  };
  for (const rc of pool) {
    const info = RC_INFO[rc];
    for (const it in info.out) if (info.inn[it]) { tryPrune(rc); break; }
  }
  for (const rc of pool) {
    if (!RECIPES[rc].alternate || pruned.has(rc)) continue;
    const a = RC_INFO[rc];
    for (const other of pool) {
      if (other === rc || !RECIPES[other].alternate || pruned.has(other)) continue;
      const b = RC_INFO[other];
      const aFeedsB = Object.keys(a.out).some((it) => b.inn[it]);
      const bFeedsA = Object.keys(b.out).some((it) => a.inn[it]);
      if (aFeedsB && bFeedsA) { tryPrune(rc); tryPrune(other); }
    }
  }
  return pruned;
}

// "Fewest loops" objective: the most STRAIGHTFORWARD chain, even when it isn't optimal —
// minimize loop edges first (target: zero — pure feed-forward, nothing to prime, nothing
// to deadlock), then untangle ties toward fewer belt/pipe lines. Two stages:
//  1. STRUCTURAL PRUNE: solve with the pool's loop-bait blocked outright (see
//     loopBaitPrune). Greedy block-one search alone can't escape a loopy basin — every
//     single-block probe just re-solves into a different web of cycles.
//  2. GREEDY REFINEMENT on whatever loops remain (longer cycles the prune can't see),
//     probing with the prune still in force. Falls back to the unpruned pool when the
//     pruned solve is infeasible (a pruned chain was load-bearing after all).
function optimizeFewestLoops(params) {
  const inner = Object.assign({}, params, { objective: 'machinesLP' });
  const score = (sum) => [loopEdgeCountOf(sum), edgeCountOf(sum)];
  const finish = (sum) => { sum.objective = 'loops'; if (sum.feasible) sum.objectiveValue = loopEdgeCountOf(sum); return sum; };
  const userBlocked = params.blockedRecipes ? [...params.blockedRecipes] : [];
  const pool = recipePool(params.allowAlternates !== false, params.unlockedAlts, params.blockedRecipes);
  const prune = loopBaitPrune(pool);
  let blocked = new Set([...userBlocked, ...prune]);
  let best = optimize(Object.assign({}, inner, { blockedRecipes: blocked }));
  if (!best.feasible) { blocked = new Set(userBlocked); best = optimize(Object.assign({}, inner, { blockedRecipes: blocked })); }
  if (!best.feasible) return finish(best);
  let bestScore = score(best);
  let budget = 120;
  let progress = true;
  while (progress && budget > 0 && bestScore[0] > 0) {
    progress = false;
    // Self-loopers and cycle members first — blocking a bystander can't reduce loops.
    const inLoop = (rc) => {
      const info = RC_INFO[rc];
      for (const it in info.out) if (info.inn[it]) return true;
      const others = best.recipes.filter((r) => r.rc !== rc);
      return loopEdgeCountOf(best) > loopEdgeCountOf({ recipes: others });
    };
    const used = best.recipes.slice().sort((a, b) => (inLoop(b.rc) ? 1 : 0) - (inLoop(a.rc) ? 1 : 0) || a.machines - b.machines);
    for (const cand of used) {
      if (budget-- <= 0) break;
      const tryBlocked = new Set(blocked); tryBlocked.add(cand.rc);
      const probe = optimize(Object.assign({}, inner, { blockedRecipes: tryBlocked }));
      if (!probe.feasible) continue;
      const s = score(probe);
      if (s[0] < bestScore[0] || (s[0] === bestScore[0] && s[1] < bestScore[1])) {
        blocked = tryBlocked;
        best = probe; bestScore = s;
        progress = true;
        break; // plan changed — re-rank the survivors and scan again
      }
    }
  }
  return finish(best);
}

// "Fewest connections" objective: minimize the number of LINES between nodes — distinct
// belt/pipe links the player must route — which is NOT the same as fewest recipe nodes
// (a web of 10 recipes can need more routing than a chain of 12). Same greedy elimination
// as the other cardinality modes: block one used recipe at a time, keep blocks that
// strictly reduce the line count, stop when no single block helps.
function optimizeFewestEdges(params) {
  const inner = Object.assign({}, params, { objective: 'machinesLP' });
  const finish = (sum) => { sum.objective = 'edges'; if (sum.feasible) sum.objectiveValue = edgeCountOf(sum); return sum; };
  let best = optimize(inner);
  if (!best.feasible) return finish(best);
  const blocked = new Set(params.blockedRecipes ? [...params.blockedRecipes] : []);
  let budget = 160;
  let progress = true;
  while (progress && budget > 0) {
    progress = false;
    const used = best.recipes.slice().sort((a, b) => a.machines - b.machines);
    for (const cand of used) {
      if (budget-- <= 0) break;
      const tryBlocked = new Set(blocked); tryBlocked.add(cand.rc);
      const probe = optimize(Object.assign({}, inner, { blockedRecipes: tryBlocked }));
      if (probe.feasible && edgeCountOf(probe) < edgeCountOf(best)) {
        blocked.add(cand.rc);
        best = probe;
        progress = true;
        break; // plan changed — re-rank the survivors and scan again
      }
    }
  }
  return finish(best);
}

// ---- Clean-ratio plan search ----
// Rational helpers (solver-side copies; the renderer keeps its own for display math).
function _frac(x, maxDen) {
  let h0 = 0, h1 = 1, k0 = 1, k1 = 0, b = x;
  for (let i = 0; i < 40; i++) {
    const a = Math.floor(b);
    const h2 = a * h1 + h0, k2 = a * k1 + k0;
    if (k2 > maxDen) break;
    h0 = h1; h1 = h2; k0 = k1; k1 = k2;
    const f = b - a;
    if (f < 1e-9) break;
    b = 1 / f;
  }
  return { p: h1, q: k1 || 1 };
}
const _gcd2 = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) { const t = a % b; a = b; b = t; } return a; };
const _lcm2 = (a, b) => (a && b ? a / _gcd2(a, b) * b : 0);
// Smallest scale-UP (≥1, capped) making every count whole; when the exact LCM blows past
// the cap, allow the worst-denominator counts to stay fractional one at a time. Mirrors
// the renderer's clean-ratio ladder so a plan scored here rescales identically there.
function cleanLadderUp(counts, maxScale = 10) {
  let pool = counts.filter((c) => c > 1e-9);
  let frac = 0;
  while (pool.length) {
    let Q = 1, ok = true;
    const fr = [];
    for (const c of pool) {
      const f = _frac(c, 1000);
      if (Math.abs(f.p / f.q - c) > 1e-4) { ok = false; break; }
      fr.push(f);
      Q = _lcm2(Q, f.q);
      if (!isFinite(Q) || Q > 1e7) { ok = false; break; }
    }
    if (ok) {
      let g = 0;
      for (const f of fr) g = _gcd2(g, Math.round(Q * f.p / f.q));
      const fMin = g ? Q / g : 1;
      const s = Math.ceil(1 / fMin - 1e-9) * fMin;
      if (s <= maxScale + 1e-9) return { scale: s, frac };
    }
    let worst = 0, worstQ = -1;
    pool.forEach((c, i) => {
      const f = _frac(c, 1000);
      const q = Math.abs(f.p / f.q - c) > 1e-4 ? Infinity : f.q;
      if (q > worstQ) { worstQ = q; worst = i; }
    });
    pool.splice(worst, 1);
    frac++;
  }
  return { scale: 1, frac: 0 };
}
// Cleanliness score, lexicographic: fewest forced-fractional steps, then the smallest
// scale-up from the asked rate, then the simplest plan (fewest recipes, then machines).
function cleanScoreOf(sum) {
  const l = cleanLadderUp(sum.recipes.map((r) => r.machines));
  return [l.frac, l.scale, sum.recipes.length, sum.fracMachines];
}
function lexBetter(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i] - 1e-9) return true;
    if (a[i] > b[i] + 1e-9) return false;
  }
  return false;
}
// Search recipe space for the plan with the CLEANEST ratios near the asked output:
// start from a base plan, then greedily try blocking each used recipe (other recipes /
// alternates take over) and keep any swap whose clean score is strictly better. This IS
// the 'clean' Optimizer objective: cleanliness outranks everything — the inner LP is a
// plain fewest-machines solve with NO adherence to any other optimization parameter, so
// the search is free to take a worse plan whose counts land on whole machines or simple
// fractions (.5, .333…). The suggestion tip scores the same search, so what the tip
// promises is exactly what switching to the mode builds. (Other objective values are
// still accepted for back-compat with stored args.)
function optimizeCleanest(params) {
  const userObj = params.objective || 'clean';
  // 'clean' (and the cardinality objectives, which nest their own greedy loops) probe
  // with the plain fractional-machines LP; rate objectives keep their own inner LP.
  const innerObj = (userObj === 'clean' || userObj === 'machines' || userObj === 'recipes' || userObj === 'inputs' || userObj === 'edges' || userObj === 'loops') ? 'machinesLP' : userObj;
  const inner = Object.assign({}, params, { objective: innerObj });
  const finish = (sum) => {
    if (!sum.feasible) return sum;
    sum.objective = userObj;
    sum.objectiveValue = userObj === 'raw' ? sum.rawTotal
      : userObj === 'power' ? sum.totalPower
      : userObj === 'machines' ? sum.totalMachines
      : userObj === 'recipes' ? sum.recipes.length
      : userObj === 'inputs' ? sum.raw.length
      : userObj === 'edges' ? edgeCountOf(sum)
      : userObj === 'loops' ? loopEdgeCountOf(sum)
      : userObj === 'clean' ? cleanLadderUp(sum.recipes.map((r) => r.machines)).frac
      : sum.fracMachines;
    return sum;
  };
  // Multi-base start: the fractional-machines LP gravitates to dense alternate webs
  // whose counts are fraction spaghetti (0.0124× of this, 0.448× of that) — a greedy
  // block-one search can't climb out of that basin, because swapping one alternate for
  // another never strictly improves the score. So seed from several shapes — the inner
  // LP, the raw-minimizing LP, and a STANDARD-RECIPES-ONLY solve (human-style chains,
  // whose counts come out as simple rate fractions) — and refine the cleanest of them.
  let best = null, bestScore = null;
  const bases = [
    { objective: innerObj },
    { objective: innerObj === 'raw' ? 'machinesLP' : 'raw' },
    { objective: 'machinesLP', allowAlternates: false },
  ];
  for (const b of bases) {
    const cand = optimize(Object.assign({}, params, b));
    if (!cand.feasible) continue;
    const s = cleanScoreOf(cand);
    if (!best || lexBetter(s, bestScore)) { best = cand; bestScore = s; }
  }
  if (!best) return finish(optimize(inner));
  if (bestScore[0] === 0 && bestScore[1] <= 1 + 1e-9) return finish(best); // already perfectly clean
  const blocked = new Set(params.blockedRecipes ? [...params.blockedRecipes] : []);
  let budget = 48;
  let progress = true;
  while (progress && budget > 0) {
    progress = false;
    const used = best.recipes.slice().sort((a, b) => a.machines - b.machines);
    for (const cand of used) {
      if (budget-- <= 0) break;
      const tryBlocked = new Set(blocked); tryBlocked.add(cand.rc);
      const probe = optimize(Object.assign({}, inner, { blockedRecipes: tryBlocked }));
      if (!probe.feasible) continue;
      const s = cleanScoreOf(probe);
      if (lexBetter(s, bestScore)) {
        blocked.add(cand.rc);
        best = probe; bestScore = s;
        progress = true;
        break; // plan changed — re-rank and scan again
      }
    }
  }
  return finish(best);
}

// Max throughput. Single form: `product` — maximize that item's net output. Multi form:
// `products` = [{ item, ratio }] — maximize a scalar T with every item's net output held
// to AT LEAST ratio_i × T (the user-chosen output ratio), via a pseudo-variable __T__
// whose item coefficients are -ratio_i and which alone carries the max objective. The
// ratio is a floor, not an equality: a by-product overrun on one item never blocks T.
function maxThroughput({ product, products, supply, allowAlternates = true, recipeCost = 1, powerMult = 1, unlockedAlts = null, blockedRecipes = null }) {
  const multi = Array.isArray(products) && products.length
    ? products.filter((p) => p && p.item && Number(p.ratio) > 0)
    : null;
  if (multi && !multi.length) return { feasible: false };
  const { model, pool } = buildModel({ inputs: supply, maxItem: multi ? null : product, allowAlternates, recipeCost, powerMult, unlockedAlts, blockedRecipes });
  if (multi) {
    // No pooled recipe produces a demanded item (and it isn't supplied) → name it
    // instead of letting the dropped constraint report a hollow "feasible" T.
    const noProducer = multi.filter((p) => supply[p.item] == null && !pool.some((rc) => (RC_INFO[rc].out[p.item] || 0) > 0)).map((p) => p.item);
    if (noProducer.length) return { feasible: false, noProducer };
    const tv = { _out: 1, _power: 0, _machines: 0, _raw: 0 };
    for (const p of multi) {
      tv[p.item] = (tv[p.item] || 0) - Number(p.ratio);
      if (!model.constraints[p.item]) model.constraints[p.item] = { min: 0 };
    }
    model.variables.__T__ = tv;
    model.optimize = '_out';
    model.opType = 'max';
  }
  const res = solver.Solve(model);
  // An unbounded objective (e.g. a cost multiplier < 1 rounding a package<->unpackage
  // pair matter-positive) reports as feasible with result = Infinity — surface it as
  // its own failure instead of presenting "Infinity/min" to the user.
  if (res.feasible && !isFinite(res.result)) return { feasible: false, unbounded: true };
  if (!res.feasible || !(res.result > 1e-6)) return { feasible: false };
  const sum = summarize(res, pool, recipeCost, powerMult);
  sum.feasible = true;
  sum.maxOutput = res.result; // single: the item's rate; multi: the ratio scalar T
  if (multi) sum.maxOutputs = multi.map((p) => ({ item: p.item, ratio: Number(p.ratio), rate: Number(p.ratio) * res.result }));
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

module.exports = { optimize, maxThroughput, planner, RC_INFO, RES, effAmount, edgeCountOf, loopEdgeCountOf, optimizeCleanest, cleanLadderUp };
