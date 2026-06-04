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
let ITEMS = null;
try { const D = require('./data.json'); RECIPES = D.recipes; ITEMS = D.items; } catch (e) { RECIPES = null; ITEMS = null; }

// Pure, dependency-free building extraction (operates on a parsed save).
const { extractBuildings, summarize } = require('./factory-extract');

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

// Read + parse a .sav once. { ok, save, saveName } or { ok:false, error }.
// Shared by readUnlockedAlternates and readResourceNodes so a save is never
// read/parsed twice for the same call.
function parseSaveFile(savFile) {
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
  try {
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    // Lazy-require so listSaves()/path logic still work even if the parser dep is absent.
    const { Parser } = require('@etothepii/satisfactory-file-parser');
    const save = Parser.ParseSave(path.basename(savFile), ab, { throwErrors: true });
    return { ok: true, save, saveName: path.basename(savFile, '.sav') };
  } catch (e) {
    return {
      ok: false,
      error:
        'Failed to parse save (save format may be newer than the parser supports): ' +
        (e && e.message ? e.message : String(e)),
    };
  }
}

// Read + parse a .sav and return the unlocked alternates.
// { ok, saveName, alternates:[classNames], recognized:[{className,name}], unknown:[classNames], error }
function readUnlockedAlternates(savFile) {
  const p = parseSaveFile(savFile);
  if (!p.ok) return { ok: false, error: p.error };

  const altSet = extractAlternates(p.save);
  const alternates = [...altSet].sort();
  const recognized = [];
  const unknown = [];
  for (const rc of alternates) {
    if (RECIPES && RECIPES[rc]) recognized.push({ className: rc, name: RECIPES[rc].name });
    else unknown.push(rc);
  }
  return { ok: true, saveName: p.saveName, alternates, recognized, unknown };
}

// ---------- resource nodes (for the map view) ----------
// Resource-bearing actors the game persists with a world position. Their resource
// type and purity live in *Override properties — which the Resource Node
// Randomizer mod writes — so reading the save is the only way to know a
// randomized map's true node layout. (Vanilla untouched nodes have no override;
// their resource is static map data not stored in the save.)
const NODE_KIND = {
  BP_ResourceNode_C: 'node',
  BP_ResourceNodeGeyser_C: 'geyser',
  BP_FrackingCore_C: 'frackingCore',
  BP_FrackingSatellite_C: 'frackingSatellite',
  BP_ResourceDeposit_C: 'deposit',
};
function nodeKindOf(typePath) {
  const stem = typePath.slice(typePath.lastIndexOf('.') + 1); // BP_ResourceNode.BP_ResourceNode_C -> BP_ResourceNode_C
  return NODE_KIND[stem] || null;
}
// "/Game/.../CrudeOil/Desc_LiquidOil.Desc_LiquidOil_C" -> "Desc_LiquidOil_C"
function classFromPath(pathName) {
  if (!pathName) return null;
  const s = String(pathName);
  const dot = s.lastIndexOf('.');
  return dot >= 0 ? s.slice(dot + 1) : s;
}
const PURITY_LABEL = { RP_Pure: 'Pure', RP_Normal: 'Normal', RP_Inpure: 'Impure' };

// Pull every resource node out of a parsed save with world position + (when
// present) resource class and purity.
function extractResourceNodes(save) {
  const levels = (save && save.levels) || {};
  const out = [];
  for (const lvlName in levels) {
    const objs = (levels[lvlName] && levels[lvlName].objects) || [];
    for (const o of objs) {
      const tp = o && o.typePath;
      if (typeof tp !== 'string') continue;
      const kind = nodeKindOf(tp);
      if (!kind) continue;
      const tr = o.transform && o.transform.translation;
      if (!tr) continue;
      const props = o.properties || {};
      const purRaw = props.mPurityOverride && props.mPurityOverride.value && props.mPurityOverride.value.value;
      const resPath = props.mResourceClassOverride && props.mResourceClassOverride.value && props.mResourceClassOverride.value.pathName;
      const resClass = classFromPath(resPath);
      out.push({
        kind,
        x: tr.x,
        y: tr.y,
        z: tr.z,
        purity: purRaw ? (PURITY_LABEL[purRaw] || String(purRaw).replace(/^RP_/, '')) : null,
        resourceClass: resClass || null,
        name: resClass && ITEMS && ITEMS[resClass] ? ITEMS[resClass].name : null,
      });
    }
  }
  return out;
}

// Read + parse a .sav and return its resource nodes for the map.
// { ok, saveName, nodes:[{kind,x,y,z,purity,resourceClass,name}], counts:{kind:n}, error }
function readResourceNodes(savFile) {
  const p = parseSaveFile(savFile);
  if (!p.ok) return { ok: false, error: p.error };
  const nodes = extractResourceNodes(p.save);
  const counts = {};
  for (const n of nodes) counts[n.kind] = (counts[n.kind] || 0) + 1;
  return { ok: true, saveName: p.saveName, nodes, counts };
}

// Read + parse a .sav and return its placed buildings for the factory overlay.
// { ok, saveName, buildings:[{className,kind,x,y,z,yaw,sx,sy,overclock,boost,swatch,path?}],
//   counts:{total,byKind,byClass}, error }
function readBuildings(savFile) {
  const p = parseSaveFile(savFile);
  if (!p.ok) return { ok: false, error: p.error };
  const buildings = extractBuildings(p.save);
  return { ok: true, saveName: p.saveName, buildings, counts: summarize(buildings) };
}

// Read a save ONCE and return everything the map view needs — resource nodes and
// placed buildings — so a single parse feeds both overlays.
// { ok, saveName, nodes, nodeCounts, buildings, buildingCounts, error }
function readMap(savFile) {
  const p = parseSaveFile(savFile);
  if (!p.ok) return { ok: false, error: p.error };
  const nodes = extractResourceNodes(p.save);
  const nodeCounts = {};
  for (const n of nodes) nodeCounts[n.kind] = (nodeCounts[n.kind] || 0) + 1;
  const buildings = extractBuildings(p.save);
  return {
    ok: true,
    saveName: p.saveName,
    nodes,
    nodeCounts,
    buildings,
    buildingCounts: summarize(buildings),
  };
}

module.exports = {
  defaultSaveRoot,
  listSaves,
  parseSaveFile,
  extractAlternates,
  collectAlternates,
  readUnlockedAlternates,
  extractResourceNodes,
  readResourceNodes,
  extractBuildings,
  readBuildings,
  readMap,
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
