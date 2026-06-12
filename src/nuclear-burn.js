'use strict';
// Inject the Nuclear Power Plant's burn steps into the shared game data as synthetic
// recipes, so one plan can hold the WHOLE nuclear loop — rods → reactors → waste →
// reprocessing → sink — with reactors as real machine steps. That makes the loop visible
// to everything recipes already flow through: the planner's recipe dropdowns, the
// optimizer (whose by-product balance then forces waste to be consumed — the no-
// permanent-waste plan emerges on its own), the clean-ratio ladder (plant counts join
// the whole-machine scaling), the flowchart and the Sankey bands.
//
// The "product" is a virtual MW item (1 unit = 1 MW of continuous output, NOT per
// minute). Each burn recipe runs one plant: fuel + cooling water in, MW + spent-fuel
// waste out (per the game Docs' mByproduct data, already extracted into powergen.waste).
//
// Two deliberate physics quirks, both load-bearing:
// - The plant's building entry has power 0 and the recipes carry `burner: true`.
//   Generation must NOT enter the LP's `_power` objective (a negative draw would make
//   "minimize power" unbounded — the solver would build reactors to pay for everything)
//   nor the plan's consumption ledger; the Power tab adds it back as generation instead.
// - `burner` recipes are exempt from the Recipe Parts Cost Multiplier (solver-side):
//   the game's part-cost setting scales CRAFTING costs, not how a generator burns fuel.
//
// Both the solver and the renderer require this module before scanning DATA.recipes;
// data.json is a CJS singleton per bundle, so the injection is visible everywhere.
const DATA = require('./data.json');

const MW_ITEM = 'Virtual_MW_C';
const NUKE_BUILDING = 'Build_GeneratorNuclear_C';

(function inject() {
  const G = DATA.powergen && DATA.powergen[NUKE_BUILDING];
  if (!G || DATA.items[MW_ITEM]) return; // no nuclear data / already injected
  DATA.items[MW_ITEM] = { className: MW_ITEM, name: 'Nuclear Power (MW)', slug: '', liquid: false, sinkPoints: 0, virtual: true };
  // shardSlots 0: generators take power shards (clock) but never Somersloops.
  if (!DATA.buildings[NUKE_BUILDING]) {
    DATA.buildings[NUKE_BUILDING] = { className: NUKE_BUILDING, name: G.name, power: 0, speed: 1, exponent: 1.321929, shardSlots: 0 };
  }
  for (const fuel in G.fuels) {
    const rc = 'Burn_' + fuel;
    if (DATA.recipes[rc]) continue;
    const burn = G.fuels[fuel]; // fuel units/min per plant at 100%
    const ingredients = [{ item: fuel, amount: burn }];
    if (G.supplemental) ingredients.push({ item: G.supplemental.item, amount: G.supplemental.rate });
    const products = [{ item: MW_ITEM, amount: G.power }];
    const wb = G.waste && G.waste[fuel];
    if (wb) products.push({ item: wb.item, amount: burn * wb.amount }); // waste/min per plant
    DATA.recipes[rc] = {
      className: rc,
      name: 'Burn ' + ((DATA.items[fuel] && DATA.items[fuel].name) || fuel),
      alternate: false,
      time: 60, // amounts above are per-minute rates; a 60 s cycle makes rate == amount
      building: NUKE_BUILDING,
      ingredients,
      products,
      burner: true,
    };
  }
})();

module.exports = { MW_ITEM, NUKE_BUILDING };
