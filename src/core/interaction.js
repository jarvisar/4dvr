// Decides what each interactor is doing each frame: pressing UI, hovering,
// grabbing something near or far, or pinching empty space (scenes use this
// for things like moving the slice along W).
//
// Scenes expose `interactables`, objects with:
//   nearDistance(worldPoint) returns meters from the surface (≤0 inside) or Infinity
//   rayDistance(origin, dir) returns the hit distance or Infinity
//   onHover(ix, bool), onGrabStart(ix, mode, kind), onGrabUpdate(ix, dt), onGrabEnd(ix)
// and optionally:
//   nearRadius       how far from the surface a hand or controller can grab it (default NEAR_RADIUS)
//   pullPoint(out)   world center and radius (returned) for tracked hands to
//                    pull it from out of reach. The grab kind is then 'pull'.
//
// onGrabStart can be called again during a grab with a different mode, when a
// controller squeezes its second button or a hand closes into a fist.

import * as THREE from 'three';

const NEAR_RADIUS = 0.035;

// Pulling objects from out of reach with a tracked hand. The hand's ray has to
// point at the object (within PULL_CONE, or PULL_KEEP once it's the target)
// with the arm stretched out toward it (the wrist at least ARM_REACH from the
// shoulder, measured horizontally toward the object), the object has to be
// further than OUT_OF_REACH from the shoulder, and the ray has to stay on it
// for PULL_DWELL before a pinch pulls it. Pinching empty space close to the
// body (moving the slice) doesn't reach out toward anything, so the two don't
// get in each other's way. Arms hanging down don't count as reaching either.
const PULL_CONE = THREE.MathUtils.degToRad(4);
const PULL_KEEP = THREE.MathUtils.degToRad(8);
const ARM_REACH = 0.36;
const OUT_OF_REACH = 0.6;
const PULL_DWELL = 0.12;
// Once something is hovered its grab radius grows by this much, so the hover
// doesn't flicker between two objects the hand is between (MRTK does the same)
const HOVER_STICK = 1.4;
// Quest reserves pinching with the palm toward your face for its own menu
// (on the left hand it can end the WebXR session), and those pinches still
// reach the page. New pinches aren't used while a palm faces the head this
// much. Closing the whole hand isn't that gesture, so it still grabs.
const PALM_SYSTEM = 0.7;
const NONE = [];

const _shoulder = new THREE.Vector3();
const _arm = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();

export class InteractionManager {
  constructor(app) {
    this.app = app;
    this._lists = [NONE, NONE]; // the scene's interactables and the UI's panel handles
  }

  update(dt) {
    const scene = this.app.activeScene;
    if (!scene) return;
    for (const ix of this.app.input.all) {
      if (!ix.active) continue;
      this._update(ix, scene, dt);
    }
  }

  // Release everything (used on scene switches)
  releaseAll() {
    for (const ix of [...this.app.input.xr, this.app.input.mouse]) this.release(ix);
  }

  // Ends whatever one interactor is doing. Also used when its hand or
  // controller goes away mid-grab, since inactive interactors aren't updated.
  release(ix) {
    if (ix.grabbed) { ix.grabbed.onGrabEnd?.(ix); ix.grabbed = null; }
    if (ix.emptyGrab) { this.app.activeScene?.onEmptyGrabEnd?.(ix, ix.emptyGrab.mode); ix.emptyGrab = null; }
    if (ix.hover) { ix.hover.onHover?.(ix, false); ix.hover = null; }
    if (ix.uiCapture) this.app.ui.endCapture(ix);
    this.app.ui.forget(ix);
    ix.pullTarget = null;
  }

  // Drop references to an interactable that's being removed from the scene
  forget(target) {
    for (const ix of [...this.app.input.xr, this.app.input.mouse]) {
      if (ix.grabbed === target) ix.grabbed = null;
      if (ix.hover === target) ix.hover = null;
      if (ix.pullTarget === target) ix.pullTarget = null;
    }
  }

  _setHover(ix, target) {
    if (ix.hover === target) return;
    if (ix.hover) ix.hover.onHover?.(ix, false);
    ix.hover = target;
    if (target) {
      target.onHover?.(ix, true);
      ix.pulse(0.15, 12);
      // hands have no haptics, so a quiet tick says what a pinch would grab
      if (ix.isHand) this.app.audio.hover();
    }
  }

  // The mode the held buttons ask for: controllers hold both for 'secondary'
  _mode(ix) {
    return ix.grip.pressed ? 'secondary' : 'primary';
  }

