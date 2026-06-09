'use strict';
// Load the bundled modules behind a guard. If a packaging mistake ships the app
// without its runtime deps or sibling files (e.g. node_modules got stripped by an
// over-eager --prune), every top-level require throws and the whole renderer dies
// silently — blank tabs, empty dropdowns, no plan list, which reads to the user as
// "it deleted my factories." Catch that, show a readable error, and make clear the
// saved data is untouched (it lives in localStorage, not in the app bundle).
// data/solver/building-meta are pure compute and get bundled into this script by
// esbuild (so the renderer needs no Node require at runtime, which lets the window
// run with contextIsolation on / nodeIntegration off).
let DATA, LP, BMETA, PX;
try {
  DATA = require('./data.json');
  LP = require('./solver-lp');
  BMETA = require('./building-meta');
  PX = require('./production-xray'); // pure aggregation, bundled so the page re-scopes the X-ray locally
} catch (err) {
  showFatalLoadError(err);
  throw err; // the rest of the renderer can't run without these — halt cleanly
}
function showFatalLoadError(err) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;padding:32px;background:#15171c;color:#e6e8ee;font:15px/1.55 system-ui,Segoe UI,Roboto,sans-serif';
  box.innerHTML =
    '<div style="max-width:640px">' +
    '<h1 style="margin:0 0 12px;font-size:20px;color:#ff6b6b">This build is missing a component</h1>' +
    '<p>The app couldn’t start because a bundled dependency failed to load:</p>' +
    '<pre style="white-space:pre-wrap;background:#1e2129;padding:12px;border-radius:8px;color:#ffb4a2;margin:8px 0 16px">' +
    esc((err && err.message) || err) + '</pre>' +
    '<p><strong>Your saved factories are safe.</strong> They’re stored separately and were not touched — ' +
    'reinstalling a correct build brings them back. This is a packaging bug, not data loss.</p>' +
    '</div>';
  const attach = () => document.body.appendChild(box);
  if (document.body) attach();
  else document.addEventListener('DOMContentLoaded', attach);
}

// ---------- preload bridge (Node-side helpers) ----------
// With contextIsolation on the renderer has no Node access; file reading and shell
// links are exposed by preload.js via contextBridge as window.api. Guarded so the
// renderer (and the jsdom test harness) still loads when the bridge is absent — the
// save features simply report unavailable rather than throwing at load.
const api = (typeof window !== 'undefined' && window.api) ? window.api : null;
const SAVE_UNAVAILABLE = { ok: false, error: 'Save reading is unavailable in this context.' };
const SAVE = {
  listSaves: (root) => (api ? api.listSaves(root) : { exists: false, saves: [] }),
  readUnlockedAlternates: (file) => (api ? api.readUnlockedAlternates(file) : SAVE_UNAVAILABLE),
  readMap: (file) => (api ? api.readMap(file) : SAVE_UNAVAILABLE),
  readProduction: (file, opts) => (api ? api.readProduction(file, opts) : SAVE_UNAVAILABLE),
  readProductionRecords: (file) => (api ? api.readProductionRecords(file) : SAVE_UNAVAILABLE),
};

// ---------- support links ----------
const SUPPORT_LINKS = {
  kofi: 'https://ko-fi.com/satisfactoryflow',
};
const openExternal = (url) => { if (api && api.openExternal) api.openExternal(url); else window.open(url, '_blank', 'noopener'); };

// ---------- appearance / theming (app-wide, separate from per-plan state) ----------
// Theme overrides live in their own localStorage key, NOT in the plan store. That
// keeps them out of the durable plans.json sync (no risk of a bad theme value
// corrupting a plan / the "blank app" class of bug) and makes them genuinely
// app-wide rather than per-factory. Absent / malformed prefs fall back to the
// stylesheet defaults, so a fresh install (or a wiped key) renders the dark theme.
const THEME_KEY = 'satisfactory-app-prefs-v1';
// The CSS custom properties the Appearance panel can override, with human labels.
const THEME_VARS = [
  ['--bg', 'Background'], ['--panel', 'Panel'], ['--panel-2', 'Panel (raised)'],
  ['--line', 'Borders'], ['--text', 'Text'], ['--muted', 'Muted text'],
  ['--accent', 'Accent'], ['--accent-2', 'Accent 2'],
  ['--good', 'Good / output'], ['--warn', 'Warning'],
];
// Captured once at load, BEFORE any override is applied, so "Reset to default" and
// the Dark preset always restore the stylesheet's :root palette verbatim.
const THEME_DEFAULTS = (() => {
  const out = {};
  try {
    const cs = getComputedStyle(document.documentElement);
    for (const [v] of THEME_VARS) out[v] = (cs.getPropertyValue(v) || '').trim();
  } catch (_) {}
  return out;
})();
const THEME_PRESETS = {
  dark: { name: 'Dark (default)', vars: {} }, // empty => stylesheet defaults
  contrast: {
    name: 'High contrast',
    vars: {
      '--bg': '#000000', '--panel': '#0d0d0d', '--panel-2': '#1a1a1a',
      '--line': '#5a5a5a', '--text': '#ffffff', '--muted': '#cfcfcf',
      '--accent': '#ffd400', '--accent-2': '#ff8a3d', '--good': '#46e06a', '--warn': '#ff5b5b',
    },
  },
  ocean: {
    name: 'Ocean',
    vars: {
      '--bg': '#0e1820', '--panel': '#13212c', '--panel-2': '#1a2c39',
      '--line': '#2b4150', '--text': '#e6f0f5', '--muted': '#8fa7b5',
      '--accent': '#34c6c0', '--accent-2': '#4f9bd9', '--good': '#5fcf8a', '--warn': '#ef6a5a',
    },
  },
};
// { preset: <key>, custom: { '--var': '#hex', ... } }. custom overrides win over the
// preset so a tweaked-then-saved palette survives. Missing/garbage => dark.
let themePrefs = { preset: 'dark', custom: {} };
function loadThemePrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(THEME_KEY));
    if (raw && typeof raw === 'object') {
      themePrefs = {
        preset: THEME_PRESETS[raw.preset] ? raw.preset : 'dark',
        custom: (raw.custom && typeof raw.custom === 'object') ? raw.custom : {},
      };
    }
  } catch (_) { themePrefs = { preset: 'dark', custom: {} }; }
}
const saveThemePrefs = () => { try { localStorage.setItem(THEME_KEY, JSON.stringify(themePrefs)); } catch (_) {} };
// Effective value of one var = explicit custom override, else preset, else stylesheet default.
function themeVal(v) {
  if (themePrefs.custom && themePrefs.custom[v]) return themePrefs.custom[v];
  const p = THEME_PRESETS[themePrefs.preset];
  if (p && p.vars[v]) return p.vars[v];
  return THEME_DEFAULTS[v] || '';
}
// Push the effective palette onto :root. For the dark preset with no custom tweaks
// we clear inline overrides so the stylesheet wins (keeps the cascade clean).
function applyTheme() {
  const root = document.documentElement;
  for (const [v] of THEME_VARS) {
    const cust = themePrefs.custom && themePrefs.custom[v];
    const preset = THEME_PRESETS[themePrefs.preset];
    const presetVal = preset && preset.vars[v];
    const val = cust || presetVal;
    if (val) root.style.setProperty(v, val);
    else root.style.removeProperty(v); // fall back to :root stylesheet default
  }
}
// Read the live computed value of a CSS var (post-theme) — used by canvas/PNG code
// that can't rely on the CSS cascade. Falls back to the captured default.
function cssVar(name) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (v) return v;
  } catch (_) {}
  return THEME_DEFAULTS[name] || '';
}

// ---------- update notifier (Level 1) ----------
// main.js polls GitHub Releases on launch and fires 'update-available' when a
// newer version is published — delivered to the page via the preload bridge
// (window.api.onUpdateAvailable), since the renderer has no ipcRenderer under
// contextIsolation. Show a non-blocking toast; "Download" opens the release page
// for a manual install. Dismissing a given version is remembered so we don't nag.
function showUpdateToast(info) {
  if (!info || !info.version) return;
  try { if (localStorage.getItem('updateDismissed') === info.version) return; } catch (_) {}
  const toast = document.getElementById('updateToast');
  if (!toast) return;
  const msg = document.getElementById('updateMsg');
  if (msg) msg.textContent = `Version ${info.version} is ready to install.`;
  document.getElementById('updateGet').onclick = () => {
    if (info.url) openExternal(info.url);
    toast.hidden = true;
  };
  document.getElementById('updateDismiss').onclick = () => {
    try { localStorage.setItem('updateDismissed', info.version); } catch (_) {}
    toast.hidden = true;
  };
  toast.hidden = false;
}
if (api && api.onUpdateAvailable) api.onUpdateAvailable((info) => showUpdateToast(info));
// Auto-load the newest save when the game writes one (main process watches the folder).
if (api && api.onSaveNewest) api.onSaveNewest((info) => { try { onNewestSave(info); } catch (_) {} });

// ---------- indexes ----------
const ITEMS = DATA.items;
const RECIPES = DATA.recipes;
const BUILDINGS = DATA.buildings;
const RESOURCES = new Set(DATA.resources);
// Power-planner data (added in 1.x for the Power Planner tab). POWERGEN holds every
// generator with its fuels{item->burn/min @100%} and optional supplemental water;
// EXTRACTORS holds miners/pumps with rate/min @100% normal purity + power draw.
const POWERGEN = DATA.powergen || {};
const EXTRACTORS = DATA.extractors || {};
// Node purity output multipliers (impure ½ · normal 1 · pure 2). Applied to a miner/
// pump's normal-purity rate. Water Extractors have no purity (EXTRACTORS[x].purity=false).
const PURITY = { impure: 0.5, normal: 1, pure: 2 };
const WATER_ITEM = 'Desc_Water_C';
const SVGNS = 'http://www.w3.org/2000/svg';

const itemName = (c) => (ITEMS[c] ? ITEMS[c].name : c);
const isFluid = (c) => !!(ITEMS[c] && ITEMS[c].liquid);
const isDeliverable = (c) => /Desc_SpaceElevatorPart_\d+_C/.test(c);

// exact Satisfactory Advanced Game Settings value lists
const GAME = {
  recipe: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
  power: [0.25, 0.5, 0.75, 1, 2, 5],
  space: [0.25, 0.5, 0.75, 1, 2, 5, 10, 25, 50, 100],
};

const recipesByProduct = {};
const recipesByPrimary = {};
const recipesByBuilding = {};
for (const rc in RECIPES) {
  const r = RECIPES[rc];
  r.products.forEach((p, idx) => {
    (recipesByProduct[p.item] = recipesByProduct[p.item] || []).push(rc);
    if (idx === 0) (recipesByPrimary[p.item] = recipesByPrimary[p.item] || []).push(rc);
  });
  (recipesByBuilding[r.building] = recipesByBuilding[r.building] || []).push(rc);
}
// Buildings that actually craft recipes, with display name + recipe count — the universe
// for the F4 "turn off a building" checkboxes. Sorted by name for a stable list.
const buildingList = Object.keys(recipesByBuilding)
  .map((b) => ({ b, name: (BUILDINGS[b] && BUILDINGS[b].name) || b, count: recipesByBuilding[b].length }))
  .sort((a, c) => a.name.localeCompare(c.name));
// Unpackaging a fluid (Packaged Turbofuel -> Turbofuel + Canister) is never the real way
// to PRODUCE that fluid — it just reverses packaging. Auto-picking it as a default closes
// a package<->unpackage loop the planner can't source (Turbofuel/Rocket Fuel go infeasible,
// Heavy Oil Residue spins), which reads as an "infinite loop between the fuel and packaged
// fuel recipes". So unpackage recipes are excluded from default selection; the user can
// still choose one explicitly from the recipe dropdown.
const isUnpackageRecipe = (rc) => /unpackage/i.test(rc) || /^Unpackage/i.test((RECIPES[rc] && RECIPES[rc].name) || '');
function defaultRecipeClass(item) {
  // Skip unpackage recipes (loop bait) and any recipe the user has blocked outright —
  // a blocked standard recipe falls through to an enabled alternate, else to raw (null).
  const usable = (rc) => !isUnpackageRecipe(rc) && !recipeBlocked(rc);
  // 1) A standard recipe whose PRIMARY product is this item — the normal case.
  const stdPrim = (recipesByPrimary[item] || []).find((rc) => !RECIPES[rc].alternate && usable(rc));
  if (stdPrim) return stdPrim;
  // 2) An unlocked alternate whose PRIMARY product is this item. Prefer making the item
  //    on purpose over pulling it out of some unrelated recipe as a by-product: a
  //    by-product recipe drags in a whole foreign chain and can even close a loop
  //    (Turbofuel's only non-unpackage producers are alternates, and Compacted Coal is a
  //    by-product of Rocket Fuel which itself needs Turbofuel — picking by-product
  //    recipes there makes Turbofuel <-> Compacted Coal spin).
  const altPrim = (recipesByPrimary[item] || []).find((rc) => usable(rc) && altEnabled(rc));
  if (altPrim) return altPrim;
  // 3) Item is only ever a by-product (e.g. Dissolved Silica): fall back to any recipe
  //    that produces it so the planner BUILDS it instead of listing it as an unobtainable
  //    raw input. Prefer standard; otherwise an unlocked alternate; else leave raw (null).
  const producers = (recipesByProduct[item] || []).filter(usable);
  const stdAny = producers.find((rc) => !RECIPES[rc].alternate);
  if (stdAny) return stdAny;
  return producers.find((rc) => altEnabled(rc)) || null;
}
// Is recipe rc usable given the unlocked-from-save filter? Standard recipes are
// always available; alternates only when no save is loaded (state.unlockedAlts
// null) or when present in the unlocked list.
function altUnlocked(rc) {
  const r = RECIPES[rc];
  if (!r || !r.alternate) return true;
  if (!state.unlockedAlts) return true;
  return state.unlockedAlts.includes(rc);
}
const ALT_CLASSES = Object.keys(RECIPES).filter((rc) => RECIPES[rc].alternate);
// Standard (non-alternate) recipes the user can veto (F1). Unpackage recipes are omitted —
// they're never auto-selected anyway and would only clutter the list.
const STD_CLASSES = Object.keys(RECIPES).filter((rc) => !RECIPES[rc].alternate && !isUnpackageRecipe(rc));
// Recipes blocked outright by the user (F1) plus every recipe of a disabled building
// (F4, expanded here so the building toggle is a thin layer over the recipe blocklist).
// A blocked recipe is unavailable to planner/optimizer/max alike. Recomputed per call so
// it always reflects the active plan's state; cheap (a couple of array scans).
function blockedRecipeSet() {
  const set = new Set(state.disabledRecipes || []);
  for (const b of state.disabledBuildings || []) for (const rc of recipesByBuilding[b] || []) set.add(rc);
  return set;
}
// True when recipe rc is forbidden outright (standalone veto or its building is off).
const recipeBlocked = (rc) => blockedRecipeSet().has(rc);
// Effective gate = not blocked AND (for alternates) unlocked by the save AND not vetoed.
function altEnabled(rc) {
  if (recipeBlocked(rc)) return false;
  const r = RECIPES[rc];
  if (!r || !r.alternate) return true;
  if ((state.disabledAlts || []).includes(rc)) return false;
  return altUnlocked(rc);
}
// Set of alternates the solver may use, or null when there is no restriction at all.
// (The standard/building blocklist is passed to the solver separately via blockedRecipeSet.)
function effectiveAltSet() {
  const disabled = state.disabledAlts || [];
  if (!state.unlockedAlts && !disabled.length) return null;
  const base = state.unlockedAlts || ALT_CLASSES;
  return new Set(base.filter((rc) => !disabled.includes(rc)));
}
// Sole-producer guard for F1/F4: given item classNames, return those non-raw items that
// HAD a producer in the game data but now have none enabled because the user blocked
// every one (standalone recipe veto or a disabled building). These would otherwise turn
// into a phantom raw input / infeasible plan with no obvious cause — name them so the UI
// can explain it. Items that are simply raw resources, or were always producerless, are
// not reported (that's not a blocking-induced problem).
function blockedOrphans(itemClasses) {
  const blocked = blockedRecipeSet();
  const out = [];
  for (const it of itemClasses) {
    if (RESOURCES.has(it)) continue;
    const producers = recipesByProduct[it] || [];
    if (!producers.length) continue; // never producible — not a blocking issue
    const anyEnabled = producers.some((rc) => !blocked.has(rc) && altEnabled(rc));
    if (!anyEnabled) out.push(it);
  }
  return out;
}
const targetable = Object.keys(recipesByPrimary).map((c) => ({ c, n: itemName(c) })).sort((a, b) => a.n.localeCompare(b.n));
const resList = [...RESOURCES].map((c) => ({ c, n: itemName(c) })).sort((a, b) => a.n.localeCompare(b.n));
const nameToClass = (name) => {
  const k = (name || '').trim().toLowerCase();
  const hit = targetable.find((t) => t.n.toLowerCase() === k);
  return hit ? hit.c : '';
};
// Any item that can serve as an input/supply: raw resources + every producible
// item (so an Optimizer/Max run can start from an intermediate like Iron Plate,
// not just the 13 raw resources). Deduped, sorted by name.
const inputItems = (() => {
  const seen = new Set(); const arr = [];
  for (const t of [...resList, ...targetable]) if (!seen.has(t.c)) { seen.add(t.c); arr.push(t); }
  return arr.sort((a, b) => a.n.localeCompare(b.n));
})();
const anyNameToClass = (name) => {
  const k = (name || '').trim().toLowerCase();
  const hit = inputItems.find((t) => t.n.toLowerCase() === k);
  return hit ? hit.c : '';
};

// ---------- state ----------
const defaultState = () => ({
  mode: 'optimize', // Recipe Optimizer is the default landing tab (Planner is demoted in the nav)
  // NOTE: `prodMode` (the plan's last PRODUCTION tab: optimize | max | planner) is set
  // lazily by setMode, NOT defaulted here — a default would override the legacy
  // fall-back for plans saved before the field existed (see computeStateResult).
  view: 'tables',
  targetItem: '',
  targetRate: 60,
  // Where the primary target's production is routed: 'line' (a normal line product,
  // the default), 'depot' (Dimensional Depot) or 'storage'. Absent on plans saved
  // before this existed → treated as 'line' by normDest()/destOf().
  targetDest: 'line',
  // Additional desired outputs for the Planner, beyond the primary target above.
  // Each { name, rate, dest }. dest is 'line' | 'depot' | 'storage' (absent = 'line').
  // The primary stays in targetItem/targetRate so it keeps syncing across the
  // Planner/Optimizer/Max tabs; these extras are Planner-local.
  extraTargets: [],
  clock: 1.0,
  // When on, the plan is scaled to the nearest output that makes every step a whole
  // number of machines (clean ratios, zero over/underclocking). See applyCleanScale.
  cleanRatio: false,
  recipeCost: 1,
  powerMult: 1,
  spaceMult: 1,
  picks: {},
  // Per-step overclock overrides, keyed by recipe className (rc -> clock fraction).
  // Absent = that step follows the global Overclock slider (state.clock).
  nodeClock: {},
  // Per-step Somersloop counts, keyed by recipe className (rc -> shards installed
  // per machine, 0..the building's slot count). Absent/0 = no amplification. There's
  // no global slider: Somersloops are scarce (~hundred-ish per save), so you sloop
  // individual steps (the final one, or a material hog), not the whole factory.
  nodeSloop: {},
  flowPos: {}, // saved flowchart node positions for this plan (nodeId -> {x,y})
  flowView: null, // saved flowchart zoom/pan for this plan ({k, tx, ty}); null = fit on render
  // When on, the flowchart shows power infrastructure (opt-in): miner/extractor nodes at
  // the front feeding each raw, and generator nodes at the end burning the outputs added
  // in the Power Planner. Off by default so existing charts are unchanged. Per-plan.
  flowPower: false,
  // null = no save loaded → every alternate available (original behavior).
  // [] = a save was read but no alternates unlocked. [...classNames] = restrict to these.
  unlockedAlts: null,
  saveName: '',
  // Last selected .sav path — shared by the alternates picker and the map picker,
  // and remembered across sessions so neither has to be re-chosen (world-level).
  saveFile: '',
  // When on, auto-reload the newest save (alternates + any loaded map) whenever the game
  // writes one. World-level. Main process watches the save folder; see onNewestSave.
  autoSave: true,
  // Alternate recipe classNames the user has manually excluded from this plan's
  // calculations (independent of unlock status — vetoes even unlocked/optimal ones).
  disabledAlts: [],
  // Recipe classNames blocked outright — covers STANDARD recipes too (the alternate
  // veto above can't reach those), so "never use the base recipe for X" is possible.
  // Back-compat default = [] so plans saved before this feature load unchanged.
  disabledRecipes: [],
  // Building classNames whose every recipe is excluded in one action (e.g. turn off the
  // Converter). A thin layer over disabledRecipes, keyed by building. Default = [].
  disabledBuildings: [],
  opt: {
    outputs: [{ name: '', rate: 60 }],
    inputs: Object.fromEntries(resList.map((r) => [r.c, { on: true, cap: '' }])),
    // Extra non-resource inputs the optimizer may consume freely (e.g. a supplied
    // intermediate). Each { name, cap }; blank cap = unlimited. A row may also carry
    // an optional { fromPlanId, fromItem } link (Project feature): when set, its cap is
    // driven by the source plan's recorded net output of fromItem, not the manual cap.
    extraInputs: [],
    objective: 'raw',
    alts: true,
    sink: true, // route surplus by-products to the Awesome Sink / Fuel Generator
    waterSink: false, // dispose excess by-product Water via Wet Concrete (off = old loop/float)
  },
  // Max-supply rows are { item, amount }, optionally + { fromPlanId, fromItem } so the
  // amount tracks an upstream plan's output (same Project link as opt.extraInputs).
  max: { supply: [{ item: resList[0] ? resList[0].c : '', amount: 120 }], product: '', alts: true },
  // Power Planner: a whole-factory power ledger over this plan's production. sourceMode =
  // which production solve to read (optimize|max|planner); minerTier = miner used for solid
  // raws; purity = per-resource node purity (rawClass -> impure|normal|pure); gens = the
  // generators you've added to burn an output, each { output: fuelClass, gen: genClass }.
  power: {
    sourceMode: 'optimize',
    minerTier: 'Build_MinerMk1_C',
    purity: {},
    gens: [],
    // Global overclock % (1–250). minerClock applies to every miner/extractor (power
    // ∝ clock^exponent — overclocking trades buildings for power). genClock applies to
    // every generator (changes how many you run; gross power & water are clock-invariant).
    minerClock: 100,
    genClock: 100,
  },
  // Net outputs of this plan's last solve (itemClass -> rate/min), recorded so a
  // downstream plan can link an input to it. Per-plan + persisted so links resolve on
  // load before any re-solve. Empty by default (no outputs known yet).
  netOutputs: {},
  // Base X-ray: a polygon (world centimetres, [{x,y},...]) the user draws on the map to
  // mark THIS plan's factory footprint. The X-ray tab scopes its analysis to the machines
  // inside it. null/<3 points = no area drawn yet (the X-ray tab routes to the map to draw
  // one). Per-plan so each factory carves out its own slice of the shared save.
  xrayRegion: null,
  // When on, the X-ray ignores xrayRegion and analyzes the whole save (the original
  // whole-base view). Per-plan toggle; default off = scoped to the drawn area.
  xrayWholeBase: false,
});
let state = defaultState();

// ---------- factory plans (multiple saved calculators) ----------
let plans = [];
let activeId = null;
const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const activePlan = () => plans.find((p) => p.id === activeId);

// ---------- projects (group several plans/factories; one plan's output can feed
// another plan's input) ----------
// A project is just { id, name }; plans belong to a project via plan.projectId. The
// active project filters which plans the plan-bar shows. There is always at least one
// project and at least one plan (load() guarantees this), so the UI never hits zero.
let projects = [];
let activeProjectId = null;
const newProjId = () => 'prj' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const activeProject = () => projects.find((p) => p.id === activeProjectId);
const plansInProject = (pid) => plans.filter((p) => p.projectId === pid);
const activeProjectPlans = () => plansInProject(activeProjectId);

const LS_KEY = 'satisfactory-flow-plan-v3'; // legacy single-plan store (migration source)
const PLANS_KEY = 'satisfactory-factory-plans-v1'; // multi-plan store

// Settings that belong to the whole game/world rather than one factory — they
// carry over across every plan: the game-save unlocked alternates and the three
// cost multipliers. (disabledAlts stays per-plan: a manual veto for that factory.)
const GLOBAL_KEYS = ['recipeCost', 'powerMult', 'spaceMult', 'unlockedAlts', 'saveName', 'saveFile', 'autoSave'];
const cloneVal = (v) => (Array.isArray(v) ? v.slice() : v);
const pickGlobals = (s) => { const g = {}; for (const k of GLOBAL_KEYS) g[k] = cloneVal(s[k]); return g; };
const applyGlobals = (s, g) => { for (const k of GLOBAL_KEYS) if (k in g) s[k] = cloneVal(g[k]); };
// Mirror the active plan's global settings into every plan; returns the snapshot.
const syncGlobals = () => { const g = pickGlobals(state); for (const p of plans) applyGlobals(p.state, g); return g; };

function mergeState(s) {
  const m = Object.assign(defaultState(), s || {});
  m.opt = Object.assign(defaultState().opt, (s && s.opt) || {});
  m.max = Object.assign(defaultState().max, (s && s.max) || {});
  return m;
}
// Disk writes are debounced: save() fires on every edit (often every keystroke), so
// localStorage gets the payload immediately (cheap, synchronous, the crash fallback)
// while the IPC + fs write coalesces to at most one per pause. flushDiskSave() (on
// beforeunload) pushes any pending payload through the BLOCKING IPC path so quitting
// can't outrun the write and silently revert the last edit on next launch.
let diskSaveTimer = null;
let diskSavePending = null;
function flushDiskSave() {
  if (diskSaveTimer) { clearTimeout(diskSaveTimer); diskSaveTimer = null; }
  const payload = diskSavePending;
  diskSavePending = null;
  if (payload == null || !api) return;
  if (api.savePlansSync) { if (api.savePlansSync(payload)) return; }
  if (api.savePlans) api.savePlans(payload); // older preload — best effort
}
const save = () => {
  try {
    const globals = syncGlobals(); // keep world-level settings identical across plans
    const payload = JSON.stringify({
      projects: projects.map((p) => ({ id: p.id, name: p.name })),
      activeProjectId,
      plans: plans.map((p) => ({ id: p.id, name: p.name, projectId: p.projectId, state: p.state })),
      activeId,
      globals,
      savedAt: Date.now(), // lets load() pick the FRESHER of file vs localStorage
    });
    localStorage.setItem(PLANS_KEY, payload); // fallback + back-compat for older builds
    if (api && (api.savePlans || api.savePlansSync)) { // durable userData/plans.json (survives reinstalls)
      diskSavePending = payload;
      if (!diskSaveTimer) diskSaveTimer = setTimeout(() => { diskSaveTimer = null; if (diskSavePending != null && api.savePlans) { api.savePlans(diskSavePending); diskSavePending = null; } }, 400);
    }
  } catch (e) {}
};
// Project back-compat seam. Given whatever `projects`/`activeProjectId` a payload
// carried (possibly none — the pre-F3 format), guarantee: at least one project exists,
// activeProjectId points at a real project, and EVERY plan has a projectId pointing at
// a real project. Orphan plans (no/stale projectId) are adopted into the default
// project. Net effect: an old plans.json (no `projects`) opens with all its factories
// intact inside one "Project 1". `loaded` is the raw payload's project list (or null).
function ensureProjects(loaded, loadedActive) {
  projects = (Array.isArray(loaded) ? loaded : [])
    .filter((p) => p && p.id)
    .map((p) => ({ id: p.id, name: p.name || 'Project' }));
  if (!projects.length) projects = [{ id: newProjId(), name: 'Project 1' }];
  const ids = new Set(projects.map((p) => p.id));
  activeProjectId = ids.has(loadedActive) ? loadedActive : projects[0].id;
  // Adopt any plan whose projectId is missing or dangling into the active project, so
  // no plan is ever stranded (and so renderPlanBar always shows the old factories).
  for (const p of plans) if (!p.projectId || !ids.has(p.projectId)) p.projectId = activeProjectId;
}

function load() {
  let fromFile = false;
  try {
    // Prefer the durable userData file, but if BOTH stores parse, take the FRESHER one
    // by savedAt — localStorage is written synchronously on every edit, so when a raced
    // or quit-interrupted file write left plans.json one save behind, the localStorage
    // copy carries the missing edit. (Payloads without savedAt count as 0, which keeps
    // the old file-wins behavior for pre-stamp saves.)
    const tryParse = (s) => { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } };
    const pf = tryParse((api && api.loadPlans) ? api.loadPlans() : null);
    const pl = tryParse(localStorage.getItem(PLANS_KEY));
    const raw = (pf && pl) ? (((pl.savedAt || 0) > (pf.savedAt || 0)) ? pl : pf) : (pf || pl);
    fromFile = raw === pf && !!pf;
    if (raw && Array.isArray(raw.plans) && raw.plans.length) {
      // Keep each plan's saved projectId if present; ensureProjects() reconciles it
      // against the project list (and synthesizes a default project for pre-F3 saves).
      plans = raw.plans.map((p) => ({ id: p.id || newId(), name: p.name || 'Factory', projectId: p.projectId || null, state: mergeState(p.state) }));
      activeId = plans.some((p) => p.id === raw.activeId) ? raw.activeId : plans[0].id;
      state = activePlan().state;
      ensureProjects(raw.projects, raw.activeProjectId);
      // Shared settings carry across plans: use the saved snapshot, else adopt the
      // active plan's values (first run after upgrade) and propagate to the rest.
      if (raw.globals) for (const p of plans) applyGlobals(p.state, raw.globals);
      else syncGlobals();
      if (!fromFile || !Array.isArray(raw.projects)) save(); // seed the durable file / persist the synthesized project
      return;
    }
  } catch (e) {}
  // migrate legacy single plan, else start with one blank plan
  let legacy = null;
  try { const s = JSON.parse(localStorage.getItem(LS_KEY)); if (s && typeof s === 'object') legacy = mergeState(s); } catch (e) {}
  plans = [{ id: newId(), name: 'Factory 1', projectId: null, state: legacy || defaultState() }];
  activeId = plans[0].id;
  state = plans[0].state;
  ensureProjects(null, null); // fresh start / legacy single-plan -> one default project
}

function newPlan(name) {
  // Number within the active project (Factory N), not globally — each project counts
  // its own factories so a fresh project starts at "Factory 1".
  const n = activeProjectPlans().length + 1;
  const p = { id: newId(), name: name || `Factory ${n}`, projectId: activeProjectId, state: defaultState() };
  applyGlobals(p.state, pickGlobals(state)); // inherit shared game-save + cost settings
  plans.push(p);
  switchPlan(p.id);
}
function duplicatePlan(id) {
  const src = plans.find((p) => p.id === id) || activePlan();
  const p = { id: newId(), name: src.name + ' copy', projectId: src.projectId || activeProjectId, state: mergeState(JSON.parse(JSON.stringify(src.state))) };
  plans.push(p);
  switchPlan(p.id);
}
function deletePlan(id) {
  const idx = plans.findIndex((p) => p.id === id);
  if (idx < 0) return;
  const victim = plans[idx];
  // Never let a project end up with zero plans: deleting the last plan of a project
  // would orphan the project tab. Block it (like the global last-plan guard below).
  if (plansInProject(victim.projectId).length <= 1) {
    if (typeof alert === 'function') alert('Each project needs at least one plan. Delete the project instead, or add another plan first.');
    return;
  }
  if (plans.length > 1 && typeof confirm === 'function' && !confirm(`Delete plan "${victim.name}"?`)) return;
  plans.splice(idx, 1);
  if (!plans.length) plans.push({ id: newId(), name: 'Factory 1', projectId: activeProjectId, state: defaultState() });
  // Links may point at the deleted plan; strip the now-dangling source refs so a
  // consumer row falls back to its manual cap instead of resolving against a ghost
  // (which reads as a silent, disabled 0 cap — same treatment as deleteProject).
  pruneDanglingLinks();
  // When the active plan was deleted, fall back to a sibling in the SAME project (the
  // plan bar only shows that project's plans), else any remaining plan.
  if (id === activeId) {
    const sib = plansInProject(victim.projectId)[0] || plans[Math.max(0, idx - 1)] || plans[0];
    activeId = sib.id;
  }
  switchPlan(activeId);
}
function renamePlan(id, name) { const p = plans.find((x) => x.id === id); if (p && name) { p.name = name; save(); renderPlanBar(); } }
function switchPlan(id) {
  closeNodePopup(); // a different plan's steps — drop any open node popup
  activeId = id;
  state = activePlan().state;
  save();
  renderPlanBar();
  applyStateToControls();
}

// ---------- project ops ----------
// Make a new project plus one blank starter plan (so it's never empty), then switch
// to it. The starter plan inherits the world-level globals like any new plan.
function newProject(name) {
  const proj = { id: newProjId(), name: name || `Project ${projects.length + 1}` };
  projects.push(proj);
  const p = { id: newId(), name: 'Factory 1', projectId: proj.id, state: defaultState() };
  applyGlobals(p.state, pickGlobals(state));
  plans.push(p);
  switchProject(proj.id);
}
function renameProject(id, name) {
  const proj = projects.find((p) => p.id === id);
  if (proj && name) { proj.name = name; save(); renderProjectBar(); }
}
function deleteProject(id) {
  if (projects.length <= 1) { // never zero projects
    if (typeof alert === 'function') alert('You need at least one project.');
    return;
  }
  const proj = projects.find((p) => p.id === id);
  if (!proj) return;
  const kids = plansInProject(id);
  const msg = `Delete project "${proj.name}" and its ${kids.length} plan${kids.length === 1 ? '' : 's'}? This cannot be undone.`;
  if (typeof confirm === 'function' && !confirm(msg)) return;
  projects = projects.filter((p) => p.id !== id);
  plans = plans.filter((p) => p.projectId !== id);
  // Links may point into the deleted project; strip any now-dangling source refs so a
  // consumer row falls back to its manual cap instead of resolving against a ghost.
  pruneDanglingLinks();
  if (activeProjectId === id) {
    activeProjectId = projects[0].id;
    const first = activeProjectPlans()[0];
    activeId = first ? first.id : (plans[0] && plans[0].id);
  }
  state = activePlan() ? activePlan().state : (plans[0] && plans[0].state);
  save();
  renderProjectBar();
  renderPlanBar();
  applyStateToControls();
}
// Activate a project and jump to one of its plans (the current active plan if it
// belongs there, else the project's first plan).
function switchProject(id) {
  if (!projects.some((p) => p.id === id)) return;
  activeProjectId = id;
  const cur = activePlan();
  const target = (cur && cur.projectId === id) ? cur : activeProjectPlans()[0];
  activeId = target ? target.id : activeId;
  state = activePlan() ? activePlan().state : state;
  save();
  renderProjectBar();
  renderPlanBar();
  applyStateToControls();
}
// Drop link refs (fromPlanId) that point at a plan that no longer exists, across every
// plan's opt.extraInputs and max.supply rows. Keeps the row (manual cap) but unlinks it.
function pruneDanglingLinks() {
  const ids = new Set(plans.map((p) => p.id));
  for (const pl of plans) {
    for (const row of (pl.state.opt && pl.state.opt.extraInputs) || []) {
      if (row.fromPlanId && !ids.has(row.fromPlanId)) { delete row.fromPlanId; delete row.fromItem; }
    }
    for (const row of (pl.state.max && pl.state.max.supply) || []) {
      if (row.fromPlanId && !ids.has(row.fromPlanId)) { delete row.fromPlanId; delete row.fromItem; }
    }
  }
}

