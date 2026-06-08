# Improvement Backlog

Full-codebase audit of the Satisfactory Flow Calculator (Electron + vanilla JS).
Each item is self-contained and actionable: file references, what's wrong, the fix,
and an acceptance check. Built to be worked one-at-a-time in an improvement loop.

## How to use this in a loop
1. Pick the highest-priority unchecked item.
2. Make the change on a branch/worktree (see memory: git shipping workflow).
3. Run `npm run test:ui` (and any new tests). Verify the item's **Acceptance**.
4. Check the box, commit, move on.

## Severity legend
- 🔴 **High** — wrong/misleading output, security, or breaks a common workflow.
- 🟠 **Medium** — real defect or notable gap; not everyone hits it.
- 🟡 **Low** — polish, edge case, minor perf, tech debt.

## Status — improvement loop, round 1 (merged to main)
Done (13): S1, B1, B2, B3, B4, B5, P1, U1, U5, U6, U7, T1, T2.

## Status — improvement loop, round 2 (branch `claude/backlog-round-2`)
Done (6): U2, U3, U4, U8, U9, **S2 (full + partial)**. `npm test` green
(42 unit + 52 UI + 6 bundle-smoke = 100 checks).
- **U2** save pickers synced.
- **U3** selected save remembered (`saveFile` global) + map auto-loads on first open.
- **U4** intermediates allowed as Optimizer/Max inputs (new `inputList` + `opt.extraInputs`).
- **U8** edge labels staggered along their bezier to reduce overlap.
- **U9** export production tables (CSV), flowchart (PNG), map (PNG); CSP relaxed to
  `img-src 'self' data: blob:` for SVG→PNG.
- **S2** Electron fully hardened:
  - `main.js`: navigation lockdown (deny in-app windows, external links → OS browser,
    block navigation away from index.html) **and** `contextIsolation:true`,
    `nodeIntegration:false`, `sandbox:false`, `preload.js`.
  - `preload.js`: contextBridge exposes only a 3-method read-only save API +
    https-only `openExternal` on `window.api`.
  - renderer drops its `require('./save-reader')`/`require('electron')` (guarded
    `window.api` shim); its pure deps are esbuild-bundled into `renderer.bundle.js`
    (gitignored artifact, built on prestart/prepackage) so the page needs no `require`.
  - `scripts/bundle-smoke.js` boots the bundle in jsdom's page context to prove no
    require leak; wired into `npm test`.
  - **Verified headless** (tests + bundle smoke + syntax). **Needs one manual
    `npm start`** to confirm the live contextBridge wiring (save load + support link) —
    that path can't be exercised without launching Electron.

Still open (1):
- **P2** Debounce LP 🟡 — deliberately not done (proportionality): the only blocker is
  the synchronous UI test (asserts DOM right after each `input`), and reworking that
  230-line harness to async-flush isn't justified by an imperceptible perf gain on
  already-sub-5ms solves. Revisit if a genuinely large plan ever shows lag.

## Status — feature round (v1.6.0, branch `claude/confident-booth-3ae3a0`)
All six backlog feature requests shipped. `npm test` green (98 unit + 147 UI + 7 bundle = 252).
Built by parallel worktree agents, then integrated one-at-a-time with conflict resolution.
- **F1** disable standard recipes — generalized the alternate veto into a per-recipe blocklist (`disabledRecipes`); honored by planner pick + LP via `blockedRecipeSet()`. Sole-producer guard.
- **F4** turn off machines — `disabledBuildings`; a disabled building drops all its recipes (keyed into the same blocklist). "Buildings" veto section.
- **F5** Depot / Storage outputs — per-output `dest` tag (`line`/`depot`/`storage`); depot/storage outputs build as demand but render in their own group + a distinct flow terminal.
- **F6** declutter — default tab is now Optimizer, Planner demoted to a secondary tab (engine intact), game settings moved into a header-gear **Settings drawer**.
- **F2** appearance theming — Settings drawer overrides `:root` CSS vars live, 3 presets + reset, persisted to its own `satisfactory-app-prefs-v1` key (kept OUT of the plan store — no blank-app risk).
- **F3** Projects — plans group into projects (`projects`/`activeProjectId`/per-plan `projectId`); a plan's input can link to another plan's output (auto-syncs, cycle-guarded); Project Totals rollup. Pre-F3 `plans.json` migrates into a default "Project 1" (back-compat is the headline guarantee, covered by tests).

