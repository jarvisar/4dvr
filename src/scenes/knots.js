// Knot Lab: rope simulation in 4D (position-based dynamics). Each bead has a
// w coordinate, and beads only collide when they are close in all four
// coordinates. A strand moved to a different w can pass through another
// strand in the 3D view, which allows knots to be untied. A knot counts as
// untied when a projection of the loop has no crossings, and a link counts as
// separated when the loops are apart.

import * as THREE from 'three';
import { SceneBase, Burst, makeLabel, disposeLabel, TextLabel } from './base.js';
import { LIGHT, LIGHTING_GLSL } from '../core/lighting.js';
import { ANA_COLOR, KATA_COLOR } from '../four/sliceView.js';
import { GHOST_STYLE } from '../four/sliceMaterial.js';

const TUBE_R = 0.0095;
const COLLIDE = TUBE_R * 2.3;
// Pass-through markers, one per place where strands overlap in xyz but not w.
// Each place has several close bead pairs. Pairs within MARK_MERGE of a marker
// get averaged into it, so one crossing gets one steady ring.
const MAX_MARKS = 24;
const MARK_MERGE = 0.025;
const MARK_R = 0.018, MARK_TUBE = 0.0022;
// The ring sits this far in front of the crossing, towards the head. That's
// past the front of either strand (their centers are up to COLLIDE apart), so
// they don't cut through it.
const MARK_LIFT = COLLIDE / 2 + TUBE_R + MARK_TUBE;
const RADIAL = 8;
const SUB = 2; // curve samples per bead
const W_SAT = 0.06;
// The held bead follows the hand at most this far per step (meters). Moved all
// the way at once, a fast pull carried it past another strand between two
// collision checks, and the knot changed without anything moving through w.
const PIN_STEP = 0.01;
const COS = Array.from({ length: RADIAL }, (_, j) => Math.cos((j / RADIAL) * Math.PI * 2));
const SIN = Array.from({ length: RADIAL }, (_, j) => Math.sin((j / RADIAL) * Math.PI * 2));
const WHITE = new THREE.Color('#f4f1ff');
const _col = new THREE.Color();

const ROPE_VERT = /* glsl */ `
attribute vec3 color;
varying vec3 vN;
varying vec3 vP;
varying vec3 vColor;
void main() {
  vColor = color;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vP = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const ROPE_FRAG = /* glsl */ `
${LIGHTING_GLSL}
uniform float uHighlight;
varying vec3 vN;
varying vec3 vP;
varying vec3 vColor;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vP);
  vec3 col = shade(vColor, N, V, 0.75) + vColor * 0.12;
  // hovered or held: a brighter rim, like the Hopf globe
  col += vec3(0.6, 0.8, 1.0) * pow(1.0 - max(dot(N, V), 0.0), 2.0) * uHighlight * 0.7;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// Curves

function sampleLoop(fn, n, scale, offset = [0, 0, 0]) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const p = fn(t);
    pts.push([p[0] * scale + offset[0], p[1] * scale + offset[1], p[2] * scale + offset[2], 0]);
  }
  return pts;
}

const PRESETS = {
  trefoil: {
    label: 'Trefoil',
    goal: 'unknot',
    loops: () => [sampleLoop((t) => [Math.sin(t) + 2 * Math.sin(2 * t), Math.cos(t) - 2 * Math.cos(2 * t), -Math.sin(3 * t)], 120, 0.045)],
  },
  figure8: {
    label: 'Figure-eight',
    goal: 'unknot',
    loops: () => [sampleLoop((t) => [(2 + Math.cos(2 * t)) * Math.cos(3 * t), (2 + Math.cos(2 * t)) * Math.sin(3 * t), Math.sin(4 * t)], 140, 0.042)],
  },
  hopf: {
    label: 'Hopf link',
    goal: 'unlink',
    loops: () => [
      sampleLoop((t) => [Math.cos(t), Math.sin(t), 0], 70, 0.07, [-0.035, 0, 0]),
      sampleLoop((t) => [Math.cos(t), 0, Math.sin(t)], 70, 0.07, [0.035, 0, 0]),
    ],
  },
  borromean: {
    label: 'Borromean',
    name: 'Borromean rings',
    goal: 'unlink',
    loops: () => [
      sampleLoop((t) => [2 * Math.cos(t), Math.sin(t), 0], 80, 0.05),
      sampleLoop((t) => [0, 2 * Math.cos(t), Math.sin(t)], 80, 0.05),
      sampleLoop((t) => [Math.sin(t), 0, 2 * Math.cos(t)], 80, 0.05),
    ],
  },
};

