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
      // Somersloop slots: 1 (Constructor/Smelter), 2 (Assembler/Foundry/Refinery/
      // Packager), 4 (Manufacturer/Blender/Particle Accel/Converter/Quantum Encoder).
      // Each installed shard adds 1/slots of output (full slots = 2×).
      shardSlots: Number(c.mProductionShardSlotSize) || 1,
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

// ---- generators: the Fuel-Powered Generator, for by-product disposal -----------
// It burns the liquid/gas fuels (Fuel, Turbofuel, Liquid Biofuel, Rocket Fuel,
// Ionized Fuel) that would otherwise dead-end and back up the pipes. Solid-fuel
// burners (Coal, Biomass) are omitted: their fuels are solids the Awesome Sink
// already disposes, and biomass is never a factory by-product. Burn rate
// (units/min @100%) = 60·MW / E, where E is the fuel's energy; the Docs store fluid
// energy per mL, so the app's m³ unit multiplies that back up (E·1000 for fluids).
const energyOf = {};
for (const gname in groups) {
  for (const c of groups[gname]) {
    const cn = c.ClassName || '';
    if (/^Desc_/.test(cn) && c.mEnergyValue !== undefined && energyOf[cn] === undefined) {
      const e = Number(c.mEnergyValue) || 0;
      energyOf[cn] = isLiquid[cn] ? e * 1000 : e; // fluids: per-mL -> per-m³
    }
  }
}
const generators = {};
for (const c of groups.FGBuildableGeneratorFuel || []) {
  if (c.ClassName !== 'Build_GeneratorFuel_C') continue; // liquid/gas fuels only
  const power = Number(c.mPowerProduction) || 0;
  const fuelClasses = (c.mDefaultFuelClasses || '').match(/Desc_[A-Za-z0-9_]+_C/g) || [];
  const fuels = {};
  for (const f of fuelClasses) {
    if (!isLiquid[f]) continue; // any solid fuel goes to the sink, not a generator
    const e = energyOf[f];
    if (e > 0) fuels[f] = (60 * power) / e; // units/min consumed at 100 % clock
  }
  generators[c.ClassName] = { className: c.ClassName, name: c.mDisplayName || c.ClassName, power, fuels };
}

// ---- powergen: full generator set for the POWER PLANNER (coal, fuel, biomass,
// nuclear), incl. solid fuels + supplemental water. Kept SEPARATE from `generators`
// above (which the by-product sink uses, liquid-only) so adding solid-fuel burners
// here can't change the optimizer's disposal routing. Geothermal is omitted: its
// output is location-variable (no fuel), not plannable as a fixed rate.
//   burn rate (units/min @100%) = 60·power / E      (E from energyOf; fluids per-m³)
//   supplemental water (m³/min)  = power · ratio · 60 / 1000   (coal 45, nuclear 240)
const SUPP_ITEM = 'Desc_Water_C'; // every supplemental-requiring generator uses water
function fuelRates(power, c) {
  const fuelClasses = (c.mDefaultFuelClasses || '').match(/Desc_[A-Za-z0-9_]+_C/g) || [];
  const fuels = {};
  for (const f of fuelClasses) {
    const e = energyOf[f];
    if (e > 0) fuels[f] = (60 * power) / e; // includes solids now (coal/coke/biomass)
  }
  return fuels;
}
const powergen = {};
for (const gname of ['FGBuildableGeneratorFuel', 'FGBuildableGeneratorNuclear']) {
  for (const c of groups[gname] || []) {
    const cn = c.ClassName || '';
    const power = Number(c.mPowerProduction) || 0;
    if (!power) continue;
    const reqSupp = String(c.mRequiresSupplementalResource) === 'True';
    const ratio = Number(c.mSupplementalToPowerRatio) || 0;
    // Burn by-products (nuclear waste): the generator's mFuel array names, per fuel, the
    // spent item and how many units each fuel unit leaves behind (Uranium Fuel Rod -> 50
    // Uranium Waste, Plutonium Fuel Rod -> 10 Plutonium Waste, Ficsonium -> none). Stored
    // per fuel UNIT, so waste/min at plan time = fuel burn rate × amount (clock-invariant).
    const waste = {};
    for (const f of (Array.isArray(c.mFuel) ? c.mFuel : [])) {
      const amt = Number(f.mByproductAmount) || 0;
      if (f.mFuelClass && f.mByproduct && amt > 0) waste[f.mFuelClass] = { item: f.mByproduct, amount: amt };
    }
    powergen[cn] = {
      className: cn, name: c.mDisplayName || cn, power,
      fuels: fuelRates(power, c),
      supplemental: (reqSupp && ratio) ? { item: SUPP_ITEM, rate: (power * ratio * 60) / 1000 } : null,
      waste: Object.keys(waste).length ? waste : null,
    };
  }
}

// ---- extractors: for the POWER PLANNER's "from a node" sizing (miners, water/oil
// pumps, resource-well satellite). rate = items/cycle ÷ cycle-time × 60 at NORMAL
// purity & 100% clock; fluids are stored in mL so /1000 -> m³. Purity tiers
// (impure ×0.5 / normal ×1 / pure ×2) apply at plan time to all but the Water
// Extractor (water sources have no purity). Power scales by clock^exponent.
function formOf(s) {
  if (/RF_SOLID/.test(s)) return 'solid';
  if (/RF_LIQUID/.test(s)) return 'liquid';
  if (/RF_GAS/.test(s)) return 'gas';
  return 'solid';
}
// FGBuildableFrackingActivator is the Resource Well Pressurizer (Build_FrackingSmasher_C):
// the actor that POWERS a well (150 MW nominal). It extracts nothing itself — the
// satellites (FGBuildableFrackingExtractor, power 0) carry the extraction rates — so its
// entry comes out with ratePerMin 0 and exists purely so power accounting can see it.
const extractors = {};
for (const gname of ['FGBuildableResourceExtractor', 'FGBuildableWaterPump', 'FGBuildableFrackingExtractor', 'FGBuildableFrackingActivator']) {
  for (const c of groups[gname] || []) {
    const cn = c.ClassName || '';
    const cycle = Number(c.mExtractCycleTime) || 1;
    const per = Number(c.mItemsPerCycle) || 0;
    const form = formOf(c.mAllowedResourceForms || '');
    let rate = (per / cycle) * 60;
    if (form !== 'solid') rate /= 1000; // fluids: mL -> m³
    const allowed = (c.mAllowedResources || '').match(/Desc_[A-Za-z0-9_]+_C/g) || [];
    extractors[cn] = {
      className: cn, name: c.mDisplayName || cn,
      power: Number(c.mPowerConsumption) || 0,
      exponent: Number(c.mPowerConsumptionExponent) || 1.321929,
      form, ratePerMin: rate,
      purity: cn !== 'Build_WaterPump_C', // water nodes have no purity
      resource: allowed.length === 1 ? allowed[0] : (allowed.length ? allowed : null),
    };
  }
}

const out = { items, buildings, recipes, resources, generators, powergen, extractors };
const outPath = path.join(__dirname, '..', 'src', 'data.json');
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(`Wrote ${outPath}`);
console.log(`  items ${Object.keys(items).length}, buildings ${Object.keys(buildings).length}, recipes ${Object.keys(recipes).length} (${Object.values(recipes).filter(r=>r.alternate).length} alt), resources ${resources.length}, generators ${Object.keys(generators).length}, powergen ${Object.keys(powergen).length}, extractors ${Object.keys(extractors).length}`);
