// Spherical Space: regular 4-polytopes as tilings of the 3-sphere, seen from inside.
//
// Pushing the vertices of a regular 4-polytope out onto its circumscribed
// 3-sphere tiles S³ with curved copies of its cells: 120 dodecahedra, 24
// octahedra, 8 cubes or 5 tetrahedra, three around each edge with 120°
// dihedral angles. In flat space three of these cells leave a gap around an edge.
//
// Points of S³ are unit vectors in R⁴ and its isometries are rotations of R⁴,
// so each frame's head movement is converted to a rotation and accumulated, as
// in Hyperbolic Space. S³ is finite, so the whole tiling is drawn and no
// re-centring is needed.
//
// Every geodesic is a great circle of length 2π, so light from each point
// reaches the eye along two arcs: the short one (direction u, distance t) and
// the long one (direction −u, distance 2π − t). Everything is drawn twice, once
// per arc. Looking straight ahead along the long arc, the view ends at the back
// of your own head, which is drawn as an avatar around the eyes.
//
// Each vertex is placed in its true direction from the eye at its true
// distance (in metres), which gives each triangle exactly the right outline on
// screen. Near the antipodal point a small triangle can cover a large part of
// the view, so depth is written per fragment from the interpolated distance.
// See Hart, Hawksley, Matsumoto and Segerman, "Non-Euclidean Virtual Reality".

import * as THREE from 'three';
import * as R4 from '../math/rot4.js';
import * as V from '../math/vec4.js';
import * as S from '../math/spherical.js';
import * as P from '../four/polytopes.js';
import { SceneBase } from './base.js';
import { icosphere, axisColor, directionColor } from '../four/tetmesh.js';
import { BONES } from '../core/handVisuals.js';

const TILINGS = {
  c120: {
    label: '120-cell', get: P.hecatonicosachoron, L: 1.6, color: (c) => directionColor(c.normal),
    blurb: '120 dodecahedra, three around each edge.',
  },
  c24: {
    label: '24-cell', get: P.icositetrachoron, L: 1.0, color: (c) => directionColor(c.normal),
    blurb: '24 octahedra, three around each edge.',
  },
  c8: {
    label: 'Tesseract', get: P.tesseract, L: 0.9, color: (c) => axisColor(c.normal),
    blurb: 'The 8 cubes of a tesseract. Walk through four in a straight line and you are back at the start.',
  },
  c5: {
    label: '5-cell', get: P.simplex, L: 0.7, color: (c) => directionColor(c.normal),
    blurb: 'Five tetrahedra fill the universe. At this size you can walk all the way around it.',
  },
};

const RAD = 6;          // tube radial segments (hexagonal beams)
const SEG_ANGLE = 0.075; // tube segment length (radians)

// Projection shared by every S³ shader: place the vertex along its short or
// long arc, in metres, around the eye.
const S3_PROJECT = /* glsl */ `
uniform mat3 uHeadRot;
uniform float uL;
varying vec3 vPosW;
varying float vT;
varying vec3 vN;

void s3Project(vec4 Q, vec4 D, float longWay) {
  float r = length(Q.xyz);
  float t = atan(r, Q.w);                 // distance along the short arc, 0..π
  vec3 u = r > 1e-9 ? Q.xyz / r : vec3(0.0, 0.0, -1.0);
  if (longWay > 0.5) { u = -u; t = 6.28318530718 - t; }
  vPosW = cameraPosition + uHeadRot * u * (t * uL);
  vT = t;
  // direction of the surface normal as seen from the eye (derivative of Q.xyz / Q.w)
  vN = uHeadRot * (D.xyz * Q.w - Q.xyz * D.w);
  gl_Position = projectionMatrix * viewMatrix * vec4(vPosW, 1.0);
}
`;

const S3_FRAGMENT_COMMON = /* glsl */ `
uniform mat3 uHeadRot;
uniform float uL;
uniform float uFog;
uniform vec3 uFogColor;
uniform vec2 uDepth; // projectionMatrix[2][2], [3][2]
varying vec3 vPosW;
varying float vT;
varying vec3 vN;

// Depth of the point at the true distance along this pixel's view ray. The
// rasterised triangle can pass much closer to the eye than the surface it
// stands for (near the antipodal point), so the vertex depth isn't used.
void s3Depth() {
  vec3 P = cameraPosition + normalize(vPosW - cameraPosition) * (vT * uL);
  float zv = (viewMatrix * vec4(P, 1.0)).z;
  gl_FragDepth = 0.5 * (uDepth.x * zv + uDepth.y) / -zv + 0.5;
}
`;

