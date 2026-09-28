// Hyperplay: 4D physics sandbox on a table, shown as a 3D cross-section.

import * as THREE from 'three';
import * as V from '../math/vec4.js';
import * as R4 from '../math/rot4.js';
import { SceneBase, Burst, makeLabel, disposeLabel, TextLabel } from './base.js';
import { Object4D } from '../four/object4d.js';
import { SliceView } from '../four/sliceView.js';
import { World4, Body4 } from '../physics/world4.js';
import { WRail } from './wrail.js';
import { Shadow4 } from '../four/shadow4.js';
import { Worldline, jugglingChains } from '../four/worldline.js';
import { LIGHT } from '../core/lighting.js';
import * as P from '../four/polytopes.js';
import { screwCenters, SCREW_EDGE } from '../four/shapes.js';

const TABLE_R = 0.6;        // rim radius, objects stay inside it
const RIM_TUBE = 0.006;
const TABLE_TOP_R = 0.675;  // the top, with a ledge outside the rim for the w rail
const W_RANGE = 0.55;
const W_GRADIENT = ['#33c3ff', '#ff4f9a']; // kata (-w) to ana (+w)
// A pinch in empty space has to move this far (meters) before it moves the
// slice, so a pinch that just missed an object doesn't nudge it.
const AIR_DEADZONE = 0.012;
// How far from a toy's surface a hand or controller can still grab it. Bigger
// than the default, since a cross-section is hard to judge the depth of.
const TOY_REACH = 0.055;
// A pinch in empty space this close to a toy's surface was probably meant for
// the toy, so it doesn't move the slice either
const NEAR_MISS = 0.1;
const PULL_TIME = 0.35; // seconds for a pulled toy to fly to the hand

const fmtW = (v) => (Math.abs(v) < 0.005 ? '0' : `${v > 0 ? 'ana' : 'kata'} ${Math.abs(v * 100).toFixed(0)} cm`);
const wColor = (v) => (v > 0.005 ? '#ff8fbf' : v < -0.005 ? '#7fd8ff' : '#ffffff');
const deg = (a) => `${Math.round(THREE.MathUtils.radToDeg(a))}°`;
const MAX_TOYS = 32; // collision is O(n²), so spawning past this recycles the oldest toy

// The dice are the regular polytopes. Opposite cells add up to N + 1 like the
// faces of a d6, and the result is the cell facing up. The 5-cell has a vertex
// on top, so it's read from the cell it rests on, like a d4.
const DICE = [
  { key: 'simplex', poly: P.simplex, name: 'd5' },
  { key: 'tesseract', poly: P.tesseract, name: 'd8' },
  { key: 'orthoplex', poly: P.orthoplex, name: 'd16' },
  { key: 'icositetrachoron', poly: P.icositetrachoron, name: 'd24' },
  { key: 'hecatonicosachoron', poly: P.hecatonicosachoron, name: 'd120' },
  { key: 'hexacosichoron', poly: P.hexacosichoron, name: 'd600' },
];

// Orbits preset. In 4D gravity falls off as 1/r³, since a point mass's field
// spreads over a 3-sphere with area ∝ r³. A circular orbit then has exactly
// zero energy, so any nudge sends the moon spiraling in or out. There are no
// stable orbits. Both constants give the same circular speed at r = 0.2 m.
const ORBIT_Y = 0.24;
const GM4 = (0.42 * 0.2) ** 2; // a = GM4 / r³
const GM3 = 0.42 ** 2 * 0.2;   // a = GM3 / r²
const TRAIL = 220;

// Worldline recordings
const REC_TIME = 4;
const REC_HALF_W = 0.45;
const FINGER_COLORS = ['#e8e4ee', '#ff6b6b', '#ffd93d', '#b8e05a', '#3ddbd9', '#8b7bff']; // wrist, thumb … pinky

const _p4 = [0, 0, 0, 0];
const _q4 = [0, 0, 0, 0];
const _M = R4.mat4();
const _M2 = R4.mat4();
const _E = R4.mat4();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _hp = new THREE.Vector3();
const _hq = new THREE.Quaternion();
const _oc = new THREE.Vector3();
const _rp = new THREE.Vector3();
const _head = new THREE.Vector3();
const _air = new THREE.Vector3();
const _n4 = [0, 0, 0, 0];
const EW = [0, 0, 0, 1];

let seed = 7;
const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const randRot = () => R4.randomRotation(R4.mat4(), rand);

// A 4D object in the playground. Holds the render object, rigid body and grab handling.
class Toy {
  constructor(pg, key, { scale = 0.1, scale4 = null, pos = [0, 0.2, 0, 0], rot = null, mass = null, fixed = false, opacity = 1, tint = null, tintAmount = 0.6, restitution = 0.3, friction = 0.55, tagColor = null } = {}) {
    this.pg = pg;
    this.obj = new Object4D(key, { scale, scale4, position: pos, rotation: rot, opacity, tint, tintAmount });
    pg.stage.add(this.obj.group);
    pg.shadow4.add(this.obj);
    const desc = scale4 ? { type: 'box', h: scale4.map((s) => s * 0.5) } : this.obj.shape.physics();
    const m = mass ?? (fixed ? 0 : Math.pow((scale4 ? Math.max(...scale4) : scale) / 0.1, 3));
    this.body = new Body4(desc, scale4 ? 1 : scale, { mass: m, restitution, friction });
    V.copy(this.body.x, pos);
    if (rot) R4.copy(this.body.R, rot);
    this.body.kinematic = fixed;
    this.body.userData = this;
    this.fixed = fixed;
    pg.world.add(this.body);
    this.tagColor = new THREE.Color(tagColor || (tint ? tint : pickTagColor(key)));
    this.grabbedBy = null;
    this.hideTag = fixed;
  }

  get enabled() { return !this.fixed; }
  get nearRadius() { return TOY_REACH; }

  sync(dt) {
    V.copy(this.obj.pos, this.body.x);
    R4.copy(this.obj.R, this.body.R);
    this.obj.sync(this.pg.view, dt);
  }

  dispose() {
    this.pg.shadow4.remove(this.obj);
    this.obj.dispose();
    this.pg.world.remove(this.body);
    if (this.label) disposeLabel(this.label.mesh);
    this.trail?.dispose();
  }

  // --- interactable ---------------------------------------------------------

  _sliceToBody(p3, out) {
    _p4[0] = p3.x; _p4[1] = p3.y; _p4[2] = p3.z; _p4[3] = 0;
    this.pg.view.toWorld(_q4, _p4);
    V.sub(_q4, _q4, this.body.x);
    return R4.applyT(out, this.body.R, _q4);
  }

  // Infinity past `range` from the cross-section's bounding sphere
  nearDistance(p, range = 0.06) {
    if (!this.obj.inSlice) return Infinity;
    const local = this.pg.stage.worldToLocal(_v3.copy(p));
    if (local.distanceTo(_hp.set(this.obj.slicePos[0], this.obj.slicePos[1], this.obj.slicePos[2])) > this.obj.sliceRadius + range) return Infinity;
    return this.body.collider.sdf(this._sliceToBody(local, _p4));
  }

  rayDistance(o, d) {
    if (!this.obj.inSlice) return Infinity;
    // sphere-trace the true SDF within the slice
    const lo = this.pg.stage.worldToLocal(_v3.copy(o));
    const c = _hp.set(this.obj.slicePos[0], this.obj.slicePos[1], this.obj.slicePos[2]);
    const r = this.obj.sliceRadius + 0.01;
    const oc = _oc.copy(lo).sub(c);
    const b = oc.dot(d), cc = oc.lengthSq() - r * r, disc = b * b - cc;
    if (disc < 0) return Infinity;
    let t = Math.max(0, -b - Math.sqrt(disc));
    const tEnd = -b + Math.sqrt(disc);
    const p = _rp;
    for (let i = 0; i < 32 && t < tEnd; i++) {
      p.copy(lo).addScaledVector(d, t);
      const dist = this.body.collider.sdf(this._sliceToBody(p, _p4));
      if (dist < 0.002) return t;
      t += Math.max(dist, 0.002);
    }
    return Infinity;
  }

