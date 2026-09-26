// Input from tracked hands, controllers and the mouse. Each one is wrapped in
// an Interactor with the same fields:
//
//   pinch            primary action   (thumb+index pinch  | trigger | left mouse)
//   grip             secondary action (thumb+middle pinch | squeeze | right mouse)
//   grabPos/grabQuat where grabbed objects are held
//   rayOrigin/rayDir pointer ray for distant objects and UI
//   pokePos          index fingertip (or controller tip) for pressing UI

import * as THREE from 'three';
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js';

export const JOINT_NAMES = [
  'wrist',
  'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip',
  'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip',
  'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip',
  'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip',
  'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip',
];
export const J = Object.fromEntries(JOINT_NAMES.map((n, i) => [n, i]));

class Button {
  constructor() { this.pressed = false; this.down = false; this.up = false; this.value = 0; }
  set(pressed, value = pressed ? 1 : 0) {
    this.down = pressed && !this.pressed;
    this.up = !pressed && this.pressed;
    this.pressed = pressed;
    this.value = value;
  }
  reset() { this.set(false, 0); }
}

const HIST = 10;
// Hand tracking often drops out for a few frames (hands overlapping, fast
// motion). Keep the pinch state through short gaps so held objects aren't dropped.
const TRACKING_GRACE = 0.2;
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class Interactor {
  constructor(index) {
    this.index = index;
    this.kind = 'none'; // 'hand' | 'controller' | 'mouse' | 'none'
    this.handedness = 'none';
    this.source = null;
    this.active = false;

    this.pinch = new Button();
    this.grip = new Button();
    this.btnA = new Button();
    this.btnB = new Button();
    this.stick = new THREE.Vector2();
    this.pinchStrength = 0;

    this.grabPos = new THREE.Vector3();
    this.grabQuat = new THREE.Quaternion();
    this.rayOrigin = new THREE.Vector3();
    this.rayDir = new THREE.Vector3(0, 0, -1);
    this.rayQuat = new THREE.Quaternion();
    this.pokePos = new THREE.Vector3();
    this.hasPoke = false;
    this.palmNormal = new THREE.Vector3();
    this.palmFacingHead = 0;

    this.velocity = new THREE.Vector3();
    this.angularVelocity = new THREE.Vector3();
    // ring buffer of recent poses for release velocity (preallocated, no per-frame garbage)
    this._hist = Array.from({ length: HIST }, () => ({ t: -1, p: new THREE.Vector3(), q: new THREE.Quaternion() }));
    this._histHead = 0;
    this._lostT = 0; // seconds since hand joints were last valid

    this.joints = JOINT_NAMES.map(() => ({ pos: new THREE.Vector3(), quat: new THREE.Quaternion(), radius: 0.008 }));
    this.jointsValid = false;

    // Owned by the InteractionManager
    this.hover = null;
    this.grabbed = null;
    this.grabMode = null;
    this.grabKind = null;
    this.emptyGrab = null;
    this.uiCapture = null;
    this.uiEngaged = false;
    this.rayVisible = false;
    this.rayLength = 0.5;
    this.grabDepth = 1;
  }

  get isHand() { return this.kind === 'hand'; }
  get isMouse() { return this.kind === 'mouse'; }
  get busy() { return !!(this.grabbed || this.emptyGrab || this.uiCapture); }

  /** Pose used to carry a grabbed object ('near' → hand, 'ray' → pointer). */
  pose(kind, outPos, outQuat) {
    if (kind === 'ray' && !this.isMouse) {
      outPos.copy(this.rayOrigin);
      outQuat.copy(this.rayQuat);
    } else {
      outPos.copy(this.grabPos);
      outQuat.copy(this.grabQuat);
    }
  }

  pulse(intensity = 0.4, ms = 30) {
    const ha = this.source?.gamepad?.hapticActuators?.[0];
    if (ha && ha.pulse) ha.pulse(intensity, ms).catch?.(() => {});
  }

  _record(time) {
    this._histHead = (this._histHead + 1) % HIST;
    const last = this._hist[this._histHead];
    last.t = time; last.p.copy(this.grabPos); last.q.copy(this.grabQuat);
    // velocity over the last ~70ms
    let first = last;
    for (let k = 1; k < HIST; k++) {
      const h = this._hist[(this._histHead - k + HIST) % HIST];
      if (h.t < 0 || h.t > time) break;
      first = h;
      if (last.t - first.t > 0.07) break;
    }
    const dt = last.t - first.t;
    if (dt > 1e-4) {
      this.velocity.subVectors(last.p, first.p).divideScalar(dt);
      _q.copy(first.q).invert().premultiply(last.q); // world-space delta: last * first⁻¹
      if (_q.w < 0) { _q.x = -_q.x; _q.y = -_q.y; _q.z = -_q.z; _q.w = -_q.w; }
      const angle = 2 * Math.acos(Math.min(1, _q.w));
      const s = Math.sqrt(Math.max(1e-12, 1 - _q.w * _q.w));
      this.angularVelocity.set(_q.x / s, _q.y / s, _q.z / s).multiplyScalar(angle / dt);
      if (!isFinite(this.angularVelocity.x)) this.angularVelocity.set(0, 0, 0);
    }
  }
}

