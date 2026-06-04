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

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ ' + fail + ' FAILED'} (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
