'use strict';
// Reads a Satisfactory .sav file and extracts which ALTERNATE recipes are unlocked.
//
// Why this works: a .sav stores game *state*, not the static recipe catalog. An
// alternate recipe only appears as an object reference once it has been unlocked
// (it lands in the recipe manager's mAvailableRecipes, and in any machine set to
// it). Locked alternates are never referenced. So scanning the parsed save for
// `Recipe_Alternate_*` strings yields exactly the unlocked set.
//
// Default save location (Windows):
//   %LOCALAPPDATA%\FactoryGame\Saved\SaveGames\<steamId|common>\<SaveName>.sav

const fs = require('fs');
const path = require('path');
const os = require('os');

// data.json is used only to map raw class names -> display names and to report
// which finds are recognized by this app. Kept optional so the module still
// works (raw output) if the data file moves.
let RECIPES = null;
try { RECIPES = require('./data.json').recipes; } catch (e) { RECIPES = null; }

function defaultSaveRoot() {
  const localAppData =
    process.env.LOCALAPPDATA ||
    (process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'AppData', 'Local')) ||
    path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'FactoryGame', 'Saved', 'SaveGames');
}

// List every .sav under the save root (root itself + one level of per-user
// subfolders). Newest first.
function listSaves(root) {
  root = root || defaultSaveRoot();
  const saves = [];
  const scanDir = (dir, folder) => {
    let files;
    try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const f of files) {
      if (f.isFile() && f.name.toLowerCase().endsWith('.sav')) {
        const file = path.join(dir, f.name);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(file).mtimeMs; } catch (e) {}
        saves.push({ name: f.name.replace(/\.sav$/i, ''), file, folder: folder || '', mtimeMs });
      }
    }
  };
  let exists = true;
  let topEntries = [];
  try { topEntries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (e) { exists = false; }
  if (exists) {
    scanDir(root, '');
    for (const e of topEntries) if (e.isDirectory()) scanDir(path.join(root, e.name), e.name);
  }
  saves.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { root, exists, saves };
}

// Matches both the class form (Recipe_Alternate_WetConcrete_C) and the path
// stem (.../Recipe_Alternate_WetConcrete). Underscores/digits are part of the
// name (e.g. Recipe_Alternate_Coal_1_C); the match stops at '.' / '/' / quotes.
const ALT_RE = /Recipe_Alternate_[A-Za-z0-9_]+/g;

// Deep-scan an arbitrary value for alternate-recipe class names. Iterative with a
// depth guard; property graphs from the parser are trees, so no cycle set needed.
function collectAlternates(value, into, depth) {
  if (depth > 96 || value == null) return;
  const t = typeof value;
  if (t === 'string') {
    const m = value.match(ALT_RE);
    if (m) for (let s of m) { if (!s.endsWith('_C')) s += '_C'; into.add(s); }
    return;
  }
  if (t !== 'object') return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) collectAlternates(value[i], into, depth + 1);
    return;
  }
  for (const k in value) collectAlternates(value[k], into, depth + 1);
}

// Pull unlocked alternates out of a parsed SatisfactorySave object.
// Targeted pass first (only manager-ish objects' properties) for speed on large
// saves; falls back to a full scan if that finds nothing.
function extractAlternates(save) {
  const levels = (save && save.levels) || {};
  const found = new Set();

  const MANAGER_RE = /Recipe|Unlock|Schematic|GamePhase|GameState/i;
  for (const lvlName in levels) {
    const objs = (levels[lvlName] && levels[lvlName].objects) || [];
    for (const obj of objs) {
      if (obj && typeof obj.typePath === 'string' && MANAGER_RE.test(obj.typePath)) {
        collectAlternates(obj.properties, found, 0);
      }
    }
  }
  if (found.size) return found;

  // Fallback: scan everything (machine current-recipe refs etc. are still ⊆ unlocked).
  for (const lvlName in levels) {
    const objs = (levels[lvlName] && levels[lvlName].objects) || [];
    for (const obj of objs) collectAlternates(obj && obj.properties, found, 0);
  }
  return found;
}

// Read + parse a .sav and return the unlocked alternates.
// { ok, saveName, alternates:[classNames], recognized:[{className,name}], unknown:[classNames], error }
function readUnlockedAlternates(savFile) {
  let buf;
  try {
    buf = fs.readFileSync(savFile);
  } catch (e) {
    const locked = e && (e.code === 'EBUSY' || e.code === 'EPERM');
    return {
      ok: false,
      error: locked
        ? 'Save file is locked (game running?). Close Satisfactory or copy the .sav elsewhere and pick that.'
        : 'Could not read save: ' + (e && e.message ? e.message : String(e)),
    };
  }

  let save;
  try {
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    // Lazy-require so listSaves()/path logic still work even if the parser dep is absent.
    const { Parser } = require('@etothepii/satisfactory-file-parser');
    save = Parser.ParseSave(path.basename(savFile), ab, { throwErrors: true });
  } catch (e) {
    return {
      ok: false,
      error:
        'Failed to parse save (save format may be newer than the parser supports): ' +
        (e && e.message ? e.message : String(e)),
    };
  }

  const altSet = extractAlternates(save);
  const alternates = [...altSet].sort();
  const recognized = [];
  const unknown = [];
  for (const rc of alternates) {
    if (RECIPES && RECIPES[rc]) recognized.push({ className: rc, name: RECIPES[rc].name });
    else unknown.push(rc);
  }
  return { ok: true, saveName: path.basename(savFile, '.sav'), alternates, recognized, unknown };
}

module.exports = {
  defaultSaveRoot,
  listSaves,
  extractAlternates,
  collectAlternates,
  readUnlockedAlternates,
};

// CLI harness: `node src/save-reader.js [path-to-save-or-root]`
if (require.main === module) {
  const arg = process.argv[2];
  if (arg && /\.sav$/i.test(arg)) {
    console.log(JSON.stringify(readUnlockedAlternates(arg), null, 2));
  } else {
    const { root, exists, saves } = listSaves(arg);
    console.log('Save root:', root, exists ? '' : '(not found)');
    for (const s of saves) console.log(`  ${s.folder ? s.folder + '/' : ''}${s.name}.sav`);
    if (saves.length) {
      console.log('\nNewest save:', saves[0].name);
      console.log(JSON.stringify(readUnlockedAlternates(saves[0].file), null, 2));
    }
  }
}
