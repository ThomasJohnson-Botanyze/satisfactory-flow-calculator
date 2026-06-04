'use strict';
// Extracts a factory-map overlay (buildings + belt/pipe/wire paths) from an
// ALREADY-PARSED Satisfactory save object.
//
// Pure & dependency-free by design: this module never reads files, never requires
// an npm package, and never calls the save parser — a sibling module owns parsing.
// That keeps it unit-testable with synthetic inputs and no node_modules present.
//
// Coordinate notes: the parser gives positions in centimeters. The map is
// top-down, so we keep world X and Y and drop Z (Z is height/up). Rotations are
// quaternions; buildings almost always rotate only about the vertical Z axis, so
// a single yaw angle is enough to place them and to unwrap their local splines.

// Yaw (radians) about the vertical Z axis from a quaternion {x,y,z,w}.
// For a pure-Z rotation (x=y=0) this reduces to 2*atan2(z,w).
function quatToYaw(q) {
  if (!q) return 0;
  const x = q.x || 0, y = q.y || 0, z = q.z || 0, w = q.w || 0;
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
}

// Transform a local point into world X/Y: scale, rotate about Z by yaw, translate.
// Z is dropped (top-down map). scale defaults to {x:1,y:1,z:1}.
function localToWorld(local, translation, yaw, scale) {
  const t = translation || { x: 0, y: 0, z: 0 };
  const s = scale || { x: 1, y: 1, z: 1 };
  const lx = (local.x || 0) * (s.x != null ? s.x : 1);
  const ly = (local.y || 0) * (s.y != null ? s.y : 1);
  const c = Math.cos(yaw), sn = Math.sin(yaw);
  return {
    x: (t.x || 0) + lx * c - ly * sn,
    y: (t.y || 0) + lx * sn + ly * c,
  };
}

// "/Game/.../Build_ConstructorMk1.Build_ConstructorMk1_C" -> "Build_ConstructorMk1_C"
function classFromTypePath(typePath) {
  if (!typePath) return null;
  const s = String(typePath);
  const dot = s.lastIndexOf('.');
  return dot >= 0 ? s.slice(dot + 1) : s;
}

// Render-geometry kind for a building class name. Conveyor lifts are mostly
// vertical; we still treat them as 'belt' and emit their spline (it collapses to
// a short segment/point at map scale, which is fine).
function kindOfClass(className) {
  if (!className) return 'machine';
  if (/ConveyorBelt|ConveyorLift/.test(className)) return 'belt';
  if (/Pipeline/.test(className)) return 'pipe';
  if (className === 'Build_PowerLine_C' || /PowerLine/.test(className)) return 'wire';
  return 'machine';
}

// Build a belt/pipe path: each mSplineData point is in the actor's LOCAL space, so
// unwrap it through the actor transform. Returns >=2 world {x,y} points, or null
// if there isn't enough spline data (caller falls back to the translation).
function splinePath(o, translation, yaw, scale) {
  const vals = o.properties && o.properties.mSplineData && o.properties.mSplineData.values;
  if (!Array.isArray(vals) || vals.length < 2) return null;
  const path = [];
  for (let i = 0; i < vals.length; i++) {
    const loc = vals[i] && vals[i].properties && vals[i].properties.Location && vals[i].properties.Location.value;
    if (!loc) continue;
    path.push(localToWorld(loc, translation, yaw, scale));
  }
  return path.length >= 2 ? path : null;
}

