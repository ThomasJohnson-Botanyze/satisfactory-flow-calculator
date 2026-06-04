'use strict';
// Render metadata for Satisfactory buildings, for the top-down factory-map overlay.
//
// Given a building class name (e.g. Build_ConstructorMk1_C) this returns the
// category, a top-down footprint (w x d), and a fill color so the overlay knows
// how to draw it. w/d are the building's footprint in CENTIMETERS — Satisfactory
// world units, where 1 meter = 100 cm. Color is derived from the category by
// default; a per-class `color` override is only used when a building truly needs
// a distinct hue.
//
// Pure data + lookup: no DOM, no fs, no require of any dependency. Safe to
// require() from both Node and the Electron renderer.

// Category -> fill color. Hues chosen to stay distinct and readable when drawn
// at ~0.85 alpha over the muted tan/green factory-map image.
const CATEGORY_COLORS = {
  production:   '#e8643c', // warm orange-red
  extraction:   '#d6a01e', // amber/gold
  power:        '#4ea3f0', // sky blue
  logistics:    '#8b94a0', // steel grey
  storage:      '#6fae6f', // muted green
  foundation:   '#566573', // slate
  vehicle:      '#b069d6', // purple
  organization: '#23b5a0', // teal
  decoration:   '#9a8ca0', // dusty mauve
  other:        '#888888', // neutral grey
};

// Footprint fallbacks per category (cm), used when a class isn't in the table.
// Path-like things (belts, pipes, power lines) are drawn as polylines, so their
// footprint is unused — a small placeholder is fine.
const CATEGORY_FOOTPRINT = {
  production:   { w: 1000, d: 1500 },
  extraction:   { w: 1400, d: 900 },
  power:        { w: 1000, d: 1000 },
  logistics:    { w: 200,  d: 200 },
  storage:      { w: 500,  d: 1000 },
  foundation:   { w: 800,  d: 800 },
  vehicle:      { w: 1600, d: 1600 },
  organization: { w: 2000, d: 2000 },
  decoration:   { w: 200,  d: 200 },
  other:        { w: 400,  d: 400 },
};

