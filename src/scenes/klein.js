// Klein Room: a flat universe that isn't orientable.
//
// The room is glued to itself. Walk out through the left or right side and you
// come back in through the other, as in a video game (a torus). Walk out
// through the front or back and you come back in through the other, mirrored:
// that pair of walls is glued with a flip, x → −x. The floor plan is a Klein
// bottle, and the space is a Klein bottle times the interval from floor to ceiling.
//
// Space is flat, so it's drawn as copies of the room, laid out by the gluing
// maps (every other row of copies is mirror-reversed). Copies of you are drawn
// in the other copies of the room. Crossing a flipped wall changes the map from
// room coordinates to the real room into a reflection: everything around you
// is now mirror-reversed, and your left hand fits the right-hand print.

import * as THREE from 'three';
import { SceneBase } from './base.js';
import { BONES } from '../core/handVisuals.js';
import { J } from '../core/input.js';

const W = 3.2, D = 3.2, H = 2.7; // room size (x, z) and height
const N = 2;                      // copies drawn on each side
const COPIES = (2 * N + 1) ** 2;

/** Gluing map for copy (i, j): (x, y, z) → ((−1)^j x + iW, y, z + jD). */
function copyMatrix(i, j) {
  const s = j % 2 === 0 ? 1 : -1;
  return new THREE.Matrix4().set(
    s, 0, 0, i * W,
    0, 1, 0, 0,
    0, 0, 1, j * D,
    0, 0, 0, 1,
  );
}

function mergeColored(parts) {
  const pos = [], nrm = [], col = [], index = [];
  for (const { geo, color, matrix } of parts) {
    if (matrix) geo.applyMatrix4(matrix);
    const c = new THREE.Color(color);
    const base = pos.length / 3;
    const gp = geo.attributes.position, gn = geo.attributes.normal;
    for (let i = 0; i < gp.count; i++) {
      pos.push(gp.getX(i), gp.getY(i), gp.getZ(i));
      nrm.push(gn.getX(i), gn.getY(i), gn.getZ(i));
      col.push(c.r, c.g, c.b);
    }
    if (geo.index) for (let i = 0; i < geo.index.count; i++) index.push(base + geo.index.getX(i));
    else for (let i = 0; i < gp.count; i++) index.push(base + i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(index);
  return g;
}

const at = (x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => new THREE.Matrix4().compose(
  new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));

/** Everything in the room that doesn't move, in room coordinates, merged into one mesh. */
function roomGeometry() {
  const parts = [];
  const add = (geo, color, matrix) => parts.push({ geo, color, matrix });
  // floor: checkerboard
  const tile = 0.4;
  for (let x = -W / 2; x < W / 2 - 1e-6; x += tile) for (let z = -D / 2; z < D / 2 - 1e-6; z += tile) {
    const dark = (Math.round((x + W) / tile) + Math.round((z + D) / tile)) % 2 === 0;
    add(new THREE.PlaneGeometry(tile, tile).rotateX(-Math.PI / 2), dark ? '#cfc6b8' : '#e8e1d5', at(x + tile / 2, 0, z + tile / 2));
  }
  // a large F on the floor: its mirror image is easy to recognise
  const f = '#3d5a80';
  add(new THREE.BoxGeometry(0.16, 0.006, 0.9), f, at(-0.3, 0.003, 0.35));
  add(new THREE.BoxGeometry(0.5, 0.006, 0.16), f, at(-0.13, 0.003, -0.02));
  add(new THREE.BoxGeometry(0.38, 0.006, 0.16), f, at(-0.19, 0.003, 0.3));
  // the edges of the room: cyan where the walls are glued straight across, pink where they're glued with a flip
  const edge = (color, x, z, sx, sz) => add(new THREE.BoxGeometry(sx, 0.012, sz), color, at(x, 0.006, z));
  edge('#33c3ff', -W / 2, 0, 0.04, D); edge('#33c3ff', W / 2, 0, 0.04, D);
  edge('#ff4f9a', 0, -D / 2, W, 0.04); edge('#ff4f9a', 0, D / 2, W, 0.04);
  // arrows by the pink edges all point along +x in the room, so across a pink edge (seen in the next,
  // mirrored copy) they point the other way: that's the flip
  for (const z of [-D / 2 + 0.12, D / 2 - 0.12]) {
    add(new THREE.BoxGeometry(0.4, 0.008, 0.035), '#ff4f9a', at(0.9, 0.004, z));
    add(new THREE.ConeGeometry(0.06, 0.12, 3).rotateZ(-Math.PI / 2), '#ff4f9a', at(1.16, 0.01, z, Math.PI / 2, 0, 0, 1, 1, 0.3));
  }
  // corner posts
  for (const x of [-W / 2, W / 2]) for (const z of [-D / 2, D / 2]) add(new THREE.CylinderGeometry(0.03, 0.03, H, 10), '#2b2f3a', at(x, H / 2, z));
  // a helix, which is chiral: this one twists to the right
  add(new THREE.CylinderGeometry(0.2, 0.24, 0.8, 24), '#d4cec6', at(0.9, 0.4, 0.8));
  const helix = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(Array.from({ length: 60 }, (_, k) => {
    const t = k / 59, a = t * Math.PI * 6;
    return new THREE.Vector3(Math.cos(a) * 0.14, 0.82 + t * 0.7, -Math.sin(a) * 0.14);
  })), 160, 0.025, 8, false);
  add(helix, '#e76f51', at(0.9, 0, 0.8));
  // pedestals for the clock and the hand print
  add(new THREE.CylinderGeometry(0.16, 0.2, 1.0, 24), '#d4cec6', at(-0.9, 0.5, -0.8));
  add(new THREE.CylinderGeometry(0.2, 0.24, 0.9, 24), '#d4cec6', at(0.2, 0.45, -1.0));
  // the clock's face, facing +z
  add(new THREE.CylinderGeometry(0.22, 0.22, 0.03, 40).rotateX(Math.PI / 2), '#f7f3ec', at(-0.9, 1.3, -0.8));
  add(new THREE.BoxGeometry(0.03, 0.3, 0.03), '#2b2f3a', at(-0.9, 1.08, -0.8));
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    add(new THREE.BoxGeometry(0.012, k % 3 === 0 ? 0.05 : 0.03, 0.01), '#2b2f3a', at(-0.9 + Math.sin(a) * 0.18, 1.3 + Math.cos(a) * 0.18, -0.78, 0, 0, -a));
  }
  return mergeColored(parts);
}

