// Unit tests for the pure (non-DOM) core: the LP solver, the save -> buildings
// extractor, and the building-metadata lookup. Complements scripts/ui-test.js,
// which covers the renderer/DOM. No test framework — plain asserts + a tally.
'use strict';
const LP = require('../src/solver-lp');
const FE = require('../src/factory-extract');
const BM = require('../src/building-meta');
const DATA = require('../src/data.json');

let pass = 0, fail = 0;
const check = (label, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); cond ? pass++ : fail++; };
const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

const cls = (name) => Object.keys(DATA.items).find((k) => DATA.items[k].name === name);
const primStd = (item) => Object.keys(DATA.recipes).find((rc) => !DATA.recipes[rc].alternate && DATA.recipes[rc].products[0].item === item);
const IronOre = cls('Iron Ore'), IronIngot = cls('Iron Ingot'), IronPlate = cls('Iron Plate');

// ---- solver-lp ----
console.log('### SOLVER-LP');
// Max throughput: 60 Iron Ore/min -> 60 Iron Ingot/min (1:1 smelter), alts off.
const mt = LP.maxThroughput({ product: IronIngot, supply: { [IronOre]: 60 }, allowAlternates: false });
check('maxThroughput feasible', mt.feasible === true);
check('60 ore -> 60 ingot', near(mt.maxOutput, 60, 0.5));
check('ore is the binding input', mt.binding.includes(IronOre));

// Multi-output ratio: 2 Iron Plate : 1 Iron Rod from 60 ore, alts off.
// Plate costs 1.5 ore, Rod costs 1 ore -> one ratio unit = 2(1.5)+1 = 4 ore -> T=15.
const mr = LP.maxThroughput({ products: [{ item: IronPlate, ratio: 2 }, { item: cls('Iron Rod'), ratio: 1 }], supply: { [IronOre]: 60 }, allowAlternates: false });
check('ratio max feasible', mr.feasible === true);
check('ratio scalar T = 15', near(mr.maxOutput, 15, 0.1));
check('plates at 2x T = 30/min', !!mr.maxOutputs && near(mr.maxOutputs.find((m) => m.item === IronPlate).rate, 30, 0.1));
check('rods at 1x T = 15/min', !!mr.maxOutputs && near(mr.maxOutputs.find((m) => m.item === cls('Iron Rod')).rate, 15, 0.1));
check('ore binds the ratio set', mr.binding.includes(IronOre));
const mr1 = LP.maxThroughput({ products: [{ item: IronIngot, ratio: 1 }], supply: { [IronOre]: 60 }, allowAlternates: false });
check('single-row ratio == legacy single product', mr1.feasible && near(mr1.maxOutput, mt.maxOutput, 0.1));
const mrBad = LP.maxThroughput({ products: [{ item: IronIngot, ratio: 1 }], supply: {}, allowAlternates: false });
check('no supply -> infeasible (ratio path)', mrBad.feasible === false);

// Optimize: make 30 Iron Ingot/min from ore, minimize raw, alts off.
const opt = LP.optimize({ outputs: { [IronIngot]: 30 }, allowedInputs: { [IronOre]: Infinity }, objective: 'raw', allowAlternates: false });
check('optimize feasible', opt.feasible === true);
check('optimize uses ~30 raw ore', near(opt.objectiveValue, 30, 0.5));
const oreRaw = opt.raw.find((r) => r.item === IronOre);
check('raw list reports iron ore', !!oreRaw && near(oreRaw.rate, 30, 0.5));
check('no alternates chosen (alts off)', opt.recipes.every((r) => !DATA.recipes[r.rc].alternate));

// ---- Fewest-recipes objective: minimize DISTINCT recipes (build steps) ----
console.log('\n### FEWEST RECIPES OBJECTIVE');
{
  const RIP = cls('Reinforced Iron Plate');
  const base = { outputs: { [RIP]: 30 }, allowedInputs: { [IronOre]: Infinity }, allowAlternates: true };
  const byMachines = LP.optimize(Object.assign({}, base, { objective: 'machinesLP' })); // pure fractional LP baseline
  const byRecipes = LP.optimize(Object.assign({}, base, { objective: 'recipes' }));
  check('recipes objective feasible', byRecipes.feasible === true);
  check('objective reported as recipes', byRecipes.objective === 'recipes');
  check('objectiveValue == distinct recipe count', byRecipes.objectiveValue === byRecipes.recipes.length);
  check('never more recipes than the machines plan', byMachines.feasible && byRecipes.recipes.length <= byMachines.recipes.length);
  const ripOut = byRecipes.outputs.find((o) => o.item === RIP);
  check('target rate still met (~30/min)', !!ripOut && near(ripOut.rate, 30, 0.1));
  check('every step carries real machine load', byRecipes.recipes.every((r) => r.machines > 1e-6));

  // Locally minimal: blocking ANY used recipe must not allow an equal-or-smaller plan
  // (greedy stops only when no single removal helps).
  const minimal = byRecipes.recipes.every((r) => {
    const probe = LP.optimize(Object.assign({}, base, { objective: 'recipes', blockedRecipes: new Set([r.rc]) }));
    return !probe.feasible || probe.recipes.length >= byRecipes.recipes.length;
  });
  check('locally minimal (no single recipe is droppable)', minimal);

  // Simple chain collapses to the obvious 2 steps: ore -> ingot -> plate.
  const simple = LP.optimize({ outputs: { [IronPlate]: 20 }, allowedInputs: { [IronOre]: Infinity }, objective: 'recipes', allowAlternates: false });
  check('simple chain = exactly 2 recipes (ingot + plate)', simple.feasible && simple.recipes.length === 2);

  // Infeasible demand stays infeasible (no producer for the item).
  const blockedAll = new Set(Object.keys(DATA.recipes).filter((rc) => DATA.recipes[rc].products.some((p) => p.item === IronIngot)));
  const inf = LP.optimize({ outputs: { [IronIngot]: 10 }, allowedInputs: {}, objective: 'recipes', allowAlternates: true, blockedRecipes: blockedAll });
  check('blocked sole producers stay infeasible', inf.feasible === false);
}

// ---- Whole-machines objective: Σ ceil(machines), not the fractional LP sum ----
console.log('\n### FEWEST WHOLE MACHINES OBJECTIVE');
{
  const RIP = cls('Reinforced Iron Plate');
  const base = { outputs: { [RIP]: 30 }, allowedInputs: { [IronOre]: Infinity }, allowAlternates: true };
  const whole = (s) => s.totalMachines; // Σ ceil incl. disposal machinery (gens / wet refineries)
  const lp = LP.optimize(Object.assign({}, base, { objective: 'machinesLP' }));
  const wm = LP.optimize(Object.assign({}, base, { objective: 'machines' }));
  check('whole-machines feasible', wm.feasible === true);
  check('objective reported as machines', wm.objective === 'machines');
  check('objectiveValue is an integer', Number.isInteger(wm.objectiveValue));
  check('objectiveValue == sum of ceiled machine counts', wm.objectiveValue === whole(wm));
  check('never worse than the fractional plan, whole-counted', lp.feasible && wm.objectiveValue <= whole(lp));
  const ripOut = wm.outputs.find((o) => o.item === RIP);
  check('target rate still met (~30/min)', !!ripOut && near(ripOut.rate, 30, 0.1));
  // Locally minimal: blocking ANY used recipe must not allow fewer whole machines.
  const minimal = wm.recipes.every((r) => {
    const probe = LP.optimize(Object.assign({}, base, { objective: 'machines', blockedRecipes: new Set([r.rc]) }));
    return !probe.feasible || probe.objectiveValue >= wm.objectiveValue;
  });
  check('locally minimal (no single recipe block buys a whole machine)', minimal);
}

// ---- Fewest-connections objective: minimize LINES between nodes (≠ node count) ----
console.log('\n### FEWEST CONNECTIONS OBJECTIVE');
{
  const RIP = cls('Reinforced Iron Plate');
  const base = { outputs: { [RIP]: 30 }, allowedInputs: { [IronOre]: Infinity }, allowAlternates: true };
  const lp = LP.optimize(Object.assign({}, base, { objective: 'machinesLP' }));
  const byEdges = LP.optimize(Object.assign({}, base, { objective: 'edges' }));
  check('edges objective feasible', byEdges.feasible === true);
  check('objective reported as edges', byEdges.objective === 'edges');
  check('objectiveValue == recomputed edge count', byEdges.objectiveValue === LP.edgeCountOf(byEdges));
  check('never more connections than the LP plan', lp.feasible && byEdges.objectiveValue <= LP.edgeCountOf(lp));
  const ripOut = byEdges.outputs.find((o) => o.item === RIP);
  check('target rate still met (~30/min)', !!ripOut && near(ripOut.rate, 30, 0.1));
  // Locally minimal: blocking ANY used recipe must not allow fewer connections.
  const minimal = byEdges.recipes.every((r) => {
    const probe = LP.optimize(Object.assign({}, base, { objective: 'edges', blockedRecipes: new Set([r.rc]) }));
    return !probe.feasible || probe.objectiveValue >= byEdges.objectiveValue;
  });
  check('locally minimal (no single recipe block drops a line)', minimal);
  // Sanity of the metric itself: a 2-step chain (ore -> ingot -> plate) draws exactly
  // 3 lines — extractor->smelter, smelter->constructor, constructor->output.
  const chain = LP.optimize({ outputs: { [IronPlate]: 20 }, allowedInputs: { [IronOre]: Infinity }, objective: 'machinesLP', allowAlternates: false });
  check('metric: simple chain counts 3 lines', LP.edgeCountOf(chain) === 3);
}

// ---- Cleanest-ratio plan search: recipe space scanned for the cleanest scale-up ----
console.log('\n### CLEANEST-RATIO PLAN SEARCH');
{
  const RIP = cls('Reinforced Iron Plate');
  const base = { outputs: { [RIP]: 30 }, allowedInputs: { [IronOre]: Infinity }, allowAlternates: true, objective: 'raw' };
  const plain = LP.optimize(base);
  const clean = LP.optimizeCleanest(base);
  const ladder = (s) => LP.cleanLadderUp(s.recipes.map((r) => r.machines));
  check('cleanest search feasible', clean.feasible === true);
  check('user objective tag preserved', clean.objective === 'raw');
  const lp = ladder(plain), lc = ladder(clean);
  check('clean score never worse than the plain plan',
    lc.frac < lp.frac || (lc.frac === lp.frac && lc.scale <= lp.scale + 1e-9));
  const ripOut = clean.outputs.find((o) => o.item === RIP);
  check('target rate still met (~30/min)', !!ripOut && near(ripOut.rate, 30, 0.1));
  check('ladder scale stays within the cap', lc.scale <= 10 + 1e-9);

  // A trivially clean chain short-circuits: same 2 recipes, no swaps.
  const chainArgs = { outputs: { [IronPlate]: 20 }, allowedInputs: { [IronOre]: Infinity }, allowAlternates: false, objective: 'machinesLP' };
  const chain = LP.optimizeCleanest(chainArgs);
  check('already-clean chain returned as-is (2 recipes)', chain.feasible && chain.recipes.length === 2);
  check('already-clean ladder = ×1, nothing fractional', (() => { const l = ladder(chain); return Math.abs(l.scale - 1) < 1e-9 && l.frac === 0; })());

  // Cardinality objective passthrough: objectiveValue recomputed for the user's metric.
  const cm = LP.optimizeCleanest(Object.assign({}, base, { objective: 'machines' }));
  check('machines passthrough: integer whole-machine objectiveValue', cm.feasible && Number.isInteger(cm.objectiveValue) && cm.objectiveValue === cm.totalMachines);
}

