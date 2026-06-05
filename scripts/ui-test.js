// Headless end-to-end test of renderer.js: 3 modes + flowchart + game multipliers + factory plans.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const DATA = require('../src/data.json');
const cls = (name) => Object.keys(DATA.items).find((k) => DATA.items[k].name === name);

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'https://local/', pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
global.location = dom.window.location;
global.Event = dom.window.Event;
dom.window.confirm = () => true;
global.confirm = () => true;
if (!dom.window.SVGElement.prototype.setPointerCapture) dom.window.SVGElement.prototype.setPointerCapture = () => {};
localStorage.clear();

require('../src/renderer.js');
dom.window.dispatchEvent(new dom.window.Event('DOMContentLoaded'));

const D = dom.window.document;
const fire = (n, t) => n.dispatchEvent(new dom.window.Event(t, { bubbles: true }));
const setVal = (n, v, t = 'input') => { n.value = v; fire(n, t); };
const click = (n) => n.dispatchEvent(new dom.window.Event('click', { bubbles: true }));
const tab = (m) => click([...D.querySelectorAll('.tab')].find((t) => t.dataset.mode === m));
const prodRows = () => [...D.querySelectorAll('#prodTable tbody tr')].length;
const planNames = () => [...D.querySelectorAll('#planTabs .plan-tab .plan-name')].map((s) => s.textContent);
const activePlanName = () => { const a = D.querySelector('#planTabs .plan-tab.active .plan-name'); return a ? a.textContent : '(none)'; };
let pass = 0, fail = 0;
const check = (label, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); cond ? pass++ : fail++; };

// ---- modes + flow + multipliers (regression) ----
console.log('### MODES / FLOW / MULTIPLIERS');
tab('planner');
setVal(D.getElementById('targetItem'), 'Reinforced Iron Plate');
setVal(D.getElementById('targetRate'), '10');
check('planner produces rows', prodRows() === 5);
check('planner raw = 120 ore', D.querySelector('#rawTable tbody tr td:last-child').textContent.trim() === '120');
click(D.getElementById('viewFlow'));
check('flow nodes built', D.querySelectorAll('#flowSvg .node').length === 7);
check('flow edges built', D.querySelectorAll('#flowSvg .edge-path').length === 7);

// drag persistence + reset
const node0 = D.querySelector('#flowSvg .node');
const md = (t, x, y) => node0.dispatchEvent(new dom.window.MouseEvent(t, { clientX: x, clientY: y, bubbles: true }));
md('pointerdown', 0, 0); md('pointermove', 120, 60); md('pointerup', 120, 60);
const draggedTransform = node0.getAttribute('transform');
const persisted = JSON.parse(localStorage.getItem('satisfactory-factory-plans-v1'));
const ap = persisted.plans.find((p) => p.id === persisted.activeId);
check('drag persisted a node position', !!ap.state.flowPos && Object.keys(ap.state.flowPos).length > 0);
click(D.getElementById('viewTables')); click(D.getElementById('viewFlow'));
check('position restored after re-render', D.querySelector('#flowSvg .node').getAttribute('transform') === draggedTransform);
click(D.getElementById('flowReset'));
const after = JSON.parse(localStorage.getItem('satisfactory-factory-plans-v1'));
const ap2 = after.plans.find((p) => p.id === after.activeId);
check('reset layout clears positions', !ap2.state.flowPos || Object.keys(ap2.state.flowPos).length === 0);
click(D.getElementById('viewTables'));
setVal(D.getElementById('mPower'), '5', 'change');
check('power x5 applied', D.getElementById('sumPower').textContent === '390 MW');
setVal(D.getElementById('mPower'), '1', 'change');

// ---- per-node overclock ----
console.log('\n### PER-NODE OVERCLOCK');
const mw = () => parseFloat(D.getElementById('sumPower').textContent);
const clockInputs = () => [...D.querySelectorAll('#prodTable tbody .clock-input')];
check('Clock column present', D.querySelectorAll('#prodTable thead th').length === 7);
check('every step has a clock input', clockInputs().length === prodRows());
const mwBefore = mw();
setVal(clockInputs()[0], '250', 'change');
check('overclock one step raises total power', mw() > mwBefore);
const ocStore = JSON.parse(localStorage.getItem('satisfactory-factory-plans-v1'));
const ocPlan = ocStore.plans.find((p) => p.id === ocStore.activeId);
check('per-node clock persisted', ocPlan.state.nodeClock && Object.keys(ocPlan.state.nodeClock).length === 1);
setVal(clockInputs()[0], '100', 'change'); // back to global → override cleared
const ocStore2 = JSON.parse(localStorage.getItem('satisfactory-factory-plans-v1'));
const ocPlan2 = ocStore2.plans.find((p) => p.id === ocStore2.activeId);
check('typing the global value clears the override', Object.keys(ocPlan2.state.nodeClock || {}).length === 0);
check('power restored after clearing override', mw() === mwBefore);