// ---------- linked inputs (Project feature: one plan feeds another) ----------
// Record a plan's net outputs (itemClass -> rate/min) from its last solve so a
// downstream plan can link an input to it. The desired-output targets ARE the net
// outputs available downstream (what the plan is built to make available); surplus
// by-products are added too. Stored on the plan + persisted so links resolve on load.
function recordNetOutputs(planObj, targets, res) {
  if (!planObj) return;
  const net = {};
  for (const c in (targets || {})) if (targets[c] > 0) net[c] = (net[c] || 0) + Number(targets[c]);
  for (const s of (res && res.surplus) || []) if (s.rate > 0) net[s.item] = (net[s.item] || 0) + s.rate;
  planObj.state.netOutputs = net;
}
// Every (item -> rate) a plan currently offers downstream, from its recorded outputs.
const planNetOutputs = (planObj) => (planObj && planObj.state && planObj.state.netOutputs) || {};
// All linked rows of a plan (both optimizer extra-inputs and max supply), normalized.
function planLinkRows(planObj) {
  const rows = [];
  const st = planObj && planObj.state;
  if (!st) return rows;
  for (const r of (st.opt && st.opt.extraInputs) || []) if (r.fromPlanId) rows.push(r);
  for (const r of (st.max && st.max.supply) || []) if (r.fromPlanId) rows.push(r);
  return rows;
}
// Directed dependency edges consumer -> source from a plan's links. Used for cycle
// detection: adding a link makes the consumer depend on the source.
function dependsOn(planId) {
  const pl = plans.find((p) => p.id === planId);
  const out = new Set();
  for (const r of planLinkRows(pl)) if (r.fromPlanId) out.add(r.fromPlanId);
  return out;
}
// Would linking `consumerId` to take supply from `sourceId` create a cycle? A cycle
// exists if `sourceId` already (transitively) depends on `consumerId` — i.e. you can
// reach the consumer by following source's existing links. Self-links are cycles too.
function linkWouldCycle(consumerId, sourceId) {
  if (consumerId === sourceId) return true;
  const seen = new Set();
  const stack = [sourceId];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === consumerId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const dep of dependsOn(cur)) stack.push(dep);
  }
  return false;
}
// Resolve a linked row's effective cap from its source plan's recorded net output of
// the linked item. Returns a number (0 if the source makes none / is gone). A row
// WITHOUT fromPlanId returns null so callers fall back to the manual cap (back-compat).
function resolveLinkedCap(row) {
  if (!row || !row.fromPlanId) return null;
  const src = plans.find((p) => p.id === row.fromPlanId);
  if (!src) return 0;
  const item = row.fromItem;
  return Number(planNetOutputs(src)[item] || 0);
}
// Plans whose links draw from `sourceId` (direct consumers) — recompute these when the
// source re-solves so their linked caps track the fresh upstream numbers.
function directConsumersOf(sourceId) {
  return plans.filter((pl) => planLinkRows(pl).some((r) => r.fromPlanId === sourceId));
}
// After the active plan solves, refresh any plans that consume its output so their
// linked caps stay in sync. We re-solve each dependent off-screen (compute only,
// updating its recorded netOutputs) without disturbing the on-screen active plan.
// Propagation follows the whole downstream chain breadth-first (A→B→C→D all refresh
// when A changes — one hop used to leave C and D stale), with a visited set so the
// cycle guard's invariant (links are acyclic) is belt-and-braces enforced here too.
function propagateLinks(sourcePlanId) {
  const seen = new Set([sourcePlanId]);
  const queue = [sourcePlanId];
  let touched = 0;
  while (queue.length) {
    const cur = queue.shift();
    for (const c of directConsumersOf(cur)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      if (c.id !== activeId) { recomputePlanOutputs(c); touched++; }
      queue.push(c.id); // even the active plan's consumers continue the chain
    }
  }
  if (touched) save();
}

// ---------- planner solver ----------
function chosenRecipeClass(item) {
  const pick = state.picks[item];
  if (pick === 'RAW') return null;
  // A picked alternate that's locked by the save or manually excluded falls back to default.
  if (pick && RECIPES[pick] && altEnabled(pick)) return pick;
  if (RESOURCES.has(item)) return null;
  return defaultRecipeClass(item);
}
// Overclock applied to one step: its per-step override, else the global slider.
function effectiveClock(rc) {
  const o = state.nodeClock && state.nodeClock[rc];
  return o != null && isFinite(o) && o > 0 ? o : state.clock;
}
// Somersloop amplification is per machine: each building has a fixed number of shard
// slots (1 Constructor/Smelter, 2 Assembler/Foundry/Refinery/Packager, 4 Manufacturer/
// Blender/Particle Accel/Converter/Quantum Encoder). Installing n of max slots gives
// output ×(1 + n/max) (full = 2×) and power ×that². data.json carries shardSlots when
// rebuilt; this map is the fallback for data.json built before the field existed.
const SLOOP_SLOTS_FALLBACK = {
  Build_ConstructorMk1_C: 1, Build_SmelterMk1_C: 1,
  Build_AssemblerMk1_C: 2, Build_FoundryMk1_C: 2, Build_OilRefinery_C: 2, Build_Packager_C: 2,
  Build_ManufacturerMk1_C: 4, Build_Blender_C: 4, Build_HadronCollider_C: 4,
  Build_Converter_C: 4, Build_QuantumEncoder_C: 4,
};
function maxSloopSlots(rc) {
  const r = RECIPES[rc];
  if (!r) return 1;
  const b = BUILDINGS[r.building] || {};
  return b.shardSlots || SLOOP_SLOTS_FALLBACK[r.building] || 1;
}
// Shards installed per machine for a step, clamped to [0, max slots].
function sloopCountOf(rc) {
  const n = state.nodeSloop && state.nodeSloop[rc];
  return n ? Math.max(0, Math.min(maxSloopSlots(rc), Math.round(n))) : 0;
}
// Output multiplier from a step's installed shards: 1 + n/max  (1×..2×).
function effectiveSloop(rc) {
  const max = maxSloopSlots(rc);
  return max ? 1 + sloopCountOf(rc) / max : 1;
}
// Per-recipe Somersloop multipliers for the LP. Sloop amplifies OUTPUT only (inputs
// per machine are unchanged), so unlike clock it does NOT cancel in the material
// ratios — it must be solved inside the balance, not post-rescaled. Returns null
// when no step is slooped so the solver's fast path is untouched.
function sloopMapFor(rcs) {
  let map = null;
  for (const rc of rcs) {
    const sl = effectiveSloop(rc);
    if (sl !== 1) (map = map || {})[rc] = sl;
  }
  return map;
}
// All slooped steps recorded on the current plan (for the Optimizer, where the LP
// picks the recipes itself — any recipe the user has tuned carries its multiplier in).
function sloopMapAll() {
  return sloopMapFor(Object.keys(state.nodeSloop || {}));
}

// ----- clean ratios: scale a plan so every step is a whole number of machines -----
// Best rational p/q ≈ x with q ≤ maxDen (continued-fraction convergent). Satisfactory
// rates are all rational, so machine counts rationalize with small denominators.
function toFraction(x, maxDen = 1000) {
  let h0 = 0, h1 = 1, k0 = 1, k1 = 0, b = x;
  for (let i = 0; i < 40; i++) {
    const a = Math.floor(b);
    const h2 = a * h1 + h0, k2 = a * k1 + k0;
    if (k2 > maxDen) break;
    h0 = h1; h1 = h2; k0 = k1; k1 = k2;
    const frac = b - a;
    if (frac < 1e-9) break;
    b = 1 / frac;
  }
  return { p: h1, q: k1 || 1 };
}
const _gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) { const t = a % b; a = b; b = t; } return a; };
const _lcm = (a, b) => (a && b ? a / _gcd(a, b) * b : 0);
// Smallest scale (×everything) that turns every machine count whole, then the multiple
// of it nearest the current size so the adjusted output stays close to the requested one.
// Returns null if the counts don't rationalize within range (no sane clean ratio).
function cleanRatioScale(counts) {
  const cs = counts.filter((c) => c > 1e-9);
  if (!cs.length) return 1;
  let Q = 1;
  const fr = [];
  for (const c of cs) {
    const f = toFraction(c, 1000);
    if (Math.abs(f.p / f.q - c) > 1e-4) return null; // can't clean this count
    fr.push(f);
    Q = _lcm(Q, f.q);
    if (!isFinite(Q) || Q > 1e7) return null; // LCM exploded — no usable clean ratio
  }
  let g = 0;
  for (const f of fr) g = _gcd(g, Math.round(Q * f.p / f.q));
  if (!g) return 1;
  const fMin = Q / g;                       // smallest scale giving all-integer machines
  const k = Math.max(1, Math.round(1 / fMin));
  return k * fMin;
}
// Scale a solved result in place to clean (whole-machine) ratios when the toggle is on.
// Linear in the LP solution, so we just multiply the reported quantities. Returns the
// scale (1 = unchanged / already clean); also stamps res._cleanScale for the UI note.
function applyCleanScale(res, targets) {
  if (!state.cleanRatio || !res || !res.recipes || !res.recipes.length) return 1;
  const scale = cleanRatioScale(res.recipes.map((r) => r.machines)) || 1;
  res._cleanScale = scale;
  if (Math.abs(scale - 1) < 1e-9) return 1;
  const mul = (arr, ...keys) => (arr || []).forEach((o) => keys.forEach((k) => { if (typeof o[k] === 'number') o[k] *= scale; }));
  mul(res.recipes, 'machines', 'rate', 'power');
  mul(res.raw, 'rate'); mul(res.outputs, 'rate'); mul(res.surplus, 'rate');
  mul(res.sunk, 'rate', 'points'); mul(res.burned, 'rate', 'mw'); mul(res.depot, 'rate');
  mul(res.watered, 'rate', 'concrete', 'limestone', 'machines');
  if (typeof res.totalPower === 'number') res.totalPower *= scale;
  if (typeof res.recoveredPower === 'number') res.recoveredPower *= scale;
  if (typeof res.objectiveValue === 'number') res.objectiveValue *= scale;
  // Snap tiny float drift so ceil()/labels show exact integers.
  res.recipes.forEach((r) => { const rd = Math.round(r.machines); if (Math.abs(r.machines - rd) < 1e-4) r.machines = rd; });
  res.totalMachines = res.recipes.reduce((a, r) => a + Math.ceil(r.machines - 1e-9), 0);
  if (res.totalSloops != null) res.totalSloops = res.recipes.reduce((a, r) => a + (r.sloops || 0) * Math.ceil(r.machines - 1e-9), 0);
  for (const k in (res.targets || {})) res.targets[k] *= scale;
  for (const k in (targets || {})) targets[k] *= scale;
  return scale;
}
// Desired outputs for the Planner: the primary target plus any extra rows.
// Deliverables are scaled by the space-elevator multiplier, same as the optimizer.
// Every output — whatever its destination — becomes production demand: a Depot /
// Storage pull still has to be built. Destination only changes how it's grouped on
// render (see destOf), it does not change the solver's demand. plannerTargetsFor lets
// the Project layer compute a non-active plan's demand headlessly.
function plannerTargets() { return plannerTargetsFor(state); }
// Each desired-output row's destination, normalised: absent / unknown → 'line'.
const normDest = (d) => (d === 'depot' || d === 'storage' ? d : 'line');
// Per-item rate split across destinations for the current Planner outputs. Unlike a
// single dest-per-item map, this lets the SAME item feed multiple destinations — e.g.
// 60/min Rocket Fuel to the line AND 60/min to storage render as two separate output
// terminals, not one merged box (the old 'line'-wins collapse). Returns item class ->
// { line, depot, storage } weights in raw row rates; consumed as fractions of the
// scaled total, so the space-elevator multiplier and clean-ratio scale cancel out.
function destBreakdown() {
  const b = {};
  const add = (c, rate, dest) => {
    if (!c || !(Number(rate) > 0)) return;
    (b[c] = b[c] || { line: 0, depot: 0, storage: 0 })[normDest(dest)] += Number(rate);
  };
  add(nameToClass(state.targetItem) || state.targetItem, state.targetRate, state.targetDest);
  for (const o of state.extraTargets || []) add(nameToClass(o.name), o.rate, o.dest);
  return b;
}
function computePlanner(targets) {
  const tg = targets || plannerTargets();
  const items = Object.keys(tg);
  const empty = { ok: items.length > 0, feasible: true, recipes: [], raw: [], surplus: [], totalPower: 0, totalMachines: 0, targets: tg };
  if (!items.length) return empty;

  // Walk the chosen-recipe graph from every target. We track visited *items* (not a
  // DFS path), so loops terminate instead of being cut — the LP then balances the
  // whole graph at once, crediting by-products and resolving recycle cycles.
  const usedRc = new Set();
  const rawItems = new Set();
  const chosenItemOf = {}; // rc -> the item whose dropdown selected it (row label)
  const seen = new Set();
  const stack = items.slice();
  while (stack.length) {
    const item = stack.pop();
    if (seen.has(item)) continue;
    seen.add(item);
    const rc = chosenRecipeClass(item);
    if (!rc) { rawItems.add(item); continue; } // resource or ⛏ Raw input
    if (chosenItemOf[rc] == null) chosenItemOf[rc] = item;
    if (!usedRc.has(rc)) {
      usedRc.add(rc);
      for (const ing of RECIPES[rc].ingredients) if (!seen.has(ing.item)) stack.push(ing.item);
    }
  }
  // Every target is itself a raw/imported item — nothing to build.
  if (!usedRc.size) return Object.assign({}, empty, { raw: items.map((it) => ({ item: it, rate: tg[it] })) });

  // Only producible targets (those with a chosen recipe) become LP demand; a raw
  // item listed as a desired output has no producer and is just reported as raw.
  const demand = {};
  for (const it of items) if (!rawItems.has(it)) demand[it] = tg[it];

  const sol = LP.planner({ targets: demand, recipes: [...usedRc], rawItems: [...rawItems], recipeCost: state.recipeCost, sloopMult: sloopMapFor(usedRc) });
  if (!sol.feasible) return Object.assign({}, empty, { feasible: false });

  let totalPower = 0;
  let totalMachines = 0;
  let totalSloops = 0; // physical Somersloops the plan consumes (scarce — surfaced as a stat)
  const recipes = sol.recipes.filter((s) => s.machines > 1e-9).map((s) => {
    const r = RECIPES[s.rc];
    const b = BUILDINGS[r.building] || { name: r.building, power: 0, exponent: 1.321929, speed: 1 };
    const item = chosenItemOf[s.rc] || s.item;
    const m100 = s.machines; // machine-equivalents at 100 % clock (sloop already in the LP balance)
    const ck = effectiveClock(s.rc);
    const sl = effectiveSloop(s.rc); // 1×..2× from this step's installed Somersloops
    const machines = m100 / ck; // clock cancels in the ratios; sloop must NOT be divided out (it's in the balance)
    const powerPer = b.power * Math.pow(ck, b.exponent) * Math.pow(sl, 2) * state.powerMult;
    const power = machines * powerPer;
    const rate = (LP.RC_INFO[s.rc].out[item] || 0) * sl * m100; // gross /min of the row's item (sloop-amplified)
    const sloops = sloopCountOf(s.rc);
    const nMachines = Math.ceil(machines - 1e-9);
    totalPower += power;
    totalMachines += nMachines;
    totalSloops += sloops * nMachines; // shards/machine × physical machines in this step
    return { item, rc: s.rc, machines, building: r.building, buildingName: b.name, rate, power, clock: ck, sloops, maxSloops: maxSloopSlots(s.rc), sloopMult: sl, interactive: true };
  });
  return {
    ok: true,
    feasible: true,
    recipes,
    raw: (sol.raw || []).filter((r) => r.rate > 1e-4),
    surplus: (sol.outputs || []).filter((o) => tg[o.item] == null && o.rate > 1e-4),
    totalPower,
    totalMachines,
    totalSloops,
    targets: tg,
  };
}

// Apply each step's Overclock to an Optimizer result, the same way computePlanner
// does for the Planner. The LP solves at 100% clock (clock scales inputs and outputs
// equally, so it cancels in the material ratios); Somersloop does NOT cancel — it is
// already inside the LP balance via sloopMult (see sloopMapAll) — so here only the
// clock is divided out. We rescale machines & power per step and tag every row
// interactive so the Clock / Sloops editors — the table cells AND the flowchart node
// popup — light up in Optimizer mode too. NOT used for Max mode: there output is the
// maximand. Mutates res in place and recomputes the reported totals. (computePlanner
// inlines the same formula — keep the two in sync.)
function tuneSteps(res) {
  if (!res || !res.recipes) return res;
  let totalPower = 0, totalMachines = 0, totalSloops = 0;
  for (const s of res.recipes) {
    const r = RECIPES[s.rc];
    const b = (r && BUILDINGS[r.building]) || { power: 0, exponent: 1.321929 };
    const m100 = s.machines; // LP machine-equivalents at 100% clock (sloop already in the balance)
    const ck = effectiveClock(s.rc);
    const sl = effectiveSloop(s.rc);
    s.machines = m100 / ck;
    s.power = s.machines * (b.power || 0) * Math.pow(ck, b.exponent || 1.321929) * Math.pow(sl, 2) * state.powerMult;
    s.clock = ck;
    s.sloops = sloopCountOf(s.rc);
    s.maxSloops = maxSloopSlots(s.rc);
    s.sloopMult = sl;
    s.interactive = true;
    const n = Math.ceil(s.machines - 1e-9);
    totalPower += s.power; totalMachines += n; totalSloops += s.sloops * n;
  }
  res.totalPower = totalPower;
  res.totalMachines = totalMachines;
  res.totalSloops = totalSloops;
  return res;
}

// ---------- formatting ----------
function fmt(n, d = 2) {
  if (!isFinite(n)) return '∞';
  return (Math.round(n * 10 ** d) / 10 ** d).toLocaleString(undefined, { maximumFractionDigits: d });
}
const fmtPower = (mw) => (mw >= 1000 ? fmt(mw / 1000, 2) + ' GW' : fmt(mw, 1) + ' MW');
const $ = (id) => document.getElementById(id);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
// HTML-escape any string interpolated into innerHTML. Tooltips include strings
// derived from a loaded .sav (building class names, paint slots, purity) — without
// escaping, a crafted save could inject markup, which with Node integration on is
// an RCE vector. All dynamic values in *innerHTML go through this.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- table rendering ----------
function recipeOptionLabel(rc) {
  const r = RECIPES[rc];
  const ing = r.ingredients.map((i) => `${fmt(i.amount, 0)} ${itemName(i.item)}`).join(' + ');
  return `${r.alternate ? '★ ' : ''}${r.name}  (${ing || 'raw'})`;
}
function recipeSelect(item, currentRc) {
  const sel = el('select', 'recipe-select');
  const cands = (recipesByProduct[item] || []).filter((rc) => altEnabled(rc) || rc === currentRc).sort((a, b) => {
    const ra = RECIPES[a], rb = RECIPES[b];
    if (ra.alternate !== rb.alternate) return ra.alternate ? 1 : -1;
    return ra.name.localeCompare(rb.name);
  });
  for (const rc of cands) {
    const o = el('option', null, recipeOptionLabel(rc));
    o.value = rc;
    if (rc === currentRc) o.selected = true;
    sel.appendChild(o);
  }
  const rawO = el('option', null, '⛏ Raw input (do not produce)');
  rawO.value = 'RAW';
  if (state.picks[item] === 'RAW') rawO.selected = true;
  sel.appendChild(rawO);
  if (currentRc && RECIPES[currentRc] && RECIPES[currentRc].alternate) sel.classList.add('alt');
  sel.addEventListener('change', () => { state.picks[item] = sel.value; save(); solveAndRender(); });
  return sel;
}
function itemCell(item) {
  const span = el('span', 'item-cell');
  span.appendChild(el('span', 'dot' + (isFluid(item) ? ' fluid' : '')));
  span.appendChild(document.createTextNode(itemName(item)));
  return span;
}
// Per-step overclock editor (Planner rows). Typing the global value clears the
// override so the step tracks the global slider again.
function clockCell(s) {
  const td = el('td', 'num');
  if (!s.interactive) { td.textContent = '—'; return td; }
  const inp = el('input', 'clock-input');
  inp.type = 'number'; inp.min = '1'; inp.max = '250'; inp.step = '1';
  inp.value = Math.round((s.clock || state.clock) * 100);
  inp.title = 'Overclock this step independently of the global slider';
  const apply = () => {
    let v = Math.round(parseFloat(inp.value) || 100);
    v = Math.max(1, Math.min(250, v));
    inp.value = v;
    state.nodeClock = state.nodeClock || {};
    if (v === Math.round(state.clock * 100)) delete state.nodeClock[s.rc];
    else state.nodeClock[s.rc] = v / 100;
    save();
    solveAndRender();
  };
  inp.addEventListener('change', apply);
  td.appendChild(inp);
  td.appendChild(document.createTextNode(' %'));
  return td;
}
// Per-step Somersloop editor (Planner rows): a dropdown of shards to install in each
// machine of this step, 0..the building's slot count. Output ×(1 + n/max), power
// ×that². The option labels show the resulting multiplier; the tooltip shows how many
// physical sloops the step eats so the scarce-resource trade-off is visible.
function sloopCell(s) {
  const td = el('td', 'num');
  if (!s.interactive) { td.textContent = '—'; return td; }
  const max = s.maxSloops || 1;
  const sel = el('select', 'sloop-input');
  for (let n = 0; n <= max; n++) {
    const o = el('option', null, n === 0 ? '—' : `${n} · ${fmt(1 + n / max, 2)}×`);
    o.value = String(n);
    sel.appendChild(o);
  }
  sel.value = String(s.sloops || 0);
  const used = Math.ceil(s.machines - 1e-9) * (s.sloops || 0);
  sel.title = `Somersloops per machine (max ${max}). Output ×(1+n/${max}), power ×that².` +
    (used ? ` Uses ${used} sloop${used > 1 ? 's' : ''} across this step.` : '');
  sel.addEventListener('change', () => {
    const n = Math.max(0, Math.min(max, parseInt(sel.value, 10) || 0));
    state.nodeSloop = state.nodeSloop || {};
    if (n === 0) delete state.nodeSloop[s.rc]; else state.nodeSloop[s.rc] = n;
    save();
    solveAndRender();
  });
  td.appendChild(sel);
  return td;
}
function renderTables(res) {
  const tb = $('prodTable').querySelector('tbody');
  tb.innerHTML = '';
  res.recipes.slice().sort((a, b) => itemName(a.item).localeCompare(itemName(b.item))).forEach((s) => {
    const tr = el('tr');
    const tdItem = el('td'); tdItem.appendChild(itemCell(s.item)); tr.appendChild(tdItem);
    const tdRec = el('td');
    if (s.interactive) tdRec.appendChild(recipeSelect(s.item, s.rc));
    else { const r = RECIPES[s.rc]; tdRec.appendChild(el('span', null, r.name)); if (r.alternate) tdRec.appendChild(el('span', 'tag-alt', 'ALT')); }
    tr.appendChild(tdRec);
    tr.appendChild(el('td', 'num', `${fmt(s.rate)} ${isFluid(s.item) ? 'm³' : ''}/min`));
    const tdM = el('td', 'num');
    tdM.innerHTML = `<span class="mach-main">${fmt(Math.ceil(s.machines - 1e-9), 0)}×</span> <span class="mach-sub">(${fmt(s.machines)})</span>`;
    tr.appendChild(tdM);
    tr.appendChild(clockCell(s));
    tr.appendChild(sloopCell(s));
    tr.appendChild(el('td', null, s.buildingName));
    tr.appendChild(el('td', 'num', fmtPower(s.power)));
    tb.appendChild(tr);
  });

  const rtb = $('rawTable').querySelector('tbody');
  rtb.innerHTML = '';
  res.raw.slice().sort((a, b) => itemName(a.item).localeCompare(itemName(b.item))).forEach((r) => {
    const tr = el('tr');
    const td = el('td'); td.appendChild(itemCell(r.item)); tr.appendChild(td);
    tr.appendChild(el('td', 'num', fmt(r.rate)));
    rtb.appendChild(tr);
  });
  if (!res.raw.length) rtb.innerHTML = '<tr><td colspan="2" style="color:var(--muted)">None</td></tr>';

  const bld = {};
  for (const s of res.recipes) {
    bld[s.building] = bld[s.building] || { name: s.buildingName, count: 0, power: 0 };
    bld[s.building].count += s.machines;
    bld[s.building].power += s.power;
  }
  const btb = $('bldTable').querySelector('tbody');
  btb.innerHTML = '';
  Object.values(bld).sort((a, b) => b.power - a.power).forEach((b) => {
    const tr = el('tr');
    tr.appendChild(el('td', null, b.name));
    const c = el('td', 'num'); c.innerHTML = `${fmt(Math.ceil(b.count - 1e-9), 0)}× <span class="mach-sub">(${fmt(b.count)})</span>`;
    tr.appendChild(c);
    tr.appendChild(el('td', 'num', fmtPower(b.power)));
    btb.appendChild(tr);
  });
  if (!Object.keys(bld).length) btb.innerHTML = '<tr><td colspan="3" style="color:var(--muted)">None</td></tr>';

  // By-product disposal: what was sunk (Awesome Sink) or burned (Fuel Generator), plus
  // any genuine surplus left floating when sinking is off — each with its destination.
  const disp = [];
  (res.sunk || []).forEach((s) => disp.push({ item: s.item, rate: s.rate, dest: `Awesome Sink · ${fmt(s.points, 0)} pts/min` }));
  (res.burned || []).forEach((b) => disp.push({ item: b.item, rate: b.rate, dest: `${b.genName} · ${fmt(b.mw, 0)} MW` }));
  (res.watered || []).forEach((w) => disp.push({ item: w.item, rate: w.rate, dest: `Wet Concrete · ${fmt(w.machines)}× → ${fmt(w.concrete)} Concrete/min` }));
  (res.surplus || []).forEach((s) => disp.push({ item: s.item, rate: s.rate, dest: 'surplus (unconsumed)' }));
  const disposed = (res.sunk && res.sunk.length) || (res.burned && res.burned.length) || (res.watered && res.watered.length);
  $('byprodTitle').textContent = disposed ? 'By-product disposal' : 'By-products / surplus';
  $('byprodWrap').hidden = disp.length === 0;
  const ytb = $('byprodTable').querySelector('tbody');
  ytb.innerHTML = '';
  disp.sort((a, b) => itemName(a.item).localeCompare(itemName(b.item))).forEach((s) => {
    const tr = el('tr');
    const td = el('td'); td.appendChild(itemCell(s.item)); tr.appendChild(td);
    tr.appendChild(el('td', 'num', fmt(s.rate)));
    tr.appendChild(el('td', null, s.dest));
    ytb.appendChild(tr);
  });

  // Depot / Storage group: outputs the user tagged for the Dimensional Depot or storage
  // (still real production — see renderPlanner), kept separate from primary line outputs.
  const depot = res.depot || [];
  const dwrap = $('depotWrap');
  if (dwrap) {
    dwrap.hidden = depot.length === 0;
    const dtb = $('depotTable').querySelector('tbody');
    dtb.innerHTML = '';
    depot.slice().sort((a, b) => itemName(a.item).localeCompare(itemName(b.item))).forEach((s) => {
      const tr = el('tr');
      const td = el('td'); td.appendChild(itemCell(s.item)); tr.appendChild(td);
      tr.appendChild(el('td', 'num', fmt(s.rate)));
      tr.appendChild(el('td', null, s.dest === 'storage' ? 'Storage' : 'Dimensional Depot'));
      dtb.appendChild(tr);
    });
  }

  renderPowerInfraTables(res);
  $('sumPower').textContent = fmtPower(res.totalPower);
  $('sumMachines').textContent = fmt(res.totalMachines, 0);
  if ($('sumSloops')) $('sumSloops').textContent = fmt(res.totalSloops || 0, 0);
}
// Extraction + Power-generation tables in the table view, shown only when the "Power infra"
// toggle is on. Same powerInfraFor() sizing as the flowchart + Power Planner, so all agree.
function renderPowerInfraTables(res) {
  const exWrap = $('extractionWrap'), gnWrap = $('genWrap');
  if (!exWrap || !gnWrap) return;
  if (!state.flowPower) { exWrap.hidden = true; gnWrap.hidden = true; return; }
  const mult = state.powerMult || 1;
  const { extraction, gens } = powerInfraFor(res, lastTargets);
  exWrap.hidden = extraction.length === 0;
  const etb = $('extractionTable').querySelector('tbody'); etb.innerHTML = '';
  extraction.slice().sort((a, b) => b.powerBase - a.powerBase).forEach((e) => {
    const tr = el('tr');
    const td = el('td'); td.appendChild(itemCell(e.item)); tr.appendChild(td);
    tr.appendChild(el('td', null, e.name + (e.hasPurity ? ` · ${e.purity}` : '')));
    const c = el('td', 'num'); c.innerHTML = `${fmt(Math.ceil(e.count - 1e-9), 0)}× <span class="mach-sub">(${fmt(e.count)})</span>`; tr.appendChild(c);
    tr.appendChild(el('td', 'num', `${Math.round(e.clock * 100)}%`));
    tr.appendChild(el('td', 'num', fmtPower(e.powerBase * mult)));
    etb.appendChild(tr);
  });
  gnWrap.hidden = gens.length === 0;
  const gtb = $('genTable').querySelector('tbody'); gtb.innerHTML = '';
  gens.forEach((g) => {
    const tr = el('tr');
    const td = el('td'); td.appendChild(itemCell(g.output)); tr.appendChild(td);
    tr.appendChild(el('td', null, g.name));
    const c = el('td', 'num'); c.innerHTML = `${fmt(Math.ceil(g.nGen - 1e-9), 0)}× <span class="mach-sub">(${fmt(g.nGen)})</span>`; tr.appendChild(c);
    tr.appendChild(el('td', 'num', `${Math.round(g.clock * 100)}%`));
    tr.appendChild(el('td', 'num', '+' + fmtPower(g.mw)));
    gtb.appendChild(tr);
  });
}

// ---------- flowchart ----------
let lastResult = null;
let lastTargets = null;
let currentFlow = null; // last laid-out flow, for zoom/fit buttons to re-apply without rebuilding