// ---- Fewest-input-types objective: minimize DISTINCT raw resources drawn ----
console.log('\n### FEWEST INPUT TYPES OBJECTIVE');
{
  const Cable = cls('Cable'), CopperOre = cls('Copper Ore');
  const base = { outputs: { [Cable]: 30 }, allowedInputs: { [IronOre]: Infinity, [CopperOre]: Infinity }, allowAlternates: true };
  const byMachines = LP.optimize(Object.assign({}, base, { objective: 'machinesLP' })); // pure fractional LP baseline
  const byInputs = LP.optimize(Object.assign({}, base, { objective: 'inputs' }));
  check('inputs objective feasible', byInputs.feasible === true);
  check('objective reported as inputs', byInputs.objective === 'inputs');
  check('objectiveValue == distinct raw count', byInputs.objectiveValue === byInputs.raw.length);
  check('never more input types than the machines plan', byMachines.feasible && byInputs.raw.length <= byMachines.raw.length);
  const cableOut = byInputs.outputs.find((o) => o.item === Cable);
  check('target rate still met (~30/min)', !!cableOut && near(cableOut.rate, 30, 0.1));
  // Iron Wire (alternate) frees Cable from copper entirely: 2 candidate ores -> 1.
  check('cable collapses to a single ore via alternates', byInputs.raw.length === 1);

  // Locally minimal: dropping ANY still-drawn input must break feasibility or not help.
  const minimal = byInputs.raw.every((r) => {
    const cut = Object.assign({}, base.allowedInputs);
    delete cut[r.item];
    const probe = LP.optimize({ outputs: base.outputs, allowedInputs: cut, objective: 'inputs', allowAlternates: true });
    return !probe.feasible || probe.raw.length >= byInputs.raw.length;
  });
  check('locally minimal (no single input is droppable)', minimal);

  // With alternates off there is no escape from copper: count stays as-is, still solves.
  const noAlts = LP.optimize(Object.assign({}, base, { objective: 'inputs', allowAlternates: false }));
  check('alts off: still feasible', noAlts.feasible === true);
  check('alts off: copper still drawn (no alternate escape)', noAlts.raw.some((r) => r.item === CopperOre));
}

// Planner: 20 Iron Plate/min via standard ingot+plate recipes -> 30 ore, 2 machines.
const plan = LP.planner({ targets: { [IronPlate]: 20 }, recipes: [primStd(IronIngot), primStd(IronPlate)], rawItems: [] });
check('planner feasible', plan.feasible === true);
const plateRow = plan.recipes.find((r) => r.rc === primStd(IronPlate));
check('plate produced at ~20/min', !!plateRow && near(plateRow.rate, 20, 0.1));
const plannerOre = plan.raw.find((r) => r.item === IronOre);
check('planner raw ore ~30/min', !!plannerOre && near(plannerOre.rate, 30, 0.1));

// ---- Recipe Parts Cost Multiplier: rounds each ingredient amount to a whole unit ----
console.log('\n### COST MULTIPLIER (rounding)');
check('effAmount 1x is exact (no rounding)', LP.effAmount(6, 1) === 6);
check('effAmount 0.5x: 1-part recipe stays 1', LP.effAmount(1, 0.5) === 1);
check('effAmount 0.5x: 2-part recipe -> 1', LP.effAmount(2, 0.5) === 1);
check('effAmount 0.5x: 3-part recipe -> 2 (round half up)', LP.effAmount(3, 0.5) === 2);
check('effAmount never rounds a needed part to 0', LP.effAmount(1, 0.1) === 1);
// FLUIDS round at the game's native mL granularity (1 m³ = 1000), not whole m³:
// 3 m³ Crude Oil at 0.5x is exactly 1.5 m³ — the Heavy Oil Residue alternate shows
// 15/min crude in-game, not the 20/min that whole-m³ rounding produced.
check('effAmount fluid 0.5x: 3 m³ -> 1.5 m³ (mL granularity)', LP.effAmount(3, 0.5, true) === 1.5);
check('effAmount fluid 0.25x: 3 m³ -> 0.75 m³', LP.effAmount(3, 0.25, true) === 0.75);
check('effAmount fluid floors at 1 mL, never free', LP.effAmount(0.001, 0.25, true) === 0.001);
{
  const ph = LP.planner({ targets: { Desc_HeavyOilResidue_C: 40 }, recipes: ['Recipe_Alternate_HeavyOilResidue_C'], rawItems: [], recipeCost: 0.5 });
  const oil = ph.feasible && ph.raw.find((r) => r.item === 'Desc_LiquidOil_C');
  check('0.5x HOR alternate: 40 HOR/min draws 15 crude/min (game-accurate)', !!oil && near(oil.rate, 15, 1e-6));
  const resin = ph.feasible && ph.outputs.find((o) => o.item === 'Desc_PolymerResin_C');
  check('0.5x HOR alternate: 20 resin/min by-product', !!resin && near(resin.rate, 20, 1e-6));
}
// Exhaustive cost-rounding invariants over EVERY recipe ingredient × all 8 game
// multipliers: fluids must land on whole mL, solids on whole units, nothing rounds
// free, 1x stays exact, and (cost ≤ 1) never charges MORE than vanilla. Burn
// pseudo-recipes are skipped — they're cost-exempt physics with per-minute amounts.
{
  let badMl = 0, badSolid = 0, badZero = 0, badExact = 0, badMono = 0;
  for (const cost of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) {
    for (const rc in DATA.recipes) {
      if (DATA.recipes[rc].burner) continue;
      for (const g of DATA.recipes[rc].ingredients) {
        const liquid = !!(DATA.items[g.item] && DATA.items[g.item].liquid);
        const eff = LP.effAmount(g.amount, cost, liquid);
        if (cost === 1 && eff !== g.amount) badExact++;
        if (!(eff > 0)) badZero++;
        if (cost <= 1 && eff > g.amount + 1e-9 && g.amount >= 1) badMono++; // floor-at-1 may lift sub-1 amounts; whole parts must never grow under a discount
        if (liquid) { const ml = eff * 1000; if (Math.abs(ml - Math.round(ml)) > 1e-6) badMl++; }
        else if (Math.abs(eff - Math.round(eff)) > 1e-9) badSolid++;
      }
    }
  }
  check('sweep: every fluid cost lands on whole mL (all recipes × 8 multipliers)', badMl === 0);
  check('sweep: every solid cost stays a whole unit', badSolid === 0);
  check('sweep: no ingredient ever rounds to free', badZero === 0);
  check('sweep: 1x is always exact', badExact === 0);
  check('sweep: a discount never raises a whole-part cost', badMono === 0);
}
// A 1:1 smelter is UNCHANGED at 0.5x (round(1*0.5)=1): 30 ore still makes 30 ingot.
const ph1 = LP.planner({ targets: { [IronIngot]: 30 }, recipes: [primStd(IronIngot)], rawItems: [], recipeCost: 0.5 });
const oreI = ph1.raw.find((r) => r.item === IronOre);
check('0.5x: 1:1 smelter unchanged (30 ore for 30 ingot)', !!oreI && near(oreI.rate, 30, 0.1));
// A multi-part recipe DOES shrink: Iron Plate (3 ingot -> 2 plate) rounds to 2 ingot, so
// 20 plate needs 20 ingot -> 20 ore (was 30 at 1x).
const ph2 = LP.planner({ targets: { [IronPlate]: 20 }, recipes: [primStd(IronIngot), primStd(IronPlate)], rawItems: [], recipeCost: 0.5 });
const oreP = ph2.raw.find((r) => r.item === IronOre);
check('0.5x: 3-ingot plate recipe rounds to 2 (ore 30 -> 20)', !!oreP && near(oreP.rate, 20, 0.1));
check('planner uses 2 machines total', plan.totalMachines === 2);

// ---- Nuclear power data: plant burn rates + waste by-products (from the game Docs) ----
console.log('\n### POWERGEN NUCLEAR (burn rates + waste)');
{
  const NUKE = DATA.powergen && DATA.powergen.Build_GeneratorNuclear_C;
  check('Nuclear Power Plant in powergen (2,500 MW)', !!NUKE && NUKE.power === 2500);
  check('burn rates: 0.2 uranium / 0.1 plutonium / 1 ficsonium rods per min',
    !!NUKE && near(NUKE.fuels.Desc_NuclearFuelRod_C, 0.2, 1e-9) && near(NUKE.fuels.Desc_PlutoniumFuelRod_C, 0.1, 1e-9) && near(NUKE.fuels.Desc_FicsoniumFuelRod_C, 1, 1e-9));
  check('supplemental water 240/min per plant', !!NUKE && NUKE.supplemental && NUKE.supplemental.item === 'Desc_Water_C' && near(NUKE.supplemental.rate, 240, 1e-9));
  check('uranium rod -> 50 Uranium Waste', !!NUKE && NUKE.waste && NUKE.waste.Desc_NuclearFuelRod_C && NUKE.waste.Desc_NuclearFuelRod_C.item === 'Desc_NuclearWaste_C' && NUKE.waste.Desc_NuclearFuelRod_C.amount === 50);
  check('plutonium rod -> 10 Plutonium Waste', !!NUKE && NUKE.waste && NUKE.waste.Desc_PlutoniumFuelRod_C && NUKE.waste.Desc_PlutoniumFuelRod_C.item === 'Desc_PlutoniumWaste_C' && NUKE.waste.Desc_PlutoniumFuelRod_C.amount === 10);
  check('ficsonium rod leaves no waste', !!NUKE && NUKE.waste && NUKE.waste.Desc_FicsoniumFuelRod_C == null);
  check('non-nuclear generators carry no waste field', DATA.powergen.Build_GeneratorCoal_C.waste == null && DATA.powergen.Build_GeneratorFuel_C.waste == null);
}

