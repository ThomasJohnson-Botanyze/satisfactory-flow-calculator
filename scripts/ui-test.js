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

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ ' + fail + ' FAILED'} (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
