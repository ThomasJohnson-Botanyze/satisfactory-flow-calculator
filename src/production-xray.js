'use strict';
// Whole-base / per-area production X-ray. Reads an ALREADY-PARSED Satisfactory save
// plus the static data tables (recipes / buildings / items / extractors / powergen) and
// computes what the built factory is configured to do:
//   - per-item production, consumption and net (surplus / deficit)
//   - total power draw, idle / under- / over-clocked / somerslooped machine counts
//   - best-effort raw extraction (so raw resources net correctly, not as deficits)
//   - generation capacity (powergen nameplate) and net power
//   - a spatial per-factory breakdown (machines clustered by proximity)
//
// Two-phase so the renderer can re-scope to a user-drawn map region WITHOUT re-parsing:
//   extractRecords(save, DATA) -> a flat array of compact per-actor records (the parse-
//     dependent pass; resolves extractor purity once). Returned to the page over the
//     preload bridge and cached there.
//   aggregate(records, DATA, {region, powerMult}) -> the render-ready summary. Pure and
//     cheap, so the page calls it on every plan switch / region edit. opts.region is a
//     polygon in WORLD centimetres ([{x,y},...]); when set, only actors inside it count.
//   computeProduction(save, DATA, opts) = aggregate(extractRecords(...), ...) — the
//     whole-base convenience used by the Node side and the unit tests.
//
// Pure & dependency-free by design: never reads files, never requires the parser or
// data.json — the caller passes the parsed save and the DATA object in. That keeps it
// unit-testable with tiny synthetic inputs and lets it be esbuild-bundled into the
// renderer (so the page can aggregate locally), exactly like the LP solver.
//
// IMPORTANT honesty note (surfaced in the UI): a .sav stores each machine's *nameplate
// configuration* (recipe + overclock + Somersloop), NOT live belt/pipe throughput. So
// "production" here is what every machine would make at 100% feed — a perfectly-fed
// factory. Real-world starvation (a manifold that can't keep up) is not in a static
// save and cannot be read from one. Every offline tool shares this limit.

// "/Game/.../Recipe_IronPlate.Recipe_IronPlate_C" -> "Recipe_IronPlate_C"
function classFromPath(p) {
  if (!p) return null;
  const s = String(p);
  const dot = s.lastIndexOf('.');
  return dot >= 0 ? s.slice(dot + 1) : s;
}

// Power-curve exponent shared by every machine/extractor when a building entry omits
// its own (matches data.json's per-building value).
const DEFAULT_EXPONENT = 1.321929;

// Recipe class a machine is set to, from its mCurrentRecipe ObjectProperty. null when
// the machine has no recipe selected (an idle, freshly-placed machine).
function recipeClassOf(props) {
  const v = props && props.mCurrentRecipe && props.mCurrentRecipe.value;
  return v ? classFromPath(v.pathName) : null;
}

// Read a FloatProperty's value (overclock, production boost), defaulting when absent.
function floatProp(props, key, dflt) {
  const p = props && props[key];
  return p && p.value != null ? p.value : dflt;
}

// Index every level object by its instanceName so an extractor's mExtractableResource
// reference can be resolved back to the resource-node actor it sits on.
function indexByInstance(save) {
  const idx = {};
  const levels = (save && save.levels) || {};
  for (const lvl in levels) {
    const objs = (levels[lvl] && levels[lvl].objects) || [];
    for (let i = 0; i < objs.length; i++) {
      const k = objs[i] && objs[i].instanceName;
      if (k) idx[k] = objs[i];
    }
  }
  return idx;
}

// Purity -> rate multiplier (Satisfactory: Impure 0.5x, Normal 1x, Pure 2x).
const PURITY_MULT = { RP_Pure: 2, RP_Normal: 1, RP_Inpure: 0.5 };

