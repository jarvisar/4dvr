// Worldlines: things recorded moving over time, turned into a 4D object with
// time as the w axis. A ball of radius r that moves along p(t) sweeps out the
// worldtube { (x, w(t)) : |x − p(t)| ≤ r }: at each moment, a 3D ball in the
// hyperplane w = w(t).
//
// Cut by a slice of constant w, the worldtube is the ball at that moment, so
// moving the slice along w replays the motion. Rotating the slice in the xw
// plane mixes time and space: each x position then shows a different moment,
// like a slit-scan photograph. The slice then meets each moment's ball in a
// flat disk (a 3D ball cut by a plane), and the cross-section is the stack of
// those disks.
//
// Each path is a polyline of samples, linear in between. Each frame the ball
// centres are moved into slice space. For a slice of constant w, one sphere is
// placed per path where it crosses the slice. Otherwise every disk lies in a
// plane perpendicular to the same direction, and thin disks are stacked along
// it about 1.5 mm apart.

import * as THREE from 'three';
import { LIGHTING_GLSL, LIGHT } from '../core/lighting.js';
import { ANA_COLOR, KATA_COLOR } from './sliceView.js';

const MAX_BALLS = 256;
const MAX_DISKS = 6000;
const DISK_STEP = 0.0015;

const VERT = /* glsl */ `
attribute vec3 iCenter;
attribute float iRadius;
attribute vec3 iColor;
#ifdef DISK
attribute vec3 iAxis;       // disk normal (slice space)
attribute float iThickness;
#endif
varying vec3 vN;
varying vec3 vP;
varying vec3 vColor;
void main() {
  vColor = iColor;
#ifdef DISK
  vec3 e3 = iAxis;
  vec3 e1 = normalize(cross(e3, abs(e3.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 e2 = cross(e3, e1);
  // CylinderGeometry: axis along y, radius 1, height 1
  vec3 local = e1 * position.x * iRadius + e2 * position.z * iRadius + e3 * position.y * iThickness;
  vec3 n = e1 * normal.x + e2 * normal.z + e3 * normal.y;
#else
  vec3 local = position * iRadius;
  vec3 n = normal;
#endif
  vec4 w = modelMatrix * vec4(iCenter + local, 1.0);
  vP = w.xyz;
  vN = normalize(mat3(modelMatrix) * n);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const FRAG = /* glsl */ `
${LIGHTING_GLSL}
varying vec3 vN;
varying vec3 vP;
varying vec3 vColor;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vP);
  if (dot(N, V) < 0.0) N = -N;
  gl_FragColor = vec4(shade(vColor, N, V, 0.6), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function instanced(base, count, attrs, defines) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', base.attributes.position);
  g.setAttribute('normal', base.attributes.normal);
  g.setIndex(base.index);
  const out = {};
  for (const [name, size] of attrs) {
    out[name] = new THREE.InstancedBufferAttribute(new Float32Array(count * size), size).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute(name, out[name]);
  }
  g.instanceCount = 0;
  const mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({ uniforms: { ...LIGHT }, vertexShader: VERT, fragmentShader: FRAG, defines }));
  mesh.frustumCulled = false;
  return { mesh, geo: g, attrs: out };
}

/** Mark the first `count` instances of each attribute for upload (the buffers are sized for the most). */
function uploadFirst(attrs, count) {
  if (count <= 0) return;
  for (const name in attrs) {
    const a = attrs[name];
    a.clearUpdateRanges(); // replaces a pending range: nothing past `count` is drawn
    a.addUpdateRange(0, count * a.itemSize);
    a.needsUpdate = true;
  }
}

const _s = [0, 0, 0, 0];
const _c = new THREE.Color();
const _m = [0, 0, 0];
const _cd0 = [0, 0, 0];
const _cd1 = [0, 0, 0];

