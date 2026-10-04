// 4D shape definitions: how each one is drawn (tetrahedral mesh or analytic
// sphere) and its collision shape at unit scale.

import * as P from './polytopes.js';
import {
  polytopeTets, axisColor, directionColor, duocylinderTets, spherinderTets, cubinderTets,
  tigerTets, spheritorusTets, torisphereTets, polycubeTets, hexToRgb,
} from './tetmesh.js';

// A chiral tetracube with steps of +x, +y, +z (a right-handed twist). No 3D
// rotation turns it into its mirror image, but a half-turn in a plane
// containing w does. Cube edge is 0.5 so the piece is about as big as the
// other shapes.
export const SCREW_CUBES = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 1, 1]];
export const SCREW_EDGE = 0.5;
const SCREW_COLORS = ['#ff6b6b', '#ffd93d', '#3ddbd9', '#8b7bff'];
// Cube centers of the chiral tetracube in body space (w = 0)
export function screwCenters() {
  const cen = [0, 1, 2].map((i) => SCREW_CUBES.reduce((a, c) => a + c[i], 0) / SCREW_CUBES.length);
  return SCREW_CUBES.map((c) => [(c[0] - cen[0]) * SCREW_EDGE, (c[1] - cen[1]) * SCREW_EDGE, (c[2] - cen[2]) * SCREW_EDGE, 0]);
}

function convexPhysics(poly) {
  const verts = poly.vertices.map((v) => v.slice());
  const planes = poly.cells.map((c) => {
    let d = -Infinity;
    for (const v of verts) d = Math.max(d, v[0] * c.normal[0] + v[1] * c.normal[1] + v[2] * c.normal[2] + v[3] * c.normal[3]);
    return [...c.normal, d];
  });
  const samples = [...verts];
  for (const [a, b] of poly.edges) samples.push(verts[a].map((x, i) => (x + verts[b][i]) / 2));
  return { type: 'convex', verts, planes, samples };
}