// ---- Nuclear burn pseudo-recipes: the whole loop in one plan ----
// nuclear-burn.js injects Burn_<rod> recipes (rod + water -> virtual MW + waste) so the
// reactors are real machine steps: the optimizer's by-product balance then forces waste
// into the plutonium chain and the sinkable rods into the Awesome Sink — the classic
// "no permanent waste" build emerges from the constraints alone.
console.log('\n### NUCLEAR BURN RECIPES (full loop)');
{
  const MW = 'Virtual_MW_C';
  check('virtual MW item injected', !!DATA.items[MW] && DATA.items[MW].virtual === true);
  const burnU = DATA.recipes.Burn_Desc_NuclearFuelRod_C;
  check('uranium burn recipe: 0.2 rod + 240 water -> 2500 MW + 10 waste', !!burnU
    && burnU.ingredients.some((i) => i.item === 'Desc_NuclearFuelRod_C' && near(i.amount, 0.2, 1e-9))
    && burnU.ingredients.some((i) => i.item === 'Desc_Water_C' && near(i.amount, 240, 1e-9))
    && burnU.products.some((p) => p.item === MW && p.amount === 2500)
    && burnU.products.some((p) => p.item === 'Desc_NuclearWaste_C' && near(p.amount, 10, 1e-9)));
  check('ficsonium burn has no waste product', DATA.recipes.Burn_Desc_FicsoniumFuelRod_C.products.length === 1);

  // Optimizer: demand 7,500 MW with by-product sinking on -> 3 plants, zero net waste,
  // plutonium rods sunk (uranium waste is unsinkable, so the LP must reprocess it).
  const allRes = {};
  for (const r of DATA.resources) allRes[r] = Infinity;
  const res = LP.optimize({ outputs: { [MW]: 7500 }, allowedInputs: allRes, objective: 'machines', allowAlternates: true, sinkByproducts: true });
  check('optimizer solves a 7.5 GW nuclear demand', res.feasible === true);
  const plants = res.feasible && res.recipes.find((r) => r.rc === 'Burn_Desc_NuclearFuelRod_C');
  check('3 reactors built (7500 / 2500 MW)', !!plants && near(plants.machines, 3, 1e-6));
  check('zero net uranium waste (reprocessed, not floating)', res.feasible && !(res.net.Desc_NuclearWaste_C > 1e-6) && !res.outputs.some((o) => o.item === 'Desc_NuclearWaste_C'));
  check('plutonium rods leave via the Awesome Sink', res.feasible && (res.sunk || []).some((s) => s.item === 'Desc_PlutoniumFuelRod_C' && s.rate > 0));
  check('MW output delivered exactly', res.feasible && res.outputs.some((o) => o.item === MW && near(o.rate, 7500, 1e-4)));

  // Planner: the canonical 30-reactor module (Infused Uranium Cell + Uranium Fuel Unit,
  // default waste chain) — machine counts must land on the known clean ratios.
  const modRecipes = [
    'Burn_Desc_NuclearFuelRod_C',
    'Recipe_Alternate_NuclearFuelRod_1_C', 'Recipe_Alternate_UraniumCell_1_C',
    'Recipe_ElectromagneticControlRod_C', 'Recipe_CrystalOscillator_C', 'Recipe_Rotor_C',
    'Recipe_NonFissileUranium_C', 'Recipe_Plutonium_C', 'Recipe_PlutoniumCell_C', 'Recipe_PlutoniumFuelRod_C',
    'Recipe_NitricAcid_C', 'Recipe_SulfuricAcid_C',
  ];
  const modRaws = ['Desc_Silica_C', 'Desc_HighSpeedWire_C', 'Desc_Cement_C', 'Desc_SteelPlate_C', 'Desc_AluminumCasing_C', 'Desc_QuartzCrystal_C', 'Desc_Cable_C', 'Desc_Stator_C', 'Desc_IronPlateReinforced_C', 'Desc_AluminumPlateReinforced_C', 'Desc_IronPlate_C', 'Desc_IronRod_C', 'Desc_IronScrew_C', 'Desc_CircuitBoardHighSpeed_C'];
  const mod = LP.planner({ targets: { [MW]: 75000, Desc_PlutoniumFuelRod_C: 1.5 }, recipes: modRecipes, rawItems: modRaws });
  const m = (rc) => { const r = mod.recipes.find((x) => x.rc === rc); return r ? r.machines : 0; };
  check('30-reactor module solves', mod.feasible === true);
  check('module: 30 plants / 10 fuel units / 10 infused cells', near(m('Burn_Desc_NuclearFuelRod_C'), 30, 1e-6) && near(m('Recipe_Alternate_NuclearFuelRod_1_C'), 10, 1e-6) && near(m('Recipe_Alternate_UraniumCell_1_C'), 10, 1e-6));
  check('module: 6 NFU blenders / 3 accelerators / 9 assemblers / 6 rod manufacturers', near(m('Recipe_NonFissileUranium_C'), 6, 1e-6) && near(m('Recipe_Plutonium_C'), 3, 1e-6) && near(m('Recipe_PlutoniumCell_C'), 9, 1e-6) && near(m('Recipe_PlutoniumFuelRod_C'), 6, 1e-6));
  check('module: zero net waste, both targets met', near(mod.net.Desc_NuclearWaste_C || 0, 0, 1e-6) && mod.outputs.some((o) => o.item === MW && near(o.rate, 75000, 1e-3)) && mod.outputs.some((o) => o.item === 'Desc_PlutoniumFuelRod_C' && near(o.rate, 1.5, 1e-6)));

  // Recipe Parts Cost Multiplier must NOT touch burn physics: at 0.25x a crafting
  // recipe's parts shrink, but a reactor still drinks 240 water per plant.
  const burnOnly = LP.planner({ targets: { [MW]: 2500 }, recipes: ['Burn_Desc_NuclearFuelRod_C'], rawItems: ['Desc_NuclearFuelRod_C'], recipeCost: 0.25 });
  const w = burnOnly.feasible && burnOnly.raw.find((r) => r.item === 'Desc_Water_C');
  check('cost multiplier 0.25x leaves the reactor water draw at 240/min', !!w && near(w.rate, 240, 1e-6));
}

// ---- 'loops' objective: straightforward feed-forward chains ----
console.log('\n### LOOPS OBJECTIVE (straightforward chains)');
{
  const allRes = {};
  for (const r of DATA.resources) allRes[r] = Infinity;
  // loopEdgeCountOf is a pure graph metric — pin its two loop flavours deterministically.
  const sumOf = (...rcs) => ({ recipes: rcs.map((rc) => ({ rc })) });
  check('2-cycle counted (Recycled Rubber <-> Recycled Plastic = 2 loop edges)',
    LP.loopEdgeCountOf(sumOf('Recipe_Alternate_RecycledRubber_C', 'Recipe_Alternate_Plastic_1_C')) === 2);
  check('a plain chain has zero loop edges',
    LP.loopEdgeCountOf(sumOf('Recipe_IngotIron_C', 'Recipe_IronPlate_C')) === 0);
  check('self-loop counted (std Encased Uranium Cell: sulfuric acid in AND out)',
    LP.loopEdgeCountOf(sumOf('Recipe_UraniumCell_C')) === 1);

  // Plastic + Rubber demand is the classic recycled-loop bait — the 'loops' objective
  // must deliver a feed-forward plan (zero loop edges), even at a worse raw bill.
  const Plastic = cls('Plastic'), Rubber = cls('Rubber');
  const loopy = LP.optimize({ outputs: { [Plastic]: 90, [Rubber]: 90 }, allowedInputs: allRes, objective: 'loops', allowAlternates: true, sinkByproducts: true });
  check('plastic+rubber solves under the loops objective', loopy.feasible === true);
  check('plastic+rubber plan is loop-free', loopy.feasible && LP.loopEdgeCountOf(loopy) === 0);
  check('objectiveValue reports the loop count', loopy.feasible && loopy.objective === 'loops' && loopy.objectiveValue === 0);
  // Same demand under 'raw' picks the recycled cycle (that's WHY the mode exists).
  const rawPlan = LP.optimize({ outputs: { [Plastic]: 90, [Rubber]: 90 }, allowedInputs: allRes, objective: 'raw', allowAlternates: true, sinkByproducts: true });
  check('raw objective happily loops on the same demand (mode differentiates)', rawPlan.feasible && LP.loopEdgeCountOf(rawPlan) > 0);

  // Self-loop avoidance: Encased Uranium Cell demand should land on a recipe set with
  // no step feeding itself (the Infused alternate has no acid return).
  const cell = LP.optimize({ outputs: { [cls('Encased Uranium Cell')]: 50 }, allowedInputs: allRes, objective: 'loops', allowAlternates: true, sinkByproducts: true });
  check('uranium cell plan avoids the sulfuric self-loop', cell.feasible && LP.loopEdgeCountOf(cell) === 0);
}

// ---- 'clean' objective: cleanest machine ratios, no adherence to other objectives ----
console.log('\n### CLEAN OBJECTIVE (cleanest ratios as a mode)');
{
  const allRes = {};
  for (const r of DATA.resources) allRes[r] = Infinity;
  const RIP = cls('Reinforced Iron Plate');
  const res = LP.optimize({ outputs: { [RIP]: 7 }, allowedInputs: allRes, objective: 'clean', allowAlternates: true, sinkByproducts: true });
  check('clean objective solves', res.feasible === true);
  check('result stamped objective=clean', res.objective === 'clean');
  // The mode's promise: machine counts rationalize — the ladder leaves nothing forced-fractional.
  const ladder = res.feasible && LP.cleanLadderUp(res.recipes.map((r) => r.machines));
  check('every machine count rationalizes to a sane clean scale', !!ladder && ladder.frac === 0);
  check('objectiveValue = forced-fractional steps (0)', res.objectiveValue === 0);
  check("asked rate still met (scaling is the renderer's job)", res.outputs.some((o) => o.item === RIP && o.rate >= 7 - 1e-6));
}

// ---- exportWaste: uranium waste as supply for a SEPARATE plutonium factory ----
console.log('\n### EXPORT WASTE (separate plutonium factory)');
{
  const allRes = {};
  for (const r of DATA.resources) allRes[r] = Infinity;
  const MW = 'Virtual_MW_C';
  // exportWaste ON: the machines objective happily skips in-plan reprocessing — the
  // waste floats up as an exportable plan output instead.
  const exp = LP.optimize({ outputs: { [MW]: 7500 }, allowedInputs: allRes, objective: 'machines', allowAlternates: true, sinkByproducts: true, exportWaste: true });
  check('exportWaste: nuclear plan solves', exp.feasible === true);
  const w = exp.feasible && exp.outputs.find((o) => o.item === 'Desc_NuclearWaste_C');
  check('exportWaste: 30/min Uranium Waste floats as a plan output', !!w && near(w.rate, 30, 1e-4));
  check('exportWaste: no in-plan reprocessing forced', exp.feasible && !exp.recipes.some((r) => r.rc === 'Recipe_NonFissileUranium_C' || r.rc === 'Recipe_Alternate_FertileUranium_C'));
  // The separate plutonium factory consumes that waste as a capped supplied input
  // (exactly what a Project link feeds it): 30 waste/min -> 0.15 rods/min.
  const pluto = LP.optimize({ outputs: { Desc_PlutoniumFuelRod_C: 0.15 }, allowedInputs: Object.assign({}, allRes, { Desc_NuclearWaste_C: 30 }), objective: 'machines', allowAlternates: false, sinkByproducts: true });
  check('plutonium factory feasible on the linked 30/min waste', pluto.feasible === true);
  const used = pluto.feasible && pluto.raw.find((r) => r.item === 'Desc_NuclearWaste_C');
  check('plutonium factory draws the waste as its input', !!used && used.rate > 1 && used.rate <= 30 + 1e-6);
  // Default (exportWaste off) is unchanged: the forced no-waste loop — covered by the
  // burn-recipe block above ('plutonium rods leave via the Awesome Sink').
}