// ---- factory plans ----
console.log('\n### FACTORY PLANS');
check('starts with 1 plan', planNames().length === 1 && planNames()[0] === 'Factory 1');
check('plan1 holds RIP target', D.getElementById('targetItem').value === 'Reinforced Iron Plate');

// new plan -> blank
click(D.getElementById('planNew'));
check('2 plans after New', planNames().length === 2);
check('new plan is active', activePlanName() === 'Factory 2');
check('new plan blank target', D.getElementById('targetItem').value === '');
check('new plan empty output', !D.getElementById('empty').hidden);

// set a different target on plan 2
setVal(D.getElementById('targetItem'), 'Modular Frame');
setVal(D.getElementById('targetRate'), '5');
check('plan2 produces rows', prodRows() > 0);

// switch back to plan 1 -> restored
click([...D.querySelectorAll('#planTabs .plan-tab .plan-name')][0]);
check('switched to Factory 1', activePlanName() === 'Factory 1');
check('plan1 target restored', D.getElementById('targetItem').value === 'Reinforced Iron Plate');
check('plan1 rate restored', D.getElementById('targetRate').value === '10');

// switch to plan 2 -> its target
click([...D.querySelectorAll('#planTabs .plan-tab .plan-name')][1]);
check('plan2 target restored', D.getElementById('targetItem').value === 'Modular Frame');

// duplicate active (plan2)
click(D.getElementById('planDup'));
check('3 plans after Duplicate', planNames().length === 3);
check('dup name = "Modular Frame"? no, "Factory 2 copy"', activePlanName() === 'Factory 2 copy');
check('dup copies target', D.getElementById('targetItem').value === 'Modular Frame');

// rename active via dblclick
const activeLabel = D.querySelector('#planTabs .plan-tab.active .plan-name');
activeLabel.dispatchEvent(new dom.window.Event('dblclick', { bubbles: true }));
const renameInput = D.querySelector('#planTabs .plan-rename');
check('rename input shown', !!renameInput);
renameInput.value = 'Steel Line';
renameInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
check('renamed to Steel Line', activePlanName() === 'Steel Line');

// persistence
const stored = JSON.parse(localStorage.getItem('satisfactory-factory-plans-v1'));
check('persisted 3 plans', stored.plans.length === 3);
check('persisted names', JSON.stringify(stored.plans.map((p) => p.name)) === JSON.stringify(['Factory 1', 'Factory 2', 'Steel Line']));
check('persisted activeId valid', stored.plans.some((p) => p.id === stored.activeId));

// delete active
click(D.querySelector('#planTabs .plan-tab.active .plan-close'));
check('2 plans after delete', planNames().length === 2);

// reload simulation: new dom, same localStorage -> plans restored
const lsDump = localStorage.getItem('satisfactory-factory-plans-v1');
console.log('\n### RELOAD PERSISTENCE');
const dom2 = new JSDOM(html, { url: 'https://local/', pretendToBeVisual: true });
global.window = dom2.window; global.document = dom2.window.document; global.localStorage = dom2.window.localStorage;
global.location = dom2.window.location; global.Event = dom2.window.Event;
if (!dom2.window.SVGElement.prototype.setPointerCapture) dom2.window.SVGElement.prototype.setPointerCapture = () => {};
dom2.window.localStorage.setItem('satisfactory-factory-plans-v1', lsDump);
delete require.cache[require.resolve('../src/renderer.js')];
require('../src/renderer.js');
dom2.window.dispatchEvent(new dom2.window.Event('DOMContentLoaded'));
const names2 = [...dom2.window.document.querySelectorAll('#planTabs .plan-tab .plan-name')].map((s) => s.textContent);
check('reload restores 2 plans', names2.length === 2);
check('reload restores names', JSON.stringify(names2) === JSON.stringify(['Factory 1', 'Factory 2']));

