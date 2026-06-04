# Satisfactory Flow Calculator

Desktop production-flow planner for **Satisfactory** — like the online satisfactory calculator, plus
sliders for new game-mode recipe-cost options. Built with Electron, ships as a Windows `.exe`.

![panel](src/index.html)

## Factory plans (multiple calculators)

A **plan bar** above the mode tabs holds any number of independent factory plans — each its own
calculator + flowchart with its own mode, target/inputs, recipe picks, multipliers, and view. Like the
online tool's tabs.

- **＋ New** — start a blank plan. **⧉ Duplicate** — clone the active plan.
- Click a tab to switch; **double-click** the name to rename; **×** deletes (with confirm).
- Everything auto-saves to local storage and is restored on relaunch. Existing single-plan setups
  migrate automatically into "Factory 1".

## Three modes (tabs)

### Views (all modes)
- **Tables** — production steps, raw resources, building totals, by-products.
- **Flowchart** — node-graph like satisfactory-tools: gray raw → orange machine → green output, edges
  labeled with item + rate, layered left→right with wide spacing so the per-minute labels stay readable.
  **Drag nodes** to rearrange — positions are **saved per plan** (keyed by recipe, survive re-solve and
  relaunch). **Reset layout** restores the automatic placement.

### 1. Planner
- Pick a target item + output rate; expands the full recipe tree, aggregates shared intermediates,
  reports machine counts, raw-resource demand, building totals, and power.
- **Alternate recipe selection** — every produced item has a dropdown of all recipes that make it
  (standard + ★ alternates). Switch any node; re-solves instantly. **⛏ Raw input** treats an item as
  imported and stops expanding it.

### Cost Multiplier — exact Advanced Game Settings *(applies to all modes)*
Dropdowns matching the in-game **Advanced Game Settings → Cost Multiplier** values exactly:
- **Recipe Parts Cost Multiplier** — `0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2`. Scales every recipe's
  ingredient amounts; compounds up the chain (the game's "exceedingly high values" warning).
- **Power Consumption Multiplier** — `0.25, 0.5, 0.75, 1, 2, 5`. Scales all building power.
- **Space Elevator Deliverable Cost Multiplier** — `0.25, 0.5, 0.75, 1, 2, 5, 10, 25, 50, 100`. Scales
  the target rate only for space-elevator parts (Smart Plating, Versatile Framework, … Nuclear Pasta).

### Machine tuning (Planner)
- **Overclock** (1–250 %) — fewer machines, power scales by `clock^1.32` per machine (in-game curve).
- **Somersloop amplification** (1.0×–4.0×) — production amplification: output ×amp, power ×amp².

### 2. Recipe Optimizer  *(auto-pick best alternates)*
- Give it **desired outputs** (item + rate) and **allowed input resources** (tick which raws you can
  supply, optional per-resource caps), and it solves a linear program over **all 211 recipes** to choose
  the **best set of alternate recipes**.
- **Optimize for:** fewest raw resource units · lowest power · fewest machines.
- Toggle "consider alternate recipes" to compare against standard-only.
- Reports the chosen recipes (★ALT tagged), machines, raw draw, power. Infeasible combos are flagged.

### 3. Max Throughput  *(clean ratios / limiting factor)*
- Give it **available inputs** (resource + amount per min) and a **product to maximize**. It finds the
  maximum output that fully utilizes your inputs, and reports the **limiting factor** — the binding
  input(s) pinned at 100 % — with a utilization bar per input.
- Use it to answer "I have 120 iron ore + 40 coal — how much steel, and what runs out first?"

**Persistent** — every mode's inputs, picks, and slider positions are saved to local storage.
By-products / surplus are listed (not credited back).

## Optimizer / Max math

Both run a linear program (`javascript-lp-solver`): variables are machine counts `m_i ≥ 0`, each recipe
contributes `(produced − consumed) × 60/time × speed` per machine to its items' balance. Targets get a
`≥ rate` constraint, allowed inputs a `≥ −cap` (consumption bounded by supply), everything else `≥ 0`
(surplus ok, can't pull from nothing). Optimizer minimizes the chosen objective; Max Throughput
maximizes the product's net output. "Fewest raw resources" counts total raw **units/min** equally — it
will favor cheap-by-volume paths (e.g. oil/rubber) over ore when allowed, which is the true optimum for
that objective; switch to power/machines or restrict inputs for other trade-offs. LP modes compute at
100 % clock (the sliders apply to Planner).

## Data

Recipe/item/building data: **736 items, 291 automatable recipes (111 alternates), 11 production buildings**,
generated directly from the game's own database (`Satisfactory/CommunityResources/Docs/en-US.json`) into
`src/data.json` via `scripts/transform-docs.js`. This is the authoritative, version-matched source — it stays
in sync with the installed game, so there are no recipe gaps (fluid amounts are converted from mL; recipes are
filtered to those producible in a manufacturer). Power figures use each building's `mPowerConsumption` and
exponent; variable-power machines (Particle Accelerator, Converter, Quantum Encoder) use their mid-range draw.

To refresh data: `npm run data` (reads the Steam install path baked into `scripts/transform-docs.js`; pass a
path argument to point elsewhere). The older community-dataset pipeline (`data/raw.json` → `scripts/transform.js`)
remains available as `npm run data:legacy`.

## Run from source

```powershell
npm install
npm start
```

## Build the .exe

**Working method on this machine** — `@electron/packager` (no code-signing toolchain, no admin needed):

```powershell
npm run package
```

Produces a self-contained portable app folder:

```
C:\Users\tjjrj\build-out\SatisfactoryFlowCalculator-win32-x64\
    SatisfactoryFlowCalculator.exe   <- double-click to run
```

Zip that folder to distribute, or make a shortcut to the `.exe`. ~270 MB (bundled Chromium runtime —
normal for Electron).

### Why not electron-builder (installer)?

`npm run dist` builds an NSIS installer + single-file portable, but on this box it fails twice:

1. **`EBUSY`** — OneDrive locks the packaged `.exe` mid-write. Worked around by sending build output
   to `C:\Users\tjjrj\build-out\satisfactory-flow` (see `build.directories.output`).
2. **`winCodeSign` symlink error** — electron-builder extracts a signing toolset whose archive holds
   macOS symlinks; creating them needs the Windows *symbolic-link privilege*. Turn on **Settings →
   Privacy & security → For developers → Developer Mode** (or run the shell as admin), then
   `npm run dist` works and yields:
   - `Satisfactory Flow Calculator Setup <ver>.exe` — installer (desktop shortcut, pick install dir)
   - `SatisfactoryFlowCalculator-<ver>-x64.exe` — portable single-file exe

Until Developer Mode is on, use `npm run package`.

## Tests

```powershell
npm run test:ui   # drives the real renderer.js in jsdom, prints production/raw/power tables
```

## How the math works

For a chosen recipe making the target item with product amount `p` over `t` seconds in a building of
`speed` s:

```
output/min/machine = p * (60/t) * speed * clock * sloop
machines           = demand / (output/min/machine)
power/machine      = basePower * clock^exponent * sloop^2
ingredient demand  = demand * (ingredientAmount * costMult) / p     // per ingredient, recursive
```

Raw resources are items with no selected recipe (the 12 map resources, or anything set to **Raw input**).

## Limitations

- By-products are reported but not auto-consumed/credited.
- One global slider set applies to all machines (not per-node overclock yet).
- Recipe loops (e.g. some alternate plastic/rubber + recycled chains) are cut to avoid infinite
  expansion and flagged with a warning — break the loop by switching one alternate.
