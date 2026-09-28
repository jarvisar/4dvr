// Collision shapes for 4D rigid bodies.
//
// Each shape has a signed distance function in body space and a set of
// surface sample points. Contacts between two bodies come from testing each
// body's samples against the other's SDF. This works for curved shapes like
// duocylinders and tigers without shape-specific contact code. Hyperspheres
// are handled separately.

import { icosphere } from '../four/tetmesh.js';
import { PLANES } from '../math/rot4.js';

const hyp = Math.hypot;
// Math.hypot is much slower than sqrt of a sum of squares (V8 does not inline
// it), and the SDFs below run for every sample point of every body pair each
// substep. Magnitudes here are far from overflow, so the plain form is exact enough.
const len2 = (a, b) => Math.sqrt(a * a + b * b);
const len3 = (a, b, c) => Math.sqrt(a * a + b * b + c * c);
const len4 = (a, b, c, d) => Math.sqrt(a * a + b * b + c * c + d * d);
const _q = [0, 0, 0, 0];

function comboSDF(a, b, c) {
  // exact SDF of a product of convex sets given per-factor distances
  const ox = Math.max(a, 0), oy = Math.max(b, 0), oz = c === undefined ? 0 : Math.max(c, 0);
  const outside = Math.sqrt(ox * ox + oy * oy + oz * oz);
  const inside = Math.min(Math.max(a, b, c === undefined ? -Infinity : c), 0);
  return outside + inside;
}

function circle(n, r, phase = 0) {
  const out = [];
  for (let i = 0; i < n; i++) { const a = phase + (i / n) * Math.PI * 2; out.push([r * Math.cos(a), r * Math.sin(a)]); }
  return out;
}

function discPoints(r, rings = [[0.55, 6], [1, 10]]) {
  const pts = [[0, 0]];
  for (const [f, n] of rings) pts.push(...circle(n, r * f, f * 0.7));
  return pts;
}