// ---- Water disposal modes: report / Wet Concrete / Packaged Water ----
// Aluminum Scrap fed from supplied Alumina Solution is a pure water-surplus plan:
// 360 scrap/min leaves 120 water/min with no in-plan consumer.
console.log('\n### WATER DISPOSAL MODES');
{
  const allRes = {};
  for (const r of DATA.resources) allRes[r] = Infinity;
  const scrapArgs = { outputs: { Desc_AluminumScrap_C: 360 }, allowedInputs: Object.assign({}, allRes, { Desc_AluminaSolution_C: Infinity }), objective: 'machines', allowAlternates: false, sinkByproducts: true };
  // Mode OFF: the excess is REPORTED as a resource surplus, not silently dropped.
  const off = LP.optimize(scrapArgs);
  const xs = off.feasible && (off.resSurplus || []).find((r) => r.item === 'Desc_Water_C');
  check('off: 120/min excess water reported as resSurplus', !!xs && near(xs.rate, 120, 1e-4));
  // Mode PACKAGE: net water capped at ≤ 0. The solver may consume the surplus in any
  // real water-eating recipe when that's cheaper (here: extra Alumina Solution offsets
  // the supplied input) — the contract is simply NO surplus survives.
  const pkg = LP.optimize(Object.assign({}, scrapArgs, { packageWater: true }));
  check('package: plan solves', pkg.feasible === true);
  check('package: no leftover water surplus (consumed or packaged)', pkg.feasible && !(pkg.resSurplus || []).length && !(pkg.net.Desc_Water_C > 1e-6));
  // Forced-Packager scenario: inputs offer NO other water consumer (alumina-from-bauxite
  // is impossible without bauxite; residual plastic/rubber blocked), so the surplus MUST
  // be packaged — Packager + in-plan Empty Canister chain + plastic from oil, sunk.
  const forced = LP.optimize({
    outputs: { Desc_AluminumScrap_C: 360 },
    allowedInputs: { Desc_AluminaSolution_C: Infinity, Desc_Coal_C: Infinity, Desc_LiquidOil_C: Infinity },
    objective: 'machines', allowAlternates: false, sinkByproducts: true, packageWater: true,
    blockedRecipes: new Set(['Recipe_ResidualPlastic_C', 'Recipe_ResidualRubber_C']),
  });
  check('package (forced): plan solves', forced.feasible === true);
  const pkgStep = forced.feasible && forced.recipes.find((r) => r.rc === 'Recipe_PackagedWater_C');
  check('package (forced): 2 Packagers for 120 water/min', !!pkgStep && near(pkgStep.machines, 2, 1e-6));
  check('package (forced): canisters crafted in-plan (2 Constructors)', forced.feasible && forced.recipes.some((r) => r.rc === 'Recipe_FluidCanister_C' && near(r.machines, 2, 1e-6)));
  check('package (forced): plastic feedstock chain in-plan from oil', forced.feasible && forced.recipes.some((r) => r.rc === 'Recipe_Plastic_C') && forced.raw.some((r) => r.item === 'Desc_LiquidOil_C'));
  check('package (forced): 120/min Packaged Water leaves via the Awesome Sink', forced.feasible && (forced.sunk || []).some((s) => s.item === 'Desc_PackagedWater_C' && near(s.rate, 120, 1e-4)));
  // LOOPS STAY ALLOWED: an aluminum-ingot plan nets its scrap water against the alumina
  // draw — net water is a fresh DRAW, so no Packager appears and nothing is diverted.
  const alu = LP.optimize({ outputs: { Desc_AluminumIngot_C: 240 }, allowedInputs: allRes, objective: 'machines', allowAlternates: false, sinkByproducts: true, packageWater: true });
  check('package: aluminum still solves with loops allowed', alu.feasible === true);
  check('package: aluminum nets water (fresh draw, no Packager)', alu.feasible && (alu.net.Desc_Water_C || 0) < -1e-6 && !alu.recipes.some((r) => r.rc === 'Recipe_PackagedWater_C'));
  // Diagnostic: water allowed but no oil ⇒ no plastic ⇒ no canisters — dropping ONLY the
  // net-water cap would solve, so the failure is named waterPackaging.
  const noCans = LP.optimize({
    outputs: { Desc_AluminumScrap_C: 360 },
    allowedInputs: { Desc_AluminaSolution_C: Infinity, Desc_Coal_C: Infinity, Desc_Water_C: Infinity },
    objective: 'machines', allowAlternates: false, sinkByproducts: true, packageWater: true,
  });
  check('package: canister-less plan reports waterPackaging infeasibility', noCans.feasible === false && noCans.waterPackaging === true);
  // Without Water even allowed as an input, the by-product balance itself blocks (the
  // older "would back up" shape) — and the fluid surplus is still NAMED via resSurplus.
  const noWaterIn = LP.optimize({
    outputs: { Desc_AluminumScrap_C: 360 },
    allowedInputs: { Desc_AluminaSolution_C: Infinity, Desc_Coal_C: Infinity },
    objective: 'machines', allowAlternates: false, sinkByproducts: true, packageWater: true,
  });
  check('package: water-not-allowed plan names Water as the backing-up fluid', noWaterIn.feasible === false && (noWaterIn.backup || []).includes('Desc_Water_C'));
}

// Infeasible: ask for a product with no allowed inputs.
const bad = LP.optimize({ outputs: { [IronIngot]: 30 }, allowedInputs: {}, objective: 'raw', allowAlternates: false });
check('optimize infeasible with no inputs', bad.feasible === false);

// ---- Solver float dust: no phantom "0/min" by-products / raw inputs ----
// Simplex residue scales with the rates flowing through an item (~2e-10 of gross), so a
// 6,000/min aluminum plan used to leak net residues of ±1e-6..2.4e-6 past the old absolute
// 1e-6 cutoff — rendering phantom "Aluminum Scrap 0/min" raw and "Alumina Solution 0/min"
// output nodes. summarize() now snaps |net| below a gross-relative epsilon to exact zero.
console.log('\n### SOLVER DUST (phantom 0/min entries)');
{
  const allRes = {};
  for (const r of DATA.resources) allRes[r] = Infinity;
  const alclad = cls('Alclad Aluminum Sheet'), casing = cls('Aluminum Casing');
  let dust = 0, plans = 0, missing = 0;
  for (const objective of ['raw', 'power', 'machines', 'recipes', 'edges']) {
    for (const sloopMult of [null, { Recipe_Alternate_SloppyAlumina_C: 2 }]) {
      const res = LP.optimize({ outputs: { [alclad]: 6000, [casing]: 6000 }, allowedInputs: allRes, objective, allowAlternates: true, sinkByproducts: true, waterSink: true, sloopMult });
      if (!res.feasible) continue;
      plans++;
      for (const it in res.net) { const v = Math.abs(res.net[it]); if (v > 0 && v < 0.01) dust++; }
      for (const r of res.raw) if (r.rate < 0.01) dust++;
      for (const o of res.outputs) if (o.rate < 0.01) dust++;
      for (const s of res.sunk || []) if (s.rate < 0.01) dust++;
      // the demanded outputs themselves must survive the snap at full rate
      for (const it of [alclad, casing]) {
        const o = res.outputs.find((x) => x.item === it);
        if (!o || Math.abs(o.rate - 6000) > 0.01) missing++;
      }
    }
  }
  check(`aluminum sweep solves (${plans}/10 plans feasible)`, plans === 10);
  check('no net/raw/output/sunk entry below 0.01/min (dust snapped to 0)', dust === 0);
  check('demanded outputs survive the snap at full rate', missing === 0);
  // Genuinely tiny plans keep their small rates (the epsilon floor stays at 1e-6).
  const tiny = LP.optimize({ outputs: { [IronPlate]: 0.1 }, allowedInputs: { [IronOre]: Infinity }, objective: 'raw', allowAlternates: false });
  const tinyOut = tiny.feasible && tiny.outputs.find((o) => o.item === IronPlate);
  check('a real 0.1/min output is NOT snapped away', !!tinyOut && near(tinyOut.rate, 0.1, 1e-4));
}

// Intermediate as a free input (what U4 surfaces in the UI): supply Iron Ingot and
// make Iron Plate — the ingot is consumed directly, no ore pulled.
const interm = LP.optimize({ outputs: { [IronPlate]: 20 }, allowedInputs: { [IronIngot]: Infinity }, objective: 'raw', allowAlternates: false });
check('optimize from an intermediate input feasible', interm.feasible === true);
const ingotIn = interm.raw.find((r) => r.item === IronIngot);
check('supplied intermediate consumed (~30 ingot for 20 plate)', !!ingotIn && near(ingotIn.rate, 30, 0.5));
check('no ore pulled when ingot supplied', !interm.raw.some((r) => r.item === IronOre));

// By-product disposal: standard Plastic emits Heavy Oil Residue (a fluid). With
// sinking on, the optimizer must route that HOR somewhere — here HOR -> Petroleum Coke
// (a solid) -> Awesome Sink — instead of letting it pile up and deadlock the line.
const allRaw = Object.fromEntries(DATA.resources.map((r) => [r, Infinity]));
const Plastic = cls('Plastic'), HOR = cls('Heavy Oil Residue'), Coke = cls('Petroleum Coke'), Fuel = cls('Fuel');
const sinkOn = LP.optimize({ outputs: { [Plastic]: 120 }, allowedInputs: allRaw, objective: 'machinesLP', allowAlternates: false, sinkByproducts: true });
check('sink on: feasible', sinkOn.feasible === true);
check('sink on: Heavy Oil Residue fully consumed (net ~0)', near(sinkOn.net[HOR] || 0, 0, 1e-4));
check('sink on: no fluid left as surplus', !sinkOn.outputs.some((o) => DATA.items[o.item] && DATA.items[o.item].liquid));
check('sink on: Petroleum Coke routed to the Awesome Sink', (sinkOn.sunk || []).some((s) => s.item === Coke && s.rate > 0));
check('sink on: sink points reported', (sinkOn.sunk || []).every((s) => s.points > 0));

// Legacy behaviour (toggle off): the by-product is allowed to float as surplus.
const sinkOff = LP.optimize({ outputs: { [Plastic]: 120 }, allowedInputs: allRaw, objective: 'machinesLP', allowAlternates: false, sinkByproducts: false });
check('sink off: Heavy Oil Residue floats as surplus', sinkOff.outputs.some((o) => o.item === HOR && o.rate > 0));
check('sink off: nothing sunk', (sinkOff.sunk || []).length === 0);

// With alternates on, the solver can do better than sinking: close the loop by feeding
// HOR back through Diluted Fuel / Recycled Plastic so only the desired output remains.
const loop = LP.optimize({ outputs: { [Plastic]: 120 }, allowedInputs: allRaw, objective: 'machinesLP', allowAlternates: true, sinkByproducts: true });
check('alts + sink: feasible', loop.feasible === true);
check('alts + sink: no by-product surplus at all', loop.feasible && !loop.outputs.some((o) => o.item !== Plastic));

// Water sink via Wet Concrete: aluminum refining dumps Water from its scrap step. Water is
// a raw RESOURCE, so by default that surplus silently floats (in-game it backs up the pipes
// and forces a recirculation loop). With the water-sink option on, the surplus is diverted
// into Wet Concrete (-> sinkable Concrete) and all fresh water is drawn from extractors — no
// loop. Use a scrap/ingot plant that imports Alumina Solution so the scrap water is pure
// surplus (no local alumina step to soak it back up).
const AlIngot = cls('Aluminum Ingot'), Alumina = cls('Alumina Solution'), Water = cls('Water'), Concrete = cls('Concrete'), Limestone = cls('Limestone'), WetRC = 'Recipe_Alternate_WetConcrete_C';
const scrapInputs = Object.assign({ [Alumina]: Infinity }, allRaw);
const blockAlumina = new Set(['Recipe_Alternate_SloppyAlumina_C', 'Recipe_AluminaSolution_C', 'Recipe_PackagedWater_C']);
const wsArgs = { outputs: { [AlIngot]: 100 }, allowedInputs: scrapInputs, objective: 'raw', allowAlternates: true, sinkByproducts: true, blockedRecipes: blockAlumina };
const wOff = LP.optimize(Object.assign({}, wsArgs, { waterSink: false }));
const wOn = LP.optimize(Object.assign({}, wsArgs, { waterSink: true }));
check('water-sink off: surplus water floats (net > 0, hidden because Water is raw)', (wOff.net[Water] || 0) > 1);
check('water-sink off: nothing routed to Wet Concrete', (wOff.watered || []).length === 0);
check('water-sink on: feasible', wOn.feasible === true);
check('water-sink on: surplus water disposed (net ~0)', near(wOn.net[Water] || 0, 0, 1e-4));
check('water-sink on: Wet Concrete route ran', (wOn.watered || []).length > 0 && wOn.watered[0].machines > 0);
check('water-sink on: routed water == prior surplus', near(wOn.watered[0].rate, wOff.net[Water] || 0, 0.5));
check('water-sink on: Concrete produced and sunk', wOn.watered[0].concrete > 0 && (wOn.sunk || []).some((s) => s.item === Concrete && s.rate > 0));
check('water-sink on: Limestone drawn as raw for it', wOn.raw.some((r) => r.item === Limestone && r.rate > 0));
check('water-sink on: no phantom water output for downstream links', !wOn.outputs.some((o) => o.item === Water));
// The route is an explicit opt-in to Wet Concrete, but still respects an outright block.
const wBlocked = LP.optimize(Object.assign({}, wsArgs, { waterSink: true, blockedRecipes: new Set([...blockAlumina, WetRC]) }));
check('water-sink: a blocked Wet Concrete disables the route', (wBlocked.watered || []).length === 0);
// Integrated plant (makes Alumina Solution locally): water normally recirculates. The option
// breaks the loop — fresh-water draw rises to the full demand and the scrap water is dumped.
const intOff = LP.optimize({ outputs: { [AlIngot]: 100 }, allowedInputs: allRaw, objective: 'raw', allowAlternates: true, sinkByproducts: true, waterSink: false });
const intOn = LP.optimize({ outputs: { [AlIngot]: 100 }, allowedInputs: allRaw, objective: 'raw', allowAlternates: true, sinkByproducts: true, waterSink: true });
const freshOff = (intOff.raw.find((r) => r.item === Water) || {}).rate || 0;
const freshOn = (intOn.raw.find((r) => r.item === Water) || {}).rate || 0;
check('water-sink on: integrated plant draws more fresh water (loop broken)', intOn.feasible && freshOn > freshOff);

