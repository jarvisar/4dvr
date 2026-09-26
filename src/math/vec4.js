// Small allocation-free 4D vector helpers. Vectors are plain arrays [x, y, z, w].
// Every function writes into `out` and returns it so calls can be chained.

export function v4(x = 0, y = 0, z = 0, w = 0) {
  return [x, y, z, w];
}

export function set(out, x, y, z, w) {
  out[0] = x; out[1] = y; out[2] = z; out[3] = w;
  return out;
}

export function copy(out, a) {
  out[0] = a[0]; out[1] = a[1]; out[2] = a[2]; out[3] = a[3];
  return out;
}

export function add(out, a, b) {
  out[0] = a[0] + b[0]; out[1] = a[1] + b[1]; out[2] = a[2] + b[2]; out[3] = a[3] + b[3];
  return out;
}

export function sub(out, a, b) {
  out[0] = a[0] - b[0]; out[1] = a[1] - b[1]; out[2] = a[2] - b[2]; out[3] = a[3] - b[3];
  return out;
}

export function scale(out, a, s) {
  out[0] = a[0] * s; out[1] = a[1] * s; out[2] = a[2] * s; out[3] = a[3] * s;
  return out;
}

/** out = a + b * s */
export function addScaled(out, a, b, s) {
  out[0] = a[0] + b[0] * s; out[1] = a[1] + b[1] * s; out[2] = a[2] + b[2] * s; out[3] = a[3] + b[3] * s;
  return out;
}

export function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
}

export function lengthSq(a) {
  return a[0] * a[0] + a[1] * a[1] + a[2] * a[2] + a[3] * a[3];
}

export function length(a) {
  return Math.sqrt(lengthSq(a));
}

export function distance(a, b) {
  const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2], w = a[3] - b[3];
  return Math.sqrt(x * x + y * y + z * z + w * w);
}

export function normalize(out, a) {
  const l = length(a);
  return l > 1e-12 ? scale(out, a, 1 / l) : set(out, 0, 0, 0, 0);
}

export function lerp(out, a, b, t) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  out[3] = a[3] + (b[3] - a[3]) * t;
  return out;
}

function det3(a0, a1, a2, b0, b1, b2, c0, c1, c2) {
  return a0 * (b1 * c2 - b2 * c1) - a1 * (b0 * c2 - b2 * c0) + a2 * (b0 * c1 - b1 * c0);
}

/**
 * Generalised cross product: returns a vector orthogonal to a, b and c
 * (the cofactor expansion of det[e; a; b; c]).
 */
export function cross4(out, a, b, c) {
  const x = det3(a[1], a[2], a[3], b[1], b[2], b[3], c[1], c[2], c[3]);
  const y = -det3(a[0], a[2], a[3], b[0], b[2], b[3], c[0], c[2], c[3]);
  const z = det3(a[0], a[1], a[3], b[0], b[1], b[3], c[0], c[1], c[3]);
  const w = -det3(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  return set(out, x, y, z, w);
}

export function mean(points) {
  const m = [0, 0, 0, 0];
  for (const p of points) add(m, m, p);
  return scale(m, m, 1 / points.length);
}