const TILING_VERT = /* glsl */ `
${S3_PROJECT}
uniform mat4 uEyeInv;  // world → this eye (rotation of R⁴)
uniform float uLongWay;
attribute vec4 aS;     // point on S³
attribute vec4 aD;     // outward unit tangent at aS
attribute float aKind; // 0 edge, 1 node, 2 lantern
attribute vec3 aColor;
varying vec3 vColor;
varying float vKind;
void main() {
  vColor = aColor;
  vKind = aKind;
  s3Project(uEyeInv * aS, uEyeInv * aD, uLongWay);
}
`;

const TILING_FRAG = /* glsl */ `
${S3_FRAGMENT_COMMON}
uniform vec3 uNear;
uniform vec3 uMid;
uniform vec3 uFar;
uniform vec3 uBack;
uniform float uGlow;
varying vec3 vColor;
varying float vKind;
void main() {
  vec3 N = normalize(vN + vec3(1e-9));
  vec3 V = normalize(cameraPosition - vPosW);
  float ndv = abs(dot(N, V));
  // warm along the short arc (0..π), cool along the long arc (π..2π)
  float s = vT / 3.14159265;
  vec3 base = s < 0.5 ? mix(uNear, uMid, s * 2.0) : (s < 1.0 ? mix(uMid, uFar, s * 2.0 - 1.0) : mix(uFar, uBack, clamp((s - 1.0) * 2.0, 0.0, 1.0)));
  vec3 c = vKind > 0.5 ? mix(base, vec3(1.0), 0.35) : base;
  vec3 col = c * (0.3 + 0.7 * ndv) + c * pow(1.0 - ndv, 2.5) * 0.6;
  if (vKind > 1.5) col = vColor * (1.2 + uGlow) + pow(1.0 - ndv, 2.5) * vec3(1.0);
  col = mix(uFogColor, col, exp(-vT * uFog));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  s3Depth();
}
`;

// The avatar is modelled in metres around the eyes (head-local frame) and
// placed on S³ with the exponential map. Only its long-arc image is drawn: the
// short one is where you are.
const AVATAR_VERT = /* glsl */ `
${S3_PROJECT}
uniform mat4 uAvatarEye; // head frame → this eye
uniform mat3 uBodyRot;   // body (yaw only) → head frame
attribute vec3 aColor;
attribute float aPart;   // 0 head, 1 body
#ifdef JOINTS
attribute vec3 aCenter;
attribute float aRadius;
#endif
#ifdef BONES
attribute vec3 aA;
attribute vec3 aB;
attribute float aRadius;
#endif
varying vec3 vColor;
void main() {
  vec3 m, nl;
#if defined(JOINTS)
  m = aCenter + position * aRadius;
  nl = normal;
#elif defined(BONES)
  vec3 ax = aB - aA;
  float len = length(ax);
  vec3 e3 = ax / max(len, 1e-6);
  vec3 e1 = normalize(cross(e3, abs(e3.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 e2 = cross(e3, e1);
  m = aA + e3 * (position.y * len) + (e1 * position.x + e2 * position.z) * aRadius;
  nl = e1 * normal.x + e2 * normal.z;
#else
  m = aPart > 0.5 ? uBodyRot * position : position;
  nl = aPart > 0.5 ? uBodyRot * normal : normal;
#endif
  vColor = aColor;
  float len3 = length(m);
  float d = len3 / uL;
  vec3 dir = m / max(len3, 1e-9);
  vec4 Sp = vec4(dir * sin(d), cos(d));
  vec4 Dp = vec4(nl - dir * dot(nl, dir) * (1.0 - cos(d)), -dot(nl, dir) * sin(d)); // tangent at Sp
  s3Project(uAvatarEye * Sp, uAvatarEye * Dp, 1.0);
}
`;

const AVATAR_FRAG = /* glsl */ `
${S3_FRAGMENT_COMMON}
varying vec3 vColor;
void main() {
  vec3 N = normalize(vN + vec3(1e-9));
  vec3 V = normalize(cameraPosition - vPosW);
  float ndv = abs(dot(N, V));
  vec3 col = vColor * (0.35 + 0.65 * ndv) + vColor * pow(1.0 - ndv, 3.0) * 0.5;
  // lighter fog than the tiling, so you can still recognise yourself 2π away
  col = mix(uFogColor, col, exp(-vT * uFog * 0.45));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  s3Depth();
}
`;

// ---------------------------------------------------------------------------
// Geometry

/** Rotation of R⁴ taking the origin (0,0,0,1) to the point p of S³. */
function toPoint(out, p) {
  const r = Math.hypot(p[0], p[1], p[2]);
  const d = Math.atan2(r, p[3]);
  if (r < 1e-12) return S.translation(out, 0, 0, d); // p = ±origin
  return S.translation(out, (p[0] / r) * d, (p[1] / r) * d, (p[2] / r) * d);
}

