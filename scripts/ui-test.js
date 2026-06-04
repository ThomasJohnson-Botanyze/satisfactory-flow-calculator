// Headless end-to-end test of the REAL renderer.js (all 3 modes) against jsdom.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const DATA = require('../src/data.json');
const cls = (name) => Object.keys(DATA.items).find((k) => DATA.items[k].name === name);

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: 'https://local/' });
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
global.location = dom.window.location;
global.Event = dom.window.Event;
localStorage.clear();

require('../src/renderer.js');
dom.window.dispatchEvent(new dom.window.Event('DOMContentLoaded'));

const D = dom.window.document;
const fire = (node, type) => node.dispatchEvent(new dom.window.Event(type, { bubbles: true }));
const setVal = (node, v, type = 'input') => { node.value = v; fire(node, type); };
const clickTab = (mode) => [...D.querySelectorAll('.tab')].find((t) => t.dataset.mode === mode).dispatchEvent(new dom.window.Event('click', { bubbles: true }));

function prodRows() {
  return [...D.querySelectorAll('#prodTable tbody tr')].map((tr) =>
    [...tr.children].map((td) => td.textContent.replace(/\s+/g, ' ').trim()));
}
function rawRows() {
  return [...D.querySelectorAll('#rawTable tbody tr')].map((tr) =>
    [...tr.children].map((td) => td.textContent.replace(/\s+/g, ' ').trim()));
}
function dump(tag) {
  console.log(`\n### ${tag}`);
  console.log('  empty:', D.getElementById('empty').hidden ? 'hidden' : 'SHOWN', '| msg:', D.getElementById('emptyMsg').textContent);
  console.log('  power:', D.getElementById('sumPower').textContent, '| machines:', D.getElementById('sumMachines').textContent);
  const ex = D.getElementById('modeExtras').textContent.replace(/\s+/g, ' ').trim();
  if (ex) console.log('  extras:', ex);
  const banner = D.getElementById('maxBanner');
  if (!banner.hidden) console.log('  banner:', banner.textContent.replace(/\s+/g, ' ').trim());
  console.log('  prod rows:', prodRows().length);
  prodRows().slice(0, 6).forEach((r) => console.log('    ', r[0], '|', r[1], '|', r[3], '|', r[4]));
  if (rawRows().length) { console.log('  raw:'); rawRows().forEach((r) => console.log('    ', r.join(' '))); }
}

// ---- 1) PLANNER ----
clickTab('planner');
setVal(D.getElementById('targetItem'), 'Reinforced Iron Plate');
setVal(D.getElementById('targetRate'), '10');
dump('PLANNER: Reinforced Iron Plate @ 10/min');
console.log('  recipe dropdowns:', D.querySelectorAll('.recipe-select').length);

// ---- 2) OPTIMIZER ----
clickTab('optimize');
setVal(D.querySelector('#optOutputs .row-item'), 'Reinforced Iron Plate');
setVal(D.querySelector('#optOutputs .row-rate'), '60');
setVal(D.getElementById('optObjective'), 'raw', 'change');
dump('OPTIMIZER: 60 RIP/min, all inputs, MIN RAW, alternates ON');

// turn alternates off -> should change recipe selection / raw
D.getElementById('optAlts').checked = false; fire(D.getElementById('optAlts'), 'change');
dump('OPTIMIZER: alternates OFF (standard only)');
D.getElementById('optAlts').checked = true; fire(D.getElementById('optAlts'), 'change');

// objective power
setVal(D.getElementById('optObjective'), 'power', 'change');
dump('OPTIMIZER: objective = lowest power');

// ---- 3) MAX THROUGHPUT ----
clickTab('max');
const supplySel = D.querySelector('#maxSupply .row-item');
setVal(supplySel, cls('Iron Ore'), 'change');
setVal(D.querySelector('#maxSupply .row-rate'), '120');
setVal(D.getElementById('maxProduct'), 'Reinforced Iron Plate');
dump('MAX: 120 Iron Ore -> max Reinforced Iron Plate');

console.log('\nDONE.');
