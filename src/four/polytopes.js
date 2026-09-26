// Regular convex 4-polytopes and duoprisms.
//
// Each polytope is given by its vertices and the outward normals of its cells
// (the vertices of the dual polytope). Each cell is the set of vertices that
// maximize dot(v, n), and its faces come from a 3D convex hull computed in the
// cell's hyperplane. This avoids hard-coding face lists.

import * as V from '../math/vec4.js';

export const PHI = (1 + Math.sqrt(5)) / 2;

function normalizeAll(verts, r = 1) {
  return verts.map((v) => V.scale([0, 0, 0, 0], v, r / V.length(v)));
}

function permutations(arr) {
  if (arr.length <= 1) return [arr.slice()];
  const out = [];
  arr.forEach((x, i) => {
    const rest = arr.slice(0, i).concat(arr.slice(i + 1));
    for (const p of permutations(rest)) out.push([x, ...p]);
  });
  return out;
}

function parity(p) {
  let inv = 0;
  for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) if (p[i] > p[j]) inv++;
  return inv % 2;
}

const EVEN_PERMS = permutations([0, 1, 2, 3]).filter((p) => parity(p) === 0);
const ALL_PERMS = permutations([0, 1, 2, 3]);

/** All sign flips of the non-zero entries of v. */
function signCombos(v) {
  const nz = v.map((x, i) => (Math.abs(x) > 1e-12 ? i : -1)).filter((i) => i >= 0);
  const out = [];
  for (let mask = 0; mask < 1 << nz.length; mask++) {
    const c = v.slice();
    nz.forEach((idx, b) => { if (mask & (1 << b)) c[idx] = -c[idx]; });
    out.push(c);
  }
  return out;
}

function dedupe(verts, eps = 1e-6) {
  const out = [];
  const seen = new Set();
  for (const v of verts) {
    const key = v.map((x) => Math.round(x / eps)).join(',');
    if (!seen.has(key)) { seen.add(key); out.push(v); }
  }
  return out;
}

function permsOf(base, perms) {
  const out = [];
  for (const p of perms) {
    const v = [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) v[p[k]] = base[k];
    for (const s of signCombos(v)) out.push(s);
  }
  return dedupe(out);
}

// ---------------------------------------------------------------------------
// Vertex sets (all normalised to circumradius 1)

export function simplexVertices() {
  const s5 = Math.sqrt(5);
  return normalizeAll([
    [1, 1, 1, -1 / s5], [1, -1, -1, -1 / s5], [-1, 1, -1, -1 / s5], [-1, -1, 1, -1 / s5], [0, 0, 0, s5 - 1 / s5],
  ]);
}

export function tesseractVertices() {
  return permsOf([0.5, 0.5, 0.5, 0.5], [[0, 1, 2, 3]]);
}

export function orthoplexVertices() {
  return permsOf([1, 0, 0, 0], ALL_PERMS);
}

export function icositetrachoronVertices() {
  return normalizeAll(permsOf([1, 1, 0, 0], ALL_PERMS));
}

/** 24-cell dual vertices: (±1,0,0,0) perms and (±½,±½,±½,±½). */
function icositetrachoronDual() {
  return [...permsOf([1, 0, 0, 0], ALL_PERMS), ...permsOf([0.5, 0.5, 0.5, 0.5], [[0, 1, 2, 3]])];
}

export function hexacosichoronVertices() {
  return [
    ...permsOf([1, 0, 0, 0], ALL_PERMS),
    ...permsOf([0.5, 0.5, 0.5, 0.5], [[0, 1, 2, 3]]),
    ...permsOf([PHI / 2, 0.5, 1 / (2 * PHI), 0], EVEN_PERMS),
  ];
}

