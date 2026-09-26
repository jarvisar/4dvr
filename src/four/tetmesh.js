// Tetrahedral meshes of the 3D boundaries of 4D solids.
//
// A 3D solid is drawn using triangles on its surface. A 4D solid is drawn
// using tetrahedra on its boundary. Cutting each tetrahedron with the
// viewer's hyperplane gives a triangle or quad, and together these form the
// surface of the 3D cross-section. The cutting is done in sliceMaterial.js;
// this module builds the tetrahedra.
//
// Each tetrahedron is stored as 10 RGBA float texels:
//   0-3  vertex positions (object space, xyzw)
//   4-7  vertex normals (4D hypersurface normals)
//   8    rgb color + h: vertex 0 of a polytope tetrahedron is the cell center,
//        so its barycentric weight * h is the distance to the nearest face.
//        The fragment shader uses this to draw edges.
//   9    x: reach, the largest distance from vertex 0 to the other vertices.
//        The vertex shader uses it to skip tetrahedra far from the slice
//        after reading only vertex 0 (most of them, for any given slice).

import * as THREE from 'three';
import * as V from '../math/vec4.js';

export const TEXELS_PER_TET = 10;
export const TEX_WIDTH = 1024;

export class TetMesh {
  constructor(name = 'tetmesh') {
    this.name = name;
    this.data = [];
    this.count = 0;
    this.radius = 0;
    this._texture = null;
  }

  addTet(p, n, color, h = 0) {
    const d = this.data;
    let reach = 0;
    for (let k = 0; k < 4; k++) {
      d.push(p[k][0], p[k][1], p[k][2], p[k][3]);
      this.radius = Math.max(this.radius, V.length(p[k]));
      if (k > 0) reach = Math.max(reach, V.distance(p[k], p[0]));
    }
    for (let k = 0; k < 4; k++) d.push(n[k][0], n[k][1], n[k][2], n[k][3]);
    d.push(color[0], color[1], color[2], h);
    d.push(reach, 0, 0, 0);
    this.count++;
  }

  get texture() {
    if (!this._texture) {
      const texels = this.count * TEXELS_PER_TET;
      const height = Math.max(1, Math.ceil(texels / TEX_WIDTH));
      const arr = new Float32Array(TEX_WIDTH * height * 4);
      arr.set(this.data);
      const tex = new THREE.DataTexture(arr, TEX_WIDTH, height, THREE.RGBAFormat, THREE.FloatType);
      tex.minFilter = THREE.NearestFilter;
      tex.magFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      this._texture = tex;
      this.data = null; // the texture keeps its own Float32 copy
    }
    return this._texture;
  }

  /**
   * Geometry with 4 output vertices per tet (the up-to-4 polygon corners),
   * indexed as two triangles. The vertex shader derives everything from
   * gl_VertexID; the dummy attribute only sizes the draw.
   */
  get geometry() {
    if (!this._geometry) {
      const g = new THREE.BufferGeometry();
      const n = this.count * 4;
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n), 1));
      const index = n < 65535 ? new Uint16Array(this.count * 6) : new Uint32Array(this.count * 6);
      for (let t = 0; t < this.count; t++) {
        const b = t * 4, o = t * 6;
        index[o] = b; index[o + 1] = b + 1; index[o + 2] = b + 2;
        index[o + 3] = b; index[o + 4] = b + 2; index[o + 5] = b + 3;
      }
      g.setIndex(new THREE.BufferAttribute(index, 1));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), this.radius * 2);
      this._geometry = g;
    }
    return this._geometry;
  }
}

// ---------------------------------------------------------------------------
// Colour helpers

