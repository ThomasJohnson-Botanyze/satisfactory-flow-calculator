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
check('Clock + Sloops columns present', D.querySelectorAll('#prodTable thead th').length === 8);
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

// ---- per-node somersloop ----
console.log('\n### PER-NODE SOMERSLOOP');
const sloopInputs = () => [...D.querySelectorAll('#prodTable tbody .sloop-input')];
check('every step has a sloop select', sloopInputs().length === prodRows());
check('sloop options run 0..max slots', sloopInputs().every((sel) => sel.options.length >= 2));
const slMwBefore = mw();
const firstSloop = sloopInputs()[0];
const maxOpt = firstSloop.options[firstSloop.options.length - 1].value; // fill all slots
setVal(firstSloop, maxOpt, 'change');
check('somerslooping one step raises total power', mw() > slMwBefore);
check('Somersloops-used total reported', parseFloat(D.getElementById('sumSloops').textContent) > 0);
const slStore = JSON.parse(localStorage.getItem('satisfactory-factory-plans-v1'));
const slPlan = slStore.plans.find((p) => p.id === slStore.activeId);
check('per-node sloop persisted', slPlan.state.nodeSloop && Object.keys(slPlan.state.nodeSloop).length === 1);
setVal(sloopInputs()[0], '0', 'change'); // back to none → override cleared
const slStore2 = JSON.parse(localStorage.getItem('satisfactory-factory-plans-v1'));
const slPlan2 = slStore2.plans.find((p) => p.id === slStore2.activeId);
check('setting 0 sloops clears the override', Object.keys(slPlan2.state.nodeSloop || {}).length === 0);
check('power restored after clearing sloops', mw() === slMwBefore);
check('Somersloops-used back to 0', parseFloat(D.getElementById('sumSloops').textContent) === 0);

// ---- clean ratios ----
console.log('\n### CLEAN RATIO');
setVal(D.getElementById('targetRate'), '7'); // 7 RIP/min -> fractional machine counts
const machSubs = () => [...D.querySelectorAll('#prodTable .mach-sub')].map((s) => s.textContent);
const anyFrac = () => machSubs().some((t) => t.includes('.'));
check('fractional machine counts at 7/min', anyFrac());
const crBox = D.getElementById('cleanRatio');
crBox.checked = true; fire(crBox, 'change');
check('clean ratio -> all whole machine counts', !anyFrac());
const crStore = JSON.parse(localStorage.getItem('satisfactory-factory-plans-v1'));
const crPlan = crStore.plans.find((p) => p.id === crStore.activeId);
check('clean ratio toggle persisted', crPlan.state.cleanRatio === true);
check('clean ratio note shown', !D.getElementById('cleanRatioNote').hidden);
crBox.checked = false; fire(crBox, 'change');
check('toggling clean ratio off restores fractional counts', anyFrac());
setVal(D.getElementById('targetRate'), '10'); // restore target for the factory-plans block below

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

// Planner Depot / Storage destination (F5): an output tagged for the Depot must still be
// produced (its production rows appear), but be grouped under "To Depot / Storage" with
// a distinct flow terminal — NOT shown as a primary line output. The primary stays a line
// product. Iron Plate (line) + Iron Rod (depot), both off shared Iron Ingot.
console.log('\n### PLANNER DEPOT / STORAGE OUTPUT');
const dom8 = new JSDOM(html, { url: 'https://local/', pretendToBeVisual: true });
global.window = dom8.window; global.document = dom8.window.document; global.localStorage = dom8.window.localStorage;
global.location = dom8.window.location; global.Event = dom8.window.Event;
if (!dom8.window.SVGElement.prototype.setPointerCapture) dom8.window.SVGElement.prototype.setPointerCapture = () => {};
dom8.window.localStorage.clear();
delete require.cache[require.resolve('../src/renderer.js')];
require('../src/renderer.js');
dom8.window.dispatchEvent(new dom8.window.Event('DOMContentLoaded'));
const d8 = dom8.window.document;
const fire8 = (n, t) => n.dispatchEvent(new dom8.window.Event(t, { bubbles: true }));
const setVal8 = (n, v, t = 'input') => { n.value = v; fire8(n, t); };
const click8 = (n) => n.dispatchEvent(new dom8.window.Event('click', { bubbles: true }));
const itemTexts8 = () => [...d8.querySelectorAll('#prodTable tbody tr td:first-child')].map((td) => td.textContent);
const depotRowTexts8 = () => [...d8.querySelectorAll('#depotTable tbody tr td:first-child')].map((td) => td.textContent);
const ironRodRate = () => { // gross /min produced for Iron Rod across all its production rows
  let r = 0;
  [...d8.querySelectorAll('#prodTable tbody tr')].forEach((tr) => {
    if (/Iron Rod/.test(tr.querySelector('td:first-child').textContent)) r += parseFloat(tr.querySelector('td:nth-child(3)').textContent) || 0;
  });
  return r;
};
click8([...d8.querySelectorAll('.tab')].find((t) => t.dataset.mode === 'planner'));
setVal8(d8.getElementById('targetItem'), 'Iron Plate'); setVal8(d8.getElementById('targetRate'), '30');
const baseRows8 = d8.querySelectorAll('#prodTable tbody tr').length;
check('primary destination select present, default line', !!d8.getElementById('targetDest') && d8.getElementById('targetDest').value === 'line');
check('depot group hidden with no depot/storage output', d8.getElementById('depotWrap').hidden === true);
// add a depot-tagged extra output for Iron Rod at 30/min
click8(d8.getElementById('plannerAddOutput'));
const exRow8 = d8.querySelector('#plannerExtra .row');
check('extra row has a destination select', !!exRow8.querySelector('.row-dest'));
setVal8(exRow8.querySelector('.row-item'), 'Iron Rod'); setVal8(exRow8.querySelector('.row-rate'), '30');
const rodRateLineDefault = ironRodRate();
check('depot-tagged output is still produced (production rows appear)', rodRateLineDefault > 0 && d8.querySelectorAll('#prodTable tbody tr').length > baseRows8);
// flip its destination to Depot
setVal8(exRow8.querySelector('.row-dest'), 'depot', 'change');
check('Depot output keeps the SAME required production (demand unchanged by destination)', Math.abs(ironRodRate() - rodRateLineDefault) < 1e-6);
check('Iron Rod listed under To Depot / Storage', depotRowTexts8().some((t) => /Iron Rod/.test(t)));
check('To Depot / Storage group now visible', d8.getElementById('depotWrap').hidden === false);
check('destination column reads Dimensional Depot', [...d8.querySelectorAll('#depotTable tbody tr')].some((tr) => /Dimensional Depot/.test(tr.textContent)));
// the persisted plan records the dest tag (back-compat: absent == line)
const ps8 = JSON.parse(dom8.window.localStorage.getItem('satisfactory-factory-plans-v1'));
const pp8 = ps8.plans.find((p) => p.id === ps8.activeId);
check('extra output dest persisted as depot', pp8.state.extraTargets && pp8.state.extraTargets[0].dest === 'depot');
// flow: Iron Rod becomes a distinct depot terminal, NOT a green line-output node
click8(d8.getElementById('viewFlow'));
const flow8 = dom8.window.__lastFlow;
const ironRodCls8 = Object.keys(DATA.items).find((k) => DATA.items[k].name === 'Iron Rod');
check('flow shows a fed depot terminal node', !!flow8 && flow8.nodes.some((n) => n.kind === 'depot' && n.ins.length > 0));
check('only the line product (Iron Plate) is a green output node', flow8.nodes.filter((n) => n.kind === 'out').length === 1);
check('Iron Rod is NOT a green line output (it routes to the depot)', !flow8.nodes.some((n) => n.id === 'out|' + ironRodCls8));
check('depot terminal carries the Iron Rod item id', flow8.nodes.some((n) => n.id === 'depot|' + ironRodCls8));
click8(d8.getElementById('viewTables'));
// switching to Storage relabels the destination, stays in the same group
setVal8(exRow8.querySelector('.row-dest'), 'storage', 'change');
check('storage destination relabels to Storage', [...d8.querySelectorAll('#depotTable tbody tr')].some((tr) => /Storage/.test(tr.textContent)));
check('storage output still excluded from line outputs', d8.getElementById('depotWrap').hidden === false);

