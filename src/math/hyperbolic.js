// Hyperbolic 3-space in the hyperboloid model: points p with ⟨p,p⟩ = −1,
// p.w > 0, where ⟨a,b⟩ = ax·bx + ay·by + az·bz − aw·bw. Isometries are 4×4
// Lorentz matrices (row-major Float64Array, same layout as rot4.js).

import * as R4 from './rot4.js';

export function mdot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] - a[3] * b[3];
}

export const ORIGIN = [0, 0, 0, 1];

/** Hyperbolic distance between two hyperboloid points. */
export function hdist(a, b) {
  return Math.acosh(Math.max(1, -mdot(a, b)));
}

/** Boost (translation) moving the origin by distance |v| in direction v. */
export function boost(out, v) {
  const d = Math.hypot(v[0], v[1], v[2]);
  R4.identity(out);
  if (d < 1e-12) return out;
  const n = [v[0] / d, v[1] / d, v[2] / d];
  const c = Math.cosh(d), s = Math.sinh(d);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) out[i * 4 + j] = (i === j ? 1 : 0) + (c - 1) * n[i] * n[j];
    out[i * 4 + 3] = s * n[i];
    out[3 * 4 + i] = s * n[i];
  }
  out[15] = c;
  return out;
}

/** Reflection in the plane {x : ⟨x,n⟩ = 0} for a unit spacelike normal n. */
export function reflection(out, n) {
  const Jn = [n[0], n[1], n[2], -n[3]];
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) out[i * 4 + j] = (i === j ? 1 : 0) - 2 * n[i] * Jn[j];
  return out;
}

/** Map a point to the hyperboloid from Klein (projective) coordinates. */
export function fromKlein(k) {
  const s = 1 / Math.sqrt(1 - (k[0] * k[0] + k[1] * k[1] + k[2] * k[2]));
  return [k[0] * s, k[1] * s, k[2] * s, s];
}

/** Lorentz inverse: J Mᵀ J. */
const _J = [1, 1, 1, -1];
const _inv = new Float64Array(16);
export function lorentzInverse(out, M) {
  const t = _inv;
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) t[i * 4 + j] = _J[i] * M[j * 4 + i] * _J[j];
  out.set(t);
  return out;
}

/**
 * Re-orthonormalise a Lorentz matrix (columns are the images of the basis
 * vectors). Gram–Schmidt with the Minkowski product, timelike column first.
 */
export function lorentzOrthonormalize(M) {
  const col = (j) => [M[j], M[4 + j], M[8 + j], M[12 + j]];
  const setCol = (j, v) => { M[j] = v[0]; M[4 + j] = v[1]; M[8 + j] = v[2]; M[12 + j] = v[3]; };
  const t = col(3);
  const tn = Math.sqrt(Math.max(1e-12, -mdot(t, t)));
  for (let i = 0; i < 4; i++) t[i] /= tn;
  setCol(3, t);
  const done = [t];
  for (let j = 0; j < 3; j++) {
    const v = col(j);
    for (const u of done) {
      const uu = mdot(u, u); // −1 for t, +1 for spacelike
      const k = mdot(v, u) / uu;
      for (let i = 0; i < 4; i++) v[i] -= k * u[i];
    }
    const n = Math.sqrt(Math.max(1e-12, mdot(v, v)));
    for (let i = 0; i < 4; i++) v[i] /= n;
    setCol(j, v);
    done.push(v);
  }
  return M;
}

/** Minkowski-orthogonal complement helper: x with ⟨x,a⟩ = ⟨x,b⟩ = ⟨x,c⟩ = 0. */
export function mcross(out, a, b, c) {
  const Ja = [a[0], a[1], a[2], -a[3]], Jb = [b[0], b[1], b[2], -b[3]], Jc = [c[0], c[1], c[2], -c[3]];
  // Euclidean cofactor cross of the J-flipped vectors
  const det3 = (a0, a1, a2, b0, b1, b2, c0, c1, c2) => a0 * (b1 * c2 - b2 * c1) - a1 * (b0 * c2 - b2 * c0) + a2 * (b0 * c1 - b1 * c0);
  out[0] = det3(Ja[1], Ja[2], Ja[3], Jb[1], Jb[2], Jb[3], Jc[1], Jc[2], Jc[3]);
  out[1] = -det3(Ja[0], Ja[2], Ja[3], Jb[0], Jb[2], Jb[3], Jc[0], Jc[2], Jc[3]);
  out[2] = det3(Ja[0], Ja[1], Ja[3], Jb[0], Jb[1], Jb[3], Jc[0], Jc[1], Jc[3]);
  out[3] = -det3(Ja[0], Ja[1], Ja[2], Jb[0], Jb[1], Jb[2], Jc[0], Jc[1], Jc[2]);
  return out;
}