// Build a power-line path from mWireInstances[*].properties.Locations[*].
//
// World/local ambiguity: it's not certain whether wire Locations are stored
// world-absolute or actor-local. Heuristic (documented assumption): a point whose
// |x| or |y| exceeds 100000 cm (1 km) is well outside the band a local offset
// would occupy, so we treat it as already world-absolute and use it as-is;
// otherwise we treat it as local and unwrap it through the actor transform. This
// is decided per-point so a mixed/odd wire still places sensibly.
function wirePath(o, translation, yaw, scale) {
  const wires = o.properties && o.properties.mWireInstances && o.properties.mWireInstances.values;
  if (!Array.isArray(wires)) return null;
  const path = [];
  for (let w = 0; w < wires.length; w++) {
    const locs = wires[w] && wires[w].properties && wires[w].properties.Locations;
    const arr = Array.isArray(locs) ? locs : (locs && locs.value) || (locs && Array.isArray(locs.values) ? locs.values : null);
    if (!Array.isArray(arr)) continue;
    for (let i = 0; i < arr.length; i++) {
      const p = arr[i] && (arr[i].value || arr[i]); // tolerate {value:{x,y,z}} or bare {x,y,z}
      if (!p || (p.x == null && p.y == null)) continue;
      if (Math.abs(p.x || 0) > 100000 || Math.abs(p.y || 0) > 100000) {
        path.push({ x: p.x || 0, y: p.y || 0 }); // world-absolute
      } else {
        path.push(localToWorld(p, translation, yaw, scale)); // local-relative
      }
    }
  }
  return path.length >= 2 ? path : null;
}

// Extract every placed building from a parsed save. One linear pass over all
// objects in all levels — no deep recursion or serialization (saves can hold
// 100k+ objects). Only objects whose class stem starts with "Build_" and that
// carry a transform.translation are included (skips inventories/info/chain actors).
function extractBuildings(save) {
  const levels = (save && save.levels) || {};
  const out = [];
  for (const lvlName in levels) {
    const objs = (levels[lvlName] && levels[lvlName].objects) || [];
    for (let oi = 0; oi < objs.length; oi++) {
      const o = objs[oi];
      if (!o || typeof o.typePath !== 'string') continue;
      const className = classFromTypePath(o.typePath);
      if (!className || className.indexOf('Build_') !== 0) continue;
      const tr = o.transform && o.transform.translation;
      if (!tr) continue;

      const scale = (o.transform && o.transform.scale3d) || { x: 1, y: 1, z: 1 };
      const yaw = quatToYaw(o.transform && o.transform.rotation);
      const kind = kindOfClass(className);
      const props = o.properties || {};

      const rec = {
        className,
        kind,
        x: tr.x,
        y: tr.y,
        z: tr.z,
        yaw,
        sx: scale.x != null ? scale.x : 1,
        sy: scale.y != null ? scale.y : 1,
        overclock: (props.mCurrentPotential && props.mCurrentPotential.value != null) ? props.mCurrentPotential.value : 1.0,
        boost: (props.mCurrentProductionBoost && props.mCurrentProductionBoost.value != null) ? props.mCurrentProductionBoost.value : 0,
        swatch: swatchOf(props),
      };

      if (kind === 'belt' || kind === 'pipe') {
        rec.path = splinePath(o, tr, yaw, scale) || [{ x: tr.x, y: tr.y }, { x: tr.x, y: tr.y }];
      } else if (kind === 'wire') {
        rec.path = wirePath(o, tr, yaw, scale) || [{ x: tr.x, y: tr.y }, { x: tr.x, y: tr.y }];
      }
      out.push(rec);
    }
  }
  return out;
}

// Paint swatch stem, e.g. "SwatchDesc_Slot0_C", or null when not customized.
function swatchOf(props) {
  const sw = props.mCustomizationData
    && props.mCustomizationData.value
    && props.mCustomizationData.value.properties
    && props.mCustomizationData.value.properties.SwatchDesc
    && props.mCustomizationData.value.properties.SwatchDesc.value
    && props.mCustomizationData.value.properties.SwatchDesc.value.pathName;
  return classFromTypePath(sw);
}

// Counts for a list of building records: { total, byKind:{...}, byClass:{...} }.
function summarize(buildings) {
  const byKind = { machine: 0, belt: 0, pipe: 0, wire: 0 };
  const byClass = {};
  const list = buildings || [];
  for (let i = 0; i < list.length; i++) {
    const b = list[i];
    if (b.kind in byKind) byKind[b.kind]++;
    else byKind[b.kind] = (byKind[b.kind] || 0) + 1;
    byClass[b.className] = (byClass[b.className] || 0) + 1;
  }
  return { total: list.length, byKind, byClass };
}

module.exports = {
  extractBuildings,
  summarize,
  quatToYaw,
  localToWorld,
  kindOfClass,
  classFromTypePath,
};