// Same item, two destinations: Iron Plate to the line (primary, 30) AND to storage (extra
// row, now also Iron Plate at 30) must split into two terminals — one green line output
// AND one storage terminal — not collapse into a single box. Regression guard for the
// per-row destination breakdown (the old item->one-dest map dropped the storage portion).
setVal8(exRow8.querySelector('.row-item'), 'Iron Plate'); // extra row: Iron Plate -> storage
const iplateCls8 = Object.keys(DATA.items).find((k) => DATA.items[k].name === 'Iron Plate');
check('split: Iron Plate still listed under To Depot / Storage', depotRowTexts8().some((t) => /Iron Plate/.test(t)));
check('split: storage row reads Storage', [...d8.querySelectorAll('#depotTable tbody tr')].some((tr) => /Iron Plate/.test(tr.textContent) && /Storage/.test(tr.textContent)));
click8(d8.getElementById('viewFlow'));
const flow8b = dom8.window.__lastFlow;
check('split: same item is STILL a green line output', flow8b.nodes.some((n) => n.id === 'out|' + iplateCls8 && n.kind === 'out'));
check('split: same item ALSO has a fed storage terminal', flow8b.nodes.some((n) => n.id === 'storage|' + iplateCls8 && n.kind === 'depot' && n.ins.length > 0));
check('split: line + storage portions both ~30/min (no double-count, no drop)',
  /\b30\b/.test((flow8b.nodes.find((n) => n.id === 'out|' + iplateCls8) || {}).sub || '') &&
  /\b30\b/.test((flow8b.nodes.find((n) => n.id === 'storage|' + iplateCls8) || {}).sub || ''));
click8(d8.getElementById('viewTables'));

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

// Settings drawer (F6) + appearance theming (F2). Fresh DOM/storage so the default
// landing tab and the theme prefs key start clean.
console.log('\n### SETTINGS DRAWER + APPEARANCE THEME');
const THEME_KEY = 'satisfactory-app-prefs-v1';
const dom10 = new JSDOM(html, { url: 'https://local/', pretendToBeVisual: true });
global.window = dom10.window; global.document = dom10.window.document; global.localStorage = dom10.window.localStorage;
global.location = dom10.window.location; global.Event = dom10.window.Event;
if (!dom10.window.SVGElement.prototype.setPointerCapture) dom10.window.SVGElement.prototype.setPointerCapture = () => {};
dom10.window.localStorage.clear();
delete require.cache[require.resolve('../src/renderer.js')];
require('../src/renderer.js');
dom10.window.dispatchEvent(new dom10.window.Event('DOMContentLoaded'));
const d10 = dom10.window.document;
const fire10 = (n, t) => n.dispatchEvent(new dom10.window.Event(t, { bubbles: true }));
const click10 = (n) => n.dispatchEvent(new dom10.window.Event('click', { bubbles: true }));
const activeTab10 = () => { const a = d10.querySelector('.tab.active'); return a ? a.dataset.mode : '(none)'; };

// F6: default landing tab is the Recipe Optimizer (Planner demoted but still present).
check('default landing tab is Recipe Optimizer', activeTab10() === 'optimize');
check('optimizer panel visible by default', !d10.querySelector('.mode-panel[data-mode="optimize"]').hidden);
check('planner panel hidden by default', d10.querySelector('.mode-panel[data-mode="planner"]').hidden === true);
check('planner tab still present (saved-plan engine intact)', !!d10.querySelector('.tab[data-mode="planner"]'));
check('planner tab is demoted (secondary class)', d10.querySelector('.tab[data-mode="planner"]').classList.contains('tab-secondary'));

// F6: game-settings controls moved off the main screen into the drawer.
const drawer10 = d10.getElementById('settingsDrawer');
check('settings drawer exists and starts closed', !!drawer10 && drawer10.hidden === true);
check('machine tuning + cost multipliers live inside the drawer', drawer10.contains(d10.getElementById('clock')) && drawer10.contains(d10.getElementById('mRecipe')));
click10(d10.getElementById('btnSettings'));
check('gear button opens the drawer', drawer10.hidden === false && d10.getElementById('settingsBackdrop').hidden === false);
// relocated controls still functional: power multiplier still drives the summary
const dom10optProd = () => d10.querySelectorAll('#prodTable tbody tr').length;
click10([...d10.querySelectorAll('.tab')].find((t) => t.dataset.mode === 'optimize'));
const optRow10 = d10.querySelector('#optOutputs .row');
optRow10.querySelector('.row-item').value = 'Iron Plate'; fire10(optRow10.querySelector('.row-item'), 'input');
check('optimizer solves with relocated machine-tuning still wired', dom10optProd() > 0);
const mPower10 = d10.getElementById('mPower'); mPower10.value = '5'; fire10(mPower10, 'change');
check('relocated power multiplier still recomputes', d10.getElementById('sumPower').textContent !== '—');
mPower10.value = '1'; fire10(mPower10, 'change');
// close paths
click10(d10.getElementById('settingsClose'));
check('close button hides the drawer', drawer10.hidden === true);
click10(d10.getElementById('btnSettings'));
click10(d10.getElementById('settingsBackdrop'));
check('backdrop click hides the drawer', drawer10.hidden === true);

// F2: appearance theme override applies live + persists to its own key (not the plan store).
click10(d10.getElementById('btnSettings'));
const colorInputs10 = [...d10.querySelectorAll('#themeColors input[type="color"]')];
check('appearance exposes one colour input per themeable var', colorInputs10.length === 10);
const accentInput10 = colorInputs10.find((i) => i.title === '--accent');
check('accent colour input present', !!accentInput10);
accentInput10.value = '#00ff00'; fire10(accentInput10, 'input');
check('override applies live to :root', d10.documentElement.style.getPropertyValue('--accent').trim() === '#00ff00');
const themeStored10 = JSON.parse(dom10.window.localStorage.getItem(THEME_KEY));
check('theme override persisted to its own prefs key', !!themeStored10 && themeStored10.custom['--accent'] === '#00ff00');
const plansStore10 = JSON.parse(dom10.window.localStorage.getItem('satisfactory-factory-plans-v1') || 'null');
check('theme NOT written into the plan store (no blank-app risk)', !plansStore10 || !JSON.stringify(plansStore10).includes('--accent'));
// preset switch wipes custom + applies the preset palette
const preset10 = d10.getElementById('themePreset'); preset10.value = 'contrast'; fire10(preset10, 'change');
check('high-contrast preset applies a different accent', d10.documentElement.style.getPropertyValue('--accent').trim() && d10.documentElement.style.getPropertyValue('--accent').trim() !== '#00ff00');
check('preset selection persisted', JSON.parse(dom10.window.localStorage.getItem(THEME_KEY)).preset === 'contrast');
// reset to default clears overrides
click10(d10.getElementById('themeReset'));
check('reset clears the inline accent override', d10.documentElement.style.getPropertyValue('--accent') === '');
check('reset persists the dark default', JSON.parse(dom10.window.localStorage.getItem(THEME_KEY)).preset === 'dark');