// legacy v3 single-plan migration
console.log('\n### LEGACY v3 MIGRATION');
const dom3 = new JSDOM(html, { url: 'https://local/', pretendToBeVisual: true });
global.window = dom3.window; global.document = dom3.window.document; global.localStorage = dom3.window.localStorage;
global.location = dom3.window.location; global.Event = dom3.window.Event;
if (!dom3.window.SVGElement.prototype.setPointerCapture) dom3.window.SVGElement.prototype.setPointerCapture = () => {};
dom3.window.localStorage.setItem('satisfactory-flow-plan-v3', JSON.stringify({ mode: 'planner', targetItem: cls('Iron Plate'), targetRate: 42 }));
delete require.cache[require.resolve('../src/renderer.js')];
require('../src/renderer.js');
dom3.window.dispatchEvent(new dom3.window.Event('DOMContentLoaded'));
const d3 = dom3.window.document;
const names3 = [...d3.querySelectorAll('#planTabs .plan-tab .plan-name')].map((s) => s.textContent);
check('legacy -> 1 plan', names3.length === 1);
check('legacy target migrated', d3.getElementById('targetItem').value === 'Iron Plate');
check('legacy rate migrated', d3.getElementById('targetRate').value === '42');

// global settings (game-save unlocks + cost multipliers) carry across plans
console.log('\n### GLOBAL SETTINGS CARRY-OVER');
const dom4 = new JSDOM(html, { url: 'https://local/', pretendToBeVisual: true });
global.window = dom4.window; global.document = dom4.window.document; global.localStorage = dom4.window.localStorage;
global.location = dom4.window.location; global.Event = dom4.window.Event;
if (!dom4.window.SVGElement.prototype.setPointerCapture) dom4.window.SVGElement.prototype.setPointerCapture = () => {};
dom4.window.localStorage.clear();
delete require.cache[require.resolve('../src/renderer.js')];
require('../src/renderer.js');
dom4.window.dispatchEvent(new dom4.window.Event('DOMContentLoaded'));
const d4 = dom4.window.document;
const fire4 = (n, t) => n.dispatchEvent(new dom4.window.Event(t, { bubbles: true }));
const setVal4 = (n, v, t = 'input') => { n.value = v; fire4(n, t); };
const click4 = (n) => n.dispatchEvent(new dom4.window.Event('click', { bubbles: true }));
// Factory 1: choose non-default cost multipliers
setVal4(d4.getElementById('mRecipe'), '2', 'change');
setVal4(d4.getElementById('mPower'), '5', 'change');
// New plan should inherit them
click4(d4.getElementById('planNew'));
check('new plan inherits recipe-cost multiplier', d4.getElementById('mRecipe').value === '2');
check('new plan inherits power multiplier', d4.getElementById('mPower').value === '5');
// Change on plan 2, switch back to plan 1 → shared value followed
setVal4(d4.getElementById('mPower'), '2', 'change');
click4([...d4.querySelectorAll('#planTabs .plan-tab .plan-name')][0]);
check('cost-multiplier change shared back to plan 1', d4.getElementById('mPower').value === '2');
const g4 = JSON.parse(dom4.window.localStorage.getItem('satisfactory-factory-plans-v1')).globals;
check('globals snapshot persisted', !!g4 && g4.powerMult === 2 && g4.recipeCost === 2);
check('globals include save-unlock keys', !!g4 && 'unlockedAlts' in g4 && 'saveName' in g4);