// ---------------------------------------------------------------------------
// Simulation

class Rope {
  constructor(loops) {
    this.loops = loops.map((pts) => ({ n: pts.length, start: 0 }));
    let off = 0;
    for (const l of this.loops) { l.start = off; off += l.n; }
    this.N = off;
    this.p = new Float64Array(off * 4);
    this.q = new Float64Array(off * 4); // previous positions
    this.loopOf = new Int32Array(off);
    let k = 0;
    loops.forEach((pts, li) => pts.forEach((p) => {
      this.p.set(p, k * 4); this.q.set(p, k * 4); this.loopOf[k] = li; k++;
    }));
    // neighbors along each loop and rest lengths
    this.next1 = new Int32Array(off);
    this.next2 = new Int32Array(off);
    this.rest = new Float64Array(off);
    this.bend = new Float64Array(off);
    for (let i = 0; i < off; i++) {
      this.next1[i] = this.next(i, 1);
      this.next2[i] = this.next(i, 2);
      this.rest[i] = this._dist(i, this.next1[i]);
      this.bend[i] = this._dist(i, this.next2[i]);
    }
    this.pinned = -1;
    this.pinTarget = [0, 0, 0, 0];
    this._pinAt = new Float64Array(4); // where the held bead is, on its way to pinTarget
    this._pinFor = -1;
    this.crossings = new Float64Array(MAX_MARKS * 4); // x, y, z, and the number of bead pairs averaged
    this.nCrossings = 0;
  }

  _markCrossing(x, y, z) {
    const c = this.crossings;
    for (let k = 0; k < this.nCrossings; k++) {
      const n = c[k * 4 + 3];
      const dx = c[k * 4] / n - x, dy = c[k * 4 + 1] / n - y, dz = c[k * 4 + 2] / n - z;
      if (dx * dx + dy * dy + dz * dz < MARK_MERGE * MARK_MERGE) {
        c[k * 4] += x; c[k * 4 + 1] += y; c[k * 4 + 2] += z; c[k * 4 + 3] = n + 1;
        return;
      }
    }
    if (this.nCrossings >= MAX_MARKS) return;
    const k = this.nCrossings++;
    c[k * 4] = x; c[k * 4 + 1] = y; c[k * 4 + 2] = z; c[k * 4 + 3] = 1;
  }

  next(i, s) {
    const l = this.loops[this.loopOf[i]];
    return l.start + ((i - l.start + s) % l.n + l.n) % l.n;
  }

  _dist(i, j) {
    const p = this.p;
    const dx = p[j * 4] - p[i * 4], dy = p[j * 4 + 1] - p[i * 4 + 1], dz = p[j * 4 + 2] - p[i * 4 + 2], dw = p[j * 4 + 3] - p[i * 4 + 3];
    return Math.sqrt(dx * dx + dy * dy + dz * dz + dw * dw);
  }

