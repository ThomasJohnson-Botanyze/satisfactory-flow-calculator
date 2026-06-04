const DATA = require('../src/data.json');
const { optimize, maxThroughput } = require('../src/solver-lp');

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