// F2: theme persists across a reload (new DOM, same localStorage).
console.log('\n### THEME RELOAD PERSISTENCE');
const themeDump10 = (() => { dom10.window.localStorage.setItem(THEME_KEY, JSON.stringify({ preset: 'dark', custom: { '--accent': '#abcdef' } })); return dom10.window.localStorage.getItem(THEME_KEY); })();
const dom9 = new JSDOM(html, { url: 'https://local/', pretendToBeVisual: true });
global.window = dom9.window; global.document = dom9.window.document; global.localStorage = dom9.window.localStorage;
global.location = dom9.window.location; global.Event = dom9.window.Event;
if (!dom9.window.SVGElement.prototype.setPointerCapture) dom9.window.SVGElement.prototype.setPointerCapture = () => {};
dom9.window.localStorage.clear();
dom9.window.localStorage.setItem(THEME_KEY, themeDump10);
delete require.cache[require.resolve('../src/renderer.js')];
require('../src/renderer.js');
dom9.window.dispatchEvent(new dom9.window.Event('DOMContentLoaded'));
check('saved theme override re-applied on reload', dom9.window.document.documentElement.style.getPropertyValue('--accent').trim() === '#abcdef');

// Recipe + building exclusion (F1 / F4): the shared veto must drive the solver through the
// real DOM/event path, persist per-plan, and surface the sole-producer guard message.
console.log('\n### RECIPE / BUILDING EXCLUSION (F1 / F4)');
const dom12 = new JSDOM(html, { url: 'https://local/', pretendToBeVisual: true });
global.window = dom12.window; global.document = dom12.window.document; global.localStorage = dom12.window.localStorage;
global.location = dom12.window.location; global.Event = dom12.window.Event;
if (!dom12.window.SVGElement.prototype.setPointerCapture) dom12.window.SVGElement.prototype.setPointerCapture = () => {};
dom12.window.localStorage.clear();
delete require.cache[require.resolve('../src/renderer.js')];
require('../src/renderer.js');
dom12.window.dispatchEvent(new dom12.window.Event('DOMContentLoaded'));
const d12 = dom12.window.document;
const fire12 = (n, t) => n.dispatchEvent(new dom12.window.Event(t, { bubbles: true }));
const setVal12 = (n, v, t = 'input') => { n.value = v; fire12(n, t); };
const click12 = (n) => n.dispatchEvent(new dom12.window.Event('click', { bubbles: true }));
const plan12 = () => { const s = JSON.parse(dom12.window.localStorage.getItem('satisfactory-factory-plans-v1')); return s.plans.find((p) => p.id === s.activeId); };

// The two new veto sections exist and are wired.
check('Buildings veto list rendered (>= the 11 crafting buildings)', d12.querySelectorAll('#bldList .alt-row').length >= 11);
check('Standard-recipe veto list rendered (many base recipes)', d12.querySelectorAll('#stdList .alt-row').length > 50);

// F4: build Time Crystal in the Optimizer, then disable the Converter via its checkbox.
click12([...d12.querySelectorAll('.tab')].find((t) => t.dataset.mode === 'optimize'));
click12(d12.getElementById('optAllInputs')); // allow every raw resource
const oRow = d12.querySelector('#optOutputs .row');
setVal12(oRow.querySelector('.row-item'), 'Time Crystal'); setVal12(oRow.querySelector('.row-rate'), '10');
check('Time Crystal optimizes before any veto', !d12.getElementById('output').hidden && prodRows() > 0);
// Find the Converter checkbox by its label text and untick it.
const convRow = [...d12.querySelectorAll('#bldList .alt-row')].find((r) => /Converter/.test(r.textContent));
check('Converter row present in building list', !!convRow);
const convCb = convRow.querySelector('input');
convCb.checked = false; fire12(convCb, 'change');
check('disabling Converter persists in disabledBuildings', (plan12().state.disabledBuildings || []).includes('Build_Converter_C'));
check('Time Crystal now infeasible (empty shown)', !d12.getElementById('empty').hidden && d12.getElementById('output').hidden);
check('sole-producer guard message names the item', /Time Crystal/.test(d12.getElementById('emptyMsg').textContent) && /disabled/i.test(d12.getElementById('emptyMsg').textContent));
// Re-enabling the Converter restores the plan.
convCb.checked = true; fire12(convCb, 'change');
check('re-enabling Converter restores the plan', !d12.getElementById('output').hidden && prodRows() > 0);

// F1: ticking off a standard recipe persists to disabledRecipes and re-solves.
const stdRow0 = d12.querySelector('#stdList .alt-row');
const stdCb0 = stdRow0.querySelector('input');
stdCb0.checked = false; fire12(stdCb0, 'change');
check('disabling a standard recipe persists in disabledRecipes', (plan12().state.disabledRecipes || []).length === 1);
stdCb0.checked = true; fire12(stdCb0, 'change');
check('re-enabling clears the standard-recipe veto', (plan12().state.disabledRecipes || []).length === 0);

// Back-compat: a plan saved before these fields existed must load with empty defaults.
console.log('\n### EXCLUSION BACK-COMPAT');
const dom11 = new JSDOM(html, { url: 'https://local/', pretendToBeVisual: true });
global.window = dom11.window; global.document = dom11.window.document; global.localStorage = dom11.window.localStorage;
global.location = dom11.window.location; global.Event = dom11.window.Event;
if (!dom11.window.SVGElement.prototype.setPointerCapture) dom11.window.SVGElement.prototype.setPointerCapture = () => {};
dom11.window.localStorage.clear();
// An "old" persisted plan with none of the new fields.
dom11.window.localStorage.setItem('satisfactory-factory-plans-v1', JSON.stringify({
  plans: [{ id: 'old1', name: 'Legacy', state: { mode: 'planner', targetItem: cls('Iron Plate'), targetRate: 10 } }],
  activeId: 'old1',
}));
delete require.cache[require.resolve('../src/renderer.js')];
require('../src/renderer.js');
dom11.window.dispatchEvent(new dom11.window.Event('DOMContentLoaded'));
const d11 = dom11.window.document;
const oldPlan = JSON.parse(dom11.window.localStorage.getItem('satisfactory-factory-plans-v1')).plans[0];
check('old plan gains empty disabledRecipes default', Array.isArray(oldPlan.state.disabledRecipes) && oldPlan.state.disabledRecipes.length === 0);
check('old plan gains empty disabledBuildings default', Array.isArray(oldPlan.state.disabledBuildings) && oldPlan.state.disabledBuildings.length === 0);
check('old plan still produces (no veto applied)', d11.querySelectorAll('#prodTable tbody tr').length > 0);