  _constrain(i, j, rest, stiff) {
    const p = this.p;
    const dx = p[j * 4] - p[i * 4], dy = p[j * 4 + 1] - p[i * 4 + 1], dz = p[j * 4 + 2] - p[i * 4 + 2], dw = p[j * 4 + 3] - p[i * 4 + 3];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz + dw * dw) || 1e-9;
    const wi = i === this.pinned ? 0 : 1, wj = j === this.pinned ? 0 : 1;
    if (wi + wj === 0) return;
    const k = ((d - rest) / d) * stiff / (wi + wj);
    p[i * 4] += dx * k * wi; p[i * 4 + 1] += dy * k * wi; p[i * 4 + 2] += dz * k * wi; p[i * 4 + 3] += dw * k * wi;
    p[j * 4] -= dx * k * wj; p[j * 4 + 1] -= dy * k * wj; p[j * 4 + 2] -= dz * k * wj; p[j * 4 + 3] -= dw * k * wj;
  }

  _collide(markCrossings) {
    const p = this.p, N = this.N;
    const d2 = COLLIDE * COLLIDE;
    if (markCrossings) this.nCrossings = 0;
    for (let i = 0; i < N; i++) {
      const xi = p[i * 4], yi = p[i * 4 + 1], zi = p[i * 4 + 2], wi = p[i * 4 + 3];
      const li = this.loopOf[i];
      const loop = this.loops[li];
      for (let j = i + 1; j < N; j++) {
        const dx = p[j * 4] - xi;
        if (dx > COLLIDE || dx < -COLLIDE) continue; // cheap reject (implies r3 > d2)
        const dy = p[j * 4 + 1] - yi, dz = p[j * 4 + 2] - zi;
        const r3 = dx * dx + dy * dy + dz * dz;
        if (r3 > d2) continue;
        if (this.loopOf[j] === li) {
          const di = Math.abs(j - i);
          if (Math.min(di, loop.n - di) < 4) continue;
        }
        const dw = p[j * 4 + 3] - wi;
        const r4 = r3 + dw * dw;
        if (r4 >= d2) {
          // overlapping in xyz but apart in w, so one strand is passing through another
          if (markCrossings && Math.abs(dw) > COLLIDE * 0.5) this._markCrossing((xi + p[j * 4]) / 2, (yi + p[j * 4 + 1]) / 2, (zi + p[j * 4 + 2]) / 2);
          continue;
        }
        const d = Math.sqrt(r4) || 1e-9;
        const wiP = i === this.pinned ? 0 : 1, wjP = j === this.pinned ? 0 : 1;
        if (wiP + wjP === 0) continue;
        const k = ((COLLIDE - d) / d) / (wiP + wjP);
        p[i * 4] -= dx * k * wiP; p[i * 4 + 1] -= dy * k * wiP; p[i * 4 + 2] -= dz * k * wiP; p[i * 4 + 3] -= dw * k * wiP;
        p[j * 4] += dx * k * wjP; p[j * 4 + 1] += dy * k * wjP; p[j * 4 + 2] += dz * k * wjP; p[j * 4 + 3] += dw * k * wjP;
      }
    }
  }

  step(dt, { settle = 0 } = {}) {
    const p = this.p, q = this.q, N = this.N;
    const damp = 0.9;
    for (let i = 0; i < N; i++) {
      for (let c = 0; c < 4; c++) {
        const v = (p[i * 4 + c] - q[i * 4 + c]) * damp;
        q[i * 4 + c] = p[i * 4 + c];
        p[i * 4 + c] += v;
      }
      // move w back towards 0
      if (settle > 0) p[i * 4 + 3] -= p[i * 4 + 3] * Math.min(1, settle * dt);
    }
    const at = this._pinAt, t = this.pinTarget;
    if (this.pinned >= 0) {
      if (this._pinFor !== this.pinned) { this._pinFor = this.pinned; for (let c = 0; c < 4; c++) at[c] = q[this.pinned * 4 + c]; }
      const d = Math.hypot(t[0] - at[0], t[1] - at[1], t[2] - at[2], t[3] - at[3]);
      const k = d > PIN_STEP ? PIN_STEP / d : 1;
      for (let c = 0; c < 4; c++) at[c] += (t[c] - at[c]) * k;
    } else this._pinFor = -1;
    for (let it = 0; it < 10; it++) {
      if (this.pinned >= 0) this.p.set(at, this.pinned * 4);
      for (let i = 0; i < N; i++) this._constrain(i, this.next1[i], this.rest[i], 1);
      for (let i = 0; i < N; i++) this._constrain(i, this.next2[i], this.bend[i], 0.06);
      if (it % 3 === 2) this._collide(it === 8);
    }
    if (this.pinned >= 0) this.p.set(at, this.pinned * 4);
  }

  maxAbsW() {
    let m = 0;
    for (let i = 0; i < this.N; i++) m = Math.max(m, Math.abs(this.p[i * 4 + 3]));
    return m;
  }

  // Crossings in the projection of loop li along dir. Zero means the loop is unknotted.
  projectedCrossings(li, dir) {
    const l = this.loops[li];
    const p = this.p;
    // basis of the projection plane
    const a = Math.abs(dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = norm(cross(dir, a)), v = cross(dir, u);
    const P = [];
    for (let k = 0; k < l.n; k++) {
      const i = l.start + k;
      const x = p[i * 4], y = p[i * 4 + 1], z = p[i * 4 + 2];
      P.push([x * u[0] + y * u[1] + z * u[2], x * v[0] + y * v[1] + z * v[2]]);
    }
    let count = 0;
    for (let s = 0; s < l.n; s++) {
      const a0 = P[s], a1 = P[(s + 1) % l.n];
      for (let t = s + 2; t < l.n; t++) {
        if (s === 0 && t === l.n - 1) continue;
        if (segCross(a0, a1, P[t], P[(t + 1) % l.n])) count++;
      }
    }
    return count;
  }

  loopCenter(li) {
    const l = this.loops[li];
    const c = [0, 0, 0];
    for (let k = 0; k < l.n; k++) for (let e = 0; e < 3; e++) c[e] += this.p[(l.start + k) * 4 + e] / l.n;
    let r = 0;
    for (let k = 0; k < l.n; k++) {
      const i = l.start + k;
      const dx = this.p[i * 4] - c[0], dy = this.p[i * 4 + 1] - c[1], dz = this.p[i * 4 + 2] - c[2];
      r = Math.max(r, Math.sqrt(dx * dx + dy * dy + dz * dz));
    }
    return { c, r };
  }
}