export class Collider {
  constructor(desc, scale) {
    this.type = desc.type;
    const s = scale;
    this.scale = s;
    let samples = [];
    let moments = null; // E[x_i²] per axis, for the inertia tensor
    this.products = null; // E[x_i x_j] per plane [xy, xz, xw, yz, yw, zw], when not all zero

    switch (desc.type) {
      case 'sphere': {
        this.r = desc.r * s;
        this.bound = this.r;
        moments = [this.r ** 2 / 6, this.r ** 2 / 6, this.r ** 2 / 6, this.r ** 2 / 6];
        break;
      }
      case 'box': {
        this.h = desc.h.map((x) => x * s);
        const h = this.h;
        for (let m = 0; m < 16; m++) samples.push([0, 1, 2, 3].map((i) => (m & (1 << i) ? h[i] : -h[i])));
        // edge midpoints help with edge-on contacts
        for (let axis = 0; axis < 4; axis++) for (let m = 0; m < 16; m++) {
          if (m & (1 << axis)) continue;
          samples.push([0, 1, 2, 3].map((i) => (i === axis ? 0 : (m & (1 << i) ? h[i] : -h[i]))));
        }
        this.bound = hyp(...h);
        moments = h.map((x) => (x * x) / 3);
        break;
      }
      case 'boxes': {
        // union of axis-aligned boxes in body space: [{ c: center, h: half-sizes }]
        this.boxes = desc.boxes.map((bx) => ({ c: bx.c.map((x) => x * s), h: bx.h.map((x) => x * s) }));
        const seen = new Set();
        const addSample = (v) => {
          const k = v.map((x) => Math.round(x * 1e5)).join(',');
          if (!seen.has(k)) { seen.add(k); samples.push(v); }
        };
        let bound = 0;
        // second moments about the body origin, which must be the center of
        // mass (boxes weighted by volume, assumed not to overlap)
        const S = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
        const vol = this.boxes.reduce((acc, { h }) => acc + h[0] * h[1] * h[2] * h[3], 0);
        for (const { c, h } of this.boxes) {
          for (let mask = 0; mask < 16; mask++) addSample([0, 1, 2, 3].map((i) => c[i] + (mask & (1 << i) ? h[i] : -h[i])));
          for (let axis = 0; axis < 4; axis++) for (let mask = 0; mask < 16; mask++) {
            if (mask & (1 << axis)) continue;
            addSample([0, 1, 2, 3].map((i) => c[i] + (i === axis ? 0 : (mask & (1 << i) ? h[i] : -h[i]))));
          }
          bound = Math.max(bound, hyp(...c) + hyp(...h));
          const f = (h[0] * h[1] * h[2] * h[3]) / vol;
          for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) S[i][j] += f * (c[i] * c[j] + (i === j ? (h[i] * h[i]) / 3 : 0));
        }
        this.bound = bound;
        moments = [S[0][0], S[1][1], S[2][2], S[3][3]];
        // A union of boxes (like the chiral tetracube) usually has
        // E[x_i x_j] ≠ 0, so its body axes aren't principal axes.
        const products = PLANES.map(([i, j]) => S[i][j]);
        const scaleM = moments.reduce((a, b) => a + b, 0);
        if (products.some((p) => Math.abs(p) > scaleM * 1e-9)) this.products = products;
        break;
      }
      case 'convex': {
        this.planes = desc.planes.map((p) => [p[0], p[1], p[2], p[3], p[4] * s]);
        samples = desc.samples.map((v) => v.map((x) => x * s));
        this.bound = Math.max(...desc.verts.map((v) => hyp(...v))) * s;
        const e = desc.verts.reduce((acc, v) => acc + v[0] * v[0], 0) / desc.verts.length * s * s * 0.55;
        moments = [e, e, e, e];
        break;
      }
      case 'duocylinder': {
        this.r1 = desc.r1 * s; this.r2 = desc.r2 * s;
        for (const [x, y] of circle(14, this.r1)) for (const [z, w] of circle(14, this.r2, 0.1)) samples.push([x, y, z, w]);
        for (const [x, y] of circle(12, this.r1)) for (const [z, w] of discPoints(this.r2, [[0.55, 6]])) samples.push([x, y, z, w]);
        for (const [z, w] of circle(12, this.r2)) for (const [x, y] of discPoints(this.r1, [[0.55, 6]])) samples.push([x, y, z, w]);
        this.bound = hyp(this.r1, this.r2);
        moments = [this.r1 ** 2 / 4, this.r1 ** 2 / 4, this.r2 ** 2 / 4, this.r2 ** 2 / 4];
        break;
      }
      case 'spherinder': {
        this.r = desc.r * s; this.h = desc.h * s;
        const sph = icosphere(1).verts;
        for (const d of sph) for (const w of [-this.h, 0, this.h]) samples.push([d[0] * this.r, d[1] * this.r, d[2] * this.r, w]);
        for (const w of [-this.h, this.h]) for (const d of icosphere(0).verts) samples.push([d[0] * this.r * 0.55, d[1] * this.r * 0.55, d[2] * this.r * 0.55, w]);
        this.bound = hyp(this.r, this.h);
        moments = [this.r ** 2 / 5, this.r ** 2 / 5, this.r ** 2 / 5, this.h ** 2 / 3];
        break;
      }
      case 'cubinder': {
        this.r = desc.r * s; this.h = desc.h * s;
        const h = this.h;
        const sq = [];
        for (const a of [-h, 0, h]) for (const b of [-h, 0, h]) sq.push([a, b]);
        for (const [x, y] of circle(14, this.r)) for (const [z, w] of sq) samples.push([x, y, z, w]);
        for (const [x, y] of discPoints(this.r, [[0.55, 6]])) for (const [z, w] of [[-h, -h], [-h, h], [h, -h], [h, h], [0, h], [0, -h], [h, 0], [-h, 0]]) samples.push([x, y, z, w]);
        this.bound = hyp(this.r, h, h);
        moments = [this.r ** 2 / 4, this.r ** 2 / 4, (h * h) / 3, (h * h) / 3];
        break;
      }
      case 'tiger': {
        this.R1 = desc.R1 * s; this.R2 = desc.R2 * s; this.r = desc.r * s;
        const n1 = 10, n2 = 10, n3 = 5;
        for (let i = 0; i < n1; i++) for (let j = 0; j < n2; j++) for (let k = 0; k < n3; k++) {
          const a = (i / n1) * Math.PI * 2, b = (j / n2 + 0.05) * Math.PI * 2, c = (k / n3) * Math.PI * 2;
          const ra = this.R1 + this.r * Math.cos(c), rb = this.R2 + this.r * Math.sin(c);
          samples.push([ra * Math.cos(a), ra * Math.sin(a), rb * Math.cos(b), rb * Math.sin(b)]);
        }
        this.bound = hyp(this.R1, this.R2) + this.r;
        moments = [this.R1 ** 2 / 2, this.R1 ** 2 / 2, this.R2 ** 2 / 2, this.R2 ** 2 / 2];
        break;
      }
      case 'spheritorus': {
        this.R = desc.R * s; this.r = desc.r * s;
        const sph = icosphere(1).verts;
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          for (const d of sph) {
            const rho = this.R + this.r * d[0];
            samples.push([rho * Math.cos(a), rho * Math.sin(a), this.r * d[1], this.r * d[2]]);
          }
        }
        this.bound = this.R + this.r;
        moments = [this.R ** 2 / 2, this.R ** 2 / 2, this.r ** 2 / 5, this.r ** 2 / 5];
        break;
      }
      case 'torisphere': {
        this.R = desc.R * s; this.r = desc.r * s;
        const sph = icosphere(1).verts;
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          for (const d of sph) {
            const rho = this.R + this.r * Math.cos(a);
            samples.push([rho * d[0], rho * d[1], rho * d[2], this.r * Math.sin(a)]);
          }
        }
        this.bound = this.R + this.r;
        moments = [this.R ** 2 / 3, this.R ** 2 / 3, this.R ** 2 / 3, this.r ** 2 / 4]; // w: a solid disc of radius r
        break;
      }
      default:
        throw new Error(`Unknown collider ${desc.type}`);
    }
    this.samples = samples;
    this.moments = moments;
  }

  // Signed distance in body space. With limit set, the result is only exact up
  // to limit. A convex shape returns at the first face plane past it, so callers
  // that throw away far points can skip most of the planes.
  sdf(p, limit = Infinity) {
    const x = p[0], y = p[1], z = p[2], w = p[3];
    switch (this.type) {
      case 'sphere': return len4(x, y, z, w) - this.r;
      case 'box': {
        const h = this.h;
        const qx = Math.abs(x) - h[0], qy = Math.abs(y) - h[1], qz = Math.abs(z) - h[2], qw = Math.abs(w) - h[3];
        const out = len4(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0), Math.max(qw, 0));
        return out + Math.min(Math.max(qx, qy, qz, qw), 0);
      }
      case 'boxes': {
        let d = Infinity;
        for (const { c, h } of this.boxes) {
          const qx = Math.abs(x - c[0]) - h[0], qy = Math.abs(y - c[1]) - h[1], qz = Math.abs(z - c[2]) - h[2], qw = Math.abs(w - c[3]) - h[3];
          const e = len4(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0), Math.max(qw, 0)) + Math.min(Math.max(qx, qy, qz, qw), 0);
          if (e < d) d = e;
        }
        return d;
      }
      case 'convex': {
        let d = -Infinity;
        const planes = this.planes;
        for (let i = 0; i < planes.length; i++) {
          const pl = planes[i];
          const e = pl[0] * x + pl[1] * y + pl[2] * z + pl[3] * w - pl[4];
          if (e > d) { d = e; if (d > limit) return d; }
        }
        return d;
      }
      case 'duocylinder': return comboSDF(len2(x, y) - this.r1, len2(z, w) - this.r2);
      case 'spherinder': return comboSDF(len3(x, y, z) - this.r, Math.abs(w) - this.h);
      case 'cubinder': return comboSDF(len2(x, y) - this.r, Math.abs(z) - this.h, Math.abs(w) - this.h);
      case 'tiger': return len2(len2(x, y) - this.R1, len2(z, w) - this.R2) - this.r;
      case 'spheritorus': return len3(len2(x, y) - this.R, z, w) - this.r;
      case 'torisphere': return len2(len3(x, y, z) - this.R, w) - this.r;
    }
    return Infinity;
  }

  // Outward unit normal (SDF gradient) in body space
  normal(p, out) {
    if (this.type === 'sphere') {
      const l = len4(p[0], p[1], p[2], p[3]) || 1;
      out[0] = p[0] / l; out[1] = p[1] / l; out[2] = p[2] / l; out[3] = p[3] / l;
      return out;
    }
    if (this.type === 'convex') {
      let best = -Infinity, bi = 0;
      for (let i = 0; i < this.planes.length; i++) {
        const pl = this.planes[i];
        const d = pl[0] * p[0] + pl[1] * p[1] + pl[2] * p[2] + pl[3] * p[3] - pl[4];
        if (d > best) { best = d; bi = i; }
      }
      const pl = this.planes[bi];
      out[0] = pl[0]; out[1] = pl[1]; out[2] = pl[2]; out[3] = pl[3];
      return out;
    }
    const e = this.scale * 1e-3;
    const q = _q;
    q[0] = p[0]; q[1] = p[1]; q[2] = p[2]; q[3] = p[3];
    let l = 0;
    for (let i = 0; i < 4; i++) {
      q[i] = p[i] + e; const a = this.sdf(q);
      q[i] = p[i] - e; const b = this.sdf(q);
      q[i] = p[i];
      out[i] = a - b;
      l += out[i] * out[i];
    }
    l = Math.sqrt(l) || 1;
    for (let i = 0; i < 4; i++) out[i] /= l;
    return out;
  }
}