/** Orthonormal vectors spanning the complement of the orthonormal pair a, b. */
function complementBasis(a, b) {
  const out = [];
  for (let k = 0; k < 4 && out.length < 2; k++) {
    const v = [0, 0, 0, 0];
    v[k] = 1;
    for (const u of [a, b, ...out]) V.addScaled(v, v, u, -V.dot(v, u));
    if (V.length(v) > 0.3) out.push(V.normalize(v, v));
  }
  return out;
}

/** Place the polytope with a cell centre at the origin and a neighbouring cell straight ahead (−z). */
function buildTiling(def) {
  const poly = def.get();
  const centers = poly.cells.map((c) => V.normalize([0, 0, 0, 0], c.center));
  let i0 = 0;
  for (let i = 1; i < centers.length; i++) if (centers[i][3] > centers[i0][3]) i0 = i;
  const c0 = centers[i0];
  const M = R4.mat4();
  const ang = S.sdist(c0, S.ORIGIN);
  if (ang > 1e-9) {
    const b = V.addScaled([0, 0, 0, 0], S.ORIGIN, c0, -c0[3]); // e_w minus its component along c0
    V.normalize(b, b);
    R4.rotationInPlane(M, c0, b, ang);
  }
  const moved = centers.map((c) => R4.apply([0, 0, 0, 0], M, c));
  let dmin = Infinity;
  moved.forEach((c, i) => { if (i !== i0) dmin = Math.min(dmin, S.sdist(c, S.ORIGIN)); });
  let ahead = null;
  moved.forEach((c, i) => {
    if (i === i0 || S.sdist(c, S.ORIGIN) > dmin + 1e-6) return;
    const d = new THREE.Vector3(c[0], c[1], c[2]).normalize();
    if (!ahead || d.z < ahead.z) ahead = d;
  });
  const q = new THREE.Quaternion().setFromUnitVectors(ahead, new THREE.Vector3(0, 0, -1));
  R4.multiply(M, R4.fromQuaternion(R4.mat4(), q), M);
  const verts = poly.vertices.map((v) => R4.apply([0, 0, 0, 0], M, V.normalize([0, 0, 0, 0], v)));
  const cells = poly.cells.map((c, i) => ({ center: R4.apply([0, 0, 0, 0], M, centers[i]), color: def.color(c) }));
  return { def, verts, edges: poly.edges, cells, cellDist: dmin };
}

function buildGeometry(tiling, { tube, node, lantern }) {
  const aS = [], aD = [], aKind = [], aColor = [], index = [];
  const push = (Sp, D, kind, c) => { aS.push(...Sp); aD.push(...D); aKind.push(kind); aColor.push(c[0], c[1], c[2]); return aKind.length - 1; };
  const white = [1, 1, 1];

  // edges: tubes around great-circle arcs. The normal space of a great circle
  // is the same 2-plane all along it.
  for (const [ia, ib] of tiling.edges) {
    const A = tiling.verts[ia], B = tiling.verts[ib];
    const th = S.sdist(A, B);
    const Bp = V.addScaled([0, 0, 0, 0], B, A, -V.dot(A, B));
    V.normalize(Bp, Bp);
    const [N1, N2] = complementBasis(A, Bp);
    const nSeg = Math.max(2, Math.ceil(th / SEG_ANGLE));
    const rings = [];
    for (let k = 0; k <= nSeg; k++) {
      const a = (k / nSeg) * th;
      const Pt = [0, 1, 2, 3].map((i) => Math.cos(a) * A[i] + Math.sin(a) * Bp[i]);
      const ring = [];
      for (let j = 0; j < RAD; j++) {
        const ph = (j / RAD) * Math.PI * 2;
        const D = [0, 1, 2, 3].map((i) => Math.cos(ph) * N1[i] + Math.sin(ph) * N2[i]);
        const X = [0, 1, 2, 3].map((i) => Math.cos(tube) * Pt[i] + Math.sin(tube) * D[i]);
        const Dout = [0, 1, 2, 3].map((i) => -Math.sin(tube) * Pt[i] + Math.cos(tube) * D[i]);
        ring.push(push(X, Dout, 0, white));
      }
      rings.push(ring);
    }
    for (let k = 0; k < nSeg; k++) for (let j = 0; j < RAD; j++) {
      const a0 = rings[k][j], b0 = rings[k][(j + 1) % RAD], c0 = rings[k + 1][j], d0 = rings[k + 1][(j + 1) % RAD];
      index.push(a0, c0, b0, b0, c0, d0);
    }
  }

  // small spheres (nodes, lanterns) by the exponential map around their centre
  const R = R4.mat4();
  const sphereAt = (Cp, radius, detail, kind, color) => {
    const s = icosphere(detail);
    toPoint(R, Cp);
    const base = aKind.length;
    for (const u of s.verts) {
      const D = R4.apply([0, 0, 0, 0], R, [u[0], u[1], u[2], 0]);
      const X = [0, 1, 2, 3].map((i) => Math.cos(radius) * Cp[i] + Math.sin(radius) * D[i]);
      const Dout = [0, 1, 2, 3].map((i) => -Math.sin(radius) * Cp[i] + Math.cos(radius) * D[i]);
      push(X, Dout, kind, color);
    }
    for (const [x, y, z] of s.tris) index.push(base + x, base + y, base + z);
  };
  for (const v of tiling.verts) sphereAt(v, node, 0, 1, white);
  for (const c of tiling.cells) sphereAt(c.center, lantern, 1, 2, c.color);
  return makeGeometry(aS, aD, aKind, aColor, index);
}