  _update(ix, scene, dt) {
    const ui = this.app.ui;
    const audio = this.app.audio;
    const held = ix.pinch.pressed || ix.grip.pressed;

    // 1. Continue ongoing captures
    if (ix.grabbed) {
      if (!held) {
        const t = ix.grabbed;
        ix.grabbed = null;
        t.onGrabEnd?.(ix);
        audio.release(ix.grabPos);
      } else {
        const mode = this._mode(ix);
        if (mode !== ix.grabMode && (!ix.isMouse || ix.touch)) {
          // second button squeezed or let go, a hand closed into a fist, or a second finger on a touch screen
          ix.grabMode = mode;
          ix.grabbed.onGrabStart?.(ix, mode, ix.grabKind === 'pull' ? 'near' : ix.grabKind);
          ix.pulse(0.3, 15);
        }
        ix.grabbed.onGrabUpdate?.(ix, dt);
      }
      ix.rayVisible = ix.grabKind === 'ray';
      return;
    }
    if (ix.emptyGrab) {
      if (!held) {
        const mode = ix.emptyGrab.mode;
        ix.emptyGrab = null;
        scene.onEmptyGrabEnd?.(ix, mode);
      } else {
        const mode = this._mode(ix);
        if (mode !== ix.emptyGrab.mode && (!ix.isMouse || ix.touch)) {
          scene.onEmptyGrabEnd?.(ix, ix.emptyGrab.mode);
          if (scene.onEmptyGrabStart(ix, mode) !== false) ix.emptyGrab.mode = mode;
          else ix.emptyGrab = null;
        }
        if (ix.emptyGrab) scene.onEmptyGrabUpdate?.(ix, ix.emptyGrab.mode, dt);
      }
      ix.rayVisible = false;
      return;
    }
    if (ix.uiCapture) {
      if (!held || !ix.uiCapture.panel.visible) ui.endCapture(ix);
      else ui.updateCapture(ix);
      ix.rayVisible = true;
      return;
    }

    // 2. Direct poke on UI panels (fingertip)
    if (ui.updatePoke(ix)) {
      this._setHover(ix, null);
      ix.pullTarget = null;
      ix.rayVisible = false;
      return;
    }

    // 3. Find the best target. Hands check a point in front of the palm as
    // well as the pinch point, for grabbing with the whole hand.
    const items = scene.interactables || NONE;
    const lists = this._lists;
    lists[0] = items;
    lists[1] = ui.handles;
    let near = null, nearScore = 0;
    if (!ix.isMouse) {
      for (const list of lists) {
        for (const it of list) {
          if (it.enabled === false || !it.nearDistance) continue;
          let d = it.nearDistance(ix.grabPos);
          if (ix.hasPalm && !it.isUI) d = Math.min(d, it.nearDistance(ix.palmPos));
          const score = d - (it.nearRadius ?? NEAR_RADIUS) * (it === ix.hover ? HOVER_STICK : 1);
          if (score < nearScore) { nearScore = score; near = it; }
        }
      }
    }
    let rayT = Infinity, rayTarget = null;
    const uiHit = near ? null : ui.raycast(ix);
    // Tracked hands only use the ray for UI (including panel handles) and for
    // pulling things from out of reach. Their ray usually points at the table,
    // so ray grabbing would grab objects when pinching empty space.
    if (!near) {
      for (const list of lists) {
        if (ix.isHand && list !== ui.handles) continue;
        for (const it of list) {
          if (it.enabled === false || !it.rayDistance) continue;
          const t = it.rayDistance(ix.rayOrigin, ix.rayDir);
          if (t < rayT) { rayT = t; rayTarget = it; }
        }
      }
    }
    // The target is kept as it was on the frame a pinch starts, since pinching
    // moves the ray a little
    if (!near && !rayTarget && ix.isHand && !ix.pinch.pressed) this._updatePull(ix, items, dt);
    else if (near || rayTarget || !ix.isHand || !ix.pinch.down) ix.pullTarget = null;
    const pull = ix.pullTarget && ix.pullT >= PULL_DWELL ? ix.pullTarget : null;
    if (ix.pullTarget) {
      rayT = ix.pullDist;
      rayTarget = ix.pullTarget;
    }
    // A button on a panel that draws over the world (all the interactive ones)
    // wins even when the ray reaches something else first, since the button is
    // what you see there. Polytope Lab's grab sphere reaches past the menu.
    const uiFirst = !!uiHit && (uiHit.t < rayT || (!!uiHit.widget && !uiHit.panel.material.depthTest));
    this._setHover(ix, near || (uiFirst ? null : rayTarget));
    ui.setRayHover(ix, uiFirst ? uiHit : null);

    // only show the ray when it points at a target
    ix.rayVisible = !near && (uiFirst || !!rayTarget);
    ix.rayLength = uiFirst ? uiHit.t : (rayTarget ? rayT : 0.4);

    // 4. Presses
    const pressed = ix.pinch.down ? 'primary' : (ix.grip.down ? 'secondary' : null);
    if (!pressed) return;
    if (ix.isHand && ix.palmFacingHead > PALM_SYSTEM && !ix.palmGrab) return;
    if (near) {
      this._grab(ix, near, pressed, 'near');
    } else if (uiFirst) {
      ui.beginCapture(ix, uiHit, pressed);
    } else if (ix.pullTarget) {
      // pinched while pointing at something out of reach. Pulls it if the ray
      // has been on it long enough, otherwise it was probably passing over it.
      if (pull && pressed === 'primary' && !ix.palmGrab) this._grab(ix, pull, pressed, 'pull');
    } else if (rayTarget) {
      if (ix.isMouse) {
        // Held at the depth the ray hit. grabPos was worked out this frame at
        // the last grab's depth, so without this the target jumps along the
        // ray (a knot finds no strand there) and a quick click throws it.
        ix.grabDepth = rayT;
        ix.grabPos.copy(ix.rayOrigin).addScaledVector(ix.rayDir, rayT);
        ix.clearHistory(this.app.time);
      }
      this._grab(ix, rayTarget, pressed, 'ray');
    } else if (!(ix.isMouse && pressed === 'primary') // on desktop, left-drag on empty space orbits the camera
      && !ix.palmGrab // a fist in empty space is usually just a relaxed hand
      && !this.app.input.all.some((other) => other !== ix && other.emptyGrab)
      && scene.onEmptyGrabStart && scene.onEmptyGrabStart(ix, pressed) !== false) {
      ix.emptyGrab = { mode: pressed };
    }
  }