function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { const l = Math.hypot(...a); return a.map((x) => x / l); }
function segCross(p1, p2, p3, p4) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

// ---------------------------------------------------------------------------
// Rendering, smooth tubes colored by w

class RopeMesh {
  constructor(rope, parent) {
    this.rope = rope;
    this.meshes = rope.loops.map((l) => {
      const M = l.n * SUB;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(M * RADIAL * 3), 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(M * RADIAL * 3), 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(M * RADIAL * 3), 3).setUsage(THREE.DynamicDrawUsage));
      const idx = [];
      for (let i = 0; i < M; i++) for (let j = 0; j < RADIAL; j++) {
        const a = i * RADIAL + j, b = i * RADIAL + ((j + 1) % RADIAL);
        const c = ((i + 1) % M) * RADIAL + j, d = ((i + 1) % M) * RADIAL + ((j + 1) % RADIAL);
        idx.push(a, b, c, b, d, c);
      }
      g.setIndex(idx);
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2);
      const mesh = new THREE.Mesh(g, parent.material);
      mesh.frustumCulled = false;
      parent.group.add(mesh);
      return { mesh, M };
    });
  }

  update() {
    const r = this.rope, p = r.p;
    r.loops.forEach((l, li) => {
      const { mesh, M } = this.meshes[li];
      const pos = mesh.geometry.attributes.position.array;
      const nor = mesh.geometry.attributes.normal.array;
      const cols = mesh.geometry.attributes.color.array;
      // scratch buffers, grown once and reused every frame
      if (!this._S || this._S.length < M * 4) {
        this._S = new Float64Array(M * 4);
        this._T = new Float64Array((M + 1) * 3);
        this._N = new Float64Array((M + 1) * 3);
      }
      const S = this._S, Ts = this._T, Ns = this._N;
      // Catmull-Rom samples
      for (let k = 0; k < l.n; k++) {
        const i0 = l.start + ((k - 1 + l.n) % l.n), i1 = l.start + k, i2 = l.start + ((k + 1) % l.n), i3 = l.start + ((k + 2) % l.n);
        for (let s = 0; s < SUB; s++) {
          const t = s / SUB, t2 = t * t, t3 = t2 * t;
          const o = (k * SUB + s) * 4;
          for (let c = 0; c < 4; c++) {
            const a = p[i0 * 4 + c], b = p[i1 * 4 + c], cc = p[i2 * 4 + c], d = p[i3 * 4 + c];
            S[o + c] = 0.5 * (2 * b + (-a + cc) * t + (2 * a - 5 * b + 4 * cc - d) * t2 + (-a + 3 * b - 3 * cc + d) * t3);
          }
        }
      }
      // Rotation-minimizing frames around the loop. The frame usually comes back
      // twisted after a full loop, so spread the twist evenly to avoid a seam.
      for (let i = 0; i <= M; i++) {
        const a = ((i - 1 + M) % M) * 4, b = ((i + 1) % M) * 4;
        let tx = S[b] - S[a], ty = S[b + 1] - S[a + 1], tz = S[b + 2] - S[a + 2];
        const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
        tx /= tl; ty /= tl; tz /= tl;
        let nx, ny, nz;
        if (i === 0) {
          // cross(T, helper), helper = +y unless T is nearly vertical
          const hx = Math.abs(ty) < 0.9 ? 0 : 1, hy = 1 - hx;
          nx = -tz * hy; ny = tz * hx; nz = tx * hy - ty * hx;
        } else {
          const px = Ns[(i - 1) * 3], py = Ns[(i - 1) * 3 + 1], pz = Ns[(i - 1) * 3 + 2];
          const dp = px * tx + py * ty + pz * tz;
          nx = px - dp * tx; ny = py - dp * ty; nz = pz - dp * tz;
        }
        const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        Ts[i * 3] = tx; Ts[i * 3 + 1] = ty; Ts[i * 3 + 2] = tz;
        Ns[i * 3] = nx / nl; Ns[i * 3 + 1] = ny / nl; Ns[i * 3 + 2] = nz / nl;
      }
      const t0x = Ts[0], t0y = Ts[1], t0z = Ts[2], n0x = Ns[0], n0y = Ns[1], n0z = Ns[2];
      const b0x = t0y * n0z - t0z * n0y, b0y = t0z * n0x - t0x * n0z, b0z = t0x * n0y - t0y * n0x;
      const nMx = Ns[M * 3], nMy = Ns[M * 3 + 1], nMz = Ns[M * 3 + 2];
      const twist = Math.atan2(nMx * b0x + nMy * b0y + nMz * b0z, nMx * n0x + nMy * n0y + nMz * n0z);
      for (let i = 0; i < M; i++) {
        const tx = Ts[i * 3], ty = Ts[i * 3 + 1], tz = Ts[i * 3 + 2];
        const nx0 = Ns[i * 3], ny0 = Ns[i * 3 + 1], nz0 = Ns[i * 3 + 2];
        const bx0 = ty * nz0 - tz * ny0, by0 = tz * nx0 - tx * nz0, bz0 = tx * ny0 - ty * nx0;
        const ang0 = -twist * (i / M), ca0 = Math.cos(ang0), sa0 = Math.sin(ang0);
        const Nx = nx0 * ca0 + bx0 * sa0, Ny = ny0 * ca0 + by0 * sa0, Nz = nz0 * ca0 + bz0 * sa0;
        const Bx = ty * Nz - tz * Ny, By = tz * Nx - tx * Nz, Bz = tx * Ny - ty * Nx;
        const sx = S[i * 4], sy = S[i * 4 + 1], sz = S[i * 4 + 2], w = S[i * 4 + 3];
        const k = Math.max(-1, Math.min(1, w / W_SAT));
        _col.copy(WHITE).lerp(k >= 0 ? ANA_COLOR : KATA_COLOR, Math.abs(k));
        for (let j = 0; j < RADIAL; j++) {
          const ca = COS[j], sa = SIN[j];
          const nx = Nx * ca + Bx * sa, ny = Ny * ca + By * sa, nz = Nz * ca + Bz * sa;
          const o = (i * RADIAL + j) * 3;
          pos[o] = sx + nx * TUBE_R; pos[o + 1] = sy + ny * TUBE_R; pos[o + 2] = sz + nz * TUBE_R;
          nor[o] = nx; nor[o + 1] = ny; nor[o + 2] = nz;
          cols[o] = _col.r; cols[o + 1] = _col.g; cols[o + 2] = _col.b;
        }
      }
      mesh.geometry.attributes.position.needsUpdate = true;
      mesh.geometry.attributes.normal.needsUpdate = true;
      mesh.geometry.attributes.color.needsUpdate = true;
    });
  }

  dispose() {
    for (const { mesh } of this.meshes) { mesh.removeFromParent(); mesh.geometry.dispose(); }
  }
}