  // For tracked hands pulling it from out of reach (see InteractionManager)
  pullPoint(out) {
    if (!this.obj.inSlice) return 0;
    const s = this.obj.slicePos;
    this.pg.stage.localToWorld(out.set(s[0], s[1], s[2]));
    return this.obj.sliceRadius;
  }

  onHover(ix, on) { this.obj.setHighlight(on ? 0.6 : (this.grabbedBy ? 1 : 0)); }

  onGrabStart(ix, mode, kind) {
    const view = this.pg.view;
    this.grabbedBy = ix;
    this.mode = mode;
    this.kind = kind;
    this.pullT = kind === 'pull' ? 0 : PULL_TIME;
    this.body.held = true;
    this.body.invMass = this.body.baseInvMass * 0.25; // held objects push others harder
    this.body.wake();
    this.body.target = { x: this.body.x.slice(), R: R4.copy(R4.mat4(), this.body.R) };
    this.obj.setHighlight(1);
    ix.pose(kind, _hp, _hq);
    this.startHand = this.pg.stage.worldToLocal(_hp.clone());
    this.startHandQInv = _hq.clone().invert();
    this.startSliceRot = view.rotToSlice(R4.mat4(), this.body.R);
    this.startSlicePos = view.toSlice([0, 0, 0, 0], this.body.x);
  }

  onGrabUpdate(ix, dt = 0) {
    const view = this.pg.view;
    ix.pose(this.kind, _hp, _hq);
    const hand = this.pg.stage.worldToLocal(_hp.clone());
    const dq = _q.copy(_hq).multiply(this.startHandQInv); // world rotation since grab
    R4.fromQuaternion(_E, dq);
    R4.multiply(_M, _E, this.startSliceRot);
    const sp = this.startSlicePos;
    const pos = [sp[0], sp[1], sp[2], sp[3]];

    if (this.mode === 'secondary') {
      // 4D trackball. Pushing the hand along d rolls the object in the (d, w) plane
      this.pg.app.hands.readout(ix, 'turning through w');
      const d = hand.clone().sub(this.startHand);
      const len = d.length();
      if (len > 1e-4) {
        const k = 1 / Math.max(0.05, this.obj.radius * 0.9);
        const dir = [d.x / len, d.y / len, d.z / len, 0];
        R4.rotationInPlane(_M2, EW, dir, len * k);
        R4.multiply(_M, _M2, _M);
      }
    } else {
      // carrying follows the hand rigidly in xyz and keeps the same offset in w
      _v3.set(sp[0], sp[1], sp[2]).sub(this.startHand);
      if (this.pullT < PULL_TIME) {
        // pulled from out of reach: the offset shrinks until it sits just past the fingers
        this.pullT += dt;
        const len = _v3.length();
        const end = Math.min(len, this.obj.sliceRadius * 0.7 + 0.01);
        _v3.setLength(len + (end - len) * THREE.MathUtils.smootherstep(this.pullT / PULL_TIME, 0, 1));
        if (this.pullT >= PULL_TIME) { sp[0] = this.startHand.x + _v3.x; sp[1] = this.startHand.y + _v3.y; sp[2] = this.startHand.z + _v3.z; }
      }
      _v3.applyQuaternion(dq).add(hand);
      pos[0] = _v3.x; pos[1] = _v3.y; pos[2] = _v3.z;
    }
    view.rotToWorld(this.body.target.R, _M);
    view.toWorld(this.body.target.x, pos);
    // keep held things above the table
    const minY = 0.0;
    if (this.body.target.x[1] < minY) this.body.target.x[1] = minY;
  }

  onGrabEnd(ix) {
    const view = this.pg.view;
    this.grabbedBy = null;
    this.obj.setHighlight(0);
    this.body.held = false;
    this.body.invMass = this.body.baseInvMass;
    this.body.target = null;
    this.body.wake();
    if (this.mode === 'primary') {
      const v = ix.velocity;
      const throwGain = ix.isMouse ? 0.6 : 1.15;
      view.toWorld(_q4, [v.x * throwGain, v.y * throwGain, v.z * throwGain, 0]);
      _q4[3] -= view.w; // toWorld adds the slice offset, which a velocity shouldn't get
      V.copy(this.body.v, _q4);
      const w = ix.angularVelocity;
      const B = [-w.z, w.y, 0, -w.x, 0, 0]; // xyz angular velocity as a bivector (slice space)
      const Bw = R4.bivRotate(R4.biv(), view.rotT, B);
      this.body.setAngularVelocity(Bw.map((x) => x * 0.9));
    } else {
      V.set(this.body.v, 0, 0, 0, 0);
      this.body.setAngularVelocity(R4.biv());
    }
    if (ix.velocity.length() > 1.2) this.pg.app.audio.whoosh(ix.grabPos);
  }
}

function pickTagColor(key) {
  const map = {
    hypersphere: '#ff6b6b', tesseract: '#ffd93d', simplex: '#b8e05a', orthoplex: '#3ddbd9',
    icositetrachoron: '#8b7bff', duocylinder: '#ff9f68', spherinder: '#4aa8ff', cubinder: '#d77bff',
    tiger: '#ff8a5c', spheritorus: '#ffd166', torisphere: '#06d6a0', hecatonicosachoron: '#ff4f9a', hexacosichoron: '#33c3ff', duoprism: '#ffd93d',
    screw: '#ff6b6b',
  };
  return map[key] || '#ffffff';
}

// Opposite cells get numbers that add up to N + 1, if the polytope has opposite cells
function diceNumbers(poly) {
  const N = poly.cells.length;
  const nums = new Array(N).fill(0);
  let next = 1;
  for (let i = 0; i < N; i++) {
    if (nums[i]) continue;
    nums[i] = next;
    const opp = poly.cells.findIndex((c, j) => !nums[j] && V.dot(c.normal, poly.cells[i].normal) < -0.9999);
    if (opp >= 0) nums[opp] = N + 1 - next;
    next++;
  }
  return nums;
}

// Height of a body's center when its lowest point rests on the table
function restHeight(R, centers, h) {
  let yMin = Infinity;
  for (const c of centers) for (let m = 0; m < 16; m++) {
    const p = [0, 1, 2, 3].map((i) => c[i] + (m & (1 << i) ? h : -h));
    yMin = Math.min(yMin, R[4] * p[0] + R[5] * p[1] + R[6] * p[2] + R[7] * p[3]);
  }
  return -yMin;
}

const TRAIL_VERT = /* glsl */ `
attribute float aAlpha;
varying float vAlpha;
void main() { vAlpha = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const TRAIL_FRAG = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;
void main() { gl_FragColor = vec4(uColor, vAlpha); }
`;

// A moon's recent path. Stored in 4D and drawn in the slice, fading where it leaves it.
class Trail {
  constructor(parent, color) {
    this.pts = new Float64Array(TRAIL * 4);
    this.count = 0;
    this.head = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL * 3), 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(TRAIL), 1).setUsage(THREE.DynamicDrawUsage));
    this.line = new THREE.Line(g, new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) } }, vertexShader: TRAIL_VERT, fragmentShader: TRAIL_FRAG, transparent: true, depthWrite: false,
    }));
    this.line.frustumCulled = false;
    parent.add(this.line);
  }

  push(x) {
    this.pts.set(x, this.head * 4);
    this.head = (this.head + 1) % TRAIL;
    this.count = Math.min(TRAIL, this.count + 1);
  }

  update(view) {
    const pos = this.line.geometry.attributes.position, al = this.line.geometry.attributes.aAlpha;
    for (let k = 0; k < this.count; k++) {
      const i = (this.head - this.count + k + TRAIL) % TRAIL;
      _p4[0] = this.pts[i * 4]; _p4[1] = this.pts[i * 4 + 1]; _p4[2] = this.pts[i * 4 + 2]; _p4[3] = this.pts[i * 4 + 3];
      view.toSlice(_q4, _p4);
      pos.setXYZ(k, _q4[0], _q4[1], _q4[2]);
      const age = k / this.count;
      al.setX(k, age * 0.9 * (1 - THREE.MathUtils.smoothstep(Math.abs(_q4[3]), 0.012, 0.05)));
    }
    this.line.geometry.setDrawRange(0, this.count);
    pos.needsUpdate = true;
    al.needsUpdate = true;
  }

  dispose() {
    this.line.removeFromParent();
    this.line.geometry.dispose(); // material not disposed, to keep its shader program (see Object4D.dispose)
  }
}