// Work out what an extractor mines and at what purity. Randomized-map saves write the
// resource + purity onto the node (mResourceClassOverride / mPurityOverride), so we get
// it exactly. Vanilla solid nodes store neither (it's static map data the save omits),
// so we fall back to the extractor's fixed resource (oil/water pumps know theirs) and
// assume Normal purity — flagged `estimated` so the UI can say so.
function extractorYield(o, extDef, instIdx) {
  const props = o.properties || {};
  const ref =
    props.mExtractableResource &&
    props.mExtractableResource.value &&
    props.mExtractableResource.value.pathName;
  // oil/water pumps know their resource up front; miners (and multi-resource wells, whose
  // `resource` is an array) depend on the node override, so start unknown for those.
  let resClass = typeof extDef.resource === 'string' ? extDef.resource : null;
  let purMult = 1;
  let purity = 'Normal';
  let estimated = true;
  const node = ref ? instIdx[ref] : null;
  if (node) {
    const np = node.properties || {};
    const po = np.mPurityOverride && np.mPurityOverride.value && np.mPurityOverride.value.value;
    const ro =
      np.mResourceClassOverride &&
      np.mResourceClassOverride.value &&
      np.mResourceClassOverride.value.pathName;
    if (ro) {
      resClass = classFromPath(ro);
      estimated = false;
    }
    if (po && PURITY_MULT[po] != null) {
      purMult = PURITY_MULT[po];
      purity = po.replace(/^RP_/, '');
      estimated = false;
    }
  }
  return { resClass, purMult, purity, estimated };
}

// ---------- phase 1: flat records (the only parse-dependent pass) ----------
// One linear sweep over the save. Emits a compact record per production machine,
// extractor and generator — enough for aggregate() to recompute rates/power from DATA
// without the parsed save. Kinds: 'm' machine, 'e' extractor, 'g' generator.
function extractRecords(save, DATA) {
  const BUILDINGS = (DATA && DATA.buildings) || {};
  const EXTRACTORS = (DATA && DATA.extractors) || {};
  const POWERGEN = (DATA && DATA.powergen) || {};
  const instIdx = indexByInstance(save);
  const records = [];
  const levels = (save && save.levels) || {};
  for (const lvl in levels) {
    const objs = (levels[lvl] && levels[lvl].objects) || [];
    for (let oi = 0; oi < objs.length; oi++) {
      const o = objs[oi];
      if (!o || typeof o.typePath !== 'string') continue;
      const cn = classFromPath(o.typePath);
      const props = o.properties || {};
      const tr = o.transform && o.transform.translation;
      const x = tr ? tr.x : 0, y = tr ? tr.y : 0;

      if (BUILDINGS[cn]) {
        const rawBoost = floatProp(props, 'mCurrentProductionBoost', 0);
        records.push({
          k: 'm',
          x, y,
          b: cn,
          rc: recipeClassOf(props), // null = idle
          clock: floatProp(props, 'mCurrentPotential', 1) || 1,
          amp: rawBoost >= 1 ? rawBoost : 1, // mCurrentProductionBoost stores the output multiplier (2 = doubled)
        });
      } else if (EXTRACTORS[cn]) {
        const y2 = extractorYield(o, EXTRACTORS[cn], instIdx);
        records.push({
          k: 'e',
          x, y,
          e: cn,
          clock: floatProp(props, 'mCurrentPotential', 1) || 1,
          res: y2.resClass,
          pur: y2.purMult,
          est: y2.estimated,
        });
      } else if (POWERGEN[cn]) {
        records.push({ k: 'g', x, y, g: cn, clock: floatProp(props, 'mCurrentPotential', 1) || 1 });
      }
    }
  }
  return records;
}