export function hexToRgb(hex) {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

/** The eight "cell colours": one per ±axis, shared with the hypersphere pattern. */
export const AXIS_COLORS = [
  '#ff6b6b', '#ff9f68', // +x, -x
  '#ffd93d', '#b8e05a', // +y, -y
  '#3ddbd9', '#4aa8ff', // +z, -z
  '#8b7bff', '#d77bff', // +w, -w
].map(hexToRgb);

/** Colour a cell by the axis its normal is closest to (tesseract-style). */
export function axisColor(normal) {
  let best = 0;
  for (let i = 1; i < 4; i++) if (Math.abs(normal[i]) > Math.abs(normal[best])) best = i;
  return AXIS_COLORS[best * 2 + (normal[best] >= 0 ? 0 : 1)];
}

/** Pastel color from a 4D direction. */
export function directionColor(n) {
  const c = new THREE.Color();
  const hue = (Math.atan2(n[1] + 0.35 * n[3], n[0] - 0.35 * n[2]) / (Math.PI * 2) + 1) % 1;
  const light = 0.62 + 0.12 * n[3];
  c.setHSL(hue, 0.72, light);
  return [c.r, c.g, c.b];
}

// ---------------------------------------------------------------------------
// Polytopes

/**
 * Tetrahedralise the boundary of a polytope: every cell is fanned from its
 * centre over its faces (and each non-triangular face from its own centre).
 */
export function polytopeTets(poly, { scale = 1, color = (cell) => directionColor(cell.normal) } = {}) {
  const mesh = new TetMesh(poly.name);
  const P = (v) => V.scale([0, 0, 0, 0], v, scale);
  for (const cell of poly.cells) {
    const col = color(cell);
    const C = P(cell.center);
    const N = cell.normal;
    const nn = [N, N, N, N];
    for (const fi of cell.faces) {
      const face = poly.faces[fi];
      const F = P(face.center);
      const h = V.distance(C, F);
      const vs = face.verts.map((i) => P(poly.vertices[i]));
      if (vs.length === 3) {
        mesh.addTet([C, vs[0], vs[1], vs[2]], nn, col, h);
      } else {
        for (let k = 0; k < vs.length; k++) {
          mesh.addTet([C, F, vs[k], vs[(k + 1) % vs.length]], nn, col, h);
        }
      }
    }
  }
  return mesh;
}

/**
 * A 3D polycube thickened along w: each cube [i, j, k] becomes a hypercube of
 * edge `edge` with w in [−edge/2, edge/2], centred on the polycube's centroid.
 * Only the boundary cells are kept (a ±x/±y/±z cell is dropped where the
 * neighbouring cube shares it); each cell is fanned from its centre like a
 * polytope cell, so the edge lines show the individual cubes.
 */
export function polycubeTets(cubes, colors, edge = 1) {
  const mesh = new TetMesh('polycube');
  const has = new Set(cubes.map((c) => c.join(',')));
  const cen = [0, 1, 2].map((i) => cubes.reduce((acc, c) => acc + c[i], 0) / cubes.length);
  const h = edge / 2;
  cubes.forEach((c, ci) => {
    const center = [(c[0] - cen[0]) * edge, (c[1] - cen[1]) * edge, (c[2] - cen[2]) * edge, 0];
    for (let axis = 0; axis < 4; axis++) for (const sign of [-1, 1]) {
      if (axis < 3) {
        const nb = c.slice();
        nb[axis] += sign;
        if (has.has(nb.join(','))) continue;
      }
      const n = [0, 0, 0, 0];
      n[axis] = sign;
      const nn = [n, n, n, n];
      const C = center.slice();
      C[axis] += sign * h;
      const col = axis === 3 ? colors[ci].map((x) => x + (1 - x) * 0.3) : colors[ci];
      const others = [0, 1, 2, 3].filter((a) => a !== axis);
      for (const b of others) for (const t of [-1, 1]) {
        const F = C.slice();
        F[b] += t * h;
        const [u, v] = others.filter((a) => a !== b);
        const loop = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([su, sv]) => {
          const p = F.slice();
          p[u] += su * h; p[v] += sv * h;
          return p;
        });
        for (let k = 0; k < 4; k++) mesh.addTet([C, F, loop[k], loop[(k + 1) % 4]], nn, col, h);
      }
    }
  });
  return mesh;
}

// ---------------------------------------------------------------------------
// Generic builders for smooth shapes