export class PlaygroundScene extends SceneBase {
  constructor(app) {
    super(app);
    this.key = 'playground';
    this.title = 'Hyperplay';
    this.short = 'Hyperplay';
    this.subtitle = '4D physics sandbox';
    this.mood = 'studio';
    this.tableY = 0.86;
    this.tableZ = -0.72;

    this.view = new SliceView();
    this.view.wMin = -W_RANGE;
    this.view.wMax = W_RANGE;
    this.world = new World4({ floorY: 0, wallRadius: TABLE_R - 0.012, wRange: W_RANGE + 0.02 });
    this.world.onImpact = (p, speed, a, b) => this._impact(p, speed, a, b);
    this.world.accel = (b, dt) => this._orbitAccel(b, dt);
    this.toys = [];
    this.ghosts = true;
    this.slowmo = false;
    this.lowGravity = false;
    this.preset = 'sandbox';
    this.sunW = 0;          // angle of the 4D sun towards ana (radians)
    this.gravity4 = true;   // orbits: 1/r³ (4D) or 1/r² (3D) gravity
    this.orbitTilt = false; // orbits: tilt the orbits into w
    this.orbitStats = { fell: 0, escaped: 0 };
    this.playing = false;   // worldline: move the slice through time
    this.wTravel = 0;

    this.stage = new THREE.Group(); // the 4D slice lives here (origin is the table center)
    this.root.add(this.stage);
    this.shadow4 = new Shadow4({ extent: TABLE_TOP_R });
    this._buildTable();
    // front left, standing on the ledge halfway between the rim and the edge
    this.rail = new WRail(this, new THREE.Vector3(-0.52, 0, 0.36).setLength((TABLE_R + RIM_TUBE + TABLE_TOP_R) / 2));
    this.burst = new Burst(this.stage);

    this.message = makeLabel(' ', { size: 0.028 });
    this.message.visible = false;
    this.stage.add(this.message);
    this.messageT = 0;

    this.interactables = [this.rail];
    this.desktopView = { position: new THREE.Vector3(0.0, 1.45, 0.25), target: new THREE.Vector3(0, this.tableY + 0.05, this.tableZ) };
    this._placeStage();
    this.loadPreset('sandbox');
  }

  _placeStage() {
    this.stage.position.set(0, this.tableY, this.tableZ);
    this.table.position.set(0, this.tableY, this.tableZ);
    this.desktopView.target.set(0, this.tableY + 0.05, this.tableZ);
  }