// planner multiple desired outputs (parity with the optimizer)
console.log('\n### PLANNER MULTI-OUTPUT');
const dom5 = new JSDOM(html, { url: 'https://local/', pretendToBeVisual: true });
global.window = dom5.window; global.document = dom5.window.document; global.localStorage = dom5.window.localStorage;
global.location = dom5.window.location; global.Event = dom5.window.Event;
if (!dom5.window.SVGElement.prototype.setPointerCapture) dom5.window.SVGElement.prototype.setPointerCapture = () => {};
dom5.window.localStorage.clear();
delete require.cache[require.resolve('../src/renderer.js')];
require('../src/renderer.js');
dom5.window.dispatchEvent(new dom5.window.Event('DOMContentLoaded'));
const d5 = dom5.window.document;
const fire5 = (n, t) => n.dispatchEvent(new dom5.window.Event(t, { bubbles: true }));
const setVal5 = (n, v, t = 'input') => { n.value = v; fire5(n, t); };
const click5 = (n) => n.dispatchEvent(new dom5.window.Event('click', { bubbles: true }));
const rows5 = () => d5.querySelectorAll('#prodTable tbody tr').length;
const itemTexts5 = () => [...d5.querySelectorAll('#prodTable tbody tr td:first-child')].map((td) => td.textContent);
click5([...d5.querySelectorAll('.tab')].find((t) => t.dataset.mode === 'planner'));
setVal5(d5.getElementById('targetItem'), 'Iron Plate'); setVal5(d5.getElementById('targetRate'), '30');
const baseRows5 = rows5();
check('single target excludes Iron Rod', baseRows5 > 0 && !itemTexts5().some((t) => /Iron Rod/.test(t)));
click5(d5.getElementById('plannerAddOutput'));
const exName = d5.querySelector('#plannerExtra .row .row-item');
const exRate = d5.querySelector('#plannerExtra .row .row-rate');
check('add output creates an extra row', !!exName && !!exRate);
setVal5(exName, 'Iron Rod'); setVal5(exRate, '30');
check('second output adds production rows', rows5() > baseRows5);
check('second output (Iron Rod) is produced', itemTexts5().some((t) => /Iron Rod/.test(t)));
const ps5 = JSON.parse(dom5.window.localStorage.getItem('satisfactory-factory-plans-v1'));
const pp5 = ps5.plans.find((p) => p.id === ps5.activeId);
check('extra target persisted', pp5.state.extraTargets && pp5.state.extraTargets.length === 1);
click5(d5.getElementById('viewFlow'));
check('flow has 2 output nodes (one per desired output)', d5.querySelectorAll('#flowSvg .node.out').length === 2);
click5(d5.getElementById('viewTables'));
click5(d5.querySelector('#plannerExtra .row .row-rm'));
check('removing extra reverts to single-target rows', rows5() === baseRows5);
check('Iron Rod gone after removing extra', !itemTexts5().some((t) => /Iron Rod/.test(t)));

// Optimizer by-product edges: a recipe that eats another recipe's *by-product*
// (Petroleum Coke consumes the Heavy Oil Residue that standard Plastic emits) must
// render with a real input edge — not as an orphan machine node while the by-product
// floats up as a phantom output. Regression guard for the by-product producer fix.
console.log('\n### OPTIMIZER BY-PRODUCT EDGES');
const cls6 = (name) => Object.keys(DATA.items).find((k) => DATA.items[k].name === name);
const primStd6 = (item) => Object.keys(DATA.recipes).find((rc) => !DATA.recipes[rc].alternate && DATA.recipes[rc].products[0].item === item);
const dom6 = new JSDOM(html, { url: 'https://local/', pretendToBeVisual: true });
global.window = dom6.window; global.document = dom6.window.document; global.localStorage = dom6.window.localStorage;
global.location = dom6.window.location; global.Event = dom6.window.Event;
if (!dom6.window.SVGElement.prototype.setPointerCapture) dom6.window.SVGElement.prototype.setPointerCapture = () => {};
dom6.window.localStorage.clear();
delete require.cache[require.resolve('../src/renderer.js')];
require('../src/renderer.js');
dom6.window.dispatchEvent(new dom6.window.Event('DOMContentLoaded'));
const d6 = dom6.window.document;
const fire6 = (n, t) => n.dispatchEvent(new dom6.window.Event(t, { bubbles: true }));
const setVal6 = (n, v, t = 'input') => { n.value = v; fire6(n, t); };
const click6 = (n) => n.dispatchEvent(new dom6.window.Event('click', { bubbles: true }));
click6([...d6.querySelectorAll('.tab')].find((t) => t.dataset.mode === 'optimize'));
const alts6 = d6.getElementById('optAlts'); if (alts6.checked) { alts6.checked = false; fire6(alts6, 'change'); } // off → HOR only via Plastic by-product
setVal6(d6.getElementById('optObjective'), 'machines', 'change'); // sink (0 machines) beats burning, so HOR -> Coke -> Sink deterministically
const row0 = d6.querySelector('#optOutputs .row');
setVal6(row0.querySelector('.row-item'), 'Plastic'); setVal6(row0.querySelector('.row-rate'), '120');
click6(d6.getElementById('viewFlow'));
const flow6 = dom6.window.__lastFlow;
check('optimizer flow built', !!flow6 && flow6.nodes.length > 0);
const cokeNode = flow6 && flow6.nodes.find((n) => n.id === 'mac|' + primStd6(cls6('Petroleum Coke')));
check('Petroleum Coke node present', !!cokeNode);
check('Petroleum Coke fed from the Heavy Oil Residue by-product (not orphaned)', !!cokeNode && cokeNode.ins.length > 0);
const orphans6 = (flow6 ? flow6.nodes : []).filter((n) => {
  const r = n.kind === 'machine' && DATA.recipes[n.id.slice(4)];
  return r && r.ingredients.length > 0 && n.ins.length === 0;
});
check('no orphan machine nodes (every recipe with inputs has an edge)', orphans6.length === 0);
// By-product sinking (on by default): the surplus Heavy Oil Residue is turned into extra
// Petroleum Coke and routed to the Awesome Sink, drawn as a fed sink node — and crucially
// no fluid is left floating as a green output (which in-game would back up and stall).
check('by-product sink toggle present and on by default', !!d6.getElementById('optSink') && d6.getElementById('optSink').checked === true);
const sinkNodes6 = (flow6 ? flow6.nodes : []).filter((n) => n.kind === 'sink');
check('flow shows a fed Awesome Sink node for the disposed by-product', sinkNodes6.length > 0 && sinkNodes6.every((n) => n.ins.length > 0));
check('no fluid by-product floats as a green output node', !(flow6 ? flow6.nodes : []).some((n) => n.kind === 'out' && DATA.items[n.id.slice(4)] && DATA.items[n.id.slice(4)].liquid));