// Exact-ish footprints keyed by class name. w/d in cm (1 m = 100 cm). Footprints
// reflect each building's top-down bounding box in the game (rounded to tidy
// values). Path/pole/attachment classes carry a small placeholder since the
// renderer draws those as lines/points, not boxes.
const BUILDING_META = {
  // ---------- production ----------
  Build_SmelterMk1_C:        { category: 'production', w: 600,  d: 900 },
  Build_FoundryMk1_C:        { category: 'production', w: 900,  d: 900 },
  Build_ConstructorMk1_C:    { category: 'production', w: 800,  d: 990 },
  Build_AssemblerMk1_C:      { category: 'production', w: 1000, d: 1550 },
  Build_ManufacturerMk1_C:   { category: 'production', w: 1800, d: 1900 },
  Build_OilRefinery_C:       { category: 'production', w: 1000, d: 3400 },
  Build_Packager_C:          { category: 'production', w: 800,  d: 960 },
  Build_Blender_C:           { category: 'production', w: 1800, d: 1600 },
  Build_HadronCollider_C:    { category: 'production', w: 2400, d: 3700 },
  Build_Converter_C:         { category: 'production', w: 1600, d: 2400 },
  Build_QuantumEncoder_C:    { category: 'production', w: 1800, d: 2400 },

  // ---------- extraction ----------
  Build_MinerMk1_C:          { category: 'extraction', w: 600,  d: 1400 },
  Build_MinerMk2_C:          { category: 'extraction', w: 600,  d: 1400 },
  Build_MinerMk3_C:          { category: 'extraction', w: 600,  d: 1400 },
  Build_WaterPump_C:         { category: 'extraction', w: 1000, d: 1000 },
  Build_OilPump_C:           { category: 'extraction', w: 800,  d: 1400 },
  Build_FrackingExtractor_C: { category: 'extraction', w: 600,  d: 600 },
  Build_FrackingSmasher_C:   { category: 'extraction', w: 1400, d: 1400 },
  Build_ResourceWellPressurizer_C: { category: 'extraction', w: 1300, d: 1300 },

  // ---------- power ----------
  Build_GeneratorBiomass_Automated_C:  { category: 'power', w: 800,  d: 800 },
  Build_GeneratorBiomass_C:            { category: 'power', w: 800,  d: 800 },
  Build_GeneratorIntegratedBiomass_C:  { category: 'power', w: 800,  d: 800 },
  Build_GeneratorCoal_C:               { category: 'power', w: 1000, d: 2600 },
  Build_GeneratorFuel_C:               { category: 'power', w: 2000, d: 2000 },
  Build_GeneratorNuclear_C:            { category: 'power', w: 3700, d: 4300 },
  Build_GeneratorGeoThermal_C:         { category: 'power', w: 1900, d: 1900 },
  Build_PowerPoleMk1_C:        { category: 'power', w: 200, d: 200 },
  Build_PowerPoleMk2_C:        { category: 'power', w: 200, d: 200 },
  Build_PowerPoleMk3_C:        { category: 'power', w: 200, d: 200 },
  Build_PowerPoleWall_C:       { category: 'power', w: 200, d: 200 },
  Build_PowerPoleWall_Mk2_C:   { category: 'power', w: 200, d: 200 },
  Build_PowerPoleWall_Mk3_C:   { category: 'power', w: 200, d: 200 },
  Build_PowerTower_C:          { category: 'power', w: 400, d: 400 },
  Build_PowerTowerPlatform_C:  { category: 'power', w: 400, d: 400 },
  Build_PowerLine_C:           { category: 'power', w: 200, d: 200 },
  Build_PowerSwitch_C:         { category: 'power', w: 400, d: 400 },
  Build_PriorityPowerSwitch_C: { category: 'power', w: 400, d: 400 },
  Build_PowerStorageMk1_C:     { category: 'power', w: 1000, d: 1000 },

  // ---------- logistics ----------
  Build_ConveyorBeltMk1_C: { category: 'logistics', w: 200, d: 200 },
  Build_ConveyorBeltMk2_C: { category: 'logistics', w: 200, d: 200 },
  Build_ConveyorBeltMk3_C: { category: 'logistics', w: 200, d: 200 },
  Build_ConveyorBeltMk4_C: { category: 'logistics', w: 200, d: 200 },
  Build_ConveyorBeltMk5_C: { category: 'logistics', w: 200, d: 200 },
  Build_ConveyorBeltMk6_C: { category: 'logistics', w: 200, d: 200 },
  Build_ConveyorLiftMk1_C: { category: 'logistics', w: 200, d: 200 },
  Build_ConveyorLiftMk2_C: { category: 'logistics', w: 200, d: 200 },
  Build_ConveyorLiftMk3_C: { category: 'logistics', w: 200, d: 200 },
  Build_ConveyorLiftMk4_C: { category: 'logistics', w: 200, d: 200 },
  Build_ConveyorLiftMk5_C: { category: 'logistics', w: 200, d: 200 },
  Build_ConveyorLiftMk6_C: { category: 'logistics', w: 200, d: 200 },
  Build_ConveyorAttachmentSplitter_C:      { category: 'logistics', w: 200, d: 200 },
  Build_ConveyorAttachmentSplitterSmart_C: { category: 'logistics', w: 200, d: 200 },
  Build_ConveyorAttachmentSplitterProgrammable_C: { category: 'logistics', w: 200, d: 200 },
  Build_ConveyorAttachmentSplitterLift_C:  { category: 'logistics', w: 200, d: 200 },
  Build_ConveyorAttachmentMerger_C:        { category: 'logistics', w: 200, d: 200 },
  Build_ConveyorPole_C:          { category: 'logistics', w: 200, d: 200 },
  Build_ConveyorPoleStackable_C: { category: 'logistics', w: 200, d: 200 },
  Build_ConveyorPoleWall_C:      { category: 'logistics', w: 200, d: 200 },
  Build_Pipeline_C:              { category: 'logistics', w: 200, d: 200 },
  Build_Pipeline_NoIndicator_C:  { category: 'logistics', w: 200, d: 200 },
  Build_PipelineMK2_C:           { category: 'logistics', w: 200, d: 200 },
  Build_PipelineMK2_NoIndicator_C: { category: 'logistics', w: 200, d: 200 },
  Build_PipelinePump_C:          { category: 'logistics', w: 200, d: 200 },
  Build_PipelinePumpMk2_C:       { category: 'logistics', w: 200, d: 200 },
  Build_PipelineJunction_Cross_C: { category: 'logistics', w: 200, d: 200 },
  Build_PipelineJunction_T_C:    { category: 'logistics', w: 200, d: 200 },
  Build_PipelineSupport_C:       { category: 'logistics', w: 200, d: 200 },
  Build_PipeSupportStackable_C:  { category: 'logistics', w: 200, d: 200 },
  Build_PipelineSupportWall_C:   { category: 'logistics', w: 200, d: 200 },
  Build_Valve_C:                 { category: 'logistics', w: 200, d: 200 },

  // ---------- storage ----------
  Build_StorageContainerMk1_C: { category: 'storage', w: 500,  d: 1000 },
  Build_StorageContainerMk2_C: { category: 'storage', w: 500,  d: 1000 },
  Build_StorageIntegrated_C:   { category: 'storage', w: 500,  d: 1000 },
  Build_IndustrialStorageContainer_C: { category: 'storage', w: 800, d: 1500 },
  Build_CentralStorage_C:      { category: 'storage', w: 1600, d: 1600 },
  Build_PipeStorageTank_C:     { category: 'storage', w: 500,  d: 500 },
  Build_IndustrialFluidContainer_C: { category: 'storage', w: 900, d: 900 },
  Build_PipeHyperStart_C:      { category: 'storage', w: 400,  d: 400 },
  Build_DimensionalDepotUploader_C: { category: 'storage', w: 800, d: 800 },

  // ---------- foundation ----------
  Build_Foundation_8x4_01_C:   { category: 'foundation', w: 800, d: 800 },
  Build_Foundation_8x2_01_C:   { category: 'foundation', w: 800, d: 800 },
  Build_Foundation_8x1_01_C:   { category: 'foundation', w: 800, d: 800 },
  Build_Foundation_4x4_01_C:   { category: 'foundation', w: 400, d: 400 },
  Build_Foundation_4x2_01_C:   { category: 'foundation', w: 400, d: 400 },
  Build_Foundation_4x1_01_C:   { category: 'foundation', w: 400, d: 400 },
  Build_FoundationGlass_01_C:  { category: 'foundation', w: 800, d: 800 },
  Build_Wall_8x4_01_C:         { category: 'foundation', w: 800, d: 100 },
  Build_Wall_8x4_02_C:         { category: 'foundation', w: 800, d: 100 },
  Build_Wall_Concrete_8x4_C:   { category: 'foundation', w: 800, d: 100 },
  Build_Ramp_8x4_01_C:         { category: 'foundation', w: 800, d: 800 },
  Build_Ramp_8x2_01_C:         { category: 'foundation', w: 800, d: 800 },
  Build_RampDouble_8x4_C:      { category: 'foundation', w: 800, d: 800 },
  Build_Roof_Flat_01_C:        { category: 'foundation', w: 800, d: 800 },
  Build_Pillar_Small_C:        { category: 'foundation', w: 200, d: 200 },
  Build_PillarBase_C:          { category: 'foundation', w: 400, d: 400 },
  Build_Beam_C:                { category: 'foundation', w: 200, d: 200 },
  Build_CatwalkStraight_C:     { category: 'foundation', w: 200, d: 400 },
  Build_WalkwayStraight_C:     { category: 'foundation', w: 400, d: 400 },
  Build_Stairs_Left_01_C:      { category: 'foundation', w: 400, d: 400 },

  // ---------- vehicle ----------
  Build_TruckStation_C:        { category: 'vehicle', w: 1600, d: 3200 },
  Build_TrainStation_C:        { category: 'vehicle', w: 3400, d: 1700 },
  Build_TrainDockingStation_C: { category: 'vehicle', w: 3400, d: 1700 },
  Build_TrainDockingStationLiquid_C: { category: 'vehicle', w: 3400, d: 1700 },
  Build_TrainPlatformEmpty_C:  { category: 'vehicle', w: 3400, d: 1700 },
  Build_RailroadTrack_C:       { category: 'vehicle', w: 200,  d: 200 },
  Build_RailroadSwitchControl_C: { category: 'vehicle', w: 200, d: 200 },
  Build_FreightPlatform_C:     { category: 'vehicle', w: 3400, d: 1700 },
  Build_DronePort_C:           { category: 'vehicle', w: 2400, d: 2400 },
  Build_VehicleDock_C:         { category: 'vehicle', w: 2400, d: 2400 },
  Build_Hypertube_C:           { category: 'vehicle', w: 200,  d: 200 },
  Build_HyperTubeEntrance_C:   { category: 'vehicle', w: 400,  d: 400 },
  Build_HyperTubeSupport_C:    { category: 'vehicle', w: 200,  d: 200 },
  Build_JumpPad_C:             { category: 'vehicle', w: 400,  d: 400 },
  Build_JumpPadTilted_C:       { category: 'vehicle', w: 400,  d: 400 },

  // ---------- organization ----------
  Build_HubTerminal_C:   { category: 'organization', w: 1600, d: 2400 },
  Build_TradingPost_C:   { category: 'organization', w: 3200, d: 3200 },
  Build_SpaceElevator_C: { category: 'organization', w: 5600, d: 5600 },
  Build_Mam_C:           { category: 'organization', w: 600,  d: 1000 },
  Build_ResourceSink_C:  { category: 'organization', w: 1600, d: 2400 },
  Build_ResourceSinkShop_C: { category: 'organization', w: 800, d: 800 },
  Build_WorkBench_C:     { category: 'organization', w: 600,  d: 1000 },
  Build_WorkBenchComponent_C: { category: 'organization', w: 600, d: 1000 },
  Build_Workshop_C:      { category: 'organization', w: 600,  d: 1000 },
  Build_RadarTower_C:    { category: 'organization', w: 800,  d: 800 },
  Build_Portal_C:        { category: 'organization', w: 1600, d: 1600 },
  Build_PortalSatellite_C: { category: 'organization', w: 1600, d: 1600 },

  // ---------- decoration ----------
  Build_StandaloneWidgetSign_Huge_C:  { category: 'decoration', w: 400, d: 200 },
  Build_StandaloneWidgetSign_Large_C: { category: 'decoration', w: 200, d: 200 },
  Build_WallLight_01_C: { category: 'decoration', w: 200, d: 100 },
  Build_FloodlightPole_C: { category: 'decoration', w: 200, d: 200 },
  Build_Ladder_C:       { category: 'decoration', w: 100, d: 100 },
  Build_FicsmasTree_C:  { category: 'decoration', w: 400, d: 400 },
};

