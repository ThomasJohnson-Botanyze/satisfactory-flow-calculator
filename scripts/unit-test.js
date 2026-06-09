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

// Optimize: make 30 Iron Ingot/min from ore, minimize raw, alts off.
const opt = LP.optimize({ outputs: { [IronIngot]: 30 }, allowedInputs: { [IronOre]: Infinity }, objective: 'raw', allowAlternates: false });
check('optimize feasible', opt.feasible === true);
check('optimize uses ~30 raw ore', near(opt.objectiveValue, 30, 0.5));
const oreRaw = opt.raw.find((r) => r.item === IronOre);
check('raw list reports iron ore', !!oreRaw && near(oreRaw.rate, 30, 0.5));
check('no alternates chosen (alts off)', opt.recipes.every((r) => !DATA.recipes[r.rc].alternate));

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

// Infeasible: ask for a product with no allowed inputs.
const bad = LP.optimize({ outputs: { [IronIngot]: 30 }, allowedInputs: {}, objective: 'raw', allowAlternates: false });
check('optimize infeasible with no inputs', bad.feasible === false);

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
const sinkOn = LP.optimize({ outputs: { [Plastic]: 120 }, allowedInputs: allRaw, objective: 'machines', allowAlternates: false, sinkByproducts: true });
check('sink on: feasible', sinkOn.feasible === true);
check('sink on: Heavy Oil Residue fully consumed (net ~0)', near(sinkOn.net[HOR] || 0, 0, 1e-4));
check('sink on: no fluid left as surplus', !sinkOn.outputs.some((o) => DATA.items[o.item] && DATA.items[o.item].liquid));
check('sink on: Petroleum Coke routed to the Awesome Sink', (sinkOn.sunk || []).some((s) => s.item === Coke && s.rate > 0));
check('sink on: sink points reported', (sinkOn.sunk || []).every((s) => s.points > 0));

// Legacy behaviour (toggle off): the by-product is allowed to float as surplus.
const sinkOff = LP.optimize({ outputs: { [Plastic]: 120 }, allowedInputs: allRaw, objective: 'machines', allowAlternates: false, sinkByproducts: false });
check('sink off: Heavy Oil Residue floats as surplus', sinkOff.outputs.some((o) => o.item === HOR && o.rate > 0));
check('sink off: nothing sunk', (sinkOff.sunk || []).length === 0);

// With alternates on, the solver can do better than sinking: close the loop by feeding
// HOR back through Diluted Fuel / Recycled Plastic so only the desired output remains.
const loop = LP.optimize({ outputs: { [Plastic]: 120 }, allowedInputs: allRaw, objective: 'machines', allowAlternates: true, sinkByproducts: true });
check('alts + sink: feasible', loop.feasible === true);
check('alts + sink: no by-product surplus at all', loop.feasible && !loop.outputs.some((o) => o.item !== Plastic));

// Generator data the disposal model relies on (Fuel-Powered Generator: 250 MW).
check('generators data present', !!(DATA.generators && DATA.generators.Build_GeneratorFuel_C));
check('Fuel Generator burns 20 Fuel/min', near(DATA.generators.Build_GeneratorFuel_C.fuels[Fuel], 20, 0.01));

// Package <-> Unpackage cycle: building from raw, the optimizer must never run an
// unpackage recipe — it would only pair with its package recipe to spin a pointless
// Water <-> Packaged Water loop instead of using a real Empty Canister recipe.
const PkgFuel = cls('Packaged Fuel'); // Desc_Fuel_C (legacy name — the *packaged* item)
const cyc = LP.optimize({ outputs: { [PkgFuel]: 60 }, allowedInputs: allRaw, objective: 'machines', allowAlternates: true, sinkByproducts: true });
check('packaged-fuel plan feasible', cyc.feasible === true);
check('no unpackage recipe used when building from raw', !cyc.recipes.some((s) => /unpackage/i.test(s.rc)));
check('Empty Canister comes from a real producer (not an unpackage loop)', cyc.recipes.some((s) => DATA.recipes[s.rc].products.some((p) => p.item === cls('Empty Canister'))));
// ...but unpackaging IS allowed when the packaged item is supplied as a free input.
const supplied = LP.optimize({ outputs: { [cls('Fuel')]: 60 }, allowedInputs: Object.assign({ [PkgFuel]: Infinity }, allRaw), objective: 'machines', allowAlternates: true });
check('unpackage allowed when its packaged input is supplied', supplied.feasible && supplied.recipes.some((s) => /unpackage/i.test(s.rc)));

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
const tcBase = LP.optimize({ outputs: { [TimeCrystal]: 10 }, allowedInputs: allRawX, objective: 'machines', allowAlternates: true });
check('control: Time Crystal feasible with Converter on', tcBase.feasible === true);
const tcBlocked = LP.optimize({ outputs: { [TimeCrystal]: 10 }, allowedInputs: allRawX, objective: 'machines', allowAlternates: true, blockedRecipes: new Set(converterRecipes) });
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

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ ' + fail + ' FAILED'} (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