// Package <-> Unpackage loop: the planner used to auto-pick "Unpackage Turbofuel" as the
// default way to PRODUCE Turbofuel (it's the only non-unpackage standard primary recipe),
// closing a Turbofuel <-> Packaged Turbofuel loop the LP can't source — which surfaced as
// an "infinite loop between the fuel and packaged fuel recipes". Default selection now
// skips unpackage recipes and prefers a primary producer, so the chain resolves cleanly.
console.log('\n### PACKAGE/UNPACKAGE LOOP');
const dom7 = new JSDOM(html, { url: 'https://local/', pretendToBeVisual: true });
global.window = dom7.window; global.document = dom7.window.document; global.localStorage = dom7.window.localStorage;
global.location = dom7.window.location; global.Event = dom7.window.Event;
if (!dom7.window.SVGElement.prototype.setPointerCapture) dom7.window.SVGElement.prototype.setPointerCapture = () => {};
dom7.window.localStorage.clear();
delete require.cache[require.resolve('../src/renderer.js')];
require('../src/renderer.js');
dom7.window.dispatchEvent(new dom7.window.Event('DOMContentLoaded'));
const d7 = dom7.window.document;
const fire7 = (n, t) => n.dispatchEvent(new dom7.window.Event(t, { bubbles: true }));
const setVal7 = (n, v, t = 'input') => { n.value = v; fire7(n, t); };
const click7 = (n) => n.dispatchEvent(new dom7.window.Event('click', { bubbles: true }));
click7([...d7.querySelectorAll('.tab')].find((t) => t.dataset.mode === 'planner'));
setVal7(d7.getElementById('targetItem'), 'Turbofuel'); setVal7(d7.getElementById('targetRate'), '60');
const rows7 = d7.querySelectorAll('#prodTable tbody tr').length;
check('planner makes Turbofuel feasible (not the no-plan empty state)', rows7 > 0 && d7.getElementById('empty').hidden === true);
click7(d7.getElementById('viewFlow'));
const flow7 = dom7.window.__lastFlow;
const machineRcs = (flow7 ? flow7.nodes : []).filter((n) => n.kind === 'machine').map((n) => n.id.slice(4));
check('no Unpackage recipe auto-selected as a producer', !machineRcs.some((rc) => /unpackage/i.test(rc)));
check('no Turbofuel<->Packaged Turbofuel cycle (package + unpackage both present)',
  !(machineRcs.includes('Recipe_PackagedTurboFuel_C') && machineRcs.includes('Recipe_UnpackageTurboFuel_C')));
// Layout spreads the chain across columns by depth instead of stacking everything in
// column 0 — the regression that made complex factories pile up sky-high. Turbofuel's
// chain (raw -> Compacted Coal / Fuel -> Turbofuel -> output) is at least 4 deep.
const cols7 = new Set((flow7 ? flow7.nodes : []).map((n) => Math.round(n.x)));
check('flow layout spreads across multiple columns (not a single tall stack)', cols7.size >= 4);

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ ' + fail + ' FAILED'} (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
