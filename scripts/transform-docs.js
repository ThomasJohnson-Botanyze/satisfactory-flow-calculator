// Transform the game's own Docs JSON (CommunityResources/Docs/en-US.json) into
// the app's src/data.json. This is the authoritative, version-matched source —
// it closes recipe data gaps that the older community raw.json had.
//
// Usage: node scripts/transform-docs.js ["<path to en-US.json>"]
// Default path = Steam install on this machine.
const fs = require('fs');
const path = require('path');

const SRC = process.argv[2] ||
  'C:/Program Files (x86)/Steam/steamapps/common/Satisfactory/CommunityResources/Docs/en-US.json';

let text = fs.readFileSync(SRC).toString('utf16le'); // Docs ships UTF-16 LE
if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
const data = JSON.parse(text);

const groups = {};
for (const g of data) groups[(g.NativeClass || '').replace(/^.*\./, '').replace(/'$/, '')] = g.Classes || [];

// ---- items: every class whose ClassName starts with Desc_ (across all groups) ----
const items = {};
const isLiquid = {};
for (const gname in groups) {
  for (const c of groups[gname]) {
    const cn = c.ClassName || '';
    // item descriptors are Desc_*; a few (e.g. Portable Miner) use BP_ItemDescriptor*
    if (!(/^Desc_/.test(cn) || /^BP_ItemDescriptor/.test(cn)) || items[cn]) continue;
    const liquid = c.mForm === 'RF_LIQUID' || c.mForm === 'RF_GAS';
    isLiquid[cn] = liquid;
    items[cn] = { className: cn, name: c.mDisplayName || cn, slug: '', liquid, sinkPoints: Number(c.mResourceSinkPoints) || 0 };
  }
}

// ---- buildings: production machines (fixed + variable-power manufacturers) ----
const buildings = {};
const MANU = new Set();
for (const gname in groups) {
  if (!/Manufacturer/.test(gname)) continue; // FGBuildableManufacturer (+ VariablePower)
  for (const c of groups[gname]) {
    const cn = c.ClassName || '';
    let power = Number(c.mPowerConsumption) || 0;
    if (!power) {
      // variable-power machines (Particle Accelerator, Quantum Encoder, Converter):
      // use the midpoint of their advertised variable range as a representative draw.
      const lo = Number(c.mEstimatedMininumPowerConsumption) || 0;
      const hi = Number(c.mEstimatedMaximumPowerConsumption) || 0;
      power = hi ? (lo + hi) / 2 : 0;
    }
    buildings[cn] = {
      className: cn, name: c.mDisplayName || cn,
      power, exponent: Number(c.mPowerConsumptionExponent) || 1.321929, speed: 1,
    };
    MANU.add(cn);
  }
}

// ---- recipes: only those produced in a manufacturer machine ----
const stackRe = /ItemClass="[^"]*?\.([A-Za-z0-9_]+_C)'?",Amount=([\d.]+)/g;
function parseStacks(s) {
  const out = [];
  let m;
  stackRe.lastIndex = 0;
  while ((m = stackRe.exec(s || ''))) {
    const item = m[1];
    let amount = Number(m[2]);
    if (isLiquid[item]) amount /= 1000; // Docs stores fluids in mL
    out.push({ item, amount });
  }
  return out;
}
function manufacturerOf(producedIn) {
  const builds = (producedIn || '').match(/Build_[A-Za-z0-9_]+_C/g) || [];
  return builds.find((b) => MANU.has(b)) || null;
}

const recipes = {};
for (const c of groups.FGRecipe || []) {
  const cn = c.ClassName || '';
  const building = manufacturerOf(c.mProducedIn);
  if (!building) continue; // hand-craft / build-gun / building recipe → skip
  const products = parseStacks(c.mProduct);
  const ingredients = parseStacks(c.mIngredients);
  if (!products.length) continue;
  recipes[cn] = {
    className: cn,
    name: c.mDisplayName || cn,
    alternate: /_Alternate_/.test(cn) || /^Alternate:/.test(c.mDisplayName || ''),
    time: Number(c.mManufactoringDuration) || 1,
    building,
    ingredients,
    products,
  };
}

const resources = (groups.FGResourceDescriptor || []).map((c) => c.ClassName);

const out = { items, buildings, recipes, resources };
const outPath = path.join(__dirname, '..', 'src', 'data.json');
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`Wrote ${outPath}`);
console.log(`  items ${Object.keys(items).length}, buildings ${Object.keys(buildings).length}, recipes ${Object.keys(recipes).length} (${Object.values(recipes).filter(r=>r.alternate).length} alt), resources ${resources.length}`);
