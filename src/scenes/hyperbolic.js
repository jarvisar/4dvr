// Hyperbolic Space: the {5,3,4} honeycomb (right-angled dodecahedra, eight
// per vertex) and the {4,3,5} honeycomb (cubes, five per edge).
//
// Based on Hart, Hawksley, Matsumoto and Segerman, "Non-Euclidean Virtual
// Reality". Points are stored in the hyperboloid model. Each frame the world
// is transformed by the inverse of the viewer's Lorentz transform and drawn
// using the Beltrami-Klein model, which is correct from the origin and keeps
// geodesics straight. Each eye is offset separately in the vertex shader.
//
// Each frame's head movement is converted to a hyperbolic translation and
// rotation and accumulated. Because of this, walking in a loop leaves the
// viewer rotated (holonomy).
//
// When the viewer leaves the center cell, a symmetry of the honeycomb (a
// half-turn about a line in the crossed face) moves them back. This changes
// the coordinates but not what is drawn.

import * as THREE from 'three';
import * as R4 from '../math/rot4.js';
import * as H from '../math/hyperbolic.js';
import { SceneBase } from './base.js';
import { icosphere } from '../four/tetmesh.js';

const PHI = (1 + Math.sqrt(5)) / 2;

function dodecahedronVerts() {
  const v = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) v.push([x, y, z]);
  for (const a of [-1, 1]) for (const b of [-1, 1]) {
    v.push([0, a / PHI, b * PHI], [a / PHI, b * PHI, 0], [a * PHI, 0, b / PHI]);
  }
  return v;
}

function dodecahedronNormals() {
  const n = [];
  for (const a of [-1, 1]) for (const b of [-1, 1]) n.push([0, a * PHI, b], [a, 0, b * PHI], [a * PHI, b, 0]);
  return n.map((x) => { const l = Math.hypot(...x); return x.map((c) => c / l); });
}

const HONEYCOMBS = {
  dodeca: {
    label: '{5,3,4} dodecahedra',
    blurb: 'Right-angled dodecahedra, eight around each vertex. This does not fit in Euclidean space.',
    normals: dodecahedronNormals,
    verts: dodecahedronVerts,
    // adjacent face normals meet at arccos(1/√5); a 90° dihedral needs tanh²(a) = 1/√5
    inradius: () => Math.atanh(Math.pow(5, -0.25)),
    twoColor: true,
    maxCells: 440,
    rmax: 3.5,
    scale: 1.5,
  },
  cube: {
    label: '{4,3,5} cubes',
    blurb: 'Cubes with 72° dihedral angles, five around each edge. In Euclidean space only four fit.',
    normals: () => [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]],
    verts: () => { const v = []; for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) v.push([x, y, z]); return v; },
    // orthogonal face normals with a 72° dihedral: sinh²(a) = cos 72°
    inradius: () => Math.asinh(Math.sqrt(Math.cos((2 * Math.PI) / 5))),
    twoColor: false,
    maxCells: 700,
    rmax: 3.4,
    scale: 2.0,
  },
};

const RAD = 4;          // tube radial segments (square beams read well and halve the cost)
const TUBE_R = 0.018;   // hyperbolic units
const NODE_R = 0.04;
const LANTERN_R = 0.055;