// ---- PROJECTS (F3): project switcher, plan-bar filtering, linked inputs, rollup ----
// Helper to boot a fresh renderer + jsdom with an optional pre-seeded payload. Returns
// { w, d, app, fire, setVal, click }. (Uses dom13+ to avoid the file's existing dom1..7
// instance names.) prompt is stubbed so newProject() doesn't block.
function boot13(seed) {
  const w = new JSDOM(html, { url: 'https://local/', pretendToBeVisual: true }).window;
  global.window = w; global.document = w.document; global.localStorage = w.localStorage;
  global.location = w.location; global.Event = w.Event;
  w.confirm = () => true; global.confirm = w.confirm;
  w.alert = () => {}; global.alert = w.alert;
  w.prompt = (msg, def) => def; global.prompt = w.prompt;
  global.Image = w.Image; // the map's ensureMapImg() does `new Image()` (X-ray routes through the map)
  global.requestAnimationFrame = w.requestAnimationFrame || ((cb) => setTimeout(cb, 0)); global.cancelAnimationFrame = w.cancelAnimationFrame || clearTimeout;
  if (!w.SVGElement.prototype.setPointerCapture) w.SVGElement.prototype.setPointerCapture = () => {};
  w.localStorage.clear();
  if (seed != null) w.localStorage.setItem('satisfactory-factory-plans-v1', seed);
  delete require.cache[require.resolve('../src/renderer.js')];
  require('../src/renderer.js');
  w.dispatchEvent(new w.Event('DOMContentLoaded'));
  const d = w.document;
  const fire = (n, t) => n.dispatchEvent(new w.Event(t, { bubbles: true }));
  const setVal = (n, v, t = 'input') => { n.value = v; fire(n, t); };
  const click = (n) => n.dispatchEvent(new w.Event('click', { bubbles: true }));
  return { w, d, app: w.__app, fire, setVal, click };
}
const planNamesIn = (d) => [...d.querySelectorAll('#planTabs .plan-tab .plan-name')].map((s) => s.textContent);

console.log('\n### PROJECTS: SWITCHER + PLAN-BAR FILTER + ROLLUP');
{
  const { d, app, setVal, click } = boot13(null);
  check('starts with one project', app.projects.length === 1 && d.querySelectorAll('#projectSelect option').length === 1);
  check('plan bar shows the project\'s single plan', planNamesIn(d).length === 1);
  // Create a second project via the New Project button (prompt stubbed to default name).
  click(d.getElementById('projectNew'));
  check('two projects after New Project', app.projects.length === 2);
  check('project switcher shows two options', d.querySelectorAll('#projectSelect option').length === 2);
  check('new project is active', app.activeProjectId === app.projects[1].id);
  check('plan bar filtered to new project (its starter plan only)', planNamesIn(d).length === 1 && planNamesIn(d)[0] === 'Factory 1');
  // Add a 2nd plan to project 2, then confirm project 1 still shows only its own plan.
  click(d.getElementById('planNew'));
  check('project 2 now has 2 plans in the bar', planNamesIn(d).length === 2);
  const proj1Id = app.projects[0].id;
  setVal(d.getElementById('projectSelect'), proj1Id, 'change'); // switch back to project 1
  check('switched back to project 1', app.activeProjectId === proj1Id);
  check('plan bar filters by project (project 1 shows only its 1 plan)', planNamesIn(d).length === 1);
  // Persistence of projects.
  const persisted = JSON.parse(d.defaultView.localStorage.getItem('satisfactory-factory-plans-v1'));
  check('projects persisted', Array.isArray(persisted.projects) && persisted.projects.length === 2);
  check('activeProjectId persisted', persisted.activeProjectId === proj1Id);
  check('each plan persisted with a projectId', persisted.plans.every((p) => !!p.projectId));
}

console.log('\n### PROJECTS: CREATE + INLINE RENAME WITHOUT prompt() (Electron has none)');
{
  const { w, d, app, fire, click } = boot13(null);
  // Electron's renderer defines window.prompt but THROWS when it's called
  // ("prompt() is and will not be supported."). The +Project / ✎Rename handlers used to
  // call prompt() first, so the throw aborted them and the buttons did nothing. Simulate
  // that throw here so any regression reintroducing prompt() fails loudly.
  w.prompt = () => { throw new Error('prompt() is and will not be supported.'); };
  global.prompt = w.prompt;
  check('starts with one project', app.projects.length === 1);
  click(d.getElementById('projectNew'));
  check('+Project creates without calling prompt()', app.projects.length === 2);
  check('projectSelect intact after create (not mid-swap)',
    !!d.getElementById('projectSelect') && d.querySelectorAll('#projectSelect option').length === 2);
  // ✎Rename swaps the <select> for an inline text input (same UX as plan-tab rename).
  click(d.getElementById('projectRename'));
  const inp = d.querySelector('.project-bar input.plan-rename');
  check('Rename swaps select for an input', !!inp && !d.getElementById('projectSelect'));
  inp.value = 'Steel Wing';
  fire(inp, 'blur'); // commit on blur
  check('rename committed to active project', app.projects[1].name === 'Steel Wing');
  check('projectSelect restored after rename', !!d.getElementById('projectSelect'));
  check('renamed option shown in switcher',
    [...d.querySelectorAll('#projectSelect option')].some((o) => o.textContent === 'Steel Wing'));
}

