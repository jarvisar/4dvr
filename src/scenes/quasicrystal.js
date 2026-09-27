// Quasicrystals: patterns that never repeat, as slices of higher-dimensional
// lattices.
//
// Take the cubic lattice Z⁵ and a 2D plane through it at an irrational angle.
// The lattice points close to the plane, flattened onto it, are the corners of
// a Penrose tiling of thick and thin rhombs. Moving the plane sideways through
// the hidden directions changes which points count as close: tiles rearrange
// three at a time (phason flips), while every patch that occurs still occurs
// everywhere. The same construction from Z⁶ gives a 3D tiling of two
// rhombohedra with icosahedral symmetry, the pattern of real quasicrystals
// (Shechtman, Nobel Prize 2011).
//
// The tilings are built with de Bruijn's dual method, which is equivalent: N
// families of parallel grid lines (planes in 3D) with normals e_j and offsets
// γ_j. Every point z where d of them cross, from d different families, gives
// one tile: a rhomb (rhombohedron) with the edges e_j of those families, at
// Σ K_j e_j, where K_j = ⌈z·e_j + γ_j⌉ counts the lines of each family below
// the crossing. Moving γ along the perpendicular-space vectors e⊥_j moves the
// slice through the hidden dimensions.

import * as THREE from 'three';
import { SceneBase } from './base.js';

const PHI = (1 + Math.sqrt(5)) / 2;

/** Grid of the Penrose tiling: e_j at 72° steps, e⊥_j at 144° steps. */
const PENROSE = {
  d: 2,
  axes: [0, 1, 2, 3, 4].map((j) => [Math.cos((2 * Math.PI * j) / 5), Math.sin((2 * Math.PI * j) / 5)]),
  perp: [0, 1, 2, 3, 4].map((j) => [Math.cos((4 * Math.PI * j) / 5), Math.sin((4 * Math.PI * j) / 5)]),
  // any generic offsets adding up to 0 give a Penrose tiling
  gamma: [0.1377, 0.2551, -0.0823, 0.3314, -0.6419],
};

/** The six icosahedral 5-fold axes (no two opposite), and their images in perpendicular space (φ → −1/φ). */
const ICOSA = (() => {
  const par = [[0, 1, PHI], [0, -1, PHI], [1, PHI, 0], [-1, PHI, 0], [PHI, 0, 1], [-PHI, 0, 1]];
  const per = par.map((v) => v.map((x) => (Math.abs(x) === PHI ? Math.sign(x) * (-1 / PHI) : x)));
  const unit = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
  return { d: 3, axes: par.map(unit), perp: per.map(unit), gamma: [0.1133, -0.2047, 0.3129, 0.0761, -0.1583, 0.2291] };
})();

function combinations(n, d) {
  const out = [];
  const rec = (start, acc) => {
    if (acc.length === d) { out.push(acc.slice()); return; }
    for (let i = start; i < n; i++) { acc.push(i); rec(i + 1, acc); acc.pop(); }
  };
  rec(0, []);
  return out;
}

/** Inverse of a 2×2 or 3×3 matrix (given as rows), flattened row-major. */
function invert(M) {
  if (M.length === 2) {
    const [[a, b], [c, d]] = M, det = a * d - b * c;
    return [d / det, -b / det, -c / det, a / det];
  }
  const [[a, b, c], [d, e, f], [g, h, i]] = M;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
    B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
    C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
  ];
}

for (const g of [PENROSE, ICOSA]) {
  g.sets = combinations(g.axes.length, g.d).map((set) => ({ set, inv: invert(set.map((j) => g.axes[j])) }));
}

const _z = [0, 0, 0], _n = [0, 0, 0], _rhs = [0, 0, 0], _base = [0, 0, 0], _lo = [0, 0, 0], _hi = [0, 0, 0];

/**
 * Tiles of the dual of a multigrid with offsets gamma, whose centres are within
 * `radius` (in edge lengths) of the origin. Each tile: { set, base, key }; its
 * corners are base + Σ c_a e_{set[a]} for c ∈ {0,1}^d.
 */