  // Hands: the pullable object the ray points at, if the arm is stretched out
  // toward something out of reach. Sticks to the current target within a
  // wider cone, so the ray moving a little as the fingers pinch doesn't lose it.
  _updatePull(ix, items, dt) {
    // Closing the fingers to pinch moves the ray. Once they're on their way the target is kept.
    if (ix.pullTarget && ix.pinchStrength > 0.6) { ix.pullT += dt; return; }
    const app = this.app;
    const head = app.headPosition;
    _fwd.set(0, 0, -1).applyQuaternion(app.headQuaternion).setY(0).normalize();
    _right.set(-_fwd.z, 0, _fwd.x);
    _shoulder.copy(head).addScaledVector(_right, ix.handedness === 'left' ? -0.17 : 0.17).addScaledVector(_fwd, -0.04);
    _shoulder.y -= 0.22;
    _arm.subVectors(ix.joints[0].pos, _shoulder).setY(0);
    let best = null, bestScore = PULL_CONE, bestDist = 0;
    for (const it of items) {
      if (it.enabled === false || !it.pullPoint) continue;
      const r = it.pullPoint(_c);
      if (r <= 0 || _c.distanceTo(_shoulder) < OUT_OF_REACH) continue;
      // how far the hand reaches out toward it
      _d.subVectors(_c, _shoulder).setY(0).normalize();
      if (_arm.dot(_d) < (it === ix.pullTarget ? ARM_REACH - 0.04 : ARM_REACH)) continue;
      _d.subVectors(_c, ix.rayOrigin);
      const dist = _d.length();
      if (dist < 0.05) continue;
      // angle between the ray and the object, less the object's angular radius
      const score = Math.acos(THREE.MathUtils.clamp(_d.dot(ix.rayDir) / dist, -1, 1)) - Math.atan(r / dist);
      const limit = it === ix.pullTarget ? PULL_KEEP : bestScore;
      if (score < limit && (!best || score < bestScore)) { best = it; bestScore = score; bestDist = Math.max(0.05, dist - r); }
    }
    if (best !== ix.pullTarget) ix.pullT = 0;
    ix.pullTarget = best;
    ix.pullDist = bestDist;
    if (best) ix.pullT += dt;
  }

  _grab(ix, target, mode, kind) {
    // release it from the other hand if needed
    for (const other of this.app.input.all) {
      if (other !== ix && other.grabbed === target) {
        other.grabbed = null;
        target.onGrabEnd?.(other);
      }
    }
    ix.grabbed = target;
    ix.grabMode = mode;
    ix.grabKind = kind;
    ix.pullTarget = null;
    this._setHover(ix, null);
    target.onGrabStart?.(ix, mode, kind);
    this.app.audio.grab(ix.grabPos);
    ix.pulse(0.5, 25);
  }
}

// Ray vs sphere helper for interactables (0 if the ray starts inside)
export function raySphere(origin, dir, center, radius) {
  const ox = origin.x - center.x, oy = origin.y - center.y, oz = origin.z - center.z;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  if (t > 0) return t;
  const t2 = -b + Math.sqrt(disc);
  return t2 > 0 ? 0 : Infinity;
}

export const _tmpV = new THREE.Vector3();