const _hp = new THREE.Vector3();
const _hq = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _head = new THREE.Vector3();
const _toHead = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _one = new THREE.Vector3(1, 1, 1);

export class KnotScene extends SceneBase {
  constructor(app) {
    super(app);
    this.key = 'knots';
    this.title = 'Knot Lab';
    this.short = 'Knots';
    this.subtitle = 'Knots and links in 4D';
    this.mood = 'dusk';
    this.center = new THREE.Vector3(0, 1.22, -0.42);
    this.settle = true;
    this.group = new THREE.Group();
    this.root.add(this.group);
    this.material = new THREE.ShaderMaterial({ uniforms: { ...LIGHT, uHighlight: { value: 0 } }, vertexShader: ROPE_VERT, fragmentShader: ROPE_FRAG });

    // markers where strands overlap in xyz but are apart in w
    this.markers = new THREE.InstancedMesh(
      new THREE.TorusGeometry(MARK_R, MARK_TUBE, 8, 28),
      new THREE.MeshBasicMaterial({ color: '#fff3b0', transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false }),
      MAX_MARKS,
    );
    this.markers.count = 0;
    this.markers.frustumCulled = false;
    this.group.add(this.markers);

    this.burst = new Burst(this.group);
    this.wLabel = new TextLabel({ size: 0.016, template: 'w −00.0 cm', bg: 'rgba(27,31,38,0.92)' });
    this.wLabel.mesh.visible = false;
    this.group.add(this.wLabel.mesh);
    this.message = null;
    this.messageT = 0;

    this.handle = this._handle();
    this.interactables = [this.handle];
    this.load('trefoil');
    this._layout();
    this.desktopView = { position: new THREE.Vector3(0, 1.35, 0.1), target: this.center.clone() };
  }

