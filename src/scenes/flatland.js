// Flatland: a 2D world on a sheet, for seeing 4D the way a 2D being would
// see 3D. (After Edwin Abbott's "Flatland", 1884.)
//
// Everything that meets the sheet is drawn as its cross-section, found per
// pixel from signed distance functions: the 3D visitors (a sphere, a cube, a
// cone and a torus) and your tracked hand, as capsules around its bones.
// Pushing a finger through shows the Flatlanders five circles that appear from
// nowhere, grow and merge. That is what Hyperplay shows us of 4D objects.
//
// A Square, the narrator of Abbott's book, sees a 1D image. The strip above the
// sheet is that image: rays cast within the plane, dimmed by distance (in
// Flatland, fog is how shapes and distances are judged).
//
// Flatlanders can be lifted out of the plane (from their point of view they
// vanish) and put back. Put back upside down, a Flatlander is mirror-reversed,
// which no motion inside Flatland can undo. The gem in the sealed vault can be
// taken out without opening it, like the ball in Hyperplay's sealed box.

import * as THREE from 'three';
import { SceneBase, makeLabel, Burst } from './base.js';
import { BONES } from '../core/handVisuals.js';

const W = 0.45, D = 0.3;         // half-size of the sheet (x, z)
const MAX_SEGS = 64;
const MAX_CAPS = 32;
const FOV = THREE.MathUtils.degToRad(120);
const FOG = 0.3;                 // metres for the view to dim by 1/e

// --- signed distance functions (the same in GLSL and JS) -------------------------

const SDF_GLSL = /* glsl */ `
uniform int uObjCount;
uniform int uObjType[4];      // 0 sphere, 1 box, 2 cone, 3 torus
uniform vec3 uObjPos[4];
uniform mat3 uObjRotT[4];     // board → object rotation
uniform vec3 uObjSize[4];     // sphere (r) · box (half sizes) · cone (base r, height) · torus (R, r)
uniform vec3 uObjColor[4];
uniform sampler2D uCaps;      // hand bones: row 0 (a, radius), row 1 (b)
uniform int uCapCount;

float sdBox(vec3 p, vec3 b) { vec3 q = abs(p) - b; return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0); }
float sdTorus(vec3 p, vec2 t) { vec2 q = vec2(length(p.xz) - t.x, p.y); return length(q) - t.y; }
// cone with its apex at the origin, opening downwards to a base of radius r at y = −h (Inigo Quilez)
float sdCone(vec3 p, float r, float h) {
  vec2 q = vec2(r, -h);
  vec2 w = vec2(length(p.xz), p.y);
  vec2 a = w - q * clamp(dot(w, q) / dot(q, q), 0.0, 1.0);
  vec2 b = w - q * vec2(clamp(w.x / q.x, 0.0, 1.0), 1.0);
  float k = sign(q.y);
  float d = min(dot(a, a), dot(b, b));
  float s = max(k * (w.x * q.y - w.y * q.x), k * (w.y - q.y));
  return sqrt(d) * sign(s);
}
float sdCapsule(vec3 p, vec3 a, vec3 b, float r) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-9), 0.0, 1.0);
  return length(pa - ba * h) - r;
}
float sdObj(int i, vec3 p) {
  vec3 q = uObjRotT[i] * (p - uObjPos[i]);
  vec3 s = uObjSize[i];
  if (uObjType[i] == 0) return length(q) - s.x;
  if (uObjType[i] == 1) return sdBox(q, s);
  if (uObjType[i] == 2) return sdCone(q - vec3(0.0, s.y * 0.5, 0.0), s.x, s.y);
  return sdTorus(q, s.xy);
}
float sdHands(vec3 p) {
  float d = 1e3;
  for (int i = 0; i < ${MAX_CAPS}; i++) {
    if (i >= uCapCount) break;
    vec4 a = texelFetch(uCaps, ivec2(i, 0), 0);
    vec3 b = texelFetch(uCaps, ivec2(i, 1), 0).xyz;
    d = min(d, sdCapsule(p, a.xyz, b, a.w));
  }
  return d;
}
// distance to the nearest visitor or hand; id = object index, 4 for a hand, −1 for none
float sdIntruders(vec3 p, out int id) {
  float d = sdHands(p);
  id = d < 1e2 ? 4 : -1;
  for (int i = 0; i < 4; i++) {
    if (i >= uObjCount) break;
    float e = sdObj(i, p);
    if (e < d) { d = e; id = i; }
  }
  return d;
}
vec3 intruderColor(int id) {
  if (id == 4) return vec3(0.95, 0.66, 0.58);
  for (int i = 0; i < 4; i++) if (i == id) return uObjColor[i];
  return vec3(0.5);
}
`;

// Outline of each cross-section, drawn over everything: from above, whatever
// pokes up through the sheet would otherwise hide its own cross-section.
const OUTLINE_FRAG = /* glsl */ `
${SDF_GLSL}
varying vec2 vXZ;
void main() {
  int id;
  float d = sdIntruders(vec3(vXZ.x, 0.0, vXZ.y), id);
  float fw = max(fwidth(d), 1e-5);
  float edge = 1.0 - smoothstep(fw * 0.8, fw * 2.2, abs(d));
  if (id < 0 || edge < 0.01) discard;
  vec3 c = mix(intruderColor(id), vec3(1.0), 0.35);
  gl_FragColor = vec4(c, edge);
  #include <colorspace_fragment>
}
`;

const SHEET_VERT = /* glsl */ `
varying vec2 vXZ;
void main() {
  vXZ = position.xz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SHEET_FRAG = /* glsl */ `
