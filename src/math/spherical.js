// The 3-sphere S³: unit vectors [x, y, z, w] in R⁴, with the origin at
// (0, 0, 0, 1). Distances are angles (radians). Isometries are orthogonal 4×4
// matrices, in the same row-major layout as rot4.js, so moving through S³ is
// rotating R⁴.

export const ORIGIN = [0, 0, 0, 1];
const _n = [0, 0, 0];

export function dot4(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

// Distance between two points of S³, which is the angle between them
export function sdist(a, b) {
  return Math.acos(Math.min(1, Math.max(-1, dot4(a, b))));
}

// Translation by the tangent vector v at the origin. This is the rotation of R⁴
// in the plane of (0,0,0,1) and v that moves the origin a distance |v| along v.
// Filled in directly from R = I + sin d (b aᵀ − a bᵀ) + (cos d − 1)(a aᵀ + b bᵀ)
// with a = e_w and b = (v/|v|, 0), so it doesn't allocate.
export function translation(out, vx, vy, vz) {
  const d = Math.sqrt(vx * vx + vy * vy + vz * vz);
  out.fill(0);
  if (d < 1e-12) {
    out[0] = out[5] = out[10] = out[15] = 1;
    return out;
  }
  const n = _n;
  n[0] = vx / d; n[1] = vy / d; n[2] = vz / d;
  const c = Math.cos(d), s = Math.sin(d), c1 = c - 1;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) out[i * 4 + j] = (i === j ? 1 : 0) + c1 * n[i] * n[j];
    out[i * 4 + 3] = s * n[i];
    out[12 + i] = -s * n[i];
  }
  out[15] = c;
  return out;
}

// Point at distance |v| from the origin in the direction of v (exponential map)
export function expOrigin(v) {
  const d = Math.hypot(v[0], v[1], v[2]);
  if (d < 1e-12) return ORIGIN.slice();
  const s = Math.sin(d) / d;
  return [v[0] * s, v[1] * s, v[2] * s, Math.cos(d)];
}

// Point a fraction t of the way along the shorter great-circle arc from a to b
export function slerp4(a, b, t) {
  const th = sdist(a, b);
  if (th < 1e-9) return a.slice();
  const s = Math.sin(th);
  const ka = Math.sin((1 - t) * th) / s, kb = Math.sin(t * th) / s;
  return [0, 1, 2, 3].map((i) => ka * a[i] + kb * b[i]);
}