function makeGeometry(aS, aD, aKind, aColor, index) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('aS', new THREE.Float32BufferAttribute(aS, 4));
  g.setAttribute('aD', new THREE.Float32BufferAttribute(aD, 4));
  g.setAttribute('aKind', new THREE.Float32BufferAttribute(aKind, 1));
  g.setAttribute('aColor', new THREE.Float32BufferAttribute(aColor, 3));
  g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(aKind.length * 3), 3));
  g.setIndex(aKind.length > 65535 ? new THREE.Uint32BufferAttribute(index, 1) : new THREE.Uint16BufferAttribute(index, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return g;
}

/** Glowing marker sphere at point p. */
function markerGeometry(p, radius) {
  const aS = [], aD = [], aK = [], aC = [];
  const s = icosphere(2);
  const R = toPoint(R4.mat4(), p);
  for (const u of s.verts) {
    const D = R4.apply([0, 0, 0, 0], R, [u[0], u[1], u[2], 0]);
    aS.push(...[0, 1, 2, 3].map((i) => Math.cos(radius) * p[i] + Math.sin(radius) * D[i]));
    aD.push(...[0, 1, 2, 3].map((i) => -Math.sin(radius) * p[i] + Math.cos(radius) * D[i]));
    aK.push(2); aC.push(1, 1, 1);
  }
  return makeGeometry(aS, aD, aK, aC, s.tris.flat());
}

/**
 * Stylised avatar in metres around the eyes (−z forward, +y up): head, hair,
 * ears, a headset with a strap, and a body that only turns with the head's yaw.
 */
function avatarGeometry() {
  const parts = [];
  const add = (geo, color, part, matrix) => {
    geo.applyMatrix4(matrix);
    parts.push({ geo, color: new THREE.Color(color), part });
  };
  const m = (x, y, z, sx = 1, sy = 1, sz = 1, rx = 0) => new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, 0, 0)), new THREE.Vector3(sx, sy, sz));
  const skin = '#f0cdb0', hair = '#7a5238', headset = '#d6d9e0', strap = '#ff4f9a', visor = '#1d2029', shirt = '#5b6fc4';
  // head
  add(new THREE.SphereGeometry(1, 40, 28), skin, 0, m(0, 0.03, 0.075, 0.077, 0.104, 0.099));
  add(new THREE.SphereGeometry(1, 40, 28, 0, Math.PI * 2, 0, Math.PI * 0.62), hair, 0, m(0, 0.045, 0.09, 0.083, 0.1, 0.1, 0.55));
  for (const sx of [-1, 1]) add(new THREE.SphereGeometry(1, 16, 12), skin, 0, m(sx * 0.078, 0.02, 0.085, 0.014, 0.03, 0.02));
  // headset and strap
  add(new THREE.BoxGeometry(0.19, 0.1, 0.085, 2, 2, 2), headset, 0, m(0, 0.0, -0.035));
  add(new THREE.BoxGeometry(0.16, 0.06, 0.006), visor, 0, m(0, 0.0, -0.079));
  add(new THREE.TorusGeometry(1, 0.13, 10, 48).rotateX(Math.PI / 2), strap, 0, m(0, 0.01, 0.05, 0.088, 0.09, 0.108));
  // body (turns with the head's yaw only)
  add(new THREE.CapsuleGeometry(0.048, 0.12, 6, 16), skin, 1, m(0, -0.15, 0.085));
  add(new THREE.CapsuleGeometry(0.07, 0.3, 8, 20).rotateZ(Math.PI / 2), shirt, 1, m(0, -0.27, 0.09));
  add(new THREE.CapsuleGeometry(0.14, 0.38, 10, 28), shirt, 1, m(0, -0.5, 0.095, 1.15, 1, 0.72));

  const pos = [], nrm = [], col = [], part = [], index = [];
  for (const p of parts) {
    const g = p.geo;
    const base = pos.length / 3;
    const gp = g.attributes.position, gn = g.attributes.normal;
    for (let i = 0; i < gp.count; i++) {
      pos.push(gp.getX(i), gp.getY(i), gp.getZ(i));
      nrm.push(gn.getX(i), gn.getY(i), gn.getZ(i));
      col.push(p.color.r, p.color.g, p.color.b);
      part.push(p.part);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) index.push(base + g.index.getX(i));
    else for (let i = 0; i < gp.count; i++) index.push(base + i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aColor', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  g.setIndex(index);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return g;
}

function instancedFrom(base, count, attrs) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', base.attributes.position);
  g.setAttribute('normal', base.attributes.normal);
  g.setIndex(base.index);
  for (const [name, size] of attrs) g.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(count * size), size).setUsage(THREE.DynamicDrawUsage));
  g.instanceCount = 0;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
  return g;
}