function dualTiles(grid, gamma, radius) {
  const { d, axes, sets } = grid;
  const N = axes.length;
  // a tile sits at about (N/d) times its crossing point, give or take its size
  const zMax = (radius * d) / N + 1.5;
  const tiles = [];
  for (const { set, inv } of sets) {
    // only crossings with |z·e_j| ≤ zMax can be in range
    for (let a = 0; a < d; a++) { _lo[a] = Math.ceil(gamma[set[a]] - zMax); _hi[a] = Math.floor(gamma[set[a]] + zMax); _n[a] = _lo[a]; }
    for (;;) {
      for (let a = 0; a < d; a++) _rhs[a] = _n[a] - gamma[set[a]];
      let zz = 0;
      for (let r = 0; r < d; r++) {
        let v = 0;
        for (let b = 0; b < d; b++) v += inv[r * d + b] * _rhs[b];
        _z[r] = v; zz += v * v;
      }
      if (zz <= zMax * zMax) {
        for (let b = 0; b < d; b++) _base[b] = 0;
        let k = 0;
        for (let m = 0; m < N; m++) {
          let K;
          if (m === set[k]) K = _n[k++];
          else {
            let s = gamma[m];
            for (let b = 0; b < d; b++) s += _z[b] * axes[m][b];
            K = Math.ceil(s);
          }
          for (let b = 0; b < d; b++) _base[b] += K * axes[m][b];
        }
        let cc = 0, key = '';
        for (let b = 0; b < d; b++) {
          let c = _base[b];
          for (let a = 0; a < d; a++) c += 0.5 * axes[set[a]][b];
          cc += c * c;
          key += `${Math.round(c * 1000)},`;
        }
        if (cc <= radius * radius) tiles.push({ set, base: _base.slice(0, d), key });
      }
      let a = 0;
      while (a < d && ++_n[a] > _hi[a]) { _n[a] = _lo[a]; a++; }
      if (a === d) break;
    }
  }
  return tiles;
}

// ---------------------------------------------------------------------------------

const FLOOR_VERT = /* glsl */ `
attribute vec3 aColor;
attribute vec2 aUV;
attribute float aBirth;
varying vec3 vColor;
varying vec2 vUV;
varying float vBirth;
varying vec3 vPos;
void main() {
  vColor = aColor; vUV = aUV; vBirth = aBirth;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vPos = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const FLOOR_FRAG = /* glsl */ `