/** Speed-adaptive exponential smoothing (a light One-Euro filter). */
class Smoother {
  constructor() { this.init = false; this.p = new THREE.Vector3(); this.q = new THREE.Quaternion(); }
  apply(pos, quat, dt) {
    if (!this.init) { this.p.copy(pos); this.q.copy(quat); this.init = true; return; }
    const speed = pos.distanceTo(this.p) / Math.max(dt, 1e-3);
    const cutoff = 2.0 + 40 * speed; // Hz
    const a = 1 - Math.exp(-2 * Math.PI * cutoff * dt);
    this.p.lerp(pos, a);
    const ang = this.q.angleTo(quat) / Math.max(dt, 1e-3);
    const qa = 1 - Math.exp(-2 * Math.PI * (2.0 + 3 * ang) * dt);
    this.q.slerp(quat, qa);
    pos.copy(this.p);
    quat.copy(this.q);
  }
  reset() { this.init = false; }
}

export class InputSystem {
  constructor(app) {
    this.app = app;
    const r = app.renderer;
    this.xr = [new Interactor(0), new Interactor(1)];
    this.mouse = new Interactor(2);
    this.mouse.kind = 'mouse';
    this.mouse.handedness = 'right';
    this.spaces = [];
    this.smoothers = [new Smoother(), new Smoother()];
    const factory = new XRControllerModelFactory();

    for (let i = 0; i < 2; i++) {
      const ctrl = r.xr.getController(i);
      const grip = r.xr.getControllerGrip(i);
      const hand = r.xr.getHand(i);
      app.rig.add(ctrl, grip, hand);
      const model = factory.createControllerModel(grip);
      grip.add(model);
      const ix = this.xr[i];
      ctrl.addEventListener('connected', (e) => {
        ix.source = e.data;
        ix.handedness = e.data.handedness;
        ix.kind = e.data.hand ? 'hand' : 'controller';
        ix.active = true;
        model.visible = ix.kind === 'controller';
        this.smoothers[i].reset();
      });
      ctrl.addEventListener('disconnected', () => {
        ix.source = null;
        ix.kind = 'none';
        ix.active = false;
        ix.pinch.reset(); ix.grip.reset(); ix.btnA.reset(); ix.btnB.reset();
        ix.stick.set(0, 0);
        ix.jointsValid = false;
        ix.hasPoke = false;
        model.visible = false;
      });
      this.spaces.push({ ctrl, grip, hand, model });
    }
    this._setupMouse();
  }

  get all() {
    return this.app.presenting ? this.xr : [this.mouse];
  }

  byHand(handedness) {
    return this.xr.find((ix) => ix.handedness === handedness && ix.active) || null;
  }

  update(dt, time) {
    const head = this.app.headPosition;
    this.app.rig.updateMatrixWorld(true);
    if (this.app.presenting) {
      for (let i = 0; i < 2; i++) this._updateXR(this.xr[i], this.spaces[i], this.smoothers[i], dt, time, head);
    } else {
      this._updateMouse(time);
    }
  }

