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