uniform float uTime;
uniform float uRadius; // the tiling is complete out to here
uniform vec3 uHorizon; // the sky's colours (see environment.js)
uniform vec3 uBottom;
varying vec3 vColor;
varying vec2 vUV;
varying float vBirth;
varying vec3 vPos;
void main() {
  // a round edge: past it the outermost tiles leave a ragged border
  float rad = length(vPos.xz);
  if (rad > uRadius) discard;
  // edge lines (uv are the rhomb's two edge coordinates, 0..1)
  vec2 e = min(vUV, 1.0 - vUV);
  vec2 fw = max(fwidth(vUV), vec2(1e-5));
  float line = 1.0 - smoothstep(0.0, 1.6, min(e.x / fw.x, e.y / fw.y));
  float glow = exp(-(uTime - vBirth) * 1.6); // tiles that just flipped
  vec3 col = mix(vColor, vec3(1.0, 0.98, 0.82), glow) + vec3(0.35, 0.3, 0.15) * glow;
  col = mix(col, vec3(0.13, 0.12, 0.16), line * 0.85);
  // fade into the sky seen just past the edge (below the horizon), so the edge doesn't show
  float below = clamp(-normalize(vPos - cameraPosition).y, 0.0, 1.0);
  col = mix(col, mix(uHorizon, uBottom, pow(below, 0.4)), smoothstep(uRadius * 0.7, uRadius, rad));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const CRYSTAL_VERT = /* glsl */ `
attribute vec3 aColor;
attribute float aBirth;
varying vec3 vColor;
varying float vBirth;
void main() {
  vColor = aColor; vBirth = aBirth;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const CRYSTAL_FRAG = /* glsl */ `
uniform float uTime;
uniform float uAlpha;
uniform float uGlowOnly;
varying vec3 vColor;
varying float vBirth;
void main() {
  float glow = exp(-(uTime - vBirth) * 1.6);
  vec3 col = mix(vColor, vec3(1.0, 0.88, 0.45), glow);
  if (uGlowOnly > 0.5) {
    // faces: faint, except tiles that just flipped (additive, so no sorting needed)
    gl_FragColor = vec4(col * (uAlpha + glow * 0.45), 1.0);
  } else {
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
}
`;

const THICK = new THREE.Color('#f2cc8f'), THIN = new THREE.Color('#81b29a');
const PROLATE = new THREE.Color('#ff8fb1'), OBLATE = new THREE.Color('#7fd1ff');
const _c = new THREE.Color();

/** Mark the first `count` vertices of each attribute for upload (the buffers are sized for the most tiles). */
function uploadFirst(attrs, count) {
  if (count <= 0) return;
  for (const a of Object.values(attrs)) {
    a.clearUpdateRanges(); // replaces a pending range: nothing past `count` is drawn
    a.addUpdateRange(0, count * a.itemSize);
    a.needsUpdate = true;
  }
}

function dynamicGeometry(verts, attrs) {
  const g = new THREE.BufferGeometry();
  for (const [name, size] of attrs) g.setAttribute(name, new THREE.BufferAttribute(new Float32Array(verts * size), size).setUsage(THREE.DynamicDrawUsage));
  return g;
}

/** Keep the birth time of tiles that were already there; new ones are born now (and glow). */
function birthOf(prev, next, key, time) {
  let born = prev.get(key);
  const isNew = born === undefined && prev.size > 0;
  if (born === undefined) born = isNew ? time : -100;
  next.set(key, born);
  return [born, isNew];
}

/** A Penrose floor around the viewer. */
class PenroseFloor {
  /** sky: the environment's sky uniforms, whose colours the edge fades into. */
  constructor(parent, sky, { edge = 0.28, radius = 3.4, capacity = 2600 } = {}) {
    this.edge = edge;
    this.radius = radius;
    this.capacity = capacity;
    this.births = new Map();
    // Tiles are kept if their centre is within radius, and every point of a
    // rhomb is within one edge length of its centre, so the tiling has no
    // holes out to radius − edge.
    this.uniforms = { uTime: { value: 0 }, uRadius: { value: radius - edge }, uHorizon: sky.uHorizon, uBottom: sky.uBottom };
    this.geo = dynamicGeometry(capacity * 4, [['position', 3], ['aColor', 3], ['aUV', 2], ['aBirth', 1]]);
    const index = new Uint32Array(capacity * 6);
    for (let i = 0; i < capacity; i++) index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    this.geo.setIndex(new THREE.BufferAttribute(index, 1));
    // a rhomb's corners go round clockwise or anticlockwise depending on its two edge directions
    this.mesh = new THREE.Mesh(this.geo, new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: FLOOR_VERT, fragmentShader: FLOOR_FRAG, side: THREE.DoubleSide }));
    this.mesh.frustumCulled = false;
    parent.add(this.mesh);
  }

  /** Rebuild for the slice offset delta (2D); returns how many tiles are new. */
  build(delta, time) {
    const g = PENROSE;
    const gamma = g.gamma.map((x, j) => x + delta[0] * g.perp[j][0] + delta[1] * g.perp[j][1]);
    const tiles = dualTiles(g, gamma, this.radius / this.edge);
    const n = Math.min(tiles.length, this.capacity);
    const A = this.geo.attributes;
    const pos = A.position.array, col = A.aColor.array, uv = A.aUV.array, birth = A.aBirth.array;
    const births = new Map();
    let flips = 0;
    for (let i = 0; i < n; i++) {
      const t = tiles[i];
      const [a, b] = t.set;
      const ea = g.axes[a], eb = g.axes[b];
      _c.copy(b - a === 1 || b - a === 4 ? THICK : THIN); // 72° or 144° between the two edges
      const [born, isNew] = birthOf(this.births, births, `${a}${b}:${t.key}`, time);
      if (isNew) flips++;
      for (let k = 0; k < 4; k++) {
        const ca = k === 1 || k === 2 ? 1 : 0, cb = k >= 2 ? 1 : 0;
        const v = i * 4 + k;
        pos[v * 3] = (t.base[0] + ca * ea[0] + cb * eb[0]) * this.edge;
        pos[v * 3 + 1] = 0;
        pos[v * 3 + 2] = (t.base[1] + ca * ea[1] + cb * eb[1]) * this.edge;
        col[v * 3] = _c.r; col[v * 3 + 1] = _c.g; col[v * 3 + 2] = _c.b;
        uv[v * 2] = ca; uv[v * 2 + 1] = cb;
        birth[v] = born;
      }
    }
    this.births = births;
    uploadFirst(A, n * 4);
    this.geo.setDrawRange(0, n * 6);
    this.count = n;
    return flips;
  }
}

// corners of the six faces and twelve edges of a parallelepiped, as c ∈ {0,1}³
const FACES = [[[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]], [[0, 0, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1]], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]];
const EDGES = [];
for (let axis = 0; axis < 3; axis++) for (let m = 0; m < 4; m++) {
  const others = [0, 1, 2].filter((x) => x !== axis);
  const p = [0, 0, 0];
  p[others[0]] = m & 1; p[others[1]] = (m >> 1) & 1;
  const q = p.slice();
  q[axis] = 1;
  EDGES.push(p, q);
}

/** The 3D icosahedral tiling (prolate and oblate rhombohedra), as a floating ball. */
class IcosaCrystal {
  constructor(parent, { edge = 0.07, radius = 0.34, capacity = 1600 } = {}) {
    this.edge = edge;
    this.radius = radius;
    this.capacity = capacity;
    this.births = new Map();
    this.group = new THREE.Group();
    parent.add(this.group);
    this.uniforms = { uTime: { value: 0 } };
    const attrs = [['position', 3], ['aColor', 3], ['aBirth', 1]];
    this.faceGeo = dynamicGeometry(capacity * 36, attrs);
    this.lineGeo = dynamicGeometry(capacity * 24, attrs);
    this.faces = new THREE.Mesh(this.faceGeo, new THREE.ShaderMaterial({
      uniforms: { uTime: this.uniforms.uTime, uAlpha: { value: 0.012 }, uGlowOnly: { value: 1 } }, vertexShader: CRYSTAL_VERT, fragmentShader: CRYSTAL_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      forceSinglePass: true, // additive, so back and front faces needn't be drawn in separate passes
    }));
    this.lines = new THREE.LineSegments(this.lineGeo, new THREE.ShaderMaterial({
      uniforms: { uTime: this.uniforms.uTime, uAlpha: { value: 1 }, uGlowOnly: { value: 0 } }, vertexShader: CRYSTAL_VERT, fragmentShader: CRYSTAL_FRAG,
    }));
    for (const o of [this.faces, this.lines]) { o.frustumCulled = false; this.group.add(o); }
    this._q = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  }

  /** Rebuild for the slice offset delta (3D); returns how many tiles are new. */
  build(delta, time) {
    const g = ICOSA;
    const gamma = g.gamma.map((x, j) => x + delta[0] * g.perp[j][0] + delta[1] * g.perp[j][1] + delta[2] * g.perp[j][2]);
    const tiles = dualTiles(g, gamma, this.radius / this.edge);
    const n = Math.min(tiles.length, this.capacity);
    const F = this.faceGeo.attributes, L = this.lineGeo.attributes;
    const births = new Map();
    const q = this._q;
    let flips = 0, fv = 0, lv = 0, born = 0;
    const put = (A, idx, p) => {
      A.position.array[idx * 3] = p[0]; A.position.array[idx * 3 + 1] = p[1]; A.position.array[idx * 3 + 2] = p[2];
      A.aColor.array[idx * 3] = _c.r; A.aColor.array[idx * 3 + 1] = _c.g; A.aColor.array[idx * 3 + 2] = _c.b;
      A.aBirth.array[idx] = born;
    };
    for (let i = 0; i < n; i++) {
      const t = tiles[i];
      const a = g.axes[t.set[0]], b = g.axes[t.set[1]], c = g.axes[t.set[2]];
      const corner = (cc, out) => {
        for (let k = 0; k < 3; k++) out[k] = (t.base[k] + cc[0] * a[k] + cc[1] * b[k] + cc[2] * c[k]) * this.edge;
        return out;
      };
      // prolate (acute) or oblate: |a · (b × c)| is 0.76 or 0.47 for unit icosahedral axes
      const vol = Math.abs(a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]));
      _c.copy(vol > 0.6 ? PROLATE : OBLATE);
      const r = birthOf(this.births, births, `${t.set.join('')}:${t.key}`, time);
      born = r[0];
      if (r[1]) flips++;
      for (const f of FACES) {
        for (let k = 0; k < 4; k++) corner(f[k], q[k]);
        put(F, fv++, q[0]); put(F, fv++, q[1]); put(F, fv++, q[2]);
        put(F, fv++, q[0]); put(F, fv++, q[2]); put(F, fv++, q[3]);
      }
      for (const cc of EDGES) put(L, lv++, corner(cc, q[0]));
    }
    this.births = births;
    uploadFirst(F, fv);
    uploadFirst(L, lv);
    this.faceGeo.setDrawRange(0, fv);
    this.lineGeo.setDrawRange(0, lv);
    this.count = n;
    return flips;
  }
}

const _v = new THREE.Vector3();

export class QuasicrystalScene extends SceneBase {
  constructor(app) {
    super(app);
    this.key = 'quasicrystal';
    this.title = 'Quasicrystals';
    this.short = 'Penrose';
    this.subtitle = 'Slices of 5D and 6D lattices';
    this.mood = 'quasi';
    this.drift = false;
    this.flipCount = 0;
    this.spin = 0;

    this.floor = new PenroseFloor(this.root, app.env.skyMat.uniforms);
    this.crystalCenter = new THREE.Vector3(0, 1.25, -0.9);
    this.crystal = new IcosaCrystal(this.root);
    this.crystal.group.position.copy(this.crystalCenter);
    this.reset();
    this.setMode('floor');
  }

  reset() {
    this.delta2 = [0, 0];
    this.delta3 = [0, 0, 0];
    this.floor.births.clear();
    this.crystal.births.clear();
    this.floor.build(this.delta2, 0);
    this.crystal.build(this.delta3, 0);
    this.dirty = false;
    this.flipCount = 0;
  }

  setMode(mode) {
    this.rebuild(this.app.time); // finish a pending move in the old mode
    this.mode = mode;
    this.crystal.group.visible = mode === 'crystal';
    this.desktopView = mode === 'crystal'
      ? { position: new THREE.Vector3(0, 1.45, 0.05), target: this.crystalCenter.clone() }
      : { position: new THREE.Vector3(0, 1.6, 0.6), target: new THREE.Vector3(0, 0.6, -1.4) };
    if (this.app.activeScene === this) {
      if (!this.app.presenting) {
        this.app.camera.position.copy(this.desktopView.position);
        this.app.orbit.target.copy(this.desktopView.target);
        this.app.orbit.update();
      }
      this.app.menu.rebuild();
    }
  }

  onUserReady() {
    this.crystalCenter.y = THREE.MathUtils.clamp(this.app.headPosition.y - 0.25, 1.0, 1.6);
    this.crystal.group.position.copy(this.crystalCenter);
  }

  /** Move the slice through the hidden directions (in edge lengths of the lattice). */
  shift(dx, dy, dz) {
    if (this.mode === 'floor') { this.delta2[0] += dx; this.delta2[1] += dy; } else { this.delta3[0] += dx; this.delta3[1] += dy; this.delta3[2] += dz; }
    this.dirty = true; // rebuilt in update(), at most ~15 times a second: a rebuild takes a few ms
  }

  /** Rebuild the current tiling now if the slice moved. */
  rebuild(time) {
    if (!this.dirty) return;
    this.dirty = false;
    this.builtAt = time;
    this.flipCount += this.mode === 'floor' ? this.floor.build(this.delta2, time) : this.crystal.build(this.delta3, time);
  }

  onEmptyGrabStart(ix) {
    this.pull = { last: ix.grabPos.clone() };
    return true;
  }

  onEmptyGrabUpdate(ix) {
    if (!this.pull) return;
    const d = _v.copy(ix.grabPos).sub(this.pull.last);
    this.pull.last.copy(ix.grabPos);
    if (d.lengthSq() < 1e-10) return;
    const k = ix.isMouse ? 2.5 : 3.0;
    if (this.mode === 'floor') this.shift(d.x * k, d.z * k, 0);
    else this.shift(d.x * k, d.y * k, d.z * k);
    this.app.hands.readout(ix, `${this.flipCount} tiles flipped`);
  }

  onEmptyGrabEnd() { this.pull = null; }

  update(dt, time) {
    for (const ix of this.app.input.xr) {
      if (ix.kind === 'controller' && (ix.stick.x || ix.stick.y)) {
        this.shift(ix.stick.x * dt * 0.6, ix.stick.y * dt * 0.6, 0);
        this.app.hands.readout(ix, `${this.flipCount} tiles flipped`);
      }
    }
    if (this.drift) {
      // a slow loop through the hidden directions
      const s = dt * 0.25;
      if (this.mode === 'floor') this.shift(Math.cos(time * 0.3) * s, Math.sin(time * 0.3) * s, 0);
      else this.shift(Math.cos(time * 0.3) * s, Math.sin(time * 0.23) * s, Math.sin(time * 0.3) * s);
    }
    if (this.dirty && time - (this.builtAt ?? -1) > 0.066) this.rebuild(time);
    this.floor.uniforms.uTime.value = time;
    this.crystal.uniforms.uTime.value = time;
    if (this.mode === 'crystal') {
      this.spin += dt * 0.08;
      this.crystal.group.quaternion.setFromAxisAngle(_v.set(0, 1, 0), this.spin);
    }
  }

  menuRows() {
    const d = () => (this.mode === 'floor' ? this.delta2 : this.delta3);
    return [
      {
        type: 'tabs',
        options: [{ label: 'Penrose floor (5D)', value: 'floor', small: true }, { label: '3D quasicrystal (6D)', value: 'crystal', small: true }],
        get: () => this.mode,
        set: (m) => this.setMode(m),
      },
      {
        type: 'buttons', columns: 2,
        items: [
          { label: () => (this.drift ? 'Stop drifting' : 'Drift the slice'), onClick: () => { this.drift = !this.drift; } },
          { label: 'Reset', onClick: () => this.reset() },
        ],
      },
      {
        type: 'text', lines: 2, color: '#dfe2ff',
        text: () => `${this.mode === 'floor' ? this.floor.count : this.crystal.count} tiles · slice moved (${d().map((x) => x.toFixed(2)).join(', ')}) · ${this.flipCount} tiles rearranged`,
      },
    ];
  }

  hint(mode) {
    const how = { hands: 'Pinch empty space and move your hand', controllers: 'Push the stick, or hold the trigger in empty space and move', desktop: 'Right-drag' }[mode];
    if (this.mode === 'crystal') return `A slice of the 6D cubic lattice: two rhombohedra with icosahedral symmetry that never repeat. ${how} to shift the slice through the hidden dimensions. Changed tiles glow.`;
    return `A Penrose tiling is a slice of the 5D cubic lattice. ${how} to shift the slice through the hidden dimensions: tiles flip three at a time (they glow), but the pattern never repeats.`;
  }

  desktopHelp({ touch } = {}) {
    if (touch) return '<b>Drag</b> to orbit · <b>Menu</b>: drift the slice';
    return '<b>Right-drag</b> to move the slice through the hidden dimensions · drag to orbit · <b>M</b> menu';
  }
}