const VERT = /* glsl */ `
// Lorentz transform world -> this eye: boost(-eye) · headInv · model. It is the
// same for every vertex, so it is computed once per eye on the CPU (in double
// precision) in onBeforeRender, which three.js calls separately for each eye.
uniform mat4 uEyeInv;
uniform mat3 uHeadRot;
uniform float uL;
uniform float uFog;
uniform vec3 uNear;
uniform vec3 uMid;
uniform vec3 uFar;
uniform vec3 uLanternA;
uniform vec3 uLanternB;
uniform float uParityFlip;
attribute vec4 aH;
attribute vec4 aD;
attribute float aKind;   // 0 edge, 1 node, 2 lantern
attribute float aParity;
varying vec3 vColor;
varying float vFog;
varying vec3 vN;
varying vec3 vV;
varying float vKind;

void main() {
  vec4 Q = uEyeInv * aH;
  vec4 D = uEyeInv * aD;
  vec3 k = Q.xyz / Q.w;              // Beltrami–Klein coordinates seen from this eye
  vec3 local = k * uL;
  vec3 world = cameraPosition + uHeadRot * local;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);

  float dist = acosh(max(Q.w, 1.0));
  vFog = exp(-dist * uFog);
  vN = uHeadRot * normalize(D.xyz - k * D.w);
  vV = -normalize(uHeadRot * local + 1e-6);
  vKind = aKind;
  if (aKind > 1.5) {
    vColor = mix(uLanternA, uLanternB, abs(aParity - uParityFlip));
  } else {
    float t = clamp(dist / 3.2, 0.0, 1.0);
    vColor = t < 0.5 ? mix(uNear, uMid, t * 2.0) : mix(uMid, uFar, t * 2.0 - 1.0);
    if (aKind > 0.5) vColor = mix(vColor, vec3(1.0), 0.35);
  }
}
`;

