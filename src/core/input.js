// Input from tracked hands, controllers and the mouse. Each one is wrapped in
// an Interactor with the same fields:
//
//   pinch            primary action (thumb+index pinch or a closed hand, trigger
//                    or grip alone, or left mouse)
//   grip             secondary action (thumb+middle pinch, trigger and grip
//                    together, or right mouse)
//   grabPos/grabQuat where grabbed objects are held
//   rayOrigin/rayDir pointer ray for distant objects and UI
//   pokePos          index fingertip (or controller tip) for pressing UI
//
// Inputs with no hand joints and no gamepad (a gaze cursor, a phone viewer's
// screen tap, Vision Pro's look and pinch) are 'pointer's. Their select
// events are the only thing to read, and they act as the primary action.

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

// Pinch thresholds, as the distance between the thumb tip and a fingertip joint (meters).
// A pinch starts at 2 cm and ends past 3 cm, so tracking noise can't flicker it.
const PINCH_ON = 0.02;
const PINCH_OFF = 0.03;

// Which pinch the thumb is making, from its distance to the index (dI) and
// middle (dM) fingertips. Only one pinch can be held at a time, so a middle
// pinch that brushes the index finger doesn't drop what it's holding. A middle
// pinch has to be clearly closer than the index, since the index often rests
// near the thumb during one.
export function classifyPinch(dI, dM, pinchHeld, gripHeld) {
  if (pinchHeld) return { pinch: dI < PINCH_OFF, grip: false };
  if (gripHeld) return { pinch: false, grip: dM < PINCH_OFF + 0.004 };
  const pinch = dI < PINCH_ON && dI <= dM + 0.002;
  return { pinch, grip: !pinch && dM < PINCH_ON && dM < dI - 0.006 };
}

// How straight a finger is: knuckle to tip distance over the length of the
// bones in between. About 1 when straight and 0.5 when curled into the palm.
// `base` is the index of its proximal phalanx joint.
function curl(joints, base) {
  const p = joints[base].pos, i = joints[base + 1].pos, d = joints[base + 2].pos, t = joints[base + 3].pos;
  const chain = p.distanceTo(i) + i.distanceTo(d) + d.distanceTo(t);
  return p.distanceTo(t) / Math.max(chain, 1e-4);
}

// Closed hand (a fist or grabbing with the whole hand). New users often grab
// this way instead of pinching, so it grabs too. It starts when the index,
// middle and ring fingers are all curled and ends once they're mostly open
// again. Pointing (index straight, the rest curled) doesn't count.
export function classifyFist(ci, cm, cr, held) {
  if (held) return (ci + cm + cr) / 3 < 0.74;
  return Math.max(ci, cm, cr) < 0.62;
}
// A thumb to middle finger touch while the ring finger is curled this much is
// part of a closing fist, not a middle-finger pinch
const RING_CLOSING = 0.72;
const RELEASE_DELAY = 0.075;