// Generator data the disposal model relies on (Fuel-Powered Generator: 250 MW).
check('generators data present', !!(DATA.generators && DATA.generators.Build_GeneratorFuel_C));
check('Fuel Generator burns 20 Fuel/min', near(DATA.generators.Build_GeneratorFuel_C.fuels[Fuel], 20, 0.01));

// Package <-> Unpackage cycle: building from raw, the optimizer must never run an
// unpackage recipe — it would only pair with its package recipe to spin a pointless
// Water <-> Packaged Water loop instead of using a real Empty Canister recipe.
const PkgFuel = cls('Packaged Fuel'); // Desc_Fuel_C (legacy name — the *packaged* item)
const cyc = LP.optimize({ outputs: { [PkgFuel]: 60 }, allowedInputs: allRaw, objective: 'machinesLP', allowAlternates: true, sinkByproducts: true });
check('packaged-fuel plan feasible', cyc.feasible === true);
check('no unpackage recipe used when building from raw', !cyc.recipes.some((s) => /unpackage/i.test(s.rc)));
check('Empty Canister comes from a real producer (not an unpackage loop)', cyc.recipes.some((s) => DATA.recipes[s.rc].products.some((p) => p.item === cls('Empty Canister'))));
// ...but unpackaging IS allowed when the packaged item is supplied as a free input.
const supplied = LP.optimize({ outputs: { [cls('Fuel')]: 60 }, allowedInputs: Object.assign({ [PkgFuel]: Infinity }, allRaw), objective: 'machinesLP', allowAlternates: true });
check('unpackage allowed when its packaged input is supplied', supplied.feasible && supplied.recipes.some((s) => /unpackage/i.test(s.rc)));

// ---- Somersloop in the material balance ----
// Sloop amplifies OUTPUT only (inputs per machine unchanged), so a fully-slooped step
// must shrink its machines AND its whole upstream chain — not just trade machines for
// power. (The old post-rescale divided machines by the multiplier but left the LP
// balance un-slooped, overstating raw by up to 2×.)
console.log('\n### SOMERSLOOP BALANCE');
const slPlan = LP.planner({ targets: { [IronPlate]: 20 }, recipes: [primStd(IronIngot), primStd(IronPlate)], rawItems: [], sloopMult: { [primStd(IronPlate)]: 2 } });
check('sloop: planner feasible', slPlan.feasible === true);
const slPlate = slPlan.recipes.find((r) => r.rc === primStd(IronPlate));
const basePlate = plan.recipes.find((r) => r.rc === primStd(IronPlate));
check('sloop: plate output rate unchanged (20/min)', !!slPlate && near(slPlate.rate, 20, 0.1));
check('sloop: plate machines halved vs un-slooped', !!slPlate && !!basePlate && near(slPlate.machines, basePlate.machines / 2, 1e-6));
const slOre = slPlan.raw.find((r) => r.item === IronOre);
check('sloop: upstream raw halved (30 -> 15 ore)', !!slOre && near(slOre.rate, 15, 0.1));
const slOpt = LP.optimize({ outputs: { [IronPlate]: 20 }, allowedInputs: { [IronOre]: Infinity }, objective: 'raw', allowAlternates: false, sloopMult: { [primStd(IronPlate)]: 2 } });
check('sloop: optimizer raw halved too', slOpt.feasible === true && near(slOpt.objectiveValue, 15, 0.5));

// ---- item both demanded AND supplied: supply nets against the demand ----
console.log('\n### DEMAND + SUPPLY NETTING');
const netFull = LP.optimize({ outputs: { [IronPlate]: 100 }, allowedInputs: { [IronPlate]: 100, [IronOre]: Infinity }, objective: 'raw', allowAlternates: false });
check('supply covers demand: no raw pulled', netFull.feasible === true && !(netFull.raw || []).some((r) => r.item === IronOre));
const netPart = LP.optimize({ outputs: { [IronPlate]: 100 }, allowedInputs: { [IronPlate]: 40, [IronOre]: Infinity }, objective: 'raw', allowAlternates: false });
const netOre = (netPart.raw || []).find((r) => r.item === IronOre);
check('partial supply netted (60 plate to build -> 90 ore)', netPart.feasible === true && !!netOre && near(netOre.rate, 90, 0.5));

// ---- demanded leaf item with every producer blocked: infeasible, named ----
// (Previously the item fell out of the constraint set entirely and the solver returned
// a feasible EMPTY plan with no warning.)
console.log('\n### ORPHANED DEMAND');
const leaf = Object.keys(DATA.items).find((it) =>
  Object.keys(DATA.recipes).some((rc) => DATA.recipes[rc].products.some((p) => p.item === it)) &&
  !Object.keys(DATA.recipes).some((rc) => DATA.recipes[rc].ingredients.some((g) => g.item === it)));
const leafProducers = new Set(Object.keys(DATA.recipes).filter((rc) => DATA.recipes[rc].products.some((p) => p.item === leaf)));
const orphan = LP.optimize({ outputs: { [leaf]: 100 }, allowedInputs: allRaw, objective: 'raw', allowAlternates: true, blockedRecipes: leafProducers });
check('all producers blocked -> infeasible (not an empty feasible plan)', orphan.feasible === false);
check('orphaned demand named in noProducer', Array.isArray(orphan.noProducer) && orphan.noProducer.includes(leaf));

// ---- unbounded max-throughput objective is reported, not shown as Infinity ----
// Cost multiplier 0.5 rounds the package<->unpackage pair matter-positive (1 Water in,
// 2 Water out), so maximizing Water from supplied Packaged Water is unbounded.
console.log('\n### UNBOUNDED MAX');
const unb = LP.maxThroughput({ product: cls('Water'), supply: { [cls('Packaged Water')]: 100 }, recipeCost: 0.5 });
check('unbounded max -> infeasible + flagged', unb.feasible === false && unb.unbounded === true);

// ---- recipe + building exclusion (F1 / F4) ----
// blockedRecipes drops the named recipes from the pool for optimize/maxThroughput,
// covering STANDARD recipes (the alt veto can't) and whole buildings (the renderer
// expands a disabled building into its recipe classNames before calling).
console.log('\n### RECIPE / BUILDING EXCLUSION');
const allRawX = Object.fromEntries(DATA.resources.map((r) => [r, Infinity]));
const stdIngot = 'Recipe_IngotIron_C';          // standard Iron Ingot (Smelter), no alt needed
const altIngotFoundry = 'Recipe_Alternate_IronIngot_Basic_C'; // an alternate Iron Ingot recipe

// F1: blocking the standard recipe with alts OFF makes plain Iron Ingot infeasible
// (its only non-alternate producer is gone).
const blockStdNoAlt = LP.optimize({ outputs: { [IronIngot]: 30 }, allowedInputs: allRawX, objective: 'raw', allowAlternates: false, blockedRecipes: new Set([stdIngot]) });
check('F1: blocking sole standard recipe (alts off) -> infeasible', blockStdNoAlt.feasible === false);
// ...and the standard recipe itself never appears even when it would otherwise be optimal.
const baseIngot = LP.optimize({ outputs: { [IronIngot]: 30 }, allowedInputs: allRawX, objective: 'raw', allowAlternates: false });
check('control: standard Iron Ingot recipe used when not blocked', baseIngot.feasible && baseIngot.recipes.some((s) => s.rc === stdIngot));
// F1 + alternates: blocking the standard recipe forces the solver onto an alternate.
const blockStdWithAlts = LP.optimize({ outputs: { [IronIngot]: 30 }, allowedInputs: allRawX, objective: 'raw', allowAlternates: true, blockedRecipes: new Set([stdIngot]) });
check('F1: blocked standard recipe is never chosen', blockStdWithAlts.feasible && !blockStdWithAlts.recipes.some((s) => s.rc === stdIngot));

// F4: a building disabled = every one of its recipes blocked. Time Crystal is produced
// ONLY by the Converter, so blocking all Converter recipes makes it unbuildable.
const TimeCrystal = cls('Time Crystal');
const converterRecipes = Object.keys(DATA.recipes).filter((rc) => DATA.recipes[rc].building === 'Build_Converter_C');
check('fixture: >1 Converter recipe exists', converterRecipes.length > 1);
const tcBase = LP.optimize({ outputs: { [TimeCrystal]: 10 }, allowedInputs: allRawX, objective: 'machinesLP', allowAlternates: true });
check('control: Time Crystal feasible with Converter on', tcBase.feasible === true);
const tcBlocked = LP.optimize({ outputs: { [TimeCrystal]: 10 }, allowedInputs: allRawX, objective: 'machinesLP', allowAlternates: true, blockedRecipes: new Set(converterRecipes) });
check('F4: disabling the Converter (all its recipes) -> Time Crystal infeasible', tcBlocked.feasible === false);
// And no Converter recipe is used elsewhere once the building is off.
const ironViaConv = LP.optimize({ outputs: { [IronIngot]: 30 }, allowedInputs: allRawX, objective: 'raw', allowAlternates: true, blockedRecipes: new Set(converterRecipes) });
check('F4: no Converter recipe appears in any plan when building disabled', ironViaConv.feasible && !ironViaConv.recipes.some((s) => DATA.recipes[s.rc].building === 'Build_Converter_C'));

// maxThroughput honors the block too: max Iron Ingot from ore with the standard recipe
// blocked and alts off must report infeasible (no producer left).
const mtBlocked = LP.maxThroughput({ product: IronIngot, supply: { [IronOre]: 60 }, allowAlternates: false, blockedRecipes: new Set([stdIngot]) });
check('F4/F1: maxThroughput infeasible when sole producer blocked', mtBlocked.feasible === false);

// Sanity: blocking an irrelevant recipe leaves a plan unchanged & feasible.
const harmless = LP.optimize({ outputs: { [IronIngot]: 30 }, allowedInputs: allRawX, objective: 'raw', allowAlternates: false, blockedRecipes: new Set([altIngotFoundry]) });
check('blocking an unused recipe leaves the plan feasible', harmless.feasible && harmless.recipes.some((s) => s.rc === stdIngot));