// ---------------------------------------------------------------------------

const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _mv = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _euler = new THREE.Euler();
const _E = R4.mat4();
const _T = R4.mat4();
const _B = R4.mat4();
const _fwd = new THREE.Vector3();
const _yaw = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);
const _head = [0, 0, 0, 0];
const HAND_COLOR = new THREE.Color('#dfe6ff');
const MAX_JOINTS = 60;
const MAX_BONES = BONES.length * 2;

export class SphericalScene extends SceneBase {
  constructor(app) {
    super(app);
    this.key = 'spherical';
    this.title = 'Spherical Space';
    this.short = 'Spherical';
    this.subtitle = 'Regular polytopes as tilings of the 3-sphere';
    this.mood = 'spherical';
    this.noOrbit = true;
    this.locomotion = true; // snap turn and the comfort vignette (see App)

    this.uniforms = {
      uEyeInv: { value: new THREE.Matrix4() },
      uHeadRot: { value: new THREE.Matrix3() },
      uL: { value: 1.6 },
      uFog: { value: 0.2 },
      uFogColor: { value: new THREE.Color('#1a1224') },
      uDepth: { value: new THREE.Vector2(-1, -0.04) },
      uNear: { value: new THREE.Color('#fff1d6') },
      uMid: { value: new THREE.Color('#ffb46b') },
      uFar: { value: new THREE.Color('#ff5f8f') },
      uBack: { value: new THREE.Color('#6f7dff') },
      uGlow: { value: 0 },
    };
    // one material per arc; they share every uniform except uLongWay
    this.tilingMats = [0, 1].map((longWay) => new THREE.ShaderMaterial({
      uniforms: { ...this.uniforms, uLongWay: { value: longWay } },
      vertexShader: TILING_VERT,
      fragmentShader: TILING_FRAG,
    }));
    this.beaconMats = [0, 1].map((longWay) => new THREE.ShaderMaterial({
      uniforms: { ...this.uniforms, uLongWay: { value: longWay }, uGlow: { value: 1.5 } },
      vertexShader: TILING_VERT,
      fragmentShader: TILING_FRAG,
    }));

    // avatar: head, body and tracked hands, long arc only
    this.avatarUniforms = {
      uHeadRot: this.uniforms.uHeadRot,
      uL: this.uniforms.uL,
      uFog: this.uniforms.uFog,
      uFogColor: this.uniforms.uFogColor,
      uDepth: this.uniforms.uDepth,
      uAvatarEye: { value: new THREE.Matrix4() },
      uBodyRot: { value: new THREE.Matrix3() },
    };
    const avatarMat = (defines) => new THREE.ShaderMaterial({ uniforms: this.avatarUniforms, vertexShader: AVATAR_VERT, fragmentShader: AVATAR_FRAG, defines });
    this.avatar = new THREE.Group();
    this.root.add(this.avatar);
    this.avatarBody = new THREE.Mesh(avatarGeometry(), avatarMat({}));
    const sphere = new THREE.SphereGeometry(1, 10, 8);
    this.jointGeo = instancedFrom(sphere, MAX_JOINTS, [['aCenter', 3], ['aRadius', 1], ['aColor', 3]]);
    this.joints = new THREE.Mesh(this.jointGeo, avatarMat({ JOINTS: '' }));
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true).translate(0, 0.5, 0);
    this.boneGeo = instancedFrom(cyl, MAX_BONES, [['aA', 3], ['aB', 3], ['aRadius', 1], ['aColor', 3]]);
    this.bones = new THREE.Mesh(this.boneGeo, avatarMat({ BONES: '' }));
    for (const mesh of [this.avatarBody, this.joints, this.bones]) {
      mesh.frustumCulled = false;
      mesh.onBeforeRender = (r, s, camera) => this._setEye(camera, mesh.material, true);
      this.avatar.add(mesh);
    }
    for (let i = 0; i < MAX_JOINTS; i++) this.jointGeo.attributes.aColor.setXYZ(i, HAND_COLOR.r, HAND_COLOR.g, HAND_COLOR.b);
    for (let i = 0; i < MAX_BONES; i++) this.boneGeo.attributes.aColor.setXYZ(i, HAND_COLOR.r * 0.85, HAND_COLOR.g * 0.85, HAND_COLOR.b * 0.85);