const DEFS = {
  hypersphere: {
    label: 'Hypersphere', blurb: 'Cross-sections are spheres', sphere: true, radius: 1,
    physics: () => ({ type: 'sphere', r: 1 }),
  },
  tesseract: {
    label: 'Tesseract', blurb: '8 cubic cells', radius: 1,
    tets: () => polytopeTets(P.tesseract(), { color: (c) => axisColor(c.normal) }),
    physics: () => ({ type: 'box', h: [0.5, 0.5, 0.5, 0.5] }),
  },
  simplex: {
    label: '5-cell', blurb: '4D simplex: 5 tetrahedra', radius: 1,
    tets: () => polytopeTets(P.simplex(), { color: (c) => directionColor(c.normal) }),
    physics: () => convexPhysics(P.simplex()),
  },
  orthoplex: {
    label: '16-cell', blurb: '16 tetrahedral cells', radius: 1,
    tets: () => polytopeTets(P.orthoplex(), { color: (c) => directionColor(c.normal) }),
    physics: () => convexPhysics(P.orthoplex()),
  },
  icositetrachoron: {
    label: '24-cell', blurb: '24 octahedral cells', radius: 1,
    tets: () => polytopeTets(P.icositetrachoron(), { color: (c) => directionColor(c.normal) }),
    physics: () => convexPhysics(P.icositetrachoron()),
  },
  hecatonicosachoron: {
    label: '120-cell', blurb: '120 dodecahedra', radius: 1,
    tets: () => polytopeTets(P.hecatonicosachoron(), { color: (c) => directionColor(c.normal) }),
    physics: () => convexPhysics(P.hecatonicosachoron()),
  },
  hexacosichoron: {
    label: '600-cell', blurb: '600 tetrahedra', radius: 1,
    tets: () => polytopeTets(P.hexacosichoron(), { color: (c) => directionColor(c.normal) }),
    physics: () => convexPhysics(P.hexacosichoron()),
  },
  duoprism: {
    label: '6-6 duoprism', blurb: 'hexagon × hexagon', radius: 1,
    tets: () => polytopeTets(P.duoprism(6, 6), { color: (c) => axisColor(c.normal) }),
    physics: () => convexPhysics(P.duoprism(6, 6)),
  },
  duocylinder: {
    label: 'Duocylinder', blurb: 'disk × disk', radius: Math.hypot(0.62, 0.62), pattern: 1,
    tets: () => duocylinderTets(0.62, 0.62, 36),
    physics: () => ({ type: 'duocylinder', r1: 0.62, r2: 0.62 }),
  },
  spherinder: {
    label: 'Spherinder', blurb: 'ball × segment', radius: Math.hypot(0.62, 0.5), pattern: 2,
    tets: () => spherinderTets(0.62, 0.5, 2),
    physics: () => ({ type: 'spherinder', r: 0.62, h: 0.5 }),
  },
  cubinder: {
    label: 'Cubinder', blurb: 'disk × square', radius: Math.hypot(0.6, 0.45 * Math.SQRT2), pattern: 3,
    tets: () => cubinderTets(0.6, 0.45, 32),
    physics: () => ({ type: 'cubinder', r: 0.6, h: 0.45 }),
  },
  tiger: {
    label: 'Tiger', blurb: 'points within a fixed distance of a flat torus', radius: Math.hypot(0.55, 0.55) + 0.22, pattern: 1,
    tets: () => tigerTets(0.55, 0.55, 0.22, 18, 18, 8),
    physics: () => ({ type: 'tiger', R1: 0.55, R2: 0.55, r: 0.22 }),
  },
  spheritorus: {
    label: 'Spheritorus', blurb: 'points within a fixed distance of a circle', radius: 0.9, pattern: 1,
    tets: () => spheritorusTets(0.6, 0.3, 36, 2),
    physics: () => ({ type: 'spheritorus', R: 0.6, r: 0.3 }),
  },
  screw: {
    label: 'Chiral tetracube', blurb: 'four cubes in a right-handed twist, extended along w',
    radius: Math.max(...screwCenters().map((c) => Math.hypot(Math.abs(c[0]) + 0.25, Math.abs(c[1]) + 0.25, Math.abs(c[2]) + 0.25, 0.25))),
    tets: () => polycubeTets(SCREW_CUBES, SCREW_COLORS.map(hexToRgb), SCREW_EDGE),
    physics: () => ({ type: 'boxes', boxes: screwCenters().map((c) => ({ c, h: [0.25, 0.25, 0.25, 0.25] })) }),
  },
  torisphere: {
    label: 'Torisphere', blurb: 'points within a fixed distance of a 2-sphere', radius: 0.85, pattern: 1,
    tets: () => torisphereTets(0.6, 0.25, 16, 2),
    physics: () => ({ type: 'torisphere', R: 0.6, r: 0.25 }),
  },
};

const built = new Map();

export function getShape(key) {
  let s = built.get(key);
  if (s) return s;
  const def = DEFS[key];
  if (!def) throw new Error(`Unknown shape ${key}`);
  s = {
    key,
    label: def.label,
    blurb: def.blurb,
    isSphere: !!def.sphere,
    radius: def.radius,
    pattern: def.pattern || 0,
    tetMesh: def.tets ? def.tets() : null,
    physics: once(def.physics), // colliders copy what they need, so the description can be shared
  };
  built.set(key, s);
  return s;
}

function once(fn) {
  let v;
  return () => (v ??= fn());
}

// Builds every shape ahead of time, one per idle callback, while keepGoing()
// returns true. The larger curved shapes take tens of milliseconds to build
// (more on a headset), which would otherwise stall frames the first time a
// preset or gallery shape uses them. onBuilt(shape) can upload GPU data.
export function prebuildShapes(keepGoing, onBuilt) {
  const keys = SHAPE_KEYS.filter((k) => !built.has(k));
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 30));
  const next = () => {
    if (!keys.length || !keepGoing()) return;
    const shape = getShape(keys.shift());
    onBuilt?.(shape);
    idle(next);
  };
  idle(next);
}

export const SHAPE_KEYS = Object.keys(DEFS);
export function shapeLabel(key) { return DEFS[key].label; }