${SDF_GLSL}
varying vec2 vXZ;
void main() {
  vec3 p = vec3(vXZ.x, 0.0, vXZ.y);
  // paper with a faint grid
  vec2 g = abs(fract(vXZ / 0.05 - 0.5) - 0.5) * 0.05;
  vec2 fwg = fwidth(vXZ);
  float grid = 1.0 - smoothstep(0.0, 1.5 * max(fwg.x, fwg.y), min(g.x, g.y));
  vec3 col = mix(vec3(0.95, 0.94, 0.9), vec3(0.84, 0.83, 0.79), grid * 0.6);
  // cross-sections of whatever passes through the plane
  int id;
  float d = sdIntruders(p, id);
  float fw = max(fwidth(d), 1e-5);
  if (id >= 0) {
    vec3 c = intruderColor(id);
    float inside = 1.0 - smoothstep(-fw, fw, d);
    float edge = 1.0 - smoothstep(fw, 2.5 * fw, abs(d + 1.5 * fw));
    col = mix(col, c, inside * 0.9);
    col = mix(col, c * 0.35, edge);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// A Square's view: one ray per column, cast within the plane.
const VIEW_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

const VIEW_FRAG = /* glsl */ `
${SDF_GLSL}
uniform vec3 uEye;       // x, z, heading
uniform float uMirror;   // 1 when the viewer has been turned over
uniform sampler2D uSegs; // walls and outlines: row 0 (a.xz, b.xz), row 1 (colour)
uniform int uSegCount;
varying vec2 vUv;
void main() {
  // the left of the strip is the viewer's left
  float delta = (vUv.x - 0.5) * ${FOV.toFixed(6)} * (uMirror > 0.5 ? -1.0 : 1.0);
  float ang = uEye.z + delta;
  vec2 o = uEye.xy, dir = vec2(cos(ang), sin(ang));
  float tHit = 2.0;
  vec3 hitCol = vec3(0.0);
  for (int i = 0; i < ${MAX_SEGS}; i++) {
    if (i >= uSegCount) break;
    vec4 s = texelFetch(uSegs, ivec2(i, 0), 0);
    vec2 a = s.xy, e = s.zw - s.xy;
    float den = dir.x * e.y - dir.y * e.x;
    if (abs(den) < 1e-9) continue;
    vec2 ao = a - o;
    float t = (ao.x * e.y - ao.y * e.x) / den;
    float u = (ao.x * dir.y - ao.y * dir.x) / den;
    if (t > 1e-4 && t < tHit && u >= 0.0 && u <= 1.0) { tHit = t; hitCol = texelFetch(uSegs, ivec2(i, 1), 0).rgb; }
  }
  // intruders: sphere-trace the 3D distance within the plane (a safe step: the
  // distance within the plane is never smaller)
  float t = 0.0;
  for (int k = 0; k < 48; k++) {
    if (t >= tHit) break;
    int id;
    float d = sdIntruders(vec3(o.x + dir.x * t, 0.0, o.y + dir.y * t), id);
    if (d < 0.0008) { tHit = t; hitCol = intruderColor(id); break; }
    t += max(d, 0.0015);
  }
  vec3 fog = vec3(0.16, 0.16, 0.18);
  vec3 col = tHit < 1.9 ? mix(fog, hitCol, exp(-tHit / ${FOG.toFixed(3)})) : fog;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// JS versions, for the Flatlanders to stay clear of intruders
function sdBoxJS(x, y, z, b) {
  const qx = Math.abs(x) - b[0], qy = Math.abs(y) - b[1], qz = Math.abs(z) - b[2];
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0);
}
function sdConeJS(x, y, z, r, h) {
  const qx = r, qy = -h;
  const wx = Math.hypot(x, z), wy = y;
  const t1 = Math.min(1, Math.max(0, (wx * qx + wy * qy) / (qx * qx + qy * qy)));
  const ax = wx - qx * t1, ay = wy - qy * t1;
  const t2 = Math.min(1, Math.max(0, wx / qx));
  const bx = wx - qx * t2, by = wy - qy;
  const d = Math.min(ax * ax + ay * ay, bx * bx + by * by);
  const s = Math.max(-(wx * qy - wy * qx), -(wy - qy));
  return Math.sqrt(d) * Math.sign(s);
}
function sdCapsuleJS(p, a, b, r) {
  const pax = p.x - a.x, pay = p.y - a.y, paz = p.z - a.z;
  const bax = b.x - a.x, bay = b.y - a.y, baz = b.z - a.z;
  const h = Math.min(1, Math.max(0, (pax * bax + pay * bay + paz * baz) / Math.max(1e-9, bax * bax + bay * bay + baz * baz)));
  return Math.hypot(pax - bax * h, pay - bay * h, paz - baz * h) - r;
}

// --- the 3D visitors ----------------------------------------------------------------

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _hp = new THREE.Vector3();
const _hq = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();
const _rp = new THREE.Vector3();

class Visitor {
  constructor(scene, type, color, home, size) {
    this.scene = scene;
    this.type = type;
    this.size = size;
    this.home = home.clone();
    this.color = new THREE.Color(color);
    const geo = type === 0 ? new THREE.SphereGeometry(size[0], 40, 28)
      : type === 1 ? new THREE.BoxGeometry(size[0] * 2, size[1] * 2, size[2] * 2)
        : type === 2 ? new THREE.ConeGeometry(size[0], size[1], 40, 1)
          : new THREE.TorusGeometry(size[0], size[1], 20, 48).rotateX(Math.PI / 2);
    this.solidMat = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.05 });
    // while it crosses the sheet it turns translucent, so its cross-section shows through
    this.ghostMat = new THREE.MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.05, transparent: true, opacity: 0.38, depthWrite: false });
    this.mesh = new THREE.Mesh(geo, this.solidMat);
    this.mesh.position.copy(home);
    this.bound = type === 0 ? size[0] : type === 1 ? Math.hypot(...size) : type === 2 ? Math.hypot(size[0], size[1] / 2) : size[0] + size[1];
    scene.board.add(this.mesh);
    this.grabbedBy = null;
  }

  /** Signed distance from a board-local point. */
  sdf(p) {
    _v.copy(p).sub(this.mesh.position).applyQuaternion(_q.copy(this.mesh.quaternion).invert());
    const s = this.size;
    if (this.type === 0) return _v.length() - s[0];
    if (this.type === 1) return sdBoxJS(_v.x, _v.y, _v.z, s);
    if (this.type === 2) return sdConeJS(_v.x, _v.y - s[1] / 2, _v.z, s[0], s[1]);
    return Math.hypot(Math.hypot(_v.x, _v.z) - s[0], _v.y) - s[1];
  }

  nearDistance(p) { return this.sdf(this.scene.board.worldToLocal(_v2.copy(p))); }

  rayDistance(o, d) {
    const lo = this.scene.board.worldToLocal(_v2.copy(o));
    const c = this.mesh.position;
    const ocx = lo.x - c.x, ocy = lo.y - c.y, ocz = lo.z - c.z;
    const b = ocx * d.x + ocy * d.y + ocz * d.z, cc = ocx * ocx + ocy * ocy + ocz * ocz - this.bound * this.bound;
    if (b * b - cc < 0) return Infinity;
    let t = Math.max(0, -b - Math.sqrt(b * b - cc));
    const tEnd = -b + Math.sqrt(b * b - cc);
    const p = _rp;
    for (let i = 0; i < 40 && t < tEnd; i++) {
      p.copy(lo).addScaledVector(d, t);
      const dist = this.sdf(p);
      if (dist < 0.002) return t;
      t += Math.max(dist, 0.002);
    }
    return Infinity;
  }

  onHover(ix, on) { for (const m of [this.solidMat, this.ghostMat]) m.emissive.set(on ? 0x333333 : 0x000000); }

  /** Translucent while it meets the plane. */
  updateLook() {
    const crossing = Math.abs(this.mesh.position.y) < this.bound;
    this.mesh.material = crossing ? this.ghostMat : this.solidMat;
  }

  onGrabStart(ix, mode, kind) {
    this.grabbedBy = ix;
    this.mode = mode;
    this.kind = kind;
    this.scene.visit = null;
    ix.pose(kind, _hp, _hq);
    const hand = this.scene.board.worldToLocal(_hp.clone());
    this.offset = this.mesh.position.clone().sub(hand).applyQuaternion(_hq.clone().invert());
    this.relQ = _hq.clone().invert().multiply(this.mesh.quaternion);
    this.mouseStart = ix.isMouse ? _hp.clone() : null;
    this.startQ = this.mesh.quaternion.clone();
  }

  onGrabUpdate(ix) {
    ix.pose(this.kind, _hp, _hq);
    if (this.mouseStart && this.mode === 'secondary') {
      // desktop: drag to turn it in place
      const d = _hp.clone().sub(this.mouseStart);
      const axis = new THREE.Vector3(-d.y, d.x, 0).applyQuaternion(this.scene.app.camera.quaternion);
      const ang = axis.length() * 8;
      if (ang > 1e-5) this.mesh.quaternion.setFromAxisAngle(axis.normalize(), ang).multiply(this.startQ);
      return;
    }
    const hand = this.scene.board.worldToLocal(_hp.clone());
    this.mesh.position.copy(this.offset).applyQuaternion(_hq).add(hand);
    this.mesh.quaternion.copy(_hq).multiply(this.relQ);
  }

  onGrabEnd() { this.grabbedBy = null; } // visitors stay where they are let go
}

// --- Flatlanders ----------------------------------------------------------------------

const TILE = 0.003; // thickness of a Flatlander seen from Spaceland

class Flatlander {
  /** points: outline in local coordinates (x forward, z to the right as seen from above). */
  constructor(scene, { name, points, color, x, z, heading, speed = 0.025, isGem = false }) {
    this.scene = scene;
    this.name = name;
    this.points = points;
    this.radius = Math.max(...points.map(([px, pz]) => Math.hypot(px, pz)));
    this.x = x; this.z = z; this.heading = heading;
    this.flipped = false;
    this.lifted = false;
    this.speed = speed;
    this.isGem = isGem;
    this.turn = 0;
    this.color = new THREE.Color(color);
    this.group = new THREE.Group();
    // extruded outline; the shape's (x, y) becomes (x, −z) after rotating into the plane
    const shape = new THREE.Shape(points.map(([px, pz]) => new THREE.Vector2(px, -pz)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: TILE, bevelEnabled: false }).rotateX(-Math.PI / 2);
    this.body = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.55 }));
    this.group.add(this.body);
    if (!isGem) {
      // markings on both faces (a 2D being has no top or bottom): an eye at the
      // front and a stripe down its left side, so a turned-over Flatlander is visibly mirror-reversed
      const eyeGeo = new THREE.CircleGeometry(this.radius * 0.16, 16).rotateX(-Math.PI / 2);
      const eyeMat = new THREE.MeshBasicMaterial({ color: '#1b1c22', side: THREE.DoubleSide });
      const stripeGeo = new THREE.PlaneGeometry(this.radius * 0.9, this.radius * 0.16).rotateX(-Math.PI / 2);
      const stripeMat = new THREE.MeshBasicMaterial({ color: this.color.clone().offsetHSL(0.5, 0, -0.25), side: THREE.DoubleSide });
      for (const y of [TILE + 0.0004, -0.0004]) {
        const eye = new THREE.Mesh(eyeGeo, eyeMat);
        eye.position.set(this.radius * 0.5, y, -this.radius * 0.22);
        const stripe = new THREE.Mesh(stripeGeo, stripeMat);
        stripe.position.set(-this.radius * 0.05, y, -this.radius * 0.5);
        this.group.add(eye, stripe);
      }
    }
    scene.board.add(this.group);
    this.place();
  }

  /** Put the tile where the 2D simulation says it is. */
  place() {
    this.group.position.set(this.x, 0, this.z);
    // heading θ points along (cos θ, sin θ) in (x, z); turning over is a half-turn about the forward axis
    this.group.quaternion.setFromAxisAngle(_v.set(0, 1, 0), -this.heading);
    if (this.flipped) this.group.quaternion.multiply(_q.setFromAxisAngle(_v.set(1, 0, 0), Math.PI));
  }

  /** Outline in the plane (x, z), mirrored if turned over. */
  outline() {
    const c = Math.cos(this.heading), s = Math.sin(this.heading), m = this.flipped ? -1 : 1;
    return this.points.map(([px, pz]) => [this.x + c * px - s * pz * m, this.z + s * px + c * pz * m]);
  }

  nearDistance(p) {
    const l = this.scene.board.worldToLocal(_v2.copy(p));
    const c = this.group.position;
    const h = Math.hypot(l.x - c.x, l.z - c.z);
    return Math.hypot(Math.max(0, h - this.radius * 0.9), l.y - c.y) - 0.004;
  }

  rayDistance(o, d) {
    const lo = this.scene.board.worldToLocal(_v2.copy(o));
    const c = this.group.position;
    if (Math.abs(d.y) < 1e-6) return Infinity;
    const t = (c.y - lo.y) / d.y;
    if (t < 0) return Infinity;
    return Math.hypot(lo.x + d.x * t - c.x, lo.z + d.z * t - c.z) < this.radius ? t : Infinity;
  }

  onHover(ix, on) { this.body.material.emissive.set(on ? 0x2a2a2a : 0x000000); }

  onGrabStart(ix, mode, kind) {
    this.grabbedBy = ix;
    this.kind = kind;
    this.lifted = true;
    this.drop = null;
    ix.pose(kind, _hp, _hq);
    if (ix.isMouse && mode === 'secondary') {
      // desktop: turn it over in place
      this.flipAnim = { t: 0, from: this.group.quaternion.clone() };
      this.grabbedBy = null;
      return;
    }
    const hand = this.scene.board.worldToLocal(_hp.clone());
    this.offset = this.group.position.clone().sub(hand).applyQuaternion(_hq.clone().invert());
    this.relQ = _hq.clone().invert().multiply(this.group.quaternion);
    this.mouse = ix.isMouse;
    this.scene.app.audio.grab(ix.grabPos);
  }

  onGrabUpdate(ix) {
    if (!this.grabbedBy) return;
    ix.pose(this.kind, _hp, _hq);
    const hand = this.scene.board.worldToLocal(_hp.clone());
    this.group.position.copy(this.offset).applyQuaternion(_hq).add(hand);
    if (this.mouse) this.group.position.y = Math.max(this.group.position.y, 0.06); // lift clear of the plane
    this.group.quaternion.copy(_hq).multiply(this.relQ);
  }

  onGrabEnd() {
    if (!this.grabbedBy) return;
    this.grabbedBy = null;
    this._startDrop();
  }

  /** Let go: settle back into the plane below, keeping which way up it is. */
  _startDrop() {
    const up = _v.set(0, 1, 0).applyQuaternion(this.group.quaternion);
    const fwd = _v2.set(1, 0, 0).applyQuaternion(this.group.quaternion);
    const flipped = up.y < 0;
    const x = THREE.MathUtils.clamp(this.group.position.x, -W + this.radius, W - this.radius);
    const z = THREE.MathUtils.clamp(this.group.position.z, -D + this.radius, D - this.radius);
    this.drop = { t: 0, from: this.group.position.clone(), fromQ: this.group.quaternion.clone(), x, z, heading: Math.atan2(fwd.z, fwd.x), flipped };
  }

  update(dt) {
    if (this.flipAnim) {
      // lift, turn over about the forward axis, put back
      const a = this.flipAnim;
      a.t = Math.min(1, a.t + dt / 0.9);
      const s = Math.sin(Math.PI * a.t);
      this.group.position.set(this.x, 0.07 * s, this.z);
      this.group.quaternion.copy(a.from).multiply(_q.setFromAxisAngle(_v.set(1, 0, 0), Math.PI * a.t));
      if (a.t >= 1) {
        this.flipAnim = null;
        this.flipped = !this.flipped;
        this.lifted = false;
        this.place();
        this.scene.onReturned(this);
      }
      return;
    }
    if (!this.drop) return;
    const d = this.drop;
    d.t = Math.min(1, d.t + dt / 0.35);
    const e = d.t * d.t * (3 - 2 * d.t);
    this.x = d.x; this.z = d.z; this.heading = d.heading; this.flipped = d.flipped;
    this.place();
    this.group.position.lerpVectors(d.from, this.group.position, e);
    this.group.quaternion.slerpQuaternions(d.fromQ, this.group.quaternion, e);
    if (d.t >= 1) {
      this.drop = null;
      this.lifted = false;
      this.place();
      this.scene.onReturned(this);
    }
  }
}

function polygon(n, r, phase = 0) {
  return Array.from({ length: n }, (_, i) => { const a = phase + (i / n) * Math.PI * 2; return [Math.cos(a) * r, Math.sin(a) * r]; });
}

// --- the scene --------------------------------------------------------------------------

export class FlatlandScene extends SceneBase {
  constructor(app) {
    super(app);
    this.key = 'flatland';
    this.title = 'Flatland';
    this.short = 'Flatland';
    this.subtitle = 'A 2D world, visited from 3D';
    this.mood = 'studio';
    this.boardY = 0.95;
    this.board = new THREE.Group();
    this.root.add(this.board);
    this.showView = true;

    this.segTex = new THREE.DataTexture(new Float32Array(MAX_SEGS * 2 * 4), MAX_SEGS, 2, THREE.RGBAFormat, THREE.FloatType);
    this.capTex = new THREE.DataTexture(new Float32Array(MAX_CAPS * 2 * 4), MAX_CAPS, 2, THREE.RGBAFormat, THREE.FloatType);
    this.sdfUniforms = {
      uObjCount: { value: 0 },
      uObjType: { value: [0, 0, 0, 0] },
      uObjPos: { value: [0, 1, 2, 3].map(() => new THREE.Vector3()) },
      uObjRotT: { value: [0, 1, 2, 3].map(() => new THREE.Matrix3()) },
      uObjSize: { value: [0, 1, 2, 3].map(() => new THREE.Vector3()) },
      uObjColor: { value: [0, 1, 2, 3].map(() => new THREE.Color()) },
      uCaps: { value: this.capTex },
      uCapCount: { value: 0 },
    };

    this._buildSheet();
    this._buildWorld();
    this._buildView();
    this.burst = new Burst(this.board);

    this.visitors = [
      new Visitor(this, 0, '#ff6f9f', new THREE.Vector3(0.6, 0.065, -0.17), [0.05, 0, 0]),
      new Visitor(this, 1, '#ffb347', new THREE.Vector3(0.6, 0.07, -0.05), [0.035, 0.035, 0.035]),
      new Visitor(this, 2, '#3ddbd9', new THREE.Vector3(0.6, 0.075, 0.07), [0.04, 0.1, 0]),
      new Visitor(this, 3, '#8b7bff', new THREE.Vector3(0.6, 0.05, 0.19), [0.04, 0.015, 0]),
    ];
    this.visitors[1].mesh.quaternion.setFromEuler(new THREE.Euler(0.6, 0.5, 0.2));
    this.visitors[3].mesh.quaternion.setFromEuler(new THREE.Euler(0.5, 0, 0.3));
    this.interactables = [...this.visitors, ...this.flatlanders];
    this.desktopView = { position: new THREE.Vector3(0.1, 1.5, 0.35), target: new THREE.Vector3(0.05, this.boardY, -0.55) };
    this._layout();
  }

  _layout() {
    this.board.position.set(0, this.boardY, -0.55);
    this.desktopView.target.set(0.05, this.boardY, -0.55);
    const h = this.boardY;
    for (const leg of this.legs) { leg.scale.y = h; leg.position.y = -h / 2 - 0.01; }
    this.shelfLeg.scale.y = h;
    this.shelfLeg.position.y = -h / 2;
  }

  onUserReady() {
    this.boardY = THREE.MathUtils.clamp(this.app.headPosition.y - 0.6, 0.72, 1.1);
    this._layout();
  }

  _buildSheet() {
    this.sheetMat = new THREE.ShaderMaterial({ uniforms: this.sdfUniforms, vertexShader: SHEET_VERT, fragmentShader: SHEET_FRAG, side: THREE.DoubleSide });
    const plane = new THREE.PlaneGeometry(W * 2, D * 2).rotateX(-Math.PI / 2);
    const sheet = new THREE.Mesh(plane, this.sheetMat);
    this.board.add(sheet);
    const outline = new THREE.Mesh(plane, new THREE.ShaderMaterial({
      uniforms: this.sdfUniforms, vertexShader: SHEET_VERT, fragmentShader: OUTLINE_FRAG,
      transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    }));
    outline.renderOrder = 35; // after the hands
    this.board.add(outline);
    // frame and stand
    const frameMat = new THREE.MeshStandardMaterial({ color: '#2b2f3a', roughness: 0.5, metalness: 0.3 });
    const bar = (w, d, x, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.012, d), frameMat); m.position.set(x, -0.002, z); this.board.add(m); };
    bar(W * 2 + 0.024, 0.012, 0, -D - 0.006); bar(W * 2 + 0.024, 0.012, 0, D + 0.006);
    bar(0.012, D * 2, -W - 0.006, 0); bar(0.012, D * 2, W + 0.006, 0);
    const legMat = new THREE.MeshStandardMaterial({ color: '#d4cec6', roughness: 0.6 });
    this.legs = [[-W + 0.03, -D + 0.03], [W - 0.03, -D + 0.03], [-W + 0.03, D - 0.03], [W - 0.03, D - 0.03]].map(([x, z]) => {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 1, 10), legMat);
      leg.position.set(x, 0, z);
      this.board.add(leg);
      return leg;
    });
    // a shelf for the visitors from Spaceland
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.012, 0.5), legMat);
    shelf.position.set(0.6, -0.006, 0.02);
    this.board.add(shelf);
    this.shelfLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1, 10), legMat);
    this.shelfLeg.position.set(0.6, 0, 0.02);
    this.board.add(this.shelfLeg);
    const lab = makeLabel('VISITORS FROM SPACELAND', { size: 0.014, color: '#4a4f5c' });
    lab.rotation.x = -Math.PI / 2;
    lab.position.set(0.6, 0.002, 0.31);
    this.board.add(lab);
  }

  _buildWorld() {
    this.walls = [];
    const wallMat = new THREE.MeshStandardMaterial({ color: '#5a4636', roughness: 0.7 });
    const wall = (ax, az, bx, bz) => {
      const len = Math.hypot(bx - ax, bz - az);
      const m = new THREE.Mesh(new THREE.BoxGeometry(len, 0.006, 0.006), wallMat);
      m.position.set((ax + bx) / 2, 0.003, (az + bz) / 2);
      m.rotation.y = -Math.atan2(bz - az, bx - ax);
      this.board.add(m);
      this.walls.push([ax, az, bx, bz]);
    };
    // Abbott's pentagonal house, with a door
    const hc = [-0.25, -0.09], hr = 0.11;
    const hp = polygon(5, hr, Math.PI / 2).map(([x, z]) => [hc[0] + x, hc[1] + z]);
    for (let i = 0; i < 5; i++) {
      const [ax, az] = hp[i], [bx, bz] = hp[(i + 1) % 5];
      if (i === 0) {
        // the edge at the front gets a door in the middle
        const f = 0.3;
        wall(ax, az, ax + (bx - ax) * f, az + (bz - az) * f);
        wall(ax + (bx - ax) * (1 - f), az + (bz - az) * (1 - f), bx, bz);
      } else wall(ax, az, bx, bz);
    }
    // the sealed vault
    const vc = [0.24, -0.13], vs = 0.055;
    this.vault = { x: vc[0], z: vc[1], s: vs };
    wall(vc[0] - vs, vc[1] - vs, vc[0] + vs, vc[1] - vs);
    wall(vc[0] + vs, vc[1] - vs, vc[0] + vs, vc[1] + vs);
    wall(vc[0] + vs, vc[1] + vs, vc[0] - vs, vc[1] + vs);
    wall(vc[0] - vs, vc[1] + vs, vc[0] - vs, vc[1] - vs);
    const houseLab = makeLabel('HOUSE', { size: 0.012, color: '#7a6a5c' });
    houseLab.rotation.x = -Math.PI / 2;
    houseLab.position.set(hc[0], 0.001, hc[1] - hr - 0.02);
    const vaultLab = makeLabel('SEALED VAULT', { size: 0.012, color: '#7a6a5c' });
    vaultLab.rotation.x = -Math.PI / 2;
    vaultLab.position.set(vc[0], 0.001, vc[1] - vs - 0.02);
    this.board.add(houseLab, vaultLab);

    this.flatlanders = [];
    const add = (o) => { const f = new Flatlander(this, o); this.flatlanders.push(f); return f; };
    this.square = add({ name: 'A Square', points: polygon(4, 0.03, Math.PI / 4), color: '#f2c14e', x: 0.02, z: 0.14, heading: -Math.PI / 2, speed: 0 });
    add({ name: 'a Triangle', points: [[0.035, 0], [-0.02, -0.018], [-0.018, 0.02]], color: '#e76f51', x: -0.3, z: 0.19, heading: 0.3 });
    add({ name: 'a Pentagon', points: polygon(5, 0.026), color: '#2a9d8f', x: 0.3, z: 0.16, heading: 2.5 });
    add({ name: 'a Hexagon', points: polygon(6, 0.027), color: '#6d6875', x: -0.05, z: -0.2, heading: 1.2 });
    add({ name: 'a Circle', points: polygon(18, 0.024), color: '#b8c0ff', x: 0.08, z: -0.02, heading: -2.4, speed: 0.015 });
    this.gem = add({ name: 'the gem', points: [[0.018, 0], [0, 0.012], [-0.018, 0], [0, -0.012]], color: '#ff4f9a', x: vc[0], z: vc[1], heading: 0.4, speed: 0, isGem: true });
    this.gemInVault = true;

    // A Square's field of view
    this.fovMesh = new THREE.Mesh(
      new THREE.CircleGeometry(0.28, 32, -FOV / 2, FOV).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: '#f2c14e', transparent: true, opacity: 0.13, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.fovMesh.position.y = 0.0006;
    this.board.add(this.fovMesh);
  }

  _buildView() {
    this.viewMat = new THREE.ShaderMaterial({
      uniforms: { ...this.sdfUniforms, uEye: { value: new THREE.Vector3() }, uMirror: { value: 0 }, uSegs: { value: this.segTex }, uSegCount: { value: 0 } },
      vertexShader: VIEW_VERT,
      fragmentShader: VIEW_FRAG,
    });
    this.viewStrip = new THREE.Group();
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.05), this.viewMat);
    const back = new THREE.Mesh(new THREE.PlaneGeometry(0.64, 0.07), new THREE.MeshBasicMaterial({ color: '#0a0b10' }));
    back.position.z = -0.001;
    const lab = makeLabel("A SQUARE'S VIEW  ·  ONE DIMENSION", { size: 0.014, color: '#eceef4', bg: 'rgba(10,11,16,0.9)' });
    lab.position.y = 0.05;
    this.viewStrip.add(back, strip, lab);
    this.viewStrip.position.set(0, 0.2, -D - 0.06);
    this.viewStrip.rotation.x = -0.25;
    this.board.add(this.viewStrip);
  }

  // --- events -------------------------------------------------------------------------

  onReturned(f) {
    if (f === this.square) f.baseHeading = f.heading;
    if (f === this.gem) {
      const inVault = Math.abs(f.x - this.vault.x) < this.vault.s && Math.abs(f.z - this.vault.z) < this.vault.s;
      if (this.gemInVault && !inVault) {
        this.gemInVault = false;
        this.burst.fire(new THREE.Vector3(f.x, 0.02, f.z), ['#ff4f9a', '#f2c14e', '#3ddbd9'], 0.6);
        this.app.audio.spawn(this.board.localToWorld(new THREE.Vector3(f.x, 0, f.z)));
        this.say('The gem left a sealed vault. In Flatland, that is impossible.');
      } else if (inVault) this.gemInVault = true;
      return;
    }
    this.app.audio.release(this.board.localToWorld(new THREE.Vector3(f.x, 0, f.z)));
    if (f.flipped !== !!f.wasFlipped) {
      f.wasFlipped = f.flipped;
      this.say(`${f.name[0].toUpperCase()}${f.name.slice(1)} is now ${f.flipped ? 'its own mirror image' : 'back to normal'}. No move within Flatland could do that.`);
    }
  }

  say(text) {
    this.message = text;
    this.messageT = 6;
  }

  sphereVisits() {
    const s = this.visitors[0];
    if (s.grabbedBy) return;
    const sq = this.square;
    const tx = sq.x + Math.cos(sq.heading) * 0.14, tz = sq.z + Math.sin(sq.heading) * 0.14;
    this.visit = { t: 0, from: s.mesh.position.clone(), x: tx, z: tz };
  }

  reset() {
    for (const f of this.flatlanders) {
      f.grabbedBy = null; f.drop = null; f.flipAnim = null; f.lifted = false; f.flipped = false; f.wasFlipped = false;
    }
    this.app.interaction.releaseAll();
    const init = [[0.02, 0.14, -Math.PI / 2], [-0.3, 0.19, 0.3], [0.3, 0.16, 2.5], [-0.05, -0.2, 1.2], [0.08, -0.02, -2.4], [this.vault.x, this.vault.z, 0.4]];
    this.flatlanders.forEach((f, i) => { [f.x, f.z, f.heading] = init[i]; f.place(); });
    this.gemInVault = true;
    for (const v of this.visitors) { v.mesh.position.copy(v.home); }
    this.visit = null;
    this.message = null;
  }

  // --- simulation ------------------------------------------------------------------------

  /** Distance from a point of the plane to the nearest intruder (a lower bound). */
  _intruderDist(x, z) {
    _v.set(x, 0, z);
    let d = Infinity;
    for (const v of this.visitors) d = Math.min(d, v.sdf(_v.set(x, 0, z)));
    for (const c of this.caps) d = Math.min(d, sdCapsuleJS(_v.set(x, 0, z), c.a, c.b, c.r));
    return d;
  }

  _simulate(dt, time) {
    for (const f of this.flatlanders) {
      if (f.lifted || f.isGem) continue;
      if (f === this.square) {
        // A Square stands still and looks around
        f.heading = f.baseHeading ?? (f.baseHeading = f.heading);
        f.heading = f.baseHeading + Math.sin(time * 0.25) * 0.5;
      } else {
        f.turn += (Math.random() - 0.5) * dt * 3;
        f.turn *= Math.exp(-dt);
        f.heading += f.turn * dt * 2;
        f.x += Math.cos(f.heading) * f.speed * dt;
        f.z += Math.sin(f.heading) * f.speed * dt;
      }
      const r = f.radius * 0.85;
      // flee from things from Spaceland: step down the distance gradient
      const di = this._intruderDist(f.x, f.z);
      if (di < r + 0.03) {
        const e = 0.004;
        const gx = this._intruderDist(f.x + e, f.z) - this._intruderDist(f.x - e, f.z);
        const gz = this._intruderDist(f.x, f.z + e) - this._intruderDist(f.x, f.z - e);
        const gl = Math.hypot(gx, gz) || 1;
        const push = Math.min(0.02, (r + 0.03 - di)) ;
        f.x += (gx / gl) * push * (f === this.square ? 0.3 : 1);
        f.z += (gz / gl) * push * (f === this.square ? 0.3 : 1);
        if (f !== this.square) f.heading = Math.atan2(gz, gx);
      }
      // walls
      for (const [ax, az, bx, bz] of this.walls) {
        const ex = bx - ax, ez = bz - az;
        const t = Math.min(1, Math.max(0, ((f.x - ax) * ex + (f.z - az) * ez) / (ex * ex + ez * ez)));
        const px = ax + ex * t, pz = az + ez * t;
        const dx = f.x - px, dz = f.z - pz, dd = Math.hypot(dx, dz);
        if (dd < r + 0.004 && dd > 1e-9) {
          f.x = px + (dx / dd) * (r + 0.004);
          f.z = pz + (dz / dd) * (r + 0.004);
          if (f !== this.square) f.heading = Math.atan2(dz, dx) + (Math.random() - 0.5);
        }
      }
      // other Flatlanders
      for (const g of this.flatlanders) {
        if (g === f || g.lifted) continue;
        const dx = f.x - g.x, dz = f.z - g.z, dd = Math.hypot(dx, dz), min = r + g.radius * 0.85;
        if (dd < min && dd > 1e-9) { f.x += (dx / dd) * (min - dd) * 0.5; f.z += (dz / dd) * (min - dd) * 0.5; }
      }
      // the edge of the world
      if (Math.abs(f.x) > W - r) { f.x = Math.sign(f.x) * (W - r); f.heading = Math.PI - f.heading; }
      if (Math.abs(f.z) > D - r) { f.z = Math.sign(f.z) * (D - r); f.heading = -f.heading; }
      f.place();
    }
  }

  /** Hand bones near the plane, as capsules (board coordinates). */
  _collectCaps() {
    this.caps = this.caps || [];
    this.caps.length = 0;
    const pool = this._capPool || (this._capPool = Array.from({ length: MAX_CAPS }, () => ({ a: new THREE.Vector3(), b: new THREE.Vector3(), r: 0 })));
    if (!this.app.presenting) return;
    for (const ix of this.app.input.xr) {
      if (!ix.active) continue;
      if (ix.kind === 'hand' && ix.jointsValid) {
        for (const [a, b] of BONES) {
          if (this.caps.length >= MAX_CAPS) break;
          const c = pool[this.caps.length];
          this.board.worldToLocal(c.a.copy(ix.joints[a].pos));
          this.board.worldToLocal(c.b.copy(ix.joints[b].pos));
          c.r = Math.max(0.006, Math.min(ix.joints[a].radius, ix.joints[b].radius));
          // only bones that reach the plane matter
          if (Math.min(c.a.y, c.b.y) - c.r > 0.002 || Math.max(c.a.y, c.b.y) + c.r < -0.002) continue;
          this.caps.push(c);
        }
      } else if (ix.kind === 'controller' && this.caps.length < MAX_CAPS) {
        // the tip of a controller, as a small ball
        const c = pool[this.caps.length];
        this.board.worldToLocal(c.a.copy(ix.pokePos));
        c.b.copy(c.a);
        c.r = 0.015;
        if (Math.abs(c.a.y) < c.r) this.caps.push(c);
      }
    }
  }

  _uploadIntruders() {
    const u = this.sdfUniforms;
    this.visitors.forEach((v, i) => {
      u.uObjType.value[i] = v.type;
      u.uObjPos.value[i].copy(v.mesh.position);
      _m4.makeRotationFromQuaternion(v.mesh.quaternion);
      u.uObjRotT.value[i].setFromMatrix4(_m4).transpose();
      u.uObjSize.value[i].set(v.size[0], v.size[1], v.size[2]);
      u.uObjColor.value[i].copy(v.color);
    });
    u.uObjCount.value = this.visitors.length;
    const cd = this.capTex.image.data;
    this.caps.forEach((c, i) => {
      cd[i * 4] = c.a.x; cd[i * 4 + 1] = c.a.y; cd[i * 4 + 2] = c.a.z; cd[i * 4 + 3] = c.r;
      const j = (MAX_CAPS + i) * 4;
      cd[j] = c.b.x; cd[j + 1] = c.b.y; cd[j + 2] = c.b.z;
    });
    u.uCapCount.value = this.caps.length;
    this.capTex.needsUpdate = true;
  }

  _uploadSegments() {
    const sd = this.segTex.image.data;
    let n = 0;
    const seg = (ax, az, bx, bz, col) => {
      if (n >= MAX_SEGS) return;
      sd[n * 4] = ax; sd[n * 4 + 1] = az; sd[n * 4 + 2] = bx; sd[n * 4 + 3] = bz;
      const j = (MAX_SEGS + n) * 4;
      sd[j] = col.r; sd[j + 1] = col.g; sd[j + 2] = col.b; sd[j + 3] = 1;
      n++;
    };
    const wallCol = { r: 0.55, g: 0.45, b: 0.37 }, edgeCol = { r: 0.3, g: 0.3, b: 0.34 };
    for (const [ax, az, bx, bz] of this.walls) seg(ax, az, bx, bz, wallCol);
    seg(-W, -D, W, -D, edgeCol); seg(W, -D, W, D, edgeCol); seg(W, D, -W, D, edgeCol); seg(-W, D, -W, -D, edgeCol);
    for (const f of this.flatlanders) {
      if (f.lifted || f === this.square) continue;
      const o = f.outline();
      for (let i = 0; i < o.length; i++) seg(o[i][0], o[i][1], o[(i + 1) % o.length][0], o[(i + 1) % o.length][1], f.color);
    }
    this.viewMat.uniforms.uSegCount.value = n;
    this.segTex.needsUpdate = true;
  }

  update(dt, time) {
    // "a Sphere visits": down through the plane in front of A Square and back
    if (this.visit) {
      const s = this.visitors[0], v = this.visit;
      v.t += dt;
      const T = 8;
      const k = Math.min(1, v.t / T);
      if (k < 0.12) s.mesh.position.lerpVectors(v.from, _v.set(v.x, 0.18, v.z), k / 0.12);
      else if (k > 0.88) s.mesh.position.lerpVectors(_v.set(v.x, 0.18, v.z), s.home, (k - 0.88) / 0.12);
      else s.mesh.position.set(v.x, 0.18 * Math.cos((Math.PI * 2 * (k - 0.12)) / 0.76), v.z); // down through the plane and back
      if (k >= 1) this.visit = null;
    }

    this._collectCaps();
    for (const v of this.visitors) v.updateLook();
    for (const f of this.flatlanders) f.update(dt);
    this._simulate(dt, time);
    this._uploadIntruders();
    this._uploadSegments();

    // A Square's eye and field of view
    const sq = this.square;
    const eyeX = sq.x + Math.cos(sq.heading) * sq.radius * 0.75, eyeZ = sq.z + Math.sin(sq.heading) * sq.radius * 0.75;
    this.viewMat.uniforms.uEye.value.set(eyeX, eyeZ, sq.heading);
    this.viewMat.uniforms.uMirror.value = sq.flipped ? 1 : 0;
    this.fovMesh.visible = !sq.lifted && this.showView;
    this.fovMesh.position.set(eyeX, 0.0006, eyeZ);
    this.fovMesh.rotation.y = -sq.heading;
    this.viewStrip.visible = this.showView;
    this.burst.update(dt);
    if (this.messageT > 0) { this.messageT -= dt; if (this.messageT <= 0) this.message = null; }
  }

  menuRows() {
    return [
      {
        type: 'buttons', columns: 2,
        items: [
          { label: 'A Sphere visits', onClick: () => this.sphereVisits() },
          { label: 'Reset Flatland', onClick: () => this.reset() },
        ],
      },
      { type: 'toggles', items: [{ label: "A Square's view", get: () => this.showView, set: (v) => { this.showView = v; } }] },
    ];
  }

  hint(mode) {
    if (this.message) return this.message;
    const reach = { hands: 'Push a finger through the sheet', controllers: 'Push a controller through the sheet', desktop: 'Drag a visitor through the sheet' }[mode];
    const lift = {
      hands: 'Pinch a Flatlander to lift it out; put it back upside down',
      controllers: 'Trigger on a Flatlander lifts it out; put it back upside down',
      desktop: 'Drag a Flatlander to lift it out, or right-click to turn it over',
    }[mode];
    return `${reach}: Flatlanders only see its cross-section. The strip is A Square's 1D view. ${lift}. Can you get the gem out of the sealed vault?`;
  }

  desktopHelp({ touch } = {}) {
    if (touch) return '<b>Drag</b> a visitor or a Flatlander to move it · <b>Drag</b> empty space to orbit';
    return '<b>Drag</b> a visitor from the shelf through the sheet · <b>Right-drag</b> a visitor to turn it · <b>Drag</b> a Flatlander to lift it out · <b>Right-click</b> a Flatlander to turn it over · <b>M</b> menu · drag empty space to orbit';
  }
}