console.log('\n### PROJECTS: LINKED INPUT A -> B TRACKS A\'S OUTPUT');
{
  const { d, app, setVal, click } = boot13(null);
  // Plan A: optimizer making 30 Iron Plate from raw. Records its net output.
  click([...d.querySelectorAll('.tab')].find((t) => t.dataset.mode === 'optimize'));
  const aOut = d.querySelector('#optOutputs .row');
  setVal(aOut.querySelector('.row-item'), 'Iron Plate'); setVal(aOut.querySelector('.row-rate'), '30');
  const planA = app.activePlan();
  check('A records Iron Plate as a net output', (app.planNetOutputs(planA)[cls('Iron Plate')] || 0) === 30);
  // Plan B in the same project: add an optimizer extra-input row, link it to A's Plate.
  click(d.getElementById('planNew'));
  click([...d.querySelectorAll('.tab')].find((t) => t.dataset.mode === 'optimize'));
  click(d.getElementById('optAddInput'));
  let linkSel = d.querySelector('#optExtraInputs .row .row-link');
  check('extra-input row has a link <select>', !!linkSel);
  const planB = app.activePlan();
  // The select offers A's Iron Plate output as "planAId|itemClass".
  const optVal = planA.id + '|' + cls('Iron Plate');
  const hasOpt = [...linkSel.options].some((o) => o.value === optVal);
  check('link select offers A\'s Iron Plate output', hasOpt);
  setVal(linkSel, optVal, 'change');
  const bRow = planB.state.opt.extraInputs[0];
  check('B\'s row linked to A', bRow.fromPlanId === planA.id && bRow.fromItem === cls('Iron Plate'));
  check('B\'s linked cap tracks A\'s output (30)', app.resolveLinkedCap(bRow) === 30);
  // Change A's rate to 90; B's resolved cap must follow.
  setVal(d.getElementById('projectSelect'), app.projects[0].id, 'change'); // back to A's project? same project here
  // A and B share a project; switch to A by clicking its plan tab.
  click([...d.querySelectorAll('#planTabs .plan-tab .plan-name')][0]);
  click([...d.querySelectorAll('.tab')].find((t) => t.dataset.mode === 'optimize'));
  const aOut2 = d.querySelector('#optOutputs .row');
  setVal(aOut2.querySelector('.row-rate'), '90');
  check('A re-solved to 90/min Iron Plate', (app.planNetOutputs(app.activePlan())[cls('Iron Plate')] || 0) === 90);
  check('B\'s linked cap now tracks A\'s new output (90)', app.resolveLinkedCap(bRow) === 90);
  // Cycle guard: linking A's input back to B (which already pulls from A) is refused.
  check('linking A <- B would be a cycle (refused by guard)', app.linkWouldCycle(planA.id, planB.id) === true);

  // Project rollup view: power + raw summed across A and B.
  click([...d.querySelectorAll('.tab')].find((t) => t.dataset.mode === 'project'));
  check('project view shown', !d.getElementById('projectView').hidden);
  const powerTxt = d.getElementById('projPowerBig').textContent;
  check('rollup shows a non-empty total power', /\d/.test(powerTxt));
  const projRawRows = [...d.querySelectorAll('#projRawTable tbody tr')];
  const rawItems = projRawRows.map((tr) => tr.querySelector('td') ? tr.querySelector('td').textContent : '');
  check('rollup raw includes Iron Ore (A\'s raw input)', rawItems.some((t) => /Iron Ore/.test(t)));
  check('rollup nets out internally-supplied Iron Plate', !rawItems.some((t) => /^.*Iron Plate/.test(t)));
}

// ---- BACK-COMPAT: a pre-F3 payload (plans, activeId, NO projects) loads into a
//      default project with every plan intact and rendered. This is the headline
//      acceptance criterion — old plans.json must never be lost. ----
console.log('\n### PROJECTS: PRE-F3 BACK-COMPAT LOAD');
{
  const preF3 = JSON.stringify({
    plans: [
      { id: 'old1', name: 'Smelter', state: { mode: 'planner', targetItem: cls('Iron Ingot'), targetRate: 60 } },
      { id: 'old2', name: 'Plates', state: { mode: 'planner', targetItem: cls('Iron Plate'), targetRate: 30 } },
      { id: 'old3', name: 'Rods', state: { mode: 'planner', targetItem: cls('Iron Rod'), targetRate: 15 } },
    ],
    activeId: 'old2',
    globals: { recipeCost: 1, powerMult: 1, spaceMult: 1, unlockedAlts: null, saveName: '', saveFile: '' },
  });
  const { d, app } = boot13(preF3);
  check('pre-F3: a default project was synthesized', app.projects.length === 1);
  check('pre-F3: default project named "Project 1"', app.projects[0].name === 'Project 1');
  check('pre-F3: all 3 old plans loaded', app.plans.length === 3);
  check('pre-F3: every old plan adopted into the default project', app.plans.every((p) => p.projectId === app.projects[0].id));
  check('pre-F3: activeId preserved (old2)', app.activeId === 'old2');
  check('pre-F3: all 3 plans render in the plan bar', planNamesIn(d).length === 3);
  check('pre-F3: plan names intact', JSON.stringify(planNamesIn(d)) === JSON.stringify(['Smelter', 'Plates', 'Rods']));
  check('pre-F3: active plan target restored (Iron Plate)', d.getElementById('targetItem').value === 'Iron Plate');
  // And it persists forward in the new shape (projects now written).
  const reSaved = JSON.parse(d.defaultView.localStorage.getItem('satisfactory-factory-plans-v1'));
  check('pre-F3: re-saved payload now carries projects', Array.isArray(reSaved.projects) && reSaved.projects.length === 1);
  check('pre-F3: re-saved plans all have projectId', reSaved.plans.every((p) => p.projectId === reSaved.projects[0].id));
}

// ---- OPTIMIZER per-step Overclock + Somersloop ----
// Regression for "spreadsheet can't add sloops / power shards": the default landing tab is
// the Optimizer, whose rows used to show "—" (only the Planner was interactive). tuneSteps
// now makes Optimizer rows tunable too.
console.log('\n### OPTIMIZER PER-STEP OVERCLOCK + SOMERSLOOP');
{
  const { d, setVal, click } = boot13(null);
  click([...d.querySelectorAll('.tab')].find((t) => t.dataset.mode === 'optimize'));
  const row = d.querySelector('#optOutputs .row');
  setVal(row.querySelector('.row-item'), 'Iron Plate'); setVal(row.querySelector('.row-rate'), '60');
  const prod = () => d.querySelectorAll('#prodTable tbody tr').length;
  const mw = () => parseFloat(d.getElementById('sumPower').textContent);
  check('optimizer produces rows', prod() > 0);
  check('optimizer rows now have a clock input (was —)', [...d.querySelectorAll('#prodTable tbody .clock-input')].length === prod());
  check('optimizer rows now have a sloop select (was —)', [...d.querySelectorAll('#prodTable tbody .sloop-input')].length === prod());
  const before = mw();
  setVal([...d.querySelectorAll('#prodTable tbody .clock-input')][0], '250', 'change');
  check('overclock one optimizer step raises total power', mw() > before);
  setVal([...d.querySelectorAll('#prodTable tbody .clock-input')][0], '100', 'change');
  check('clearing the overclock restores power', mw() === before);
  const slBefore = mw();
  const sloopSel = [...d.querySelectorAll('#prodTable tbody .sloop-input')][0];
  setVal(sloopSel, sloopSel.options[sloopSel.options.length - 1].value, 'change');
  check('somerslooping one optimizer step raises power', mw() > slBefore);
  check('optimizer reports somersloops used', parseFloat(d.getElementById('sumSloops').textContent) > 0);
  const store = JSON.parse(d.defaultView.localStorage.getItem('satisfactory-factory-plans-v1'));
  const plan = store.plans.find((p) => p.id === store.activeId);
  check('optimizer per-step sloop persisted to nodeSloop', plan.state.nodeSloop && Object.keys(plan.state.nodeSloop).length === 1);
}