/** Find all tetrahedral 4-cliques at the given edge length (used for the 600-cell). */
function tetraCliques(verts, edgeLen) {
  const n = verts.length;
  const adj = Array.from({ length: n }, () => new Set());
  const e2 = edgeLen * edgeLen;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const d = V.distance(verts[i], verts[j]);
    if (Math.abs(d * d - e2) < 1e-6) { adj[i].add(j); adj[j].add(i); }
  }
  const tets = [];
  for (let a = 0; a < n; a++) for (const b of adj[a]) {
    if (b <= a) continue;
    for (const c of adj[a]) {
      if (c <= b || !adj[b].has(c)) continue;
      for (const d of adj[a]) {
        if (d <= c || !adj[b].has(d) || !adj[c].has(d)) continue;
        tets.push([a, b, c, d]);
      }
    }
  }
  return tets;
}

// ---------------------------------------------------------------------------
// Combinatorics

function sub3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross3(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm3(a) { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l]; }

/** Facets of the 3D convex hull of a small point set, each as a CCW-ordered index loop. */
function hullFaces3D(pts, eps = 1e-6) {
  const n = pts.length;
  const c = [0, 0, 0];
  for (const p of pts) { c[0] += p[0] / n; c[1] += p[1] / n; c[2] += p[2] / n; }
  const planes = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) {
    let nrm = cross3(sub3(pts[j], pts[i]), sub3(pts[k], pts[i]));
    const l = Math.hypot(nrm[0], nrm[1], nrm[2]);
    if (l < 1e-9) continue;
    nrm = [nrm[0] / l, nrm[1] / l, nrm[2] / l];
    let d = dot3(nrm, pts[i]);
    if (dot3(nrm, c) > d) { nrm = [-nrm[0], -nrm[1], -nrm[2]]; d = -d; }
    let ok = true;
    for (let m = 0; m < n; m++) if (dot3(nrm, pts[m]) - d > eps) { ok = false; break; }
    if (!ok) continue;
    if (planes.some((pl) => Math.abs(pl.d - d) < 1e-5 && dot3(pl.n, nrm) > 1 - 1e-6)) continue;
    planes.push({ n: nrm, d });
  }
  return planes.map(({ n: nrm, d }) => {
    const members = [];
    for (let m = 0; m < n; m++) if (Math.abs(dot3(nrm, pts[m]) - d) < eps * 10) members.push(m);
    const fc = [0, 0, 0];
    for (const m of members) { fc[0] += pts[m][0]; fc[1] += pts[m][1]; fc[2] += pts[m][2]; }
    fc[0] /= members.length; fc[1] /= members.length; fc[2] /= members.length;
    const u = norm3(sub3(pts[members[0]], fc));
    const v = cross3(nrm, u);
    members.sort((a, b) => {
      const pa = sub3(pts[a], fc), pb = sub3(pts[b], fc);
      return Math.atan2(dot3(pa, v), dot3(pa, u)) - Math.atan2(dot3(pb, v), dot3(pb, u));
    });
    return members;
  });
}

/** Orthonormal basis of the hyperplane orthogonal to unit vector n. */
function hyperplaneBasis(n) {
  const basis = [];
  const cands = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  cands.sort((a, b) => Math.abs(V.dot(a, n)) - Math.abs(V.dot(b, n)));
  for (const c of cands) {
    const v = c.slice();
    V.addScaled(v, v, n, -V.dot(v, n));
    for (const b of basis) V.addScaled(v, v, b, -V.dot(v, b));
    if (V.length(v) > 1e-6) basis.push(V.normalize(v, v));
    if (basis.length === 3) break;
  }
  return basis;
}

/**
 * Build the full face lattice (vertices, edges, 2-faces, cells) of a convex
 * polytope from its vertices and cell normal directions.
 */