const strength = (d) => 1 - THREE.MathUtils.clamp((d - 0.012) / 0.05, 0, 1);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class Interactor {
  constructor(index) {
    this.index = index;
    this.kind = 'none'; // 'hand', 'controller', 'pointer', 'mouse' or 'none'
    this.handedness = 'none';
    this.source = null;
    this.active = false;

    this.pinch = new Button();
    this.grip = new Button();
    this.trigger = new Button(); // controllers: the raw buttons behind pinch and grip
    this.squeeze = new Button();
    this.btnA = new Button();
    this.btnB = new Button();
    this.stick = new THREE.Vector2();
    this.touch = false;     // mouse: a touch screen is being touched
    this.pinchStrength = 0; // thumb and index, 0 (fingers apart) to 1 (touching)
    this.gripStrength = 0;  // the same for the thumb and middle finger
    this.fist = false;      // hands: closed hand (see classifyFist)
    // Hands: true while the current pinch is a closed hand rather than a thumb
    // and index pinch. Objects are then held at the palm, and it doesn't start
    // empty-space gestures.
    this.palmGrab = false;
    this.palmPos = new THREE.Vector3(); // hands: a few cm in front of the palm
    this.hasPalm = false;
    this.selecting = false; // pointers: between selectstart and selectend
    this.openness = 1;  // hands: how straight the least straight of the index, middle and ring fingers is
    this._pinchOffT = 0; // seconds a held pinch or grip has looked released (see RELEASE_DELAY)
    this._gripOffT = 0;

    this.grabPos = new THREE.Vector3();
    this.grabQuat = new THREE.Quaternion();
    this.rayOrigin = new THREE.Vector3();
    this.rayDir = new THREE.Vector3(0, 0, -1);
    this.rayQuat = new THREE.Quaternion();
    this.pokePos = new THREE.Vector3();
    this.hasPoke = false;
    // the panel under the fingertip this frame (set by UISystem.updatePoke), for the poke cursor
    this.pokeHit = { panel: null, x: 0, y: 0, z: 0 };
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
    this.pullTarget = null; // hands: what a pinch would pull from out of reach
    this.pullT = 0;         // seconds the ray has been on it
    this.pullDist = 0;
  }

  get isHand() { return this.kind === 'hand'; }
  get isMouse() { return this.kind === 'mouse'; }
  get busy() { return !!(this.grabbed || this.emptyGrab || this.uiCapture); }

  // Pose used to carry a grabbed object. 'near' uses the hand and 'ray' uses the pointer.
  pose(kind, outPos, outQuat) {
    if (kind === 'ray' && !this.isMouse) {
      outPos.copy(this.rayOrigin);
      outQuat.copy(this.rayQuat);
    } else {
      outPos.copy(this.grabPos);
      outQuat.copy(this.grabQuat);
    }
  }

  // Forget recent motion, for when grabPos jumps without the hand moving
  clearHistory(time) {
    for (const h of this._hist) h.t = -1;
    this._record(time);
    this.velocity.set(0, 0, 0);
    this.angularVelocity.set(0, 0, 0);
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

// Speed-adaptive exponential smoothing (a light One-Euro filter)
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
  static classifyPinch = classifyPinch; // for tools/interaction-test.js
  static classifyFist = classifyFist;

  constructor(app) {
    this.app = app;
    const r = app.renderer;
    this.xr = [new Interactor(0), new Interactor(1)];
    this.mouse = new Interactor(2);
    this.mouse.kind = 'mouse';
    this.mouse.handedness = 'right';
    this._mouseList = [this.mouse];
    this.spaces = [];
    this.smoothers = [new Smoother(), new Smoother()];
    // The menu and the tips panel draw over the world (depthTest off), and the
    // hands draw after them. The controller models do the same, so a
    // controller reaching for the menu isn't hidden behind it.
    const factory = new XRControllerModelFactory(null, (scene) => scene.traverse((o) => {
      if (!o.isMesh) return;
      o.material.transparent = true; // opacity stays at 1. This only moves it into the later pass.
      o.renderOrder = 30;
    }));

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
        ix.kind = e.data.hand ? 'hand' : e.data.gamepad ? 'controller' : 'pointer';
        ix.active = true;
        model.visible = ix.kind === 'controller';
        this.smoothers[i].reset();
      });
      ctrl.addEventListener('selectstart', () => { ix.selecting = true; });
      ctrl.addEventListener('selectend', () => { ix.selecting = false; });
      ctrl.addEventListener('disconnected', () => {
        // drop what it was holding, without throwing it
        ix.velocity.set(0, 0, 0);
        ix.angularVelocity.set(0, 0, 0);
        app.interaction?.release(ix);
        ix.source = null;
        ix.kind = 'none';
        ix.active = false;
        ix.pinch.reset(); ix.grip.reset(); ix.trigger.reset(); ix.squeeze.reset(); ix.btnA.reset(); ix.btnB.reset();
        ix.stick.set(0, 0);
        ix.jointsValid = false;
        ix.hasPoke = false;
        ix.hasPalm = false;
        ix.fist = false;
        ix.palmGrab = false;
        ix.selecting = false;
        model.visible = false;
      });
      this.spaces.push({ ctrl, grip, hand, model });
    }
    this._setupMouse();
  }

  get all() {
    return this.app.presenting ? this.xr : this._mouseList;
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
    // pointing ray (targetRaySpace), available for both hands and controllers
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
        ix.hasPalm = false;
        // after a longer gap, start the filter afresh where the hand reappears
        // instead of sweeping across from where it was lost
        if (!hold) smoother.reset();
        return;
      }
      ix._lostT = 0;

      const thumb = ix.joints[J['thumb-tip']].pos;
      const index = ix.joints[J['index-finger-tip']].pos;
      const middle = ix.joints[J['middle-finger-tip']].pos;
      const dI = thumb.distanceTo(index);
      const dM = thumb.distanceTo(middle);
      ix.pinchStrength = strength(dI);
      ix.gripStrength = strength(dM);
      const ci = curl(ix.joints, J['index-finger-phalanx-proximal']);
      const cm = curl(ix.joints, J['middle-finger-phalanx-proximal']);
      const cr = curl(ix.joints, J['ring-finger-phalanx-proximal']);
      ix.openness = Math.min(ci, cm, cr);
      ix.fist = classifyFist(ci, cm, cr, ix.fist);
      const wasPalm = ix.palmGrab;
      const p = classifyPinch(dI, dM, ix.pinch.pressed && !ix.palmGrab, ix.grip.pressed);
      if (p.grip && !ix.grip.pressed && cr < RING_CLOSING) p.grip = false;
      if (ix.fist) {
        // a closed hand is always a primary grab, even if the thumb brushed the middle finger on the way
        if (!ix.pinch.pressed) ix.palmGrab = !p.pinch;
        p.pinch = true;
        p.grip = false;
      } else if (ix.palmGrab) {
        p.pinch = false; // opening the hand lets go
      }
      // Tracking noise can open a pinch for a frame or two, so letting go has
      // to last RELEASE_DELAY (Meta's First Steps waits 75 ms)
      if (ix.pinch.pressed && !p.pinch && !p.grip) {
        ix._pinchOffT += dt;
        if (ix._pinchOffT < RELEASE_DELAY) p.pinch = true;
      } else ix._pinchOffT = 0;
      if (ix.grip.pressed && !p.grip && !p.pinch) {
        ix._gripOffT += dt;
        if (ix._gripOffT < RELEASE_DELAY) p.grip = true;
      } else ix._gripOffT = 0;
      if (!p.pinch) ix.palmGrab = false;
      ix.pinch.set(p.pinch, ix.pinchStrength);
      ix.grip.set(p.grip, ix.gripStrength);

      // palm normal is -Y of the wrist joint (WebXR hand joint convention)
      const wrist = ix.joints[J.wrist];
      ix.palmNormal.set(0, -1, 0).applyQuaternion(wrist.quat);
      _v2.subVectors(head, wrist.pos).normalize();
      ix.palmFacingHead = ix.palmNormal.dot(_v2);
      ix.palmPos.addVectors(wrist.pos, ix.joints[J['middle-finger-phalanx-proximal']].pos).multiplyScalar(0.5).addScaledVector(ix.palmNormal, 0.035);
      ix.hasPalm = true;

      // Grab point is between the thumb and the pinching finger, or in front of
      // the palm for a closed hand. The filter restarts when it switches, so a
      // held object doesn't drift across the gap between the two.
      if (ix.palmGrab !== wasPalm) smoother.reset();
      if (ix.palmGrab) ix.grabPos.copy(ix.palmPos);
      else ix.grabPos.addVectors(thumb, ix.grip.pressed ? middle : index).multiplyScalar(0.5);
      ix.grabQuat.copy(wrist.quat);
      smoother.apply(ix.grabPos, ix.grabQuat, dt);

      ix.pokePos.copy(index);
      ix.hasPoke = true;
    } else if (ix.kind === 'pointer') {
      ix.jointsValid = false;
      ix.hasPalm = false;
      ix.hasPoke = false;
      // held at the grip if there is one (Vision Pro's is at the pinch), otherwise along the ray
      if (sp.grip.visible) sp.grip.matrixWorld.decompose(ix.grabPos, ix.grabQuat, _v);
      else { ix.grabPos.copy(ix.rayOrigin).addScaledVector(ix.rayDir, 0.4); ix.grabQuat.copy(ix.rayQuat); }
      ix.pinch.set(ix.selecting);
      ix.grip.set(false);
      ix.palmFacingHead = 0;
    } else {
      ix.jointsValid = false;
      ix.hasPalm = false;
      sp.grip.matrixWorld.decompose(_v2, ix.grabQuat, _v);
      // hold point is 5 cm in front of the controller
      ix.grabPos.set(0, -0.01, -0.05).applyQuaternion(ix.grabQuat).add(_v2);
      ix.pokePos.copy(ix.rayOrigin).addScaledVector(ix.rayDir, 0.02);
      ix.hasPoke = true;
      const gp = ix.source.gamepad;
      if (gp) {
        const trig = gp.buttons[0]?.value || 0;
        const sq = gp.buttons[1]?.value || 0;
        ix.trigger.set(ix.trigger.pressed ? trig > 0.35 : trig > 0.6, trig);
        ix.squeeze.set(ix.squeeze.pressed ? sq > 0.35 : sq > 0.6, sq);
        // Either button grabs, since Quest apps usually grab with the grip and
        // pointers select with the trigger. Holding both is the secondary action.
        const both = ix.trigger.pressed && ix.squeeze.pressed;
        ix.pinch.set((ix.trigger.pressed || ix.squeeze.pressed) && !both, Math.max(trig, sq));
        ix.grip.set(both, Math.min(trig, sq));
        ix.btnA.set(!!gp.buttons[4]?.pressed);
        ix.btnB.set(!!gp.buttons[5]?.pressed);
        const a = gp.axes.length >= 4 ? 2 : 0; // the thumbstick (xr-standard), else the only axes
        const ax = gp.axes[a] || 0, ay = gp.axes[a + 1] || 0;
        ix.stick.set(Math.abs(ax) > 0.12 ? ax : 0, Math.abs(ay) > 0.12 ? ay : 0);
      }
      ix.palmFacingHead = 0;
    }
    ix._record(time);
  }

  // ---------------------------------------------------------------------------
  // Desktop mouse

  // Touch screens: one finger is the left button. Two fingers are the right
  // button, at their midpoint, until every finger has lifted. That's the
  // secondary action (turning things through 4D, pulling yourself along)
  // wherever a right-drag does it.
  _setupMouse() {
    const el = this.app.renderer.domElement;
    const m = this.mouse;
    this.ndc = new THREE.Vector2();
    this._buttons = 0;
    this._shift = false;
    this._touches = new Map(); // on the canvas, by pointer id
    this.twoFinger = false;
    const track = (x, y) => {
      const r = el.getBoundingClientRect();
      this.ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    };
    const trackTouches = () => {
      let x = 0, y = 0;
      for (const t of this._touches.values()) { x += t.x; y += t.y; }
      track(x / this._touches.size, y / this._touches.size);
    };
    el.addEventListener('pointermove', (e) => {
      this._shift = e.shiftKey;
      if (e.pointerType !== 'touch') { track(e.clientX, e.clientY); return; }
      const t = this._touches.get(e.pointerId);
      if (!t) return;
      t.x = e.clientX; t.y = e.clientY;
      trackTouches();
    });
    el.addEventListener('pointerdown', (e) => {
      this._shift = e.shiftKey;
      this.app.audio.unlock();
      if (e.pointerType !== 'touch') {
        track(e.clientX, e.clientY); // a pen has no pointermove before it goes down either
        this._buttons = e.buttons;
        return;
      }
      this._touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      trackTouches();
      if (this._touches.size === 2) {
        this.twoFinger = true;
        this.app.orbit.enabled = false; // App turns it back on once every finger has lifted
      }
    });
    const up = (e) => {
      if (e.pointerType !== 'touch') { this._buttons = e.buttons; return; }
      this._touches.delete(e.pointerId);
      if (!this._touches.size) this.twoFinger = false;
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
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
    const touches = this._touches.size;
    m.touch = touches > 0;
    // Shift+drag is a right-drag for trackpads, except where Shift is for moving faster
    const shift = this._shift && !this.app.activeScene?.locomotion;
    const left = touches ? !this.twoFinger : (this._buttons & 1) !== 0;
    const right = touches ? this.twoFinger && touches > 1 : (this._buttons & 2) !== 0;
    m.pinch.set(left && !shift);
    m.grip.set(right || (left && shift));
    m.hasPoke = false;
    m._record(time);
  }

  // True while the desktop user is dragging something, so orbiting pauses
  get mouseBusy() {
    return this.mouse.busy;
  }
}
