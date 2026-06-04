// Transform raw community dataset -> clean app data.json
const fs = require('fs');
const path = require('path');

const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'raw.json'), 'utf8'));

const items = {};
for (const k in raw.items) {
  const it = raw.items[k];
  items[k] = {
    className: k,
    name: it.name,
    slug: it.slug,
    liquid: !!it.liquid,
    sinkPoints: it.sinkPoints || 0,
  };
}

const buildings = {};
for (const k in raw.buildings) {
  const b = raw.buildings[k];
  const m = b.metadata || {};
  buildings[k] = {
    className: k,
    name: b.name,
    power: m.powerConsumption || 0,
    exponent: m.powerConsumptionExponent || 1.321929,
    speed: m.manufacturingSpeed || 1,
  };
}

// Keep only automatable in-machine production recipes.
const recipes = {};
for (const k in raw.recipes) {
  const r = raw.recipes[k];
  if (!r.inMachine || r.forBuilding) continue;
  if (!r.producedIn || !r.producedIn.length) continue;
  const building = r.producedIn.find((b) => buildings[b]) || r.producedIn[0];
  recipes[k] = {
    className: k,
    name: r.name,
    alternate: !!r.alternate,
    time: r.time,
    building,
    ingredients: r.ingredients.map((i) => ({ item: i.item, amount: i.amount })),
    products: r.products.map((p) => ({ item: p.item, amount: p.amount })),
  };
}

const resources = Object.keys(raw.resources);

const out = { items, buildings, recipes, resources };
const outPath = path.join(__dirname, '..', 'src', 'data.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out));
console.log(
  `Wrote ${outPath}: ${Object.keys(items).length} items, ${Object.keys(recipes).length} recipes, ${Object.keys(buildings).length} buildings, ${resources.length} resources`
);