// ---------- point in polygon (region scoping) ----------
// Ray-casting test. poly = [{x,y},...] (world cm). Used to keep only the actors inside a
// user-drawn factory outline. A polygon with < 3 vertices is treated as "no region".
function pointInPolygon(x, y, poly) {
  if (!poly || poly.length < 3) return true;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// ---------- spatial clustering (per-factory breakdown) ----------
// Group machines into "factories" by proximity. A coarse grid + union-find on 8-
// connected non-empty cells: two machines in the same or touching cells join the same
// factory, so a base spread over many foundations stays one cluster while a distant
// outpost splits off. O(n) over machines, then near-O(cells) merges.
const CELL_CM = 8000; // 80 m — a few foundations; coarse enough to bridge aisles, fine enough to split outposts.

function clusterFactories(machines) {
  if (!machines.length) return [];
  const cellOf = (m) => Math.floor(m.x / CELL_CM) + ',' + Math.floor(m.y / CELL_CM);
  const cells = new Map();
  for (let i = 0; i < machines.length; i++) {
    const key = cellOf(machines[i]);
    let arr = cells.get(key);
    if (!arr) cells.set(key, (arr = []));
    arr.push(i);
  }
  const parent = new Map();
  const find = (k) => {
    while (parent.get(k) !== k) {
      parent.set(k, parent.get(parent.get(k)));
      k = parent.get(k);
    }
    return k;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const key of cells.keys()) parent.set(key, key);
  for (const key of cells.keys()) {
    const [cx, cy] = key.split(',').map(Number);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const nk = cx + dx + ',' + (cy + dy);
        if (cells.has(nk)) union(key, nk);
      }
    }
  }
  const groups = new Map();
  for (const [key, idxs] of cells) {
    const root = find(key);
    let g = groups.get(root);
    if (!g) groups.set(root, (g = []));
    for (const i of idxs) g.push(i);
  }
  const factories = [];
  let fid = 0;
  for (const idxs of groups.values()) {
    let power = 0, sx = 0, sy = 0, count = 0;
    const outNet = {};
    for (const i of idxs) {
      const m = machines[i];
      count++;
      power += m.power;
      sx += m.x;
      sy += m.y;
      for (const o of m.outputs) outNet[o.item] = (outNet[o.item] || 0) + o.rate;
    }
    const topOutputs = Object.keys(outNet)
      .map((item) => ({ item, rate: outNet[item] }))
      .sort((a, b) => b.rate - a.rate)
      .slice(0, 3);
    factories.push({ id: ++fid, count, power, cx: sx / count, cy: sy / count, topOutputs });
  }
  factories.sort((a, b) => b.power - a.power);
  return factories;
}