## Priority order (original)
1. [S1] XSS→RCE via untrusted save strings in tooltips 🔴 — ✅ DONE
2. [B1] Vanilla save nodes hidden by default 🔴 — ✅ DONE
3. [T1] No unit tests for solver / save-reader / extractors 🟠 — ✅ DONE
4. [S2] Electron hardening (contextIsolation/nodeIntegration) 🟠 — ✅ DONE (round 2; needs one `npm start` smoke)
5. [B3] Byproduct-only items treated as raw in Planner 🟠 — ✅ DONE
6. [B2] Double flowchart render per solve 🟡 — ✅ DONE
7. Everything else below 🟡 — B4/B5/P1/U1/U5/U6/U7 done; P2/U2/U3/U4/U8/U9 open

---

## Security

### [S1] XSS → RCE via untrusted save strings in map tooltips 🔴
- **Where:** [src/renderer.js:1035](src/renderer.js:1035), [src/renderer.js:1056](src/renderer.js:1056) (`buildingTipHtml` / `mapHover` set `tip.innerHTML`); building name from save: [src/renderer.js:762](src/renderer.js:762).
- **Problem:** `buildingTipHtml` interpolates `buildingDisplayName(b.className)` — derived from the loaded `.sav` file's `typePath` — straight into `innerHTML`. A crafted save with HTML in a class/type path injects markup. Combined with `nodeIntegration:true` + `contextIsolation:false` ([src/main.js:13](src/main.js:13)) that injection runs with full Node access → remote code execution. Threat model is real: players routinely share `.sav` files.
- **Fix:** Build tooltips from text nodes / `textContent` instead of `innerHTML` (or HTML-escape every save-derived string). Node tooltips (`mapTipHtml`) use trusted `ITEMS` names but should be converted too for consistency.
- **Acceptance:** Loading a save whose building `typePath` contains `<img src=x onerror=...>` shows the literal text in the tooltip; no script runs.

### [S2] Electron hardening 🟠
- **Where:** [src/main.js:13-16](src/main.js:13).
- **Problem:** `nodeIntegration:true`, `contextIsolation:false`. Any renderer-side injection (see S1) becomes RCE. Default-unsafe config.
- **Fix:** Flip to `contextIsolation:true`, `nodeIntegration:false`; move `save-reader`/`fs` work behind a `preload.js` + IPC (`ipcMain.handle` for listSaves/readMap/readUnlockedAlternates). Renderer calls an exposed `window.api.*`.
- **Acceptance:** App still lists saves, loads alternates, and renders the map; DevTools `require` is undefined in the renderer.
- **Note:** Larger refactor. S1 (escape tooltips) is the cheap immediate mitigation and can land first.

---

## Bugs / correctness

### [B1] Vanilla (non-randomized) save nodes hidden by default 🔴
- **Where:** [src/renderer.js:923](src/renderer.js:923) (default `mapResOn` excludes `__unknown`); visibility [src/renderer.js:782](src/renderer.js:782).
- **Problem:** Only the Resource Node Randomizer mod writes per-node resource overrides. On a **vanilla** save every mineable node has `resourceClass === null` → bucket `__unknown`, which defaults OFF. Result: a normal player loads the map and sees **0 mineable nodes** (only geysers/wells/buildings), with no hint why. This is the common case, not the edge case.
- **Fix:** When `__unknown` is the only (or dominant) mineable bucket, default it ON. Relabel it "Vanilla / unknown nodes" and only default it off when randomized overrides are actually present.
- **Acceptance:** Loading a vanilla save plots its iron/copper/etc. nodes by default.

### [B3] Byproduct-only items treated as raw in the Planner 🟠
- **Where:** `defaultRecipeClass` [src/renderer.js:43](src/renderer.js:43); `chosenRecipeClass` [src/renderer.js:201](src/renderer.js:201).
- **Problem:** The planner resolves an item's producer via `recipesByPrimary` (first product only). An item that is only ever a **secondary** product has no primary recipe, so `chosenRecipeClass` returns null and the planner lists it as a **raw input** instead of producing it. Confirmed real case: **Dissolved Silica** (`Desc_DissolvedSilica_C`) — produced as a by-product of 1 recipe, used as an ingredient elsewhere → shows up as an unobtainable "raw resource."
- **Fix:** When no primary recipe exists, fall back to any recipe in `recipesByProduct[item]` (and expose it in the row dropdown so the user can still pick Raw). The LP already credits by-products, so balancing works once the producer is included.
- **Acceptance:** A plan that needs Dissolved Silica builds its producing recipe rather than listing it under Raw resources.