// Dompierre et al., "How to subdivide pyramids, prisms and hexahedra into
// tetrahedra": relabel so the smallest global id sits at local vertex 0, then
// pick diagonals that always pass through each quad's smallest vertex. This
// keeps neighbouring prisms conforming, so slices have no cracks.
const PRISM_PERM = [
  [0, 1, 2, 3, 4, 5], [1, 2, 0, 4, 5, 3], [2, 0, 1, 5, 3, 4],
  [3, 5, 4, 0, 2, 1], [4, 3, 5, 1, 0, 2], [5, 4, 3, 2, 1, 0],
];

function splitPrism(ids) {
  let m = 0;
  for (let i = 1; i < 6; i++) if (ids[i] < ids[m]) m = i;
  const p = PRISM_PERM[m];
  const L = p.map((i) => ids[i]);
  if (Math.min(L[1], L[5]) < Math.min(L[2], L[4])) {
    return [[L[0], L[1], L[2], L[5]], [L[0], L[1], L[5], L[4]], [L[0], L[4], L[5], L[3]]];
  }
  return [[L[0], L[1], L[2], L[4]], [L[0], L[4], L[2], L[5]], [L[0], L[4], L[5], L[3]]];
}

/**
 * Extrude a triangulated 2-manifold (tris over nBase vertices) through
 * `layers` steps of a 1D parameter, producing prisms split into tets.
 * vertexFn(baseIndex, layer) → { p: vec4, n: vec4 }.
 */
export function prismTets(mesh, tris, nBase, layers, periodic, vertexFn, color) {
  const nLayers = periodic ? layers : layers + 1;
  const cache = new Map();
  const vert = (id) => {
    let v = cache.get(id);
    if (!v) { v = vertexFn(id % nBase, Math.floor(id / nBase)); cache.set(id, v); }
    return v;
  };
  for (let l = 0; l < layers; l++) {
    const l0 = l, l1 = periodic ? (l + 1) % nLayers : l + 1;
    for (const [a, b, c] of tris) {
      const ids = [a + l0 * nBase, b + l0 * nBase, c + l0 * nBase, a + l1 * nBase, b + l1 * nBase, c + l1 * nBase];
      for (const t of splitPrism(ids)) {
        const vs = t.map(vert);
        mesh.addTet(vs.map((v) => v.p), vs.map((v) => v.n), typeof color === 'function' ? color(vs) : color, 0);
      }
    }
  }
}

/** Kuhn (Freudenthal) triangulation of a 3D parameter grid, each cube → 6 tets. */
export function gridTets(mesh, nu, nv, nw, periodic, fn, color) {
  const [pu, pv, pw] = periodic;
  const cache = new Map();
  const vert = (i, j, k) => {
    if (pu) i %= nu; if (pv) j %= nv; if (pw) k %= nw;
    const key = (i * (nv + 1) + j) * (nw + 1) + k;
    let v = cache.get(key);
    if (!v) { v = fn(i / nu, j / nv, k / nw); cache.set(key, v); }
    return v;
  };
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) for (let k = 0; k < nw; k++) {
    for (const perm of perms) {
      const c = [i, j, k];
      const vs = [vert(c[0], c[1], c[2])];
      for (const axis of perm) { c[axis]++; vs.push(vert(c[0], c[1], c[2])); }
      mesh.addTet(vs.map((v) => v.p), vs.map((v) => v.n), typeof color === 'function' ? color(vs) : color, 0);
    }
  }
}