export class Worldline {
  constructor(parent) {
    this.chains = [];
    this.group = new THREE.Group();
    parent.add(this.group);
    this.balls = instanced(new THREE.SphereGeometry(1, 20, 14), MAX_BALLS, [['iCenter', 3], ['iRadius', 1], ['iColor', 3]], {});
    this.disks = instanced(new THREE.CylinderGeometry(1, 1, 1, 14, 1, false), MAX_DISKS,
      [['iCenter', 3], ['iRadius', 1], ['iColor', 3], ['iAxis', 3], ['iThickness', 1]], { DISK: '' });
    this.group.add(this.balls.mesh, this.disks.mesh);

    // faint paths: every ball centre seen along the slice's w axis, coloured by time
    this.pathGeo = new THREE.BufferGeometry();
    this.paths = new THREE.LineSegments(this.pathGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.4, depthWrite: false }));
    this.paths.frustumCulled = false;
    this.group.add(this.paths);
    this._viewKey = '';
  }

  /**
   * chains: [{ points: [[x, y, z, w], …], radius, color }] in world 4D
   * coordinates, with w increasing along each chain (w is time in metres).
   */
  setChains(chains) {
    this.chains = chains.filter((c) => c.points.length > 1).map((c) => ({
      pts: Float64Array.from(c.points.flat()),
      n: c.points.length,
      r: c.radius,
      color: new THREE.Color(c.color),
      slice: new Float64Array(c.points.length * 4),
    }));
    let segs = 0;
    let wMin = Infinity, wMax = -Infinity;
    for (const c of this.chains) {
      segs += c.n - 1;
      wMin = Math.min(wMin, c.pts[3]);
      wMax = Math.max(wMax, c.pts[(c.n - 1) * 4 + 3]);
    }
    this.wMin = wMin; this.wMax = wMax;
    this.pathGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(segs * 6), 3));
    const col = new Float32Array(segs * 6);
    let v = 0;
    for (const c of this.chains) for (let i = 0; i + 1 < c.n; i++) for (const j of [i, i + 1]) {
      _c.copy(KATA_COLOR).lerp(ANA_COLOR, (c.pts[j * 4 + 3] - wMin) / Math.max(1e-9, wMax - wMin));
      col[v * 3] = _c.r; col[v * 3 + 1] = _c.g; col[v * 3 + 2] = _c.b;
      v++;
    }
    this.pathGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this._viewKey = '';
    this._pathKey = '';
  }

  get empty() { return this.chains.length === 0; }

  /** Rebuild the cross-section for the current slice (only when the slice moved). */
  update(view) {
    const key = `${view.w},${view.angleXW},${view.angleZW},${this.chains.length}`;
    if (key === this._viewKey) return;
    this._viewKey = key;
    const rot = view.rot;
    // the slice's w axis in world coordinates is row 3 of rot; its xyz part n
    const n0 = rot[12], n1 = rot[13], n2 = rot[14];
    const nn = n0 * n0 + n1 * n1 + n2 * n2;
    const flat = nn < 1e-10; // slice of constant w
    // disk normal in slice space: rot · (n, 0), normalised
    for (let r = 0; r < 3; r++) _m[r] = rot[r * 4] * n0 + rot[r * 4 + 1] * n1 + rot[r * 4 + 2] * n2;
    const ml = Math.hypot(_m[0], _m[1], _m[2]) || 1;
    _m[0] /= ml; _m[1] /= ml; _m[2] /= ml;
    // a ball's offset u (xyz) moves its point by rot · (u, 0) in slice space
    const B = this.balls.attrs, D = this.disks.attrs;
    let nb = 0, nd = 0;

    for (const ch of this.chains) {
      const { pts, n, r, slice, color } = ch;
      for (let i = 0; i < n; i++) {
        _s[0] = pts[i * 4]; _s[1] = pts[i * 4 + 1]; _s[2] = pts[i * 4 + 2]; _s[3] = pts[i * 4 + 3];
        view.toSlice(_s, _s);
        slice[i * 4] = _s[0]; slice[i * 4 + 1] = _s[1]; slice[i * 4 + 2] = _s[2]; slice[i * 4 + 3] = _s[3];
      }
      if (flat) {
        // σ = the centre's w in slice space; the whole ball is in the slice where σ = 0
        for (let i = 0; i + 1 < n && nb < MAX_BALLS; i++) {
          const a = slice[i * 4 + 3], b = slice[i * 4 + 7];
          if ((a > 0 && b > 0) || (a < 0 && b < 0) || a === b) continue;
          if (b === 0 && i + 2 < n) continue; // counted by the next segment
          const t = a / (a - b);
          for (let k = 0; k < 3; k++) B.iCenter.array[nb * 3 + k] = slice[i * 4 + k] + (slice[i * 4 + 4 + k] - slice[i * 4 + k]) * t;
          B.iRadius.array[nb] = r;
          B.iColor.array[nb * 3] = color.r; B.iColor.array[nb * 3 + 1] = color.g; B.iColor.array[nb * 3 + 2] = color.b;
          nb++;
        }
        continue;
      }
      // tilted slice: at each moment the ball meets the slice in the disk
      // { u : |u| ≤ r, n·u = −σ }, centred at u* = −σ n / |n|² with radius sqrt(r² − σ²/|n|²)
      const R = r * Math.sqrt(nn);
      for (let i = 0; i + 1 < n && nd < MAX_DISKS; i++) {
        const sa = slice[i * 4 + 3], sb = slice[i * 4 + 7];
        if ((sa > R && sb > R) || (sa < -R && sb < -R)) continue;
        let t0 = 0, t1 = 1;
        const ds = sb - sa;
        if (Math.abs(ds) > 1e-12) {
          const ta = (-R - sa) / ds, tb = (R - sa) / ds;
          t0 = Math.max(0, Math.min(ta, tb));
          t1 = Math.min(1, Math.max(ta, tb));
          if (t1 <= t0) continue;
        }
        diskCenter(_cd0, slice, i, t0, nn, _m, ml);
        diskCenter(_cd1, slice, i, t1, nn, _m, ml);
        const span = Math.abs((_cd1[0] - _cd0[0]) * _m[0] + (_cd1[1] - _cd0[1]) * _m[1] + (_cd1[2] - _cd0[2]) * _m[2]);
        const count = Math.max(1, Math.ceil(span / DISK_STEP));
        const thick = Math.max(DISK_STEP, span / count) * 1.15;
        for (let k = 0; k <= count && nd < MAX_DISKS; k++) {
          const t = t0 + ((t1 - t0) * k) / count;
          const sigma = sa + ds * t;
          const rr = r * r - (sigma * sigma) / nn;
          if (rr <= 0) continue;
          diskCenter(_cd0, slice, i, t, nn, _m, ml);
          D.iCenter.array[nd * 3] = _cd0[0]; D.iCenter.array[nd * 3 + 1] = _cd0[1]; D.iCenter.array[nd * 3 + 2] = _cd0[2];
          D.iRadius.array[nd] = Math.sqrt(rr);
          D.iAxis.array[nd * 3] = _m[0]; D.iAxis.array[nd * 3 + 1] = _m[1]; D.iAxis.array[nd * 3 + 2] = _m[2];
          D.iThickness.array[nd] = thick;
          D.iColor.array[nd * 3] = color.r; D.iColor.array[nd * 3 + 1] = color.g; D.iColor.array[nd * 3 + 2] = color.b;
          nd++;
        }
      }
    }
    this.balls.geo.instanceCount = nb;
    this.disks.geo.instanceCount = nd;
    this.balls.mesh.visible = nb > 0;
    this.disks.mesh.visible = nd > 0;
    uploadFirst(B, nb);
    uploadFirst(D, nd);

    const pk = `${view.angleXW},${view.angleZW},${this.chains.length}`;
    if (pk !== this._pathKey) this._updatePaths(pk);
  }

  _updatePaths(key) {
    this._pathKey = key;
    const pos = this.pathGeo.attributes.position;
    if (!pos) return;
    const P = pos.array;
    let v = 0;
    for (const ch of this.chains) {
      for (let i = 0; i + 1 < ch.n; i++) for (const j of [i, i + 1]) {
        P[v * 3] = ch.slice[j * 4]; P[v * 3 + 1] = ch.slice[j * 4 + 1]; P[v * 3 + 2] = ch.slice[j * 4 + 2];
        v++;
      }
    }
    pos.needsUpdate = true;
  }

  dispose() {
    this.group.removeFromParent();
    for (const part of [this.balls, this.disks]) { part.geo.dispose(); part.mesh.material.dispose(); }
    this.pathGeo.dispose();
    this.paths.material.dispose();
  }
}