// ---- FLOWCHART node settings popup ----
// Click a machine node → popup with an Overclock input + power-shard chips + Somersloop
// select. Edits write through to the same state.nodeClock / state.nodeSloop the table uses.
console.log('\n### FLOWCHART NODE POPUP (Overclock + Somersloop)');
{
  const { w, d, setVal, click } = boot13(null);
  click([...d.querySelectorAll('.tab')].find((t) => t.dataset.mode === 'planner'));
  setVal(d.getElementById('targetItem'), 'Reinforced Iron Plate'); setVal(d.getElementById('targetRate'), '10');
  click(d.getElementById('viewFlow'));
  const macNode = [...d.querySelectorAll('#flowSvg .node.machine')][0];
  check('machine nodes are marked tunable', macNode.classList.contains('tunable'));
  const tap = (t, x, y) => macNode.dispatchEvent(new w.MouseEvent(t, { clientX: x, clientY: y, bubbles: true }));
  tap('pointerdown', 50, 50); tap('pointerup', 50, 50); // a no-move tap opens the popup
  let popup = d.getElementById('nodePopup');
  check('tapping a machine opens the node popup', !!popup);
  check('popup has an overclock input', !!popup.querySelector('.clock-input'));
  check('popup has a somersloop select', !!popup.querySelector('.sloop-input'));
  check('popup has 4 power-shard chips (0..3)', popup.querySelectorAll('.np-chip').length === 4);
  const mwB = parseFloat(d.getElementById('sumPower').textContent);
  const sel = popup.querySelector('.sloop-input');
  setVal(sel, sel.options[sel.options.length - 1].value, 'change');
  check('popup somersloop raises sloops-used total', parseFloat(d.getElementById('sumSloops').textContent) > 0);
  check('popup somersloop raises total power', parseFloat(d.getElementById('sumPower').textContent) > mwB);
  check('popup stays open after an edit (re-rendered in place)', !!d.getElementById('nodePopup'));
  const ns = JSON.parse(d.defaultView.localStorage.getItem('satisfactory-factory-plans-v1')).plans.find((p) => p.id === JSON.parse(d.defaultView.localStorage.getItem('satisfactory-factory-plans-v1')).activeId).state.nodeSloop;
  check('popup sloop persisted to nodeSloop', ns && Object.keys(ns).length >= 1);
  // power-shard chip [3] = 250% → writes a per-step overclock
  click([...d.getElementById('nodePopup').querySelectorAll('.np-chip')][3]);
  const nc = JSON.parse(d.defaultView.localStorage.getItem('satisfactory-factory-plans-v1')).plans.find((p) => p.id === JSON.parse(d.defaultView.localStorage.getItem('satisfactory-factory-plans-v1')).activeId).state.nodeClock;
  check('power-shard chip sets a per-step overclock (250%)', nc && Object.values(nc).some((v) => Math.abs(v - 2.5) < 1e-9));
  d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('Escape closes the popup', !d.getElementById('nodePopup'));
}

// Standalone "mine → burn" power: mine a raw fuel (Coal) and feed a generator directly,
// independent of the production plan — so coal power works with no plan at all. Shares the
// powerInfraFor seam, so the same numbers drive the Power Planner tables AND the flowchart.
console.log('\n### POWER PLANNER: STANDALONE COAL POWER (mine → burn)');
{
  const { w, d, setVal, click } = boot13(null);
  const tabOf = (m) => click([...d.querySelectorAll('.tab')].find((t) => t.dataset.mode === m));
  tabOf('power'); // empty optimizer plan behind it — standalone must stand on its own
  const addBtn = d.getElementById('pwrAddStandalone');
  check('standalone "add coal power" button present', !!addBtn);
  click(addBtn);
  check('standalone row added', d.querySelectorAll('#pwrStandaloneList .pwr-row').length === 1);
  const genTxt = () => [...d.querySelectorAll('#pwrGenTable tbody tr')].map((r) => r.textContent).join(' | ');
  check('generation table lists the Coal-Powered Generator', /Coal-Powered Generator/.test(genTxt()));
  check('net is positive with no plan (gen > miners + water)', /^\+/.test(d.getElementById('pwrNet').textContent));
  // 80 coal/min → 5.33 gens · +400 MW (in-game ratio: 15 coal & 75 MW per generator)
  const rin = d.querySelector('#pwrStandaloneList .pwr-row input[type=number]');
  setVal(rin, '80', 'change');
  check('80 coal/min sizes 5.33× coal generators', /5\.33/.test(genTxt()));
  check('80 coal/min generates +400 MW', d.getElementById('pwrGenerated').textContent === '400 MW');
  check('consumption table includes the coal miner', /Coal/.test([...d.querySelectorAll('#pwrConsTable tbody tr')].map((r) => r.textContent).join(' ')));
  const ps = JSON.parse(w.localStorage.getItem('satisfactory-factory-plans-v1'));
  const ap = ps.plans.find((p) => p.id === ps.activeId);
  check('standalone persisted to state.power.standalone (rate 80)', !!(ap.state.power && ap.state.power.standalone && ap.state.power.standalone[0] && ap.state.power.standalone[0].rate === 80));

  // Flowchart: with ⚡ Power infra on, the coal island appears over an UNRELATED plan.
  tabOf('planner');
  setVal(d.getElementById('targetItem'), 'Iron Plate'); setVal(d.getElementById('targetRate'), '20');
  click(d.getElementById('flowPowerToggle'));
  click(d.getElementById('viewFlow'));
  const rawNodes = [...d.querySelectorAll('#flowSvg .node.raw')].map((n) => n.textContent);
  check('flow creates the mined Coal raw node (not in res.raw)', rawNodes.some((t) => /Coal/.test(t)));
  const extNodes = [...d.querySelectorAll('#flowSvg .node.ext')].map((n) => n.textContent);
  check('flow shows a miner feeding the coal', extNodes.some((t) => /Miner/.test(t)));
  const genNodes = [...d.querySelectorAll('#flowSvg .node.gen')].map((n) => n.textContent);
  check('flow shows the standalone coal generator', genNodes.some((t) => /Coal-Powered Generator/.test(t)));
}