// ---- factory-extract ----
console.log('\n### FACTORY-EXTRACT');
check('quatToYaw identity = 0', near(FE.quatToYaw({ x: 0, y: 0, z: 0, w: 1 }), 0));
check('quatToYaw 90deg about Z = pi/2', near(FE.quatToYaw({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 }), Math.PI / 2, 1e-6));
check('localToWorld yaw=0 translates', (() => { const p = FE.localToWorld({ x: 800, y: 0 }, { x: 100, y: 50 }, 0); return near(p.x, 900) && near(p.y, 50); })());
check('localToWorld yaw=90 rotates', (() => { const p = FE.localToWorld({ x: 800, y: 0 }, { x: 0, y: 0 }, Math.PI / 2); return near(p.x, 0, 1e-6) && near(p.y, 800, 1e-6); })());
check('kindOfClass belt', FE.kindOfClass('Build_ConveyorBeltMk3_C') === 'belt');
check('kindOfClass lift = belt', FE.kindOfClass('Build_ConveyorLiftMk2_C') === 'belt');
check('kindOfClass pipe', FE.kindOfClass('Build_Pipeline_C') === 'pipe');
check('kindOfClass wire', FE.kindOfClass('Build_PowerLine_C') === 'wire');
check('kindOfClass machine', FE.kindOfClass('Build_ConstructorMk1_C') === 'machine');
check('classFromTypePath stem', FE.classFromTypePath('/Game/X/Build_ConstructorMk1.Build_ConstructorMk1_C') === 'Build_ConstructorMk1_C');

const save = { levels: { Persistent: { objects: [
  { typePath: '/Game/X/Build_ConstructorMk1.Build_ConstructorMk1_C',
    transform: { translation: { x: 100, y: 200, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale3d: { x: 1, y: 1, z: 1 } },
    properties: { mCurrentPotential: { value: 1.5 }, mCurrentProductionBoost: { value: 0 } } },
  { typePath: '/Game/X/Build_ConveyorBeltMk1.Build_ConveyorBeltMk1_C',
    transform: { translation: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } },
    properties: { mSplineData: { values: [ { properties: { Location: { value: { x: 0, y: 0, z: 0 } } } }, { properties: { Location: { value: { x: 800, y: 0, z: 0 } } } } ] } } },
  { typePath: '/Game/X/Foo.Foo_C', transform: { translation: { x: 0, y: 0, z: 0 } } }, // not Build_ -> skip
  { typePath: '/Game/X/Build_Bar.Build_Bar_C' }, // no transform -> skip
] } } };
const blds = FE.extractBuildings(save);
check('extractBuildings keeps only placed Build_ actors', blds.length === 2);
const mac = blds.find((b) => b.kind === 'machine');
check('machine extracted with position', !!mac && mac.x === 100 && mac.y === 200);
check('machine overclock read', !!mac && near(mac.overclock, 1.5));
const belt = blds.find((b) => b.kind === 'belt');
check('belt has a >=2 point world path', !!belt && Array.isArray(belt.path) && belt.path.length === 2);
check('belt spline unwrapped to world X', !!belt && near(belt.path[1].x, 800));
const sum = FE.summarize(blds);
check('summarize totals', sum.total === 2 && sum.byKind.machine === 1 && sum.byKind.belt === 1);

