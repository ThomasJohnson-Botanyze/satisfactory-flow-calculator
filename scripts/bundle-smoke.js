'use strict';
// Smoke test for the esbuild renderer bundle. Loads it in jsdom and runs it in the
// page context (where `require` is undefined — same as the real window with
// contextIsolation on / nodeIntegration off) to catch a bundle that still leaks a
// runtime require or otherwise fails to boot in a browser. Run after build:renderer.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8');
const bundlePath = path.join(root, 'src', 'renderer.bundle.js');
if (!fs.existsSync(bundlePath)) { console.error('bundle-smoke FAILED — renderer.bundle.js not built (run npm run build:renderer)'); process.exit(1); }
const bundle = fs.readFileSync(bundlePath, 'utf8');

let pass = 0, fail = 0;
const check = (label, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); cond ? pass++ : fail++; };

// A browser bundle must carry no runtime CommonJS require( call (esbuild's internal
// shim is __require, which this won't match).
check('bundle has no runtime require( call', !/[^.\w$]require\s*\(/.test(bundle));

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://local/' });
const { window } = dom;
if (!window.SVGElement.prototype.setPointerCapture) window.SVGElement.prototype.setPointerCapture = () => {};
window.localStorage.clear();

let bootError = null;
try {
  window.eval(bundle);               // execute in the page context — no `require` here
  window.dispatchEvent(new window.Event('DOMContentLoaded'));
} catch (e) { bootError = e; }
check('bundle boots without throwing', !bootError);
if (bootError) console.error('   ' + (bootError && bootError.stack || bootError));

const D = window.document;
check('tabs rendered', D.querySelectorAll('.tab').length === 4);
check('item datalist populated from bundled data', D.querySelectorAll('#itemList option').length > 100);
check('save features degrade gracefully without window.api', !!D.getElementById('saveSelect'));
check('no Node require leaked into the page global', typeof window.require === 'undefined');

console.log(`\n${fail === 0 ? '✅ BUNDLE OK' : '❌ ' + fail + ' FAILED'} (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