function buildFlow(res, targets) {
  const nodes = [];
  const byId = {};
  const edges = [];
  const addNode = (id, kind, title, sub) => {
    if (!byId[id]) { const n = { id, kind, title, sub, ins: [], outs: [] }; nodes.push(n); byId[id] = n; }
    return byId[id];
  };
  // stable id keyed by recipe class so saved drag positions survive re-solves
  res.recipes.forEach((s, i) => {
    s._nid = 'mac|' + (s.rc || i);
    const r = RECIPES[s.rc];
    // Alternate recipes show the recipe name; standard recipes show the output item.
    const title = r && r.alternate ? '★ ' + r.name.replace(/^Alternate:\s*/, '') : itemName(s.item);
    // Exact (fractional) machine count for perfect-ratio / 100%-uptime planning,
    // e.g. "7.5× Assembler" = 7 machines at 100% + 1 at 50%. Append the clock only
    // when this step is overclocked away from the global slider.
    const oc = s.clock != null && Math.abs(s.clock - state.clock) > 1e-9 ? ` · ${Math.round(s.clock * 100)}%` : '';
    const sp = s.sloops ? ` · ${fmt(s.sloopMult, 2)}× sloop` : '';
    const macNode = addNode(s._nid, 'machine', title, `${fmt(s.machines)}× ${s.buildingName}${oc}${sp}`);
    // Carry the recipe class + interactivity so a tap opens the node settings popup
    // (Overclock / Somersloop). Only interactive steps (Planner / Optimizer) are tunable.
    macNode.rc = s.rc;
    macNode.interactive = !!s.interactive;
  });
  res.raw.forEach((r) => addNode('raw|' + r.item, 'raw', itemName(r.item), fmt(r.rate) + '/min'));
  // Index every step under *each* item it produces — primary product AND by-products.
  // Keying only by the primary (the old behaviour) made by-products invisible as
  // sources: a recipe eating another recipe's by-product (e.g. Petroleum Coke from the
  // Heavy Oil Residue that Plastic/Rubber emit) found no producer, fell back to a
  // raw|<item> node that doesn't exist for a non-raw item, so addEdge silently dropped
  // it — the consumer rendered with no input while the by-product floated up as a
  // phantom output. `rate` is this step's output of `item`, scaled off the primary
  // rate so it stays correct even when the Planner clock-rescales machine counts.
  const producers = {};
  res.recipes.forEach((s) => {
    const info = LP.RC_INFO[s.rc];
    if (!info) return;
    const base = info.out[s.item] || info.primaryRate || 1;
    for (const item in info.out) {
      (producers[item] = producers[item] || []).push({ step: s, rate: s.rate * (info.out[item] / base) });
    }
  });
  const addEdge = (srcId, dstId, item, rate) => {
    if (!byId[srcId] || !byId[dstId]) return;
    // item + numeric rate are carried alongside the display label so the Sankey view can
    // size each band by throughput (and colour it by material) without re-parsing the text.
    const e = { src: srcId, dst: dstId, item, rate, label: `${itemName(item)} ${fmt(rate)}/min` };
    edges.push(e); byId[srcId].outs.push(e); byId[dstId].ins.push(e);
  };
  res.recipes.forEach((s) => {
    const r = RECIPES[s.rc];
    const prod = r.products.find((p) => p.item === s.item) || r.products[0];
    r.ingredients.forEach((ing) => {
      // s.rate is sloop-amplified gross output; inputs scale with machines (not sloop),
      // so divide the multiplier back out to get the true ingredient draw.
      const total = (s.rate / (prod.amount * (s.sloopMult || 1))) * LP.effAmount(ing.amount, state.recipeCost);
      const provs = (producers[ing.item] || []).filter((p) => p.step !== s); // no self-edge on by-product loops
      if (provs.length) {
        const tot = provs.reduce((a, p) => a + p.rate, 0) || 1;
        provs.forEach((p) => addEdge(p.step._nid, s._nid, ing.item, total * (p.rate / tot)));
      } else addEdge('raw|' + ing.item, s._nid, ing.item, total);
    });
  });
  // Power infrastructure (opt-in): shared sizing so the flowchart, table, and Power Planner
  // agree. Extractors gather each raw at the FRONT (extractor → raw → machine); generators
  // burn outputs at the END (below). Nodes are interactive — double-click to set per-node
  // overclock (power shards), like a machine.
  const infra = state.flowPower ? powerInfraFor(res, targets) : null;
  if (infra) {
    const mult = state.powerMult || 1;
    infra.extraction.forEach((e) => {
      const oc = e.clock !== 1 ? ` · ${Math.round(e.clock * 100)}%` : '';
      const id = 'ext|' + e.item;
      const n = addNode(id, 'ext', e.name, `${fmt(Math.ceil(e.count - 1e-9), 0)}× · ${fmtPower(e.powerBase * mult)}${oc}`);
      n.interactive = true; n.power = { kind: 'ext', item: e.item };
      // A standalone generator's fuel isn't in res.raw, so its raw node may not exist yet —
      // create it. Set the sub to the merged demand so a raw fed to both the plan and a
      // generator shows the total mined, not just the plan's share.
      const rawNode = addNode('raw|' + e.item, 'raw', itemName(e.item), fmt(e.rate) + '/min');
      rawNode.sub = fmt(e.rate) + '/min';
      addEdge(id, 'raw|' + e.item, e.item, e.rate);
    });
  }
  const outs = Object.assign({}, targets || {});
  (res.surplus || []).forEach((s) => { if (outs[s.item] == null) outs[s.item] = s.rate; });
  // Outputs the Power Planner routes into generators (opt-in) are CONSUMED for power, not
  // exported — skip their green output node and let the generator node below carry them.
  const burnedSet = new Set(infra ? infra.gens.map((g) => g.output) : []);
  for (const item in outs) {
    if (burnedSet.has(item)) continue;
    const oid = 'out|' + item;
    addNode(oid, 'out', itemName(item), fmt(outs[item]) + '/min');
    const provs = producers[item];
    if (provs && provs.length) { const tot = provs.reduce((a, p) => a + p.rate, 0) || 1; provs.forEach((p) => addEdge(p.step._nid, oid, item, outs[item] * (p.rate / tot))); }
  }
  // Disposal terminals: solids routed to the Awesome Sink, liquid fuels burned in a
  // Fuel Generator. One node per disposed item, fed by whatever produced it (a producer
  // can split between a real consumer and disposal, so these coexist with normal edges).
  const drawDisposal = (list, prefix, kind, title, sub) => (list || []).forEach((d) => {
    const id = (typeof prefix === 'function' ? prefix(d) : prefix + d.item);
    addNode(id, kind, title(d), sub(d));
    const provs = producers[d.item];
    if (provs && provs.length) { const tot = provs.reduce((a, p) => a + p.rate, 0) || 1; provs.forEach((p) => addEdge(p.step._nid, id, d.item, d.rate * (p.rate / tot))); }
  });
  drawDisposal(res.sunk, 'sink|', 'sink', () => 'Awesome Sink', (d) => `${itemName(d.item)} · ${fmt(d.points, 0)} pts/min`);
  drawDisposal(res.burned, 'gen|', 'gen', (d) => d.genName || 'Fuel Generator', (d) => `${fmt(d.machines)}× · ${fmt(d.mw, 0)} MW`);
  drawDisposal(res.watered, 'wet|', 'sink', () => 'Wet Concrete', (d) => `${fmt(d.machines)}× → ${fmt(d.concrete)} Concrete/min`);
  // Depot / Storage terminals: outputs the user tagged to be pulled into the
  // Dimensional Depot or stashed in storage. Built like the disposal terminals (one
  // fed node per item) but a destination, not a sink — the production is still real.
  // Keyed by dest so the SAME item routed to both depot and storage gets two separate
  // terminals (depot|item, storage|item) instead of colliding on one node id.
  drawDisposal(res.depot, (d) => `${d.dest}|${d.item}`, 'depot', (d) => (d.dest === 'storage' ? 'Storage' : 'Dimensional Depot'),
    (d) => `${itemName(d.item)} · ${fmt(d.rate)}/min`);
  // Power infrastructure (opt-in): generators added in the Power Planner, burning a plan
  // output at the END of the chart (blue, like the by-product fuel generators), plus the
  // water extractor that feeds coal/nuclear generators. The burned output's green node was
  // skipped above, so its producers flow straight into the generator here.
  if (infra) {
    const mult = state.powerMult || 1;
    infra.gens.forEach((g) => {
      const oc = g.clock !== 1 ? ` · ${Math.round(g.clock * 100)}%` : '';
      const key = g.standalone ? 's' + g.sidx : g.idx; // distinct id space so standalone + plan gens never collide
      const gid = 'pgen|' + key + '|' + g.output;
      // count× generators · total MW (fractional count, matching the machine nodes)
      const gn = addNode(gid, 'gen', g.name, `${fmt(g.nGen)}× · ${fmt(g.mw, 0)} MW${oc}`);
      gn.interactive = true; gn.power = g.standalone ? { kind: 'sgen', sidx: g.sidx } : { kind: 'gen', idx: g.idx };
      const provs = producers[g.output];
      if (provs && provs.length) { const tot = provs.reduce((a, pp) => a + pp.rate, 0) || 1; provs.forEach((pp) => addEdge(pp.step._nid, gid, g.output, g.avail * (pp.rate / tot))); }
      else addEdge('raw|' + g.output, gid, g.output, g.avail);
      if (g.water) {
        const wid = 'wgen|' + key;
        addNode(wid, 'ext', EXTRACTORS.Build_WaterPump_C.name, `${fmt(g.water.count, 0)}× · ${fmtPower(g.water.powerBase * mult)}`);
        addEdge(wid, gid, WATER_ITEM, g.water.need);
      }
    });
  }
  return { nodes, byId, edges };
}

function layoutFlow(flow) {
  const { nodes, byId } = flow;
  // Column = longest path from a source, with cycles broken: a back-edge into a node
  // still on the current DFS path is ignored. Plain Kahn's layering dumped every node
  // caught in a recycle loop into column 0; once by-product edges made those loops common
  // (e.g. HOR <-> recycled plastic) the whole chart collapsed into a couple of absurdly
  // tall columns. Longest-path layering gives every node a real column, spreading the
  // graph wide instead of stacking it sky-high.
  const col = {};
  const mark = {}; // 1 = on current DFS path, 2 = finalized
  const depthOf = (id) => {
    if (mark[id] === 2) return col[id];
    if (mark[id] === 1) return 0; // back-edge — break the cycle here
    mark[id] = 1;
    let d = 0;
    for (const e of byId[id].ins) if (byId[e.src]) d = Math.max(d, depthOf(e.src) + 1);
    mark[id] = 2;
    return (col[id] = d);
  };
  nodes.forEach((n) => depthOf(n.id));
  const cols = {};
  nodes.forEach((n) => (cols[col[n.id]] = cols[col[n.id]] || []).push(n));
  // Wider columns so the per-minute edge labels fit between nodes; taller rows reduce label overlap.
  const COLW = 300, ROWH = 96, NW = 168, NH = 52, PADX = 28, PADY = 28;
  const saved = state.flowPos || {};
  // Vertically centre each column against the tallest so the graph reads as a balanced
  // flow left-to-right rather than top-left-anchored ragged columns.
  const maxLen = Math.max(1, ...Object.values(cols).map((a) => a.length));
  // Crossing reduction (Sugiyama barycentre): order nodes within each column by the mean
  // rank of their neighbours, sweeping a few times in alternating directions. Far fewer
  // edge crossings — readable even with by-product cross-links. Deterministic (no RNG).
  const colKeys = Object.keys(cols).map(Number).sort((a, b) => a - b);
  const rank = {};
  colKeys.forEach((c) => cols[c].forEach((n, i) => { rank[n.id] = i; }));
  const adj = {};
  nodes.forEach((n) => { adj[n.id] = []; });
  flow.edges.forEach((e) => { if (byId[e.src] && byId[e.dst]) { adj[e.src].push(e.dst); adj[e.dst].push(e.src); } });
  for (let sweep = 0; sweep < 8; sweep++) {
    const seq = sweep % 2 ? colKeys.slice().reverse() : colKeys;
    for (const c of seq) {
      const arr = cols[c];
      const key = {};
      for (const n of arr) { const a = adj[n.id]; key[n.id] = a.length ? a.reduce((s, id) => s + rank[id], 0) / a.length : rank[n.id]; }
      arr.sort((p, q) => (key[p.id] - key[q.id]) || (rank[p.id] - rank[q.id]));
      arr.forEach((n, i) => { rank[n.id] = i; });
    }
  }
  Object.keys(cols).map(Number).sort((a, b) => a - b).forEach((c) => {
    const off = ((maxLen - cols[c].length) / 2) * ROWH;
    cols[c].forEach((n, i) => {
      n.w = NW; n.h = NH;
      const sp = saved[n.id];
      if (sp && isFinite(sp.x) && isFinite(sp.y)) { n.x = sp.x; n.y = sp.y; }
      else { n.x = PADX + c * COLW; n.y = PADY + off + i * ROWH; }
    });
  });
  // size canvas to actual node extents (covers nodes dragged outside the grid)
  let mx = 0, my = 0;
  nodes.forEach((n) => { mx = Math.max(mx, n.x + n.w); my = Math.max(my, n.y + n.h); });
  flow.width = mx + PADX;
  flow.height = my + PADY;
  return flow;
}

// Label positions cycle through these curve parameters (set per-edge in drawFlow)
// so labels of edges sharing a column band spread out instead of stacking.
const EDGE_LABEL_TS = [0.5, 0.4, 0.6, 0.45, 0.55, 0.35, 0.65];
function edgePath(e, byId) {
  const s = byId[e.src], d = byId[e.dst];
  // Smart side selection: attach to the side of each box that faces its partner, by the
  // boxes' relative position. Target to the right -> exit source-right, enter target-left
  // (the usual left-to-right flow). Target to the left -> exit source-left, enter target-
  // right (back-edges / recycle loops, or after a node is dragged). The bezier handle
  // offset flips sign to match, so the curve bows outward instead of looping back across
  // the boxes.
  const goRight = (d.x + d.w / 2) >= (s.x + s.w / 2);
  const sx = goRight ? s.x + s.w : s.x;
  const dx = goRight ? d.x : d.x + d.w;
  const ho = goRight ? 50 : -50; // horizontal control-handle direction
  const sy = s.y + s.h / 2, dy = d.y + d.h / 2;
  const c1 = sx + ho, c2 = dx - ho;
  // Anti-parallel pair (both A->B and B->A exist): bow each curve to the opposite side and
  // push its label there too, so the two lines and their rate labels don't sit on top of
  // each other. e._anti is +1/-1 for the two directions, 0 otherwise (set in drawFlow).
  const off = (e && e._anti ? e._anti : 0) * 16;
  const c1y = sy + off, c2y = dy + off;
  // Place the label at parameter t along the cubic bezier (control points carry the
  // horizontal handles + the anti-parallel vertical bow). drawFlow staggers t to de-clutter.
  const t = (e && e._lt != null) ? e._lt : 0.5, mt = 1 - t;
  const lx = mt * mt * mt * sx + 3 * mt * mt * t * c1 + 3 * mt * t * t * c2 + t * t * t * dx;
  const ly = mt * mt * mt * sy + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * dy;
  return { d: `M ${sx} ${sy} C ${c1} ${c1y} ${c2} ${c2y} ${dx} ${dy}`, lx, ly: ly - 5 };
}

// ----- Sankey mode: proportional flow bands -----
// The Sankey view reuses the exact node layout from layoutFlow; it only changes how edges
// are drawn — each becomes a band whose thickness is its throughput (items/min). A band's
// two ends attach to stacked slots along the facing edge of its source/target node, so the
// bands fan out of a node in proportion to flow rather than all meeting at the centre.
// Offsets are stored RELATIVE to the node origin (_so on the source, _di on the dest) so a
// dragged node keeps its bands attached without recomputing the whole layout.
const isSankey = () => state.view === 'sankey';
// Stable per-item hue so each material reads as its own colour; fluids share the map's cyan.
function itemHue(item) { let h = 0; const s = String(item || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; }
const bandColor = (item) => (isFluid(item) ? 'hsl(199, 82%, 60%)' : `hsl(${itemHue(item)}, 62%, 60%)`);
function sankeyLayout(flow) {
  const { nodes } = flow;
  let maxStack = 0;
  nodes.forEach((n) => {
    n._in = n.ins.reduce((a, e) => a + (e.rate || 0), 0);
    n._out = n.outs.reduce((a, e) => a + (e.rate || 0), 0);
    maxStack = Math.max(maxStack, n._in, n._out);
  });
  // One global scale so band widths are comparable across the whole chart: the busiest
  // node's stack spans ~SPAN px; every band is clamped to a legible [MINW, MAXW].
  const SPAN = 150, MINW = 2.5, MAXW = 52;
  const scale = maxStack > 0 ? SPAN / maxStack : 1;
  flow._bandScale = scale;
  const bw = (r) => Math.max(MINW, Math.min(MAXW, (r || 0) * scale));
  nodes.forEach((n) => {
    // Stack the widest bands nearest the node centre (sorted by rate) so big flows read
    // first and thin trickles sit at the edges; centre the whole stack on the node.
    const lay = (list, key) => {
      const ordered = list.slice().sort((a, b) => (b.rate || 0) - (a.rate || 0));
      const total = ordered.reduce((a, e) => a + bw(e.rate), 0);
      let y = n.h / 2 - total / 2;
      ordered.forEach((e) => { const w = bw(e.rate); e._bw = w; e[key] = y + w / 2; y += w; });
    };
    lay(n.outs, '_so'); // attach offset on the source node's right/left edge
    lay(n.ins, '_di');  // attach offset on the dest node's facing edge
  });
}
// Band centre-line for Sankey mode: a flat-handled bezier between the two stacked attach
// points. Stroking it with width e._bw gives a constant-thickness ribbon = its throughput.
function sankeyEdgePath(e, byId) {
  const s = byId[e.src], d = byId[e.dst];
  const goRight = (d.x + d.w / 2) >= (s.x + s.w / 2);
  const sx = goRight ? s.x + s.w : s.x;
  const dx = goRight ? d.x : d.x + d.w;
  const ho = goRight ? 60 : -60;
  const sy = s.y + (e._so != null ? e._so : s.h / 2);
  const dy = d.y + (e._di != null ? e._di : d.h / 2);
  const c1 = sx + ho, c2 = dx - ho;
  const lx = 0.125 * sx + 0.375 * c1 + 0.375 * c2 + 0.125 * dx; // bezier midpoint (t=0.5)
  const ly = 0.5 * sy + 0.5 * dy;
  return { d: `M ${sx} ${sy} C ${c1} ${sy} ${c2} ${dy} ${dx} ${dy}`, lx, ly: ly - 4 };
}

function drawFlow(flow) {
  const svg = $('flowSvg');
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  // SVG fills the container (1 user unit = 1px); zoom/pan is a transform on the root
  // <g> so the graph scales to the window instead of running off the right edge.
  svg.removeAttribute('viewBox');
  const root = document.createElementNS(SVGNS, 'g');
  root.setAttribute('id', 'flowRoot');
  const gEdges = document.createElementNS(SVGNS, 'g');
  const gNodes = document.createElementNS(SVGNS, 'g');
  root.appendChild(gEdges); root.appendChild(gNodes);
  svg.appendChild(root);

  // Arrowhead marker: a small triangle at each edge's end, pointing into the target node
  // so flow direction is unambiguous. userSpaceOnUse so it scales with the graph (zoom),
  // not with stroke width. orient=auto aligns it with the curve's end tangent.
  const defs = document.createElementNS(SVGNS, 'defs');
  const marker = document.createElementNS(SVGNS, 'marker');
  marker.setAttribute('id', 'flowArrow');
  marker.setAttribute('viewBox', '0 0 10 10');
  marker.setAttribute('refX', '10'); marker.setAttribute('refY', '5');
  marker.setAttribute('markerWidth', '7'); marker.setAttribute('markerHeight', '7');
  marker.setAttribute('markerUnits', 'userSpaceOnUse'); marker.setAttribute('orient', 'auto');
  const av = document.createElementNS(SVGNS, 'path');
  av.setAttribute('d', 'M0,0 L10,5 L0,10 z'); av.setAttribute('class', 'flow-arrow');
  marker.appendChild(av); defs.appendChild(marker); svg.insertBefore(defs, root);

  const sankey = isSankey();
  if (sankey) {
    // Proportional bands: width = throughput, colour = material. Visuals are set as
    // attributes (not CSS) so the PNG export captures them without extra stylesheet rules.
    sankeyLayout(flow);
    flow.edges.forEach((e) => {
      const p = sankeyEdgePath(e, flow.byId);
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('class', 'sankey-band');
      path.setAttribute('d', p.d);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', bandColor(e.item));
      path.setAttribute('stroke-width', e._bw);
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-opacity', '0.55');
      const tip = document.createElementNS(SVGNS, 'title');
      tip.textContent = e.label;
      path.appendChild(tip);
      gEdges.appendChild(path);
      e._path = path;
      // Label only bands wide enough to carry text without crowding the thin ones; the
      // rest surface their rate via the hover tooltip above.
      if (e._bw >= 9) {
        const t = document.createElementNS(SVGNS, 'text');
        t.setAttribute('class', 'edge-label');
        t.setAttribute('x', p.lx); t.setAttribute('y', p.ly);
        t.setAttribute('text-anchor', 'middle');
        t.textContent = e.label;
        gEdges.appendChild(t);
        e._label = t;
      } else e._label = null;
    });
  } else {
    // Flag anti-parallel pairs (both A->B and B->A present) so edgePath splits them apart.
    const pk = (a, b) => a + ' ' + b;
    const eset = new Set(flow.edges.map((e) => pk(e.src, e.dst)));
    flow.edges.forEach((e) => { e._anti = eset.has(pk(e.dst, e.src)) ? (e.src < e.dst ? 1 : -1) : 0; });

    flow.edges.forEach((e, i) => {
      e._lt = EDGE_LABEL_TS[i % EDGE_LABEL_TS.length]; // stagger label along the curve
      const p = edgePath(e, flow.byId);
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('class', 'edge-path');
      path.setAttribute('d', p.d);
      path.setAttribute('marker-end', 'url(#flowArrow)');
      gEdges.appendChild(path);
      const t = document.createElementNS(SVGNS, 'text');
      t.setAttribute('class', 'edge-label');
      t.setAttribute('x', p.lx); t.setAttribute('y', p.ly);
      t.setAttribute('text-anchor', 'middle');
      t.textContent = e.label;
      gEdges.appendChild(t);
      e._path = path; e._label = t;
    });
  }

  flow.nodes.forEach((n) => {
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('class', 'node ' + n.kind + (((n.kind === 'machine' && n.interactive) || n.power) ? ' tunable' : ''));
    g.setAttribute('transform', `translate(${n.x},${n.y})`);
    const rect = document.createElementNS(SVGNS, 'rect');
    rect.setAttribute('width', n.w); rect.setAttribute('height', n.h);
    rect.setAttribute('rx', '7');
    g.appendChild(rect);
    const t1 = document.createElementNS(SVGNS, 'text');
    t1.setAttribute('class', 'n-title'); t1.setAttribute('x', 10); t1.setAttribute('y', 19);
    t1.textContent = n.title.length > 25 ? n.title.slice(0, 24) + '…' : n.title;
    g.appendChild(t1);
    const t2 = document.createElementNS(SVGNS, 'text');
    t2.setAttribute('class', 'n-sub'); t2.setAttribute('x', 10); t2.setAttribute('y', 35);
    t2.textContent = n.sub;
    g.appendChild(t2);
    n._g = g;
    gNodes.appendChild(g);
    attachDrag(g, n, flow);
  });
  ensureFlowControls();
}

function attachDrag(g, node, flow) {
  let last = null;   // last pointer pos while pressed (null = not pressing)
  let down = null;   // pos at press, to tell a tap from a drag
  let moved = false; // crossed the drag threshold since press
  g.addEventListener('pointerdown', (ev) => {
    last = { x: ev.clientX, y: ev.clientY };
    down = { x: ev.clientX, y: ev.clientY };
    moved = false;
    g.setPointerCapture(ev.pointerId); g.classList.add('dragging'); ev.preventDefault();
  });
  g.addEventListener('pointermove', (ev) => {
    if (!last) return;
    if (down && (Math.abs(ev.clientX - down.x) > 4 || Math.abs(ev.clientY - down.y) > 4)) moved = true;
    const k = (state.flowView && state.flowView.k) || 1; // screen px → world units under zoom
    node.x += (ev.clientX - last.x) / k;
    node.y += (ev.clientY - last.y) / k;
    last = { x: ev.clientX, y: ev.clientY };
    g.setAttribute('transform', `translate(${node.x},${node.y})`);
    // In Sankey mode the bands attach at stacked offsets (fixed relative to the node), so
    // the same path fn keeps them glued as the node moves; thin bands have no label to move.
    const pathOf = isSankey() ? sankeyEdgePath : edgePath;
    [...node.ins, ...node.outs].forEach((e) => {
      const p = pathOf(e, flow.byId);
      if (e._path) e._path.setAttribute('d', p.d);
      if (e._label) { e._label.setAttribute('x', p.lx); e._label.setAttribute('y', p.ly); }
    });
  });
  const finish = (ev, isUp) => {
    if (last && moved) { state.flowPos = state.flowPos || {}; state.flowPos[node.id] = { x: node.x, y: node.y }; save(); }
    // A press that didn't move is a tap → open the node settings popup for a tunable
    // machine (Overclock + Somersloop). Non-machine / non-interactive nodes do nothing.
    else if (isUp && last && !moved && node.kind === 'machine' && node.rc && node.interactive) {
      openNodePopup(node.rc, ev.clientX, ev.clientY);
    }
    // Power-infrastructure nodes (extractor / generator) open the per-node overclock popup.
    else if (isUp && last && !moved && node.power) {
      openPowerPopup(node.power, ev.clientX, ev.clientY);
    }
    last = null; down = null; g.classList.remove('dragging');
    try { g.releasePointerCapture(ev.pointerId); } catch (e) {}
  };
  g.addEventListener('pointerup', (ev) => finish(ev, true));
  g.addEventListener('pointercancel', (ev) => finish(ev, false));
}

// ---------- flowchart node settings popup (Overclock + Somersloop) ----------
// Tapping a machine node opens this. Edits write to state.nodeClock / state.nodeSloop for
// that step's recipe class and re-solve live (mirrors the table's clockCell / sloopCell).
// It floats on <body> — not inside the SVG — so the flow viewport can't clip it and it
// survives the re-render each edit triggers (it keys off the recipe class, re-reading the
// fresh step from lastResult on every refresh).
let nodePopupRc = null;
let powerPopupRef = null; // { kind:'ext', item } | { kind:'gen', idx } — power-node popup
const stepByRc = (rc) => (lastResult && lastResult.recipes ? lastResult.recipes.find((s) => s.rc === rc) : null);

function onNodePopupOutside(ev) {
  const p = $('nodePopup');
  if (!p) return;
  if (p.contains(ev.target)) return; // clicks inside keep it open
  // A press on another tunable node is handled by that node (reopens) — don't fight it.
  if (ev.target && ev.target.closest && ev.target.closest('.node.tunable')) return;
  closeNodePopup();
}
function onNodePopupKey(ev) { if (ev.key === 'Escape') closeNodePopup(); }
function closeNodePopup() {
  nodePopupRc = null;
  powerPopupRef = null;
  const p = $('nodePopup');
  if (p && p.parentNode) p.parentNode.removeChild(p);
  document.removeEventListener('pointerdown', onNodePopupOutside, true);
  document.removeEventListener('keydown', onNodePopupKey, true);
}
function openNodePopup(rc, clientX, clientY) {
  if (!stepByRc(rc)) return;
  nodePopupRc = rc;
  powerPopupRef = null; // leaving any power-node popup
  let p = $('nodePopup');
  if (!p) {
    p = el('div', 'node-popup'); p.id = 'nodePopup';
    document.body.appendChild(p);
    document.addEventListener('pointerdown', onNodePopupOutside, true);
    document.addEventListener('keydown', onNodePopupKey, true);
  }
  renderNodePopup();
  positionNodePopup(clientX, clientY);
}
function positionNodePopup(clientX, clientY) {
  const p = $('nodePopup'); if (!p) return;
  const vw = (typeof window !== 'undefined' && window.innerWidth) || 1024;
  const vh = (typeof window !== 'undefined' && window.innerHeight) || 768;
  const w = p.offsetWidth || 264, h = p.offsetHeight || 240;
  let x = (clientX != null ? clientX : vw / 2) + 14;
  let y = (clientY != null ? clientY : vh / 2) + 8;
  if (x + w > vw - 8) x = Math.max(8, (clientX != null ? clientX : vw / 2) - w - 14);
  if (y + h > vh - 8) y = Math.max(8, vh - h - 8);
  p.style.left = x + 'px';
  p.style.top = y + 'px';
}
function renderNodePopup() {
  const p = $('nodePopup'); if (!p) return;
  const rc = nodePopupRc;
  const s = stepByRc(rc);
  if (!s) { closeNodePopup(); return; } // step vanished (recipe changed) — nothing to tune
  const r = RECIPES[rc] || {};
  const b = BUILDINGS[r.building] || { exponent: 1.321929 };
  const title = r.alternate ? '★ ' + r.name.replace(/^Alternate:\s*/, '') : itemName(s.item);
  p.innerHTML = '';

  const x = el('button', 'modal-x', '✕'); x.title = 'Close'; x.addEventListener('click', closeNodePopup); p.appendChild(x);
  p.appendChild(el('div', 'np-title', title));
  p.appendChild(el('div', 'np-sub', `${fmt(Math.ceil(s.machines - 1e-9), 0)}× ${s.buildingName} · ${fmt(s.rate)} ${isFluid(s.item) ? 'm³' : ''}/min`));

  // ----- Overclock (power shards) -----
  const ocSec = el('div', 'np-section');
  ocSec.appendChild(el('div', 'np-label', 'Overclock (Power Shards)'));
  const curPct = Math.round((s.clock || state.clock) * 100);
  const applyClock = (pct) => {
    let v = Math.max(1, Math.min(250, Math.round(pct)));
    state.nodeClock = state.nodeClock || {};
    if (v === Math.round(state.clock * 100)) delete state.nodeClock[rc]; else state.nodeClock[rc] = v / 100;
    save(); solveAndRender(); renderNodePopup();
  };
  const ocRow = el('div', 'np-row');
  const inp = el('input', 'clock-input'); inp.type = 'number'; inp.min = '1'; inp.max = '250'; inp.step = '1';
  inp.value = curPct;
  inp.addEventListener('change', () => applyClock(parseFloat(inp.value) || 100));
  ocRow.appendChild(inp); ocRow.appendChild(el('span', 'np-unit', '%'));
  ocSec.appendChild(ocRow);
  const shardRow = el('div', 'np-shards');
  [[0, 100], [1, 150], [2, 200], [3, 250]].forEach(([n, pct]) => {
    const chip = el('button', 'np-chip', n + '◈');
    chip.title = n === 0 ? 'No shards · 100%' : `${n} power shard${n > 1 ? 's' : ''} · ${pct}%`;
    if (curPct === pct) chip.classList.add('on');
    chip.addEventListener('click', () => applyClock(pct));
    shardRow.appendChild(chip);
  });
  ocSec.appendChild(shardRow);
  const shards = Math.max(0, Math.min(3, Math.ceil((curPct - 100) / 50)));
  const ocMult = Math.pow((s.clock || 1), b.exponent || 1.321929);
  ocSec.appendChild(el('div', 'np-note', shards
    ? `${shards} power shard${shards > 1 ? 's' : ''} / machine · power ×${fmt(ocMult, 2)}`
    : 'No shards · power ×1.00'));
  p.appendChild(ocSec);

  // ----- Somersloop -----
  const slSec = el('div', 'np-section');
  slSec.appendChild(el('div', 'np-label', 'Somersloop'));
  const max = s.maxSloops || 1;
  const sel = el('select', 'sloop-input');
  for (let n = 0; n <= max; n++) {
    const o = el('option', null, n === 0 ? '— none' : `${n} · ${fmt(1 + n / max, 2)}×`);
    o.value = String(n); sel.appendChild(o);
  }
  sel.value = String(s.sloops || 0);
  sel.addEventListener('change', () => {
    const n = Math.max(0, Math.min(max, parseInt(sel.value, 10) || 0));
    state.nodeSloop = state.nodeSloop || {};
    if (n === 0) delete state.nodeSloop[rc]; else state.nodeSloop[rc] = n;
    save(); solveAndRender(); renderNodePopup();
  });
  slSec.appendChild(sel);
  const used = Math.ceil(s.machines - 1e-9) * (s.sloops || 0);
  slSec.appendChild(el('div', 'np-note', s.sloops
    ? `${s.sloops}/${max} slots · output ×${fmt(s.sloopMult, 2)} · uses ${used} sloop${used > 1 ? 's' : ''}`
    : `0/${max} slots · no amplification`));
  p.appendChild(slSec);

  p.appendChild(el('div', 'np-foot', 'Esc or click away to close'));
}

// ---------- power-node popup (overclock / power shards for extractors & generators) ----------
// Opened by tapping an extractor or generator node on the flowchart. Writes a per-node
// overclock override into state.power (extClock[item] for an extractor, gens[idx].clock for
// a generator), falling back to the global default when set back to it — mirroring the
// machine node popup. Re-solves so the table + flowchart + Power Planner page all update.
function openPowerPopup(ref, clientX, clientY) {
  nodePopupRc = null;
  powerPopupRef = ref;
  let p = $('nodePopup');
  if (!p) {
    p = el('div', 'node-popup'); p.id = 'nodePopup';
    document.body.appendChild(p);
    document.addEventListener('pointerdown', onNodePopupOutside, true);
    document.addEventListener('keydown', onNodePopupKey, true);
  }
  renderPowerPopup();
  positionNodePopup(clientX, clientY);
}
function renderPowerPopup() {
  const p = $('nodePopup'); if (!p) return;
  const ref = powerPopupRef; if (!ref) { closeNodePopup(); return; }
  const pw = ensurePower();
  let title, sub, curPct, note, apply;
  if (ref.kind === 'ext') {
    // Resolve the extractor from the shared infra sizing so a standalone generator's mined
    // fuel (not in res.raw) is found too, not just the plan's own raws.
    const infra = lastResult ? powerInfraFor(lastResult, lastTargets) : { extraction: [] };
    const e = infra.extraction.find((x) => x.item === ref.item);
    if (!e) { closeNodePopup(); return; }
    const exCls = FLUID_EXTRACTOR[ref.item] || pw.minerTier;
    const exponent = (EXTRACTORS[exCls] && EXTRACTORS[exCls].exponent) || 1.321929;
    title = `${e.name} · ${itemName(ref.item)}`;
    sub = `${fmt(Math.ceil(e.count - 1e-9), 0)}× · ${fmt(e.rate)} ${isFluid(ref.item) ? 'm³' : ''}/min`;
    curPct = clampClock(extClockOf(ref.item, pw));
    note = (s) => s ? `${s} shard${s > 1 ? 's' : ''} / extractor · power ×${fmt(Math.pow(curPct / 100, exponent), 2)}` : 'No shards · power ×1.00';
    apply = (pct) => { const v = clampClock(pct); if (v === clampClock(pw.minerClock)) delete pw.extClock[ref.item]; else pw.extClock[ref.item] = v; };
  } else if (ref.kind === 'sgen') {
    const g = pw.standalone[ref.sidx]; const G = g && POWERGEN[g.gen];
    if (!G) { closeNodePopup(); return; }
    const rate = +g.rate || 0;
    const z = genSizing(G, g.fuel, rate, genClockOf(g, pw));
    title = `${G.name} · ${itemName(g.fuel)}`;
    sub = `${fmt(z.nGen)}× · ${fmt(z.mw, 0)} MW · burns ${fmt(rate)}/min`;
    curPct = clampClock(genClockOf(g, pw));
    note = (s) => s ? `${s} shard${s > 1 ? 's' : ''} / generator · runs fewer, harder (total power unchanged)` : 'No shards · 100%';
    apply = (pct) => { const v = clampClock(pct); if (v === clampClock(pw.genClock)) delete g.clock; else g.clock = v; };
  } else {
    const g = pw.gens[ref.idx]; const G = g && POWERGEN[g.gen];
    if (!G) { closeNodePopup(); return; }
    const avail = lastResult ? outputsOf(lastResult, lastTargets).filter((o) => o.item === g.output).reduce((a, o) => a + o.rate, 0) : 0;
    const z = genSizing(G, g.output, avail, genClockOf(g, pw));
    title = `${G.name} · ${itemName(g.output)}`;
    sub = `${fmt(z.nGen)}× · ${fmt(z.mw, 0)} MW`;
    curPct = clampClock(genClockOf(g, pw));
    note = (s) => s ? `${s} shard${s > 1 ? 's' : ''} / generator · runs fewer, harder (total power unchanged)` : 'No shards · 100%';
    apply = (pct) => { const v = clampClock(pct); if (v === clampClock(pw.genClock)) delete g.clock; else g.clock = v; };
  }
  const applyClock = (pct) => { apply(pct); save(); solveAndRender(); renderPowerPopup(); };
  p.innerHTML = '';
  const x = el('button', 'modal-x', '✕'); x.title = 'Close'; x.addEventListener('click', closeNodePopup); p.appendChild(x);
  p.appendChild(el('div', 'np-title', title));
  p.appendChild(el('div', 'np-sub', sub));
  const ocSec = el('div', 'np-section');
  ocSec.appendChild(el('div', 'np-label', 'Overclock (Power Shards)'));
  const ocRow = el('div', 'np-row');
  const inp = el('input', 'clock-input'); inp.type = 'number'; inp.min = '1'; inp.max = '250'; inp.step = '1'; inp.value = curPct;
  inp.addEventListener('change', () => applyClock(parseFloat(inp.value) || 100));
  ocRow.appendChild(inp); ocRow.appendChild(el('span', 'np-unit', '%'));
  ocSec.appendChild(ocRow);
  const shardRow = el('div', 'np-shards');
  [[0, 100], [1, 150], [2, 200], [3, 250]].forEach(([n, pct]) => {
    const chip = el('button', 'np-chip', n + '◈');
    chip.title = n === 0 ? 'No shards · 100%' : `${n} power shard${n > 1 ? 's' : ''} · ${pct}%`;
    if (curPct === pct) chip.classList.add('on');
    chip.addEventListener('click', () => applyClock(pct));
    shardRow.appendChild(chip);
  });
  ocSec.appendChild(shardRow);
  ocSec.appendChild(el('div', 'np-note', note(Math.max(0, Math.min(3, Math.ceil((curPct - 100) / 50))))));
  p.appendChild(ocSec);
  p.appendChild(el('div', 'np-foot', 'Esc or click away to close'));
}

// ---------- flowchart zoom / pan ----------
const FLOW_MINK = 0.12, FLOW_MAXK = 2;
const clampFlowK = (k) => Math.max(FLOW_MINK, Math.min(FLOW_MAXK, k));
let flowSaveT = null;
const saveFlowViewSoon = () => { if (flowSaveT) return; flowSaveT = setTimeout(() => { flowSaveT = null; save(); }, 250); };

function applyFlowTransform() {
  const root = $('flowRoot'); if (!root) return;
  const v = state.flowView || { k: 1, tx: 0, ty: 0 };
  root.setAttribute('transform', `translate(${v.tx},${v.ty}) scale(${v.k})`);
  const pct = $('flowZoomPct'); if (pct) pct.textContent = Math.round(v.k * 100) + '%';
}

function flowViewport() {
  const svg = $('flowSvg'); if (!svg) return { w: 800, h: 440, left: 0, top: 0 };
  const r = svg.getBoundingClientRect();
  return { w: r.width || 800, h: r.height || 440, left: r.left, top: r.top };
}

// Scale the whole graph to fit the visible area, centered — never upscaled past 100% —
// so even big factories show end-to-end with nothing clipped off the right.
function fitFlow(flow) {
  if (!flow) return;
  const vp = flowViewport(), m = 24;
  const k = clampFlowK(Math.min((vp.w - 2 * m) / Math.max(1, flow.width), (vp.h - 2 * m) / Math.max(1, flow.height), 1));
  state.flowView = { k, tx: (vp.w - k * flow.width) / 2, ty: (vp.h - k * flow.height) / 2 };
  applyFlowTransform();
}

// Zoom by `factor` keeping the world point under (sx,sy) — screen px from the svg
// top-left — fixed on screen, so it zooms toward the cursor.
function zoomFlowAt(sx, sy, factor) {
  const v = state.flowView || { k: 1, tx: 0, ty: 0 };
  const nk = clampFlowK(v.k * factor);
  state.flowView = { k: nk, tx: sx - nk * (sx - v.tx) / v.k, ty: sy - nk * (sy - v.ty) / v.k };
  applyFlowTransform();
  saveFlowViewSoon();
}
function zoomFlowCenter(factor) { const vp = flowViewport(); zoomFlowAt(vp.w / 2, vp.h / 2, factor); }

// Wire pan (drag empty background) + wheel-zoom on the svg, once per element.
function ensureFlowControls() {
  const svg = $('flowSvg');
  if (!svg || svg._fcWired) return;
  svg._fcWired = true;
  let pan = null;
  svg.addEventListener('pointerdown', (ev) => {
    if (ev.target !== svg) return; // nodes handle their own drag; only blank space pans
    const v = state.flowView || { k: 1, tx: 0, ty: 0 };
    pan = { x: ev.clientX, y: ev.clientY, tx: v.tx, ty: v.ty };
    svg.setPointerCapture(ev.pointerId); svg.classList.add('panning');
  });
  svg.addEventListener('pointermove', (ev) => {
    if (!pan) return;
    const v = state.flowView || { k: 1, tx: 0, ty: 0 };
    state.flowView = { k: v.k, tx: pan.tx + (ev.clientX - pan.x), ty: pan.ty + (ev.clientY - pan.y) };
    applyFlowTransform();
  });
  const endPan = (ev) => {
    if (!pan) return;
    pan = null; svg.classList.remove('panning');
    try { svg.releasePointerCapture(ev.pointerId); } catch (_) {}
    save();
  };
  svg.addEventListener('pointerup', endPan);
  svg.addEventListener('pointercancel', endPan);
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const vp = flowViewport();
    zoomFlowAt(ev.clientX - vp.left, ev.clientY - vp.top, ev.deltaY < 0 ? 1.12 : 1 / 1.12);
  }, { passive: false });
}