  _buildTable() {
    const t = new THREE.Group();
    this.table = t;
    this.root.add(t);
    // top with a faint polar grid
    const c = document.createElement('canvas');
    c.width = c.height = 1024;
    const g = c.getContext('2d');
    g.fillStyle = '#f3f0eb';
    g.fillRect(0, 0, 1024, 1024);
    g.strokeStyle = 'rgba(120,110,100,0.16)';
    g.lineWidth = 2;
    for (let r = 1; r <= 6; r++) { g.beginPath(); g.arc(512, 512, (r / 6) * 500, 0, Math.PI * 2); g.stroke(); }
    for (let a = 0; a < 12; a++) {
      g.beginPath(); g.moveTo(512, 512);
      g.lineTo(512 + Math.cos((a / 12) * Math.PI * 2) * 500, 512 + Math.sin((a / 12) * Math.PI * 2) * 500); g.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    // The 4D shadows are part of the top face's shading, not a separate layer on it.
    // Lambert since the top fills a lot of the view. A matte Standard material looks
    // the same here and costs about twice as much per pixel.
    const topParams = { color: '#ffffff', map: tex };
    const topMat = this.shadow4.receive(new THREE.MeshLambertMaterial(topParams));
    // Scale the grid so its outer circle (500 of 512 texels from the center)
    // lies under the rim, which puts a ring every 10 cm. The ledge outside it
    // shows the plain edge of the canvas.
    tex.repeat.setScalar(TABLE_TOP_R / (TABLE_R * (512 / 500)));
    tex.offset.setScalar((1 - tex.repeat.x) / 2);
    const top = new THREE.Mesh(new THREE.CylinderGeometry(TABLE_TOP_R, TABLE_TOP_R, 0.032, 128), [
      new THREE.MeshLambertMaterial({ color: '#e7e2da' }), topMat, new THREE.MeshLambertMaterial(topParams),
    ]);
    top.position.y = -0.016;
    t.add(top);
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(TABLE_R, RIM_TUBE, 10, 128).rotateX(Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: '#2b2f3a', emissive: '#eceef4', emissiveIntensity: 0.35 }),
    );
    rim.position.y = 0.004;
    t.add(rim);
    const legMat = new THREE.MeshLambertMaterial({ color: '#d4cec6' });
    this.leg = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.16, 1, 32), legMat);
    t.add(this.leg);
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.32, 0.03, 48), legMat);
    this.foot = foot;
    t.add(foot);
    this._layoutLeg();
  }

  _layoutLeg() {
    const h = this.tableY - 0.03;
    this.leg.scale.y = h;
    this.leg.position.y = -0.032 - h / 2;
    this.foot.position.y = -this.tableY + 0.015;
  }

  // Keeps the palm menu above the table top (see HandMenu._follow)
  get menuFloorY() { return this.tableY + 0.03; }

  onUserReady() {
    // fit the table to the person, roughly waist height
    const headY = this.app.headPosition.y;
    this.tableY = THREE.MathUtils.clamp(headY - 0.62, 0.7, 1.05);
    this._placeStage();
    this._layoutLeg();
  }

  enter() {
    super.enter();
    this._placeStage();
    this.shadow4.dirty = true;
  }

  // ---------------------------------------------------------------------------

  setW(w) {
    const before = this.view.w;
    this.view.setW(w);
    this._wSpeed = Math.abs(this.view.w - before);
    this.wTravel += this._wSpeed; // how far the person has moved the slice, for the tutorial
  }

  _removeToy(t) {
    this.app.interaction.forget(t);
    t.dispose();
  }

  clear() {
    for (const t of this.toys) this._removeToy(t);
    this.toys = [];
    this.interactables = [this.rail];
    this.boxGoal = null;
    this.mirror = null;
    this.dice = null;
    this.sun = null;
    this.moons = [];
    if (this.mirrorTarget) {
      this.mirrorTarget.dispose();
      this.mirrorTarget = null;
    }
    if (this.worldline) this.worldline.group.visible = false;
    this.rec = null;
    this.playing = false;
    this.world.linearDamping = 0.02;
  }

  add(key, opts) {
    const t = new Toy(this, key, opts);
    this.toys.push(t);
    if (!t.fixed) this.interactables.push(t);
    t.sync(0);
    return t;
  }

  _drop(t) {
    this._removeToy(t);
    this.toys = this.toys.filter((x) => x !== t);
    this.interactables = this.interactables.filter((x) => x !== t);
  }

  spawn(key) {
    const dynamic = this.toys.filter((t) => !t.fixed);
    if (dynamic.length >= MAX_TOYS) {
      const old = dynamic.find((t) => !t.grabbedBy);
      if (old) this._drop(old);
    }
    // drop in front of the viewer, inside the current slice
    const scale = key === 'hypersphere' ? 0.055 + rand() * 0.04 : key === 'tesseract' ? 0.13 : key === 'tiger' ? 0.1 : 0.11;
    const x = (rand() - 0.5) * 0.3, z = (rand() - 0.5) * 0.2 + 0.1;
    const s = [x, 0.35, z, 0];
    const w = this.view.toWorld([0, 0, 0, 0], s);
    this.add(key, { scale, pos: w, rot: randRot() });
    this.app.audio.spawn(this.stage.localToWorld(new THREE.Vector3(x, 0.35, z)));
  }

  loadPreset(name) {
    const was = this.preset;
    this.preset = name;
    this.clear();
    this.view.setW(0);
    this.view.setAngles(0, 0);
    if (name !== 'shadows' && was === 'shadows') this.sunW = 0;
    seed = 11;
    const P4 = (x, y, z, w) => [x, y, z, w];
    if (name === 'sandbox') {
      // most objects near w = 0, a few further along w so they show as ghosts
      this.add('tesseract', { scale: 0.14, pos: P4(-0.2, 0.08, -0.08, 0.0), rot: randRot() });
      this.add('hypersphere', { scale: 0.075, pos: P4(0.14, 0.1, 0.12, 0.02) });
      this.add('hypersphere', { scale: 0.05, pos: P4(0.3, 0.1, -0.1, -0.03) });
      this.add('icositetrachoron', { scale: 0.1, pos: P4(0.05, 0.12, -0.28, 0.01), rot: randRot() });
      this.add('simplex', { scale: 0.12, pos: P4(-0.32, 0.12, 0.2, 0.02), rot: randRot() });
      this.add('duocylinder', { scale: 0.09, pos: P4(-0.02, 0.1, 0.26, -0.02), rot: randRot() });
      this.add('tiger', { scale: 0.09, pos: P4(0.32, 0.12, 0.3, 0.0), rot: randRot() });
      this.add('orthoplex', { scale: 0.1, pos: P4(0.3, 0.1, -0.35, 0.2), rot: randRot() });
      this.add('spherinder', { scale: 0.08, pos: P4(-0.3, 0.1, -0.3, 0.26), rot: randRot() });
      this.add('tesseract', { scale: 0.09, pos: P4(0.05, 0.1, 0.02, -0.32), rot: randRot() });
      this.add('hypersphere', { scale: 0.065, pos: P4(-0.1, 0.1, 0.1, 0.38) });
    } else if (name === 'box') {
      // Closed box. The walls only extend ±6 cm in w, so the ball can be
      // moved around them in w. The panels don't overlap. The side walls run
      // the full depth, the front and back fit between them, and the lid
      // covers all four.
      const ww = 0.06, s = 0.13, th = 0.012, hgt = 0.16, out = 2 * s + th;
      const glass = { fixed: true, opacity: 0.28, tint: '#bfe6ff', tintAmount: 0.85, restitution: 0.2 };
      this.add('tesseract', { ...glass, scale4: [out, th, out, 2 * ww], pos: P4(0, hgt + th / 2, 0, 0) }); // lid
      this.add('tesseract', { ...glass, scale4: [th, hgt, out, 2 * ww], pos: P4(s, hgt / 2, 0, 0) });
      this.add('tesseract', { ...glass, scale4: [th, hgt, out, 2 * ww], pos: P4(-s, hgt / 2, 0, 0) });
      this.add('tesseract', { ...glass, scale4: [2 * s - th, hgt, th, 2 * ww], pos: P4(0, hgt / 2, s, 0) });
      this.add('tesseract', { ...glass, scale4: [2 * s - th, hgt, th, 2 * ww], pos: P4(0, hgt / 2, -s, 0) });
      this.ball = this.add('hypersphere', { scale: 0.045, pos: P4(0, 0.05, 0, 0), restitution: 0.2 });
      this.boxGoal = { s, done: false };
      this._say('Get the ball out of the box', 5);
    } else if (name === 'tower') {
      const s = 0.1; // tesseract edge length
      for (let lvl = 0; lvl < 4; lvl++) {
        for (let i = 0; i < 2; i++) {
          this.add('tesseract', { scale: s, pos: P4((i - 0.5) * s * 1.02 + (lvl % 2 ? 0.02 : 0), s * 0.5 + lvl * s * 1.001, 0, (lvl % 2 ? 1 : -1) * 0.01) });
        }
      }
      this.add('icositetrachoron', { scale: 0.07, pos: P4(0, s * 4 + 0.07, 0, 0) });
      this.add('hypersphere', { scale: 0.06, pos: P4(0.2, 0.08, 0.28, 0) });
      this.add('hypersphere', { scale: 0.06, pos: P4(-0.2, 0.08, 0.28, 0) });
      this._say('Tesseract tower', 3);
    } else if (name === 'balls') {
      for (let i = 0; i < 14; i++) {
        const r = 0.035 + rand() * 0.05;
        this.add('hypersphere', { scale: r, pos: P4((rand() - 0.5) * 0.7, 0.25 + i * 0.07, (rand() - 0.5) * 0.7, (rand() - 0.5) * 0.9), restitution: 0.55 });
      }
      this._say('Hyperspheres at different w positions', 3);
    } else if (name === 'rollers') {
      const keys = ['duocylinder', 'spherinder', 'cubinder', 'tiger', 'spheritorus', 'torisphere', 'duocylinder'];
      keys.forEach((k, i) => {
        const a = (i / keys.length) * Math.PI * 2;
        const t = this.add(k, { scale: 0.085, pos: P4(Math.cos(a) * 0.3, 0.12, Math.sin(a) * 0.3, (rand() - 0.5) * 0.3), rot: randRot() });
        const B = [0, 0, 0, 0, 0, 0];
        B[Math.floor(rand() * 6)] = 8 + rand() * 6;
        B[Math.floor(rand() * 6)] += 5;
        t.body.setAngularVelocity(B);
        t.body.v[3] = (rand() - 0.5) * 0.3;
      });
      this._say('Curved 4D shapes with random spin', 3);
    } else if (name === 'polytopes') {
      const keys = ['simplex', 'orthoplex', 'tesseract', 'icositetrachoron', 'hecatonicosachoron', 'hexacosichoron', 'duoprism'];
      keys.forEach((k, i) => {
        const a = (i / keys.length) * Math.PI * 2;
        this.add(k, { scale: k === 'tesseract' ? 0.15 : 0.11, pos: P4(Math.cos(a) * 0.32, 0.14, Math.sin(a) * 0.32, 0), rot: randRot() });
      });
      this._say('Regular 4-polytopes', 3);
    } else if (name === 'mirror') {
      this._loadMirror();
    } else if (name === 'dice') {
      this._loadDice();
    } else if (name === 'orbits') {
      this.world.linearDamping = 0; // no drag in space
      this.sun = this.add('hypersphere', { scale: 0.045, pos: P4(0, ORBIT_Y, 0, 0), fixed: true, tint: '#ffc44d', tintAmount: 0.85 });
      this.launchMoons();
      this._say(this.gravity4 ? '4D gravity: no orbit is stable' : '3D gravity: orbits close up', 4);
    } else if (name === 'shadows') {
      // The sun leans towards ana, so shadows shift towards kata as they fall.
      // The first three are outside the slice but their shadows cross it.
      this.sunW = THREE.MathUtils.degToRad(50);
      this.add('tesseract', { scale: 0.14, pos: P4(-0.22, 0.07, -0.05, 0.11), rot: R4.planeRotation(R4.mat4(), 0, 2, 0.4) });
      this.add('icositetrachoron', { scale: 0.11, pos: P4(0.2, 0.1, -0.2, 0.13), rot: randRot() });
      this.add('hypersphere', { scale: 0.06, pos: P4(0.05, 0.06, 0.24, 0.09) });
      // in the slice, but their shadows fall outside it
      this.add('orthoplex', { scale: 0.1, pos: P4(0.28, 0.1, 0.18, -0.04), rot: randRot() });
      this.add('tesseract', { scale: 0.09, pos: P4(-0.12, 0.05, 0.28, 0), rot: R4.planeRotation(R4.mat4(), 0, 2, -0.3) });
      this._say('The sun leans 50° towards ana', 4);
    } else if (name === 'worldline') {
      if (!this.worldline) this.worldline = new Worldline(this.stage);
      if (this.worldline.empty || this.worldlineDemo) this._setJuggling();
      this.worldline.group.visible = true;
      this.playing = true;
      this.setW(-REC_HALF_W);
      this._say(this.worldlineDemo ? 'Juggling, with time as w' : 'Your recording, with time as w', 3);
    }
    if (this.app.activeScene === this) this.app.menu.rebuild();
    this.shadow4.dirty = true;
  }

  // --- presets with their own logic --------------------------------------------------

  _loadMirror() {
    // A chiral piece and an outline of its mirror image. The outline is the
    // piece turned half a turn in the xw plane (x becomes -x and w becomes -w),
    // which reflects its 3D cross-section.
    const s = 0.12, h = (SCREW_EDGE / 2) * s;
    const centers = screwCenters().map((c) => c.map((x) => x * s));
    const Rt = R4.multiply(R4.mat4(), R4.planeRotation(R4.mat4(), 0, 2, Math.PI / 2), R4.planeRotation(R4.mat4(), 0, 3, Math.PI));
    const R0 = R4.planeRotation(R4.mat4(), 2, 1, Math.PI / 2);
    const targetPos = [0.17, restHeight(Rt, centers, h), -0.08, 0];
    this.mirrorTarget = new Object4D('screw', { scale: s, position: targetPos, rotation: Rt, opacity: 0.3, tint: '#ffffff', tintAmount: 0.75 });
    this.mirrorTarget.ghostsEnabled = false;
    this.stage.add(this.mirrorTarget.group);
    const piece = this.add('screw', { scale: s, pos: [-0.18, restHeight(R0, centers, h) + 0.002, 0.12, 0], rot: R0 });
    const target = centers.map((c) => V.add([0, 0, 0, 0], R4.apply([0, 0, 0, 0], Rt, c), targetPos));
    this.mirror = { piece, centers, target, done: false };
    this._say('Fit the piece into the outline', 5);
  }

  // True when the piece's four cubes (4D centers) sit on the outline's
  _mirrorSolved() {
    const m = this.mirror;
    const b = m.piece.body;
    if (m.piece.grabbedBy) return false;
    return m.centers.every((c) => {
      V.add(_n4, R4.apply(_n4, b.R, c), b.x);
      return m.target.some((t) => V.distance(_n4, t) < 0.022);
    });
  }

  _loadDice() {
    this.dice = [];
    DICE.forEach((d, i) => {
      const a = (i / DICE.length) * Math.PI * 2 + 0.3;
      const t = this.add(d.key, { scale: 0.075, pos: [Math.cos(a) * 0.3, 0.2 + i * 0.03, Math.sin(a) * 0.3, 0], rot: randRot(), restitution: 0.25 });
      const poly = d.poly();
      const label = new TextLabel({ size: 0.024, template: 'd600  600', weight: 600, bg: 'rgba(244,245,248,0.92)' });
      this.stage.add(label.mesh);
      t.label = label;
      this.dice.push({ toy: t, name: d.name, nums: diceNumbers(poly), normals: poly.cells.map((c) => c.normal), top: d.key !== 'simplex', still: 0, result: null });
    });
    this.rollDice();
  }

  rollDice() {
    if (!this.dice) return;
    this.dice.forEach((d, i) => {
      const b = d.toy.body;
      const a = (i / this.dice.length) * Math.PI * 2 + rand();
      V.set(b.x, Math.cos(a) * 0.28, 0.22 + i * 0.03, Math.sin(a) * 0.28, 0);
      R4.randomRotation(b.R, rand);
      // Thrown around the ring so they rarely hit each other, with a tumble in
      // the xyz planes. Rolling on a tilted 4D cell can still move a die in w.
      V.set(b.v, -Math.sin(a) * 0.55 - Math.cos(a) * 0.15, 0.3, Math.cos(a) * 0.55 - Math.sin(a) * 0.15, 0);
      b.wake();
      b.setAngularVelocity([(rand() - 0.5) * 24, (rand() - 0.5) * 24, 0, (rand() - 0.5) * 24, 0, 0]);
      d.still = 0;
      d.result = null;
    });
    this.app.audio.whoosh(this.stage.localToWorld(new THREE.Vector3(0, 0.2, 0)));
  }

  _updateDice(dt) {
    const head = this.stage.worldToLocal(_head.copy(this.app.headPosition));
    for (const d of this.dice) {
      const b = d.toy.body;
      const moving = d.toy.grabbedBy || (!b.sleeping && (V.length(b.v) > 0.03 || R4.bivNorm(b.w) > 0.4));
      d.still = moving ? 0 : d.still + dt;
      const u = d.toy.obj.mats.solid.uniforms;
      if (d.still > 0.35 && d.result === null) {
        // world normal y of each cell = row 1 of R · n
        let best = 0, bestY = d.top ? -Infinity : Infinity;
        d.normals.forEach((n, i) => {
          const y = b.R[4] * n[0] + b.R[5] * n[1] + b.R[6] * n[2] + b.R[7] * n[3];
          if (d.top ? y > bestY : y < bestY) { bestY = y; best = i; }
        });
        d.result = d.nums[best];
        u.uCellHi.value.set(...d.normals[best]);
        this.app.audio._tone({ freq: 660 + d.result % 12 * 40, type: 'triangle', dur: 0.12, gain: 0.06 });
      }
      if (d.still === 0) d.result = null;
      u.uCellHiAmount.value = d.result !== null && d.top ? 1 : 0;
      const o = d.toy.obj;
      const p = o.slicePos;
      d.toy.label.setText(`${d.name}  ${d.result ?? '…'}`, d.result !== null ? '#11131a' : '#6a7082');
      d.toy.label.mesh.position.set(p[0], p[1] + o.radius + 0.035, p[2]);
      d.toy.label.mesh.lookAt(this.stage.localToWorld(_v3.set(head.x, p[1] + o.radius + 0.035, head.z)));
      d.toy.label.mesh.material.opacity = o.inSlice ? 1 : 0.4;
    }
  }

  launchMoons() {
    if (this.preset !== 'orbits' || !this.sun) return;
    for (const m of this.moons) this._drop(m);
    this.moons = [];
    this.orbitStats = { fell: 0, escaped: 0 };
    const radii = [0.12, 0.18, 0.24, 0.3];
    // small nudges off the circular speed. In 4D these decide whether a moon falls in or escapes
    const nudge = [0.985, 1.015, 0.992, 1.008];
    const colors = ['#9fd8ff', '#ff9f68', '#b8e05a', '#d77bff'];
    radii.forEach((r, i) => {
      const a = rand() * Math.PI * 2;
      const moon = this.add('hypersphere', { scale: 0.016, pos: [Math.cos(a) * r, ORBIT_Y, Math.sin(a) * r, 0], tint: colors[i], tintAmount: 0.8, restitution: 0.6 });
      const v = (this.gravity4 ? Math.sqrt(GM4) / r : Math.sqrt(GM3 / r)) * nudge[i];
      const tilt = this.orbitTilt ? 0.6 : 0;
      V.set(moon.body.v, -Math.sin(a) * v * Math.cos(tilt), 0, Math.cos(a) * v * Math.cos(tilt), v * Math.sin(tilt));
      moon.trail = new Trail(this.stage, colors[i]);
      this.moons.push(moon);
    });
  }

  // The sun's gravity in the orbits preset, called by the physics each substep
  _orbitAccel(b, dt) {
    if (this.preset !== 'orbits' || !this.sun || b === this.sun.body) return;
    const s = this.sun.body;
    V.sub(_n4, s.x, b.x);
    const r = V.length(_n4);
    if (r < s.collider.r + b.collider.r + 0.003) {
      b.enabled = false; // fell into the sun
      b.crashed = true;
      return;
    }
    const a = this.gravity4 ? GM4 / (r * r * r) : GM3 / (r * r);
    V.addScaled(b.v, b.v, _n4, (a * dt) / r);
  }

  _updateOrbits() {
    const s = this.sun.body.x;
    for (const t of this.toys) {
      if (t === this.sun || t.fixed) continue;
      if (!this.moons.includes(t)) { // thrown in from elsewhere
        t.trail = new Trail(this.stage, '#ffffff');
        this.moons.push(t);
      }
    }
    for (let i = this.moons.length - 1; i >= 0; i--) {
      const m = this.moons[i];
      const b = m.body;
      if (b.crashed || V.distance(b.x, s) > 0.5) {
        if (b.crashed) {
          this.orbitStats.fell++;
          const p = this.view.toSlice([0, 0, 0, 0], b.x);
          if (Math.abs(p[3]) < 0.1) this.burst.fire(new THREE.Vector3(p[0], p[1], p[2]), ['#ffc44d', '#ff9f68', '#ffffff'], 0.5);
        } else this.orbitStats.escaped++;
        this.moons.splice(i, 1);
        this._drop(m);
        continue;
      }
      if (this.app.frameCount % 2 === 0) m.trail.push(b.x);
      m.trail.update(this.view);
    }
  }

  _setJuggling() {
    const j = jugglingChains({ halfW: REC_HALF_W });
    this.worldline.setChains(j.chains);
    this.worldlineDuration = j.duration;
    this.worldlineDemo = true;
  }

  // Records the tracked hands (or controllers, or the mouse) for a few seconds
  startRecording() {
    if (this.preset !== 'worldline') this.loadPreset('worldline');
    this.playing = false;
    this.view.setAngles(0, 0);
    this.setW(0);
    this.worldline.group.visible = false;
    this.rec = { t: -3, frames: [], shown: null };
  }

  _sampleSources(out) {
    const add = (key, p, r, color) => {
      const l = this.stage.worldToLocal(_v3.copy(p));
      out.push({ key, x: l.x, y: l.y, z: l.z, r, color });
    };
    if (this.app.presenting) {
      for (const ix of this.app.input.xr) {
        if (!ix.active) continue;
        if (ix.kind === 'hand' && ix.jointsValid) {
          for (let j = 0; j < 25; j++) add(`${ix.handedness}${j}`, ix.joints[j].pos, Math.max(0.006, ix.joints[j].radius), FINGER_COLORS[fingerOf(j)]);
        } else if (ix.kind === 'controller') add(`${ix.handedness}c`, ix.grabPos, 0.016, ix.handedness === 'left' ? '#33c3ff' : '#ff4f9a');
      }
    } else add('mouse', this.app.input.mouse.grabPos, 0.016, '#ff4f9a');
  }

  _updateRecording(dt) {
    const rec = this.rec;
    rec.t += dt;
    if (rec.t < 0) {
      const n = Math.ceil(-rec.t);
      if (rec.shown !== n) { rec.shown = n; this._say(`Recording in ${n}`, 1.2); this.app.audio._tone({ freq: 520, dur: 0.08, gain: 0.08 }); }
      return;
    }
    if (rec.shown !== 'rec') { rec.shown = 'rec'; this._say('Recording: move your hands', REC_TIME); this.app.audio._tone({ freq: 880, dur: 0.12, gain: 0.08 }); }
    const samples = [];
    this._sampleSources(samples);
    rec.frames.push({ t: rec.t, samples });
    if (rec.t < REC_TIME) return;
    // one chain per tracked point, split where tracking dropped out
    const chains = [];
    const open = new Map();
    for (const f of rec.frames) {
      const seen = new Set();
      const w = ((f.t - REC_TIME / 2) / REC_TIME) * 2 * REC_HALF_W;
      for (const s of f.samples) {
        seen.add(s.key);
        let c = open.get(s.key);
        if (!c) { c = { points: [], radius: s.r, color: s.color }; open.set(s.key, c); chains.push(c); }
        c.points.push([s.x, s.y, s.z, w]);
      }
      for (const k of [...open.keys()]) if (!seen.has(k)) open.delete(k);
    }
    this.rec = null;
    this.worldline.setChains(chains);
    this.worldlineDuration = REC_TIME;
    this.worldlineDemo = false;
    this.worldline.group.visible = true;
    this.playing = !this.worldline.empty; // nothing to replay if its w range is empty
    this.setW(-REC_HALF_W);
    this.app.audio.spawn(this.stage.localToWorld(new THREE.Vector3(0, 0.2, 0)));
    this._say(this.worldline.empty ? 'Nothing was tracked' : 'Replaying: the slice moves through time', 3);
    if (this.app.activeScene === this) this.app.menu.rebuild();
  }

  _say(text, seconds = 3) {
    disposeLabel(this.message);
    this.message = makeLabel(text, { size: 0.03, color: '#11131a', bg: 'rgba(244,245,248,0.9)' });
    this.message.position.set(0, 0.42, -0.1);
    this.stage.add(this.message);
    this.messageT = seconds;
  }

  _impact(p, speed, a, b) {
    const pos = this.stage.localToWorld(new THREE.Vector3());
    // physics uses 4D world coordinates, so place the sound in the slice
    const s = this.view.toSlice([0, 0, 0, 0], p);
    if (Math.abs(s[3]) > 0.15) return; // collisions far off-slice are "silent"
    pos.add(new THREE.Vector3(s[0], s[1], s[2]));
    const size = (b.userData?.obj?.radius || 0.08);
    this.app.audio.hit(pos, speed, size);
    for (const toy of [a.userData, b.userData]) {
      if (toy?.grabbedBy) toy.grabbedBy.pulse(Math.min(1, speed * 0.4), 20);
    }
  }

  // ---------------------------------------------------------------------------
  // Pinching empty space and moving up/down moves the slice along W.
  // Middle-finger pinching empty space and dragging rotates the slice (xw / zw).

  onEmptyGrabStart(ix, mode) {
    if (!ix.isMouse) {
      for (const t of this.toys) {
        if (t.enabled && t.nearDistance(ix.grabPos, NEAR_MISS) < NEAR_MISS) return false;
      }
    }
    this._air = { start: ix.grabPos.clone(), w: this.view.w, xw: this.view.angleXW, zw: this.view.angleZW, mode, live: false };
    return true;
  }

  onEmptyGrabUpdate(ix, mode) {
    const a = this._air;
    if (!a) return;
    const d = _hp.copy(ix.grabPos).sub(a.start);
    if (!a.live) {
      if (d.length() < AIR_DEADZONE) return;
      a.live = true; // start from where the hand is now so nothing jumps
      a.start.copy(ix.grabPos);
      if (mode === 'primary') this.playing = false;
      return;
    }
    if (mode === 'primary') {
      const gain = ix.isMouse ? 1.0 : 1.6;
      this.setW(a.w + d.y * gain);
      this.app.hands.readout(ix, `w ${fmtW(this.view.w)}`, wColor(this.view.w));
    } else {
      const k = ix.isMouse ? 2.5 : 4.0;
      const xw = THREE.MathUtils.clamp(a.xw + d.x * k, -Math.PI / 2, Math.PI / 2);
      const zw = THREE.MathUtils.clamp(a.zw - d.z * k, -Math.PI / 2, Math.PI / 2);
      this.view.setAngles(xw, zw);
      this.app.hands.readout(ix, `xw ${deg(xw)}  zw ${deg(zw)}`);
    }
  }

  resetSlice() {
    this.playing = false;
    this.setW(0);
    this.view.setAngles(0, 0);
  }

  onEmptyGrabEnd() { this._air = null; }

  onWheel(delta) {
    this.playing = false;
    this.setW(this.view.w - delta * 0.0006);
  }

  onKey(e) {
    const k = e.key.toLowerCase();
    if (k === 'q' || e.key === 'ArrowDown') { this.playing = false; this.setW(this.view.w - 0.02); }
    if (k === 'e' || e.key === 'ArrowUp') { this.playing = false; this.setW(this.view.w + 0.02); }
    if (k === 'a' || e.key === 'ArrowLeft') this.view.setAngles(this.view.angleXW - 0.05, this.view.angleZW);
    if (k === 'd' || e.key === 'ArrowRight') this.view.setAngles(this.view.angleXW + 0.05, this.view.angleZW);
    if (k === 'r') this.loadPreset(this.preset);
    if (k === 'g') this.ghosts = !this.ghosts;
    if (k === ' ' && this.preset === 'worldline') this.playing = !this.playing;
    if (k === '0') this.resetSlice();
  }

  // ---------------------------------------------------------------------------

  update(dt, time) {
    // controllers: thumbstick moves the slice along W and rotates it
    for (const ix of this.app.input.xr) {
      if (ix.kind !== 'controller') continue;
      if (Math.abs(ix.stick.y) > 0) {
        this.playing = false;
        this.setW(this.view.w - ix.stick.y * dt * 0.45);
        this.app.hands.readout(ix, `w ${fmtW(this.view.w)}`, wColor(this.view.w));
      }
      if (Math.abs(ix.stick.x) > 0 && !ix.grabbed) {
        this.view.setAngles(THREE.MathUtils.clamp(this.view.angleXW + ix.stick.x * dt * 1.0, -Math.PI / 2, Math.PI / 2), this.view.angleZW);
        this.app.hands.readout(ix, `xw ${deg(this.view.angleXW)}`);
      }
    }

    this.world.gravity[1] = this.preset === 'orbits' ? 0 : this.lowGravity ? -2.2 : -9.81;
    this.world.step(this.slowmo ? dt * 0.25 : dt);

    for (const t of this.toys) {
      t.obj.ghostsEnabled = this.ghosts && !t.fixed;
      t.sync(dt);
      if (t.obj.poseChanged) { this.shadow4.dirty = true; t.obj.poseChanged = false; }
      // fell off the table, move it back into the slice
      if (t.body.x[1] < -1.5) {
        const s = [0, 0.3, 0, 0];
        V.copy(t.body.x, this.view.toWorld([0, 0, 0, 0], s));
        V.set(t.body.v, 0, 0, 0, 0);
      }
    }
    if (this.mirrorTarget) this.mirrorTarget.sync(this.view, dt);
    this.rail.update(this.toys);
    this.burst.update(dt);

    if (this.dice) this._updateDice(dt);
    if (this.preset === 'orbits' && this.sun) this._updateOrbits();
    if (this.rec) this._updateRecording(dt);
    if (this.worldline?.group.visible) {
      if (this.playing && !this._air) {
        const span = this.worldline.wMax - this.worldline.wMin;
        let w = this.view.w + (span / (this.worldlineDuration || REC_TIME)) * dt;
        if (w > this.worldline.wMax) w = this.worldline.wMin;
        this.view.setW(w);
      }
      this.worldline.update(this.view);
    }

    // W-scrub tone
    const w01 = (this.view.w - this.view.wMin) / (this.view.wMax - this.view.wMin);
    this.app.audio.scrub(w01, this.playing ? 0 : (this._wSpeed || 0) / Math.max(dt, 1e-3));
    this._wSpeed = 0;

    // sealed-box puzzle
    if (this.boxGoal && !this.boxGoal.done && this.ball) {
      const x = this.ball.body.x;
      const s = this.boxGoal.s;
      if ((Math.abs(x[0]) > s + 0.03 || Math.abs(x[2]) > s + 0.03) && Math.abs(x[3]) < 0.05 && !this.ball.grabbedBy) {
        this.boxGoal.done = true;
        this._celebrate(x, 'Solved');
      }
    }
    // mirror puzzle
    if (this.mirror && !this.mirror.done && this._mirrorSolved()) {
      this.mirror.done = true;
      this._celebrate(this.mirror.piece.body.x, 'Solved: a half-turn through w mirrored it');
    }

    // 4D shadows use the sun's direction in slice space, tilted towards ana by sunW
    const sd = LIGHT.uSunDir.value, c = Math.cos(this.sunW), sn = Math.sin(this.sunW);
    this.shadow4.setSun(sd.x * c, sd.y * c, sd.z * c, sn);
    const shadowsOn = this.app.env.shadows; // the graphics preset's shadow setting
    this.shadow4.enabled = shadowsOn;
    if (shadowsOn) this.shadow4.render(this.app.renderer);

    if (this.messageT > 0) {
      this.messageT -= dt;
      this.message.visible = true;
      const head = this.stage.worldToLocal(_head.copy(this.app.headPosition));
      this.message.lookAt(this.stage.localToWorld(head.setY(this.message.position.y)));
      this.message.material.opacity = Math.min(1, this.messageT * 2);
    } else this.message.visible = false;
  }

  _celebrate(x4, text) {
    const p = this.view.toSlice([0, 0, 0, 0], x4);
    this.burst.fire(new THREE.Vector3(p[0], p[1], p[2]));
    this.app.audio.spawn(this.stage.localToWorld(new THREE.Vector3(p[0], p[1], p[2])));
    for (const ix of this.app.input.xr) ix.pulse(0.7, 120);
    this._say(text, 4);
  }

  // --- tutorial (see core/guide.js) ------------------------------------------------

  tutorial() {
    if (this.preset !== 'sandbox') this.loadPreset('sandbox');
    const app = this.app;
    const held = (mode) => app.input.xr.some((ix) => ix.grabbed instanceof Toy && (!mode || ix.grabMode === mode));
    let grabbed = false, w0 = null, turnT = 0;
    return [
      {
        title: 'Pick something up',
        text: {
          hands: 'Pinch an object between your thumb and index finger, or close your hand around it. Let go to drop or throw it. For objects out of reach, point at one with your arm out and pinch.',
          controllers: 'Hold the trigger or grip with the controller in an object, or point at one further away. Let go to drop or throw it.',
        },
        demo: 'grab', fingers: 'index', tag: 'Trigger or grip: grab',
        done: () => { if (held()) grabbed = true; return grabbed && !held(); },
      },
      {
        title: 'Move the slice',
        text: {
          hands: 'Pinch empty space away from the objects and move your hand up or down. This moves the slice along w, and the cross-sections change as it goes.',
          controllers: 'Push a thumbstick up or down. This moves the slice along w, and the cross-sections change as it goes.',
        },
        demo: 'air', fingers: 'index', tag: 'Stick up or down: move the slice',
        done: () => { if (w0 === null) w0 = this.wTravel; return this.wTravel - w0 > 0.15; },
      },
      {
        title: 'Turn through w',
        text: {
          hands: 'Pinch an object between your thumb and middle finger and move your hand. It turns through w, the fourth direction.',
          controllers: 'Hold the trigger and grip together on an object and move the controller. It turns through w, the fourth direction.',
        },
        fingers: 'middle', tag: 'Trigger and grip: turn through w',
        done: (dt) => { if (held('secondary')) turnT += dt; return turnT > 0.5; },
      },
      {
        title: 'Open the menu',
        text: {
          hands: "Turn a palm towards you and tap the Menu button next to it with your other hand. Don't pinch with that hand, since the Quest uses that for its own menu.",
          controllers: 'Press A or X.',
        },
        demo: 'palm', tag: 'A or X: menu',
        done: () => app.menu.shown,
      },
    ];
  }

  // Where the tutorial's demonstration hand pinches. 'grab': the top of the
  // nearest object in reach. 'air': empty space over the near half of the table.
  demoTarget(kind, out) {
    const head = this.stage.worldToLocal(_head.copy(this.app.headPosition));
    if (kind === 'grab') {
      let best = null, bestD = 0.75;
      for (const t of this.toys) {
        if (!t.enabled || t.grabbedBy || !t.obj.inSlice || t.obj.sliceRadius < 0.03) continue;
        const p = t.obj.slicePos;
        const d = Math.hypot(p[0] - head.x, p[2] - head.z);
        if (d < bestD) { bestD = d; best = t; }
      }
      if (!best) return false;
      const p = best.obj.slicePos;
      this.stage.localToWorld(out.set(p[0], p[1] + best.obj.sliceRadius * 0.45, p[2]));
      return true;
    }
    // halfway from the table's center to the person, a little to the right, above the objects
    const p = _air.set(head.x * 0.5 + 0.1, 0.28, head.z * 0.5);
    for (let i = 0; i < 4; i++) {
      this.stage.localToWorld(out.copy(p));
      if (!this.toys.some((t) => t.enabled && t.nearDistance(out, NEAR_MISS) < NEAR_MISS + 0.03)) break;
      p.y += 0.08;
    }
    return true;
  }

  // The tutorial card floats over the far side of the table
  guideAnchor(out) {
    this.stage.localToWorld(out.set(0, 0.5, -0.45));
    return true;
  }

  menuRows() {
    const preset = (label, key) => ({ label, onClick: () => this.loadPreset(key), active: () => this.preset === key });
    const rows = [
      {
        type: 'buttons', columns: 4,
        items: [
          preset('Sandbox', 'sandbox'), preset('Sealed box', 'box'), preset('Tower', 'tower'), preset('Hyperballs', 'balls'),
          preset('Rollers', 'rollers'), preset('Polytopes', 'polytopes'), preset('Mirror', 'mirror'), preset('Dice', 'dice'),
          preset('Orbits', 'orbits'), preset('Shadows', 'shadows'), preset('Worldline', 'worldline'),
        ],
      },
      { type: 'slider', label: 'Slice position (w)', min: this.view.wMin, max: this.view.wMax, center: 0, get: () => this.view.w, set: (v) => { this.playing = false; this.setW(v); }, format: fmtW, gradient: W_GRADIENT },
      {
        type: 'slider', label: 'Slice rotation (xw)', min: -Math.PI / 2, max: Math.PI / 2, center: 0,
        get: () => this.view.angleXW, set: (v) => this.view.setAngles(v, this.view.angleZW), format: deg,
      },
      {
        type: 'buttons', columns: 2,
        items: [
          { label: 'Reset slice', small: true, onClick: () => this.resetSlice() },
          { label: 'Restart preset', small: true, onClick: () => this.loadPreset(this.preset) },
        ],
      },
    ];
    if (this.preset === 'orbits') {
      rows.push(
        {
          type: 'toggles', columns: 2,
          items: [
            { label: '4D gravity (1/r³)', get: () => this.gravity4, set: (v) => { this.gravity4 = v; this.launchMoons(); } },
            { label: 'Tilt orbits into w', get: () => this.orbitTilt, set: (v) => { this.orbitTilt = v; this.launchMoons(); } },
          ],
        },
        { type: 'buttons', items: [{ label: 'Launch moons', onClick: () => this.launchMoons() }] },
        { type: 'text', lines: 1, color: '#dfe2ff', text: () => `Orbiting ${this.moons.length} · fell in ${this.orbitStats.fell} · escaped ${this.orbitStats.escaped}` },
      );
    } else if (this.preset === 'worldline') {
      rows.push({
        type: 'buttons', columns: 3,
        items: [
          { label: () => (this.rec ? 'Recording…' : 'Record 4 s'), onClick: () => this.startRecording() },
          { label: () => (this.playing ? 'Pause' : 'Play'), onClick: () => { this.playing = !this.playing; } },
          { label: 'Juggling', onClick: () => { this._setJuggling(); this.playing = true; this.setW(-REC_HALF_W); } },
        ],
      });
    } else if (this.preset === 'dice') {
      rows.push({ type: 'buttons', items: [{ label: 'Roll the dice', onClick: () => this.rollDice() }] });
    } else {
      rows.push({
        type: 'buttons', columns: 4,
        items: [
          { label: '+ Tesseract', small: true, onClick: () => this.spawn('tesseract') },
          { label: '+ Sphere', small: true, onClick: () => this.spawn('hypersphere') },
          { label: '+ 24-cell', small: true, onClick: () => this.spawn('icositetrachoron') },
          { label: '+ Duocyl.', small: true, onClick: () => this.spawn('duocylinder') },
        ],
      });
    }
    if (this.preset === 'shadows') {
      // the Low graphics preset turns the 4D shadows off (App rebuilds the menu when it changes)
      const noShadows = () => !this.app.env.shadows;
      rows.push({
        type: 'slider', label: 'Sun angle towards ana', min: -THREE.MathUtils.degToRad(60), max: THREE.MathUtils.degToRad(60), center: 0,
        get: () => this.sunW, set: (v) => { this.sunW = v; }, format: deg, gradient: W_GRADIENT, disabled: noShadows,
      });
      if (noShadows()) rows.push({ type: 'text', lines: 2, text: 'Shadows are off at Low graphics quality.' });
    }
    rows.push(
      {
        type: 'toggles', columns: 3,
        items: [
          { label: 'Ghosts', get: () => this.ghosts, set: (v) => { this.ghosts = v; } },
          { label: 'Slow-mo', get: () => this.slowmo, set: (v) => { this.slowmo = v; } },
          // orbits have no gravity towards the table
          { label: 'Low gravity', get: () => this.lowGravity, set: (v) => { this.lowGravity = v; }, disabled: () => this.preset === 'orbits' },
        ],
      },
    );
    return rows;
  }

  hint(mode) {
    const move = { hands: 'by pinching empty space with your other hand', controllers: 'with the stick', desktop: 'with the scroll wheel' }[mode];
    const turn4 = { hands: 'middle-finger pinch it and move your hand', controllers: 'hold the trigger and grip on it and move the controller', desktop: 'right-drag it' }[mode];
    if (this.preset === 'box') {
      return `The box walls only extend a short distance in w. Hold the ball, move the slice along w ${move} until the walls are gone, move the ball out, then move the slice back.`;
    }
    if (this.preset === 'mirror') {
      return `The outline is the piece's mirror image, and no turn in 3D can match it. Turn the piece half a turn through w: ${turn4}.`;
    }
    if (this.preset === 'dice') {
      return 'Regular 4-polytopes as dice. A 4D die lands on a 3D cell, and the number is on the cell facing up. Opposite cells add up to N + 1. The 5-cell is read from the cell it rests on.';
    }
    if (this.preset === 'orbits') {
      return 'In 4D, gravity falls off as 1/r³. Every circular orbit then has zero energy, so a small nudge sends a moon into the sun or away for good. Switch to 1/r² to compare.';
    }
    if (this.preset === 'shadows') {
      return 'The 4D sun leans towards ana. Shadows fall on the floor, which is 3D in 4D, and you see the part inside your slice. Objects outside it (the ghosts) cast shadows into it.';
    }
    if (this.preset === 'worldline') {
      return `A motion recorded with time as w, so moving the slice along w replays it. Rotating the slice in xw mixes time with space, so each x shows a different moment like a slit-scan photo. Record your own ${mode === 'desktop' ? 'mouse movements' : 'hands'} from the menu.`;
    }
    if (mode === 'controllers') return 'Trigger or grip to grab and throw. Hold both on an object and move the controller to turn it through 4D. Stick up/down moves the slice along w and left/right tilts it. Faint ghosts are objects just outside the slice.';
    if (mode === 'desktop') return 'Each object is shown as its 3D cross-section. Move the slice along w to see the cross-sections change.';
    return 'Pinch or grab to pick things up and throw them, and middle-finger pinch to turn one through 4D. In empty space, pinch and move up or down to move the slice along w, or middle-finger pinch to tilt it. The ring on the w rail moves it too.';
  }

  desktopHelp({ touch } = {}) {
    if (touch) return '<b>Drag</b> an object to move it · <b>Drag</b> empty space to orbit · The menu has sliders to move and rotate the slice.';
    return '<b>Drag</b> an object to move it · <b>Right-drag</b> an object to rotate it through 4D · <b>Wheel</b> or <b>Q/E</b> move the slice along w · <b>Right-drag</b> empty space or <b>A/D</b> rotate the slice · <b>Drag</b> empty space to orbit · <b>0</b> reset the slice · <b>R</b> restart the preset · <b>G</b> show or hide ghosts';
  }
}

// 0 wrist, 1 thumb, 2 index, 3 middle, 4 ring, 5 little finger (WebXR joint order, see input.js)
function fingerOf(j) {
  if (j === 0) return 0;
  if (j <= 4) return 1;
  return 2 + Math.floor((j - 5) / 5);
}