### [B2] Flowchart renders twice per solve 🟡
- **Where:** `present()` [src/renderer.js:1100-1102](src/renderer.js:1100) calls `showOutput()` → `applyView()` → `renderFlowView()` ([src/renderer.js:686](src/renderer.js:686)), then calls `renderFlowView()` again directly ([src/renderer.js:1102](src/renderer.js:1102)).
- **Problem:** When the flow view is active, the whole graph is built, laid out, and drawn twice on every solve. Wasted work; can double-apply fit logic.
- **Fix:** Let `applyView()` own flow rendering; drop the redundant call in `present()`.
- **Acceptance:** One `renderFlowView` per solve (add a temporary counter/log to confirm); flow still updates on every input change.

### [B4] Long belts/pipes culled by their anchor point 🟡
- **Where:** `drawBuildings` path pass [src/renderer.js:841-845](src/renderer.js:841).
- **Problem:** A path is skipped if its translation anchor `(b.x,b.y)` is outside the viewport (+200px margin). A long conveyor/pipe spanning the screen disappears when its origin is panned off-edge.
- **Fix:** Precompute each path's world/image bbox at load; cull by bbox-intersects-viewport instead of anchor-in-viewport.
- **Acceptance:** A long route stays drawn while any segment is on screen.

### [B5] Window resize doesn't reframe the map 🟡
- **Where:** resize handler [src/renderer.js:1084](src/renderer.js:1084); `fitMapView` only runs on load/reset [src/renderer.js:800](src/renderer.js:800).
- **Problem:** Resizing the window updates canvas pixel size but not `mapV` scale/offset, so the map drifts off-center (still pannable, but jarring).
- **Fix:** On resize, keep the current view center fixed (recompute `ox/oy` around center), or refit when the user hasn't manually zoomed.
- **Acceptance:** Resizing the window keeps the map centered/framed.

---

## UI / UX

### [U1] "Clear plan" has no confirmation 🟡
- **Where:** [src/renderer.js:1552](src/renderer.js:1552).
- **Problem:** Instantly wipes the active plan's target, recipe picks, extra outputs, and flow layout. `deletePlan` confirms but the more destructive in-place wipe doesn't.
- **Fix:** `confirm('Clear this plan?')` before resetting, matching `deletePlan`.
- **Acceptance:** Clicking "Clear plan" prompts; cancel leaves the plan intact.

### [U2] Two separate save selectors for the same folder 🟡
- **Where:** `#saveSelect` (alternates) [src/index.html:184](src/index.html:184); `#mapSaveSelect` (map) [src/index.html:127](src/index.html:127); both filled by `buildSaveList` [src/renderer.js:1294](src/renderer.js:1294).
- **Problem:** The alternates panel and the map each have their own save dropdown and "Load" button; users select and parse the same save twice.
- **Fix:** Share one selection (sync the two dropdowns), or introduce a single "active save" the whole app reads.
- **Acceptance:** Choosing a save in one place reflects in the other.

### [U3] Map data not persisted / no auto-load 🟡
- **Where:** `mapNodes`/`mapBuildings` are module-scope vars [src/renderer.js:707](src/renderer.js:707), [src/renderer.js:741](src/renderer.js:741); loaded only via `loadMapFromSave` [src/renderer.js:983](src/renderer.js:983).
- **Problem:** Every app launch requires a manual "Load map" — the parsed map is in memory only.
- **Fix:** Remember the last map save path in localStorage and auto-load on startup (or cache extracted nodes/buildings).
- **Acceptance:** Reopening the app restores the last map without a manual reload.

### [U4] Optimizer / Max accept only raw resources as inputs 🟡
- **Where:** Optimizer inputs use `resList` [src/renderer.js:1144](src/renderer.js:1144); Max supply uses `resList` [src/renderer.js:1260](src/renderer.js:1260).
- **Problem:** You can't start from an intermediate ("I have 120 Iron Plate/min, maximize Reinforced Plate"). Only the 13 raw resources are selectable.
- **Fix:** Allow any item (use `targetable`/`itemList`) as an allowed input / supply; the LP already supports arbitrary free items.
- **Acceptance:** Max Throughput can use Iron Plate as a supplied input.

