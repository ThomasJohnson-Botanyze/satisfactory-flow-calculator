'use strict';
// Whole-base production X-ray. Reads an ALREADY-PARSED Satisfactory save plus the
// static data tables (recipes / buildings / items / extractors / powergen) and
// computes what the built factory is configured to do:
//   - per-item production, consumption and net (surplus / deficit)
//   - total power draw, idle / under- / over-clocked / somerslooped machine counts
//   - best-effort raw extraction (so raw resources net correctly, not as deficits)
//   - generation capacity (powergen nameplate) and net power
//   - a spatial per-factory breakdown (machines clustered by proximity)
//
// Pure & dependency-free by design: never reads files, never requires the parser or
// data.json — the caller passes the parsed save and the DATA object in. That keeps it
// unit-testable with tiny synthetic inputs and no node_modules present, exactly like
// the sibling factory-extract.js.
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

// ---------- spatial clustering (per-factory breakdown) ----------
// Group machines into "factories" by proximity. A coarse grid + union-find on 8-
// connected non-empty cells: two machines in the same or touching cells join the same
// factory, so a base spread over many foundations stays one cluster while a distant
// outpost splits off. O(n) over machines, then near-O(cells) merges.
const CELL_CM = 8000; // 80 m — a few foundations; coarse enough to bridge aisles, fine enough to split outposts.

function clusterFactories(machines) {
  if (!machines.length) return [];
  const cellOf = (m) => Math.floor(m.x / CELL_CM) + ',' + Math.floor(m.y / CELL_CM);
  // Bucket machine indices by cell.
  const cells = new Map();
  for (let i = 0; i < machines.length; i++) {
    const key = cellOf(machines[i]);
    let arr = cells.get(key);
    if (!arr) cells.set(key, (arr = []));
    arr.push(i);
  }
  // Union-find over cell keys.
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
  // Gather machine indices per connected component.
  const groups = new Map();
  for (const [key, idxs] of cells) {
    const root = find(key);
    let g = groups.get(root);
    if (!g) groups.set(root, (g = []));
    for (const i of idxs) g.push(i);
  }
  // Summarize each factory: count, power, centroid, top outputs by net /min.
  const factories = [];
  let fid = 0;
  for (const idxs of groups.values()) {
    let power = 0, sx = 0, sy = 0, count = 0;
    const outNet = {}; // item -> produced /min inside this cluster
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
    factories.push({
      id: ++fid,
      count,
      power,
      cx: sx / count,
      cy: sy / count,
      topOutputs,
    });
  }
  factories.sort((a, b) => b.power - a.power);
  return factories;
}