// ---- Base X-ray: per-plan region routing + scoped render ----
console.log('\n### BASE X-RAY (per-plan area)');
{
  const PX = require('../src/production-xray');
  const recPath = (rc) => 'x.' + rc;
  const Ore = cls('Iron Ore');
  // Two plate constructors far apart (so a region can include just one), an idle one, a
  // smelter, and a Pure-node miner — all near the first constructor except constructor B.
  const xSave = { levels: { L: { objects: [
    { typePath: 'g.Build_ConstructorMk1_C', transform: { translation: { x: 0, y: 0, z: 0 } }, properties: { mCurrentRecipe: { value: { pathName: recPath('Recipe_IronPlate_C') } }, mCurrentPotential: { value: 1 } } },
    { typePath: 'g.Build_ConstructorMk1_C', transform: { translation: { x: 100000, y: 0, z: 0 } }, properties: { mCurrentRecipe: { value: { pathName: recPath('Recipe_IronPlate_C') } }, mCurrentPotential: { value: 2 }, mCurrentProductionBoost: { value: 2 } } },
    { typePath: 'g.Build_ConstructorMk1_C', transform: { translation: { x: 1000, y: 0, z: 0 } }, properties: {} },
    { typePath: 'g.Build_SmelterMk1_C', transform: { translation: { x: 0, y: 500, z: 0 } }, properties: { mCurrentRecipe: { value: { pathName: recPath('Recipe_IngotIron_C') } } } },
    { typePath: 'g.Build_MinerMk2_C', transform: { translation: { x: 1500, y: 1500, z: 0 } }, properties: { mExtractableResource: { value: { pathName: 'N1' } } } },
    { typePath: 'g.BP_ResourceNode_C', instanceName: 'N1', properties: { mPurityOverride: { value: { value: 'RP_Pure' } }, mResourceClassOverride: { value: { pathName: 'x.' + Ore } } } },
  ] } } };
  const records = PX.extractRecords(xSave, DATA);
  const { d, app, setVal } = boot13();
  const itemRows = () => [...d.querySelectorAll('#xrayItemsTable tbody tr')];

  // 1) No area + not whole-base: STAY on the X-ray tab with a choice (the Whole-base
  //    toggle lives in this panel — auto-routing away made it unreachable); the
  //    "Edit area" button is what routes to the map and arms the draw tool.
  app.setMode('xray');
  let xs = app.getXray();
  check('no-area X-ray stays on its tab (whole-base toggle reachable)', xs.mode === 'xray');
  check('no-area X-ray offers the two ways forward', d.getElementById('xrayView').hidden === false && /Whole base/.test(d.getElementById('xrayEmpty').textContent) && /Edit area/.test(d.getElementById('xrayEmpty').textContent));
  d.getElementById('xrayDrawArea').click();
  xs = app.getXray();
  check('Edit area routes to the map and arms the draw tool', xs.mode === 'map' && xs.drawing === true && xs.armed === true);

  // 2) Trace a region around the near cluster (excludes constructor B at x=100000), close it.
  app.xrayPushWorldPoint(-5000, -5000); app.xrayPushWorldPoint(5000, -5000);
  app.xrayPushWorldPoint(5000, 5000); app.xrayPushWorldPoint(-5000, 5000);
  app.xrayFinishDraw();
  xs = app.getXray();
  check('finishing the trace saves a region to the plan', !!xs.region && xs.region.length === 4 && xs.drawing === false);

  // 3) Inject the parsed records and open X-ray: now it renders, scoped to the area.
  app.xrayInjectRecords(records, 'test.sav');
  app.setMode('xray');
  check('X-ray renders once an area exists', d.getElementById('xrayView').hidden === false && d.getElementById('xrayBody').hidden === false);
  // In-area: constructor A (20 plate) + idle + smelter + miner = 3 buildings counted, B excluded.
  check('scoped: out-of-area machine excluded (hero count)', d.getElementById('xrMachines').textContent === '2 / 3');
  const plateScoped = itemRows().find((tr) => /Iron Plate/.test(tr.textContent));
  const plateProduced = plateScoped && plateScoped.querySelectorAll('td')[1].textContent; // produced cell
  check('scoped: only the in-area constructor\'s output counted (20/min, not 100)', plateProduced === '20');
  check('scope line names the area', /area/i.test(d.getElementById('xrayScope').textContent));

  // 4) Whole-base toggle: ignores the area, counts both constructors.
  const wb = d.getElementById('xrayWholeBase'); wb.checked = true; wb.dispatchEvent(new d.defaultView.Event('change', { bubbles: true }));
  check('whole-base toggle counts every machine', d.getElementById('xrMachines').textContent === '3 / 4');
  check('whole-base scope line says whole base', /whole base/i.test(d.getElementById('xrayScope').textContent));
  wb.checked = false; wb.dispatchEvent(new d.defaultView.Event('change', { bubbles: true }));

  // 5) Filters still work on the scoped table.
  check('item table populated', itemRows().length >= 2);
  setVal(d.getElementById('xrayFilter'), 'iron plate');
  check('filter narrows the item table', itemRows().length === 1);
  setVal(d.getElementById('xrayFilter'), '');

  // 6) Clearing the area: the next X-ray open stays put and shows the choice again.
  app.xraySetRegion(null);
  app.setMode('xray');
  check('clearing the area shows the area/whole-base choice (no auto-route)', app.getXray().mode === 'xray' && d.getElementById('xrayBody').hidden === true && /Whole base/.test(d.getElementById('xrayEmpty').textContent));
}

// ---- Sankey view: proportional flow bands as a 3rd view toggle ----
console.log('\n### SANKEY VIEW (proportional flow bands)');
{
  const { w, d, setVal, click } = boot13(null);
  click([...d.querySelectorAll('.tab')].find((t) => t.dataset.mode === 'planner'));
  setVal(d.getElementById('targetItem'), 'Iron Plate'); setVal(d.getElementById('targetRate'), '20');
  check('Sankey toggle button present', !!d.getElementById('viewSankey'));
  click(d.getElementById('viewFlow'));
  const flowEdges = d.querySelectorAll('#flowSvg .edge-path').length;
  check('flowchart drew thin edges', flowEdges > 0);
  click(d.getElementById('viewSankey'));
  const bands = [...d.querySelectorAll('#flowSvg .sankey-band')];
  check('Sankey swaps thin edges for one band per edge', bands.length === flowEdges && d.querySelectorAll('#flowSvg .edge-path').length === 0);
  check('every band has a positive stroke-width (∝ throughput)', bands.length > 0 && bands.every((b) => parseFloat(b.getAttribute('stroke-width')) > 0));
  check('bands vary in width (a wider stream reads thicker)', new Set(bands.map((b) => b.getAttribute('stroke-width'))).size >= 1);
  check('a band carries a rate tooltip', bands.some((b) => b.querySelector('title') && /\/min/.test(b.querySelector('title').textContent)));
  const ps = JSON.parse(w.localStorage.getItem('satisfactory-factory-plans-v1'));
  check('Sankey view persisted to the plan', ps.plans.find((p) => p.id === ps.activeId).state.view === 'sankey');
  click(d.getElementById('viewFlow'));
  check('switching back to Flowchart restores thin edges (no bands)',
    d.querySelectorAll('#flowSvg .sankey-band').length === 0 && d.querySelectorAll('#flowSvg .edge-path').length === flowEdges);
}

// ---- Water sink (Wet Concrete): flowchart wiring must match the LP's diversion ----
// The LP sends every step's water OUTPUT to the Wet Concrete route and meets water
// INPUTS fresh from extractors. The chart must draw exactly that: no machine→machine
// water edge (the backfeed loop the option eliminates), consumers fed by raw|Water,
// the wet node fed only by water-emitting steps + raw Limestone, and its Concrete
// connected onward to the Awesome Sink instead of floating.
console.log('\n### WATER SINK (Wet Concrete) FLOWCHART WIRING');
{
  const { w, d, setVal, click } = boot13(null);
  click([...d.querySelectorAll('.tab')].find((t) => t.dataset.mode === 'optimize'));
  const row = d.querySelector('#optOutputs .row');
  setVal(row.querySelector('.row-item'), 'Aluminum Ingot'); setVal(row.querySelector('.row-rate'), '100');
  const ws = d.getElementById('optWaterSink');
  ws.checked = true; ws.dispatchEvent(new d.defaultView.Event('change', { bubbles: true }));
  click(d.getElementById('viewFlow'));
  const flow = w.__lastFlow;
  const WATER = 'Desc_Water_C', CEMENT = 'Desc_Cement_C', STONE = 'Desc_Stone_C';
  const wet = flow.nodes.find((n) => n.id === 'wet|' + WATER);
  check('wet-concrete node drawn', !!wet);
  const waterEdges = flow.edges.filter((e) => e.item === WATER);
  check('no machine→machine water edge (backfeed loop gone)',
    !waterEdges.some((e) => e.src.startsWith('mac|') && e.dst.startsWith('mac|')));
  check('water consumers fed from the extractor (raw|Water → machine)',
    waterEdges.some((e) => e.src === 'raw|' + WATER && e.dst.startsWith('mac|')));
  check('water-emitting step feeds the wet node (mac → wet)',
    waterEdges.some((e) => e.src.startsWith('mac|') && e.dst === 'wet|' + WATER));
  check('extractor never feeds the wet node',
    !waterEdges.some((e) => e.src === 'raw|' + WATER && e.dst === 'wet|' + WATER));
  check('wet node draws its raw Limestone',
    flow.edges.some((e) => e.item === STONE && e.src === 'raw|' + STONE && e.dst === 'wet|' + WATER));
  check('wet node\'s Concrete connects onward (sink or output, not floating)',
    flow.edges.some((e) => e.item === CEMENT && e.src === 'wet|' + WATER));
  // Toggle off: route gone, no wet node in the rebuilt chart.
  ws.checked = false; ws.dispatchEvent(new d.defaultView.Event('change', { bubbles: true }));
  check('toggle off removes the wet node', !w.__lastFlow.nodes.some((n) => n.id.startsWith('wet|')));
}