/** Unit icosphere: { verts: [[x,y,z]], tris: [[a,b,c]] }. */
export function icosphere(detail = 2) {
  const t = PHI_3;
  let verts = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t],
    [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ].map((v) => { const l = Math.hypot(...v); return v.map((x) => x / l); });
  let tris = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let d = 0; d < detail; d++) {
    const mid = new Map();
    const midpoint = (a, b) => {
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      if (mid.has(key)) return mid.get(key);
      const m = [0, 1, 2].map((i) => (verts[a][i] + verts[b][i]) / 2);
      const l = Math.hypot(...m);
      verts.push(m.map((x) => x / l));
      mid.set(key, verts.length - 1);
      return verts.length - 1;
    };
    const next = [];
    for (const [a, b, c] of tris) {
      const ab = midpoint(a, b), bc = midpoint(b, c), ca = midpoint(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    tris = next;
  }
  return { verts, tris };
}
const PHI_3 = (1 + Math.sqrt(5)) / 2;

// ---------------------------------------------------------------------------
// Smooth shape catalogue

/**
 * Duocylinder: the product of two discs, D²(r1) in xy × D²(r2) in zw.
 * Its boundary is two solid tori joined along a flat torus.
 */
export function duocylinderTets(r1, r2, seg = 32, colA = AXIS_COLORS[0], colB = AXIS_COLORS[6]) {
  const mesh = new TetMesh('duocylinder');
  // Disc as a fan: vertex 0 = centre, 1..seg on the rim (the disc is flat, so no inner rings are needed).
  const tris = [];
  for (let i = 0; i < seg; i++) tris.push([0, 1 + i, 1 + ((i + 1) % seg)]);
  const disc = (idx, r) => (idx === 0 ? [0, 0] : [r * Math.cos(((idx - 1) / seg) * Math.PI * 2), r * Math.sin(((idx - 1) / seg) * Math.PI * 2)]);
  // Part A: circle in xy × disc in zw
  prismTets(mesh, tris, seg + 1, seg, true, (b, l) => {
    const a = (l / seg) * Math.PI * 2;
    const [u, v] = disc(b, r2);
    return { p: [r1 * Math.cos(a), r1 * Math.sin(a), u, v], n: [Math.cos(a), Math.sin(a), 0, 0] };
  }, colA);
  // Part B: disc in xy × circle in zw
  prismTets(mesh, tris, seg + 1, seg, true, (b, l) => {
    const a = (l / seg) * Math.PI * 2;
    const [u, v] = disc(b, r1);
    return { p: [u, v, r2 * Math.cos(a), r2 * Math.sin(a)], n: [0, 0, Math.cos(a), Math.sin(a)] };
  }, colB);
  return mesh;
}

/** Spherinder: a ball B³(r) in xyz extruded along w ∈ [−h, h]. */
export function spherinderTets(r, h, detail = 2, colSide = AXIS_COLORS[4], colCap = AXIS_COLORS[2]) {
  const mesh = new TetMesh('spherinder');
  const s = icosphere(detail);
  const nb = s.verts.length;
  prismTets(mesh, s.tris, nb, 2, false, (b, l) => {
    const d = s.verts[b];
    return { p: [d[0] * r, d[1] * r, d[2] * r, -h + l * h], n: [d[0], d[1], d[2], 0] };
  }, colSide);
  for (const sign of [-1, 1]) {
    const n = [0, 0, 0, sign];
    const c = [0, 0, 0, sign * h];
    for (const [a, b, cc] of s.tris) {
      const P = (i) => [s.verts[i][0] * r, s.verts[i][1] * r, s.verts[i][2] * r, sign * h];
      mesh.addTet([c, P(a), P(b), P(cc)], [n, n, n, n], colCap, 0);
    }
  }
  return mesh;
}

/** Cubinder: a disc D²(r) in xy × a square [−h,h]² in zw. */
export function cubinderTets(r, h, seg = 32, colRound = AXIS_COLORS[5], colFlat = AXIS_COLORS[3]) {
  const mesh = new TetMesh('cubinder');
  // Round part: circle(xy) × square(zw), the square split into 2 triangles over 4 corners (+ center for symmetry).
  const sq = [[0, 0], [-h, -h], [h, -h], [h, h], [-h, h]];
  const sqTris = [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 1]];
  prismTets(mesh, sqTris, 5, seg, true, (b, l) => {
    const a = (l / seg) * Math.PI * 2;
    return { p: [r * Math.cos(a), r * Math.sin(a), sq[b][0], sq[b][1]], n: [Math.cos(a), Math.sin(a), 0, 0] };
  }, colRound);
  // Flat parts: disc(xy) × each edge of the square (4 cylinders).
  const tris = [];
  for (let i = 0; i < seg; i++) tris.push([0, 1 + i, 1 + ((i + 1) % seg)]);
  const edges = [[[h, -h], [h, h], [0, 0, 1, 0]], [[-h, h], [-h, -h], [0, 0, -1, 0]], [[h, h], [-h, h], [0, 0, 0, 1]], [[-h, -h], [h, -h], [0, 0, 0, -1]]];
  for (const [e0, e1, n] of edges) {
    prismTets(mesh, tris, seg + 1, 1, false, (b, l) => {
      const a = ((b - 1) / seg) * Math.PI * 2;
      const u = b === 0 ? 0 : r * Math.cos(a), v = b === 0 ? 0 : r * Math.sin(a);
      const e = l === 0 ? e0 : e1;
      return { p: [u, v, e[0], e[1]], n };
    }, colFlat);
  }
  return mesh;
}