  _layout() {
    this.group.position.copy(this.center);
    if (this.desktopView) this.desktopView.target.copy(this.center);
  }

  onUserReady() {
    this.center.y = THREE.MathUtils.clamp(this.app.headPosition.y - 0.32, 0.95, 1.55);
    this._layout();
  }

  enter() {
    super.enter();
    GHOST_STYLE.uGhostAdd.value = 0.7;
    this._layout();
  }

  exit() {
    super.exit();
    GHOST_STYLE.uGhostAdd.value = 0;
  }

  load(name) {
    this.presetName = name;
    this.goal = PRESETS[name].goal;
    if (this.ropeMesh) this.ropeMesh.dispose();
    this.grab = null; // a strand held during a reset belongs to the old rope
    this.rope = new Rope(PRESETS[name].loops());
    this.ropeMesh = new RopeMesh(this.rope, this);
    this.solved = false;
    this.lifted = false;
    this.checkT = 0;
    const p = PRESETS[name];
    this._say(this.goal === 'unknot' ? `${p.label} knot: untie it` : `${p.name || p.label}: separate the loops`, 3.5);
  }

  _say(text, seconds = 3, color = '#e8eaf0') {
    this.app.announce(text);
    disposeLabel(this.message);
    this.message = makeLabel(text, { size: 0.02, color, bg: 'rgba(27,31,38,0.92)' });
    this.message.position.set(0, 0.2, 0);
    this.group.add(this.message);
    this.messageT = seconds;
  }

  // --- grabbing beads ------------------------------------------------------------