/** A right hand, drawn on a canvas (palm down, fingers towards −z, seen from above). */
function handPrintTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#2b2f3a';
  g.fillRect(0, 0, 512, 512);
  g.fillStyle = '#f7f3ec';
  g.font = '600 40px sans-serif';
  g.textAlign = 'center';
  g.fillText('RIGHT HAND', 256, 490);
  g.strokeStyle = '#ffd93d';
  g.lineWidth = 10;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  // palm and fingers; the thumb is on the left for a right hand seen from above with the palm down
  g.beginPath();
  g.ellipse(256, 300, 95, 110, 0, 0, Math.PI * 2);
  g.stroke();
  const fingers = [[-62, 190, 150, -0.12], [-20, 180, 175, -0.03], [22, 182, 165, 0.03], [62, 195, 135, 0.12]];
  for (const [dx, y, len, a] of fingers) {
    g.beginPath();
    g.moveTo(256 + dx, y + 20);
    g.lineTo(256 + dx + Math.sin(a) * len, y + 20 - Math.cos(a) * len);
    g.stroke();
  }
  g.beginPath(); // thumb, sticking out to the left
  g.moveTo(175, 330);
  g.lineTo(90, 260);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function signTexture() {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#f7f3ec';
  g.fillRect(0, 0, 1024, 256);
  g.fillStyle = '#2b2f3a';
  g.font = '700 110px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('KLEIN ROOM →', 512, 132);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/**
 * Instances that may be mirror images. three.js decides which side of a
 * triangle faces the camera per object, not per instance, so mirrored
 * instances go into a second mesh that is itself mirrored (scale x = −1).
 */
class MirrorableInstances {
  constructor(parent, geo, mat, count) {
    this.meshes = [0, 1].map((k) => {
      const m = new THREE.InstancedMesh(geo, mat, count);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      if (k === 1) m.scale.x = -1;
      parent.add(m);
      return m;
    });
    this.n = [0, 0];
  }

  begin() { this.n[0] = 0; this.n[1] = 0; }

  push(matrix) {
    if (matrix.determinant() >= 0) this.meshes[0].setMatrixAt(this.n[0]++, matrix);
    else this.meshes[1].setMatrixAt(this.n[1]++, _fm.multiplyMatrices(FLIP_X, matrix)); // the mesh's own flip undoes this one
  }

  end() {
    this.meshes.forEach((m, k) => {
      m.count = this.n[k];
      m.visible = this.n[k] > 0;
      m.instanceMatrix.needsUpdate = true;
    });
  }
}

const FLIP_X = new THREE.Matrix4().makeScale(-1, 1, 1);
const _fm = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _headM = new THREE.Matrix4();
const _bodyM = new THREE.Matrix4();
const _bodyQ = new THREE.Quaternion();
const HEAD_SHAPE = at(0, 0.02, 0.07, 0, 0, 0, 0.08, 0.105, 0.1);
const VISOR_SHAPE = at(0, 0, -0.035);
const MAX_PARTS = 25 + BONES.length;
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _up = new THREE.Vector3(0, 1, 0);

export class KleinScene extends SceneBase {
  constructor(app) {
    super(app);
    this.key = 'klein';
    this.title = 'Klein Room';
    this.short = 'Klein';
    this.subtitle = 'A room glued to itself with a flip';
    this.mood = 'klein';
    this.noOrbit = true;
    this.showSelf = true;

    this.copies = [];
    for (let i = -N; i <= N; i++) for (let j = -N; j <= N; j++) this.copies.push({ i, j, C: copyMatrix(i, j) });
    this.M = new THREE.Matrix4();    // room → real world
    this.Minv = new THREE.Matrix4();
    this.crossings = 0;

    const inst = (geo, mat, count) => new MirrorableInstances(this.root, geo, mat, count);
    this.room = inst(roomGeometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }), COPIES);
    this.sign = inst(new THREE.PlaneGeometry(1.2, 0.3), new THREE.MeshBasicMaterial({ map: signTexture(), toneMapped: false }), COPIES);
    this.signPose = at(-0.2, 1.9, -D / 2 + 0.05);
    this.plateMat = new THREE.MeshBasicMaterial({ map: handPrintTexture(), toneMapped: false });
    this.plate = inst(new THREE.PlaneGeometry(0.34, 0.34).rotateX(-Math.PI / 2), this.plateMat, COPIES);
    this.platePos = new THREE.Vector3(0.2, 0.905, -1.0);
    this.platePose = at(this.platePos.x, this.platePos.y, this.platePos.z);
    this.minuteHand = inst(new THREE.BoxGeometry(0.018, 0.16, 0.008).translate(0, 0.07, 0), new THREE.MeshStandardMaterial({ color: '#2b2f3a', roughness: 0.4 }), COPIES);
    this.secondHand = inst(new THREE.BoxGeometry(0.008, 0.19, 0.006).translate(0, 0.08, 0), new THREE.MeshStandardMaterial({ color: '#e63946' }), COPIES);

    // copies of you: head, headset, body and hands
    const skin = new THREE.MeshStandardMaterial({ color: '#f0cdb0', roughness: 0.6 });
    this.head = inst(new THREE.SphereGeometry(1, 24, 16), skin, COPIES);
    this.visor = inst(new THREE.BoxGeometry(0.19, 0.1, 0.09), new THREE.MeshStandardMaterial({ color: '#d6d9e0', roughness: 0.4 }), COPIES);
    this.torso = inst(new THREE.CapsuleGeometry(0.15, 0.45, 8, 20), new THREE.MeshStandardMaterial({ color: '#5b6fc4', roughness: 0.7 }), COPIES);
    this.joints = inst(new THREE.SphereGeometry(1, 10, 8), skin, COPIES * 50);
    this.bones = inst(new THREE.CylinderGeometry(1, 1, 1, 8).translate(0, 0.5, 0), skin, COPIES * BONES.length * 2);
    this.desktopView = { position: new THREE.Vector3(0, 1.6, 0.6), target: new THREE.Vector3(0, 1.4, -1) };
    this.yaw = 0;
    this.pitch = 0;
    this.keys = new Set();
    this._onKeyDown = (e) => { if (!e.ctrlKey && !e.metaKey && !e.altKey) this.keys.add(e.key.toLowerCase()); };
    this._onKeyUp = (e) => this.keys.delete(e.key.toLowerCase());
    this._onBlur = () => this.keys.clear();
    this._onPointerMove = (e) => {
      if (this.app.presenting || !(e.buttons & 1) || !this.app.pointerOnEmpty) return;
      this.yaw -= e.movementX * 0.004;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.004, -1.4, 1.4);
    };
    this._placeRoom();
  }

  get mirrored() { return this.M.determinant() < 0; }

  reset() {
    this.M.identity();
    this.crossings = 0;
    this._placeRoom();
  }

  /** Room copies and fixed objects, after M changes. */
  _placeRoom() {
    this.Minv.copy(this.M).invert();
    const fixed = [this.room, this.sign, this.plate];
    for (const m of fixed) m.begin();
    for (const c of this.copies) {
      _m.multiplyMatrices(this.M, c.C);
      c.world = (c.world || new THREE.Matrix4()).copy(_m);
      this.room.push(_m);
      this.sign.push(_m2.multiplyMatrices(_m, this.signPose));
      this.plate.push(_m2.multiplyMatrices(_m, this.platePose));
    }
    for (const m of fixed) m.end();
  }

  enter() {
    super.enter();
    this.app.scene.fog = new THREE.Fog('#2a2f40', 5, 12); // the copies stop 8 m away
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    this.app.renderer.domElement.addEventListener('pointermove', this._onPointerMove);
    if (!this.app.presenting) { this.yaw = 0; this.pitch = 0; }
  }

  exit() {
    super.exit();
    this.app.scene.fog = null;
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    this.keys.clear();
    this.app.renderer.domElement.removeEventListener('pointermove', this._onPointerMove);
  }

  /** Move the room by a real-world displacement (the viewer moves the opposite way). */
  _moveRoom(dx, dz) {
    _m.makeTranslation(dx, 0, dz);
    this.M.premultiply(_m);
    this._placeRoom();
  }

  onEmptyGrabStart(ix) {
    this.pull = { last: ix.grabPos.clone() };
    return true;
  }

  onEmptyGrabUpdate(ix) {
    if (!this.pull) return;
    const d = _v.copy(ix.grabPos).sub(this.pull.last);
    this.pull.last.copy(ix.grabPos);
    const gain = ix.isMouse ? 2.5 : 3.0;
    this._moveRoom(d.x * gain, d.z * gain); // pulling the room towards you moves you forwards
  }

  onEmptyGrabEnd() { this.pull = null; }

  /** Keep the head inside the central copy: crossing a wall re-glues the room around you. */
  _wrap() {
    const p = _v.copy(this.app.headPosition).applyMatrix4(this.Minv);
    let g = null;
    if (p.x > W / 2) g = copyMatrix(1, 0);
    else if (p.x < -W / 2) g = copyMatrix(-1, 0);
    else if (p.z > D / 2) g = copyMatrix(0, 1);
    else if (p.z < -D / 2) g = copyMatrix(0, -1);
    if (!g) return;
    // the head is now in copy g of the room: re-label so it's in the central one
    this.M.multiply(g);
    this.crossings++;
    this._placeRoom();
    this.app.audio._tone({ freq: this.mirrored ? 440 : 660, type: 'triangle', dur: 0.2, gain: 0.07 });
  }

  update(dt, time) {
    const app = this.app;
    if (!app.presenting) {
      app.camera.position.copy(this.desktopView.position);
      app.camera.quaternion.setFromEuler(_e.set(this.pitch, this.yaw, 0, 'YXZ'));
      app.camera.updateMatrixWorld();
      app.camera.getWorldPosition(app.headPosition);
      app.camera.getWorldQuaternion(app.headQuaternion);
      const f = (this.keys.has('w') ? 1 : 0) - (this.keys.has('s') ? 1 : 0), s = (this.keys.has('d') ? 1 : 0) - (this.keys.has('a') ? 1 : 0);
      if (f || s) {
        const sp = (this.keys.has('shift') ? 3.0 : 1.4) * dt;
        const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
        this._moveRoom(-(fx * f + Math.cos(this.yaw) * s) * sp, -(fz * f - Math.sin(this.yaw) * s) * sp);
      }
    }
    for (const ix of app.input.xr) {
      if (ix.kind !== 'controller' || (!ix.stick.x && !ix.stick.y)) continue;
      _v2.set(ix.stick.x, 0, ix.stick.y).applyQuaternion(ix.rayQuat).setY(0).multiplyScalar(-dt * 1.2);
      this._moveRoom(_v2.x, _v2.z);
    }
    this._wrap();

    // clock hands, turning clockwise in the room's own frame
    const secA = -(time % 60) / 60 * Math.PI * 2, minA = -(time % 3600) / 3600 * Math.PI * 2;
    this.minuteHand.begin();
    this.secondHand.begin();
    for (const c of this.copies) {
      this.minuteHand.push(_m2.multiplyMatrices(c.world, _m.makeRotationZ(minA).setPosition(-0.9, 1.3, -0.765)));
      this.secondHand.push(_m2.multiplyMatrices(c.world, _m.makeRotationZ(secA).setPosition(-0.9, 1.3, -0.76)));
    }
    this.minuteHand.end();
    this.secondHand.end();

    this._updateSelf();
    this._updatePlate();
  }

  /** Copies of you in the other copies of the room. */
  _updateSelf() {
    const app = this.app;
    const parts = [this.head, this.visor, this.torso, this.joints, this.bones];
    for (const m of parts) m.begin();
    if (this.showSelf) {
      _headM.compose(app.headPosition, app.headQuaternion, _s.set(1, 1, 1));
      const fwd = _v.set(0, 0, -1).applyQuaternion(app.headQuaternion).setY(0).normalize();
      _bodyQ.setFromAxisAngle(_up, Math.atan2(-fwd.x, -fwd.z));
      _v2.copy(app.headPosition).addScaledVector(fwd, -0.08);
      _v2.y -= 0.52;
      _bodyM.compose(_v2, _bodyQ, _s.set(1.1, 1, 0.75));
      // the hands' joints and bones in the real world, computed once
      const hand = this._handParts || (this._handParts = Array.from({ length: 2 * MAX_PARTS }, () => new THREE.Matrix4()));
      let np = 0, nJoints = 0;
      if (app.presenting) {
        for (const ix of app.input.xr) {
          if (ix.kind !== 'hand' || !ix.jointsValid) continue;
          for (let j = 0; j < 25; j++) {
            const r = Math.max(0.005, ix.joints[j].radius * 0.9);
            hand[np++].compose(ix.joints[j].pos, _q.identity(), _s.set(r, r, r));
          }
          nJoints += 25;
        }
        for (const ix of app.input.xr) {
          if (ix.kind !== 'hand' || !ix.jointsValid) continue;
          for (const [a, b] of BONES) {
            const pa = ix.joints[a].pos;
            _v.subVectors(ix.joints[b].pos, pa);
            const len = _v.length();
            const r = Math.max(0.004, Math.min(ix.joints[a].radius, ix.joints[b].radius) * 0.6);
            _q.setFromUnitVectors(_up, _v.divideScalar(len || 1));
            hand[np++].compose(pa, _q, _s.set(r, len, r));
          }
        }
      }
      for (const c of this.copies) {
        if (c.i === 0 && c.j === 0) continue; // that one is you
        // real world → room → this copy → real world
        _m.multiplyMatrices(c.world, this.Minv);
        this.head.push(_m2.multiplyMatrices(_m, _headM).multiply(HEAD_SHAPE));
        this.visor.push(_m2.multiplyMatrices(_m, _headM).multiply(VISOR_SHAPE));
        this.torso.push(_m2.multiplyMatrices(_m, _bodyM));
        for (let p = 0; p < np; p++) (p < nJoints ? this.joints : this.bones).push(_m2.multiplyMatrices(_m, hand[p]));
      }
    }
    for (const m of parts) m.end();
  }

  /** Which hand fits the print right now: with the room mirrored around you, it's your left. */
  _updatePlate() {
    let fits = null;
    if (this.app.presenting) {
      for (const ix of this.app.input.xr) {
        if (ix.kind !== 'hand' || !ix.jointsValid) continue;
        const palm = _v.copy(ix.joints[J.wrist].pos).lerp(ix.joints[J['middle-finger-phalanx-proximal']].pos, 0.6).applyMatrix4(this.Minv);
        if (palm.distanceTo(this.platePos) > 0.12) continue;
        // in room coordinates a hand is right-handed if it's a right hand and the room isn't mirrored around you
        const right = (ix.handedness === 'right') !== this.mirrored;
        fits = right;
      }
    }
    this.plateMat.color.set(fits === null ? '#ffffff' : fits ? '#8dff9a' : '#ff8d8d');
    this.fits = fits;
  }

  menuRows() {
    return [
      { type: 'buttons', items: [{ label: 'Back to the start', onClick: () => this.reset() }] },
      { type: 'toggles', items: [{ label: 'Show copies of yourself', get: () => this.showSelf, set: (v) => { this.showSelf = v; } }] },
      {
        type: 'text', lines: 2, color: '#dfe2ff',
        text: () => `Walls crossed: ${this.crossings}. You are ${this.mirrored ? 'mirror-reversed: your left hand fits the right-hand print' : 'the right way round'}.`,
      },
    ];
  }

  hint(mode) {
    const move = { hands: 'Walk, or pinch empty space and pull', controllers: 'Walk, or use the stick', desktop: 'Use WASD' }[mode];
    return `${move} to move. The cyan walls are glued straight across. The pink walls are glued with a flip, so crossing one leaves you mirror-reversed: text reads backwards and your left hand fits the right-hand print.`;
  }

  desktopHelp({ touch } = {}) {
    if (touch) return '<b>Drag</b> to look around · moving needs a keyboard or a headset';
    return '<b>WASD</b> move (<b>Shift</b> faster) · <b>drag</b> to look · <b>right-drag</b> to pull · <b>M</b> menu';
  }
}