/**
 * Tiger: points at distance r from the torus {|xy| = R1, |zw| = R2}.
 * Its boundary is a 3-torus.
 */
export function tigerTets(R1, R2, r, nu = 20, nv = 20, nw = 8) {
  const mesh = new TetMesh('tiger');
  const cA = new THREE.Color('#ff8a5c'), cB = new THREE.Color('#5ce1ff');
  gridTets(mesh, nu, nv, nw, [true, true, true], (u, v, w) => {
    const a = u * Math.PI * 2, b = v * Math.PI * 2, c = w * Math.PI * 2;
    const n = [Math.cos(c) * Math.cos(a), Math.cos(c) * Math.sin(a), Math.sin(c) * Math.cos(b), Math.sin(c) * Math.sin(b)];
    const p = [(R1 + r * Math.cos(c)) * Math.cos(a), (R1 + r * Math.cos(c)) * Math.sin(a), (R2 + r * Math.sin(c)) * Math.cos(b), (R2 + r * Math.sin(c)) * Math.sin(b)];
    return { p, n };
  }, (vs) => {
    const c = cA.clone().lerp(cB, 0.5 + 0.5 * vs[0].n[3]);
    return [c.r, c.g, c.b];
  });
  return mesh;
}

/** Spheritorus: points at distance r from a circle of radius R in the xy-plane (boundary S² × S¹). */
export function spheritorusTets(R, r, seg = 32, detail = 1) {
  const mesh = new TetMesh('spheritorus');
  const s = icosphere(detail);
  const nb = s.verts.length;
  const cA = new THREE.Color('#ffd166'), cB = new THREE.Color('#ef476f');
  prismTets(mesh, s.tris, nb, seg, true, (b, l) => {
    const a = (l / seg) * Math.PI * 2;
    const d = s.verts[b]; // (radial, z, w) components on S²
    const rho = R + r * d[0];
    return {
      p: [rho * Math.cos(a), rho * Math.sin(a), r * d[1], r * d[2]],
      n: [d[0] * Math.cos(a), d[0] * Math.sin(a), d[1], d[2]],
    };
  }, (vs) => {
    const c = cA.clone().lerp(cB, 0.5 + 0.5 * vs[0].n[3]);
    return [c.r, c.g, c.b];
  });
  return mesh;
}

/** Torisphere: points at distance r from a 2-sphere of radius R in xyz (boundary S² × S¹). */
export function torisphereTets(R, r, seg = 16, detail = 2) {
  const mesh = new TetMesh('torisphere');
  const s = icosphere(detail);
  const nb = s.verts.length;
  const cA = new THREE.Color('#06d6a0'), cB = new THREE.Color('#118ab2');
  prismTets(mesh, s.tris, nb, seg, true, (b, l) => {
    const a = (l / seg) * Math.PI * 2;
    const d = s.verts[b];
    const rho = R + r * Math.cos(a);
    return {
      p: [rho * d[0], rho * d[1], rho * d[2], r * Math.sin(a)],
      n: [Math.cos(a) * d[0], Math.cos(a) * d[1], Math.cos(a) * d[2], Math.sin(a)],
    };
  }, (vs) => {
    const c = cA.clone().lerp(cB, 0.5 + 0.5 * vs[0].n[3]);
    return [c.r, c.g, c.b];
  });
  return mesh;
}
