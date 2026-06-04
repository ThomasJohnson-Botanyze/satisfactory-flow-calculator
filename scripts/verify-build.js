'use strict';
// Post-package sanity check. v1.2.0 shipped from electron-packager with its
// node_modules stripped, so every require in the renderer threw at load and the
// app came up dead (blank tabs, empty dropdowns, no saved factories shown). This
// runs as `postpackage` and fails the build if the packaged app.asar is missing
// any runtime dependency or sibling source file, so a broken bundle can never
// ship silently again.
const fs = require('fs');
const path = require('path');

// Resolve @electron/asar (bundled by electron-packager); fall back to legacy asar.
let asar;
try { asar = require('@electron/asar'); } catch (_) {
  try { asar = require('asar'); } catch (e2) {
    console.error('verify-build: asar module not found (install deps first).');
    process.exit(1);
  }
}

const appDir = process.argv[2] || 'C:/Users/tjjrj/build-out/SatisfactoryFlowCalculator-win32-x64';
const archive = path.join(appDir, 'resources', 'app.asar');

if (!fs.existsSync(archive)) {
  console.error('verify-build FAILED — no app.asar at: ' + archive);
  process.exit(1);
}

const REQUIRED = [
  'src/renderer.js',
  'src/index.html',
  'src/data.json',
  'src/solver-lp.js',
  'src/save-reader.js',
  'src/building-meta.js',
  'src/factory-extract.js',
  'node_modules/javascript-lp-solver/package.json',
  'node_modules/@etothepii/satisfactory-file-parser/package.json',
  'node_modules/pako/package.json',
];

let entries;
try {
  entries = asar.listPackage(archive).map((f) => f.replace(/^[\\/]+/, '').replace(/\\/g, '/'));
} catch (e) {
  console.error('verify-build FAILED — could not read ' + archive + ': ' + e.message);
  process.exit(1);
}

const have = new Set(entries);
const missing = REQUIRED.filter((r) => !have.has(r));
if (missing.length) {
  console.error('verify-build FAILED — packaged app.asar is missing required files:');
  for (const m of missing) console.error('  - ' + m);
  console.error('\nMost likely the runtime deps were not installed before packaging, or --prune removed them.');
  console.error('Run `npm install` then re-run `npm run package`.');
  process.exit(1);
}

console.log('verify-build OK — ' + REQUIRED.length + ' required files present in app.asar (' + entries.length + ' total entries).');