// ---------- main aggregation ----------
// computeProduction(save, DATA, opts) -> compact, render-ready summary (see README of
// fields at the return). opts.powerMult scales draw by the game's Power Consumption
// Multiplier (default 1 = nameplate). opts.includeIdleFactories keeps idle-only
// machines out of factory clustering by default (they make nothing).
function computeProduction(save, DATA, opts) {
  opts = opts || {};
  const powerMult = opts.powerMult || 1;
  const RECIPES = (DATA && DATA.recipes) || {};
  const BUILDINGS = (DATA && DATA.buildings) || {};
  const ITEMS = (DATA && DATA.items) || {};
  const EXTRACTORS = (DATA && DATA.extractors) || {};
  const POWERGEN = (DATA && DATA.powergen) || {};
  const RESOURCES = new Set((DATA && DATA.resources) || []);
  const instIdx = indexByInstance(save);

  // item class -> running tallies. Created lazily so we only list items the base touches.
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

  const buildingTotals = {}; // class -> {className,name,count,idle,power}
  const extractionByItem = {}; // class -> {item,name,rate,count,estimated}
  const generation = {}; // class -> {className,name,count,power}
  const prodMachines = []; // configured manufacturing machines (for clustering)

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
    anyEstimatedExtraction = false;

  const levels = (save && save.levels) || {};
  for (const lvl in levels) {
    const objs = (levels[lvl] && levels[lvl].objects) || [];
    for (let oi = 0; oi < objs.length; oi++) {
      const o = objs[oi];
      if (!o || typeof o.typePath !== 'string') continue;
      const cn = classFromPath(o.typePath);
      const props = o.properties || {};
      const tr = o.transform && o.transform.translation;

      // ----- manufacturing machine -----
      const bdef = BUILDINGS[cn];
      if (bdef) {
        totalMachines++;
        const bt =
          buildingTotals[cn] ||
          (buildingTotals[cn] = { className: cn, name: bdef.name, count: 0, idle: 0, power: 0 });
        bt.count++;
        const rc = recipeClassOf(props);
        const r = rc && RECIPES[rc];
        const clock = floatProp(props, 'mCurrentPotential', 1) || 1;
        const rawBoost = floatProp(props, 'mCurrentProductionBoost', 0);
        const amp = rawBoost >= 1 ? rawBoost : 1; // mCurrentProductionBoost stores the output multiplier (2 = doubled)
        if (!r) {
          idle++;
          bt.idle++;
          continue; // no recipe -> produces/consumes nothing
        }
        configured++;
        if (clock < 0.999) under++;
        else if (clock > 1.001) over++;
        const exp = bdef.exponent || DEFAULT_EXPONENT;
        // Power: base x clock^exp x amp^2 (Somersloop amplification roughly squares draw).
        const power = (bdef.power || 0) * Math.pow(clock, exp) * Math.pow(amp, 2) * powerMult;
        totalPower += power;
        bt.power += power;
        const per = 60 / (r.time || 1);
        const outputs = [];
        for (const pr of r.products || []) {
          // Output scales with overclock AND Somersloop amplification.
          const rate = pr.amount * per * clock * amp;
          itemRec(pr.item).produced += rate;
          outputs.push({ item: pr.item, rate });
        }
        for (const ig of r.ingredients || []) {
          // Input scales with overclock only — Somersloop gives free output, not free input.
          const rate = ig.amount * per * clock;
          itemRec(ig.item).consumed += rate;
        }
        if (amp > 1) {
          sloop++;
          const max = bdef.shardSlots || 1; // amp = 1 + n/max  ->  physical sloops n = (amp-1)*max
          sloopsInstalled += Math.round((amp - 1) * max);
        }
        prodMachines.push({ x: tr ? tr.x : 0, y: tr ? tr.y : 0, power, outputs });
        continue;
      }

      // ----- extractor (miner / pump) -> raw production (best effort) -----
      const edef = EXTRACTORS[cn];
      if (edef) {
        const clock = floatProp(props, 'mCurrentPotential', 1) || 1;
        const exp = edef.exponent || DEFAULT_EXPONENT;
        const power = (edef.power || 0) * Math.pow(clock, exp) * powerMult;
        extractionPower += power;
        const y = extractorYield(o, edef, instIdx);
        const rate = (edef.ratePerMin || 0) * clock * y.purMult;
        if (y.estimated) anyEstimatedExtraction = true;
        if (y.resClass) {
          itemRec(y.resClass).extraction += rate;
          const e =
            extractionByItem[y.resClass] ||
            (extractionByItem[y.resClass] = {
              item: y.resClass,
              name: (ITEMS[y.resClass] && ITEMS[y.resClass].name) || y.resClass,
              rate: 0,
              count: 0,
              estimated: false,
            });
          e.rate += rate;
          e.count++;
          if (y.estimated) e.estimated = true;
        }
        continue;
      }

      // ----- power generator -> generation capacity (nameplate) -----
      const gdef = POWERGEN[cn];
      if (gdef) {
        const clock = floatProp(props, 'mCurrentPotential', 1) || 1;
        const out = (gdef.power || 0) * clock; // generators: output scales linearly with clock
        generationCapacity += out;
        const g =
          generation[cn] ||
          (generation[cn] = { className: cn, name: gdef.name, count: 0, power: 0 });
        g.count++;
        g.power += out;
      }
    }
  }

  // Roll up raw extraction into each item's produced total so raws net correctly.
  for (const c in items) items[c].produced += items[c].extraction;

  const itemList = Object.keys(items)
    .map((c) => {
      const it = items[c];
      return {
        item: it.item,
        name: it.name,
        liquid: it.liquid,
        raw: it.raw,
        produced: it.produced,
        consumed: it.consumed,
        extraction: it.extraction,
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
      totalMachines, // every manufacturing building (incl. idle)
      configured, // machines with a recipe set
      idle, // machines with no recipe
      underclocked: under,
      overclocked: over,
      somersloop: sloop, // machines with >=1 Somersloop
      sloopsInstalled, // physical Somersloops across those machines
      totalPower, // manufacturing draw (MW, at powerMult)
      extractionPower, // miner/pump draw (MW)
      generationCapacity, // generator nameplate output (MW)
      netPower: generationCapacity - (totalPower + extractionPower),
      itemTypes: itemList.length,
      factoryCount: factories.length,
    },
    items: itemList,
    buildings: buildingList,
    extraction: Object.keys(extractionByItem)
      .map((c) => extractionByItem[c])
      .sort((a, b) => b.rate - a.rate),
    generation: Object.keys(generation)
      .map((c) => generation[c])
      .sort((a, b) => b.power - a.power),
    factories,
    caveats: {
      estimatedExtraction: anyEstimatedExtraction, // some extractor purity/resource was assumed (vanilla nodes)
      generatorFuel: Object.keys(generation).length > 0, // generator fuel burn is NOT netted into item consumption
    },
  };
}

module.exports = {
  computeProduction,
  clusterFactories,
  extractorYield,
  recipeClassOf,
  indexByInstance,
  classFromPath,
  CELL_CM,
  PURITY_MULT,
};