function renderFlowView() {
  if (!lastResult) return;
  currentFlow = layoutFlow(buildFlow(lastResult, lastTargets));
  drawFlow(currentFlow);
  if (typeof window !== 'undefined') window.__lastFlow = currentFlow; // test/debug hook: inspect node + edge wiring
  // Keep the saved zoom/pan across tab toggles; first render of a plan fits to window.
  if (state.flowView && isFinite(state.flowView.k)) applyFlowTransform();
  else {
    fitFlow(currentFlow); // first pass — may run before the just-shown panel has its final size
    // Re-fit next frame once layout settled, but only if the user hasn't taken over yet.
    const flow = currentFlow;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { if (flow === currentFlow) fitFlow(flow); });
  }
}
// Reflect the per-plan flowPower toggle on its button (active = power infrastructure shown).
function syncFlowPowerBtn() {
  const b = $('flowPowerToggle');
  if (b) b.classList.toggle('active', !!state.flowPower);
}
function applyView() {
  const sankey = state.view === 'sankey';
  const flow = state.view === 'flow' || sankey; // both views share the flowchart plumbing
  $('flowView').hidden = !flow;
  $('tableView').hidden = flow;
  $('viewFlow').classList.toggle('active', state.view === 'flow');
  if ($('viewSankey')) $('viewSankey').classList.toggle('active', sankey);
  $('viewTables').classList.toggle('active', state.view === 'tables');
  const hint = $('flowHint');
  if (hint) hint.textContent = sankey
    ? 'Band width = items / min · colour = material (cyan = fluid). Hover a thin band for its rate · drag nodes to rearrange · scroll to zoom · drag empty space to pan.'
    : 'Click a machine to set Overclock / Somersloop · drag nodes to rearrange · scroll to zoom · drag empty space to pan. Gray = raw · orange = machine · green = output · pink = sink · blue = generator · copper = extractor.';
  syncFlowPowerBtn();
  if (flow) renderFlowView();
  else closeNodePopup(); // the popup belongs to the flowchart — drop it when leaving flow view
}

// ---------- resource map ----------
// World coordinate bounds of the bundled 5000x5000 map render (Satisfactory Wiki).
// North is -Y, so the image top edge = MAP_BOUNDS.north. Values are the community
// standard used by the in-game map / SCIM (centimetres).
const MAP_BOUNDS = { west: -324698.832031, east: 425301.832031, north: -375000, south: 375000 };
const MAP_IMG_W = 5000, MAP_IMG_H = 5000;
const RES_COLORS = {
  Desc_OreIron_C: '#c2693f', Desc_OreCopper_C: '#e08a3a', Desc_Stone_C: '#cdbf95',
  Desc_Coal_C: '#586271', Desc_OreGold_C: '#e8c84a', Desc_RawQuartz_C: '#e08ad6',
  Desc_Sulfur_C: '#e6db4a', Desc_OreBauxite_C: '#b07a52', Desc_OreUranium_C: '#5fd35f',
  Desc_SAM_C: '#9b5fd3', Desc_LiquidOil_C: '#a98bd0', Desc_NitrogenGas_C: '#6fc0cf',
  Desc_Water_C: '#3f8fd9',
};
const KIND_COLOR = { geyser: '#efe9ff', frackingCore: '#a98bd0', frackingSatellite: '#8d79b8', deposit: '#9aa0a8', node: '#c9cdd3' };
const KIND_LABEL = { node: 'Resource node', geyser: 'Geyser', frackingCore: 'Resource well', frackingSatellite: 'Well satellite', deposit: 'Small deposit' };
const PURITY_R = { Pure: 6, Normal: 4.6, Impure: 3.4 };

// ---------- collectables overlay (uncollected pickups from the save) ----------
const COLL_COLOR = {
  slugBlue: '#3fa9ff', slugYellow: '#ffd23f', slugPurple: '#c060f0',
  somersloop: '#ff9a3c', mercerSphere: '#36c9b0', crashSite: '#ff6b5c',
};
const COLL_LABEL = {
  slugBlue: 'Power slug (blue)', slugYellow: 'Power slug (yellow)', slugPurple: 'Power slug (purple)',
  somersloop: 'Somersloop', mercerSphere: 'Mercer sphere', crashSite: 'Crash site (hard drive)',
};
const COLL_KINDS = ['slugBlue', 'slugYellow', 'slugPurple', 'somersloop', 'mercerSphere', 'crashSite'];
let mapCollectables = [];          // uncollected collectables from the loaded save
let mapCollOn = { slugBlue: true, slugYellow: true, slugPurple: true, somersloop: true, mercerSphere: true, crashSite: true };
function collVisible(c) { return !!mapCollOn[c.kind]; }

let mapImg = null, mapImgReady = false;
let mapNodes = [];                 // resource nodes from the loaded save
let mapResOn = null;               // Set of enabled resourceClass keys ('__unknown' bucket allowed)
let mapKindOn = { geyser: true, frackingCore: true, deposit: false };
let mapV = { s: 1, ox: 0, oy: 0, ready: false };  // view transform: image px -> css px (screen = img*s + o)
let mapFitS = 1;                   // scale at which the whole map fits (zoom clamp reference)
let mapDrag = null;
let mapRAF = 0;
let mapCw = 0, mapCh = 0;          // last canvas CSS size, for reframing on window resize

// ---------- Base X-ray (production analysis from a save) ----------
let xrayRaw = null;                // flat per-actor records from the last parse (PX.extractRecords)
let xrayRawFile = '';              // which .sav xrayRaw was parsed from (so plan switches don't re-parse)
let xrayData = null;               // aggregated summary for the active plan's scope (PX.aggregate)
let xrayFilter = '';               // item-table search box
let xraySort = 'netDesc';          // item-table sort key
let xrayHideBalanced = false;
let xrayRawOnly = false;

// ---------- map region drawing (the per-plan factory outline) ----------
let mapDrawing = false;            // true while the user is tracing a polygon
let mapDrawPts = [];               // in-progress vertices in WORLD cm
let mapDrawHover = null;           // live cursor position in world cm (preview segment)
let mapArmedForXray = false;       // routed here from the X-ray tab — show the "outline this" prompt

// ---------- factory buildings overlay (Cartograph-style) ----------
// Buildings are drawn as vectors every frame (not baked to an offscreen) so that
// thin belts/wires stay one screen-pixel wide at any zoom — exactly how the node
// markers keep a constant screen size. Image-space px per world cm (uniform on
// both axes): the 5000px render spans MAP_BOUNDS east-west = ~750000 cm.
const IMG_PX_PER_CM = MAP_IMG_W / (MAP_BOUNDS.east - MAP_BOUNDS.west);
// Default in-game customization swatch slot -> approximate paint color. Used only
// in "By paint" color mode; unknown/custom swatches fall back to a neutral grey.
const SWATCH_COLORS = {
  SwatchDesc_Slot0_C: '#e8a33d', SwatchDesc_Slot1_C: '#c64a3b', SwatchDesc_Slot2_C: '#d98b3a',
  SwatchDesc_Slot3_C: '#e0c84a', SwatchDesc_Slot4_C: '#7bbf48', SwatchDesc_Slot5_C: '#46b06a',
  SwatchDesc_Slot6_C: '#3fb59b', SwatchDesc_Slot7_C: '#3f9fd9', SwatchDesc_Slot8_C: '#4a6fd0',
  SwatchDesc_Slot9_C: '#7a5fd3', SwatchDesc_Slot10_C: '#b05fd0', SwatchDesc_Slot11_C: '#d05f9f',
  SwatchDesc_Slot12_C: '#8a939e', SwatchDesc_Slot13_C: '#5c6670', SwatchDesc_Slot14_C: '#3a4048',
  SwatchDesc_Slot15_C: '#cfd4da', SwatchDesc_Slot16_C: '#9a8c7a', SwatchDesc_Slot17_C: '#6b5b45',
  SwatchDesc_FoundationModern_C: '#9aa0a8', SwatchDesc_ProjectAssembly_C: '#e08a3a',
};
const CAT_LABEL = {
  production: 'Production', extraction: 'Extraction', power: 'Power', logistics: 'Logistics',
  storage: 'Storage', foundation: 'Foundations', vehicle: 'Vehicles', organization: 'Organization',
  decoration: 'Decoration', other: 'Other',
};
// Stroke width (screen px) per path kind; machine footprints use a min screen size.
const PATH_W = { belt: 1.7, pipe: 1.7, wire: 0.9 };
const MACHINE_MIN_PX = 3;          // smallest a footprint is drawn, so it stays visible when zoomed out

let mapBuildings = [];             // building records from the loaded save
let mapBuildShow = true;           // master overlay toggle
let mapBuildOpacity = 0.9;
let mapCatOn = null;               // Set of enabled categories (null => all on)
let mapColorMode = 'category';     // 'category' | 'paint'
let mapMarkClock = false;          // ring machines that are overclocked / somerslooped

function catVisible(cat) { return !mapCatOn || mapCatOn.has(cat); }
function buildingColor(b) {
  if (mapColorMode === 'paint') return SWATCH_COLORS[b.swatch] || '#8a8f98';
  return b._catColor || BMETA.buildingMeta(b.className).color;
}
// Annotate raw building records with stable render fields once at load, so the
// per-frame draw loop does no metadata lookups AND no coordinate projection.
// Image-space coords depend only on world position + the fixed map bounds (not on
// zoom/pan, which are a canvas transform), so they're constant and precomputable:
// projecting all of them once here instead of every frame is the big win on saves
// with 100k+ buildings. Paths also get an image-space bbox for viewport culling.
function annotateBuildings(list) {
  for (const b of list) {
    const m = BMETA.buildingMeta(b.className);
    b._cat = m.category; b._w = m.w; b._d = m.d; b._catColor = m.color;
    b._ix = worldToImgX(b.x); b._iy = worldToImgY(b.y); // image-space anchor
    if (b.path && b.path.length) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      const ip = new Array(b.path.length);
      for (let i = 0; i < b.path.length; i++) {
        const px = worldToImgX(b.path[i].x), py = worldToImgY(b.path[i].y);
        ip[i] = { x: px, y: py };
        if (px < x0) x0 = px; if (px > x1) x1 = px;
        if (py < y0) y0 = py; if (py > y1) y1 = py;
      }
      b._ipath = ip; b._bx0 = x0; b._by0 = y0; b._bx1 = x1; b._by1 = y1;
    }
  }
  return list;
}
function buildingDisplayName(cn) {
  if (BUILDINGS[cn] && BUILDINGS[cn].name) return BUILDINGS[cn].name;
  return String(cn).replace(/^Build_/, '').replace(/_C$/, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\bMk(\d)/, 'Mk $1').trim();
}

function ensureMapImg() {
  if (mapImg) return;
  mapImg = new Image();
  mapImg.onload = () => { mapImgReady = true; if (state.mode === 'map') { if (!mapV.ready) fitMapView(); drawMap(); } };
  mapImg.onerror = () => { mapImgReady = false; if (state.mode === 'map') drawMap(); };
  mapImg.src = 'map.jpg'; // same dir as index.html -> same-origin, satisfies CSP 'self'
}
function worldToImgX(x) { return (x - MAP_BOUNDS.west) / (MAP_BOUNDS.east - MAP_BOUNDS.west) * MAP_IMG_W; }
function worldToImgY(y) { return (y - MAP_BOUNDS.north) / (MAP_BOUNDS.south - MAP_BOUNDS.north) * MAP_IMG_H; }
// Inverses, for turning a click back into world cm (region drawing).
function imgToWorldX(ix) { return MAP_BOUNDS.west + (ix / MAP_IMG_W) * (MAP_BOUNDS.east - MAP_BOUNDS.west); }
function imgToWorldY(iy) { return MAP_BOUNDS.north + (iy / MAP_IMG_H) * (MAP_BOUNDS.south - MAP_BOUNDS.north); }
// Canvas CSS-pixel coords -> world cm (screen = img*s + o; getBoundingClientRect gives CSS px).
function screenToWorld(sx, sy) {
  return { x: imgToWorldX((sx - mapV.ox) / mapV.s), y: imgToWorldY((sy - mapV.oy) / mapV.s) };
}
function resourceColor(n) { return (n.resourceClass && RES_COLORS[n.resourceClass]) || KIND_COLOR[n.kind] || '#bbb'; }

function resOn(n) {
  if (!mapResOn) return true;
  return mapResOn.has(n.resourceClass || '__unknown');
}
function nodeVisible(n) {
  switch (n.kind) {
    case 'geyser': return mapKindOn.geyser;
    case 'frackingCore':
    case 'frackingSatellite': return mapKindOn.frackingCore;
    case 'deposit': return mapKindOn.deposit && resOn(n);
    default: return resOn(n); // mineable 'node'
  }
}

function resizeMapCanvas() {
  const wrap = $('mapWrap'), cv = $('mapCanvas');
  const dpr = window.devicePixelRatio || 1;
  const cw = wrap.clientWidth || 1, ch = wrap.clientHeight || 1;
  cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
  cv.style.width = cw + 'px'; cv.style.height = ch + 'px';
  mapCw = cw; mapCh = ch;
  return { cw, ch, dpr };
}
// On window resize the canvas changes size but the view transform doesn't, so the
// map drifts off-centre. Keep the image-space point that was at the canvas centre
// fixed at the new centre (uses the PREVIOUS canvas size still held in mapCw/mapCh).
function reframeMapForResize() {
  if (!mapV.ready || !mapCw || !mapCh) return;
  const wrap = $('mapWrap'); if (!wrap) return;
  const nw = wrap.clientWidth || mapCw, nh = wrap.clientHeight || mapCh;
  const cx = (mapCw / 2 - mapV.ox) / mapV.s, cy = (mapCh / 2 - mapV.oy) / mapV.s;
  mapV.ox = nw / 2 - cx * mapV.s; mapV.oy = nh / 2 - cy * mapV.s;
}
function fitMapView() {
  const wrap = $('mapWrap'); if (!wrap) return;
  const cw = wrap.clientWidth || 800, ch = wrap.clientHeight || 600;
  const s = Math.min(cw / MAP_IMG_W, ch / MAP_IMG_H) * 0.98;
  mapFitS = s;
  mapV = { s, ox: (cw - MAP_IMG_W * s) / 2, oy: (ch - MAP_IMG_H * s) / 2, ready: true };
}
function scheduleMapDraw() { if (mapRAF) return; mapRAF = requestAnimationFrame(() => { mapRAF = 0; drawMap(); }); }