### [U5] Icon-only buttons lack accessible labels 🟡
- **Where:** e.g. row remove `×` [src/renderer.js:1221](src/renderer.js:1221), plan close `×` [src/renderer.js:1423](src/renderer.js:1423); `↻` refresh, `+`/`−` zoom in [src/index.html:131](src/index.html:131), [src/index.html:248](src/index.html:248).
- **Problem:** Screen readers announce no purpose; several rely on glyphs only (some have `title`, not all).
- **Fix:** Add `aria-label` to icon-only controls.
- **Acceptance:** Each icon button exposes a label to assistive tech.

### [U6] Somersloop slider allows up to 4× 🟡
- **Where:** [src/index.html:67](src/index.html:67); applied in `computePlanner` [src/renderer.js:269](src/renderer.js:269).
- **Problem:** In-game production amplification per building is generally capped at ~2×; allowing 4× overstates output and understates machine count.
- **Fix:** Cap the slider at 200%, or clearly label it as an idealized approximation.
- **Acceptance:** Slider max reflects the in-game amplification cap (or carries an explicit caveat).

### [U7] Dead `warnBox` element 🟡
- **Where:** declared [src/index.html:229](src/index.html:229); only ever hidden [src/renderer.js:1107](src/renderer.js:1107).
- **Problem:** The summary "warn" box is never populated — dead UI.
- **Fix:** Either wire it to real warnings (locked recipe auto-fell-back-to-default, infeasible hints, randomizer-not-detected) or remove it.
- **Acceptance:** No unused warn element, or it shows a real message.

### [U8] Flowchart edge labels overlap on dense graphs 🟡
- **Where:** edge label placement [src/renderer.js:537-543](src/renderer.js:537).
- **Problem:** Per-minute labels collide where many edges share a column band.
- **Fix:** Stagger label offset along the path, draw a small background chip, or hide labels below a zoom threshold.
- **Acceptance:** Labels stay legible on a large multi-product plan.

### [U9] No export of results 🟡
- **Where:** results tables [src/index.html:258-290](src/index.html:258); flow SVG [src/renderer.js:518](src/renderer.js:518).
- **Problem:** No way to copy/export production tables (CSV) or the flowchart (PNG/SVG) — a common ask for planner tools.
- **Fix:** Add "Copy as CSV" for the tables and "Export PNG/SVG" for the flow.
- **Acceptance:** User can export a plan's tables and diagram.

---

## Performance

### [P1] Map overlay recomputed every frame 🟠
- **Where:** `drawBuildings` two passes [src/renderer.js:833-882](src/renderer.js:833); `updateMapCount` O(n) per draw [src/renderer.js:901](src/renderer.js:901); `pickMachineAt` O(n) per hover [src/renderer.js:1015](src/renderer.js:1015).
- **Problem:** Every pan/zoom frame re-projects all buildings (`worldToImgX/Y`) and recounts visibles. On 100k-building saves this stutters. Hover hit-tests linearly too.
- **Fix:** Precompute image-space coords (and path bboxes) once in `annotateBuildings`; build a coarse spatial grid for culling + hit-test; cache the visible count and recompute only when filters change.
- **Acceptance:** Smooth pan/zoom on a large save (target ~60fps); hover stays responsive.

### [P2] LP re-solves on every keystroke 🟡
- **Where:** rate/cap `input` handlers, e.g. [src/renderer.js:1223](src/renderer.js:1223), [src/renderer.js:1255](src/renderer.js:1255), [src/renderer.js:1504](src/renderer.js:1504).
- **Problem:** Each character triggers `save()` + full `solveAndRender()`. Cheap for small plans, wasteful for large ones / fast typists.
- **Fix:** Debounce `solveAndRender` (~120ms); keep `save` immediate or also debounced.
- **Acceptance:** Typing a multi-digit rate solves once after the pause, not per character.

---

## Testing / tooling