  _nearestBead(local, maxD) {
    const p = this.rope.p;
    let best = -1, bd = maxD;
    for (let i = 0; i < this.rope.N; i++) {
      const dx = p[i * 4] - local.x, dy = p[i * 4 + 1] - local.y, dz = p[i * 4 + 2] - local.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < bd) { bd = d; best = i; }
    }
    return { index: best, dist: bd };
  }

  _handle() {
    const s = this;
    return {
      nearDistance(pw) {
        const local = s.group.worldToLocal(pw.clone());
        const { index, dist } = s._nearestBead(local, 0.08);
        return index < 0 ? Infinity : dist - TUBE_R;
      },
      rayDistance(o, d) {
        const lo = s.group.worldToLocal(o.clone());
        const p = s.rope.p;
        let best = Infinity;
        for (let i = 0; i < s.rope.N; i++) {
          const cx = p[i * 4] - lo.x, cy = p[i * 4 + 1] - lo.y, cz = p[i * 4 + 2] - lo.z;
          const t = cx * d.x + cy * d.y + cz * d.z;
          if (t < 0) continue;
          const dd = cx * cx + cy * cy + cz * cz - t * t;
          if (dd < 0.015 * 0.015 && t < best) best = t;
        }
        return best;
      },
      onHover(ix, on) { s.hover = on; },
      onGrabStart(ix, mode, kind) {
        ix.pose(kind, _hp, _hq);
        const local = s.group.worldToLocal(_hp.clone());
        const { index } = s._nearestBead(local, 0.2);
        if (index < 0) return;
        const p = s.rope.p;
        s.grab = { ix, kind, mode, index, startHand: local.clone(), startBead: [p[index * 4], p[index * 4 + 1], p[index * 4 + 2], p[index * 4 + 3]] };
        s.rope.pinned = index;
        s.rope.pinTarget = s.grab.startBead.slice();
      },
      onGrabUpdate(ix, dt) {
        const g = s.grab;
        if (!g) return;
        ix.pose(g.kind, _hp, _hq);
        const local = s.group.worldToLocal(_hp.clone());
        const d = local.clone().sub(g.startHand);
        const t = s.rope.pinTarget;
        if (g.mode === 'secondary') {
          // hand height sets w, horizontal motion still moves the strand
          t[0] = g.startBead[0] + d.x;
          t[1] = g.startBead[1];
          t[2] = g.startBead[2] + d.z;
          t[3] = g.startBead[3] + d.y * (ix.isMouse ? 0.8 : 1.2);
        } else {
          t[0] = g.startBead[0] + d.x;
          t[1] = g.startBead[1] + d.y;
          t[2] = g.startBead[2] + d.z;
          t[3] = g.startBead[3];
          t[3] += -ix.stick.y * 0.3 * dt; // controllers: the stick changes w while dragging
          g.startBead[3] = t[3];
        }
        if (Math.abs(t[3]) > 0.02) s.lifted = true;
      },
      onGrabEnd() {
        s.grab = null;
        s.rope.pinned = -1;
      },
    };
  }

  onKey(e) {
    const k = e.key.toLowerCase();
    if (k === 'r') this.load(this.presetName);
    if (k === 'f') this.flattenT = 1.5;
  }

  update(dt) {
    const settleRate = this.flattenT > 0 ? 4 : (this.settle && !this.grab ? 0.6 : 0);
    if (this.flattenT > 0) this.flattenT -= dt;
    const steps = 2;
    for (let s = 0; s < steps; s++) this.rope.step(dt / steps, { settle: settleRate });
    this.ropeMesh.update();

    // pass-through markers
    const head = this.group.worldToLocal(_head.copy(this.app.headPosition));
    const cr = this.rope.crossings;
    let n = 0;
    for (let k = 0; k < this.rope.nCrossings; k++) {
      const pairs = cr[k * 4 + 3];
      _pos.set(cr[k * 4] / pairs, cr[k * 4 + 1] / pairs, cr[k * 4 + 2] / pairs);
      _pos.addScaledVector(_toHead.subVectors(head, _pos).normalize(), MARK_LIFT);
      _m.lookAt(head, _pos, _up);
      _hq.setFromRotationMatrix(_m);
      _m.compose(_pos, _hq, _one);
      this.markers.setMatrixAt(n++, _m);
    }
    this.markers.count = n;
    this.markers.instanceMatrix.needsUpdate = true;

    // w readout next to the grabbed bead
    if (this.grab) {
      const i = this.grab.index, p = this.rope.p;
      const w = p[i * 4 + 3];
      const text = Math.abs(w) < 0.003 ? 'w 0 cm' : `w ${w > 0 ? '+' : '−'}${Math.abs(w * 100).toFixed(1)} cm`;
      this.wLabel.setText(text, w > 0.003 ? '#ff8fbf' : w < -0.003 ? '#7fd8ff' : '#ffffff');
      const lm = this.wLabel.mesh;
      lm.visible = true;
      lm.position.set(p[i * 4], p[i * 4 + 1] + 0.035, p[i * 4 + 2]);
      lm.lookAt(this.app.headPosition);
    } else this.wLabel.mesh.visible = false;

    // check for a solution twice a second
    this.checkT -= dt;
    if (!this.solved && this.lifted && !this.grab && this.checkT <= 0) {
      this.checkT = 0.5;
      if (this.rope.maxAbsW() < 0.006) this._checkSolved();
    }

    const hl = this.material.uniforms.uHighlight;
    hl.value += ((this.hover || this.grab ? 1 : 0) - hl.value) * Math.min(1, dt * 12);

    this.burst.update(dt);
    if (this.message) {
      // in VR the open menu covers it, so it waits for the menu to close
      if (!this.app.presenting || !this.app.menu.shown) this.messageT -= dt;
      this.message.visible = this.messageT > 0;
      this.message.lookAt(this.app.headPosition);
      this.message.material.opacity = Math.min(1, this.messageT * 2);
    }
  }

  _checkSolved() {
    const r = this.rope;
    let ok = false;
    if (this.goal === 'unknot') {
      // a projection with zero crossings proves the loop is unknotted
      const dirs = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.577, 0.577, 0.577], [-0.577, 0.577, 0.577], [0.577, -0.577, 0.577], [0.707, 0.707, 0], [0, 0.707, 0.707], [0.707, 0, 0.707]];
      ok = dirs.some((d) => r.projectedCrossings(0, d) === 0);
    } else {
      // links: every pair of loops is separated
      ok = true;
      const info = r.loops.map((_, i) => r.loopCenter(i));
      let apart = 0;
      for (let i = 0; i < info.length; i++) for (let j = i + 1; j < info.length; j++) {
        const d = Math.hypot(info[i].c[0] - info[j].c[0], info[i].c[1] - info[j].c[1], info[i].c[2] - info[j].c[2]);
        if (d > info[i].r + info[j].r + COLLIDE) apart++;
      }
      // Borromean rings come apart once any one ring is removed
      ok = this.presetName === 'borromean' ? apart >= 2 : apart === info.length * (info.length - 1) / 2;
    }
    if (ok) {
      this.solved = true;
      this.burst.fire(new THREE.Vector3(0, 0.05, 0));
      this.app.audio.spawn(this.group.getWorldPosition(new THREE.Vector3()));
      this._say(this.goal === 'unknot' ? 'Untied' : 'Separated', 4, '#fff3b0');
    }
  }

  menuRows() {
    return [
      {
        type: 'buttons', columns: 4,
        items: Object.entries(PRESETS).map(([k, v]) => ({ label: v.label, small: true, onClick: () => this.load(k), active: () => this.presetName === k })),
      },
      {
        type: 'toggles', columns: 1,
        items: [{ label: 'Return released strands to w = 0', get: () => this.settle, set: (v) => { this.settle = v; } }],
      },
      {
        type: 'buttons', columns: 2,
        items: [
          { label: 'Set all w to 0', onClick: () => { this.flattenT = 1.5; } },
          { label: 'Reset', onClick: () => this.load(this.presetName) },
        ],
      },
    ];
  }

  hint(mode) {
    const rules = `Strands at different w do not collide. ${this.settle ? 'Released strands move back to w = 0.' : 'Set all w to 0 to check the knot.'}`;
    if (mode === 'desktop') return `Pink is +w, blue is −w. ${rules}`;
    if (mode === 'controllers') return `Trigger or grip to move a strand. Hold both on a strand and move the controller up or down, or push the stick while holding it, to change its w (pink is +w, blue is −w). ${rules}`;
    return `Pinch a strand to move it. Middle-finger pinch a strand and move your hand up or down to change its w (pink is +w, blue is −w). ${rules}`;
  }

  desktopHelp({ touch } = {}) {
    if (touch) return '<b>Drag</b> a strand to move it · <b>Two-finger drag</b> a strand up or down to change its w · <b>Drag</b> empty space to orbit';
    return '<b>Drag</b> a strand to move it · <b>Right-drag</b> a strand up or down to change its w · <b>Drag</b> empty space to orbit · <b>F</b> set all w to 0 · <b>R</b> reset the knot · Strands at different w do not collide.';
  }
}
