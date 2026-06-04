const DATA = require('../src/data.json');
const { optimize, maxThroughput, planner } = require('../src/solver-lp');

const nm = (c) => (DATA.items[c] ? DATA.items[c].name : c);
const cls = (name) => Object.keys(DATA.items).find((k) => DATA.items[k].name === name);
const rname = (rc) => DATA.recipes[rc].name + (DATA.recipes[rc].alternate ? ' [ALT]' : '');

function showOpt(tag, r) {
  console.log(`\n=== ${tag} ===`);
  if (!r.feasible) return console.log('  INFEASIBLE');
  console.log(`  objective(${r.objective}) = ${r.objectiveValue.toFixed(2)} | power ${r.totalPower.toFixed(1)}MW | machines ${r.totalMachines}`);
  console.log('  recipes:');
  r.recipes.sort((a, b) => b.machines - a.machines).forEach((x) =>
    console.log(`    ${rname(x.rc).padEnd(34)} ${x.machines.toFixed(2)}x  ${x.buildingName}`));
  console.log('  raw:');
  r.raw.forEach((x) => console.log(`    ${nm(x.item).padEnd(18)} ${x.rate.toFixed(2)}/min`));
  console.log('  outputs:');
  r.outputs.forEach((x) => console.log(`    ${nm(x.item).padEnd(18)} ${x.rate.toFixed(2)}/min`));
}

const RIP = cls('Reinforced Iron Plate');
const IRON = cls('Iron Ore');
const COAL = cls('Coal');
const COPPER = cls('Copper Ore');
const OIL = cls('Crude Oil');
const WATER = cls('Water');

// 1. standard only vs alternates allowed, minimise ore
showOpt('RIP 60/min, iron ore only, MIN RAW, standard only',
  optimize({ outputs: { [RIP]: 60 }, allowedInputs: { [IRON]: Infinity }, objective: 'raw', allowAlternates: false }));
showOpt('RIP 60/min, iron ore only, MIN RAW, alternates ON',
  optimize({ outputs: { [RIP]: 60 }, allowedInputs: { [IRON]: Infinity }, objective: 'raw', allowAlternates: true }));
showOpt('RIP 60/min, iron ore only, MIN POWER, alternates ON',
  optimize({ outputs: { [RIP]: 60 }, allowedInputs: { [IRON]: Infinity }, objective: 'power', allowAlternates: true }));

// 2. infeasible: RIP from copper only
showOpt('RIP 60/min, COPPER only (should be infeasible)',
  optimize({ outputs: { [RIP]: 60 }, allowedInputs: { [COPPER]: Infinity }, objective: 'raw', allowAlternates: true }));

// 3. max throughput: 120 iron ore -> max RIP, binding should be iron ore
const m1 = maxThroughput({ product: RIP, supply: { [IRON]: 120 }, allowAlternates: false });
console.log('\n=== MAX RIP from 120 iron ore (standard) ===');
if (m1.feasible) {
  console.log('  max output', m1.maxOutput.toFixed(2), '/min | machines', m1.totalMachines, '| power', m1.totalPower.toFixed(1), 'MW');
  m1.utilization.forEach((u) => console.log(`    ${nm(u.item)}: ${u.used.toFixed(1)}/${u.avail} (${(u.pct * 100).toFixed(0)}%)`));
  console.log('  binding:', m1.binding.map(nm).join(', '));
}
const m2 = maxThroughput({ product: RIP, supply: { [IRON]: 120 }, allowAlternates: true });
console.log('  [alternates ON] max output', m2.feasible ? m2.maxOutput.toFixed(2) : 'infeasible', '/min');

// 4. max throughput with two inputs (steel needs iron + coal)
const STEEL = cls('Steel Ingot');
const m3 = maxThroughput({ product: STEEL, supply: { [IRON]: 120, [COAL]: 40 }, allowAlternates: false });
console.log('\n=== MAX Steel Ingot from 120 iron + 40 coal (standard) ===');
if (m3.feasible) {
  console.log('  max output', m3.maxOutput.toFixed(2), '/min');
  m3.utilization.forEach((u) => console.log(`    ${nm(u.item)}: ${u.used.toFixed(1)}/${u.avail} (${(u.pct * 100).toFixed(0)}%)`));
  console.log('  binding (limiting factor):', m3.binding.map(nm).join(', '));
}

// 5. Planner balance — by-product crediting + recycle-loop resolution.
const rc = (name) => Object.keys(DATA.recipes).find((k) => DATA.recipes[k].name === name);
const HOR = cls('Heavy Oil Residue'), FUEL = cls('Fuel'), PLASTIC = cls('Plastic'), RUBBER = cls('Rubber');
let lpPass = 0, lpFail = 0;
const lpCheck = (label, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); cond ? lpPass++ : lpFail++; };

console.log('\n=== PLANNER: by-product credited (Residual Fuel fed by Plastic\'s Heavy Oil Residue) ===');
const credit = planner({ target: FUEL, rate: 40, recipes: [rc('Residual Fuel'), rc('Plastic')], rawItems: [OIL] });
lpCheck('feasible', credit.feasible);
lpCheck('Heavy Oil Residue net ≈ 0 (byproduct fully consumed, no dedicated source)', credit.feasible && Math.abs(credit.net[HOR] || 0) < 1e-6);
lpCheck('only crude oil is drawn raw', credit.feasible && credit.raw.length === 1 && credit.raw[0].item === OIL);

console.log('\n=== PLANNER: recycle loop resolves instead of being cut ===');
const loop = planner({ target: PLASTIC, rate: 60, recipes: [rc('Alternate: Recycled Plastic'), rc('Alternate: Recycled Rubber')], rawItems: [FUEL] });
lpCheck('loop is feasible (was cut + warned before)', loop.feasible);
lpCheck('both recycled recipes run with finite machines', loop.feasible && loop.recipes.length === 2 && loop.recipes.every((x) => isFinite(x.machines) && x.machines > 0));
lpCheck('net Plastic ≈ 60', loop.feasible && Math.abs((loop.net[PLASTIC] || 0) - 60) < 1e-6);

console.log('\n=== PLANNER: multiple desired outputs solved together ===');
const multi = planner({ targets: { [FUEL]: 40, [PLASTIC]: 30 }, recipes: [rc('Residual Fuel'), rc('Plastic')], rawItems: [OIL] });
lpCheck('feasible with two targets', multi.feasible);
lpCheck('both demands met (Fuel ≥ 40, Plastic ≥ 30)', multi.feasible && (multi.net[FUEL] || 0) >= 40 - 1e-6 && (multi.net[PLASTIC] || 0) >= 30 - 1e-6);

console.log(`\n${lpFail === 0 ? '✅ planner checks pass' : '❌ ' + lpFail + ' planner checks FAILED'} (${lpPass} passed)`);
process.exit(lpFail ? 1 : 0);