function drawMarker(ctx, n, ix, iy, s) {
  const base = PURITY_R[n.purity] || 4;
  const screenR = n.kind === 'deposit' ? 2.4 : n.kind === 'frackingSatellite' ? 3 : base;
  const r = screenR / s;
  ctx.beginPath();
  if (n.kind === 'geyser') { ctx.moveTo(ix, iy - r); ctx.lineTo(ix + r, iy); ctx.lineTo(ix, iy + r); ctx.lineTo(ix - r, iy); ctx.closePath(); }
  else if (n.kind === 'frackingCore') { ctx.rect(ix - r, iy - r, 2 * r, 2 * r); }
  else { ctx.arc(ix, iy, r, 0, Math.PI * 2); }
  ctx.fillStyle = resourceColor(n);
  ctx.fill();
  ctx.lineWidth = 1.3 / s; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.stroke();
  if (n.purity === 'Pure') { ctx.beginPath(); ctx.arc(ix, iy, r + 2.4 / s, 0, Math.PI * 2); ctx.lineWidth = 1.3 / s; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke(); }
}
// Collectable markers, drawn at a constant screen size (like resource nodes) with
// a distinct shape per group so they read apart from ore dots: slugs = 4-point
// sparkle (tier colour), Somersloop = ringed dot, Mercer sphere = pipped dot,
// crash site = triangle.
function drawCollectable(ctx, c, ix, iy, s) {
  const col = COLL_COLOR[c.kind] || '#fff';
  ctx.lineWidth = 1.2 / s;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.fillStyle = col;
  if (c.kind === 'crashSite') {
    const r = 5.2 / s;
    ctx.beginPath();
    ctx.moveTo(ix, iy - r); ctx.lineTo(ix + r * 0.92, iy + r * 0.72); ctx.lineTo(ix - r * 0.92, iy + r * 0.72); ctx.closePath();
    ctx.fill(); ctx.stroke();
  } else if (c.kind === 'somersloop') {
    const r = 4.4 / s;
    ctx.beginPath(); ctx.arc(ix, iy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(ix, iy, r * 0.42, 0, Math.PI * 2); ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fill();
  } else if (c.kind === 'mercerSphere') {
    const r = 4.2 / s;
    ctx.beginPath(); ctx.arc(ix, iy, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(ix, iy, r * 0.32, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fill();
  } else {
    // power slugs — 4-point sparkle
    const r = 4.6 / s, ir = r * 0.4;
    ctx.beginPath();
    ctx.moveTo(ix, iy - r); ctx.lineTo(ix + ir, iy - ir); ctx.lineTo(ix + r, iy); ctx.lineTo(ix + ir, iy + ir);
    ctx.lineTo(ix, iy + r); ctx.lineTo(ix - ir, iy + ir); ctx.lineTo(ix - r, iy); ctx.lineTo(ix - ir, iy - ir);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
  }
}
// Visible image-space rect (with margin) for viewport culling. screen = img*s + o.
function visibleImgRect(cw, ch, mar) {
  const s = mapV.s;
  return {
    x0: (0 - mapV.ox) / s - mar, x1: (cw - mapV.ox) / s + mar,
    y0: (0 - mapV.oy) / s - mar, y1: (ch - mapV.oy) / s + mar,
  };
}
// Draw one footprint (rotated rect) + an optional overclock/somersloop ring.
function drawFootprint(ctx, b, s, minHalf) {
  const ix = b._ix, iy = b._iy; // precomputed image-space anchor (see annotateBuildings)
  const hw = Math.max(minHalf, (b._w * IMG_PX_PER_CM * (b.sx || 1)) / 2);
  const hd = Math.max(minHalf, (b._d * IMG_PX_PER_CM * (b.sy || 1)) / 2);
  ctx.save();
  ctx.translate(ix, iy);
  if (b.yaw) ctx.rotate(b.yaw);
  ctx.fillStyle = buildingColor(b);
  ctx.fillRect(-hw, -hd, 2 * hw, 2 * hd);
  ctx.lineWidth = 0.7 / s; ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.strokeRect(-hw, -hd, 2 * hw, 2 * hd);
  ctx.restore();
  if (mapMarkClock && (Math.abs((b.overclock || 1) - 1) > 1e-3 || (b.boost || 0) > 0)) {
    ctx.beginPath();
    ctx.arc(ix, iy, Math.max(hw, hd) + 2.2 / s, 0, Math.PI * 2);
    ctx.lineWidth = 1.4 / s;
    ctx.strokeStyle = (b.boost || 0) > 0 ? 'rgba(236,99,60,0.95)' : 'rgba(255,255,255,0.9)';
    ctx.stroke();
  }
}
// Draw the factory-buildings overlay in IMAGE space (ctx already carries the map
// transform). Vector every frame, viewport-culled, with screen-constant stroke
// widths and a minimum footprint size so the layer reads at any zoom. Layered
// bottom->top: foundations (floors) -> belts/pipes/wires -> machines, so a
// machine always draws on top of the floor it sits on.
function drawBuildings(ctx, s, cw, ch) {
  if (!mapBuildShow || !mapBuildings.length) return;
  const vr = visibleImgRect(cw, ch, 200 / s);
  const inView = (b) => (b._ix >= vr.x0 && b._ix <= vr.x1 && b._iy >= vr.y0 && b._iy <= vr.y1);
  const minHalf = (MACHINE_MIN_PX / 2) / s;
  ctx.save();
  ctx.globalAlpha = mapBuildOpacity;
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';

  // Pass 0: foundations / floors — first, so everything else sits on top.
  for (const b of mapBuildings) {
    if (b.kind !== 'machine' || b._cat !== 'foundation') continue;
    if (!catVisible(b._cat) || !inView(b)) continue;
    drawFootprint(ctx, b, s, minHalf);
  }

  // Pass 1: paths (belts / pipes / wires) — over the floors, under the machines.
  for (const b of mapBuildings) {
    if (b.kind === 'machine' || !b._ipath) continue;
    if (!catVisible(b._cat)) continue;
    // Cull by the path's bounding box, not its anchor — a long belt whose origin is
    // off-screen can still cross the viewport, so anchor-culling made it vanish.
    if (b._bx1 < vr.x0 || b._bx0 > vr.x1 || b._by1 < vr.y0 || b._by0 > vr.y1) continue;
    ctx.beginPath();
    for (let i = 0; i < b._ipath.length; i++) {
      const p = b._ipath[i];
      if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = buildingColor(b);
    ctx.lineWidth = (PATH_W[b.kind] || 1.2) / s;
    ctx.stroke();
  }

  // Pass 2: machines (everything except foundations) — on top.
  for (const b of mapBuildings) {
    if (b.kind !== 'machine' || b._cat === 'foundation') continue;
    if (!catVisible(b._cat) || !inView(b)) continue;
    drawFootprint(ctx, b, s, minHalf);
  }
  ctx.restore();
}
function drawMap() {
  const cv = $('mapCanvas'); if (!cv) return;
  const { cw, ch, dpr } = resizeMapCanvas();
  const ctx = cv.getContext('2d');
  if (!ctx) return; // no 2D context (e.g. headless jsdom without the canvas package)
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#10141b'; ctx.fillRect(0, 0, cv.width, cv.height);
  if (!mapV.ready) fitMapView();
  ctx.setTransform(dpr * mapV.s, 0, 0, dpr * mapV.s, dpr * mapV.ox, dpr * mapV.oy);
  if (mapImgReady) ctx.drawImage(mapImg, 0, 0, MAP_IMG_W, MAP_IMG_H);
  else { ctx.fillStyle = '#1b2230'; ctx.fillRect(0, 0, MAP_IMG_W, MAP_IMG_H); }
  const s = mapV.s;
  drawBuildings(ctx, s, cw, ch);
  for (const n of mapNodes) {
    if (!nodeVisible(n)) continue;
    drawMarker(ctx, n, worldToImgX(n.x), worldToImgY(n.y), s);
  }
  for (const c of mapCollectables) {
    if (!collVisible(c)) continue;
    drawCollectable(ctx, c, worldToImgX(c.x), worldToImgY(c.y), s);
  }
  drawRegions(ctx, s);
  updateMapCount();
}

// Draw the per-plan factory outlines: other plans in this project faintly (with a name
// label) so the carve-up is visible, the active plan's saved area solid, and any
// in-progress trace with a preview segment to the cursor. All in image space (ctx
// already carries the map transform); strokes are /s so they stay one screen px.
function regionToImg(poly) { return poly.map((p) => ({ x: worldToImgX(p.x), y: worldToImgY(p.y) })); }
function strokePoly(ctx, pts, close) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  if (close) ctx.closePath();
}
function drawRegions(ctx, s) {
  const accent = (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#f9a825').trim();
  // other plans in the active project (faint, read-only) — context for the carve-up
  const act = activePlan();
  for (const p of (typeof activeProjectPlans === 'function' ? activeProjectPlans() : [])) {
    if (!act || p.id === act.id) continue;
    const poly = p.state && p.state.xrayRegion;
    if (!poly || poly.length < 3) continue;
    const pts = regionToImg(poly);
    strokePoly(ctx, pts, true);
    ctx.fillStyle = 'rgba(120,140,170,0.06)'; ctx.fill();
    ctx.lineWidth = 1 / s; ctx.strokeStyle = 'rgba(150,170,200,0.5)'; ctx.setLineDash([6 / s, 5 / s]); ctx.stroke(); ctx.setLineDash([]);
    // name label at the polygon's centroid
    let cx = 0, cy = 0; for (const q of pts) { cx += q.x; cy += q.y; } cx /= pts.length; cy /= pts.length;
    ctx.fillStyle = 'rgba(180,195,215,0.7)'; ctx.font = `${12 / s}px system-ui, sans-serif`; ctx.textAlign = 'center';
    ctx.fillText(p.name, cx, cy);
  }
  // active plan's saved area (solid accent)
  const saved = state.xrayRegion;
  if (saved && saved.length >= 3 && !mapDrawing) {
    const pts = regionToImg(saved);
    strokePoly(ctx, pts, true);
    ctx.fillStyle = 'rgba(249,168,37,0.10)'; ctx.fill();
    ctx.lineWidth = 2 / s; ctx.strokeStyle = accent; ctx.stroke();
    for (const q of pts) { ctx.beginPath(); ctx.arc(q.x, q.y, 3 / s, 0, Math.PI * 2); ctx.fillStyle = accent; ctx.fill(); }
  }
  // in-progress trace
  if (mapDrawing && mapDrawPts.length) {
    const pts = regionToImg(mapDrawPts);
    strokePoly(ctx, pts, false);
    if (mapDrawHover) ctx.lineTo(worldToImgX(mapDrawHover.x), worldToImgY(mapDrawHover.y));
    ctx.lineWidth = 2 / s; ctx.strokeStyle = accent; ctx.setLineDash([5 / s, 4 / s]); ctx.stroke(); ctx.setLineDash([]);
    for (const q of pts) { ctx.beginPath(); ctx.arc(q.x, q.y, 3.5 / s, 0, Math.PI * 2); ctx.fillStyle = accent; ctx.fill(); }
    // highlight the first vertex (click it to close) once there are enough points
    if (pts.length >= 3) { ctx.beginPath(); ctx.arc(pts[0].x, pts[0].y, 6 / s, 0, Math.PI * 2); ctx.lineWidth = 1.5 / s; ctx.strokeStyle = '#fff'; ctx.stroke(); }
  }
}
function updateMapCount() {
  const c = $('mapCount'); if (!c) return;
  if (!mapNodes.length && !mapBuildings.length && !mapCollectables.length) { c.textContent = 'No save loaded.'; return; }
  const parts = [];
  if (mapNodes.length) {
    const vis = mapNodes.reduce((a, n) => a + (nodeVisible(n) ? 1 : 0), 0);
    parts.push(`${vis} / ${mapNodes.length} nodes`);
  }
  if (mapCollectables.length) {
    const vis = mapCollectables.reduce((a, c) => a + (collVisible(c) ? 1 : 0), 0);
    parts.push(`${vis} / ${mapCollectables.length} collectables`);
  }
  if (mapBuildings.length) {
    const vis = mapBuildShow ? mapBuildings.reduce((a, b) => a + (catVisible(b._cat) ? 1 : 0), 0) : 0;
    parts.push(`${vis} / ${mapBuildings.length} buildings`);
  }
  c.textContent = parts.join(' · ');
}

function buildMapResFilter() {
  const box = $('mapResFilter'); if (!box) return;
  box.innerHTML = '';
  const counts = new Map();
  for (const n of mapNodes) { if (n.kind !== 'node' && n.kind !== 'deposit') continue; const k = n.resourceClass || '__unknown'; counts.set(k, (counts.get(k) || 0) + 1); }
  if (!counts.size) { box.appendChild(el('small', 'hint', 'No mineable nodes in this save.')); return; }
  // Default: every known resource on. The unknown/vanilla bucket is off when there
  // ARE known (randomizer-overridden) resources — it's mostly noise then. But on a
  // vanilla save every node is unknown (the game doesn't store static node types),
  // so if unknown is the only bucket, default it ON or the map would show nothing.
  if (!mapResOn) {
    const allKeys = [...counts.keys()];
    const onlyUnknown = allKeys.length === 1 && allKeys[0] === '__unknown';
    mapResOn = new Set(onlyUnknown ? allKeys : allKeys.filter((k) => k !== '__unknown'));
  }
  const keys = [...counts.keys()].sort((a, b) => {
    const an = a === '__unknown' ? '￿' : itemName(a), bn = b === '__unknown' ? '￿' : itemName(b);
    return an.localeCompare(bn);
  });
  for (const k of keys) {
    const row = el('label', 'check map-res-row');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = mapResOn.has(k); cb.dataset.res = k;
    cb.addEventListener('change', () => { if (cb.checked) mapResOn.add(k); else mapResOn.delete(k); scheduleMapDraw(); });
    const sw = el('span', 'map-swatch'); sw.style.background = k === '__unknown' ? '#888' : (RES_COLORS[k] || '#bbb');
    row.appendChild(cb); row.appendChild(sw);
    row.appendChild(document.createTextNode(' ' + (k === '__unknown' ? 'Unknown / vanilla' : itemName(k)) + ' (' + counts.get(k) + ')'));
    box.appendChild(row);
  }
}
function setAllMapRes(on) {
  const box = $('mapResFilter'); if (!box) return;
  mapResOn = new Set();
  box.querySelectorAll('input[type=checkbox]').forEach((cb) => { cb.checked = on; if (on) mapResOn.add(cb.dataset.res); });
  scheduleMapDraw();
}

// Collectables overlay: fixed kinds with static checkboxes (data-coll). Counts
// are filled from the loaded save; All/None flip every kind at once.
function updateCollectableCounts(counts) {
  counts = counts || {};
  document.querySelectorAll('[data-coll-cnt]').forEach((span) => {
    span.textContent = '(' + (counts[span.dataset.collCnt] || 0) + ')';
  });
}
function setAllColl(on) {
  COLL_KINDS.forEach((k) => { mapCollOn[k] = on; });
  document.querySelectorAll('input[data-coll]').forEach((cb) => { cb.checked = on; });
  scheduleMapDraw();
}

// Category filter for the buildings overlay: checkbox + color swatch + count per
// category present in the loaded save. Mirrors buildMapResFilter.
function buildBuildingCatFilter() {
  const box = $('mapCatFilter'); if (!box) return;
  box.innerHTML = '';
  const counts = new Map();
  for (const b of mapBuildings) counts.set(b._cat, (counts.get(b._cat) || 0) + 1);
  if (!counts.size) { box.appendChild(el('small', 'hint', 'No buildings in this save.')); return; }
  if (!mapCatOn) mapCatOn = new Set(counts.keys()); // default: every category on
  const order = ['production', 'extraction', 'power', 'logistics', 'storage', 'foundation', 'vehicle', 'organization', 'decoration', 'other'];
  const keys = [...counts.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  for (const k of keys) {
    const row = el('label', 'check map-res-row');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = mapCatOn.has(k); cb.dataset.cat = k;
    cb.addEventListener('change', () => { if (cb.checked) mapCatOn.add(k); else mapCatOn.delete(k); scheduleMapDraw(); });
    const sw = el('span', 'map-swatch'); sw.style.background = BMETA.CATEGORY_COLORS[k] || '#888';
    row.appendChild(cb); row.appendChild(sw);
    row.appendChild(document.createTextNode(' ' + (CAT_LABEL[k] || k) + ' (' + counts.get(k) + ')'));
    box.appendChild(row);
  }
}
function setAllMapCat(on) {
  const box = $('mapCatFilter'); if (!box) return;
  mapCatOn = new Set();
  box.querySelectorAll('input[type=checkbox]').forEach((cb) => { cb.checked = on; if (on) mapCatOn.add(cb.dataset.cat); });
  scheduleMapDraw();
}
function buildPurityLegend() {
  const box = $('mapPurityLegend'); if (!box || box.dataset.built) return;
  box.dataset.built = '1';
  [['pure', 'Pure — larger + white ring'], ['normal', 'Normal — medium'], ['impure', 'Impure — small']].forEach(([cls, txt]) => {
    const row = el('div', 'map-legend-row');
    row.appendChild(el('span', 'map-legend-dot map-pur-' + cls));
    row.appendChild(el('span', 'map-legend-txt', txt));
    box.appendChild(row);
  });
}

// Human "x ago" for a save-file mtime (ms epoch). '' when unknown.
function relAge(ms) {
  if (!ms) return '';
  const s = (Date.now() - ms) / 1000;
  if (s < 90) return 'just now';
  const m = s / 60; if (m < 90) return Math.round(m) + 'm ago';
  const h = m / 60; if (h < 36) return Math.round(h) + 'h ago';
  return Math.round(h / 24) + 'd ago';
}
// Parse a specific save and rebuild the map overlay. silent=true (auto-newest-save path)
// drops the "Parsing…"/error chrome so a background reload doesn't flash the UI.
function loadMapFrom(file, silent) {
  const st = $('mapStatus');
  if (!file) { if (st && !silent) st.textContent = 'No save selected.'; return; }
  if (st && !silent) { st.classList.remove('warn-text'); st.textContent = 'Parsing save…'; }
  state.saveFile = file; save(); // remember across sessions
  // Defer so "Parsing…" paints before the synchronous parse blocks the thread.
  setTimeout(() => {
    let res;
    try { res = SAVE.readMap(file); }
    catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
    if (!res.ok) { if (st && !silent) { st.textContent = '⚠ ' + res.error; st.classList.add('warn-text'); } return; }
    mapNodes = res.nodes; mapResOn = null;
    mapBuildings = annotateBuildings(res.buildings || []); mapCatOn = null;
    mapCollectables = res.collectables || [];
    buildMapResFilter(); buildPurityLegend(); buildBuildingCatFilter();
    updateCollectableCounts(res.collectableCounts);
    const nc = res.nodeCounts || {};
    const bt = (res.buildingCounts && res.buildingCounts.total) || 0;
    const ct = mapCollectables.length;
    // The overlay is a snapshot of the save file, not the live game. Show how old that
    // save is so a stale overlay (e.g. buildings you removed in-game after the last
    // save) is obvious — reload after saving in-game to refresh it.
    const age = relAge(res.savedAt);
    const orphans = res.orphansHidden || 0;
    if (st) st.textContent = `${res.saveName}: ${nc.node || 0} nodes · ${nc.geyser || 0} geysers · ${nc.frackingCore || 0} wells · ${bt} buildings · ${ct} collectables`
      + (orphans ? ` · ${orphans} dismantled hidden` : '')
      + (age ? ` · saved ${age}` : '');
    $('mapEmpty').hidden = true;
    ensureMapImg(); fitMapView(); drawMap();
  }, 20);
}
function loadMapFromSave() {
  const sel = $('mapSaveSelect');
  loadMapFrom(sel && sel.value, false);
}

// ---------- factory-area drawing (the per-plan outline that scopes the X-ray) ----------
// The polygon is stored on the ACTIVE plan (state.xrayRegion) in world cm, so each plan
// outlines its own slice of the shared save. Trace = click vertices, click the first
// vertex (or double-click / Enter) to close, Esc to cancel.
function startAreaDraw() {
  if (state.mode !== 'map') setMode('map');
  mapDrawing = true; mapDrawPts = []; mapDrawHover = null;
  const cv = $('mapCanvas'); if (cv) cv.classList.add('drawing');
  renderAreaControls(); scheduleMapDraw();
}
function cancelAreaDraw() {
  mapDrawing = false; mapDrawPts = []; mapDrawHover = null;
  const cv = $('mapCanvas'); if (cv) cv.classList.remove('drawing');
  renderAreaControls(); scheduleMapDraw();
}
function finishAreaDraw() {
  if (mapDrawPts.length >= 3) {
    state.xrayRegion = mapDrawPts.map((p) => ({ x: p.x, y: p.y }));
    save();
    xrayData = null; // force the X-ray to re-aggregate for the new area
    mapArmedForXray = false;
  }
  cancelAreaDraw();
}
function clearArea() {
  state.xrayRegion = null; save(); xrayData = null;
  renderAreaControls(); scheduleMapDraw();
}
// A click while drawing: close if it lands on the first vertex (>=3 pts), else add a point.
function addAreaPoint(sx, sy) {
  if (mapDrawPts.length >= 3) {
    const p0 = mapDrawPts[0];
    const dx = (worldToImgX(p0.x) * mapV.s + mapV.ox) - sx;
    const dy = (worldToImgY(p0.y) * mapV.s + mapV.oy) - sy;
    if (dx * dx + dy * dy <= 100) { finishAreaDraw(); return; } // within ~10px of the start
  }
  mapDrawPts.push(screenToWorld(sx, sy));
  renderAreaControls(); scheduleMapDraw();
}
// Update the map's "Factory area" panel: which plan it edits, point count, button state.
function renderAreaControls() {
  const lab = $('areaPlanName'); if (lab) lab.textContent = activePlan() ? activePlan().name : '—';
  const st = $('areaStatus');
  const has = state.xrayRegion && state.xrayRegion.length >= 3;
  if (st) {
    st.classList.toggle('warn-text', mapArmedForXray && !has && !mapDrawing);
    st.textContent = mapDrawing
      ? `Tracing… ${mapDrawPts.length} point${mapDrawPts.length === 1 ? '' : 's'}. Click the first dot, double-click, or press Enter to close · Esc to cancel.`
      : has
        ? `Area set (${state.xrayRegion.length} points). The X-ray analyzes machines inside it.`
        : mapArmedForXray
          ? 'This plan has no area yet — click “Draw area” and trace around its machines, then reopen Base X-ray.'
          : 'No area drawn. Draw one to scope this plan’s Base X-ray to its machines.';
  }
  const draw = $('areaDraw'), clr = $('areaClear');
  if (draw) { draw.textContent = mapDrawing ? '■ Stop' : (has ? '✏ Redraw area' : '✏ Draw area'); draw.classList.toggle('active', mapDrawing); }
  if (clr) clr.disabled = !has && !mapDrawing;
}

// ---------- Base X-ray (per-plan production analysis) ----------
// Parse a save ONCE into flat per-actor records (cached as xrayRaw), then aggregate them
// for the active plan's scope. Re-scoping to another plan's area never re-parses — it
// just re-runs the cheap aggregate. Mirrors loadMapFrom: defers the (~1s) parse so the
// "Analyzing…" line paints first.
function loadXrayFrom(file, silent) {
  const st = $('xrayStatus');
  if (!file) { if (st && !silent) st.textContent = 'No save selected.'; return; }
  if (st && !silent) { st.classList.remove('warn-text'); st.textContent = 'Analyzing save…'; }
  state.saveFile = file; save(); // remember across sessions (shared with the other save pickers)
  setTimeout(() => {
    let res;
    try { res = SAVE.readProductionRecords(file); }
    catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
    if (!res.ok) { if (st) { st.textContent = '⚠ ' + res.error; st.classList.add('warn-text'); } xrayRaw = null; xrayData = null; renderXray(); return; }
    xrayRaw = res.records;
    xrayRawFile = file;
    xrayRaw._saveName = res.saveName;
    xrayRaw._savedAt = res.savedAt;
    xrayData = null; // re-aggregate for the current scope
    renderXray();
  }, 20);
}
function loadXrayFromSave() {
  const sel = $('xraySaveSelect');
  loadXrayFrom(sel && sel.value, false);
}
// The region the X-ray should use for the active plan: null = whole base (toggle on, or
// no area drawn). Only a >=3-point polygon scopes the analysis.
function activeXrayRegion() {
  if (state.xrayWholeBase) return null;
  const r = state.xrayRegion;
  return r && r.length >= 3 ? r : null;
}
// (Re)aggregate the cached records for the active plan's scope. Cheap — safe to call on
// every plan switch / region edit / filter change.
function aggregateXray() {
  if (!xrayRaw) { xrayData = null; return; }
  xrayData = PX.aggregate(xrayRaw, DATA, { powerMult: state.powerMult || 1, region: activeXrayRegion() });
  xrayData._saveName = xrayRaw._saveName;
  xrayData._savedAt = xrayRaw._savedAt;
}

// Round a /min rate to a cell, colour-coded by surplus / deficit / balanced.
const XR_EPS = 0.05;
function xrNetCell(net) {
  const td = el('td', 'num');
  td.textContent = (net > 0 ? '+' : '') + fmt(net, 1);
  td.classList.add(net > XR_EPS ? 'xr-pos' : net < -XR_EPS ? 'xr-neg' : 'xr-zero');
  return td;
}
function xrStatusLabel(it) {
  if (it.net > XR_EPS) return { txt: it.raw ? 'surplus (mined)' : 'surplus', cls: 'xr-pos' };
  if (it.net < -XR_EPS) return { txt: it.raw ? 'deficit — mine more' : 'deficit — under-fed', cls: 'xr-neg' };
  return { txt: 'balanced', cls: 'xr-zero' };
}

// Filter + sort the item list per the left-panel controls.
function xrayFilteredItems() {
  const q = xrayFilter.trim().toLowerCase();
  let rows = xrayData.items.slice();
  if (q) rows = rows.filter((it) => it.name.toLowerCase().includes(q));
  if (xrayRawOnly) rows = rows.filter((it) => it.raw);
  if (xrayHideBalanced) rows = rows.filter((it) => Math.abs(it.net) > XR_EPS);
  const cmp = {
    netDesc: (a, b) => b.net - a.net,
    netAsc: (a, b) => a.net - b.net,
    absNet: (a, b) => Math.abs(b.net) - Math.abs(a.net),
    name: (a, b) => a.name.localeCompare(b.name),
    produced: (a, b) => b.produced - a.produced,
  }[xraySort] || ((a, b) => b.net - a.net);
  rows.sort(cmp);
  return rows;
}

function renderXrayItems() {
  const tb = $('xrayItemsTable') && $('xrayItemsTable').querySelector('tbody');
  if (!tb) return;
  tb.innerHTML = '';
  const rows = xrayFilteredItems();
  for (const it of rows) {
    const tr = el('tr');
    const itemTd = el('td');
    itemTd.appendChild(itemCell(it.item));
    if (it.raw) { const b = el('span', 'xr-tag', 'raw'); itemTd.appendChild(b); }
    tr.appendChild(itemTd);
    const prod = el('td', 'num', fmt(it.produced, 1));
    const cons = el('td', 'num', fmt(it.consumed, 1));
    tr.appendChild(prod); tr.appendChild(cons);
    tr.appendChild(xrNetCell(it.net));
    const sl = xrStatusLabel(it);
    const stTd = el('td', null, sl.txt); stTd.classList.add(sl.cls);
    tr.appendChild(stTd);
    tb.appendChild(tr);
  }
  const note = $('xrayItemsNote');
  if (note) note.textContent = `${rows.length} of ${xrayData.items.length} items shown.`;
}

function renderXray() {
  const body = $('xrayBody'), empty = $('xrayEmpty');
  if (!body) return;
  if (!xrayData && xrayRaw) aggregateXray(); // (re)aggregate the cached parse for the active scope
  if (!xrayData) {
    if (empty) {
      // Restore the default no-data prompt (setMode's no-area branch swaps in its own).
      empty.innerHTML = '<p>Pick your save in the left panel and <b>Analyze base</b> to X-ray your factory.</p>';
      empty.hidden = false;
    }
    body.hidden = true;
    return;
  }
  if (empty) empty.hidden = true;
  body.hidden = false;
  const s = xrayData.stats;
  const draw = s.totalPower + s.extractionPower;

  // ----- scope line (which plan / area this analysis covers) -----
  const scoped = xrayData.scope && xrayData.scope.regionUsed;
  const st = $('xrayStatus');
  if (st) {
    st.classList.remove('warn-text');
    const age = relAge(xrayData._savedAt);
    const where = state.xrayWholeBase ? 'whole base' : (scoped ? `“${activePlan() ? activePlan().name : 'this plan'}” area` : 'whole base');
    st.textContent = `${xrayData._saveName || 'save'}: ${where} · ${fmt(s.totalMachines, 0)} machines · ${fmtPower(draw)} draw` + (age ? ` · saved ${age}` : '');
  }
  const scopeEl = $('xrayScope');
  if (scopeEl) {
    scopeEl.textContent = state.xrayWholeBase
      ? 'Scope: whole base (area ignored)'
      : scoped ? `Scope: “${activePlan() ? activePlan().name : 'this plan'}” outlined area` : 'Scope: whole base (no area drawn)';
  }

  // ----- hero -----
  const net = $('xrNetPower');
  if (net) { net.textContent = (s.netPower >= 0 ? '+' : '') + fmtPower(s.netPower); net.classList.toggle('xr-pos', s.netPower >= 0); net.classList.toggle('xr-neg', s.netPower < 0); }
  if ($('xrDraw')) $('xrDraw').textContent = fmtPower(draw);
  if ($('xrGen')) $('xrGen').textContent = fmtPower(s.generationCapacity);
  if ($('xrMachines')) $('xrMachines').textContent = `${fmt(s.configured, 0)} / ${fmt(s.totalMachines, 0)}`;
  if ($('xrIdle')) $('xrIdle').textContent = fmt(s.idle, 0);

  // ----- quick-stat chips -----
  const chips = $('xrayChips');
  if (chips) {
    chips.innerHTML = '';
    const add = (label, val, cls) => { const c = el('span', 'xr-chip' + (cls ? ' ' + cls : '')); c.appendChild(el('b', null, fmt(val, 0))); c.appendChild(document.createTextNode(' ' + label)); chips.appendChild(c); };
    add('idle', s.idle, s.idle ? 'xr-chip-warn' : '');
    add('underclocked', s.underclocked, '');
    add('overclocked', s.overclocked, '');
    add('somersloop', s.somersloop, s.somersloop ? 'xr-chip-good' : '');
    if (s.sloopsInstalled) add('sloops installed', s.sloopsInstalled, 'xr-chip-good');
    add('factories', s.factoryCount, '');
  }

  // ----- caveat banner -----
  const cav = $('xrayCaveat');
  if (cav) {
    const parts = ['Reflects each machine’s saved recipe + overclock + Somersloop at 100% feed — a static save can’t show live belt/manifold starvation.'];
    if (xrayData.caveats.estimatedExtraction) parts.push('Some extractor rates assume Normal purity (your save doesn’t store purity for vanilla nodes).');
    if (xrayData.caveats.generatorFuel) parts.push('Generator fuel burn is shown as capacity, not netted into the item balance above.');
    cav.textContent = 'ℹ ' + parts.join(' ');
  }

  renderXrayItems();

  // ----- machines by type -----
  const bt = $('xrayBldTable') && $('xrayBldTable').querySelector('tbody');
  if (bt) {
    bt.innerHTML = '';
    for (const b of xrayData.buildings) {
      const tr = el('tr');
      tr.appendChild(el('td', null, b.name));
      tr.appendChild(el('td', 'num', fmt(b.count, 0)));
      const idleTd = el('td', 'num', b.idle ? fmt(b.idle, 0) : '—');
      if (b.idle) idleTd.classList.add('xr-neg');
      tr.appendChild(idleTd);
      tr.appendChild(el('td', 'num', fmtPower(b.power)));
      bt.appendChild(tr);
    }
  }

  // ----- by factory -----
  const ft = $('xrayFacTable') && $('xrayFacTable').querySelector('tbody');
  if (ft) {
    ft.innerHTML = '';
    for (const f of xrayData.factories) {
      const tr = el('tr');
      const lab = `#${f.id} · @X ${Math.round(f.cx / 100)} Y ${Math.round(f.cy / 100)}`;
      tr.appendChild(el('td', null, lab));
      tr.appendChild(el('td', 'num', fmt(f.count, 0)));
      tr.appendChild(el('td', 'num', fmtPower(f.power)));
      const tops = f.topOutputs.map((o) => `${itemName(o.item)} ${fmt(o.rate, 0)}`).join(', ');
      tr.appendChild(el('td', null, tops || '—'));
      ft.appendChild(tr);
    }
    if (!xrayData.factories.length) { const tr = el('tr'); const td = el('td', 'hint'); td.colSpan = 4; td.textContent = 'No configured machines.'; tr.appendChild(td); ft.appendChild(tr); }
  }

  // ----- extraction -----
  const et = $('xrayExtTable') && $('xrayExtTable').querySelector('tbody');
  if (et) {
    et.innerHTML = '';
    for (const e of xrayData.extraction) {
      const tr = el('tr');
      const nameTd = el('td');
      nameTd.appendChild(itemCell(e.item));
      if (e.estimated) { const t = el('span', 'xr-tag', 'est'); t.title = 'Purity assumed Normal — your save doesn’t store it for this node'; nameTd.appendChild(t); }
      tr.appendChild(nameTd);
      tr.appendChild(el('td', 'num', fmt(e.rate, 1)));
      tr.appendChild(el('td', 'num', fmt(e.count, 0)));
      et.appendChild(tr);
    }
    if (!xrayData.extraction.length) { const tr = el('tr'); const td = el('td', 'hint'); td.colSpan = 3; td.textContent = 'No miners or pumps found.'; tr.appendChild(td); et.appendChild(tr); }
  }

  // ----- generation -----
  const gt = $('xrayGenTable') && $('xrayGenTable').querySelector('tbody');
  if (gt) {
    gt.innerHTML = '';
    for (const g of xrayData.generation) {
      const tr = el('tr');
      tr.appendChild(el('td', null, g.name));
      tr.appendChild(el('td', 'num', fmt(g.count, 0)));
      tr.appendChild(el('td', 'num', fmtPower(g.power)));
      gt.appendChild(tr);
    }
    if (!xrayData.generation.length) { const tr = el('tr'); const td = el('td', 'hint'); td.colSpan = 3; td.textContent = 'No power generators found.'; tr.appendChild(td); gt.appendChild(tr); }
  }
}

function mapTipHtml(n) {
  const title = n.name || KIND_LABEL[n.kind] || 'Resource node';
  const sub = [];
  if (n.kind !== 'node' && KIND_LABEL[n.kind]) sub.push(KIND_LABEL[n.kind]);
  if (n.purity) sub.push(n.purity);
  const co = `X ${Math.round(n.x / 100)} · Y ${Math.round(n.y / 100)}`;
  return `<b>${esc(title)}</b>` + (sub.length ? `<br><span class="map-tip-sub">${esc(sub.join(' · '))}</span>` : '') + `<br><span class="map-tip-co">${esc(co)}</span>`;
}
function collectableTipHtml(c) {
  const co = `X ${Math.round(c.x / 100)} · Y ${Math.round(c.y / 100)}`;
  return `<b>${esc(COLL_LABEL[c.kind] || 'Collectable')}</b><br><span class="map-tip-sub">Uncollected</span><br><span class="map-tip-co">${esc(co)}</span>`;
}
// Nearest machine whose footprint is under the cursor (screen-space). Paths
// (belts/pipes/wires) aren't hit-tested — only the machines carry useful detail.
function pickMachineAt(sx, sy) {
  const s = mapV.s;
  let best = null, bestD = Infinity;
  for (const b of mapBuildings) {
    if (b.kind !== 'machine' || !catVisible(b._cat)) continue;
    const px = b._ix * s + mapV.ox, py = b._iy * s + mapV.oy;
    const dx = px - sx, dy = py - sy;
    const reach = Math.max(6, Math.max(b._w, b._d) * IMG_PX_PER_CM * s * 0.6);
    const d = dx * dx + dy * dy;
    if (d <= reach * reach && d < bestD) { bestD = d; best = b; }
  }
  return best;
}
function buildingTipHtml(b) {
  const sub = [CAT_LABEL[b._cat] || b._cat];
  if (Math.abs((b.overclock || 1) - 1) > 1e-3) sub.push('OC ' + Math.round(b.overclock * 100) + '%');
  if ((b.boost || 0) > 0) sub.push('Somerslooped');
  const slot = b.swatch && b.swatch.match(/Slot(\d+)/);
  if (slot) sub.push('Paint ' + slot[1]); else if (b.swatch) sub.push('Painted');
  const co = `X ${Math.round(b.x / 100)} · Y ${Math.round(b.y / 100)}`;
  return `<b>${esc(buildingDisplayName(b.className))}</b><br><span class="map-tip-sub">${esc(sub.join(' · '))}</span><br><span class="map-tip-co">${esc(co)}</span>`;
}
function mapHover(e) {
  const cv = $('mapCanvas'), tip = $('mapTip'); if (!cv || !tip) return;
  const r = cv.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  let best = null, bestD = 11 * 11; // markers are constant screen-size, so hit-test in screen px
  for (const n of mapNodes) {
    if (!nodeVisible(n)) continue;
    const px = worldToImgX(n.x) * mapV.s + mapV.ox, py = worldToImgY(n.y) * mapV.s + mapV.oy;
    const d = (px - sx) * (px - sx) + (py - sy) * (py - sy);
    if (d < bestD) { bestD = d; best = n; }
  }
  let bestC = null, bestCD = 11 * 11;
  for (const c of mapCollectables) {
    if (!collVisible(c)) continue;
    const px = worldToImgX(c.x) * mapV.s + mapV.ox, py = worldToImgY(c.y) * mapV.s + mapV.oy;
    const d = (px - sx) * (px - sx) + (py - sy) * (py - sy);
    if (d < bestCD) { bestCD = d; bestC = c; }
  }
  // Closest marker wins (node vs collectable); fall back to a machine footprint
  // under the cursor when neither marker is near.
  let html = (bestC && (!best || bestCD < bestD)) ? collectableTipHtml(bestC) : (best ? mapTipHtml(best) : null);
  if (!html && mapBuildShow && mapBuildings.length) {
    const mb = pickMachineAt(sx, sy);
    if (mb) html = buildingTipHtml(mb);
  }
  if (!html) { tip.hidden = true; return; }
  tip.innerHTML = html;
  tip.hidden = false;
  const wrapR = $('mapWrap').getBoundingClientRect();
  tip.style.left = (e.clientX - wrapR.left + 14) + 'px';
  tip.style.top = (e.clientY - wrapR.top + 14) + 'px';
}
function zoomMapAt(sx, sy, f) {
  const ns = Math.max(mapFitS * 0.5, Math.min(mapFitS * 60, mapV.s * f));
  const k = ns / mapV.s;
  mapV.ox = sx - (sx - mapV.ox) * k; mapV.oy = sy - (sy - mapV.oy) * k; mapV.s = ns;
  $('mapTip').hidden = true; scheduleMapDraw();
}
function wireMap() {
  const cv = $('mapCanvas'); if (!cv) return;
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    zoomMapAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });
  cv.addEventListener('pointerdown', (e) => {
    const r = cv.getBoundingClientRect();
    if (mapDrawing) { addAreaPoint(e.clientX - r.left, e.clientY - r.top); return; } // place a vertex, don't pan
    mapDrag = { x: e.clientX, y: e.clientY, ox: mapV.ox, oy: mapV.oy };
    try { cv.setPointerCapture(e.pointerId); } catch (_) {}
  });
  cv.addEventListener('pointermove', (e) => {
    if (mapDrawing) { const r = cv.getBoundingClientRect(); mapDrawHover = screenToWorld(e.clientX - r.left, e.clientY - r.top); scheduleMapDraw(); return; }
    if (mapDrag) { mapV.ox = mapDrag.ox + (e.clientX - mapDrag.x); mapV.oy = mapDrag.oy + (e.clientY - mapDrag.y); $('mapTip').hidden = true; scheduleMapDraw(); }
    else mapHover(e);
  });
  cv.addEventListener('dblclick', (e) => { if (mapDrawing) { e.preventDefault(); finishAreaDraw(); } });
  const up = (e) => { if (mapDrag) { try { cv.releasePointerCapture(e.pointerId); } catch (_) {} mapDrag = null; } };
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('pointerleave', () => { $('mapTip').hidden = true; });
  // Enter closes the trace, Esc cancels it (only while drawing).
  document.addEventListener('keydown', (e) => {
    if (!mapDrawing) return;
    if (e.key === 'Enter') { e.preventDefault(); finishAreaDraw(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelAreaDraw(); }
  });
  window.addEventListener('resize', () => {
    if (state.mode === 'map') { reframeMapForResize(); scheduleMapDraw(); }
    if (state.view === 'flow' && $('flowView') && !$('flowView').hidden) applyFlowTransform();
  });
}
function renderMap() {
  ensureMapImg();
  if (!$('mapWrap')) return;
  const any = mapNodes.length || mapCollectables.length || mapBuildings.length;
  $('mapEmpty').hidden = any > 0;
  if (any && !mapV.ready) fitMapView();
  drawMap();
}

// ---------- export (CSV tables, PNG flow + map) ----------
const safeName = (s) => (s || 'plan').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'plan';
function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = el('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const csvCell = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const csvRow = (arr) => arr.map(csvCell).join(',');
// Production tables -> CSV (steps, raw inputs, buildings, summary). Mirrors the
// on-screen tables so a plan can drop straight into a spreadsheet.
function buildCsv(res) {
  const L = [];
  L.push('Production steps');
  L.push(csvRow(['Item', 'Recipe', 'Rate/min', 'Machines', 'Clock %', 'Sloops/machine', 'Building', 'Power MW']));
  res.recipes.slice().sort((a, b) => itemName(a.item).localeCompare(itemName(b.item))).forEach((s) => {
    const r = RECIPES[s.rc];
    L.push(csvRow([itemName(s.item), r ? r.name : s.rc, fmt(s.rate), Math.ceil(s.machines - 1e-9), Math.round((s.clock || state.clock) * 100), s.sloops || 0, s.buildingName, fmt(s.power, 1)]));
  });
  L.push('');
  L.push('Raw resources');
  L.push(csvRow(['Resource', 'Rate/min']));
  (res.raw || []).slice().sort((a, b) => itemName(a.item).localeCompare(itemName(b.item))).forEach((r) => L.push(csvRow([itemName(r.item), fmt(r.rate)])));
  const disp = [];
  (res.sunk || []).forEach((s) => disp.push([itemName(s.item), fmt(s.rate), `Awesome Sink (${fmt(s.points, 0)} pts/min)`]));
  (res.burned || []).forEach((b) => disp.push([itemName(b.item), fmt(b.rate), `${b.genName} (${fmt(b.mw, 0)} MW)`]));
  (res.watered || []).forEach((w) => disp.push([itemName(w.item), fmt(w.rate), `Wet Concrete (${fmt(w.machines)}x -> ${fmt(w.concrete)} Concrete/min)`]));
  (res.surplus || []).forEach((s) => disp.push([itemName(s.item), fmt(s.rate), 'surplus (unconsumed)']));
  if (disp.length) {
    L.push('');
    L.push((res.sunk && res.sunk.length) || (res.burned && res.burned.length) || (res.watered && res.watered.length) ? 'By-product disposal' : 'By-products / surplus');
    L.push(csvRow(['Item', 'Rate/min', 'Destination']));
    disp.sort((a, b) => a[0].localeCompare(b[0])).forEach((r) => L.push(csvRow(r)));
  }
  L.push('');
  if ((res.burned || []).length) L.push(csvRow(['Power recovered from generators MW', fmt(res.recoveredPower, 1)]));
  L.push(csvRow(['Total power MW', fmt(res.totalPower, 1)]));
  L.push(csvRow(['Production machines', res.totalMachines]));
  L.push(csvRow(['Somersloops used', res.totalSloops || 0]));
  return L.join('\r\n');
}
function exportCsv() {
  if (!lastResult || !lastResult.recipes || !lastResult.recipes.length) return;
  downloadBlob(safeName(activePlan() && activePlan().name) + '.csv', new Blob([buildCsv(lastResult)], { type: 'text/csv;charset=utf-8' }));
}
// The live <svg> is styled by stylesheet rules and carries the zoom/pan transform;
// neither survives serialization, so the export embeds its own <style> + opaque
// background and resets the transform to render the whole graph at 1:1. Colours are
// pulled from the live theme CSS vars (cssVar) so a re-themed app exports a matching
// PNG; the few node-body shades that aren't first-class vars stay as literals.
function flowExportCss() {
  const text = cssVar('--text') || '#e7eaf0';
  const muted = cssVar('--muted') || '#9aa3b2';
  const accent = cssVar('--accent') || '#f9a825';
  const good = cssVar('--good') || '#66bb6a';
  return (
    '.edge-path{fill:none;stroke:#4b566c;stroke-width:1.5}.flow-arrow{fill:#4b566c}' +
    `.edge-label{fill:${muted};font:11px "Segoe UI",system-ui,sans-serif;paint-order:stroke;stroke:#11141a;stroke-width:4px}` +
    '.node rect{stroke-width:1.5}' +
    `.node.raw rect{fill:#2b313c;stroke:#5b6675}.node.machine rect{fill:#3a2a12;stroke:${accent}}.node.out rect{fill:#15361f;stroke:${good}}` +
    '.node.sink rect{fill:#3a1530;stroke:#c061a4}.node.gen rect{fill:#1c2f3a;stroke:#4aa3c7}.node.depot rect{fill:#2c2740;stroke:#8a7bd8}' +
    `.node .n-title{fill:${text};font:700 12px "Segoe UI",system-ui,sans-serif}.node .n-sub{fill:${muted};font:10px "Segoe UI",system-ui,sans-serif}`
  );
}
function exportFlowPng() {
  if (!currentFlow) return;
  const w = Math.max(1, Math.ceil(currentFlow.width)), h = Math.max(1, Math.ceil(currentFlow.height));
  const clone = $('flowSvg').cloneNode(true);
  const root = clone.querySelector('#flowRoot'); if (root) root.removeAttribute('transform'); // full graph, 1:1
  clone.setAttribute('width', w); clone.setAttribute('height', h); clone.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const style = document.createElementNS(SVGNS, 'style'); style.textContent = flowExportCss();
  const bg = document.createElementNS(SVGNS, 'rect'); bg.setAttribute('width', w); bg.setAttribute('height', h); bg.setAttribute('fill', cssVar('--bg') || '#11141a');
  clone.insertBefore(bg, clone.firstChild); clone.insertBefore(style, clone.firstChild);
  const svgText = new XMLSerializer().serializeToString(clone);
  const img = new Image();
  img.onload = () => {
    const cv = el('canvas'); cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(img, 0, 0);
    cv.toBlob((blob) => { if (blob) downloadBlob(safeName(activePlan() && activePlan().name) + '-flow.png', blob); });
  };
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
}
function exportMapPng() {
  const cv = $('mapCanvas'); if (!cv || !cv.width) return;
  cv.toBlob((blob) => { if (blob) downloadBlob((mapNodes.length || mapBuildings.length ? safeName(state.saveName) + '-' : '') + 'map.png', blob); });
}

// ---------- pure per-mode compute (no DOM) ----------
// These take an explicit `state` so a non-active plan can be solved headlessly (for
// linked-input propagation), and are also the compute half of the render functions.
// A linked input/supply row (fromPlanId set) draws its cap/amount from the source
// plan's recorded net output instead of the manual value — back-compat: rows without
// fromPlanId use their manual cap/amount exactly as before.
function optAllowedInputs(st) {
  const allowed = {};
  for (const r of resList) { const cfg = st.opt.inputs[r.c]; if (cfg && cfg.on) allowed[r.c] = cfg.cap === '' || cfg.cap == null ? Infinity : Number(cfg.cap); }
  for (const x of st.opt.extraInputs || []) {
    const c = anyNameToClass(x.name) || (x.fromItem && ITEMS[x.fromItem] ? x.fromItem : '');
    if (!c) continue;
    const linked = resolveLinkedCap(x);
    allowed[c] = linked != null ? linked : (x.cap === '' || x.cap == null ? Infinity : Number(x.cap));
  }
  return allowed;
}
function maxSupplyMap(st) {
  const supply = {};
  for (const s of st.max.supply) {
    if (!s.item) continue;
    const linked = resolveLinkedCap(s);
    const amt = linked != null ? linked : Number(s.amount);
    if (amt > 0) supply[s.item] = (supply[s.item] || 0) + amt;
  }
  return supply;
}
function plannerTargetsFor(st) {
  const t = {};
  const add = (c, rate) => { if (c && rate > 0) t[c] = (t[c] || 0) + Number(rate) * (isDeliverable(c) ? st.spaceMult : 1); };
  add(st.targetItem, st.targetRate);
  for (const o of st.extraTargets || []) add(nameToClass(o.name), o.rate);
  return t;
}
// Compute (not render) a state's result for its current mode. Returns
// { feasible, res, targets } or { feasible:false }. `res` carries .surplus set.
function computeStateResult(st) {
  const saved = state;
  state = st; // computePlanner/effectiveAltSet read module `state`; swap then restore
  try {
    // Solve the plan's PRODUCTION mode. The tab (`st.mode`) may be parked on a
    // non-production view (project / map / xray / power) — falling through to the
    // literal tab used to silently re-interpret an Optimizer plan as a Planner one.
    const m = POWER_SOURCES.includes(st.mode) ? st.mode
      : st.prodMode || (st.power && st.power.sourceMode) || st.mode;
    // The Power Planner isn't a material-flow plan (it sizes generation, not recipes),
    // so it contributes no raw/machines/power to the project rollup — report no output.
    if (m === 'power') return { feasible: false };
    if (m === 'optimize') {
      const outputs = {};
      for (const o of st.opt.outputs) { const c = nameToClass(o.name); if (c && o.rate > 0) outputs[c] = (outputs[c] || 0) + Number(o.rate) * (isDeliverable(c) ? st.spaceMult : 1); }
      const allowedInputs = optAllowedInputs(st);
      if (!Object.keys(outputs).length || !Object.keys(allowedInputs).length) return { feasible: false };
      const res = LP.optimize({ outputs, allowedInputs, objective: st.opt.objective, allowAlternates: st.opt.alts, recipeCost: st.recipeCost, powerMult: st.powerMult, unlockedAlts: effectiveAltSet(), blockedRecipes: blockedRecipeSet(), sinkByproducts: st.opt.sink !== false, waterSink: !!st.opt.waterSink, sloopMult: sloopMapAll() });
      if (!res.feasible) return { feasible: false };
      res.surplus = res.outputs.filter((o) => !outputs[o.item]);
      tuneSteps(res); // apply per-step overclock / somersloop (machines & power)
      applyCleanScale(res, outputs);
      return { feasible: true, res, targets: outputs };
    }
    if (m === 'max') {
      const product = st.max.product;
      const supply = maxSupplyMap(st);
      if (!product || !Object.keys(supply).length) return { feasible: false };
      const res = LP.maxThroughput({ product, supply, allowAlternates: st.max.alts, recipeCost: st.recipeCost, powerMult: st.powerMult, unlockedAlts: effectiveAltSet(), blockedRecipes: blockedRecipeSet() });
      if (!res.feasible) return { feasible: false };
      res.surplus = res.outputs.filter((o) => o.item !== product);
      return { feasible: true, res, targets: { [product]: res.maxOutput } };
    }
    // planner
    const targets = plannerTargetsFor(st);
    if (!Object.keys(targets).length) return { feasible: false };
    const res = computePlanner(targets);
    if (!res.feasible) return { feasible: false };
    applyCleanScale(res);
    return { feasible: true, res, targets: res.targets };
  } finally {
    state = saved;
  }
}
// Headlessly re-solve a non-active plan and refresh its recorded net outputs so links
// off it stay current. Never touches the DOM or the on-screen active plan.
function recomputePlanOutputs(planObj) {
  if (!planObj) return;
  const out = computeStateResult(planObj.state);
  if (out.feasible) recordNetOutputs(planObj, out.targets, out.res);
  else planObj.state.netOutputs = {}; // infeasible plan offers nothing downstream
}

// ---------- mode dispatch ----------
function present(res, targets) {
  lastResult = res; lastTargets = targets;
  // Record this plan's outputs so downstream plans can link to them, then push fresh
  // numbers to any plan that consumes this one (one-hop reactive propagation).
  const ap = activePlan();
  if (ap) { recordNetOutputs(ap, targets, res); propagateLinks(ap.id); }
  showOutput(); // -> applyView(), which renders the flowchart when that view is active
  renderTables(res);
  updateCleanRatioNote(res);
}
// Explain what the Clean ratios toggle did this solve: how much the output was scaled to
// land on whole machines, or that it was already clean / doesn't apply in this mode.
function updateCleanRatioNote(res) {
  const n = $('cleanRatioNote');
  if (!n) return;
  if (!state.cleanRatio) { n.hidden = true; n.textContent = ''; return; }
  if (res && res._cleanScale != null) {
    const sc = res._cleanScale;
    n.hidden = false;
    n.textContent = Math.abs(sc - 1) > 1e-9
      ? `Inputs & outputs scaled ×${fmt(sc, 3)} so every step is a whole number of machines.`
      : 'Already whole-machine ratios — no scaling needed.';
  } else {
    n.hidden = false;
    n.textContent = 'Clean ratios apply in the Planner and Recipe Optimizer.';
  }
}
function solveAndRender() {
  $('modeExtras').innerHTML = '';
  $('maxBanner').hidden = true;
  if (state.mode === 'planner') return renderPlanner();
  if (state.mode === 'optimize') return renderOptimize();
  if (state.mode === 'max') return renderMax();
  if (state.mode === 'power') return renderPower();
}
function showEmpty(msg) {
  lastResult = null;
  $('empty').hidden = false;
  $('output').hidden = true;
  $('emptyMsg').textContent = msg;
  $('sumPower').textContent = '—'; $('sumMachines').textContent = '—'; $('sumRaw').textContent = '—';
  if ($('cleanRatioNote')) $('cleanRatioNote').hidden = true;
  // An empty/infeasible plan produces nothing downstream — clear its recorded outputs
  // and let consumers re-resolve (their linked caps drop to 0).
  const ap = activePlan();
  if (ap && ap.state.netOutputs && Object.keys(ap.state.netOutputs).length) { ap.state.netOutputs = {}; propagateLinks(ap.id); }
}
// Human message for the F1/F4 sole-producer guard. `verb` is 'build' (a target can't be
// made) or 'import' (an intermediate quietly fell back to a free input).
function blockedWarn(items, verb) {
  const names = items.map(itemName).join(', ');
  return verb === 'build'
    ? `Can’t make ${names}: every recipe for it is disabled (recipe veto or a turned-off building). Re-enable a recipe/building for it, or enable an alternate that produces it.`
    : `Heads up: ${names} has no enabled recipe (all blocked), so it’s being treated as a supplied input rather than built. Re-enable a recipe/building if you meant to produce it.`;
}
// A non-blocking warning card for the results area (re-uses the extras-card styling with a
// warn modifier). Used to surface blocked-orphan intermediates without hiding the plan.
function warnCard(msg) {
  const c = el('div', 'extras-card warn-card');
  c.appendChild(el('div', 'extras-title', '⚠ Disabled recipe / building'));
  c.appendChild(el('div', 'extras-line', msg));
  return c;
}
function showOutput() { $('empty').hidden = true; $('output').hidden = false; applyView(); }

function renderPlanner() {
  $('sumExtraLabel').textContent = 'Raw resource types';
  const targets = plannerTargets();
  if (!Object.keys(targets).length) {
    const hasItem = !!state.targetItem || (state.extraTargets || []).some((o) => nameToClass(o.name));
    return showEmpty(hasItem ? 'Set a rate above 0 for a desired output.' : 'Pick a target item to build a production flow.');
  }
  // Sole-producer guard: a target whose every recipe is blocked (recipe veto or disabled
  // building) can't be built at all — say so plainly instead of silently listing it raw.
  const deadTargets = blockedOrphans(Object.keys(targets));
  if (deadTargets.length) return showEmpty(blockedWarn(deadTargets, 'build'));
  const res = computePlanner(targets);
  if (!res.feasible) return showEmpty('No feasible plan: the selected recipes can’t balance — a recycle loop that consumes more than it makes. Switch one alternate to break it.');
  applyCleanScale(res); // scale to whole-machine ratios when the toggle is on (no-op otherwise)
  // Split the desired outputs by destination. Depot / Storage outputs stay full
  // production demand (already summed into res.targets), but are pulled out of the
  // line-output set so they render in their own group + a distinct flow terminal, not
  // as primary line products. A single item split across rows (e.g. some to the line,
  // some to storage) is divided by its per-destination weights so each destination
  // gets its own terminal. lineTargets is what feeds the normal green output nodes.
  const bd = destBreakdown();
  const lineTargets = {};
  res.depot = [];
  for (const item in res.targets) {
    const total = res.targets[item];
    const b = bd[item];
    const sum = b ? b.line + b.depot + b.storage : 0;
    if (!sum) { lineTargets[item] = total; continue; } // no breakdown row -> treat as line
    if (b.line > 1e-9) lineTargets[item] = total * (b.line / sum);
    if (b.depot > 1e-9) res.depot.push({ item, rate: total * (b.depot / sum), dest: 'depot' });
    if (b.storage > 1e-9) res.depot.push({ item, rate: total * (b.storage / sum), dest: 'storage' });
  }
  present(res, lineTargets);
  // Intermediates whose producers were all blocked silently became free "raw" inputs —
  // flag them so a removed building doesn't quietly turn a part into an imported item.
  const orphanRaw = blockedOrphans(res.raw.map((r) => r.item));
  if (orphanRaw.length) $('modeExtras').appendChild(warnCard(blockedWarn(orphanRaw, 'import')));
  $('sumRaw').textContent = fmt(res.raw.length, 0);
}

function renderOptimize() {
  $('sumExtraLabel').textContent = 'Raw resource types';
  const outputs = {};
  let n = 0;
  for (const o of state.opt.outputs) {
    const c = nameToClass(o.name);
    if (c && o.rate > 0) { outputs[c] = (outputs[c] || 0) + Number(o.rate) * (isDeliverable(c) ? state.spaceMult : 1); n++; }
  }
  if (!n) return showEmpty('Add at least one desired output item to optimize.');
  const allowedInputs = optAllowedInputs(state); // honors linked-input caps (Project links)
  if (!Object.keys(allowedInputs).length) return showEmpty('Allow at least one input resource.');

  const sink = state.opt.sink !== false;
  const res = LP.optimize({ outputs, allowedInputs, objective: state.opt.objective, allowAlternates: state.opt.alts, recipeCost: state.recipeCost, powerMult: state.powerMult, unlockedAlts: effectiveAltSet(), blockedRecipes: blockedRecipeSet(), sinkByproducts: sink, waterSink: !!state.opt.waterSink, sloopMult: sloopMapAll() });
  if (!res.feasible) {
    if (res.backup && res.backup.length) {
      const names = res.backup.map(itemName).join(', ');
      const waterTip = res.backup.includes('Desc_Water_C') ? ' For Water specifically, tick “Sink excess water → Wet Concrete”.' : '';
      return showEmpty(`By-product would back up: ${names}. It’s a fluid with no recipe consuming it, so it can’t be sunk and would stall the line. Enable an alternate recipe that consumes it, or untick “Sink / consume by-products”.${waterTip}`);
    }
    if (res.noProducer && res.noProducer.length) {
      const names = res.noProducer.map(itemName).join(', ');
      return showEmpty(`No enabled recipe produces: ${names}. Every producer is disabled (recipe or building veto) or not unlocked — re-enable one in Settings, or supply it as an input.`);
    }
    const dead = blockedOrphans(Object.keys(outputs));
    if (dead.length) return showEmpty(blockedWarn(dead, 'build'));
    return showEmpty('No feasible recipe set: those outputs cannot be made from the allowed inputs. Enable more resources or alternate recipes.');
  }
  res.surplus = res.outputs.filter((o) => !outputs[o.item]);
  tuneSteps(res); // per-step overclock / somersloop now editable in the Optimizer too
  applyCleanScale(res, outputs); // whole-machine ratios when the toggle is on (no-op otherwise)
  present(res, outputs);
  $('sumRaw').textContent = fmt(res.raw.length, 0);

  const labels = { raw: 'raw resources /min', power: 'MW', machines: 'machines' };
  const ex = el('div', 'extras-card');
  ex.appendChild(el('div', 'extras-title', '✓ Optimized recipe selection'));
  const alts = res.recipes.filter((x) => RECIPES[x.rc].alternate).length;
  ex.appendChild(el('div', 'extras-line', `Minimized ${state.opt.objective} = ${fmt(res.objectiveValue)} ${labels[state.opt.objective]} · ${alts} alternate recipe(s) chosen`));
  const sunkPts = (res.sunk || []).reduce((a, s) => a + s.points, 0);
  if ((res.sunk || []).length) ex.appendChild(el('div', 'extras-line', `By-products sunk: ${res.sunk.map((s) => itemName(s.item)).join(', ')} — ${fmt(sunkPts, 0)} AWESOME Sink points/min`));
  if ((res.burned || []).length) ex.appendChild(el('div', 'extras-line', `By-products burned: ${res.burned.map((b) => itemName(b.item)).join(', ')} — ${fmt(res.recoveredPower, 0)} MW recovered from generators`));
  (res.watered || []).forEach((w) => ex.appendChild(el('div', 'extras-line', `Excess water sunk via Wet Concrete: ${fmt(w.rate)} Water/min → ${fmt(w.concrete)} Concrete/min (${fmt(w.machines)} Refinery, ${fmt(w.limestone)} Limestone/min) — no by-product loop`)));
  $('modeExtras').appendChild(ex);
}

function renderMax() {
  $('sumExtraLabel').textContent = 'Inputs at 100%';
  const product = state.max.product;
  if (!product) return showEmpty('Choose a product to maximize.');
  const supply = maxSupplyMap(state); // honors linked-supply amounts (Project links)
  if (!Object.keys(supply).length) return showEmpty('Add at least one available input with an amount.');
  const res = LP.maxThroughput({ product, supply, allowAlternates: state.max.alts, recipeCost: state.recipeCost, powerMult: state.powerMult, unlockedAlts: effectiveAltSet(), blockedRecipes: blockedRecipeSet() });
  if (!res.feasible) {
    if (res.unbounded) return showEmpty(`Output of ${itemName(product)} is unbounded with these inputs — a recipe pair turns matter-positive under the current Recipe Parts Cost Multiplier (its rounding makes a package/unpackage loop create matter). Set the multiplier back to 1× or remove the packaged input.`);
    if (blockedOrphans([product]).length) return showEmpty(blockedWarn([product], 'build'));
    return showEmpty(`Cannot produce ${itemName(product)} from the given inputs.`);
  }
  res.surplus = res.outputs.filter((o) => o.item !== product);
  present(res, { [product]: res.maxOutput });

  const b = $('maxBanner');
  b.hidden = false;
  b.innerHTML = `<span class="banner-num">${fmt(res.maxOutput)}</span> <span class="banner-unit">${isFluid(product) ? 'm³' : ''}/min ${itemName(product)}</span>`;
  $('sumRaw').textContent = res.binding.length ? '✓' : '—';
  const ex = el('div', 'extras-card');
  ex.appendChild(el('div', 'extras-title', `Limiting factor: ${res.binding.length ? res.binding.map(itemName).join(', ') : '—'}`));
  const tbl = el('table', 'util-table');
  tbl.innerHTML = '<thead><tr><th>Input</th><th class="num">Used</th><th class="num">Avail</th><th>Utilization</th></tr></thead>';
  const tbody = el('tbody');
  res.utilization.forEach((u) => {
    const tr = el('tr');
    const td = el('td'); td.appendChild(itemCell(u.item)); tr.appendChild(td);
    tr.appendChild(el('td', 'num', fmt(u.used)));
    tr.appendChild(el('td', 'num', fmt(u.avail)));
    const bar = el('td'); const wrap = el('div', 'bar');
    const fill = el('div', 'bar-fill' + (u.pct >= 0.999 ? ' full' : ''));
    fill.style.width = Math.min(100, u.pct * 100) + '%';
    fill.textContent = Math.round(u.pct * 100) + '%';
    wrap.appendChild(fill); bar.appendChild(wrap); tr.appendChild(bar);
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody); ex.appendChild(tbl);
  $('modeExtras').appendChild(ex);
}

// ---------- power planner ----------
// Whole-factory power LEDGER for the active plan: every production machine's draw, plus
// miners/extractors sized for the plan's raw inputs, minus generators you choose to burn
// an output in. Consumption is scaled by the Power Consumption Multiplier; GENERATION is
// NOT — so the multiplier-impact table shows net power falling as the cost rises. Physics
// come from POWERGEN / EXTRACTORS (the game's own Docs; see transform-docs.js).
// Production is read from the plan's chosen source mode so opening this tab never
// overwrites the Optimizer/Max/Planner setup it reflects.
const POWER_SOURCES = ['optimize', 'max', 'planner'];
// Raw fluids extract from a fixed building (no miner-tier choice); solids use the chosen
// miner tier. Nitrogen comes from a Resource Well satellite (purity applies).
const FLUID_EXTRACTOR = { Desc_Water_C: 'Build_WaterPump_C', Desc_LiquidOil_C: 'Build_OilPump_C', Desc_NitrogenGas_C: 'Build_FrackingExtractor_C' };
// Resource-well satellites draw 0 MW — the well's PRESSURIZER (150 MW nominal) is the
// powered actor, and ITS overclock drives the whole well. Vanilla wells carry at most
// this many satellites, so sizing charges one Pressurizer per 10 satellites (fully-
// saturated wells: a best-case lower bound — real wells are often smaller).
const WELL_MAX_SATELLITES = 10;

const clampClock = (v) => Math.max(1, Math.min(250, Math.round(Number(v) || 100)));
function ensurePower() {
  const p = (state.power && typeof state.power === 'object') ? state.power : {};
  if (!POWER_SOURCES.includes(p.sourceMode)) p.sourceMode = 'optimize';
  if (!EXTRACTORS[p.minerTier]) p.minerTier = 'Build_MinerMk1_C';
  if (!p.purity || typeof p.purity !== 'object') p.purity = {};
  if (!p.extClock || typeof p.extClock !== 'object') p.extClock = {}; // per-raw OC override
  if (!Array.isArray(p.gens)) p.gens = [];
  if (!Array.isArray(p.standalone)) p.standalone = []; // mine-a-raw-fuel-and-burn-it generators, independent of the plan
  p.minerClock = clampClock(p.minerClock);
  p.genClock = clampClock(p.genClock);
  state.power = p;
  return p;
}
// Effective overclock %: a per-node override (set by double-clicking the flowchart node)
// falls back to the global default — mirroring the machine model (state.clock + nodeClock).
const extClockOf = (item, p) => (p.extClock && p.extClock[item] != null ? p.extClock[item] : p.minerClock);
const genClockOf = (g, p) => (g && g.clock != null ? g.clock : p.genClock);
// Solve the active plan's production in the chosen source mode WITHOUT touching the plan's
// own mode (which is 'power' while this tab is open). Shape: { feasible, res, targets }.
function activePlanProduction() {
  const p = ensurePower();
  return computeStateResult(Object.assign({}, state, { mode: p.sourceMode }));
}
// A solved plan's net outputs as [{item, rate}] — optimize/max expose res.outputs; the
// planner exposes targets. Drives the burnable-output picker for generators.
function planOutputs(prod) {
  const res = prod.res || {};
  if (Array.isArray(res.outputs) && res.outputs.length) return res.outputs.map((o) => ({ item: o.item, rate: o.rate }));
  if (prod.targets) return Object.keys(prod.targets).map((it) => ({ item: it, rate: prod.targets[it] }));
  return [];
}
const outputRate = (prod, item) => planOutputs(prod).filter((o) => o.item === item).reduce((a, o) => a + o.rate, 0);
// Generators that accept `item` as fuel.
const gensForFuel = (item) => Object.keys(POWERGEN).filter((g) => POWERGEN[g].fuels && POWERGEN[g].fuels[item] != null);
// Plan outputs that some generator can burn.
const burnableOutputs = (prod) => planOutputs(prod).filter((o) => o.rate > 1e-6 && gensForFuel(o.item).length);
// Raw (minable) resources some generator burns — eligible for standalone "mine → burn" power
// (realistically just Coal for the Coal-Powered Generator; Compacted Coal/Coke are crafted).
const rawFuels = () => { const s = new Set(); for (const gc in POWERGEN) for (const f in (POWERGEN[gc].fuels || {})) if (RESOURCES.has(f)) s.add(f); return [...s]; };

// Extractor sizing to gather `rate`/min of raw `item` at its per-resource purity. Base
// (multiplier = 1) power; the last unit is underclocked to the exact remainder (power ∝
// clock^exponent), as you'd trim a partial node in-game. Returns null for a non-resource
// raw (a supplied intermediate) — nothing to mine.
function extractionFor(item, rate, p) {
  if (rate <= 1e-9) return null;
  let M = null;
  if (FLUID_EXTRACTOR[item]) M = EXTRACTORS[FLUID_EXTRACTOR[item]];
  else if (RESOURCES.has(item) && !isFluid(item)) M = EXTRACTORS[p.minerTier] || EXTRACTORS.Build_MinerMk1_C;
  if (!M) return null;
  const hasPurity = !!M.purity;
  const base = M.ratePerMin * (hasPurity ? (PURITY[p.purity[item] || 'normal'] || 1) : 1); // one unit @100%
  if (base <= 0) return null;
  const c = clampClock(extClockOf(item, p)) / 100;  // per-resource OC (override or global)
  const fullEach = base * c;
  const full = Math.floor(rate / fullEach + 1e-9);
  const rem = rate - full * fullEach;
  const frac = rem > 1e-9 ? rem / base : 0;         // last unit's clock fraction (≤ c), trims the remainder
  const count = full + (frac > 0 ? 1 : 0);
  // Power scales by clock^exponent: full units run at c, the trim unit at frac.
  let powerBase = full * M.power * Math.pow(c, M.exponent) + (frac > 0 ? M.power * Math.pow(frac, M.exponent) : 0);
  // Resource-well rows: add the Pressurizer(s) powering the satellites (see
  // WELL_MAX_SATELLITES). The Pressurizer runs at the row's clock — in-game its
  // overclock is what scales every satellite's output.
  let wells = 0;
  const S = EXTRACTORS.Build_FrackingSmasher_C;
  if (M === EXTRACTORS.Build_FrackingExtractor_C && S && count > 0) {
    wells = Math.ceil(count / WELL_MAX_SATELLITES);
    powerBase += wells * (S.power || 0) * Math.pow(c, S.exponent || 1.321929);
  }
  // Report the dominant clock: the cap c when any full unit runs there, else the trim
  // clock (a single under-target machine that already makes the whole demand).
  return { item, rate, name: M.name, hasPurity, purity: p.purity[item] || 'normal', clock: full > 0 ? c : frac, count, powerBase, wells };
}
// Size generators of type G burning `avail`/min of `fuelItem` at genClock. Overclocking a
// generator scales its fuel burn AND output together, so for a fixed fuel rate the total
// power and water are clock-invariant — only the machine COUNT changes (run fewer, harder).
function genSizing(G, fuelItem, avail, genClockPct) {
  const c = clampClock(genClockPct) / 100;
  const burn = (G.fuels[fuelItem] || 0) * c;
  const nGen = burn > 0 ? avail / burn : 0;
  const mw = nGen * G.power * c;
  let water = null;
  if (G.supplemental && nGen > 1e-9) {
    const W = EXTRACTORS.Build_WaterPump_C;
    const need = nGen * G.supplemental.rate * c;
    const cnt = Math.max(1, Math.ceil(need / W.ratePerMin - 1e-9));
    const ck = need / (cnt * W.ratePerMin);
    water = { need, count: cnt, clock: ck, powerBase: cnt * W.power * Math.pow(ck, W.exponent) };
  }
  return { clock: c, nGen, mw, water };
}

// Net outputs of a SOLVED plan as [{item, rate}] from its result + targets.
function outputsOf(res, targets) {
  if (res && Array.isArray(res.outputs) && res.outputs.length) return res.outputs.map((o) => ({ item: o.item, rate: o.rate }));
  if (targets) return Object.keys(targets).map((it) => ({ item: it, rate: targets[it] }));
  return [];
}
// Shared power-infrastructure sizing for a solved plan — the single seam the Power Planner
// page, the table view, and the flowchart all read, so a change in one shows in all. Returns
// the extractors gathering each raw and the generators burning outputs, each at its
// effective overclock (per-node override or global default). `idx` ties a generator row
// back to state.power.gens for the node popup.
function powerInfraFor(res, targets) {
  const p = ensurePower();
  const outs = outputsOf(res, targets);
  const gens = [];
  // Plan-output generators: burn a net output the plan already produces.
  for (let i = 0; i < p.gens.length; i++) {
    const g = p.gens[i]; const G = POWERGEN[g.gen];
    if (!G || !G.fuels || G.fuels[g.output] == null) continue;
    const avail = outs.filter((o) => o.item === g.output).reduce((a, o) => a + o.rate, 0);
    if (!(avail > 1e-9)) continue;
    const z = genSizing(G, g.output, avail, genClockOf(g, p));
    gens.push({ idx: i, output: g.output, gen: g.gen, name: G.name, avail, nGen: z.nGen, mw: z.mw, clock: z.clock, water: z.water });
  }
  // Raw demand = the plan's raws plus the fuel burned by standalone generators (which mine
  // their own fuel rather than consuming a plan output). Merge per item so a single extractor
  // array covers both — a plan that also mines the burned raw doesn't double-count.
  const rawDemand = {};
  for (const r of (res.raw || [])) rawDemand[r.item] = (rawDemand[r.item] || 0) + r.rate;
  // Standalone generators: mine a raw fuel and burn it directly, independent of the plan.
  for (let i = 0; i < p.standalone.length; i++) {
    const g = p.standalone[i]; const G = POWERGEN[g.gen];
    if (!G || !G.fuels || G.fuels[g.fuel] == null) continue;
    const rate = +g.rate; if (!(rate > 1e-9)) continue;
    const z = genSizing(G, g.fuel, rate, genClockOf(g, p));
    gens.push({ sidx: i, standalone: true, output: g.fuel, gen: g.gen, name: G.name, avail: rate, nGen: z.nGen, mw: z.mw, clock: z.clock, water: z.water });
    rawDemand[g.fuel] = (rawDemand[g.fuel] || 0) + rate;
  }
  const extraction = [];
  for (const item in rawDemand) { const e = extractionFor(item, rawDemand[item], p); if (e) extraction.push(e); }
  return { extraction, gens };
}
function computeFactoryPower() {
  const p = ensurePower();
  const prod = activePlanProduction();
  // Standalone "mine → burn" generators stand on their own — show the ledger even when the
  // plan is empty/infeasible (treat production as zero), so coal power needs no production.
  const hasStandalone = p.standalone.some((g) => POWERGEN[g.gen] && +g.rate > 1e-9);
  if (!prod.feasible && !hasStandalone) return { feasible: false, sourceMode: p.sourceMode };
  const res = prod.feasible ? prod.res : { recipes: [], raw: [], outputs: [], totalPower: 0, totalMachines: 0 };
  const targets = prod.feasible ? prod.targets : {};
  const mult = state.powerMult || 1;
  const prodPowerBase = (res.totalPower || 0) / mult; // res power already carries ×mult
  const { extraction, gens } = powerInfraFor(res, targets);
  const extractionBase = extraction.reduce((a, e) => a + e.powerBase, 0);
  const genWaterBase = gens.reduce((a, g) => a + (g.water ? g.water.powerBase : 0), 0);
  const generated = gens.reduce((a, g) => a + g.mw, 0);
  const consumptionBase = prodPowerBase + extractionBase + genWaterBase;
  return { feasible: true, sourceMode: p.sourceMode, res, machines: res.totalMachines || 0, prodPowerBase, extraction, extractionBase, gens, generated, genWaterBase, consumptionBase };
}
function powerConsRow(tb, stage, building, count, power) {
  const tr = el('tr');
  tr.appendChild(el('td', null, stage));
  tr.appendChild(el('td', null, building));
  const c = el('td', 'num'); c.innerHTML = `${fmt(Math.ceil(count - 1e-9), 0)}× <span class="mach-sub">(${fmt(count)})</span>`; tr.appendChild(c);
  tr.appendChild(el('td', 'num', '−' + fmtPower(power)));
  tb.appendChild(tr);
}
function renderPower() {
  ensurePower();
  $('empty').hidden = true; $('output').hidden = true;
  const pv = $('powerView'); if (pv) pv.hidden = false;
  const set = (id, txt) => { const e = $(id); if (e) e.textContent = txt; };
  const body = (id) => { const t = $(id); return t ? t.querySelector('tbody') : null; };
  const cons = body('pwrConsTable'), gtb = body('pwrGenTable'), mtb = body('pwrMultTable');
  [cons, gtb, mtb].forEach((b) => { if (b) b.innerHTML = ''; });
  const r = computeFactoryPower();
  if (!r.feasible) {
    ['pwrNet', 'pwrDraw', 'pwrGenerated', 'pwrMachines'].forEach((id) => set(id, '—'));
    const ML = { optimize: 'Recipe Optimizer', max: 'Max Throughput', planner: 'Planner' };
    set('pwrNote', `No production to account for — set up a plan in the ${ML[r.sourceMode] || 'Optimizer'} first (or repoint the source on the left).`);
    return;
  }
  const m = state.powerMult || 1;
  const draw = r.consumptionBase * m;
  const net = r.generated - draw;
  set('pwrDraw', fmtPower(draw));
  set('pwrGenerated', fmtPower(r.generated));
  set('pwrMachines', fmt(Math.ceil(r.machines - 1e-9), 0));
  set('pwrNet', (net >= 0 ? '+' : '') + fmtPower(net));
  const netEl = $('pwrNet'); if (netEl) netEl.classList.toggle('neg', net < 0);

  if (cons) {
    const bld = {};
    for (const s of r.res.recipes) { (bld[s.building] = bld[s.building] || { name: s.buildingName, count: 0, power: 0 }); bld[s.building].count += s.machines; bld[s.building].power += s.power; }
    Object.values(bld).sort((a, b) => b.power - a.power).forEach((b, i) => powerConsRow(cons, i === 0 ? 'Production' : '', b.name, b.count, b.power));
    r.extraction.slice().sort((a, b) => b.powerBase - a.powerBase).forEach((e, i) => powerConsRow(cons, i === 0 ? 'Extraction' : '', `${e.name}${e.wells ? ` + ${e.wells}× ${(EXTRACTORS.Build_FrackingSmasher_C && EXTRACTORS.Build_FrackingSmasher_C.name) || 'Pressurizer'}` : ''}${e.hasPurity ? ` · ${e.purity}` : ''}${e.clock !== 1 ? ` · ${Math.round(e.clock * 100)}%` : ''} · ${itemName(e.item)}`, e.count, e.powerBase * m));
    r.gens.forEach((g) => { if (g.water) powerConsRow(cons, 'Gen. water', `Water Extractor → ${g.name}`, g.water.count, g.water.powerBase * m); });
    if (!cons.children.length) cons.innerHTML = '<tr><td colspan="4" style="color:var(--muted)">No machines.</td></tr>';
  }
  if (gtb) {
    r.gens.forEach((g) => {
      const tr = el('tr');
      const td = el('td'); td.appendChild(itemCell(g.output)); tr.appendChild(td);
      tr.appendChild(el('td', null, g.name + (g.clock !== 1 ? ` · ${Math.round(g.clock * 100)}%` : '')));
      const c = el('td', 'num'); c.innerHTML = `${fmt(Math.ceil(g.nGen - 1e-9), 0)}× <span class="mach-sub">(${fmt(g.nGen)})</span>`; tr.appendChild(c);
      tr.appendChild(el('td', 'num', '+' + fmtPower(g.mw)));
      gtb.appendChild(tr);
    });
    if (!r.gens.length) gtb.innerHTML = '<tr><td colspan="4" style="color:var(--muted)">No generators — add one to burn an output for power.</td></tr>';
  }
  if (mtb) {
    GAME.power.forEach((mm) => {
      const d = r.consumptionBase * mm, n = r.generated - d;
      const tr = el('tr'); if (Math.abs(mm - m) < 1e-9) tr.classList.add('cur');
      tr.appendChild(el('td', null, mm + '×' + (Math.abs(mm - m) < 1e-9 ? ' (current)' : '')));
      tr.appendChild(el('td', 'num', fmtPower(d)));
      const ntd = el('td', 'num', (n >= 0 ? '+' : '') + fmtPower(n)); if (n < 0) ntd.classList.add('neg'); tr.appendChild(ntd);
      mtb.appendChild(tr);
    });
  }
  const note = $('pwrNote');
  if (note) {
    const bits = [`production ${fmtPower(r.prodPowerBase * m)}`];
    if (r.extractionBase > 1e-9) bits.push(`extraction ${fmtPower(r.extractionBase * m)}`);
    if (r.genWaterBase > 1e-9) bits.push(`generator water ${fmtPower(r.genWaterBase * m)}`);
    note.textContent = `Draw = ${bits.join(' + ')}. Extraction power is an estimate at the purity set per resource; generation is never scaled by the multiplier.`;
  }
}
function purityRow(item, p) {
  const row = el('label', 'fld');
  row.appendChild(el('span', null, itemName(item)));
  const sel = el('select', 'sel');
  [['impure', 'Impure (×0.5)'], ['normal', 'Normal (×1)'], ['pure', 'Pure (×2)']].forEach(([v, lbl]) => {
    const o = el('option', null, lbl); o.value = v; if ((p.purity[item] || 'normal') === v) o.selected = true; sel.appendChild(o);
  });
  sel.addEventListener('change', () => { ensurePower().purity[item] = sel.value; save(); renderPower(); });
  row.appendChild(sel);
  return row;
}
function powerGenRow(g, idx, burnable) {
  const row = el('div', 'pwr-row');
  const osel = el('select', 'sel');
  burnable.forEach((o) => { const opt = el('option', null, itemName(o.item)); opt.value = o.item; if (o.item === g.output) opt.selected = true; osel.appendChild(opt); });
  if (!burnable.some((o) => o.item === g.output)) { const opt = el('option', null, `${itemName(g.output)} (n/a)`); opt.value = g.output; opt.selected = true; osel.appendChild(opt); }
  osel.addEventListener('change', () => { const p = ensurePower(); p.gens[idx].output = osel.value; const gg = gensForFuel(osel.value); if (!gg.includes(p.gens[idx].gen)) p.gens[idx].gen = gg[0] || ''; save(); buildPowerControls(); renderPower(); });
  const gsel = el('select', 'sel');
  gensForFuel(g.output).forEach((gc) => { const opt = el('option', null, POWERGEN[gc].name); opt.value = gc; if (gc === g.gen) opt.selected = true; gsel.appendChild(opt); });
  gsel.addEventListener('change', () => { ensurePower().gens[idx].gen = gsel.value; save(); renderPower(); });
  const del = el('button', 'btn mini ghost pwr-del', '✕');
  del.title = 'Remove generator';
  del.addEventListener('click', () => { ensurePower().gens.splice(idx, 1); save(); buildPowerControls(); renderPower(); });
  row.appendChild(osel); row.appendChild(gsel); row.appendChild(del);
  return row;
}
function buildPowerControls() {
  const p = ensurePower();
  if ($('pwrSource')) $('pwrSource').value = p.sourceMode;
  const msel = $('pwrMiner');
  if (msel) {
    msel.innerHTML = '';
    Object.keys(EXTRACTORS).filter((c) => EXTRACTORS[c].form === 'solid').forEach((c) => {
      const o = el('option', null, `${EXTRACTORS[c].name} (${fmt(EXTRACTORS[c].ratePerMin, 0)}/min normal)`); o.value = c;
      if (c === p.minerTier) o.selected = true; msel.appendChild(o);
    });
  }
  if ($('pwrMinerClock')) $('pwrMinerClock').value = p.minerClock;
  if ($('pwrGenClock')) $('pwrGenClock').value = p.genClock;
  const prod = activePlanProduction();
  const pl = $('pwrPurityList');
  if (pl) {
    pl.innerHTML = '';
    const raws = prod.feasible ? (prod.res.raw || []) : [];
    const purityRaws = raws.filter((r) => { const e = extractionFor(r.item, r.rate, p); return e && e.hasPurity; })
      .sort((a, b) => itemName(a.item).localeCompare(itemName(b.item)));
    purityRaws.forEach((r) => pl.appendChild(purityRow(r.item, p)));
    if (!purityRaws.length) pl.appendChild(el('small', 'hint', prod.feasible ? 'No purity-based raws in this plan.' : 'Set up production to list raw inputs.'));
  }
  const gl = $('pwrGenList');
  if (gl) {
    gl.innerHTML = '';
    const burnable = burnableOutputs(prod);
    p.gens.forEach((g, idx) => gl.appendChild(powerGenRow(g, idx, burnable)));
    if (!p.gens.length) gl.appendChild(el('small', 'hint', burnable.length ? 'Add a generator to burn an output for power.' : (prod.feasible ? 'This plan makes no burnable fuel output.' : 'Set up production first.')));
    if ($('pwrAddGen')) $('pwrAddGen').disabled = !burnable.length;
  }
  const sl = $('pwrStandaloneList');
  if (sl) {
    sl.innerHTML = '';
    const fuels = rawFuels();
    p.standalone.forEach((g, idx) => sl.appendChild(standaloneRow(g, idx, fuels)));
    if (!p.standalone.length) sl.appendChild(el('small', 'hint', fuels.length ? 'Add coal power to mine a raw fuel and burn it directly — no plan needed.' : 'No raw-minable generator fuels.'));
    if ($('pwrAddStandalone')) $('pwrAddStandalone').disabled = !fuels.length;
  }
}
// One standalone "mine → burn" generator row: pick the raw fuel, the generator, and how much
// fuel/min to burn. Miners + generators (+ water for coal) are sized off the rate in powerInfraFor.
function standaloneRow(g, idx, fuels) {
  const row = el('div', 'pwr-row');
  const fsel = el('select', 'sel');
  fuels.forEach((it) => { const opt = el('option', null, itemName(it)); opt.value = it; if (it === g.fuel) opt.selected = true; fsel.appendChild(opt); });
  fsel.addEventListener('change', () => { const p = ensurePower(); p.standalone[idx].fuel = fsel.value; const gg = gensForFuel(fsel.value); if (!gg.includes(p.standalone[idx].gen)) p.standalone[idx].gen = gg[0] || ''; save(); buildPowerControls(); renderPower(); });
  const gsel = el('select', 'sel');
  gensForFuel(g.fuel).forEach((gc) => { const opt = el('option', null, POWERGEN[gc].name); opt.value = gc; if (gc === g.gen) opt.selected = true; gsel.appendChild(opt); });
  gsel.addEventListener('change', () => { ensurePower().standalone[idx].gen = gsel.value; save(); renderPower(); });
  const rin = el('input', 'clock-input'); rin.type = 'number'; rin.min = '0'; rin.step = '10'; rin.value = g.rate; rin.title = 'Fuel burned per minute';
  rin.addEventListener('change', () => { const v = Math.max(0, parseFloat(rin.value) || 0); ensurePower().standalone[idx].rate = v; rin.value = v; save(); renderPower(); });
  const del = el('button', 'btn mini ghost pwr-del', '✕'); del.title = 'Remove';
  del.addEventListener('click', () => { ensurePower().standalone.splice(idx, 1); save(); buildPowerControls(); renderPower(); });
  row.appendChild(fsel); row.appendChild(gsel); row.appendChild(rin); row.appendChild(el('span', 'np-unit', '/min')); row.appendChild(del);
  return row;
}
function wirePowerControls() {
  const on = (id, ev, fn) => { const e = $(id); if (e) e.addEventListener(ev, fn); };
  on('pwrSource', 'change', (e) => { ensurePower().sourceMode = e.target.value; save(); buildPowerControls(); renderPower(); });
  on('pwrMiner', 'change', (e) => { ensurePower().minerTier = e.target.value; save(); buildPowerControls(); renderPower(); });
  on('pwrMinerClock', 'change', (e) => { const v = clampClock(e.target.value); ensurePower().minerClock = v; e.target.value = v; save(); renderPower(); });
  on('pwrGenClock', 'change', (e) => { const v = clampClock(e.target.value); ensurePower().genClock = v; e.target.value = v; save(); renderPower(); });
  on('pwrAddGen', 'click', () => {
    const p = ensurePower();
    const burnable = burnableOutputs(activePlanProduction());
    if (!burnable.length) return;
    const out = burnable[0].item;
    p.gens.push({ output: out, gen: gensForFuel(out)[0] || '' });
    save(); buildPowerControls(); renderPower();
  });
  on('pwrAddStandalone', 'click', () => {
    const p = ensurePower();
    const fuels = rawFuels();
    if (!fuels.length) return;
    const fuel = fuels[0];
    const def = (EXTRACTORS[p.minerTier] && EXTRACTORS[p.minerTier].ratePerMin) || 60; // one normal node of fuel
    p.standalone.push({ fuel, gen: gensForFuel(fuel)[0] || '', rate: def });
    save(); buildPowerControls(); renderPower();
  });
}

// ---------- control builders ----------
function buildItemList() {
  const dl = $('itemList');
  dl.innerHTML = '';
  for (const it of targetable) { const o = el('option'); o.value = it.n; dl.appendChild(o); }
  const il = $('inputList'); // resources + intermediates, for input/supply pickers
  if (il) { il.innerHTML = ''; for (const it of inputItems) { const o = el('option'); o.value = it.n; il.appendChild(o); } }
}
// Build the "link to another plan" <select> for a supply/extra-input row. Options:
// "Manual" plus one entry per (source plan, item it outputs) pair in the active
// project that wouldn't form a cycle. Value = "planId|itemClass". Choosing one sets
// row.fromPlanId/fromItem (and the row's item to match); choosing Manual clears them.
// `onChange` re-renders + re-solves. Returns the select element.
function buildLinkSelect(row, setItem, onChange) {
  const sel = el('select', 'row-link');
  sel.title = 'Drive this input from another plan’s output';
  const mk = (val, label, on) => { const o = el('option', null, label); o.value = val; if (on) o.selected = true; sel.appendChild(o); };
  mk('', 'Manual', !row.fromPlanId);
  let linkedStillValid = false;
  for (const src of activeProjectPlans()) {
    if (src.id === activeId) continue;                 // can't link to self
    if (linkWouldCycle(activeId, src.id)) continue;     // would create a cycle
    const outs = planNetOutputs(src);
    for (const item in outs) {
      if (!(outs[item] > 0)) continue;
      const val = src.id + '|' + item;
      const on = row.fromPlanId === src.id && row.fromItem === item;
      if (on) linkedStillValid = true;
      mk(val, `${src.name} → ${itemName(item)} (${fmt(outs[item])}/min)`, on);
    }
  }
  // A previously-saved link whose source no longer offers that item: keep it visible
  // (resolves to 0) so the user sees it and can re-point or clear it.
  if (row.fromPlanId && !linkedStillValid) {
    const src = plans.find((p) => p.id === row.fromPlanId);
    mk(row.fromPlanId + '|' + row.fromItem, `${src ? src.name : 'missing plan'} → ${itemName(row.fromItem)} (0/min)`, true);
  }
  sel.addEventListener('change', () => {
    const v = sel.value;
    if (!v) { delete row.fromPlanId; delete row.fromItem; }
    else {
      const [pid, item] = v.split('|');
      // Guard again at apply time in case state shifted since render.
      if (linkWouldCycle(activeId, pid)) { if (typeof alert === 'function') alert('That link would create a cycle between plans. Pick a different source.'); renderActiveRows(); return; }
      row.fromPlanId = pid; row.fromItem = item;
      if (setItem) setItem(item); // make the row's item match what it's fed
    }
    save();
    onChange();
  });
  return sel;
}
// Re-render whichever per-plan row UIs depend on link state, then re-solve.
function renderActiveRows() { buildOptExtraInputs(); buildMaxSupply(); solveAndRender(); }

// Optimizer "other inputs": extra non-resource items the optimizer may consume freely.
function buildOptExtraInputs() {
  const box = $('optExtraInputs');
  if (!box) return;
  box.innerHTML = '';
  (state.opt.extraInputs || (state.opt.extraInputs = [])).forEach((x, i) => {
    const row = el('div', 'row');
    const linked = !!x.fromPlanId;
    const name = el('input', 'row-item'); name.setAttribute('list', 'inputList'); name.placeholder = 'item…';
    name.value = linked && x.fromItem ? itemName(x.fromItem) : x.name; name.autocomplete = 'off'; name.disabled = linked;
    const cap = el('input', 'row-rate'); cap.type = 'number'; cap.min = '0'; cap.step = 'any'; cap.placeholder = '∞';
    cap.value = linked ? fmt(resolveLinkedCap(x) || 0) : x.cap; cap.disabled = linked; // linked cap is driven by the source plan
    const link = buildLinkSelect(x, (item) => { x.name = itemName(item); }, renderActiveRows);
    const rm = el('button', 'row-rm', '×'); rm.setAttribute('aria-label', 'Remove'); rm.title = 'Remove';
    name.addEventListener('input', () => { x.name = name.value; save(); solveAndRender(); });
    cap.addEventListener('input', () => { x.cap = cap.value; save(); solveAndRender(); });
    rm.addEventListener('click', () => { state.opt.extraInputs.splice(i, 1); save(); buildOptExtraInputs(); solveAndRender(); });
    row.append(name, cap, link, rm);
    box.appendChild(row);
  });
}
function buildGameSelect(id, values, cur) {
  const sel = $(id);
  sel.innerHTML = '';
  for (const v of values) { const o = el('option', null, v === 1 ? '1 (Default)' : String(v)); o.value = String(v); if (v === cur) o.selected = true; sel.appendChild(o); }
}
// Output-destination dropdown: a line product (default), or a tagged pull into the
// Dimensional Depot / storage. The production is built either way (see plannerTargets);
// the tag only regroups it. Returns a <select> with `cur` selected.
function destSelect(cur) {
  const sel = el('select', 'row-dest');
  [['line', 'Line'], ['depot', 'Depot'], ['storage', 'Storage']].forEach(([v, label]) => {
    const o = el('option', null, label); o.value = v; if (v === cur) o.selected = true; sel.appendChild(o);
  });
  return sel;
}
// Planner extra desired outputs (the primary stays in #targetItem/#targetRate).
// These are Planner-local, so unlike the optimizer's first row they don't sync
// across tabs; an empty list is fine because the primary is the anchor.
function buildPlannerExtra() {
  const box = $('plannerExtra');
  if (!box) return;
  box.innerHTML = '';
  (state.extraTargets || (state.extraTargets = [])).forEach((o, i) => {
    const row = el('div', 'row row-dst'); // row-dst widens the grid for the destination select
    const name = el('input', 'row-item'); name.setAttribute('list', 'itemList'); name.placeholder = 'item…'; name.value = o.name; name.autocomplete = 'off';
    const rate = el('input', 'row-rate'); rate.type = 'number'; rate.min = '0'; rate.step = 'any'; rate.value = o.rate;
    const dest = destSelect(normDest(o.dest)); dest.title = 'Where this output is routed';
    const rm = el('button', 'row-rm', '×'); rm.setAttribute('aria-label', 'Remove'); rm.title = 'Remove';
    name.addEventListener('input', () => { o.name = name.value; save(); solveAndRender(); });
    rate.addEventListener('input', () => { o.rate = parseFloat(rate.value) || 0; save(); solveAndRender(); });
    dest.addEventListener('change', () => { o.dest = dest.value; save(); solveAndRender(); });
    rm.addEventListener('click', () => { state.extraTargets.splice(i, 1); save(); buildPlannerExtra(); solveAndRender(); });
    row.append(name, rate, dest, rm);
    box.appendChild(row);
  });
}
function buildOptOutputs() {
  const box = $('optOutputs');
  box.innerHTML = '';
  state.opt.outputs.forEach((o, i) => {
    const row = el('div', 'row');
    const name = el('input', 'row-item'); name.setAttribute('list', 'itemList'); name.placeholder = 'item…'; name.value = o.name; name.autocomplete = 'off';
    const rate = el('input', 'row-rate'); rate.type = 'number'; rate.min = '0'; rate.step = 'any'; rate.value = o.rate;
    const rm = el('button', 'row-rm', '×'); rm.setAttribute('aria-label', 'Remove'); rm.title = 'Remove';
    name.addEventListener('input', () => { o.name = name.value; if (i === 0 && nameToClass(name.value)) { state.targetItem = nameToClass(name.value); reflectPrimary('optimize'); } save(); solveAndRender(); });
    rate.addEventListener('input', () => { o.rate = parseFloat(rate.value) || 0; if (i === 0) { state.targetRate = o.rate; reflectPrimary('optimize'); } save(); solveAndRender(); });
    rm.addEventListener('click', () => { state.opt.outputs.splice(i, 1); if (!state.opt.outputs.length) state.opt.outputs.push({ name: '', rate: 60 }); save(); buildOptOutputs(); solveAndRender(); });
    row.append(name, rate, rm);
    box.appendChild(row);
  });
}
function buildOptInputs() {
  const box = $('optInputs');
  box.innerHTML = '';
  for (const r of resList) {
    const cfg = state.opt.inputs[r.c] || (state.opt.inputs[r.c] = { on: true, cap: '' });
    const row = el('div', 'res-row');
    const lab = el('label', 'res-name');
    const cb = el('input'); cb.type = 'checkbox'; cb.checked = cfg.on;
    lab.appendChild(cb); lab.appendChild(document.createTextNode(' ' + r.n));
    const cap = el('input', 'res-cap'); cap.type = 'number'; cap.min = '0'; cap.step = 'any'; cap.placeholder = '∞'; cap.value = cfg.cap;
    cb.addEventListener('change', () => { cfg.on = cb.checked; save(); solveAndRender(); });
    cap.addEventListener('input', () => { cfg.cap = cap.value; save(); solveAndRender(); });
    row.append(lab, cap);
    box.appendChild(row);
  }
}
function buildMaxSupply() {
  const box = $('maxSupply');
  box.innerHTML = '';
  state.max.supply.forEach((s, i) => {
    const row = el('div', 'row');
    const linked = !!s.fromPlanId;
    const name = el('input', 'row-item'); name.setAttribute('list', 'inputList'); name.placeholder = 'item…';
    name.value = linked && s.fromItem ? itemName(s.fromItem) : (s.item ? itemName(s.item) : ''); name.autocomplete = 'off'; name.disabled = linked;
    const amt = el('input', 'row-rate'); amt.type = 'number'; amt.min = '0'; amt.step = 'any';
    amt.value = linked ? fmt(resolveLinkedCap(s) || 0) : s.amount; amt.disabled = linked; // linked amount driven by the source plan
    const link = buildLinkSelect(s, (item) => { s.item = item; }, renderActiveRows);
    const rm = el('button', 'row-rm', '×'); rm.setAttribute('aria-label', 'Remove'); rm.title = 'Remove';
    name.addEventListener('input', () => { s.item = anyNameToClass(name.value); save(); solveAndRender(); });
    amt.addEventListener('input', () => { s.amount = parseFloat(amt.value) || 0; save(); solveAndRender(); });
    rm.addEventListener('click', () => { state.max.supply.splice(i, 1); if (!state.max.supply.length) state.max.supply.push({ item: resList[0].c, amount: 120 }); save(); buildMaxSupply(); solveAndRender(); });
    row.append(name, amt, link, rm);
    box.appendChild(row);
  });
}
// ---------- unlocked alternates from save file ----------
function fillSaveSelect(sel, info) {
  if (!sel) return;
  sel.innerHTML = '';
  if (!info.saves.length) {
    const o = el('option', null, info.exists ? 'No .sav files found' : 'Save folder not found');
    o.value = '';
    sel.appendChild(o);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const s of info.saves) {
    const o = el('option', null, (s.folder ? s.folder.slice(0, 8) + '…/' : '') + s.name);
    o.value = s.file;
    sel.appendChild(o);
  }
}
function buildSaveList() {
  let info;
  try { info = SAVE.listSaves(); } catch (e) { info = { exists: false, saves: [] }; }
  fillSaveSelect($('saveSelect'), info);
  fillSaveSelect($('mapSaveSelect'), info);
  fillSaveSelect($('xraySaveSelect'), info);
  applySaveSelection(); // restore the remembered save in every picker
}
// The alternates picker and the map picker point at the same save. Keep them in
// sync and remember the choice (a world-level setting, like the unlocks it yields).
function applySaveSelection() {
  const f = state.saveFile || '';
  if (!f) return;
  for (const id of ['saveSelect', 'mapSaveSelect', 'xraySaveSelect']) {
    const sel = $(id);
    if (sel && [...sel.options].some((o) => o.value === f)) sel.value = f;
  }
}
function selectSaveFile(file) {
  state.saveFile = file || '';
  applySaveSelection();
  save();
}
let altSearch = '';
// Alternates the user can manage: the unlocked set when a save is loaded, else all.
function altUniverse() {
  return (state.unlockedAlts ? state.unlockedAlts : ALT_CLASSES).slice();
}
// Renders the save status line AND the per-recipe enable/disable checkbox list.
// (Called by applyStateToControls on plan switch, so the list tracks the plan.)
function renderSaveStatus() {
  const st = $('saveStatus');
  if (st) {
    st.classList.remove('warn-text');
    st.textContent = !state.unlockedAlts
      ? 'No save loaded — all alternates available. Untick any to exclude it.'
      : `${state.unlockedAlts.length} alternate${state.unlockedAlts.length === 1 ? '' : 's'} unlocked${state.saveName ? ' · ' + state.saveName : ''}.`;
  }
  const list = $('altList');
  if (!list) return;
  const disabled = state.disabledAlts || [];
  const universe = altUniverse()
    .map((rc) => ({ rc, name: RECIPES[rc] ? RECIPES[rc].name.replace(/^Alternate:\s*/, '') : rc }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const cnt = $('altCount');
  if (cnt) cnt.textContent = `${universe.filter((u) => !disabled.includes(u.rc)).length}/${universe.length} on`;
  const q = altSearch.trim().toLowerCase();
  const shown = q ? universe.filter((u) => u.name.toLowerCase().includes(q)) : universe;
  list.innerHTML = '';
  for (const u of shown) {
    const row = el('label', 'alt-row');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !disabled.includes(u.rc);
    cb.addEventListener('change', () => {
      const arr = state.disabledAlts || (state.disabledAlts = []);
      const i = arr.indexOf(u.rc);
      if (cb.checked) { if (i >= 0) arr.splice(i, 1); }
      else if (i < 0) arr.push(u.rc);
      save();
      renderSaveStatus();
      solveAndRender();
    });
    row.appendChild(cb);
    row.appendChild(document.createTextNode(' ' + u.name));
    list.appendChild(row);
  }
  if (!shown.length) list.appendChild(el('div', 'hint', q ? 'No matches.' : 'No alternates.'));
}
// Enable (on=true) or exclude (on=false) every alternate currently in the list.
function setAllAlts(on) {
  const uni = altUniverse();
  const arr = state.disabledAlts || (state.disabledAlts = []);
  if (on) state.disabledAlts = arr.filter((rc) => !uni.includes(rc));
  else { const s = new Set(arr); uni.forEach((rc) => s.add(rc)); state.disabledAlts = [...s]; }
  save();
  renderSaveStatus();
  solveAndRender();
}

// ---------- F1: standard-recipe veto + F4: building veto ----------
let stdSearch = '';
// Per-recipe enable/disable list for STANDARD recipes (mirrors the alternate list, minus
// the save-unlock concept — standard recipes are always "unlocked", only manually vetoed).
function renderStdList() {
  const list = $('stdList');
  if (!list) return;
  const disabled = state.disabledRecipes || [];
  const universe = STD_CLASSES
    .map((rc) => ({ rc, name: RECIPES[rc] ? RECIPES[rc].name : rc }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const cnt = $('stdCount');
  if (cnt) cnt.textContent = `${universe.filter((u) => !disabled.includes(u.rc)).length}/${universe.length} on`;
  const q = stdSearch.trim().toLowerCase();
  const shown = q ? universe.filter((u) => u.name.toLowerCase().includes(q)) : universe;
  list.innerHTML = '';
  for (const u of shown) {
    const row = el('label', 'alt-row');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !disabled.includes(u.rc);
    cb.addEventListener('change', () => {
      const arr = state.disabledRecipes || (state.disabledRecipes = []);
      const i = arr.indexOf(u.rc);
      if (cb.checked) { if (i >= 0) arr.splice(i, 1); }
      else if (i < 0) arr.push(u.rc);
      save();
      renderStdList();
      solveAndRender();
    });
    row.appendChild(cb);
    row.appendChild(document.createTextNode(' ' + u.name));
    list.appendChild(row);
  }
  if (!shown.length) list.appendChild(el('div', 'hint', q ? 'No matches.' : 'No recipes.'));
}
function setAllStd(on) {
  const arr = state.disabledRecipes || (state.disabledRecipes = []);
  if (on) state.disabledRecipes = arr.filter((rc) => !STD_CLASSES.includes(rc));
  else { const s = new Set(arr); STD_CLASSES.forEach((rc) => s.add(rc)); state.disabledRecipes = [...s]; }
  save();
  renderStdList();
  solveAndRender();
}
// Building on/off checkboxes (F4). Disabling a building drops ALL its recipes from the
// allowed set in one action — implemented by adding the building to state.disabledBuildings,
// which blockedRecipeSet() expands into recipe classNames for the solver/planner.
function renderBldList() {
  const list = $('bldList');
  if (!list) return;
  const off = state.disabledBuildings || [];
  const cnt = $('bldCount');
  if (cnt) cnt.textContent = `${buildingList.length - off.filter((b) => recipesByBuilding[b]).length}/${buildingList.length} on`;
  list.innerHTML = '';
  for (const b of buildingList) {
    const row = el('label', 'alt-row');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !off.includes(b.b);
    cb.addEventListener('change', () => {
      const arr = state.disabledBuildings || (state.disabledBuildings = []);
      const i = arr.indexOf(b.b);
      if (cb.checked) { if (i >= 0) arr.splice(i, 1); }
      else if (i < 0) arr.push(b.b);
      save();
      renderBldList();
      solveAndRender();
    });
    row.appendChild(cb);
    row.appendChild(document.createTextNode(` ${b.name} (${b.count})`));
    list.appendChild(row);
  }
}
function setAllBld(on) {
  state.disabledBuildings = on ? [] : buildingList.map((b) => b.b);
  save();
  renderBldList();
  solveAndRender();
}
// Parse a specific save for its unlocked alternates and apply them. silent=true (the
// auto-newest-save path) skips the "Parsing…"/error chrome so a background reload is quiet.
function loadAlternatesFrom(file, silent) {
  if (!file) return;
  const st = $('saveStatus');
  if (st && !silent) { st.classList.remove('warn-text'); st.textContent = 'Parsing save…'; }
  state.saveFile = file; save(); // remember across sessions
  // Defer so "Parsing…" paints before the synchronous parse blocks the thread.
  setTimeout(() => {
    let res;
    try { res = SAVE.readUnlockedAlternates(file); }
    catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
    if (!res.ok) { if (st && !silent) { st.textContent = '⚠ ' + res.error; st.classList.add('warn-text'); } return; }
    state.unlockedAlts = res.recognized.map((r) => r.className);
    state.saveName = res.saveName || '';
    for (const item in state.picks) {
      const p = state.picks[item];
      if (p && p !== 'RAW' && RECIPES[p] && RECIPES[p].alternate && !state.unlockedAlts.includes(p)) delete state.picks[item];
    }
    save();
    renderSaveStatus();
    if (!silent && st && res.unknown && res.unknown.length) st.textContent += ` (+${res.unknown.length} not in app data)`;
    solveAndRender();
  }, 20);
}
function loadFromSelectedSave() {
  const sel = $('saveSelect');
  loadAlternatesFrom(sel && sel.value, false);
}
// Auto-load on a fresh save (main process watches the folder and pushes the newest one):
// follow it, re-read alternates, and refresh the map if one was already loaded. Guarded by
// the Auto-load toggle and de-duped on (file, mtime) so a burst of writes acts once.
let _autoSaveFile = '', _autoSaveMtime = 0;
// The save parses below run synchronously over the preload bridge (~1s each, up to
// three of them) and the game autosaves every few minutes — running them the moment
// the watcher fires used to freeze the UI mid-keystroke. Wait for an input lull,
// then run each parse in its own macrotask so queued events interleave between them.
let _lastUserInput = 0;
if (typeof window !== 'undefined') {
  ['pointerdown', 'keydown', 'wheel'].forEach((t) =>
    window.addEventListener(t, () => { _lastUserInput = Date.now(); }, { capture: true, passive: true }));
}
let _autoSaveTimer = null;
function onNewestSave(info) {
  if (!info || !info.file || state.autoSave === false) return;
  if (info.file === _autoSaveFile && info.mtimeMs === _autoSaveMtime) return;
  _autoSaveFile = info.file; _autoSaveMtime = info.mtimeMs || 0;
  const IDLE = 1500;
  const run = () => {
    _autoSaveTimer = null;
    if (Date.now() - _lastUserInput < IDLE) { _autoSaveTimer = setTimeout(run, IDLE); return; } // still typing/dragging — try again shortly
    state.saveFile = info.file; save();
    buildSaveList(); // surface the new file in both pickers and re-select it
    loadAlternatesFrom(info.file, true);
    if (mapNodes.length || mapBuildings.length) setTimeout(() => loadMapFrom(info.file, true), 60); // keep a loaded map fresh
    if (xrayData) setTimeout(() => loadXrayFrom(info.file, true), 120); // keep a loaded X-ray fresh
  };
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(run, 50);
}
function clearUnlockedFilter() {
  state.unlockedAlts = null;
  state.saveName = '';
  save();
  renderSaveStatus();
  solveAndRender();
}

function setMode(mode) {
  closeNodePopup(); // switching modes rebuilds the plan — drop any open node popup
  // Entering the Power Planner from a production tab: remember which production solve to
  // read, so the ledger reflects the plan you were just on (and switching back is lossless).
  if (mode === 'power' && POWER_SOURCES.includes(state.mode)) ensurePower().sourceMode = state.mode;
  // Remember the last production mode separately: parking the tab on a non-production
  // view (project/map/xray/power) must not change how this plan solves headlessly
  // (rollup / base balance / linked caps). Capture it both on entering a production
  // tab and on leaving one, so the info survives `state.mode` being overwritten.
  if (POWER_SOURCES.includes(mode)) state.prodMode = mode;
  else if (POWER_SOURCES.includes(state.mode)) state.prodMode = state.mode;
  state.mode = mode;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === mode));
  document.querySelectorAll('.mode-panel').forEach((p) => { p.hidden = p.dataset.mode !== mode; });
  const isMap = mode === 'map';
  const isProject = mode === 'project';
  const isPower = mode === 'power';
  const isXray = mode === 'xray';
  // Map, Project Totals, Power Planner and Base X-ray are not single-plan recipe
  // calculators, so the shared calc-only panels (alternates / cost / per-plan summary)
  // don't apply.
  document.querySelectorAll('.calc-only').forEach((e) => { e.style.display = (isMap || isProject || isPower || isXray) ? 'none' : ''; });
  $('btnReset').style.display = mode === 'planner' ? '' : 'none';
  // The alternate list auto-selects recipes only in Optimizer/Max. Planner builds
  // from the per-row dropdowns, so spell that out instead of letting users expect a
  // re-solve when they untick an alt here.
  const altHelp = $('altHelp');
  if (altHelp) altHelp.textContent = mode === 'planner'
    ? 'Planner uses the recipe picked in each row below. This list filters those row dropdowns; it auto-selects recipes only in Recipe Optimizer & Max Throughput.'
    : 'Untick a recipe to stop the optimizer using it — even if unlocked or optimal.';
  $('mapView').hidden = !isMap;
  if ($('projectView')) $('projectView').hidden = !isProject;
  if ($('powerView')) $('powerView').hidden = !isPower;
  if ($('xrayView')) $('xrayView').hidden = !isXray;
  save();
  if (isMap) {
    $('empty').hidden = true; $('output').hidden = true;
    // Auto-load the remembered save the first time the map is opened in a session,
    // so reopening the app restores the last map without a manual "Load map" click.
    if (state.saveFile && !mapNodes.length && !mapBuildings.length) loadMapFromSave();
    else renderMap();
    renderAreaControls(); // reflect the active plan's outline in the Factory-area panel
  } else if (isProject) {
    $('empty').hidden = true; $('output').hidden = true;
    renderProjectTotals();
  } else if (isPower) {
    $('empty').hidden = true; $('output').hidden = true;
    buildPowerControls(); // (re)build the dynamic purity + generator lists for this plan
    renderPower();
  } else if (isXray) {
    $('empty').hidden = true; $('output').hidden = true;
    // Per-plan scope: the X-ray prefers an outlined area (unless "Whole base" is on).
    // With no area, STAY on this tab and offer both ways forward — the "Whole base"
    // checkbox lives in this panel, and "✏ Edit area" routes to the map with the draw
    // tool armed. (Auto-routing to the map made the whole-base toggle unreachable and
    // dropped first-time users into a blank draw mode.)
    if (!state.xrayWholeBase && !activeXrayRegion()) {
      const xe = $('xrayEmpty');
      if (xe) {
        xe.innerHTML = '<p>No factory area outlined for this plan.</p><p>Tick <b>Whole base (ignore area)</b> in the left panel to analyze your entire save, or click <b>✏ Edit area</b> to outline this plan’s factory on the map.</p>';
        xe.hidden = false;
      }
      if ($('xrayBody')) $('xrayBody').hidden = true;
      return;
    }
    // Parse once for this save (cached); otherwise just re-aggregate for the active scope.
    if (state.saveFile && (!xrayRaw || xrayRawFile !== state.saveFile)) loadXrayFromSave();
    else { xrayData = null; renderXray(); }
  } else solveAndRender();
}

// ---------- project bar ----------
function renderProjectBar() {
  const sel = $('projectSelect');
  if (!sel) return;
  sel.innerHTML = '';
  projects.forEach((p) => {
    const o = el('option', null, p.name);
    o.value = p.id;
    if (p.id === activeProjectId) o.selected = true;
    sel.appendChild(o);
  });
  const del = $('projectDelete');
  if (del) del.disabled = projects.length <= 1; // never zero projects
}

// ---------- plan bar ----------
// Shows only the plans belonging to the active project.
function renderPlanBar() {
  const box = $('planTabs');
  if (!box) return;
  box.innerHTML = '';
  activeProjectPlans().forEach((p) => {
    const tab = el('div', 'plan-tab' + (p.id === activeId ? ' active' : ''));
    const lab = el('span', 'plan-name', p.name);
    lab.title = 'Click to open · double-click to rename';
    lab.addEventListener('click', () => { if (p.id !== activeId) switchPlan(p.id); });
    lab.addEventListener('dblclick', () => startRename(tab, lab, p));
    tab.appendChild(lab);
    const x = el('button', 'plan-close', '×');
    x.title = 'Delete this plan';
    x.setAttribute('aria-label', 'Delete plan ' + p.name);
    x.addEventListener('click', (e) => { e.stopPropagation(); deletePlan(p.id); });
    tab.appendChild(x);
    box.appendChild(tab);
  });
}

// ---------- project rollup ----------
// Sum raw inputs + power + machines across every plan in the active project. Each
// plan is solved headlessly (compute-only). Linked inputs are netted out so a shared
// intermediate produced by plan A and consumed by plan B isn't counted as a raw input.
function computeProjectTotals() {
  const rows = activeProjectPlans();
  const rawTotals = {};      // itemClass -> summed raw rate across plans
  let totalPower = 0, totalMachines = 0;
  const perPlan = [];
  // Items that one plan supplies to another within this project (linked sources):
  // these are produced internally, so drop them from the project's raw totals.
  const internalSupply = {};
  for (const pl of rows) {
    for (const r of planLinkRows(pl)) {
      const inside = rows.some((s) => s.id === r.fromPlanId);
      if (inside && r.fromItem) internalSupply[r.fromItem] = true;
    }
  }
  for (const pl of rows) {
    const out = computeStateResult(pl.state);
    const info = { name: pl.name, mode: pl.state.mode, ok: out.feasible, power: 0, machines: 0 };
    if (out.feasible) {
      const res = out.res;
      info.power = res.totalPower || 0;
      info.machines = res.totalMachines || 0;
      totalPower += info.power;
      totalMachines += info.machines || 0;
      for (const r of res.raw || []) {
        if (internalSupply[r.item]) continue; // supplied by a sibling plan, not raw
        rawTotals[r.item] = (rawTotals[r.item] || 0) + r.rate;
      }
    }
    perPlan.push(info);
  }
  return { rawTotals, totalPower, totalMachines, perPlan, count: rows.length };
}
function renderProjectTotals() {
  const t = computeProjectTotals();
  const proj = activeProject();
  if ($('projTitle')) $('projTitle').textContent = proj ? proj.name : '';
  if ($('projPlanCount')) $('projPlanCount').textContent = fmt(t.count, 0);
  if ($('projTotalPower')) $('projTotalPower').textContent = fmtPower(t.totalPower);
  if ($('projTotalMachines')) $('projTotalMachines').textContent = fmt(t.totalMachines, 0);
  if ($('projPowerBig')) $('projPowerBig').textContent = fmtPower(t.totalPower);
  if ($('projMachinesBig')) $('projMachinesBig').textContent = fmt(t.totalMachines, 0);

  const rtb = $('projRawTable') && $('projRawTable').querySelector('tbody');
  if (rtb) {
    rtb.innerHTML = '';
    const raws = Object.keys(t.rawTotals).filter((c) => t.rawTotals[c] > 1e-4)
      .map((c) => ({ item: c, rate: t.rawTotals[c] }))
      .sort((a, b) => itemName(a.item).localeCompare(itemName(b.item)));
    raws.forEach((r) => {
      const tr = el('tr');
      const td = el('td'); td.appendChild(itemCell(r.item)); tr.appendChild(td);
      tr.appendChild(el('td', 'num', fmt(r.rate)));
      rtb.appendChild(tr);
    });
    if (!raws.length) rtb.innerHTML = '<tr><td colspan="2" style="color:var(--muted)">No raw inputs yet — set a target in a plan.</td></tr>';
  }
  const ptb = $('projPlansTable') && $('projPlansTable').querySelector('tbody');
  if (ptb) {
    ptb.innerHTML = '';
    const MODE_LABEL = { planner: 'Planner', optimize: 'Optimizer', max: 'Max Throughput', map: 'Map', project: 'Project', power: 'Power Planner' };
    t.perPlan.forEach((p) => {
      const tr = el('tr');
      tr.appendChild(el('td', null, p.name));
      tr.appendChild(el('td', null, MODE_LABEL[p.mode] || p.mode));
      tr.appendChild(el('td', 'num', p.ok ? fmtPower(p.power) : '—'));
      tr.appendChild(el('td', 'num', p.ok ? fmt(p.machines, 0) : '—'));
      tr.appendChild(el('td', null, p.ok ? 'solved' : 'no output'));
      ptb.appendChild(tr);
    });
  }
  if ($('projNote')) {
    const linked = activeProjectPlans().reduce((a, pl) => a + planLinkRows(pl).length, 0);
    $('projNote').textContent = linked
      ? `${linked} linked input${linked === 1 ? '' : 's'} across this project — linked items are netted out of the raw totals above.`
      : 'Tip: link a plan input to another plan’s output (in the Optimizer’s extra-inputs or Max-supply rows) to chain factories.';
  }
  renderBaseBalance();
}

// ---------- whole-base balance + factory dependencies ----------
// Solve every plan in the project headlessly and roll their item flows into one ledger:
// how much of each item the whole base PRODUCES vs CONSUMES. A plan produces an item at
// its declared output rate (targets) plus any surplus by-product; it consumes every
// external input it pulls (its `raw` list). Resources (ore, water, oil…) are mined, so a
// negative net for them is expected; a negative net for a PART is a cross-factory
// shortfall (the base consumes more than it makes). Also returns per-plan produce/consume
// maps and the directed factory dependency edges (explicit links + auto-detected matches)
// the dependency graph draws.
function computeBaseBalance() {
  const rows = activeProjectPlans();
  const produced = {}, consumed = {};
  const perPlan = [];
  const idSet = new Set(rows.map((p) => p.id));
  for (const pl of rows) {
    const out = computeStateResult(pl.state);
    const info = { id: pl.id, name: pl.name, mode: pl.state.mode, feasible: out.feasible, produces: {}, consumes: {}, power: 0, machines: 0 };
    if (out.feasible) {
      const res = out.res, tg = out.targets || {};
      info.power = res.totalPower || 0;
      info.machines = res.totalMachines || 0;
      const addProd = (it, r) => { if (r > 1e-6) { info.produces[it] = (info.produces[it] || 0) + r; produced[it] = (produced[it] || 0) + r; } };
      const addCons = (it, r) => { if (r > 1e-6) { info.consumes[it] = (info.consumes[it] || 0) + r; consumed[it] = (consumed[it] || 0) + r; } };
      for (const it in tg) addProd(it, tg[it]);
      for (const s of res.surplus || []) addProd(s.item, s.rate);
      for (const r of res.raw || []) addCons(r.item, r.rate);
    }
    perPlan.push(info);
  }
  const planById = (id) => perPlan.find((p) => p.id === id);
  // Per-item ledger, split into parts (cross-factory balance) and mined resources.
  const parts = [], resources = [];
  const EPS = 1e-4;
  for (const it of new Set([...Object.keys(produced), ...Object.keys(consumed)])) {
    const p = produced[it] || 0, c = consumed[it] || 0;
    (RESOURCES.has(it) ? resources : parts).push({ item: it, produced: p, consumed: c, net: p - c });
  }
  const byName = (a, b) => itemName(a.item).localeCompare(itemName(b.item));
  parts.sort((a, b) => a.net - b.net || byName(a, b)); // worst shortfalls first
  resources.sort(byName);
  const shortfalls = parts.filter((r) => r.net < -EPS);
  const surpluses = parts.filter((r) => r.net > EPS);

  // ----- factory dependency edges -----
  // Explicit links (a consumer declares it pulls item X from plan Y) are authoritative.
  // A (source,item) is a BOTTLENECK when its explicit consumers' combined attributed
  // demand exceeds what the source makes, or when a consumer can't solve at all. Auto
  // edges fill in producer→consumer item matches with no explicit link (drawn dashed).
  const supplyOf = (id, it) => { const q = planById(id); return q ? (q.produces[it] || 0) : 0; };
  const explicit = [];
  for (const pl of rows) {
    const consumer = planById(pl.id);
    // Group this consumer's links by item: its consumption of an item is attributed
    // ACROSS its sources (split ∝ each source's supply), not counted in full against
    // every source — otherwise one consumer with two suppliers double-counts.
    const byItem = {};
    for (const r of planLinkRows(pl)) {
      if (!idSet.has(r.fromPlanId)) continue; // link points outside this project
      const arr = (byItem[r.fromItem] = byItem[r.fromItem] || []);
      if (!arr.some((q) => q.fromPlanId === r.fromPlanId)) arr.push(r); // dedup same src+item
    }
    for (const it in byItem) {
      const srcs = byItem[it];
      const totalCons = consumer ? (consumer.consumes[it] || 0) : 0;
      const supplies = srcs.map((r) => supplyOf(r.fromPlanId, it));
      const totSup = supplies.reduce((a, b) => a + b, 0);
      srcs.forEach((r, i) => {
        const share = srcs.length === 1 ? totalCons : totalCons * (totSup > 0 ? supplies[i] / totSup : 1 / srcs.length);
        explicit.push({ from: r.fromPlanId, to: pl.id, item: it, demand: share });
      });
    }
  }
  // Per (source,item): combined attributed demand and the set of distinct consumers.
  // resolveLinkedCap grants every linking consumer the source's FULL output (caps aren't
  // divided) — that over-promise is surfaced as a `shared` note on the edge, but a RED
  // bottleneck is only flagged when the combined demand actually exceeds the supply (so
  // the graph never contradicts the Part Balance table showing a surplus).
  const demandBySrcItem = {}, consumersBySrcItem = {};
  for (const e of explicit) {
    const k = e.from + '|' + e.item;
    demandBySrcItem[k] = (demandBySrcItem[k] || 0) + e.demand;
    (consumersBySrcItem[k] = consumersBySrcItem[k] || new Set()).add(e.to);
  }
  const depEdges = [];
  const covered = new Set();
  for (const e of explicit) {
    covered.add(e.from + '>' + e.to + '|' + e.item);
    const k = e.from + '|' + e.item;
    const supply = supplyOf(e.from, e.item);
    const dst = planById(e.to);
    const shared = (consumersBySrcItem[k] ? consumersBySrcItem[k].size : 1) >= 2;
    const over = (demandBySrcItem[k] || 0) > supply + EPS;
    const rate = Math.min(e.demand, supply); // an infeasible consumer draws nothing — never show the full supply flowing into a dead node
    depEdges.push({ from: e.from, to: e.to, item: e.item, rate, supply, demand: e.demand, kind: 'link', shared, bottleneck: over || (dst && !dst.feasible) });
  }
  for (const part of parts) {
    const it = part.item;
    const producers = perPlan.filter((p) => (p.produces[it] || 0) > EPS);
    const consumers = perPlan.filter((p) => (p.consumes[it] || 0) > EPS);
    for (const P of producers) for (const C of consumers) {
      if (P.id === C.id || covered.has(P.id + '>' + C.id + '|' + it)) continue;
      depEdges.push({ from: P.id, to: C.id, item: it, rate: Math.min(P.produces[it], C.consumes[it]), supply: P.produces[it], demand: C.consumes[it], kind: 'auto', bottleneck: false });
    }
  }
  return { parts, resources, shortfalls, surpluses, perPlan, depEdges, count: rows.length };
}

function renderBaseBalance() {
  const bal = computeBaseBalance();
  // Cross-factory shortfalls callout — the headline signal (a part the base under-makes).
  const sf = $('projShortfalls');
  if (sf) {
    sf.hidden = false;
    sf.innerHTML = '';
    sf.className = bal.shortfalls.length ? 'proj-shortfall' : 'proj-shortfall ok';
    if (bal.shortfalls.length) {
      sf.appendChild(el('div', 'proj-shortfall-title', `⚠ ${bal.shortfalls.length} cross-factory shortfall${bal.shortfalls.length === 1 ? '' : 's'}`));
      sf.appendChild(el('div', 'proj-shortfall-sub', 'These parts are consumed across the base faster than they’re produced. Add a factory (or raise output) to cover the gap, or link an existing producer.'));
      const list = el('div', 'proj-shortfall-list');
      bal.shortfalls.forEach((r) => {
        const chip = el('span', 'proj-shortfall-chip');
        chip.appendChild(itemCell(r.item));
        chip.appendChild(el('b', null, '−' + fmt(-r.net) + '/min'));
        list.appendChild(chip);
      });
      sf.appendChild(list);
    } else {
      sf.appendChild(el('div', 'proj-shortfall-title', '✓ No cross-factory shortfalls'));
      sf.appendChild(el('div', 'proj-shortfall-sub', 'Every part consumed across this project is produced by a factory in it (or is a mined raw resource).'));
    }
  }
  // Part balance table: every produced/consumed part, shortfalls first.
  const tb = $('projBalanceTable') && $('projBalanceTable').querySelector('tbody');
  if (tb) {
    tb.innerHTML = '';
    if (!bal.parts.length) {
      tb.innerHTML = '<tr><td colspan="5" style="color:var(--muted)">No intermediate parts yet — set targets in this project’s plans, or link a plan’s input to another plan’s output.</td></tr>';
    } else {
      bal.parts.forEach((r) => {
        const tr = el('tr');
        const td = el('td'); td.appendChild(itemCell(r.item)); tr.appendChild(td);
        tr.appendChild(el('td', 'num', fmt(r.produced)));
        tr.appendChild(el('td', 'num', fmt(r.consumed)));
        const net = el('td', 'num ' + (r.net < -1e-4 ? 'bal-short' : r.net > 1e-4 ? 'bal-surplus' : ''), (r.net > 1e-4 ? '+' : '') + fmt(r.net));
        tr.appendChild(net);
        const status = r.net < -1e-4 ? 'Shortfall' : r.net > 1e-4 ? 'Surplus' : 'Balanced';
        tr.appendChild(el('td', r.net < -1e-4 ? 'bal-short' : r.net > 1e-4 ? 'bal-surplus' : 'bal-even', status));
        tb.appendChild(tr);
      });
    }
  }
  renderDepGraph(bal);
}

// Factory-level dependency graph: one box per plan, laid out in columns by dependency
// depth (a consumer sits to the right of what feeds it). Explicit links draw solid, auto
// matches dashed, bottlenecks/shortfalls red. Static fit-to-width SVG (no zoom/drag) — the
// graph is small (a handful of factories), so a viewBox that scales to the panel suffices.
function renderDepGraph(bal) {
  const svg = $('depSvg');
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const nodes = bal.perPlan;
  const note = $('depNote');
  if (nodes.length < 2) {
    if (note) note.textContent = 'Add a second plan to this project (＋ New) to see how your factories feed each other.';
    svg.removeAttribute('viewBox');
    return;
  }
  // Dependency depth from explicit links only (auto edges don't force a column, so a
  // hint can't reshuffle the layout). Cycle-safe: a back-edge into a node still on the
  // current path is ignored (links are cycle-guarded, but stay defensive).
  const byId = {}; nodes.forEach((n) => { byId[n.id] = n; });
  const linkEdges = bal.depEdges.filter((e) => e.kind === 'link' && byId[e.from] && byId[e.to]);
  const incoming = {}; nodes.forEach((n) => { incoming[n.id] = []; });
  linkEdges.forEach((e) => incoming[e.to].push(e.from));
  const col = {}, mark = {};
  const depthOf = (id) => {
    if (mark[id] === 2) return col[id];
    if (mark[id] === 1) return 0;
    mark[id] = 1;
    let d = 0;
    for (const src of incoming[id]) if (byId[src]) d = Math.max(d, depthOf(src) + 1);
    mark[id] = 2;
    return (col[id] = d);
  };
  nodes.forEach((n) => depthOf(n.id));
  const cols = {};
  nodes.forEach((n) => (cols[col[n.id]] = cols[col[n.id]] || []).push(n));
  const NW = 168, NH = 50, COLW = 250, ROWH = 84, PADX = 20, PADY = 20;
  const maxRows = Math.max(1, ...Object.values(cols).map((a) => a.length));
  Object.keys(cols).map(Number).sort((a, b) => a - b).forEach((c) => {
    const off = ((maxRows - cols[c].length) / 2) * ROWH;
    cols[c].forEach((n, i) => { n._x = PADX + c * COLW; n._y = PADY + off + i * ROWH; });
  });
  const W = PADX + (Math.max(...Object.keys(cols).map(Number)) + 1) * COLW;
  const H = PADY + maxRows * ROWH;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  const mk = (tag) => document.createElementNS(SVGNS, tag);
  const gE = mk('g'), gN = mk('g');
  svg.appendChild(gE); svg.appendChild(gN);
  // Edges: from source's right edge to dest's left edge, curved. Stack multiple edges
  // between the same pair by nudging their attach points so labels don't overlap.
  const pairCount = {};
  bal.depEdges.filter((e) => byId[e.from] && byId[e.to]).forEach((e) => {
    const s = byId[e.from], d = byId[e.to];
    const key = e.from + '>' + e.to;
    const idx = (pairCount[key] = (pairCount[key] || 0) + 1) - 1;
    const nudge = (idx - 0) * 12;
    const sx = s._x + NW, sy = s._y + NH / 2 + nudge;
    const dx = d._x, dy = d._y + NH / 2 + nudge;
    const back = dx < sx; // consumer drawn left of source (rare) — bow the other way
    const ho = back ? -50 : 50;
    const path = mk('path');
    path.setAttribute('d', `M ${sx} ${sy} C ${sx + ho} ${sy} ${dx - ho} ${dy} ${dx} ${dy}`);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', e.bottleneck ? '#ff5b5b' : e.kind === 'auto' ? '#5b6675' : 'var(--accent)');
    path.setAttribute('stroke-width', e.bottleneck ? 2.4 : 1.6);
    if (e.kind === 'auto') path.setAttribute('stroke-dasharray', '5 4');
    path.setAttribute('marker-end', e.bottleneck ? 'url(#depArrowBad)' : e.kind === 'auto' ? 'url(#depArrowAuto)' : 'url(#depArrow)');
    const tip = mk('title');
    tip.textContent = `${itemName(e.item)} · ${fmt(e.rate)}/min${e.bottleneck ? ' · bottleneck (demand exceeds supply)' : ''}${!e.bottleneck && e.shared ? ' · shared source (each link is granted the full output)' : ''}${e.kind === 'auto' ? ' · not linked yet' : ''}`;
    path.appendChild(tip);
    gE.appendChild(path);
    // Label link edges (and any bottleneck) with item + rate; leave plain auto hints to the tooltip.
    if (e.kind === 'link' || e.bottleneck) {
      const t = mk('text');
      t.setAttribute('class', 'dep-edge-label');
      t.setAttribute('x', (sx + dx) / 2); t.setAttribute('y', (sy + dy) / 2 - 4);
      t.setAttribute('text-anchor', 'middle');
      t.textContent = `${itemName(e.item)} ${fmt(e.rate)}`;
      gE.appendChild(t);
    }
  });
  // Arrowhead markers (one per colour).
  const defs = mk('defs');
  [['depArrow', 'var(--accent)'], ['depArrowAuto', '#5b6675'], ['depArrowBad', '#ff5b5b']].forEach(([id, fill]) => {
    const m = mk('marker');
    m.setAttribute('id', id); m.setAttribute('viewBox', '0 0 10 10');
    m.setAttribute('refX', '9'); m.setAttribute('refY', '5');
    m.setAttribute('markerWidth', '7'); m.setAttribute('markerHeight', '7');
    m.setAttribute('orient', 'auto');
    const a = mk('path'); a.setAttribute('d', 'M0,0 L10,5 L0,10 z'); a.setAttribute('fill', fill);
    m.appendChild(a); defs.appendChild(m);
  });
  svg.insertBefore(defs, gE);
  // Nodes.
  nodes.forEach((n) => {
    const bottleneck = !n.feasible || bal.depEdges.some((e) => e.bottleneck && (e.from === n.id || e.to === n.id));
    const g = mk('g');
    g.setAttribute('transform', `translate(${n._x},${n._y})`);
    g.setAttribute('class', 'dep-node' + (bottleneck ? ' bad' : '') + (n.feasible ? '' : ' dead'));
    const rect = mk('rect');
    rect.setAttribute('width', NW); rect.setAttribute('height', NH); rect.setAttribute('rx', '7');
    g.appendChild(rect);
    const t1 = mk('text'); t1.setAttribute('class', 'dep-name'); t1.setAttribute('x', 10); t1.setAttribute('y', 19);
    t1.textContent = n.name.length > 22 ? n.name.slice(0, 21) + '…' : n.name;
    g.appendChild(t1);
    const t2 = mk('text'); t2.setAttribute('class', 'dep-sub'); t2.setAttribute('x', 10); t2.setAttribute('y', 37);
    t2.textContent = n.feasible ? `${fmtPower(n.power)} · ${fmt(n.machines, 0)} mach` : 'no output';
    g.appendChild(t2);
    gN.appendChild(g);
  });
  if (note) {
    const links = bal.depEdges.filter((e) => e.kind === 'link').length;
    const autos = bal.depEdges.filter((e) => e.kind === 'auto').length;
    const bott = bal.depEdges.filter((e) => e.bottleneck).length;
    note.textContent = `${links} linked feed${links === 1 ? '' : 's'}, ${autos} auto-detected match${autos === 1 ? '' : 'es'}${bott ? `, ${bott} bottleneck${bott === 1 ? '' : 's'}` : ''}. Hover an arrow for its item and rate.`;
  }
}
function startRename(tab, lab, p) {
  const inp = el('input', 'plan-rename');
  inp.value = p.name;
  tab.replaceChild(inp, lab);
  inp.focus(); inp.select();
  let done = false;
  const commit = () => { if (done) return; done = true; renamePlan(p.id, inp.value.trim() || p.name); };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') { done = true; renderPlanBar(); } });
  inp.addEventListener('blur', commit);
}
// Inline rename for a project. Electron's renderer has no working prompt() (it throws
// "prompt() is and will not be supported"), so we swap the project <select> for a text
// input in place — same UX as the plan-tab rename. The original <select> element is
// kept and restored before renameProject()/renderProjectBar() run, because
// renderProjectBar() bails when #projectSelect is missing and only refills its options.
function startProjectRename(proj) {
  const sel = $('projectSelect');
  if (!sel || !proj) return;
  const parent = sel.parentNode;
  const inp = el('input', 'plan-rename');
  inp.value = proj.name;
  inp.title = 'Enter to save · Esc to cancel';
  parent.replaceChild(inp, sel);
  inp.focus(); inp.select();
  let done = false;
  const restore = () => { if (inp.parentNode === parent) parent.replaceChild(sel, inp); };
  const commit = () => {
    if (done) return; done = true;
    const name = inp.value.trim();
    restore();
    if (name && name !== proj.name) renameProject(proj.id, name); else renderProjectBar();
  };
  const cancel = () => { if (done) return; done = true; restore(); renderProjectBar(); };
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') cancel(); });
  inp.addEventListener('blur', commit);
}

// ---------- wiring ----------
function syncSliderLabels() {
  $('clockOut').textContent = Math.round(state.clock * 100) + '%';
}
// Carry the primary desired output (item + rate) across the Planner target,
// the Optimizer's first output row, and the Max product. `except` is the mode
// being edited; its own control is left untouched so typing isn't disrupted.
// Canonical source = state.targetItem + state.targetRate.
function reflectPrimary(except) {
  const item = state.targetItem;
  const disp = item ? itemName(item) : '';
  state.max.product = item || '';
  const o0 = state.opt.outputs[0] || (state.opt.outputs[0] = { name: '', rate: 60 });
  o0.name = disp;
  o0.rate = state.targetRate;
  if (except !== 'planner') {
    if ($('targetItem')) $('targetItem').value = disp;
    if ($('targetRate')) $('targetRate').value = state.targetRate;
    if ($('rateUnit')) $('rateUnit').textContent = item && isFluid(item) ? 'm³ / min' : '/ min';
  }
  if (except !== 'max' && $('maxProduct')) $('maxProduct').value = disp;
  if (except !== 'optimize') buildOptOutputs();
}
// Push the active plan's state into every control, then render.
function applyStateToControls() {
  renderProjectBar();
  buildPlannerExtra();
  buildOptOutputs();
  buildOptInputs();
  buildOptExtraInputs();
  buildMaxSupply();
  buildPowerControls();
  buildGameSelect('mRecipe', GAME.recipe, state.recipeCost);
  buildGameSelect('mPower', GAME.power, state.powerMult);
  buildGameSelect('mSpace', GAME.space, state.spaceMult);
  renderSaveStatus();
  renderStdList();
  renderBldList();
  $('targetItem').value = state.targetItem ? itemName(state.targetItem) : '';
  $('targetRate').value = state.targetRate;
  $('targetDest').value = normDest(state.targetDest);
  $('clock').value = Math.round(state.clock * 100);
  $('cleanRatio').checked = !!state.cleanRatio;
  if ($('autoSave')) $('autoSave').checked = state.autoSave !== false;
  $('rateUnit').textContent = state.targetItem && isFluid(state.targetItem) ? 'm³ / min' : '/ min';
  syncSliderLabels();
  $('optObjective').value = state.opt.objective;
  $('optAlts').checked = state.opt.alts;
  $('optSink').checked = state.opt.sink !== false; // default on, incl. plans saved before this option existed
  $('optWaterSink').checked = !!state.opt.waterSink; // default off; opt-in per plan
  $('maxProduct').value = state.max.product ? itemName(state.max.product) : '';
  $('maxAlts').checked = state.max.alts;
  if ($('xrayWholeBase')) $('xrayWholeBase').checked = !!state.xrayWholeBase;
  if (mapDrawing) cancelAreaDraw(); // a plan switch mid-trace would write to the wrong plan
  setMode(state.mode);
}

// ---------- settings drawer + appearance ----------
function openSettings() {
  const d = $('settingsDrawer'), b = $('settingsBackdrop');
  if (!d || !b) return;
  buildThemeControls(); // reflect current prefs each open
  b.hidden = false; d.hidden = false;
}
function closeSettings() {
  const d = $('settingsDrawer'), b = $('settingsBackdrop');
  if (d) d.hidden = true;
  if (b) b.hidden = true;
}
// Build the Appearance section: preset dropdown + one colour input per themeable var.
function buildThemeControls() {
  const sel = $('themePreset');
  if (sel) {
    sel.innerHTML = '';
    for (const key in THEME_PRESETS) { const o = el('option', null, THEME_PRESETS[key].name); o.value = key; if (key === themePrefs.preset) o.selected = true; sel.appendChild(o); }
  }
  const box = $('themeColors');
  if (!box) return;
  box.innerHTML = '';
  for (const [v, label] of THEME_VARS) {
    const row = el('div', 'theme-row');
    row.appendChild(el('span', null, label));
    const inp = el('input'); inp.type = 'color';
    inp.value = toHex(themeVal(v));
    inp.title = v;
    inp.addEventListener('input', () => { (themePrefs.custom || (themePrefs.custom = {}))[v] = inp.value; applyTheme(); saveThemePrefs(); refreshThemedCanvases(); });
    row.appendChild(inp);
    box.appendChild(row);
  }
}
// <input type=color> only accepts #rrggbb. Coerce short/space-padded values; the
// theme values are all hex literals in practice, so the canvas-normalise fallback
// (for an exotic named/rgb() value) is only reached off the happy path.
function toHex(c) {
  c = (c || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(c)) return ('#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3]).toLowerCase();
  const rgb = /rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(c);
  if (rgb) return '#' + [1, 2, 3].map((i) => Number(rgb[i]).toString(16).padStart(2, '0')).join('');
  try {
    const cv = el('canvas'); if (!cv.getContext) return '#000000';
    const ctx = cv.getContext('2d'); if (!ctx) return '#000000';
    ctx.fillStyle = '#000'; ctx.fillStyle = c;
    const m = /^#([0-9a-f]{6})$/i.exec(ctx.fillStyle);
    if (m) return ('#' + m[1]).toLowerCase();
  } catch (_) {}
  return '#000000';
}
// Re-render canvas/SVG views that read theme colours via getComputedStyle rather
// than the CSS cascade (the resource map), so a colour change shows immediately.
function refreshThemedCanvases() { try { if (state.mode === 'map' && typeof drawMap === 'function') drawMap(); } catch (_) {} }
function init() {
  loadThemePrefs();
  applyTheme(); // paint the saved palette before first render so there's no flash
  load();
  buildItemList();
  buildSaveList();
  window.addEventListener('beforeunload', () => { save(); flushDiskSave(); }); // blocking flush — quit can't outrun the disk write

  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => setMode(t.dataset.mode)));
  wirePowerControls();
  $('viewTables').addEventListener('click', () => { state.view = 'tables'; save(); applyView(); });
  $('viewFlow').addEventListener('click', () => { state.view = 'flow'; save(); applyView(); });
  if ($('viewSankey')) $('viewSankey').addEventListener('click', () => { state.view = 'sankey'; save(); applyView(); });
  $('flowReset').addEventListener('click', () => { state.flowPos = {}; state.flowView = null; save(); renderFlowView(); });
  $('flowPowerToggle').addEventListener('click', () => { state.flowPower = !state.flowPower; save(); syncFlowPowerBtn(); solveAndRender(); });
  $('flowFit').addEventListener('click', () => { fitFlow(currentFlow); save(); });
  $('flowZoomIn').addEventListener('click', () => zoomFlowCenter(1.2));
  $('flowZoomOut').addEventListener('click', () => zoomFlowCenter(1 / 1.2));
  $('exportCsv').addEventListener('click', exportCsv);
  $('flowPng').addEventListener('click', exportFlowPng);

  const onTarget = (v) => { const c = nameToClass(v); state.targetItem = c; $('rateUnit').textContent = c && isFluid(c) ? 'm³ / min' : '/ min'; reflectPrimary('planner'); save(); solveAndRender(); };
  $('targetItem').addEventListener('change', (e) => onTarget(e.target.value));
  $('targetItem').addEventListener('input', (e) => { if (nameToClass(e.target.value)) onTarget(e.target.value); });
  $('targetRate').addEventListener('input', (e) => { state.targetRate = parseFloat(e.target.value) || 0; reflectPrimary('planner'); save(); solveAndRender(); });
  $('targetDest').addEventListener('change', (e) => { state.targetDest = e.target.value; save(); solveAndRender(); });
  $('plannerAddOutput').addEventListener('click', () => { (state.extraTargets || (state.extraTargets = [])).push({ name: '', rate: 60, dest: 'line' }); save(); buildPlannerExtra(); });
  $('clock').addEventListener('input', (e) => { state.clock = (parseFloat(e.target.value) || 100) / 100; syncSliderLabels(); save(); solveAndRender(); });
  $('cleanRatio').addEventListener('change', (e) => { state.cleanRatio = e.target.checked; save(); solveAndRender(); });

  $('mRecipe').addEventListener('change', (e) => { state.recipeCost = Number(e.target.value); save(); solveAndRender(); });
  $('mPower').addEventListener('change', (e) => { state.powerMult = Number(e.target.value); save(); solveAndRender(); });
  $('mSpace').addEventListener('change', (e) => { state.spaceMult = Number(e.target.value); save(); solveAndRender(); });

  $('saveLoad').addEventListener('click', loadFromSelectedSave);
  $('saveRefresh').addEventListener('click', buildSaveList);
  $('saveClear').addEventListener('click', clearUnlockedFilter);
  $('autoSave').addEventListener('change', (e) => { state.autoSave = e.target.checked; save(); });
  // Picking a save in either dropdown updates the other + is remembered.
  $('saveSelect').addEventListener('change', (e) => selectSaveFile(e.target.value));
  $('mapSaveSelect').addEventListener('change', (e) => selectSaveFile(e.target.value));
  $('altSearch').addEventListener('input', (e) => { altSearch = e.target.value; renderSaveStatus(); });
  $('altAllOn').addEventListener('click', () => setAllAlts(true));
  $('altAllOff').addEventListener('click', () => setAllAlts(false));
  // F1 standard-recipe veto + F4 building veto (shared across all three modes).
  $('stdSearch').addEventListener('input', (e) => { stdSearch = e.target.value; renderStdList(); });
  $('stdAllOn').addEventListener('click', () => setAllStd(true));
  $('stdAllOff').addEventListener('click', () => setAllStd(false));
  $('bldAllOn').addEventListener('click', () => setAllBld(true));
  $('bldAllOff').addEventListener('click', () => setAllBld(false));

  // resource map
  wireMap();
  $('mapLoad').addEventListener('click', loadMapFromSave);
  $('mapRefresh').addEventListener('click', buildSaveList);
  $('mapPng').addEventListener('click', exportMapPng);
  $('mapResetView').addEventListener('click', () => { fitMapView(); drawMap(); });
  $('mapAllRes').addEventListener('click', () => setAllMapRes(true));
  $('mapNoRes').addEventListener('click', () => setAllMapRes(false));
  $('mapShowGeyser').addEventListener('change', (e) => { mapKindOn.geyser = e.target.checked; scheduleMapDraw(); });
  $('mapShowFrack').addEventListener('change', (e) => { mapKindOn.frackingCore = e.target.checked; scheduleMapDraw(); });
  $('mapShowDeposit').addEventListener('change', (e) => { mapKindOn.deposit = e.target.checked; scheduleMapDraw(); });
  $('mapBuildShow').addEventListener('change', (e) => { mapBuildShow = e.target.checked; scheduleMapDraw(); });
  $('mapBuildOpacity').addEventListener('input', (e) => { mapBuildOpacity = (Number(e.target.value) || 0) / 100; scheduleMapDraw(); });
  $('mapColorMode').addEventListener('change', (e) => { mapColorMode = e.target.value; scheduleMapDraw(); });
  $('mapMarkClock').addEventListener('change', (e) => { mapMarkClock = e.target.checked; scheduleMapDraw(); });
  $('mapAllCat').addEventListener('click', () => setAllMapCat(true));
  $('mapNoCat').addEventListener('click', () => setAllMapCat(false));
  $('mapAllColl').addEventListener('click', () => setAllColl(true));
  $('mapNoColl').addEventListener('click', () => setAllColl(false));
  document.querySelectorAll('input[data-coll]').forEach((cb) => {
    cb.addEventListener('change', () => { mapCollOn[cb.dataset.coll] = cb.checked; scheduleMapDraw(); });
  });

  // base x-ray
  $('xrayLoad').addEventListener('click', loadXrayFromSave);
  $('xrayRefresh').addEventListener('click', buildSaveList);
  $('xraySaveSelect').addEventListener('change', (e) => selectSaveFile(e.target.value));
  $('xrayFilter').addEventListener('input', (e) => { xrayFilter = e.target.value; if (xrayData) renderXrayItems(); });
  $('xraySort').addEventListener('change', (e) => { xraySort = e.target.value; if (xrayData) renderXrayItems(); });
  $('xrayHideBalanced').addEventListener('change', (e) => { xrayHideBalanced = e.target.checked; if (xrayData) renderXrayItems(); });
  $('xrayRawOnly').addEventListener('change', (e) => { xrayRawOnly = e.target.checked; if (xrayData) renderXrayItems(); });
  $('xrayWholeBase').addEventListener('change', (e) => { state.xrayWholeBase = e.target.checked; save(); xrayData = null; setMode('xray'); });
  $('xrayDrawArea').addEventListener('click', () => { mapArmedForXray = true; setMode('map'); startAreaDraw(); });

  // factory-area drawing (on the map)
  $('areaDraw').addEventListener('click', () => { if (mapDrawing) finishAreaDraw(); else startAreaDraw(); });
  $('areaClear').addEventListener('click', clearArea);

  $('optAddOutput').addEventListener('click', () => { state.opt.outputs.push({ name: '', rate: 60 }); save(); buildOptOutputs(); });
  $('optObjective').addEventListener('change', (e) => { state.opt.objective = e.target.value; save(); solveAndRender(); });
  $('optAlts').addEventListener('change', (e) => { state.opt.alts = e.target.checked; save(); solveAndRender(); });
  $('optSink').addEventListener('change', (e) => { state.opt.sink = e.target.checked; save(); solveAndRender(); });
  $('optWaterSink').addEventListener('change', (e) => { state.opt.waterSink = e.target.checked; save(); solveAndRender(); });
  $('optAllInputs').addEventListener('click', () => { resList.forEach((r) => (state.opt.inputs[r.c].on = true)); save(); buildOptInputs(); solveAndRender(); });
  $('optNoInputs').addEventListener('click', () => { resList.forEach((r) => (state.opt.inputs[r.c].on = false)); save(); buildOptInputs(); solveAndRender(); });
  $('optAddInput').addEventListener('click', () => { (state.opt.extraInputs || (state.opt.extraInputs = [])).push({ name: '', cap: '' }); save(); buildOptExtraInputs(); });

  $('maxAddSupply').addEventListener('click', () => { state.max.supply.push({ item: resList[0].c, amount: 60 }); save(); buildMaxSupply(); });
  const onProduct = (v) => { const c = nameToClass(v); state.max.product = c; if (c) { state.targetItem = c; reflectPrimary('max'); } save(); solveAndRender(); };
  $('maxProduct').addEventListener('change', (e) => onProduct(e.target.value));
  $('maxProduct').addEventListener('input', (e) => { if (nameToClass(e.target.value)) onProduct(e.target.value); });
  $('maxAlts').addEventListener('change', (e) => { state.max.alts = e.target.checked; save(); solveAndRender(); });

  $('planNew').addEventListener('click', () => newPlan());
  $('planDup').addEventListener('click', () => duplicatePlan(activeId));

  // projects
  $('projectSelect').addEventListener('change', (e) => switchProject(e.target.value));
  $('projectNew').addEventListener('click', () => {
    // Create with an auto-name (no prompt() — it's unsupported in Electron's renderer and
    // throws, which is why this button used to do nothing). Rename via the ✎ button.
    newProject();
  });
  $('projectRename').addEventListener('click', () => {
    const proj = activeProject(); if (!proj) return;
    startProjectRename(proj);
  });
  $('projectDelete').addEventListener('click', () => deleteProject(activeProjectId));
  $('btnReset').addEventListener('click', () => { state.picks = {}; state.nodeClock = {}; state.nodeSloop = {}; save(); solveAndRender(); });
  $('btnClear').addEventListener('click', () => {
    // More destructive than "Reset recipes": wipes target, picks, extra outputs and
    // flow layout for this plan. Confirm first (game-save + cost globals are kept).
    if (typeof confirm === 'function' && !confirm('Clear this plan? Target, recipe choices, extra outputs and flowchart layout will be reset.')) return;
    const p = activePlan(); const g = pickGlobals(p.state); p.state = defaultState(); applyGlobals(p.state, g); state = p.state; save(); applyStateToControls();
  });

  // support modal
  const supportModal = $('supportModal');
  const closeSupport = () => { supportModal.hidden = true; };
  $('btnSupport').addEventListener('click', () => { supportModal.hidden = false; });
  $('supportClose').addEventListener('click', closeSupport);
  supportModal.addEventListener('click', (e) => { if (e.target === supportModal) closeSupport(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !supportModal.hidden) closeSupport(); });
  supportModal.querySelectorAll('[data-url]').forEach((el) =>
    el.addEventListener('click', () => { const u = SUPPORT_LINKS[el.dataset.url]; if (u) openExternal(u); closeSupport(); })
  );

  // settings drawer (appearance + machine tuning + cost multipliers)
  $('btnSettings').addEventListener('click', openSettings);
  $('settingsClose').addEventListener('click', closeSettings);
  $('settingsBackdrop').addEventListener('click', closeSettings);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('settingsDrawer').hidden) closeSettings(); });
  $('themePreset').addEventListener('change', (e) => {
    // Switching preset starts from a clean slate so the preset's palette is honoured.
    themePrefs.preset = e.target.value; themePrefs.custom = {};
    applyTheme(); saveThemePrefs(); buildThemeControls(); refreshThemedCanvases();
  });
  $('themeReset').addEventListener('click', () => {
    themePrefs = { preset: 'dark', custom: {} };
    applyTheme(); saveThemePrefs(); buildThemeControls(); refreshThemedCanvases();
  });

  renderProjectBar();
  renderPlanBar();
  // Seed every plan's recorded net outputs once on boot (headless solve) so links
  // resolve to live numbers immediately, even for plans the user hasn't opened yet.
  // Only the ACTIVE project's plans solve before first paint (their links are what
  // the user sees); other projects' plans defer to time-budgeted chunks so cold
  // start no longer scales with the whole base's plan count.
  for (const p of activeProjectPlans()) recomputePlanOutputs(p);
  const deferred = plans.filter((p) => p.projectId !== activeProjectId);
  if (deferred.length) setTimeout(function chunk() {
    const t0 = Date.now();
    while (deferred.length && Date.now() - t0 < 30) recomputePlanOutputs(deferred.shift());
    if (deferred.length) setTimeout(chunk, 16); else save();
  }, 0);
  applyStateToControls();
}

// Test/debug hook: expose live state + the project/link internals so the headless
// jsdom test harness can assert on migration, cycle detection and linked caps without
// a separate module system. Getters return the *current* module vars (which get
// reassigned by load()/switchProject()). No effect in the real app.
if (typeof window !== 'undefined') {
  window.__app = {
    get plans() { return plans; },
    get activeId() { return activeId; },
    get projects() { return projects; },
    get activeProjectId() { return activeProjectId; },
    get state() { return state; },
    activePlan, activeProject, activeProjectPlans, plansInProject,
    newProject, switchProject, deleteProject, newPlan,
    linkWouldCycle, resolveLinkedCap, planNetOutputs, recomputePlanOutputs,
    computeProjectTotals, computeBaseBalance, ensureProjects,
    setMode,
    // X-ray test surface: inject parsed records (no real save), set the plan's region /
    // whole-base scope, drive the draw lifecycle, and read live X-ray/draw state — so the
    // headless test exercises routing, region scoping and drawing without a canvas.
    xrayInjectRecords: (records, file) => { xrayRaw = records; xrayRawFile = file || 'test'; xrayRaw._saveName = 'test'; xrayRaw._savedAt = 0; xrayData = null; },
    xraySetRegion: (poly) => { state.xrayRegion = poly; save(); xrayData = null; },
    xraySetWholeBase: (b) => { state.xrayWholeBase = b; save(); xrayData = null; },
    xrayStartDraw: startAreaDraw,
    xrayPushWorldPoint: (x, y) => { mapDrawPts.push({ x, y }); },
    xrayFinishDraw: finishAreaDraw,
    xrayCancelDraw: cancelAreaDraw,
    getXray: () => ({ mode: state.mode, drawing: mapDrawing, drawPts: mapDrawPts.length, region: state.xrayRegion, wholeBase: state.xrayWholeBase, hasData: !!xrayData, armed: mapArmedForXray }),
  };
}
window.addEventListener('DOMContentLoaded', init);
