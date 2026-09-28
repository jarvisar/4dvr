// 4D rotations as row-major 4x4 matrices (Float64Array(16), m[r * 4 + c]) and
// bivectors (angular velocity / momentum) as 6-component arrays in the plane
// order [xy, xz, xw, yz, yw, zw].
//
// A bivector B is identified with the skew-symmetric matrix Ω where
// Ω[i][j] = B_ij and Ω[j][i] = -B_ij (i < j). The velocity of a point at
// offset r from the rotation center is v = Ω r.

export const PLANES = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
export const PLANE_NAMES = ['xy', 'xz', 'xw', 'yz', 'yw', 'zw'];
// PLANES as flat index tables, for hot loops (no per-iteration array destructuring)
const PI = [0, 0, 0, 1, 1, 2];
const PJ = [1, 2, 3, 2, 3, 3];

export function mat4() {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function identity(out) {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

export function copy(out, a) {
  out.set(a);
  return out;
}

const _tmpA = new Float64Array(16);
const _tmpB = new Float64Array(16);
const _tmpC = new Float64Array(16);

// out = a * b (out may alias a or b)
export function multiply(out, a, b) {
  const t = _tmpA;
  for (let r = 0; r < 4; r++) {
    const a0 = a[r * 4], a1 = a[r * 4 + 1], a2 = a[r * 4 + 2], a3 = a[r * 4 + 3];
    t[r * 4] = a0 * b[0] + a1 * b[4] + a2 * b[8] + a3 * b[12];
    t[r * 4 + 1] = a0 * b[1] + a1 * b[5] + a2 * b[9] + a3 * b[13];
    t[r * 4 + 2] = a0 * b[2] + a1 * b[6] + a2 * b[10] + a3 * b[14];
    t[r * 4 + 3] = a0 * b[3] + a1 * b[7] + a2 * b[11] + a3 * b[15];
  }
  out.set(t);
  return out;
}

export function transpose(out, a) {
  const t = _tmpA;
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) t[c * 4 + r] = a[r * 4 + c];
  out.set(t);
  return out;
}

// out = m * v
export function apply(out, m, v) {
  const x = v[0], y = v[1], z = v[2], w = v[3];
  out[0] = m[0] * x + m[1] * y + m[2] * z + m[3] * w;
  out[1] = m[4] * x + m[5] * y + m[6] * z + m[7] * w;
  out[2] = m[8] * x + m[9] * y + m[10] * z + m[11] * w;
  out[3] = m[12] * x + m[13] * y + m[14] * z + m[15] * w;
  return out;
}

// out = transpose(m) * v, the inverse rotation for orthonormal m
export function applyT(out, m, v) {
  const x = v[0], y = v[1], z = v[2], w = v[3];
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12] * w;
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13] * w;
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
  out[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
  return out;
}

// Rotation by `angle` in the coordinate plane (i, j), turning e_i toward e_j
export function planeRotation(out, i, j, angle) {
  identity(out);
  const c = Math.cos(angle), s = Math.sin(angle);
  out[i * 4 + i] = c; out[j * 4 + j] = c;
  out[j * 4 + i] = s; out[i * 4 + j] = -s;
  return out;
}

// Rotation by `angle` in the plane spanned by orthonormal vectors a and b,
// turning a toward b. R = I + sinθ (b aᵀ − a bᵀ) + (cosθ − 1)(a aᵀ + b bᵀ)
export function rotationInPlane(out, a, b, angle) {
  const s = Math.sin(angle), c1 = Math.cos(angle) - 1;
  for (let r = 0; r < 4; r++) {
    for (let col = 0; col < 4; col++) {
      out[r * 4 + col] = (r === col ? 1 : 0) + s * (b[r] * a[col] - a[r] * b[col]) + c1 * (a[r] * a[col] + b[r] * b[col]);
    }
  }
  return out;
}

// Embeds a THREE.Quaternion (3D rotation) in the xyz block
export function fromQuaternion(out, q) {
  const x = q.x, y = q.y, z = q.z, w = q.w;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  out[0] = 1 - (yy + zz); out[1] = xy - wz; out[2] = xz + wy; out[3] = 0;
  out[4] = xy + wz; out[5] = 1 - (xx + zz); out[6] = yz - wx; out[7] = 0;
  out[8] = xz - wy; out[9] = yz + wx; out[10] = 1 - (xx + yy); out[11] = 0;
  out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1;
  return out;
}

// Gram-Schmidt on the rows to fix numerical drift
export function orthonormalize(m) {
  for (let r = 0; r < 4; r++) {
    for (let p = 0; p < r; p++) {
      let d = 0;
      for (let c = 0; c < 4; c++) d += m[r * 4 + c] * m[p * 4 + c];
      for (let c = 0; c < 4; c++) m[r * 4 + c] -= d * m[p * 4 + c];
    }
    let l = 0;
    for (let c = 0; c < 4; c++) l += m[r * 4 + c] * m[r * 4 + c];
    l = 1 / Math.sqrt(l);
    for (let c = 0; c < 4; c++) m[r * 4 + c] *= l;
  }
  return m;
}

