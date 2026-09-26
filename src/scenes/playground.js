// Hyperplay: 4D physics sandbox on a table, shown as a 3D cross-section.

import * as THREE from 'three';
import * as V from '../math/vec4.js';
import * as R4 from '../math/rot4.js';
import { SceneBase, Burst, makeLabel, disposeLabel } from './base.js';
import { Object4D } from '../four/object4d.js';
import { SliceView } from '../four/sliceView.js';
import { World4, Body4 } from '../physics/world4.js';
import { WRail } from './wrail.js';

const TABLE_R = 0.6;
const W_RANGE = 0.55;
const W_GRADIENT = ['#33c3ff', '#ff4f9a']; // kata (−w) → ana (+w)
const MAX_TOYS = 32; // collision is O(n²); spawning past this recycles the oldest toy

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
const EW = [0, 0, 0, 1];

let seed = 7;
const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const randRot = () => R4.randomRotation(R4.mat4(), rand);

/** A 4D object in the playground: render object, rigid body and grab handling. */
class Toy {
  constructor(pg, key, { scale = 0.1, scale4 = null, pos = [0, 0.2, 0, 0], rot = null, mass = null, fixed = false, opacity = 1, tint = null, tintAmount = 0.6, restitution = 0.3, friction = 0.55, tagColor = null } = {}) {
    this.pg = pg;
    this.obj = new Object4D(key, { scale, scale4, position: pos, rotation: rot, opacity, tint, tintAmount });
    pg.stage.add(this.obj.group);
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

  sync(dt) {
    V.copy(this.obj.pos, this.body.x);
    R4.copy(this.obj.R, this.body.R);
    this.obj.sync(this.pg.view, dt);
  }

  dispose() {
    this.obj.dispose();
    this.pg.world.remove(this.body);
  }

  // --- interactable ---------------------------------------------------------

  _sliceToBody(p3, out) {
    _p4[0] = p3.x; _p4[1] = p3.y; _p4[2] = p3.z; _p4[3] = 0;
    this.pg.view.toWorld(_q4, _p4);
    V.sub(_q4, _q4, this.body.x);
    return R4.applyT(out, this.body.R, _q4);
  }

  nearDistance(p) {
    if (!this.obj.inSlice) return Infinity;
    const local = this.pg.stage.worldToLocal(_v3.copy(p));
    if (local.distanceTo(_hp.set(this.obj.slicePos[0], this.obj.slicePos[1], this.obj.slicePos[2])) > this.obj.sliceRadius + 0.05) return Infinity;
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

  onHover(ix, on) { this.obj.setHighlight(on ? 0.6 : (this.grabbedBy ? 1 : 0)); }

  onGrabStart(ix, mode, kind) {
    const view = this.pg.view;
    this.grabbedBy = ix;
    this.mode = mode;
    this.kind = kind;
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

  onGrabUpdate(ix) {
    const view = this.pg.view;
    ix.pose(this.kind, _hp, _hq);
    const hand = this.pg.stage.worldToLocal(_hp.clone());
    const dq = _q.copy(_hq).multiply(this.startHandQInv); // world rotation since grab
    R4.fromQuaternion(_E, dq);
    R4.multiply(_M, _E, this.startSliceRot);
    const sp = this.startSlicePos;
    const pos = [sp[0], sp[1], sp[2], sp[3]];

    if (this.mode === 'secondary') {
      // 4D trackball: pushing the hand along d rolls the object in the (d, w) plane
      const d = hand.clone().sub(this.startHand);
      const len = d.length();
      if (len > 1e-4) {
        const k = 1 / Math.max(0.05, this.obj.radius * 0.9);
        const dir = [d.x / len, d.y / len, d.z / len, 0];
        R4.rotationInPlane(_M2, EW, dir, len * k);
        R4.multiply(_M, _M2, _M);
      }
    } else {
      // carry: rigidly follow the hand in xyz, keep the same offset in w
      _v3.set(sp[0], sp[1], sp[2]).sub(this.startHand).applyQuaternion(dq).add(hand);
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
      _q4[3] -= view.w; // toWorld adds the slice offset; velocities are directions
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
  };
  return map[key] || '#ffffff';
}

export class PlaygroundScene extends SceneBase {
  constructor(app) {
    super(app);
    this.key = 'playground';
    this.title = 'Hyperplay';
    this.short = 'Hyperplay';
    this.subtitle = '4D physics sandbox';
    this.mood = 'studio';
    this.shadows = true;
    this.tableY = 0.86;
    this.tableZ = -0.72;
    this._shadowsDirty = true;

    this.view = new SliceView();
    this.view.wMin = -W_RANGE;
    this.view.wMax = W_RANGE;
    this.world = new World4({ floorY: 0, wallRadius: TABLE_R - 0.012, wRange: W_RANGE + 0.02 });
    this.world.onImpact = (p, speed, a, b) => this._impact(p, speed, a, b);
    this.toys = [];
    this.ghosts = true;
    this.slowmo = false;
    this.lowGravity = false;
    this.preset = 'sandbox';

    this.stage = new THREE.Group(); // the 4D slice lives here (origin = table centre)
    this.root.add(this.stage);
    this._buildTable();
    this.rail = new WRail(this, new THREE.Vector3(-0.52, 0, 0.36));
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
    this._shadowsDirty = true;
    this.stage.position.set(0, this.tableY, this.tableZ);
    this.table.position.set(0, this.tableY, this.tableZ);
    this.app.env.setShadowFocus(new THREE.Vector3(0, this.tableY, this.tableZ), 0.75);
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
    const topMat = new THREE.MeshStandardMaterial({ color: '#ffffff', map: tex, roughness: 0.82, metalness: 0 });
    const top = new THREE.Mesh(new THREE.CylinderGeometry(TABLE_R + 0.03, TABLE_R + 0.03, 0.032, 96), [
      new THREE.MeshStandardMaterial({ color: '#e7e2da', roughness: 0.7 }), topMat, topMat,
    ]);
    top.position.y = -0.016;
    top.receiveShadow = true;
    t.add(top);
    const rim = new THREE.Mesh(
      new THREE.TorusGeometry(TABLE_R, 0.006, 10, 128).rotateX(Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: '#2b2f3a', emissive: '#eceef4', emissiveIntensity: 0.35, roughness: 0.4 }),
    );
    rim.position.y = 0.004;
    t.add(rim);
    const legMat = new THREE.MeshStandardMaterial({ color: '#d4cec6', roughness: 0.6 });
    this.leg = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.16, 1, 32), legMat);
    this.leg.castShadow = false;
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

  onUserReady() {
    // fit the table to the person: roughly waist height
    const headY = this.app.headPosition.y;
    this.tableY = THREE.MathUtils.clamp(headY - 0.62, 0.7, 1.05);
    this._placeStage();
    this._layoutLeg();
  }

  enter() {
    super.enter();
    this._placeStage();
  }

  // ---------------------------------------------------------------------------

  setW(w) {
    const before = this.view.w;
    this.view.setW(w);
    this._wSpeed = Math.abs(this.view.w - before);
  }

  _removeToy(t) {
    this.app.interaction.forget(t);
    t.dispose();
    this._shadowsDirty = true;
  }

  /** Called by the app before rendering: the shadow map only needs redrawing when a toy moved. */
  shadowsChanged() {
    const dirty = this._shadowsDirty;
    this._shadowsDirty = false;
    return dirty;
  }

  clear() {
    for (const t of this.toys) this._removeToy(t);
    this.toys = [];
    this.interactables = [this.rail];
    this.boxGoal = null;
  }

  add(key, opts) {
    const t = new Toy(this, key, opts);
    this.toys.push(t);
    this._shadowsDirty = true;
    if (!t.fixed) this.interactables.push(t);
    t.sync(0);
    return t;
  }

  spawn(key) {
    const dynamic = this.toys.filter((t) => !t.fixed);
    if (dynamic.length >= MAX_TOYS) {
      const old = dynamic.find((t) => !t.grabbedBy);
      if (old) {
        this._removeToy(old);
        this.toys = this.toys.filter((t) => t !== old);
        this.interactables = this.interactables.filter((t) => t !== old);
      }
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
    this.preset = name;
    this.clear();
    this.view.setW(0);
    this.view.setAngles(0, 0);
    seed = 11;
    const P = (x, y, z, w) => [x, y, z, w];
    if (name === 'sandbox') {
      // most objects near w = 0, a few further along w so they show as ghosts
      this.add('tesseract', { scale: 0.14, pos: P(-0.2, 0.08, -0.08, 0.0), rot: randRot() });
      this.add('hypersphere', { scale: 0.075, pos: P(0.14, 0.1, 0.12, 0.02) });
      this.add('hypersphere', { scale: 0.05, pos: P(0.3, 0.1, -0.1, -0.03) });
      this.add('icositetrachoron', { scale: 0.1, pos: P(0.05, 0.12, -0.28, 0.01), rot: randRot() });
      this.add('simplex', { scale: 0.12, pos: P(-0.32, 0.12, 0.2, 0.02), rot: randRot() });
      this.add('duocylinder', { scale: 0.09, pos: P(-0.02, 0.1, 0.26, -0.02), rot: randRot() });
      this.add('tiger', { scale: 0.09, pos: P(0.32, 0.12, 0.3, 0.0), rot: randRot() });
      this.add('orthoplex', { scale: 0.1, pos: P(0.3, 0.1, -0.35, 0.2), rot: randRot() });
      this.add('spherinder', { scale: 0.08, pos: P(-0.3, 0.1, -0.3, 0.26), rot: randRot() });
      this.add('tesseract', { scale: 0.09, pos: P(0.05, 0.1, 0.02, -0.32), rot: randRot() });
      this.add('hypersphere', { scale: 0.065, pos: P(-0.1, 0.1, 0.1, 0.38) });
    } else if (name === 'box') {
      // Closed box. The walls only extend ±6 cm in w, so the ball can be
      // moved around them in w.
      const ww = 0.06, s = 0.13, th = 0.012, hgt = 0.16;
      const glass = { fixed: true, opacity: 0.28, tint: '#bfe6ff', tintAmount: 0.85, restitution: 0.2 };
      this.add('tesseract', { ...glass, scale4: [2 * s, th, 2 * s, 2 * ww], pos: P(0, hgt + th / 2, 0, 0) }); // lid
      this.add('tesseract', { ...glass, scale4: [th, hgt, 2 * s, 2 * ww], pos: P(s, hgt / 2, 0, 0) });
      this.add('tesseract', { ...glass, scale4: [th, hgt, 2 * s, 2 * ww], pos: P(-s, hgt / 2, 0, 0) });
      this.add('tesseract', { ...glass, scale4: [2 * s, hgt, th, 2 * ww], pos: P(0, hgt / 2, s, 0) });
      this.add('tesseract', { ...glass, scale4: [2 * s, hgt, th, 2 * ww], pos: P(0, hgt / 2, -s, 0) });
      this.ball = this.add('hypersphere', { scale: 0.045, pos: P(0, 0.05, 0, 0), restitution: 0.2 });
      this.boxGoal = { s, done: false };
      this._say('Get the ball out of the box', 5);
    } else if (name === 'tower') {
      const s = 0.1; // tesseract edge length
      for (let lvl = 0; lvl < 4; lvl++) {
        for (let i = 0; i < 2; i++) {
          this.add('tesseract', { scale: s, pos: P((i - 0.5) * s * 1.02 + (lvl % 2 ? 0.02 : 0), s * 0.5 + lvl * s * 1.001, 0, (lvl % 2 ? 1 : -1) * 0.01) });
        }
      }
      this.add('icositetrachoron', { scale: 0.07, pos: P(0, s * 4 + 0.07, 0, 0) });
      this.add('hypersphere', { scale: 0.06, pos: P(0.2, 0.08, 0.28, 0) });
      this.add('hypersphere', { scale: 0.06, pos: P(-0.2, 0.08, 0.28, 0) });
      this._say('Tesseract tower', 3);
    } else if (name === 'balls') {
      for (let i = 0; i < 14; i++) {
        const r = 0.035 + rand() * 0.05;
        this.add('hypersphere', { scale: r, pos: P((rand() - 0.5) * 0.7, 0.25 + i * 0.07, (rand() - 0.5) * 0.7, (rand() - 0.5) * 0.9), restitution: 0.55 });
      }
      this._say('Hyperspheres at different w positions', 3);
    } else if (name === 'rollers') {
      const keys = ['duocylinder', 'spherinder', 'cubinder', 'tiger', 'spheritorus', 'torisphere', 'duocylinder'];
      keys.forEach((k, i) => {
        const a = (i / keys.length) * Math.PI * 2;
        const t = this.add(k, { scale: 0.085, pos: P(Math.cos(a) * 0.3, 0.12, Math.sin(a) * 0.3, (rand() - 0.5) * 0.3), rot: randRot() });
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
        this.add(k, { scale: k === 'tesseract' ? 0.15 : 0.11, pos: P(Math.cos(a) * 0.32, 0.14, Math.sin(a) * 0.32, 0), rot: randRot() });
      });
      this._say('Regular 4-polytopes', 3);
    }
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
    // physics coordinates are 4D world coordinates; place the sound in the slice
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
    this._air = { start: ix.grabPos.clone(), w: this.view.w, xw: this.view.angleXW, zw: this.view.angleZW, mode };
    return true;
  }

  onEmptyGrabUpdate(ix, mode) {
    const a = this._air;
    if (!a) return;
    const d = ix.grabPos.clone().sub(a.start);
    if (mode === 'primary') {
      const gain = ix.isMouse ? 1.0 : 1.6;
      this.setW(a.w + d.y * gain);
    } else {
      const k = ix.isMouse ? 2.5 : 4.0;
      const xw = THREE.MathUtils.clamp(a.xw + d.x * k, -Math.PI / 2, Math.PI / 2);
      const zw = THREE.MathUtils.clamp(a.zw - d.z * k, -Math.PI / 2, Math.PI / 2);
      this.view.setAngles(xw, zw);
    }
  }

  onEmptyGrabEnd() { this._air = null; }

  onWheel(delta) {
    this.setW(this.view.w - delta * 0.0006);
  }

  onKey(e) {
    const k = e.key.toLowerCase();
    if (k === 'q' || e.key === 'ArrowDown') this.setW(this.view.w - 0.02);
    if (k === 'e' || e.key === 'ArrowUp') this.setW(this.view.w + 0.02);
    if (k === 'a' || e.key === 'ArrowLeft') this.view.setAngles(this.view.angleXW - 0.05, this.view.angleZW);
    if (k === 'd' || e.key === 'ArrowRight') this.view.setAngles(this.view.angleXW + 0.05, this.view.angleZW);
    if (k === 'r') this.loadPreset(this.preset);
    if (k === 'g') this.ghosts = !this.ghosts;
    if (k === '0') { this.view.setW(0); this.view.setAngles(0, 0); }
  }

  // ---------------------------------------------------------------------------

  update(dt, time) {
    // controllers: thumbstick moves the slice along W and rotates it
    for (const ix of this.app.input.xr) {
      if (ix.kind !== 'controller') continue;
      if (Math.abs(ix.stick.y) > 0) this.setW(this.view.w - ix.stick.y * dt * 0.45);
      if (Math.abs(ix.stick.x) > 0 && !ix.grabbed) {
        this.view.setAngles(THREE.MathUtils.clamp(this.view.angleXW + ix.stick.x * dt * 1.0, -Math.PI / 2, Math.PI / 2), this.view.angleZW);
      }
    }

    this.world.gravity[1] = this.lowGravity ? -2.2 : -9.81;
    this.world.step(this.slowmo ? dt * 0.25 : dt);

    for (const t of this.toys) {
      t.obj.ghostsEnabled = this.ghosts && !t.fixed;
      t.sync(dt);
      if (t.obj.poseChanged) { this._shadowsDirty = true; t.obj.poseChanged = false; }
      // fell off the table: move it back into the slice
      if (t.body.x[1] < -1.5) {
        const s = [0, 0.3, 0, 0];
        V.copy(t.body.x, this.view.toWorld([0, 0, 0, 0], s));
        V.set(t.body.v, 0, 0, 0, 0);
      }
    }
    this.rail.update(this.toys);
    this.burst.update(dt);

    // W-scrub tone
    const w01 = (this.view.w - this.view.wMin) / (this.view.wMax - this.view.wMin);
    this.app.audio.scrub(w01, (this._wSpeed || 0) / Math.max(dt, 1e-3));
    this._wSpeed = 0;

    // sealed-box puzzle
    if (this.boxGoal && !this.boxGoal.done && this.ball) {
      const x = this.ball.body.x;
      const s = this.boxGoal.s;
      if ((Math.abs(x[0]) > s + 0.03 || Math.abs(x[2]) > s + 0.03) && Math.abs(x[3]) < 0.05 && !this.ball.grabbedBy) {
        this.boxGoal.done = true;
        const p = this.view.toSlice([0, 0, 0, 0], x);
        this.burst.fire(new THREE.Vector3(p[0], p[1], p[2]));
        this.app.audio.spawn(this.stage.localToWorld(new THREE.Vector3(p[0], p[1], p[2])));
        this._say('Solved', 4);
      }
    }

    if (this.messageT > 0) {
      this.messageT -= dt;
      this.message.visible = true;
      const head = this.stage.worldToLocal(this.app.headPosition.clone());
      this.message.lookAt(this.stage.localToWorld(head.setY(this.message.position.y)));
      this.message.material.opacity = Math.min(1, this.messageT * 2);
    } else this.message.visible = false;
  }

  menuRows() {
    const fmtW = (v) => (Math.abs(v) < 0.005 ? '0' : `${v > 0 ? 'ana' : 'kata'} ${Math.abs(v * 100).toFixed(0)} cm`);
    return [
      {
        type: 'buttons', columns: 3,
        items: [
          { label: 'Sandbox', onClick: () => this.loadPreset('sandbox'), active: () => this.preset === 'sandbox' },
          { label: 'Sealed box', onClick: () => this.loadPreset('box'), active: () => this.preset === 'box' },
          { label: 'Tower', onClick: () => this.loadPreset('tower'), active: () => this.preset === 'tower' },
          { label: 'Hyperballs', onClick: () => this.loadPreset('balls'), active: () => this.preset === 'balls' },
          { label: 'Rollers', onClick: () => this.loadPreset('rollers'), active: () => this.preset === 'rollers' },
          { label: 'Polytopes', onClick: () => this.loadPreset('polytopes'), active: () => this.preset === 'polytopes' },
        ],
      },
      { type: 'slider', label: 'Slice position (w)', min: this.view.wMin, max: this.view.wMax, center: 0, get: () => this.view.w, set: (v) => this.setW(v), format: fmtW, gradient: W_GRADIENT },
      {
        type: 'slider', label: 'Slice rotation (xw)', min: -Math.PI / 2, max: Math.PI / 2, center: 0,
        get: () => this.view.angleXW, set: (v) => this.view.setAngles(v, this.view.angleZW), format: (v) => `${Math.round((v * 180) / Math.PI)}°`,
      },
      {
        type: 'buttons', columns: 4,
        items: [
          { label: '+ Tesseract', small: true, onClick: () => this.spawn('tesseract') },
          { label: '+ Sphere', small: true, onClick: () => this.spawn('hypersphere') },
          { label: '+ 24-cell', small: true, onClick: () => this.spawn('icositetrachoron') },
          { label: '+ Duocyl.', small: true, onClick: () => this.spawn('duocylinder') },
        ],
      },
      {
        type: 'toggles', columns: 3,
        items: [
          { label: 'Ghosts', get: () => this.ghosts, set: (v) => { this.ghosts = v; } },
          { label: 'Slow-mo', get: () => this.slowmo, set: (v) => { this.slowmo = v; } },
          { label: 'Low gravity', get: () => this.lowGravity, set: (v) => { this.lowGravity = v; } },
        ],
      },
    ];
  }

  hint(mode) {
    if (this.preset === 'box') {
      const move = { hands: 'with your other hand', controllers: 'with the stick', desktop: 'with the scroll wheel' }[mode];
      return `The box walls only extend a short distance in w. Hold the ball, move the slice along w ${move} until the walls are gone, move the ball out, then move the slice back.`;
    }
    if (mode === 'controllers') return 'Trigger to grab and throw. Grip an object and move the controller to rotate it through 4D. Stick up/down moves the slice along w, left/right rotates it.';
    if (mode === 'desktop') return 'Each object is shown as its 3D cross-section. Move the slice along w to see the cross-sections change.';
    return 'Pinch to grab and throw. Middle-finger pinch an object and move your hand to rotate it through 4D. Pinch empty space and move up/down to move the slice along w. Middle-finger pinch empty space to rotate the slice.';
  }

  desktopHelp({ touch } = {}) {
    if (touch) return '<b>Drag</b> an object to move it · <b>Drag</b> empty space to orbit · <b>Menu</b>: move and rotate the slice';
    return '<b>Drag</b> an object to move it · <b>Right-drag</b> an object to rotate it through 4D · <b>Wheel</b> or <b>Q/E</b>: move the slice along w · <b>Right-drag</b> empty space or <b>A/D</b>: rotate the slice · <b>R</b> reset · <b>G</b> ghosts · <b>M</b> menu · drag empty space to orbit';
  }
}