### [T1] No unit tests for the solver, save-reader, or extractors 🟠
- **Where:** untested: [src/solver-lp.js](src/solver-lp.js), [src/save-reader.js](src/save-reader.js), [src/factory-extract.js](src/factory-extract.js), [src/building-meta.js](src/building-meta.js). Only [scripts/ui-test.js](scripts/ui-test.js) exists (UI/plans regression).
- **Problem:** The math core (optimize / maxThroughput / planner balance, by-product crediting, recycle loops) and the pure save-parsing helpers have no direct coverage. Regressions in LP construction would slip past the DOM test.
- **Fix:** Add node test files: known-answer cases for `planner`/`optimize`/`maxThroughput`; synthetic-save fixtures for `extractAlternates`, `extractBuildings`, `quatToYaw`, `categoryOf`/`buildingMeta`.
- **Acceptance:** `node scripts/<new>-test.js` passes and is wired into the test script.

### [T2] No aggregate `npm test` 🟡
- **Where:** [package.json:8-16](package.json:8).
- **Problem:** Only `test:ui`; no single `test` entry. Easy to forget to run things.
- **Fix:** Add `"test"` that runs the UI test plus the new unit tests (T1).
- **Acceptance:** `npm test` runs the whole suite and exits non-zero on any failure.

---

## Feature requests

Enhancements, not defects — captured from user backlog dump (2026-06-08). `F#` = user's
list order, for traceability. These are net-new capability, so severity here reads as
**impact / effort**, not "bug badness."

**Suggested build order:** F1 + F4 together (shared recipe/machine exclusion mechanism,
small, high daily value) → F5 (extends existing extra-outputs) → F6 (UI declutter) →
F2 (theming) → F3 (Projects — biggest, do last / its own milestone).

### [F1] Disable standard (non-alternate) recipes to force a specific one 🟠
- **Where:** veto today is alternates-only — list [src/index.html:199-220](src/index.html:199), `effectiveAltSet` [src/renderer.js:155](src/renderer.js:155); planner producer pick `chosenRecipeClass` [src/renderer.js:319](src/renderer.js:319); LP gets `unlockedAlts` [src/renderer.js:1545](src/renderer.js:1545).
- **Problem:** You can untick *alternate* recipes, but there's no way to forbid a **standard** recipe. So you can't say "never use the base recipe for X — only the alternate I picked." The optimizer keeps the standard one available.
- **Fix:** Generalize the alternate veto into a per-recipe **blocklist** covering standard recipes too. Add standard recipes to the manual veto list (or a parallel "standard recipes" disclosure), persist the disabled set in state, and have both `chosenRecipeClass` and the LP's allowed-recipe set honor it. Guard against disabling the *only* producer of a needed item (warn / block).
- **Acceptance:** Disabling a standard recipe makes the optimizer route around it (or report infeasible if it was the sole producer and no alternate is enabled).
- **Note:** Same exclusion plumbing as [F4]; build them together.

### [F2] Profile settings — tweak colors / theme 🟡
- **Where:** CSS custom properties `:root` [src/styles.css:1-12](src/styles.css:1) (`--bg`, `--panel`, `--accent`, …); map palettes (collectables/categories) e.g. [src/renderer.js:882](src/renderer.js:882); flow node colors [src/renderer.js:1470](src/renderer.js:1470).
- **Problem:** No user-facing color/theme customization. Palette is hard-coded in CSS vars + a few JS color maps.
- **Fix:** A "Profile / Appearance" settings panel that overrides the `:root` CSS variables (write to `document.documentElement.style` + persist to the durable settings store, same mechanism as plans). Optional: a couple of presets (dark default, high-contrast, light). For JS-drawn colors (map/flow), read from the same vars instead of literals so they follow the theme.
- **Acceptance:** Changing accent/background in settings updates the UI live and survives restart.
- **Note:** Natural home is the Settings menu from [F6]. Centralize color literals onto CSS vars first so one knob recolors everything.