    this.Hm = R4.mat4();   // head pose: world ← head (rotation of R⁴)
    this.HmT = R4.mat4();
    this.headPos = new THREE.Vector3();
    this.headQuatInv = new THREE.Quaternion();
    this.prevPos = new THREE.Vector3();
    this.prevQuat = new THREE.Quaternion();
    this.hasPrev = false;
    this.fogOn = true;
    this.showSelf = true;
    this.showBeacon = true;
    this.yaw = 0;
    this.pitch = 0;
    this.keys = new Set();
    this.homeDistance = 0;
    this.travelled = 0;

    this.setTiling('c120');
    this.desktopView = { position: new THREE.Vector3(0, 1.6, 0), target: new THREE.Vector3(0, 1.6, -1) };
    this._onKeyDown = (e) => { if (!e.ctrlKey && !e.metaKey && !e.altKey) this.keys.add(e.key.toLowerCase()); };
    this._onKeyUp = (e) => this.keys.delete(e.key.toLowerCase());
    this._onBlur = () => this.keys.clear();
    this._onPointerMove = (e) => {
      if (this.app.presenting || !(e.buttons & 1) || !this.app.pointerOnEmpty) return;
      this.yaw -= e.movementX * 0.004;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.004, -1.4, 1.4);
    };
  }

  setTiling(key) {
    this.tilingKey = key;
    const def = TILINGS[key];
    // thickness in S³ units, chosen for about 1.8 cm tubes at the tiling's default size
    const k = 1.6 / def.L;
    // Each tiling is built once and kept: the 120-cell takes long enough to
    // stall the headset, so switching back to it shouldn't build it again.
    this._built ??= new Map();
    let built = this._built.get(key);
    if (!built) {
      const t0 = performance.now();
      const tiling = buildTiling(def);
      built = { tiling, geo: buildGeometry(tiling, { tube: 0.0105 * k, node: 0.02 * k, lantern: 0.024 * k }) };
      this._built.set(key, built);
      console.info(`[spherical] ${def.label}: ${tiling.cells.length} cells, ${tiling.edges.length} edges, ${built.geo.attributes.aKind.count} verts in ${(performance.now() - t0).toFixed(0)} ms`);
    }
    this.tiling = built.tiling;
    for (const mesh of this.tilingMeshes || []) { mesh.removeFromParent(); }
    this.tilingMeshes = this.tilingMats.map((mat) => {
      const mesh = new THREE.Mesh(built.geo, mat);
      mesh.frustumCulled = false;
      mesh.onBeforeRender = (r, s, camera) => this._setEye(camera, mat, false);
      this.root.add(mesh);
      return mesh;
    });
    this.uniforms.uL.value = def.L;
    // start between the first cell's centre and the face behind it, looking at the centre
    this.startOffset = 0.55 * this.tiling.cellDist * 0.5;
    this.home = S.expOrigin([0, 0, this.startOffset]);
    for (const mesh of this.beacons || []) { mesh.removeFromParent(); }
    this.beacons?.[0].geometry.dispose();
    this.beaconRadius = 0.05 * k;
    const bgeo = markerGeometry(this.home, this.beaconRadius);
    this.beacons = this.beaconMats.map((mat) => {
      const mesh = new THREE.Mesh(bgeo, mat);
      mesh.frustumCulled = false;
      mesh.onBeforeRender = (r, s, camera) => this._setEye(camera, mat, false);
      this.root.add(mesh);
      return mesh;
    });
    this.goHome();
    if (this.app.activeScene === this) this.app.menu.rebuild();
  }

  /** Per-eye transforms (three.js calls onBeforeRender separately for each eye). */
  _setEye(camera, material, avatar) {
    const L = this.uniforms.uL.value;
    _v.setFromMatrixPosition(camera.matrixWorld).sub(this.headPos).applyQuaternion(this.headQuatInv).divideScalar(L);
    S.translation(_E, -_v.x, -_v.y, -_v.z); // head frame → this eye
    if (avatar) R4.toThreeMatrix(material.uniforms.uAvatarEye.value, _E, 1);
    else R4.toThreeMatrix(material.uniforms.uEyeInv.value, R4.multiply(_T, _E, this.HmT), 1);
    const pe = camera.projectionMatrix.elements;
    material.uniforms.uDepth.value.set(pe[10], pe[14]);
    material.uniformsNeedUpdate = true;
  }

  goHome() {
    S.translation(this.Hm, 0, 0, this.startOffset);
    this.hasPrev = false;
    this.travelled = 0;
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

  /** Move the viewer by a head-local displacement (radians of S³). */
  _translateLocal(x, y, z) {
    R4.multiply(this.Hm, this.Hm, S.translation(_B, x, y, z));
    this.travelled += Math.sqrt(x * x + y * y + z * z);
  }

  _rotateLocal(q) {
    R4.multiply(this.Hm, this.Hm, R4.fromQuaternion(_B, q));
  }

  onEmptyGrabStart(ix) {
    this.pull = { last: ix.grabPos.clone() };
    return true;
  }

  onEmptyGrabUpdate(ix) {
    if (!this.pull) return;
    const d = _mv.copy(ix.grabPos).sub(this.pull.last);
    this.pull.last.copy(ix.grabPos);
    const gain = (ix.isMouse ? 2.5 : 3.0) / this.uniforms.uL.value;
    this.app.addMotion(d.length() * gain * this.uniforms.uL.value);
    d.multiplyScalar(-gain).applyQuaternion(_qi.copy(this.app.headQuaternion).invert());
    this._translateLocal(d.x, d.y, d.z);
  }

  onEmptyGrabEnd() { this.pull = null; }

  update(dt) {
    const app = this.app;
    const L = this.uniforms.uL.value;

    if (!app.presenting) {
      app.camera.position.copy(this.desktopView.position);
      app.camera.quaternion.setFromEuler(_euler.set(this.pitch, this.yaw, 0, 'YXZ'));
      app.camera.updateMatrixWorld();
      app.camera.getWorldPosition(app.headPosition);
      app.camera.getWorldQuaternion(app.headQuaternion);
      const mv = _mv.set(
        (this.keys.has('d') ? 1 : 0) - (this.keys.has('a') ? 1 : 0),
        (this.keys.has('e') ? 1 : 0) - (this.keys.has('q') ? 1 : 0),
        (this.keys.has('s') ? 1 : 0) - (this.keys.has('w') ? 1 : 0),
      );
      if (mv.lengthSq() > 0) {
        mv.normalize().multiplyScalar(((this.keys.has('shift') ? 3.0 : 1.3) * dt) / L); // metres per second
        this._translateLocal(mv.x, mv.y, mv.z);
      }
    }

    // path-integrate head motion into the pose on S³
    const pos = app.headPosition, quat = app.headQuaternion;
    if (this.hasPrev) {
      const dp = _v.copy(pos).sub(this.prevPos);
      if (dp.length() < 0.5) {
        dp.applyQuaternion(_q.copy(this.prevQuat).invert()).divideScalar(L);
        this._translateLocal(dp.x, dp.y, dp.z);
      }
      this._rotateLocal(_q.copy(this.prevQuat).invert().multiply(quat));
    } else {
      R4.multiply(this.Hm, this.Hm, R4.fromQuaternion(_B, quat));
    }
    this.prevPos.copy(pos);
    this.prevQuat.copy(quat);
    this.hasPrev = true;

    for (const ix of app.input.xr) {
      if (ix.kind !== 'controller' || (!ix.stick.x && !ix.stick.y)) continue;
      const v = _mv.set(ix.stick.x, 0, ix.stick.y).multiplyScalar((dt * 0.9) / L);
      app.addMotion(v.length() * L);
      v.applyQuaternion(ix.rayQuat).applyQuaternion(_qi.copy(quat).invert());
      this._translateLocal(v.x, v.y, v.z);
    }

    R4.orthonormalize(this.Hm);
    R4.transpose(this.HmT, this.Hm);
    this.headPos.copy(pos);
    this.headQuatInv.copy(quat).invert();
    _m4.makeRotationFromQuaternion(quat);
    this.uniforms.uHeadRot.value.setFromMatrix4(_m4);
    this.uniforms.uFog.value = this.fogOn ? 0.2 : 0.02;

    // the body follows the head's yaw
    _fwd.set(0, 0, -1).applyQuaternion(quat);
    _yaw.setFromAxisAngle(_up, Math.atan2(-_fwd.x, -_fwd.z));
    _m4.makeRotationFromQuaternion(_q.copy(this.headQuatInv).multiply(_yaw));
    this.avatarUniforms.uBodyRot.value.setFromMatrix4(_m4);
    this.avatar.visible = this.showSelf;
    if (this.showSelf) this._updateHands();

    _head[0] = this.Hm[3]; _head[1] = this.Hm[7]; _head[2] = this.Hm[11]; _head[3] = this.Hm[15];
    this.homeDistance = S.sdist(_head, this.home);
    for (const b of this.beacons) b.visible = this.showBeacon && this.homeDistance > this.beaconRadius * 3;
  }

  /** World position → head-local metres. */
  _toHead = (p, out) => out.copy(p).sub(this.headPos).applyQuaternion(this.headQuatInv);

  /** Tracked hands (or controllers) in head-local metres, for the avatar. */
  _updateHands() {
    const ja = this.jointGeo.attributes, ba = this.boneGeo.attributes;
    let nj = 0, nb = 0;
    const local = this._toHead;
    if (this.app.presenting) {
      for (const ix of this.app.input.xr) {
        if (!ix.active) continue;
        if (ix.kind === 'hand' && ix.jointsValid) {
          for (let j = 0; j < 25 && nj < MAX_JOINTS; j++) {
            local(ix.joints[j].pos, _v);
            ja.aCenter.setXYZ(nj, _v.x, _v.y, _v.z);
            ja.aRadius.setX(nj, Math.max(0.004, ix.joints[j].radius * 0.85));
            nj++;
          }
          for (const [a, b] of BONES) {
            if (nb >= MAX_BONES) break;
            local(ix.joints[a].pos, _v);
            ba.aA.setXYZ(nb, _v.x, _v.y, _v.z);
            local(ix.joints[b].pos, _v);
            ba.aB.setXYZ(nb, _v.x, _v.y, _v.z);
            ba.aRadius.setX(nb, Math.max(0.003, Math.min(ix.joints[a].radius, ix.joints[b].radius) * 0.6));
            nb++;
          }
        } else if (ix.kind === 'controller' && nj < MAX_JOINTS) {
          local(ix.grabPos, _v);
          ja.aCenter.setXYZ(nj, _v.x, _v.y, _v.z);
          ja.aRadius.setX(nj, 0.03);
          nj++;
        }
      }
    }
    this.jointGeo.instanceCount = nj;
    this.boneGeo.instanceCount = nb;
    this.joints.visible = nj > 0;
    this.bones.visible = nb > 0;
    if (nj) { ja.aCenter.needsUpdate = true; ja.aRadius.needsUpdate = true; }
    if (nb) { ba.aA.needsUpdate = true; ba.aB.needsUpdate = true; ba.aRadius.needsUpdate = true; }
  }

  menuRows() {
    const L = () => this.uniforms.uL.value;
    return [
      {
        type: 'tabs',
        options: Object.entries(TILINGS).map(([k, v]) => ({ label: v.label, value: k, small: true })),
        get: () => this.tilingKey,
        set: (k) => this.setTiling(k),
      },
      { type: 'slider', label: 'Radius of the 3-sphere', min: 0.5, max: 3.0, get: L, set: (v) => { this.uniforms.uL.value = v; }, format: (v) => `${v.toFixed(1)} m` },
      {
        type: 'toggles', columns: 3,
        items: [
          { label: 'Show yourself', get: () => this.showSelf, set: (v) => { this.showSelf = v; } },
          { label: 'Distance fog', get: () => this.fogOn, set: (v) => { this.fogOn = v; } },
          { label: 'Start marker', get: () => this.showBeacon, set: (v) => { this.showBeacon = v; } },
        ],
      },
      { type: 'buttons', items: [{ label: 'Return to start', onClick: () => this.goHome() }] },
      {
        type: 'text', lines: 2, color: '#dfe2ff',
        text: () => `Distance from start ${(this.homeDistance * L()).toFixed(1)} m. All the way around: ${(2 * Math.PI * L()).toFixed(1)} m.`,
      },
    ];
  }

  hint(mode) {
    const blurb = TILINGS[this.tilingKey].blurb;
    const far = 'Light also reaches you the long way round, so straight ahead, far away, is the back of your own head.';
    if (mode === 'desktop') return `${blurb} ${far}`;
    const sticks = this.app.comfort.snapTurn ? 'Walk, or use the left stick to move and the right stick to turn.' : 'Walk, or use the sticks to move.';
    if (mode === 'controllers') return `${blurb} ${sticks} ${far}`;
    return `${blurb} Walk, or pinch empty space and pull to move. ${far}`;
  }

  desktopHelp({ touch } = {}) {
    if (touch) return '<b>Drag</b> to look around · moving needs a keyboard or a headset';
    return '<b>WASD</b> move (<b>Shift</b> faster, <b>Q/E</b> down/up) · <b>drag</b> to look · <b>right-drag</b> to pull · <b>M</b> menu';
  }
}