/**
 * Centre (slice space) of the disk where the ball at parameter t of segment i
 * meets the slice. With c(t) the ball centre in slice space and σ its w
 * coordinate, the offset u* = −σ n / |n|² moves it by rot·(u*, 0), whose xyz
 * part is −σ m |Rn|/|n|² with m the unit disk normal; its w part cancels σ.
 */
function diskCenter(out, slice, i, t, nn, m, ml) {
  const a = i * 4, b = a + 4;
  const sigma = slice[a + 3] + (slice[b + 3] - slice[a + 3]) * t;
  const k = (-sigma * ml) / nn;
  for (let j = 0; j < 3; j++) out[j] = slice[a + j] + (slice[b + j] - slice[a + j]) * t + k * m[j];
  return out;
}

/**
 * A three-ball cascade (juggling) as worldlines. The balls' paths braid
 * around each other in (x, y, t). Times are scaled so the recording spans w in
 * [−halfW, halfW]; positions are relative to the table centre.
 */
export function jugglingChains({ halfW = 0.42, height = 0.2 } = {}) {
  const beat = 0.3;              // time between throws, alternating hands
  const dwell = 0.5 * beat;      // time a ball spends in a hand
  const flight = 3 * beat - dwell;
  const g = 2.4;                 // slow "gravity" so the arcs fit above the table
  const vy = (g * flight) / 2;
  const period = 6 * beat;       // a ball comes back to the same hand every 6 beats
  const T = 2 * period;
  const outer = 0.15, inner = 0.05;
  // a hand scoops from its catch point (outside) to its throw point (inside) along a dip
  const hand = (side, u) => [side * (outer + (inner - outer) * u), height - 0.03 * Math.sin(Math.PI * u), 0.02 * side * Math.sin(Math.PI * u)];
  const ballAt = (b, t) => {
    let tt = (((t - b * 2 * beat) % period) + period) % period; // time since ball b was caught by the left hand
    const side = tt < period / 2 ? -1 : 1;
    if (tt >= period / 2) tt -= period / 2;
    if (tt < dwell) return hand(side, tt / dwell);
    const f = tt - dwell;
    const p0 = hand(side, 1), p1 = hand(-side, 0);
    const s = f / flight;
    return [p0[0] + (p1[0] - p0[0]) * s, p0[1] + vy * f - 0.5 * g * f * f, p0[2] + (p1[2] - p0[2]) * s];
  };
  // each hand holds a ball for `dwell`, then moves back out to catch the next one
  const handAt = (side, t) => {
    const ph = (((t / beat + (side > 0 ? 1 : 0)) % 2) + 2) % 2 / 2; // 0..1 over the hand's two beats
    const f = dwell / (2 * beat);
    return hand(side, ph < f ? ph / f : 1 - (ph - f) / (1 - f));
  };
  const toW = (t) => ((t - T / 2) / T) * 2 * halfW;
  const steps = 480;
  const chains = [];
  const colors = ['#ff6b6b', '#ffd93d', '#3ddbd9'];
  for (let b = 0; b < 3; b++) {
    const points = [];
    for (let i = 0; i <= steps; i++) { const t = (i / steps) * T; const p = ballAt(b, t); points.push([p[0], p[1], p[2], toW(t)]); }
    chains.push({ points, radius: 0.02, color: colors[b] });
  }
  for (const side of [-1, 1]) {
    const points = [];
    for (let i = 0; i <= steps; i++) { const t = (i / steps) * T; const p = handAt(side, t); points.push([p[0], p[1] - 0.034, p[2], toW(t)]); }
    chains.push({ points, radius: 0.014, color: '#e8e4ee' });
  }
  return { chains, duration: T, halfW };
}