// Skew matrix Ω = s·B
export function skew(out, B, s = 1) {
  out.fill(0);
  for (let k = 0; k < 6; k++) {
    const i = PI[k], j = PJ[k];
    out[i * 4 + j] = B[k] * s;
    out[j * 4 + i] = -B[k] * s;
  }
  return out;
}

// out = exp(s·B) as a rotation matrix. Uses scaling and squaring with a 4th
// order Taylor series (accurate enough for the angles used here), then
// re-orthonormalizes the result.
export function expBivector(out, B, s = 1) {
  let n = 0;
  for (let k = 0; k < 6; k++) n = Math.max(n, Math.abs(B[k] * s));
  let squarings = 0;
  while (n > 0.25 && squarings < 12) { n *= 0.5; squarings++; }
  const f = s / (1 << squarings);
  const A = skew(_tmpB, B, f);
  // T = I + A + A²/2 + A³/6 + A⁴/24, evaluated Horner style as I + A(I + A/2(I + A/3(I + A/4)))
  const T = identity(out);
  const tmp = _tmpC;
  for (let k = 4; k >= 1; k--) {
    multiply(tmp, A, T);
    for (let e = 0; e < 16; e++) T[e] = tmp[e] / k + (e % 5 === 0 ? 1 : 0);
  }
  for (let q = 0; q < squarings; q++) multiply(T, T, T);
  return orthonormalize(T);
}

// ---------------------------------------------------------------------------
// Bivectors

export function biv() {
  return [0, 0, 0, 0, 0, 0];
}

// Angular impulse of linear impulse J applied at offset r. B_ij = J_i r_j − r_i J_j
export function angularImpulse(out, r, J) {
  const r0 = r[0], r1 = r[1], r2 = r[2], r3 = r[3];
  const J0 = J[0], J1 = J[1], J2 = J[2], J3 = J[3];
  out[0] = J0 * r1 - r0 * J1;
  out[1] = J0 * r2 - r0 * J2;
  out[2] = J0 * r3 - r0 * J3;
  out[3] = J1 * r2 - r1 * J2;
  out[4] = J1 * r3 - r1 * J3;
  out[5] = J2 * r3 - r2 * J3;
  return out;
}

// v = Ω r, the linear velocity of offset r under angular velocity B
export function bivApply(out, B, r) {
  const r0 = r[0], r1 = r[1], r2 = r[2], r3 = r[3];
  out[0] = B[0] * r1 + B[1] * r2 + B[2] * r3;
  out[1] = -B[0] * r0 + B[3] * r2 + B[4] * r3;
  out[2] = -B[1] * r0 - B[3] * r1 + B[5] * r3;
  out[3] = -B[2] * r0 - B[4] * r1 - B[5] * r2;
  return out;
}

const _S = new Float64Array(16);
const _T = new Float64Array(16);

// out = R Ω Rᵀ, rotates a bivector from body to world
export function bivRotate(out, R, B) {
  skew(_S, B);
  multiply(_T, R, _S);
  // (_T Rᵀ)_ij = Σ_k _T[i][k] R[j][k]
  for (let k = 0; k < 6; k++) {
    const i = PI[k], j = PJ[k];
    let s = 0;
    for (let c = 0; c < 4; c++) s += _T[i * 4 + c] * R[j * 4 + c];
    out[k] = s;
  }
  return out;
}

// out = Rᵀ Ω R, rotates a bivector from world to body
export function bivRotateInv(out, R, B) {
  skew(_S, B);
  // _T = Rᵀ Ω
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += R[k * 4 + r] * _S[k * 4 + c];
    _T[r * 4 + c] = s;
  }
  for (let k = 0; k < 6; k++) {
    const i = PI[k], j = PJ[k];
    let s = 0;
    for (let c = 0; c < 4; c++) s += _T[i * 4 + c] * R[c * 4 + j];
    out[k] = s;
  }
  return out;
}

export function bivNorm(B) {
  let s = 0;
  for (let k = 0; k < 6; k++) s += B[k] * B[k];
  return Math.sqrt(s);
}

// Writes a 4D rotation (plus scale) into a THREE.Matrix4 so a GLSL
// `mat4 * vec4` gives R·v. THREE.Matrix4.set takes row-major input.
export function toThreeMatrix(m4, R, s = 1) {
  // s: uniform scale, or a per-axis [sx, sy, sz, sw] applied before rotating (R · diag(s))
  const a = typeof s === 'number' ? s : s[0], b = typeof s === 'number' ? s : s[1];
  const c = typeof s === 'number' ? s : s[2], d = typeof s === 'number' ? s : s[3];
  m4.set(
    R[0] * a, R[1] * b, R[2] * c, R[3] * d,
    R[4] * a, R[5] * b, R[6] * c, R[7] * d,
    R[8] * a, R[9] * b, R[10] * c, R[11] * d,
    R[12] * a, R[13] * b, R[14] * c, R[15] * d,
  );
  return m4;
}

// Random rotation, built from a random rotation in each plane
export function randomRotation(out, rng = Math.random) {
  identity(out);
  const t = new Float64Array(16);
  for (let k = 0; k < 6; k++) {
    const [i, j] = PLANES[k];
    planeRotation(t, i, j, rng() * Math.PI * 2);
    multiply(out, t, out);
  }
  return out;
}