// ---- Multi-factory: whole-base balance + dependency graph ----
console.log('\n### MULTI-FACTORY: BASE BALANCE + DEPENDENCY GRAPH');
{
  const { d, app, setVal, click } = boot13(null);
  const optTab = () => click([...d.querySelectorAll('.tab')].find((t) => t.dataset.mode === 'optimize'));
  // Factory A: optimizer makes 120 Iron Plate from ore.
  optTab();
  const aOut = d.querySelector('#optOutputs .row');
  setVal(aOut.querySelector('.row-item'), 'Iron Plate'); setVal(aOut.querySelector('.row-rate'), '120');
  const planA = app.activePlan();
  // Factory B (same project): makes Reinforced Iron Plate, importing its plates from A.
  click(d.getElementById('planNew'));
  optTab();
  const bOut = d.querySelector('#optOutputs .row');
  setVal(bOut.querySelector('.row-item'), 'Reinforced Iron Plate'); setVal(bOut.querySelector('.row-rate'), '10');
  const planB = app.activePlan();
  click(d.getElementById('optAddInput'));
  setVal(d.querySelector('#optExtraInputs .row .row-link'), planA.id + '|' + cls('Iron Plate'), 'change');

  const bal = app.computeBaseBalance();
  check('balance solves every factory in the project', bal.perPlan.length === 2 && bal.perPlan.every((p) => p.feasible));
  const plate = bal.parts.find((r) => r.item === cls('Iron Plate'));
  check('Iron Plate produced ~120 by factory A', !!plate && Math.abs(plate.produced - 120) < 0.5);
  check('Iron Plate consumed by factory B (linked import)', !!plate && plate.consumed > 1);
  check('surplus Iron Plate floats up as a net positive', !!plate && plate.net > 1 && bal.surpluses.some((r) => r.item === cls('Iron Plate')));
  const linkEdge = bal.depEdges.find((e) => e.kind === 'link' && e.from === planA.id && e.to === planB.id && e.item === cls('Iron Plate'));
  check('a dependency edge links A -> B for Iron Plate', !!linkEdge && linkEdge.bottleneck === false);

  click([...d.querySelectorAll('.tab')].find((t) => t.dataset.mode === 'project'));
  check('project view shows the dependency graph', !d.getElementById('projectView').hidden);
  check('graph draws one node per factory', d.querySelectorAll('#depSvg .dep-node').length === 2);
  check('graph draws at least one edge', d.querySelectorAll('#depSvg path[marker-end]').length >= 1);
  check('balance table is populated', d.querySelectorAll('#projBalanceTable tbody tr').length >= 1);
  check('dependency note reports the linked feed', /linked feed/.test(d.getElementById('depNote').textContent));
}

// ---- Multi-factory: cross-factory shortfall (a part nobody produces enough of) ----
console.log('\n### MULTI-FACTORY: CROSS-FACTORY SHORTFALL');
{
  const { d, app } = boot13(null);
  // One planner factory making Reinforced Iron Plate but IMPORTING its Iron Plate (RAW
  // pick) — no factory in the project produces plates, so they're a shortfall.
  const p = app.activePlan();
  p.state.mode = 'planner';
  p.state.targetItem = cls('Reinforced Iron Plate');
  p.state.targetRate = 30;
  p.state.picks = { [cls('Iron Plate')]: 'RAW' };
  const bal = app.computeBaseBalance();
  const plate = bal.parts.find((r) => r.item === cls('Iron Plate'));
  check('imported part is consumed with zero base production', !!plate && plate.consumed > 0 && plate.produced < 1e-6);
  check('it is flagged a shortfall (net < 0)', !!plate && plate.net < 0 && bal.shortfalls.some((r) => r.item === cls('Iron Plate')));
  app.setMode('project');
  check('shortfall callout is shown', !d.getElementById('projShortfalls').hidden && /shortfall/i.test(d.getElementById('projShortfalls').textContent));
  check('balance table marks the part as a Shortfall',
    [...d.querySelectorAll('#projBalanceTable tbody tr')].some((tr) => /Iron Plate/.test(tr.textContent) && /Shortfall/.test(tr.textContent)));
}

// ---- Multi-factory: bottleneck — one source over-subscribed by two consumers ----
console.log('\n### MULTI-FACTORY: BOTTLENECK (OVER-SUBSCRIBED SOURCE)');
{
  const { d, app, setVal, click } = boot13(null);
  const optTab = () => click([...d.querySelectorAll('.tab')].find((t) => t.dataset.mode === 'optimize'));
  const linkToA = (planAId) => { click(d.getElementById('optAddInput')); setVal(d.querySelector('#optExtraInputs .row .row-link'), planAId + '|' + cls('Iron Plate'), 'change'); };
  // A makes only 20 Iron Plate. B and C BOTH link their plate supply to A — each is handed
  // A's full 20/min, so their combined demand (40) outruns the 20 A actually makes: the
  // shared source is over-subscribed and every feed off it is a bottleneck.
  optTab();
  const aOut = d.querySelector('#optOutputs .row');
  setVal(aOut.querySelector('.row-item'), 'Iron Plate'); setVal(aOut.querySelector('.row-rate'), '20');
  const planA = app.activePlan();
  for (let i = 0; i < 2; i++) {
    click(d.getElementById('planNew'));
    optTab();
    const o = d.querySelector('#optOutputs .row');
    setVal(o.querySelector('.row-item'), 'Reinforced Iron Plate'); setVal(o.querySelector('.row-rate'), '10');
    linkToA(planA.id);
  }
  const bal = app.computeBaseBalance();
  const fed = bal.depEdges.filter((e) => e.kind === 'link' && e.from === planA.id);
  check('both consumers draw a dependency edge from A', fed.length === 2);
  check('the over-subscribed feeds are flagged bottlenecks', fed.length === 2 && fed.every((e) => e.bottleneck === true));
  app.setMode('project');
  check('a bottleneck edge is drawn in red', [...d.querySelectorAll('#depSvg path')].some((pt) => (pt.getAttribute('stroke') || '').includes('ff5b5b')));
}

console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ ' + fail + ' FAILED'} (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