// Regex fallback: derive a category from the class-name stem (the part after the
// last '.', minus the Build_ prefix and _C suffix). Case-insensitive. Order
// matters — logistics/storage/extraction are tested before the generic
// production check so e.g. a pipeline pump or fluid tank isn't miscategorized.
function categoryOf(className) {
  if (!className) return 'other';
  let s = String(className);
  const dot = s.lastIndexOf('.');
  if (dot >= 0) s = s.slice(dot + 1);
  s = s.replace(/^Build_/i, '').replace(/_C$/i, '');

  if (/ConveyorBelt|ConveyorLift|ConveyorAttachment|ConveyorPole|Splitter|Merger|Pipeline|Pipe/i.test(s)) return 'logistics';
  if (/Storage|Buffer|Tank|Depot/i.test(s)) return 'storage';
  if (/Miner|Extractor|WaterPump|Pump.*(Water|Oil)|Fracking|ResourceWell/i.test(s)) return 'extraction';
  if (/Generator|Power(Line|Pole|Tower|Switch|Storage)|Battery|Geothermal|GeoThermal/i.test(s)) return 'power';
  if (/Foundation|Wall|Ramp|Roof|Pillar|Beam|Frame|Catwalk|Walkway|Stair/i.test(s)) return 'foundation';
  if (/TruckStation|TrainStation|RailroadTrack|Railway|Railroad|FreightPlatform|TrainPlatform|TrainDocking|DronePort|VehicleDock|Hypertube|HyperTube|JumpPad|Locomotive|Wagon/i.test(s)) return 'vehicle';
  if (/Hub|TradingPost|SpaceElevator|Mam|ResourceSink|AwesomeShop|WorkBench|Workshop|RadarTower|Portal/i.test(s)) return 'organization';
  if (/Smelter|Foundry|Constructor|Assembler|Manufacturer|Refinery|Packager|Blender|Converter|Particle|HadronCollider|Encoder/i.test(s)) return 'production';
  if (/Sign|Light|Ladder|Decor|Tree/i.test(s)) return 'decoration';
  return 'other';
}

// Full render record for a class. Looks up BUILDING_META first; otherwise infers
// category + a default footprint from the name. Never returns null. Color is the
// per-class override if present, else the category color.
function buildingMeta(className) {
  const stem = (function () {
    if (!className) return '';
    const s = String(className);
    const dot = s.lastIndexOf('.');
    return dot >= 0 ? s.slice(dot + 1) : s;
  })();

  const hit = BUILDING_META[className] || BUILDING_META[stem];
  if (hit) {
    return {
      category: hit.category,
      w: hit.w,
      d: hit.d,
      color: hit.color || CATEGORY_COLORS[hit.category] || CATEGORY_COLORS.other,
    };
  }

  const category = categoryOf(className);
  const fp = CATEGORY_FOOTPRINT[category] || CATEGORY_FOOTPRINT.other;
  return {
    category,
    w: fp.w,
    d: fp.d,
    color: CATEGORY_COLORS[category] || CATEGORY_COLORS.other,
  };
}

module.exports = {
  CATEGORY_COLORS,
  BUILDING_META,
  buildingMeta,
  categoryOf,
};