export function buildPolytope(name, vertices, cellNormals) {
  const faces = [];
  const faceIndex = new Map();
  const cells = [];
  const edgeSet = new Map();

  for (const rawN of cellNormals) {
    const n = V.normalize([0, 0, 0, 0], rawN);
    let max = -Infinity;
    for (const v of vertices) max = Math.max(max, V.dot(v, n));
    const members = [];
    vertices.forEach((v, i) => { if (V.dot(v, n) > max - 1e-5) members.push(i); });
    if (members.length < 4) continue;

    const center = V.mean(members.map((i) => vertices[i]));
    const basis = hyperplaneBasis(n);
    const local = members.map((i) => {
      const d = V.sub([0, 0, 0, 0], vertices[i], center);
      return [V.dot(d, basis[0]), V.dot(d, basis[1]), V.dot(d, basis[2])];
    });
    const loops = hullFaces3D(local);
    const cellFaces = [];
    for (const loop of loops) {
      const verts = loop.map((m) => members[m]);
      const key = verts.slice().sort((a, b) => a - b).join(',');
      let fi = faceIndex.get(key);
      if (fi === undefined) {
        fi = faces.length;
        faceIndex.set(key, fi);
        faces.push({ verts, center: V.mean(verts.map((i) => vertices[i])) });
        for (let k = 0; k < verts.length; k++) {
          const a = verts[k], b = verts[(k + 1) % verts.length];
          const ek = a < b ? `${a},${b}` : `${b},${a}`;
          if (!edgeSet.has(ek)) edgeSet.set(ek, [Math.min(a, b), Math.max(a, b)]);
        }
      }
      cellFaces.push(fi);
    }
    cells.push({ verts: members, faces: cellFaces, center, normal: n });
  }

  const circumradius = Math.max(...vertices.map((v) => V.length(v)));
  return { name, vertices, edges: [...edgeSet.values()], faces, cells, circumradius };
}

// ---------------------------------------------------------------------------
// Catalogue

const cache = new Map();
function cached(key, fn) {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
}

export function simplex() {
  return cached('5-cell', () => {
    const v = simplexVertices();
    return buildPolytope('5-cell', v, v.map((p) => V.scale([0, 0, 0, 0], p, -1)));
  });
}

export function tesseract() {
  return cached('8-cell', () => buildPolytope('Tesseract', tesseractVertices(), orthoplexVertices()));
}

export function orthoplex() {
  return cached('16-cell', () => buildPolytope('16-cell', orthoplexVertices(), tesseractVertices()));
}

export function icositetrachoron() {
  return cached('24-cell', () => buildPolytope('24-cell', icositetrachoronVertices(), icositetrachoronDual()));
}

export function hexacosichoron() {
  return cached('600-cell', () => {
    const v = hexacosichoronVertices();
    const tets = tetraCliques(v, 1 / PHI);
    const normals = tets.map((t) => V.mean(t.map((i) => v[i])));
    return buildPolytope('600-cell', v, normals);
  });
}

export function hecatonicosachoron() {
  return cached('120-cell', () => {
    const v600 = hexacosichoronVertices();
    const tets = tetraCliques(v600, 1 / PHI);
    const verts = normalizeAll(tets.map((t) => V.mean(t.map((i) => v600[i]))));
    return buildPolytope('120-cell', verts, v600);
  });
}

/** p-q duoprism: product of a regular p-gon (xy) and q-gon (zw). */
export function duoprism(p, q) {
  return cached(`duoprism-${p}-${q}`, () => {
    const verts = [];
    const r = 1 / Math.SQRT2;
    for (let i = 0; i < p; i++) for (let j = 0; j < q; j++) {
      const a = (i / p) * Math.PI * 2, b = (j / q) * Math.PI * 2;
      verts.push([r * Math.cos(a), r * Math.sin(a), r * Math.cos(b), r * Math.sin(b)]);
    }
    const normals = [];
    for (let i = 0; i < p; i++) { const a = ((i + 0.5) / p) * Math.PI * 2; normals.push([Math.cos(a), Math.sin(a), 0, 0]); }
    for (let j = 0; j < q; j++) { const b = ((j + 0.5) / q) * Math.PI * 2; normals.push([0, 0, Math.cos(b), Math.sin(b)]); }
    return buildPolytope(`${p}-${q} duoprism`, verts, normals);
  });
}

export const POLYTOPES = {
  simplex, tesseract, orthoplex, icositetrachoron, hexacosichoron, hecatonicosachoron,
};