### [F3] Link plans into a "Project" — chain one tab's output into another's input 🟠
- **Where:** plan tabs `#planTabs` [src/index.html:27](src/index.html:27); per-plan state model [src/renderer.js:190-220](src/renderer.js:190); plans persisted to `userData/plans.json` (see memory: plans-persistence-durable); extra inputs `state.opt.extraInputs` [src/renderer.js:1541](src/renderer.js:1541); outputs feed `LP.optimize` [src/renderer.js:1545](src/renderer.js:1545).
- **Problem:** Plans/tabs are independent. For a multi-factory layout (e.g. one tab makes Fused Modular Frames, another consumes them for Nuclear Pasta) you manually copy the output rate into the next tab's input. No auto-link, no rollup.
- **Fix:** Introduce a **Project** container grouping several plans. Let a plan's input reference another plan's output ("supplied by: <plan>") so its rate auto-tracks upstream changes. Recompute downstream when upstream solves; detect/break cycles. Optional Project-level rollup (total raw inputs, total power across all member plans).
- **Acceptance:** Editing the producing plan's rate updates the consuming plan automatically; a Project view shows combined raw/power totals.
- **Note:** Largest item — its own milestone. Needs a project data model above the current flat plans array, plus migration of existing saved plans into a default project.

### [F4] Turn off specific machines/buildings (e.g. Converter) 🟠
- **Where:** recipes carry their building (`s.building` [src/renderer.js:510](src/renderer.js:510), `s.buildingName` [src/renderer.js:571](src/renderer.js:571)); same allowed-recipe set as [F1] feeds the LP [src/renderer.js:1545](src/renderer.js:1545).
- **Problem:** To stop the optimizer using the **Converter** (e.g. it makes iron from anything), you must hunt down and disable every conversion recipe by hand. No single "don't use this machine" switch.
- **Fix:** A building/machine exclusion list. Map each recipe to its producing building, and when a building is disabled, drop all its recipes from the allowed set (reuse [F1]'s blocklist, keyed by building). Surface as checkboxes of building types in/near the recipe controls. Same single-producer guard as F1.
- **Acceptance:** Unchecking "Converter" excludes every Converter recipe in one action; plans re-solve without it.
- **Note:** Thin layer over [F1] — implement F1's recipe blocklist first, then F4 = "disable all recipes for building B."

### [F5] Route an output to the Dimensional Depot / Storage 🟡
- **Where:** extra outputs `buildPlannerExtra` [src/renderer.js:1636](src/renderer.js:1636) / add handler [src/renderer.js:1957](src/renderer.js:1957); outputs map built for the LP [src/renderer.js:1545](src/renderer.js:1545); by-product destinations already tracked + shown ("Destination" col) [src/index.html:308](src/index.html:308), disposal lines [src/renderer.js:525](src/renderer.js:525).
- **Problem:** Every output is treated as a line product. No way to mark "also send 1/min Modular Frame + 1/min HMF to the Depot/storage" as a tagged building-supply pull.
- **Fix:** Add a per-output **destination** tag (`line` default, or `depot`/`storage`). Depot-tagged outputs add to demand exactly like a normal output but render in their own "To Depot / Storage" group in the tables (and a distinct flow terminal, mirroring the existing Awesome-Sink/Fuel-Generator disposal terminals). Pure presentation + grouping on top of the existing extra-output rows.
- **Acceptance:** Adding a depot-tagged output for an item increases its required production and lists it under "To Depot," separate from primary line outputs.

### [F6] Declutter main screen — drop default Planner tab, move Game Settings into a Settings menu 🟡
- **Where:** tab nav [src/index.html:32-36](src/index.html:32) (Planner tab [src/index.html:33](src/index.html:33), default `active`); planner panel [src/index.html:42-71](src/index.html:42); game-settings UI on the main screen — Machine tuning (clock/Somersloop) [src/index.html:58-70](src/index.html:58), Cost Multiplier / Advanced Game Settings [src/index.html:226](src/index.html:226), value lists [src/renderer.js:93](src/renderer.js:93).
- **Problem:** Everyone uses Recipe Optimizer + Max Throughput; the original **Planner** tab is dead weight and shouldn't be the landing tab. Game-settings knobs (cost multiplier, amplification, etc.) clutter the main workspace.
- **Fix:** Default to the Optimizer tab; either remove the Planner tab or demote it (keep the planner engine for now to avoid breaking saved plans — just hide/de-emphasize the tab). Move game-settings controls into a dedicated **Settings** menu/drawer (alongside [F2] appearance), out of the main panel.
- **Acceptance:** App opens on Optimizer; main screen has no game-settings clutter; those controls live in a Settings menu and still drive results.
- **Note:** Saved plans reference planner state — if fully removing the Planner tab, migrate/keep that data path so existing plans don't break (see memory: plans-persistence-durable, packager-prune-blank-app).