  _updateXR(ix, sp, smoother, dt, time, head) {
    if (!ix.active || !ix.source) return;
    // pointing ray (targetRaySpace) — available for both hands and controllers
    sp.ctrl.matrixWorld.decompose(ix.rayOrigin, ix.rayQuat, _v);
    ix.rayDir.set(0, 0, -1).applyQuaternion(ix.rayQuat);

    if (ix.kind === 'hand') {
      const joints = sp.hand.joints;
      let valid = true;
      for (let j = 0; j < JOINT_NAMES.length; j++) {
        const jg = joints[JOINT_NAMES[j]];
        if (!jg || !jg.visible) { valid = false; continue; }
        jg.matrixWorld.decompose(ix.joints[j].pos, ix.joints[j].quat, _v);
        ix.joints[j].radius = jg.jointRadius || 0.008;
      }
      ix.jointsValid = valid;
      if (!valid) {
        ix._lostT += dt;
        const hold = ix._lostT < TRACKING_GRACE;
        ix.pinch.set(hold && ix.pinch.pressed, ix.pinch.value);
        ix.grip.set(hold && ix.grip.pressed, ix.grip.value);
        ix.hasPoke = false;
        return;
      }
      ix._lostT = 0;

      const thumb = ix.joints[J['thumb-tip']].pos;
      const index = ix.joints[J['index-finger-tip']].pos;
      const middle = ix.joints[J['middle-finger-tip']].pos;
      const dI = thumb.distanceTo(index);
      const dM = thumb.distanceTo(middle);
      ix.pinchStrength = 1 - THREE.MathUtils.clamp((dI - 0.012) / 0.05, 0, 1);

      // hysteresis thresholds (metres)
      const pinchOn = ix.pinch.pressed ? dI < 0.032 : dI < 0.017;
      const gripOn = !pinchOn && (ix.grip.pressed ? dM < 0.036 : (dM < 0.019 && dI > 0.03));
      ix.pinch.set(pinchOn, ix.pinchStrength);
      ix.grip.set(gripOn);

      // grab point: between thumb and the pinching finger
      const other = ix.grip.pressed ? middle : index;
      ix.grabPos.addVectors(thumb, other).multiplyScalar(0.5);
      ix.grabQuat.copy(ix.joints[J.wrist].quat);
      smoother.apply(ix.grabPos, ix.grabQuat, dt);

      ix.pokePos.copy(index);
      ix.hasPoke = true;

      // palm normal = −Y of the wrist joint (WebXR hand joint convention)
      ix.palmNormal.set(0, -1, 0).applyQuaternion(ix.joints[J.wrist].quat);
      _v2.subVectors(head, ix.joints[J.wrist].pos).normalize();
      ix.palmFacingHead = ix.palmNormal.dot(_v2);
    } else {
      ix.jointsValid = false;
      sp.grip.matrixWorld.decompose(_v2, ix.grabQuat, _v);
      // hold point is 5 cm in front of the controller
      ix.grabPos.set(0, -0.01, -0.05).applyQuaternion(ix.grabQuat).add(_v2);
      ix.pokePos.copy(ix.rayOrigin).addScaledVector(ix.rayDir, 0.02);
      ix.hasPoke = true;
      const gp = ix.source.gamepad;
      if (gp) {
        const trig = gp.buttons[0]?.value || 0;
        const sq = gp.buttons[1]?.value || 0;
        ix.pinch.set(ix.pinch.pressed ? trig > 0.35 : trig > 0.6, trig);
        ix.grip.set(ix.grip.pressed ? sq > 0.35 : sq > 0.6, sq);
        ix.btnA.set(!!gp.buttons[4]?.pressed);
        ix.btnB.set(!!gp.buttons[5]?.pressed);
        const ax = gp.axes.length >= 4 ? [gp.axes[2], gp.axes[3]] : [gp.axes[0] || 0, gp.axes[1] || 0];
        ix.stick.set(Math.abs(ax[0]) > 0.12 ? ax[0] : 0, Math.abs(ax[1]) > 0.12 ? ax[1] : 0);
      }
      ix.palmFacingHead = 0;
    }
    ix._record(time);
  }

  // ---------------------------------------------------------------------------
  // Desktop mouse

  _setupMouse() {
    const el = this.app.renderer.domElement;
    const m = this.mouse;
    this.ndc = new THREE.Vector2();
    this._buttons = 0;
    this._shift = false;
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this._shift = e.shiftKey;
    });
    el.addEventListener('pointerdown', (e) => {
      this._buttons = e.buttons;
      this._shift = e.shiftKey;
      this.app.audio.unlock();
    });
    window.addEventListener('pointerup', (e) => { this._buttons = e.buttons; });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    m.active = true;
  }

  _updateMouse(time) {
    const m = this.mouse;
    const cam = this.app.camera;
    this.app.raycaster.setFromCamera(this.ndc, cam);
    m.rayOrigin.copy(this.app.raycaster.ray.origin);
    m.rayDir.copy(this.app.raycaster.ray.direction);
    m.rayQuat.copy(cam.quaternion);
    m.grabPos.copy(m.rayOrigin).addScaledVector(m.rayDir, m.grabDepth);
    m.grabQuat.identity();
    const left = (this._buttons & 1) !== 0;
    const right = (this._buttons & 2) !== 0;
    m.pinch.set(left && !this._shift);
    m.grip.set(right || (left && this._shift));
    m.hasPoke = false;
    m._record(time);
  }

  /** True while the desktop user is dragging something (so orbiting pauses). */
  get mouseBusy() {
    return this.mouse.busy;
  }
}