const FRAG = /* glsl */ `
uniform vec3 uFogColor;
uniform float uGlow;
varying vec3 vColor;
varying float vFog;
varying vec3 vN;
varying vec3 vV;
varying float vKind;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(vV);
  float ndv = abs(dot(N, V));
  float diff = 0.3 + 0.7 * ndv;
  float rim = pow(1.0 - ndv, 2.5);
  vec3 col = vColor * diff + vColor * rim * 0.6;
  if (vKind > 1.5) col = vColor * (1.2 + uGlow) + rim * vec3(1.0);
  col = mix(uFogColor, col, vFog);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function key4(p) {
  return `${Math.round(p[0] * 2000)},${Math.round(p[1] * 2000)},${Math.round(p[2] * 2000)},${Math.round(p[3] * 2000)}`;
}

function applyM(M, v) {
  return R4.apply([0, 0, 0, 0], M, v);
}

/** Build the honeycomb patch: cells (BFS over reflections), edges, nodes. */
function buildHoneycomb(def) {
  const a = def.inradius();
  const normals3 = def.normals();
  const t = Math.tanh(a);
  // scale the cell's vertices (Klein coords) so faces sit at Klein distance tanh(a)
  const rawV = def.verts();
  const inr = Math.max(...rawV.map((v) => v[0] * normals3[0][0] + v[1] * normals3[0][1] + v[2] * normals3[0][2]));
  const kverts = rawV.map((v) => v.map((c) => (c * t) / inr));
  const hverts = kverts.map(H.fromKlein);
  // cell edges = closest vertex pairs
  let minD = Infinity;
  for (let i = 0; i < kverts.length; i++) for (let j = i + 1; j < kverts.length; j++) {
    minD = Math.min(minD, Math.hypot(kverts[i][0] - kverts[j][0], kverts[i][1] - kverts[j][1], kverts[i][2] - kverts[j][2]));
  }
  const cellEdges = [];
  for (let i = 0; i < kverts.length; i++) for (let j = i + 1; j < kverts.length; j++) {
    const d = Math.hypot(kverts[i][0] - kverts[j][0], kverts[i][1] - kverts[j][1], kverts[i][2] - kverts[j][2]);
    if (d < minD * 1.01) cellEdges.push([i, j]);
  }
  // face planes and reflections
  const faceN = normals3.map((u) => [u[0] * Math.cosh(a), u[1] * Math.cosh(a), u[2] * Math.cosh(a), Math.sinh(a)]);
  const refl = faceN.map((n) => H.reflection(R4.mat4(), n));
  // re-centring symmetry per face: mirror through the cell centre containing the
  // face axis and one of the face's vertices, composed with the face reflection
  const recenter = normals3.map((u, f) => {
    let best = null, bd = -Infinity;
    for (const v of kverts) { const d = v[0] * u[0] + v[1] * u[1] + v[2] * u[2]; if (d > bd + 1e-9) { bd = d; best = v; } }
    const m = [u[1] * best[2] - u[2] * best[1], u[2] * best[0] - u[0] * best[2], u[0] * best[1] - u[1] * best[0]];
    const l = Math.hypot(...m);
    const tau = H.reflection(R4.mat4(), [m[0] / l, m[1] / l, m[2] / l, 0]);
    return R4.multiply(R4.mat4(), tau, refl[f]);
  });

  // BFS over cells
  const cells = [{ G: R4.mat4(), center: H.ORIGIN.slice(), parity: 0 }];
  const seen = new Set([key4(H.ORIGIN)]);
  for (let qi = 0; qi < cells.length && cells.length < def.maxCells; qi++) {
    const c = cells[qi];
    for (let f = 0; f < refl.length; f++) {
      const G = R4.multiply(R4.mat4(), c.G, refl[f]);
      const center = applyM(G, H.ORIGIN);
      if (Math.acosh(center[3]) > def.rmax) continue;
      const k = key4(center);
      if (seen.has(k)) continue;
      seen.add(k);
      cells.push({ G, center, parity: 1 - c.parity });
      if (cells.length >= def.maxCells) break;
    }
  }

  // unique edges and nodes
  const edges = new Map();
  const nodes = new Map();
  for (const c of cells) {
    const wv = hverts.map((v) => applyM(c.G, v));
    for (const v of wv) { const k = key4(v); if (!nodes.has(k)) nodes.set(k, v); }
    for (const [i, j] of cellEdges) {
      const A = wv[i], B = wv[j];
      const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2, (A[3] + B[3]) / 2];
      const k = key4(mid);
      if (!edges.has(k)) edges.set(k, [A, B]);
    }
  }
  return { def, a, cells, edges: [...edges.values()], nodes: [...nodes.values()], faceN, recenter, kverts };
}

/** Geometry buffers (hyperboloid coordinates) for tubes, nodes and lanterns. */
function buildGeometry(hc) {
  const aH = [], aD = [], aKind = [], aParity = [], index = [];
  const push = (Q, D, kind, parity) => { aH.push(...Q); aD.push(...D); aKind.push(kind); aParity.push(parity); return aKind.length - 1; };
  const J = (v) => [v[0], v[1], v[2], -v[3]];

  // tubes
  for (const [A, B] of hc.edges) {
    const d = H.hdist(A, B);
    const sd = Math.sinh(d);
    const rings = [];
    const far = Math.min(A[3], B[3]) > Math.cosh(2.4);
    for (const tt of far ? [0, 1] : [0, 0.5, 1]) {
      const ca = Math.sinh((1 - tt) * d) / sd, cb = Math.sinh(tt * d) / sd;
      const P = [0, 1, 2, 3].map((i) => ca * A[i] + cb * B[i]);
      const da = -Math.cosh((1 - tt) * d) / sd, db = Math.cosh(tt * d) / sd;
      const T = [0, 1, 2, 3].map((i) => da * A[i] + db * B[i]);
      const tn = Math.sqrt(Math.abs(H.mdot(T, T)));
      for (let i = 0; i < 4; i++) T[i] /= tn;
      // Minkowski-orthonormal frame around the tube
      const cands = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];
      let best = null, bestN = -1;
      for (const h of cands) {
        const hp = h.map((x, i) => x + H.mdot(h, P) * P[i] - H.mdot(h, T) * T[i]);
        const n = H.mdot(hp, hp);
        if (n > bestN) { bestN = n; best = hp; }
      }
      const N1 = best.map((x) => x / Math.sqrt(bestN));
      const N2 = H.mcross([0, 0, 0, 0], P, T, N1);
      const n2 = Math.sqrt(Math.abs(H.mdot(N2, N2)));
      for (let i = 0; i < 4; i++) N2[i] /= n2;
      const ring = [];
      for (let j = 0; j < RAD; j++) {
        const ph = (j / RAD) * Math.PI * 2;
        const Dv = [0, 1, 2, 3].map((i) => Math.cos(ph) * N1[i] + Math.sin(ph) * N2[i]);
        const Q = [0, 1, 2, 3].map((i) => Math.cosh(TUBE_R) * P[i] + Math.sinh(TUBE_R) * Dv[i]);
        ring.push(push(Q, Dv, 0, 0));
      }
      rings.push(ring);
    }
    for (let r = 0; r < rings.length - 1; r++) for (let j = 0; j < RAD; j++) {
      const a0 = rings[r][j], b0 = rings[r][(j + 1) % RAD], c0 = rings[r + 1][j], d0 = rings[r + 1][(j + 1) % RAD];
      index.push(a0, c0, b0, b0, c0, d0);
    }
  }

  // small spheres (nodes and lanterns), built by the exponential map
  const sphereAt = (V, radius, detail, kind, parity) => {
    const s = icosphere(detail);
    const dist = Math.acosh(Math.max(1, V[3]));
    const dir = dist > 1e-9 ? [V[0] / Math.sinh(dist), V[1] / Math.sinh(dist), V[2] / Math.sinh(dist)] : [0, 0, 0];
    const B = H.boost(R4.mat4(), dir.map((x) => x * dist));
    const base = aKind.length;
    for (const u of s.verts) {
      const Dv = applyM(B, [u[0], u[1], u[2], 0]);
      const Q = [0, 1, 2, 3].map((i) => Math.cosh(radius) * V[i] + Math.sinh(radius) * Dv[i]);
      push(Q, Dv, kind, parity);
    }
    for (const [x, y, z] of s.tris) index.push(base + x, base + y, base + z);
  };
  // corner nodes only where they're big enough to see
  for (const v of hc.nodes) if (Math.acosh(Math.max(1, v[3])) < 2.6) sphereAt(v, NODE_R, 0, 1, 0);
  if (hc.def.twoColor) for (const c of hc.cells) sphereAt(c.center, LANTERN_R, 1, 2, c.parity);
  else for (const c of hc.cells) sphereAt(c.center, LANTERN_R * 0.8, 1, 2, 0);

  const g = new THREE.BufferGeometry();
  g.setAttribute('aH', new THREE.Float32BufferAttribute(aH, 4));
  g.setAttribute('aD', new THREE.Float32BufferAttribute(aD, 4));
  g.setAttribute('aKind', new THREE.Float32BufferAttribute(aKind, 1));
  g.setAttribute('aParity', new THREE.Float32BufferAttribute(aParity, 1));
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(aKind.length * 3), 3));
  g.setIndex(aKind.length > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return g;
}

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _E = R4.mat4();
const _T = R4.mat4();
const _eye = [0, 0, 0];
const _euler = new THREE.Euler();

export class HyperbolicScene extends SceneBase {
  constructor(app) {
    super(app);
    this.key = 'hyperbolic';
    this.title = 'Hyperbolic Space';
    this.short = 'Hyperbolic';
    this.subtitle = 'Regular honeycombs in hyperbolic space';
    this.mood = 'hyperbolic';
    this.noOrbit = true;

    this.uniforms = {
      uEyeInv: { value: new THREE.Matrix4() },
      uHeadRot: { value: new THREE.Matrix3() },
      uL: { value: 1.5 },
      uFog: { value: 0.55 },
      uFogColor: { value: new THREE.Color('#0e0a1c') },
      uNear: { value: new THREE.Color('#fff1d6') },
      uMid: { value: new THREE.Color('#ff5fb4') },
      uFar: { value: new THREE.Color('#4b3cff') },
      uLanternA: { value: new THREE.Color('#ffc46b') },
      uLanternB: { value: new THREE.Color('#5ff2ff') },
      uParityFlip: { value: 0 },
      uGlow: { value: 0 },
    };
    this.material = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG });

    // start marker: a larger sphere at the original origin, moved along with re-centering
    this.beaconUniforms = { ...this.uniforms, uEyeInv: { value: new THREE.Matrix4() }, uLanternA: { value: new THREE.Color('#ffffff') }, uLanternB: { value: new THREE.Color('#ffffff') }, uGlow: { value: 1.5 } };
    this.beaconMat = new THREE.ShaderMaterial({ uniforms: this.beaconUniforms, vertexShader: VERT, fragmentShader: FRAG });
    this.beacon = new THREE.Mesh(this._beaconGeometry(), this.beaconMat);
    this.beacon.frustumCulled = false;
    this.beaconModel = R4.mat4();
    this.beacon.onBeforeRender = (r, s, camera) => this._setEye(camera, this.beaconMat, this.beaconModel);
    this.root.add(this.beacon);

    this.Hm = R4.mat4();     // head pose: world <- head (Lorentz)
    this.headInv = R4.mat4();
    this.headPos = new THREE.Vector3();
    this.headQuatInv = new THREE.Quaternion();
    this.home = H.ORIGIN.slice(); // true origin in current coordinates
    this.parity = 0;
    this.prevPos = new THREE.Vector3();
    this.prevQuat = new THREE.Quaternion();
    this.hasPrev = false;
    this.fogOn = true;
    this.showBeacon = true;
    this.speedBoost = 1;
    this.yaw = 0;
    this.pitch = 0;
    this.keys = new Set();

    this.setHoneycomb('dodeca');
    this.desktopView = { position: new THREE.Vector3(0, 1.6, 0), target: new THREE.Vector3(0, 1.6, -1) };
    this._onKeyDown = (e) => { if (!e.ctrlKey && !e.metaKey && !e.altKey) this.keys.add(e.key.toLowerCase()); };
    this._onKeyUp = (e) => this.keys.delete(e.key.toLowerCase());
    this._onBlur = () => this.keys.clear(); // keyup never arrives after alt-tab
    this._onPointerMove = (e) => {
      if (this.app.presenting || !(e.buttons & 1) || !this.app.pointerOnEmpty) return;
      this.yaw -= e.movementX * 0.004;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.004, -1.4, 1.4);
    };
  }

  _beaconGeometry() {
    const s = icosphere(2);
    const aH = [], aD = [], aK = [], aP = [];
    const r = 0.16;
    for (const u of s.verts) {
      aH.push(u[0] * Math.sinh(r), u[1] * Math.sinh(r), u[2] * Math.sinh(r), Math.cosh(r));
      aD.push(u[0], u[1], u[2], 0);
      aK.push(2); aP.push(0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('aH', new THREE.Float32BufferAttribute(aH, 4));
    g.setAttribute('aD', new THREE.Float32BufferAttribute(aD, 4));
    g.setAttribute('aKind', new THREE.Float32BufferAttribute(aK, 1));
    g.setAttribute('aParity', new THREE.Float32BufferAttribute(aP, 1));
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(aK.length * 3), 3));
    g.setIndex(s.tris.flat());
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
    return g;
  }

  setHoneycomb(key) {
    this.hcKey = key;
    const t0 = performance.now();
    this.hc = buildHoneycomb(HONEYCOMBS[key]);
    const geo = buildGeometry(this.hc);
    if (this.mesh) { this.root.remove(this.mesh); this.mesh.geometry.dispose(); }
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.onBeforeRender = (r, s, camera) => this._setEye(camera, this.material, null);
    this.root.add(this.mesh);
    this.uniforms.uL.value = HONEYCOMBS[key].scale;
    this.goHome();
    console.info(`[hyperbolic] ${HONEYCOMBS[key].label}: ${this.hc.cells.length} cells, ${this.hc.edges.length} edges, ${this.hc.nodes.length} nodes, ${geo.attributes.aKind.count} verts in ${(performance.now() - t0).toFixed(0)} ms`);
    if (this.app.activeScene === this) this.app.menu.rebuild();
  }

  /** Per-eye Lorentz transform (called by three.js before drawing for each eye). */
  _setEye(camera, material, model) {
    const L = this.uniforms.uL.value;
    // this eye's offset from the head centre, in head-local hyperbolic units
    _v.setFromMatrixPosition(camera.matrixWorld).sub(this.headPos).applyQuaternion(this.headQuatInv).divideScalar(L);
    _eye[0] = -_v.x; _eye[1] = -_v.y; _eye[2] = -_v.z;
    R4.multiply(_T, H.boost(_E, _eye), this.headInv);
    if (model) R4.multiply(_T, _T, model);
    R4.toThreeMatrix(material.uniforms.uEyeInv.value, _T, 1);
    material.uniformsNeedUpdate = true;
  }

  goHome() {
    R4.identity(this.Hm);
    this.home = H.ORIGIN.slice();
    this.parity = 0;
    this.hasPrev = false;
  }

  enter() {
    super.enter();
    this.hasPrev = false;
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    this.app.renderer.domElement.addEventListener('pointermove', this._onPointerMove);
    if (!this.app.presenting) {
      this.yaw = 0; this.pitch = 0;
      this.app.camera.position.copy(this.desktopView.position);
    }
  }

  exit() {
    super.exit();
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    this.keys.clear();
    this.app.renderer.domElement.removeEventListener('pointermove', this._onPointerMove);
  }

  onSessionStart() { this.hasPrev = false; }
  onSessionEnd() { this.hasPrev = false; }

  /** Move the viewer by a head-local displacement (hyperbolic units). */
  _translateLocal(v) {
    const B = H.boost(R4.mat4(), v);
    R4.multiply(this.Hm, this.Hm, B);
  }

  _rotateLocal(q) {
    const Rq = R4.fromQuaternion(R4.mat4(), q);
    R4.multiply(this.Hm, this.Hm, Rq);
  }

  _recenter() {
    // keep the head inside the central cell using symmetries of the honeycomb
    for (let iter = 0; iter < 4; iter++) {
      const p = [this.Hm[3], this.Hm[7], this.Hm[11], this.Hm[15]];
      let worst = -1, wv = 1e-9;
      for (let f = 0; f < this.hc.faceN.length; f++) {
        const s = H.mdot(p, this.hc.faceN[f]);
        if (s > wv) { wv = s; worst = f; }
      }
      if (worst < 0) return;
      const g = this.hc.recenter[worst];
      R4.multiply(this.Hm, g, this.Hm);
      this.home = R4.apply([0, 0, 0, 0], g, this.home);
      this.parity = 1 - this.parity;
    }
  }

  onEmptyGrabStart(ix) {
    this.pull = { last: ix.grabPos.clone() };
    return true;
  }

  onEmptyGrabUpdate(ix) {
    if (!this.pull) return;
    const d = ix.grabPos.clone().sub(this.pull.last);
    this.pull.last.copy(ix.grabPos);
    // move the viewer opposite to the hand motion, in head-local units
    const gain = (ix.isMouse ? 2.5 : 3.0) / this.uniforms.uL.value;
    _v.copy(d).multiplyScalar(-gain).applyQuaternion(this.app.headQuaternion.clone().invert());
    this._translateLocal([_v.x, _v.y, _v.z]);
  }

  onEmptyGrabEnd() { this.pull = null; }

  update(dt) {
    const app = this.app;
    const L = this.uniforms.uL.value;

    if (!app.presenting) {
      // desktop: mouse look and WASD movement
      app.camera.position.copy(this.desktopView.position);
      app.camera.quaternion.setFromEuler(_euler.set(this.pitch, this.yaw, 0, 'YXZ'));
      app.camera.updateMatrixWorld();
      app.camera.getWorldPosition(app.headPosition);
      app.camera.getWorldQuaternion(app.headQuaternion);
      const mv = new THREE.Vector3(
        (this.keys.has('d') ? 1 : 0) - (this.keys.has('a') ? 1 : 0),
        (this.keys.has('e') ? 1 : 0) - (this.keys.has('q') ? 1 : 0),
        (this.keys.has('s') ? 1 : 0) - (this.keys.has('w') ? 1 : 0),
      );
      if (mv.lengthSq() > 0) {
        const sp = (this.keys.has('shift') ? 2.2 : 0.9) * dt;
        mv.normalize().multiplyScalar(sp);
        this._translateLocal([mv.x, mv.y, mv.z]);
      }
    }

    // path-integrate head motion into the hyperbolic pose
    const pos = app.headPosition, quat = app.headQuaternion;
    if (this.hasPrev) {
      const dp = _v.copy(pos).sub(this.prevPos);
      if (dp.length() < 0.5) {
        dp.applyQuaternion(_q.copy(this.prevQuat).invert()).divideScalar(L);
        this._translateLocal([dp.x, dp.y, dp.z]);
      }
      const dq = _q.copy(this.prevQuat).invert().multiply(quat);
      this._rotateLocal(dq);
    } else {
      // first frame: align the hyperbolic head orientation with the real one
      R4.multiply(this.Hm, this.Hm, R4.fromQuaternion(R4.mat4(), quat));
    }
    this.prevPos.copy(pos);
    this.prevQuat.copy(quat);
    this.hasPrev = true;

    // controllers: thumbstick moves in the controller's pointing direction
    for (const ix of app.input.xr) {
      if (ix.kind !== 'controller' || (!ix.stick.x && !ix.stick.y)) continue;
      const v = new THREE.Vector3(ix.stick.x, 0, ix.stick.y).multiplyScalar(dt * 0.9);
      v.applyQuaternion(ix.rayQuat).applyQuaternion(quat.clone().invert());
      this._translateLocal([v.x, v.y, v.z]);
    }

    H.lorentzOrthonormalize(this.Hm);
    this._recenter();

    // uniforms (the per-eye matrix is finished in _setEye)
    H.lorentzInverse(this.headInv, this.Hm);
    this.headPos.copy(pos);
    this.headQuatInv.copy(quat).invert();
    _m4.makeRotationFromQuaternion(quat);
    this.uniforms.uHeadRot.value.setFromMatrix4(_m4);
    this.uniforms.uParityFlip.value = this.hc.def.twoColor ? this.parity : 0;
    this.uniforms.uFog.value = this.fogOn ? 0.5 : 0.05;
    this.mesh.visible = true;

    // start marker: translate the base sphere to the original origin
    const hd = Math.acosh(Math.max(1, this.home[3]));
    const dir = hd > 1e-9 ? [this.home[0], this.home[1], this.home[2]].map((x) => (x / Math.sinh(hd)) * hd) : [0, 0, 0];
    H.boost(this.beaconModel, dir);
    this.beacon.visible = this.showBeacon && hd < 7;
    this.homeDistance = H.hdist([this.Hm[3], this.Hm[7], this.Hm[11], this.Hm[15]], this.home);
  }

  menuRows() {
    return [
      {
        type: 'tabs',
        options: Object.entries(HONEYCOMBS).map(([k, v]) => ({ label: v.label, value: k, small: true })),
        get: () => this.hcKey,
        set: (k) => this.setHoneycomb(k),
      },
      { type: 'slider', label: 'Curvature scale (metres per unit)', min: 0.5, max: 3.5, get: () => this.uniforms.uL.value, set: (v) => { this.uniforms.uL.value = v; }, format: (v) => `${v.toFixed(1)} m` },
      {
        type: 'toggles', columns: 2,
        items: [
          { label: 'Distance fog', get: () => this.fogOn, set: (v) => { this.fogOn = v; } },
          { label: 'Start marker', get: () => this.showBeacon, set: (v) => { this.showBeacon = v; } },
        ],
      },
      { type: 'buttons', items: [{ label: 'Return to start', onClick: () => this.goHome() }] },
      { type: 'text', text: () => `Distance from start: ${(this.homeDistance || 0).toFixed(1)} units (${((this.homeDistance || 0) * this.uniforms.uL.value).toFixed(1)} m)`, lines: 2, color: '#dfe2ff' },
    ];
  }

  hint(mode) {
    const blurb = HONEYCOMBS[this.hcKey].blurb;
    if (mode === 'desktop') return `${blurb} Moving in a loop leaves you rotated (holonomy).`;
    if (mode === 'controllers') return `${blurb} Walk around, or use the stick to move. Walking in a loop leaves you rotated (holonomy).`;
    return `${blurb} Walk around, or pinch empty space and pull to move. Walking in a loop leaves you rotated (holonomy).`;
  }

  desktopHelp({ touch } = {}) {
    if (touch) return '<b>Drag</b> to look around · moving needs a keyboard or a headset';
    return '<b>WASD</b> move (<b>Shift</b> faster, <b>Q/E</b> down/up) · <b>drag</b> to look · <b>right-drag</b> to pull · <b>M</b> menu';
  }
}