// Lightweight (instanced) buildables — foundations/walls modern saves pack into
// FGLightweightBuildableSubsystem instead of per-actor objects.
const lwSave = { levels: { Persistent: { objects: [
  { typePath: '/Script/FactoryGame.FGLightweightBuildableSubsystem',
    specialProperties: { buildables: [
      { typeReference: { pathName: '/Game/X/Build_Foundation_8x4_01.Build_Foundation_8x4_01_C' },
        instances: [
          { transform: { translation: { x: 10, y: 20, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale3d: { x: 1, y: 1, z: 1 } }, usedSwatchSlot: { pathName: '/Game/X/SwatchDesc_Slot3.SwatchDesc_Slot3_C' } },
          { transform: { translation: { x: 30, y: 40, z: 0 } } },
        ] } ] } } ] } } };
const lw = [];
FE.extractLightweight(lwSave, lw);
check('extractLightweight reads instanced buildables', lw.length === 2);
check('lightweight record is a machine footprint', lw[0].kind === 'machine' && lw[0].lightweight === true);
check('lightweight class + swatch parsed', lw[0].className === 'Build_Foundation_8x4_01_C' && lw[0].swatch === 'SwatchDesc_Slot3_C');
check('extractBuildings includes lightweight pass', FE.extractBuildings(lwSave).length === 2);

// Dismantled lightweight buildables linger in the instance array as orphans with
// builtBy.playerInfoTableIndex === -1. They must be skipped so removed buildings
// don't show on the overlay; live (>=0) and builtBy-less instances are kept.
const orphanSave = { levels: { Persistent: { objects: [
  { typePath: '/Script/FactoryGame.FGLightweightBuildableSubsystem',
    specialProperties: { buildables: [
      { typeReference: { pathName: '/Game/X/Build_Foundation_8x4_01.Build_Foundation_8x4_01_C' },
        instances: [
          { transform: { translation: { x: 1, y: 2, z: 0 } }, builtBy: { playerInfoTableIndex: 0 } },   // live
          { transform: { translation: { x: 3, y: 4, z: 0 } }, builtBy: { playerInfoTableIndex: -1 } },  // dismantled orphan
          { transform: { translation: { x: 5, y: 6, z: 0 } } },                                          // no builtBy -> keep
        ] } ] } } ] } } };
const olw = [];
const ostats = { orphans: 0 };
FE.extractLightweight(orphanSave, olw, ostats);
check('orphaned (-1) lightweight instance skipped', olw.length === 2);
check('orphan skip counted in stats', ostats.orphans === 1);
const ob = FE.extractBuildings(orphanSave);
check('extractBuildings drops orphans + reports orphansHidden', ob.length === 2 && ob.orphansHidden === 1);

// ---- collectables (uncollected pickups) ----
const collSave = { levels: { Persistent: { objects: [
  { typePath: '/Game/FactoryGame/Resource/Environment/Crystal/BP_Crystal.BP_Crystal_C', transform: { translation: { x: 1, y: 2, z: 3 } } },
  { typePath: '/Game/FactoryGame/Resource/Environment/Crystal/BP_Crystal_mk2.BP_Crystal_mk2_C', transform: { translation: { x: 4, y: 5, z: 6 } } },
  { typePath: '/Game/FactoryGame/Resource/Environment/Crystal/BP_Crystal_mk3.BP_Crystal_mk3_C', transform: { translation: { x: 7, y: 8, z: 9 } } },
  { typePath: '/Game/FactoryGame/Prototype/WAT/BP_WAT1.BP_WAT1_C', transform: { translation: { x: 10, y: 11, z: 12 } } },
  { typePath: '/Game/FactoryGame/Prototype/WAT/BP_WAT2.BP_WAT2_C', transform: { translation: { x: 13, y: 14, z: 15 } } },
  { typePath: '/Game/FactoryGame/World/Benefit/DropPod/BP_DropPod.BP_DropPod_C', transform: { translation: { x: 16, y: 17, z: 18 } } }, // unopened -> kept
  { typePath: '/Game/FactoryGame/World/Benefit/DropPod/BP_DropPod.BP_DropPod_C', transform: { translation: { x: 19, y: 20, z: 21 } }, properties: { mHasBeenOpened: { value: true } } }, // looted -> skip
  { typePath: '/Game/FactoryGame/Prototype/WAT/BP_MercerShrine.BP_MercerShrine_C', transform: { translation: { x: 0, y: 0, z: 0 } } }, // shrine (not the sphere) -> skip
  { typePath: '/Game/FactoryGame/World/Benefit/DropPod/BP_DropPod.BP_DropPod_C' }, // no transform -> skip
] } } };
const coll = FE.extractCollectables(collSave);
check('extractCollectables maps 6 kinds, skips looted/unknown/no-transform', coll.length === 6);
check('slug tiers distinguished', coll.filter((c) => c.kind === 'slugBlue').length === 1 && coll.filter((c) => c.kind === 'slugYellow').length === 1 && coll.filter((c) => c.kind === 'slugPurple').length === 1);
check('somersloop + mercer sphere mapped', coll.some((c) => c.kind === 'somersloop') && coll.some((c) => c.kind === 'mercerSphere'));
check('unopened crash site kept, looted one skipped', coll.filter((c) => c.kind === 'crashSite').length === 1);
check('collectable carries world position', (() => { const b = coll.find((c) => c.kind === 'slugBlue'); return b && b.x === 1 && b.y === 2 && b.z === 3; })());
const cc = FE.summarizeCollectables(coll);
check('summarizeCollectables counts by kind', cc.slugBlue === 1 && cc.crashSite === 1 && cc.mercerSphere === 1 && cc.somersloop === 1);

// ---- building-meta ----
console.log('\n### BUILDING-META');
check('constructor = production', BM.buildingMeta('Build_ConstructorMk1_C').category === 'production');
check('belt = logistics', BM.buildingMeta('Build_ConveyorBeltMk1_C').category === 'logistics');
check('miner = extraction', BM.categoryOf('Build_MinerMk1_C') === 'extraction');
check('power line = power', BM.buildingMeta('Build_PowerLine_C').category === 'power');
check('foundation = foundation', BM.categoryOf('Build_Foundation_8x4_01_C') === 'foundation');
check('buildingMeta always returns a footprint+color', (() => { const m = BM.buildingMeta('Build_TotallyUnknownThing_C'); return m && m.w > 0 && m.d > 0 && /^#/.test(m.color); })());
check('typePath form resolves via stem', BM.buildingMeta('/Game/X/Build_AssemblerMk1.Build_AssemblerMk1_C').category === 'production');

// ---- production X-ray (whole-base analysis from a save) ----
console.log('\n### PRODUCTION X-RAY');
const PX = require('../src/production-xray');
const recPath = (rc) => 'x.' + rc; // recipeClassOf takes the stem after the last '.'
const stdIngotR = DATA.recipes['Recipe_IngotIron_C'];
// Synthetic base: two Iron Plate constructors (one plain, one 200% + Somerslooped), one
// idle constructor, one Iron Ingot smelter, and a Mk2 miner on a Pure Iron Ore node.
const xSave = { levels: { Persistent: { objects: [
  // M1: Constructor -> Iron Plate, 100% clock, no Somersloop
  { typePath: 'g.Build_ConstructorMk1_C', transform: { translation: { x: 0, y: 0, z: 0 } },
    properties: { mCurrentRecipe: { value: { pathName: recPath('Recipe_IronPlate_C') } }, mCurrentPotential: { value: 1 } } },
  // M2: Constructor -> Iron Plate, 200% clock, Somersloop output x2 (boost stores the multiplier)
  { typePath: 'g.Build_ConstructorMk1_C', transform: { translation: { x: 1000, y: 0, z: 0 } },
    properties: { mCurrentRecipe: { value: { pathName: recPath('Recipe_IronPlate_C') } }, mCurrentPotential: { value: 2 }, mCurrentProductionBoost: { value: 2 } } },
  // M3: Constructor with no recipe -> idle
  { typePath: 'g.Build_ConstructorMk1_C', transform: { translation: { x: 2000, y: 0, z: 0 } }, properties: {} },
  // Smelter -> Iron Ingot, 100%
  { typePath: 'g.Build_SmelterMk1_C', transform: { translation: { x: 0, y: 1000, z: 0 } },
    properties: { mCurrentRecipe: { value: { pathName: recPath('Recipe_IngotIron_C') } } } },
  // Miner Mk2 on a Pure Iron Ore node (resolved via mExtractableResource -> the node's overrides)
  { typePath: 'g.Build_MinerMk2_C', transform: { translation: { x: 50000, y: 50000, z: 0 } },
    properties: { mExtractableResource: { value: { pathName: 'NODE1' } } } },
  { typePath: 'g.BP_ResourceNode_C', instanceName: 'NODE1',
    properties: { mPurityOverride: { value: { value: 'RP_Pure' } }, mResourceClassOverride: { value: { pathName: 'x.' + IronOre } } } },
] } } };
const xr = PX.computeProduction(xSave, DATA);
check('xray: counts every manufacturing building (incl idle)', xr.stats.totalMachines === 4);
check('xray: idle machine (no recipe) detected', xr.stats.idle === 1);
check('xray: configured machine count', xr.stats.configured === 3);
check('xray: overclocked machine counted (M2 @200%)', xr.stats.overclocked === 1 && xr.stats.underclocked === 0);
check('xray: Somerslooped machine counted', xr.stats.somersloop === 1);
check('xray: physical Somersloops derived from the output multiplier', xr.stats.sloopsInstalled === 1); // amp 2 on a 1-slot Constructor = 1 sloop
const xrPlate = xr.items.find((it) => it.item === IronPlate);
// M1 makes 2*(60/6)=20/min; M2 makes 20 * clock2 * amp2 = 80/min; total 100, none consumed.
check('xray: Iron Plate produced (clock + Somersloop amplify output)', !!xrPlate && near(xrPlate.produced, 100, 0.01));
check('xray: Iron Plate net is a surplus', !!xrPlate && near(xrPlate.net, 100, 0.01));
const xrIngot = xr.items.find((it) => it.item === IronIngot);
// Ingot consumed by the two plate machines: M1 3*(10)=30, M2 30*clock2=60 (Somersloop does NOT raise input). Total 90.
check('xray: Iron Ingot consumed = inputs scale with clock, NOT Somersloop', !!xrIngot && near(xrIngot.consumed, 90, 0.01));
const smeltOut = stdIngotR.products[0].amount * (60 / stdIngotR.time); // smelter Iron Ingot /min @100%
check('xray: Iron Ingot produced by the smelter', !!xrIngot && near(xrIngot.produced, smeltOut, 0.01));
// Power: M1 = 4; M2 = 4 * 2^exp * 2^2 (Somersloop ~squares draw); idle adds 0.
const cExp = DATA.buildings['Build_ConstructorMk1_C'].exponent;
const m2Power = 4 * Math.pow(2, cExp) * Math.pow(2, 2);
check('xray: total manufacturing power (clock^exp x amp^2)', near(xr.stats.totalPower, 4 + m2Power + (stdIngotR ? DATA.buildings['Build_SmelterMk1_C'].power : 0), 0.05));
// Extraction: Mk2 miner (120/min base) on a Pure node (x2) at 100% = 240/min, resolved exactly.
const oreExt = xr.extraction.find((e) => e.item === IronOre);
check('xray: extraction resolves resource + purity from the node', !!oreExt && near(oreExt.rate, 240, 0.01) && oreExt.estimated === false);
const oreItem = xr.items.find((it) => it.item === IronOre);
check('xray: mined raw folded into its production total', !!oreItem && near(oreItem.extraction, 240, 0.01) && oreItem.produced >= 240);
// Clustering: the four manufacturing machines sit together (one factory); the remote miner
// is an extractor, not part of factory clusters.
check('xray: configured machines cluster into one nearby factory', xr.stats.factoryCount === 1 && xr.factories[0].count === 3);
check('xray: factory reports its top output', xr.factories[0].topOutputs.some((o) => o.item === IronPlate));
// Estimated-extraction caveat flips when a node can't be resolved (vanilla solid node).
const xSave2 = { levels: { Persistent: { objects: [
  { typePath: 'g.Build_MinerMk2_C', transform: { translation: { x: 0, y: 0, z: 0 } }, properties: {} }, // no node ref -> unknown solid resource
  { typePath: 'g.Build_WaterPump_C', transform: { translation: { x: 0, y: 0, z: 0 } }, properties: {} }, // pump knows its resource (Water) but not purity
] } } };
const xr2 = PX.computeProduction(xSave2, DATA);
check('xray: unresolved extractor flags the estimated caveat', xr2.caveats.estimatedExtraction === true);
check('xray: water pump still attributed to Water despite no node', xr2.extraction.some((e) => DATA.items[e.item] && DATA.items[e.item].name === 'Water'));
check('xray: a miner with no resolvable resource is not mis-attributed', !xr2.extraction.some((e) => e.item === 'undefined' || e.item == null));

// ---- Resource Well Pressurizer (Build_FrackingSmasher_C) ----
// The smasher is the POWERED well actor (~150 MW); its satellites
// (Build_FrackingExtractor_C, power 0) carry the extraction rates. The data layer must
// carry it so power accounting sees it, and the X-ray must count its draw without
// inventing extraction rates.
const Smasher = 'Build_FrackingSmasher_C';
const smDef = DATA.extractors[Smasher];
check('data: Resource Well Pressurizer present with power 150', !!smDef && near(smDef.power, 150, 1e-6));
check('data: Pressurizer extracts nothing itself (ratePerMin 0)', !!smDef && smDef.ratePerMin === 0);
check('data: well satellites still draw 0 MW', DATA.extractors['Build_FrackingExtractor_C'].power === 0);
const xSave3 = { levels: { P: { objects: [
  { typePath: 'g.Build_FrackingSmasher_C', transform: { translation: { x: 0, y: 0, z: 0 } }, properties: {} }, // 100%
  { typePath: 'g.Build_FrackingSmasher_C', transform: { translation: { x: 100, y: 0, z: 0 } }, properties: { mCurrentPotential: { value: 2 } } }, // 200% overclock
] } } };
const xr3 = PX.computeProduction(xSave3, DATA);
const smWant = smDef.power * (1 + Math.pow(2, smDef.exponent)); // 150 + 150Â·2^exp
check('xray: Pressurizer power counted (incl. clock^exp overclock)', near(xr3.stats.extractionPower, smWant, 0.01));
check('xray: Pressurizer attributes power only — no extraction rows', xr3.extraction.length === 0);
check('xray: Pressurizer alone does not flip the estimated caveat', xr3.caveats.estimatedExtraction === false);
check('xray: Pressurizers counted in extractorCount', xr3.stats.extractorCount === 2);

// ---- two-phase split + point-in-polygon + region scoping ----
console.log('\n### X-RAY REGION SCOPING');
// extractRecords (parse-once) then aggregate (cheap, region-aware). The composed
// computeProduction must equal aggregate(extractRecords(...)).
const recs = PX.extractRecords(xSave, DATA);
check('extractRecords emits a record per machine/extractor (idle included)', recs.filter((r) => r.k === 'm').length === 4 && recs.filter((r) => r.k === 'e').length === 1);
const agg = PX.aggregate(recs, DATA, {});
check('aggregate(extractRecords) == computeProduction', agg.stats.totalMachines === xr.stats.totalMachines && near(agg.stats.totalPower, xr.stats.totalPower, 1e-6));
// point-in-polygon: a unit square around the origin.
const sq = [{ x: -100, y: -100 }, { x: 100, y: -100 }, { x: 100, y: 100 }, { x: -100, y: 100 }];
check('pointInPolygon: inside', PX.pointInPolygon(0, 0, sq) === true);
check('pointInPolygon: outside', PX.pointInPolygon(500, 0, sq) === false);
check('pointInPolygon: <3 points = no region (always true)', PX.pointInPolygon(9e9, 9e9, [{ x: 0, y: 0 }]) === true);
// Region scoping: two plate constructors far apart; a box around only the first.
const twoSave = { levels: { L: { objects: [
  { typePath: 'g.Build_ConstructorMk1_C', transform: { translation: { x: 0, y: 0, z: 0 } }, properties: { mCurrentRecipe: { value: { pathName: recPath('Recipe_IronPlate_C') } }, mCurrentPotential: { value: 1 } } },
  { typePath: 'g.Build_ConstructorMk1_C', transform: { translation: { x: 100000, y: 0, z: 0 } }, properties: { mCurrentRecipe: { value: { pathName: recPath('Recipe_IronPlate_C') } }, mCurrentPotential: { value: 1 } } },
] } } };
const twoRecs = PX.extractRecords(twoSave, DATA);
const whole = PX.aggregate(twoRecs, DATA, {});
const box = [{ x: -5000, y: -5000 }, { x: 5000, y: -5000 }, { x: 5000, y: 5000 }, { x: -5000, y: 5000 }];
const scoped = PX.aggregate(twoRecs, DATA, { region: box });
check('region off: both constructors counted', whole.stats.totalMachines === 2 && near(whole.items.find((i) => i.item === IronPlate).produced, 40, 0.01));
check('region on: only the in-area constructor counted', scoped.stats.totalMachines === 1 && near(scoped.items.find((i) => i.item === IronPlate).produced, 20, 0.01));
check('region on: scope.regionUsed flagged', scoped.scope.regionUsed === true && whole.scope.regionUsed === false);

// ---- projects: migration + linked inputs + cycle detection (F3) ----
// These exercise renderer.js logic (load/migration, link resolution, cycle guard) via
// the window.__app test hook. Booted in jsdom so the renderer's DOM wiring runs; we
// then read the live module state through the hook's getters.
console.log('\n### PROJECTS (migration / links / cycles)');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
// Boot a fresh renderer instance with the given pre-seeded localStorage payload (or
// none). Returns the live window.__app hook. Each call gets its own JSDOM + module
// instance (the require cache is busted so module-level state resets).
function bootApp(seed) {
  const dom = new JSDOM(html, { url: 'https://local/', pretendToBeVisual: true });
  global.window = dom.window; global.document = dom.window.document;
  global.localStorage = dom.window.localStorage; global.location = dom.window.location;
  global.Event = dom.window.Event;
  dom.window.confirm = () => true; global.confirm = dom.window.confirm;
  dom.window.alert = () => {}; global.alert = dom.window.alert;
  if (!dom.window.SVGElement.prototype.setPointerCapture) dom.window.SVGElement.prototype.setPointerCapture = () => {};
  dom.window.localStorage.clear();
  if (seed != null) dom.window.localStorage.setItem('satisfactory-factory-plans-v1', seed);
  delete require.cache[require.resolve('../src/renderer.js')];
  require('../src/renderer.js');
  dom.window.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  return dom.window.__app;
}

// 1) Migration: an OLD payload (plans + activeId, NO projects) opens with one default
//    project that contains every plan, and each plan gets that project's id.
const oldPayload = JSON.stringify({
  plans: [
    { id: 'pA', name: 'Alpha', state: { mode: 'planner', targetItem: IronPlate, targetRate: 10 } },
    { id: 'pB', name: 'Beta', state: { mode: 'planner', targetItem: IronIngot, targetRate: 20 } },
  ],
  activeId: 'pB',
});
let app = bootApp(oldPayload);
check('migration: one default project synthesized', app.projects.length === 1);
check('migration: default project named "Project 1"', app.projects[0].name === 'Project 1');
check('migration: activeProjectId points at the default project', app.activeProjectId === app.projects[0].id);
check('migration: all old plans kept', app.plans.length === 2);
check('migration: every plan adopted into the default project', app.plans.every((p) => p.projectId === app.projects[0].id));
check('migration: activeId preserved', app.activeId === 'pB');

// 2) A plan that lacks projectId but a project list exists -> adopted into active project.
const orphanPayload = JSON.stringify({
  projects: [{ id: 'prjX', name: 'Existing' }],
  activeProjectId: 'prjX',
  plans: [{ id: 'pC', name: 'Gamma', state: { mode: 'planner' } }], // no projectId
  activeId: 'pC',
});
app = bootApp(orphanPayload);
check('orphan plan adopted into the active project', app.plans[0].projectId === 'prjX');
check('existing project preserved by name', app.projects.length === 1 && app.projects[0].name === 'Existing');

// 3) Fresh start (no payload) still yields one project + one plan.
app = bootApp(null);
check('fresh start: one project', app.projects.length === 1);
check('fresh start: one plan in it', app.activeProjectPlans().length === 1);
check('fresh start: that plan belongs to the project', app.plans[0].projectId === app.activeProjectId);

// 4) Linked cap resolves from a source plan's recorded net output. Plan A (active) is a
//    planner making 10 Iron Plate; record its output, then create plan B that links an
//    optimizer extra-input to A's Iron Plate and assert the resolved cap == A's output.
app = bootApp(null);
const planA = app.activePlan();
planA.state.netOutputs = { [IronPlate]: 30 }; // pretend A solved to 30/min Iron Plate
app.newPlan('B');                              // B is now active, in the same project
const planB = app.activePlan();
const linkedRow = { name: '', cap: '', fromPlanId: planA.id, fromItem: IronPlate };
planB.state.opt.extraInputs.push(linkedRow);
check('linked cap resolves to the source plan output (30)', app.resolveLinkedCap(linkedRow) === 30);
check('an unlinked row resolves to null (falls back to manual cap)', app.resolveLinkedCap({ name: 'x', cap: '5' }) === null);
// Source produces nothing of that item -> linked cap is 0 (not undefined/NaN).
planA.state.netOutputs = {};
check('linked cap is 0 when the source makes none of the item', app.resolveLinkedCap(linkedRow) === 0);

// 5) Cycle detection. B already links to A (consumer B -> source A). Linking A to B
//    would close the loop and must be refused; linking A to an unrelated plan is fine.
app = bootApp(null);
const a = app.activePlan();
a.state.netOutputs = { [IronPlate]: 60 };
app.newPlan('B'); const b = app.activePlan();
b.state.netOutputs = { [IronIngot]: 60 };
b.state.opt.extraInputs.push({ name: '', cap: '', fromPlanId: a.id, fromItem: IronPlate }); // B <- A
check('self-link is a cycle', app.linkWouldCycle(a.id, a.id) === true);
check('A -> B would create a cycle (B already pulls from A)', app.linkWouldCycle(a.id, b.id) === true);
check('B -> A is fine (already the existing direction, no new cycle)', app.linkWouldCycle(b.id, a.id) === false);
app.newPlan('C'); const c = app.activePlan();
check('A -> C (unrelated) is not a cycle', app.linkWouldCycle(a.id, c.id) === false);

// 6) Project rollup nets out an internally-supplied item. A makes Iron Plate from ore;
//    B (max-throughput) is fed Iron Plate by A and makes Iron Rod. The project's raw
//    totals should include Iron Ore (A's raw) but NOT Iron Plate (supplied by A).
app = bootApp(null);
const ra = app.activePlan();
ra.state.mode = 'optimize';
ra.state.opt.outputs = [{ name: 'Iron Plate', rate: 30 }];
app.recomputePlanOutputs(ra);
check('rollup setup: A records Iron Plate output', (app.planNetOutputs(ra)[IronPlate] || 0) > 0);
app.newPlan('B'); const rb = app.activePlan();
rb.state.mode = 'max';
rb.state.max.product = cls('Iron Rod');
rb.state.max.supply = [{ item: IronPlate, amount: 0, fromPlanId: ra.id, fromItem: IronPlate }];
app.recomputePlanOutputs(rb);
const totals = app.computeProjectTotals();
check('rollup: total power summed across plans (> 0)', totals.totalPower > 0);
check('rollup: counts both plans', totals.count === 2);
check('rollup: raw includes Iron Ore (A pulls it)', (totals.rawTotals[IronOre] || 0) > 0);
check('rollup: internally-supplied Iron Plate netted out of raw', !(totals.rawTotals[IronPlate] > 1e-4));

// ---- blank-boot self-heal ----
// A boot whose durable store was momentarily unreadable lands on the blank
// "Factory 1" fallback. healFromDiskIfRicher must adopt the real store once it
// reads back — and must refuse to fire once the user has started real work.
console.log('\n### BLANK-BOOT SELF-HEAL');
// bootApp() gives the renderer no window.api, so we wire a mutable mock around it:
// the renderer captures `api` at module load, hence the mock must exist pre-require.
function bootAppWithApi(fileStore) {
  const dom = new JSDOM(html, { url: 'https://local/', pretendToBeVisual: true });
  const mock = { current: fileStore };
  dom.window.api = {
    loadPlans: () => mock.current,
    savePlans: () => {},
    savePlansSync: () => true,
  };
  global.window = dom.window; global.document = dom.window.document;
  global.localStorage = dom.window.localStorage; global.location = dom.window.location;
  global.Event = dom.window.Event;
  dom.window.confirm = () => true; global.confirm = dom.window.confirm;
  dom.window.alert = () => {}; global.alert = dom.window.alert;
  if (!dom.window.SVGElement.prototype.setPointerCapture) dom.window.SVGElement.prototype.setPointerCapture = () => {};
  dom.window.localStorage.clear();
  delete require.cache[require.resolve('../src/renderer.js')];
  require('../src/renderer.js');
  dom.window.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  return { app: dom.window.__app, mock, dom };
}
const richStore = JSON.stringify({
  projects: [{ id: 'prjR', name: 'Real Project' }],
  activeProjectId: 'prjR',
  plans: [
    { id: 'pR1', name: 'Motors', projectId: 'prjR', state: { mode: 'planner', targetItem: IronPlate, targetRate: 10 } },
    { id: 'pR2', name: 'Aluminum', projectId: 'prjR', state: { mode: 'planner', targetItem: IronIngot, targetRate: 20 } },
  ],
  activeId: 'pR1',
  savedAt: 1000,
});
// 1) File unreadable at boot (null) -> blank fallback; file comes back -> heal adopts it.
let h = bootAppWithApi(null);
check('heal setup: boot with unreadable store lands on blank fallback', h.app.plans.length === 1 && h.app.untouchedBlankSession());
h.mock.current = richStore;
check('heal: adopts the disk store once it reads back', h.app.healFromDiskIfRicher() === true);
check('heal: all real plans present after adoption', h.app.plans.length === 2 && h.app.plans.map((p) => p.name).join() === 'Motors,Aluminum');
check('heal: real project adopted', h.app.projects.length === 1 && h.app.projects[0].name === 'Real Project');
check('heal: no longer a blank session afterwards', h.app.untouchedBlankSession() === false);
check('heal: second call is a no-op', h.app.healFromDiskIfRicher() === false);
// 2) User started real work in the blank session -> heal must refuse.
h = bootAppWithApi(null);
h.app.state.targetItem = IronPlate; // user picked a target in the fallback plan
h.mock.current = richStore;
check('heal: refuses once the session has real work', h.app.healFromDiskIfRicher() === false);
check('heal: user work untouched', h.app.plans.length === 1 && h.app.state.targetItem === IronPlate);
// 3) Disk store is itself just a blank fallback -> no pointless reload loop.
h = bootAppWithApi(null);
h.mock.current = JSON.stringify({ plans: [{ id: 'pX', name: 'Factory 1', state: {} }], activeId: 'pX', savedAt: 5 });
check('heal: ignores a blank-fallback disk store', h.app.healFromDiskIfRicher() === false);
// 4) Renamed blank plan counts as user work (name no longer matches the fallback pattern).
h = bootAppWithApi(null);
h.app.plans[0].name = 'My Base';
h.mock.current = richStore;
check('heal: a renamed plan blocks adoption', h.app.healFromDiskIfRicher() === false);

// ---- June 12 ghost shape: 2 projects + 1 blank plan, fresher savedAt ----
// A leveldb repair resurrected a days-old diverged store (2 projects, one blank
// "Factory 1", globals carrying real unlockedAlts). It must (a) lose to the real
// file at load() despite a fresher savedAt, and (b) when it boots alone (file
// unreadable), still count as an untouched-blank session so heal can adopt the
// real store when the file reads back.
const ghostStore = JSON.stringify({
  projects: [{ id: 'prjG1', name: 'Project 1' }, { id: 'prjG2', name: 'Project 2' }],
  activeProjectId: 'prjG1',
  plans: [{ id: 'pGhost', name: 'Factory 1', projectId: 'prjG2', state: { mode: 'optimize', targetItem: '', unlockedAlts: ['Recipe_Alternate_Coal_1_C'] } }],
  activeId: 'pGhost',
  savedAt: 9999999999999, // far fresher than the real store
});
// (a) Ghost in localStorage with FRESHER savedAt, real store in the file -> file wins.
{
  const dom = new JSDOM(html, { url: 'https://local/', pretendToBeVisual: true });
  dom.window.api = { loadPlans: () => richStore, savePlans: () => {}, savePlansSync: () => true };
  global.window = dom.window; global.document = dom.window.document;
  global.localStorage = dom.window.localStorage; global.location = dom.window.location;
  global.Event = dom.window.Event;
  dom.window.confirm = () => true; global.confirm = dom.window.confirm;
  dom.window.alert = () => {}; global.alert = dom.window.alert;
  if (!dom.window.SVGElement.prototype.setPointerCapture) dom.window.SVGElement.prototype.setPointerCapture = () => {};
  dom.window.localStorage.clear();
  dom.window.localStorage.setItem('satisfactory-factory-plans-v1', ghostStore);
  delete require.cache[require.resolve('../src/renderer.js')];
  require('../src/renderer.js');
  dom.window.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  const g = dom.window.__app;
  check('ghost: fresher 2-project blank store loses to the real file', g.plans.length === 2 && g.plans.map((p) => p.name).join() === 'Motors,Aluminum');
  check('ghost: blank ghost plan not merged in', !g.plans.some((p) => p.id === 'pGhost'));
}
// (b) Ghost boots ALONE (file null) -> still an untouched-blank session -> heals.
h = bootAppWithApi(null);
h.dom.window.localStorage.setItem('satisfactory-factory-plans-v1', ghostStore);
// re-boot the renderer against the ghost-seeded localStorage
{
  delete require.cache[require.resolve('../src/renderer.js')];
  global.window = h.dom.window; global.document = h.dom.window.document;
  global.localStorage = h.dom.window.localStorage; global.location = h.dom.window.location;
  require('../src/renderer.js');
  h.dom.window.dispatchEvent(new h.dom.window.Event('DOMContentLoaded'));
  const g = h.dom.window.__app;
  check('ghost alone: loads as the 2-project blank store', g.projects.length === 2 && g.plans.length === 1);
  check('ghost alone: still counts as an untouched blank session', g.untouchedBlankSession() === true);
  h.mock.current = richStore;
  check('ghost alone: heal adopts the real store over the ghost', g.healFromDiskIfRicher() === true && g.plans.length === 2 && g.plans[0].name === 'Motors');
}

console.log(`\n${fail === 0 ? '✅ ALL PASS' : 'âŒ ' + fail + ' FAILED'} (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