// ---------- phase 2: aggregate (pure, cheap, region-aware) ----------
// aggregate(records, DATA, opts) -> render-ready summary. opts.powerMult scales draw by
// the game's Power Consumption Multiplier (default 1). opts.region is a world-cm polygon
// ([{x,y},...]); when it has >= 3 points, only records inside it are counted.
function aggregate(records, DATA, opts) {
  opts = opts || {};
  const powerMult = opts.powerMult || 1;
  const region = opts.region && opts.region.length >= 3 ? opts.region : null;
  const inRegion = (r) => !region || pointInPolygon(r.x, r.y, region);
  const RECIPES = (DATA && DATA.recipes) || {};
  const BUILDINGS = (DATA && DATA.buildings) || {};
  const ITEMS = (DATA && DATA.items) || {};
  const EXTRACTORS = (DATA && DATA.extractors) || {};
  const POWERGEN = (DATA && DATA.powergen) || {};
  const RESOURCES = new Set((DATA && DATA.resources) || []);

  const items = {};
  const itemRec = (c) => {
    let it = items[c];
    if (!it)
      it = items[c] = {
        item: c,
        name: (ITEMS[c] && ITEMS[c].name) || c,
        liquid: !!(ITEMS[c] && ITEMS[c].liquid),
        raw: RESOURCES.has(c),
        produced: 0,
        consumed: 0,
        extraction: 0,
      };
    return it;
  };

  const buildingTotals = {};
  const extractionByItem = {};
  const generation = {};
  const prodMachines = [];

  let totalPower = 0,
    extractionPower = 0,
    generationCapacity = 0,
    totalMachines = 0,
    configured = 0,
    idle = 0,
    under = 0,
    over = 0,
    sloop = 0,
    sloopsInstalled = 0,
    extractorCount = 0,
    anyEstimatedExtraction = false;

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!inRegion(r)) continue;

    if (r.k === 'm') {
      const bdef = BUILDINGS[r.b];
      if (!bdef) continue;
      totalMachines++;
      const bt =
        buildingTotals[r.b] ||
        (buildingTotals[r.b] = { className: r.b, name: bdef.name, count: 0, idle: 0, power: 0 });
      bt.count++;
      const recipe = r.rc && RECIPES[r.rc];
      const clock = r.clock || 1;
      const amp = r.amp >= 1 ? r.amp : 1;
      if (!recipe) {
        idle++;
        bt.idle++;
        continue;
      }
      configured++;
      if (clock < 0.999) under++;
      else if (clock > 1.001) over++;
      const exp = bdef.exponent || DEFAULT_EXPONENT;
      const power = (bdef.power || 0) * Math.pow(clock, exp) * Math.pow(amp, 2) * powerMult;
      totalPower += power;
      bt.power += power;
      const per = 60 / (recipe.time || 1);
      const outputs = [];
      for (const pr of recipe.products || []) {
        const rate = pr.amount * per * clock * amp; // output scales with clock AND Somersloop
        itemRec(pr.item).produced += rate;
        outputs.push({ item: pr.item, rate });
      }
      for (const ig of recipe.ingredients || []) {
        const rate = ig.amount * per * clock; // input scales with clock only — Somersloop gives free output, not free input
        itemRec(ig.item).consumed += rate;
      }
      if (amp > 1) {
        sloop++;
        const max = bdef.shardSlots || 1; // amp = 1 + n/max -> physical sloops n = (amp-1)*max
        sloopsInstalled += Math.round((amp - 1) * max);
      }
      prodMachines.push({ x: r.x, y: r.y, power, outputs });
    } else if (r.k === 'e') {
      const edef = EXTRACTORS[r.e];
      if (!edef) continue;
      extractorCount++;
      const clock = r.clock || 1;
      const exp = edef.exponent || DEFAULT_EXPONENT;
      extractionPower += (edef.power || 0) * Math.pow(clock, exp) * powerMult;
      const rate = (edef.ratePerMin || 0) * clock * (r.pur || 1);
      // Power-only well actors (Resource Well Pressurizer, ratePerMin 0) draw power above
      // but extract nothing themselves — the satellites carry the rates. Skip the
      // extraction attribution AND the estimated caveat for them (no rate to estimate).
      if (!(rate > 0)) continue;
      if (r.est) anyEstimatedExtraction = true;
      if (r.res) {
        itemRec(r.res).extraction += rate;
        const e =
          extractionByItem[r.res] ||
          (extractionByItem[r.res] = {
            item: r.res,
            name: (ITEMS[r.res] && ITEMS[r.res].name) || r.res,
            rate: 0,
            count: 0,
            estimated: false,
          });
        e.rate += rate;
        e.count++;
        if (r.est) e.estimated = true;
      }
    } else if (r.k === 'g') {
      const gdef = POWERGEN[r.g];
      if (!gdef) continue;
      const out = (gdef.power || 0) * (r.clock || 1); // generators: output scales linearly with clock
      generationCapacity += out;
      const g =
        generation[r.g] || (generation[r.g] = { className: r.g, name: gdef.name, count: 0, power: 0 });
      g.count++;
      g.power += out;
    }
  }

  for (const c in items) items[c].produced += items[c].extraction;

  const itemList = Object.keys(items)
    .map((c) => {
      const it = items[c];
      return {
        item: it.item, name: it.name, liquid: it.liquid, raw: it.raw,
        produced: it.produced, consumed: it.consumed, extraction: it.extraction,
        net: it.produced - it.consumed,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const buildingList = Object.keys(buildingTotals)
    .map((c) => buildingTotals[c])
    .sort((a, b) => b.power - a.power);

  const factories = clusterFactories(prodMachines);

  return {
    stats: {
      totalMachines, configured, idle,
      underclocked: under, overclocked: over,
      somersloop: sloop, sloopsInstalled,
      totalPower, extractionPower, generationCapacity,
      netPower: generationCapacity - (totalPower + extractionPower),
      itemTypes: itemList.length, factoryCount: factories.length,
      extractorCount,
    },
    items: itemList,
    buildings: buildingList,
    extraction: Object.keys(extractionByItem).map((c) => extractionByItem[c]).sort((a, b) => b.rate - a.rate),
    generation: Object.keys(generation).map((c) => generation[c]).sort((a, b) => b.power - a.power),
    factories,
    scope: { regionUsed: !!region, machines: totalMachines },
    caveats: {
      estimatedExtraction: anyEstimatedExtraction,
      generatorFuel: Object.keys(generation).length > 0,
    },
  };
}

// Whole-base (or region-scoped) convenience: parse-pass + aggregate in one call.
function computeProduction(save, DATA, opts) {
  return aggregate(extractRecords(save, DATA), DATA, opts);
}

module.exports = {
  extractRecords,
  aggregate,
  computeProduction,
  pointInPolygon,
  clusterFactories,
  extractorYield,
  recipeClassOf,
  indexByInstance,
  classFromPath,
  CELL_CM,
  PURITY_MULT,
};
