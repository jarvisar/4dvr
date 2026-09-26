// Decides what each interactor is doing each frame: pressing UI, hovering,
// grabbing something near or far, or pinching empty space (scenes use this
// for things like moving the slice along W).
//
// Scenes expose `interactables`, objects with:
//   nearDistance(worldPoint) → metres from the surface (≤0 inside) or Infinity
//   rayDistance(origin, dir) → hit distance or Infinity
//   onHover(ix, bool), onGrabStart(ix, mode, kind), onGrabUpdate(ix, dt), onGrabEnd(ix)

import * as THREE from 'three';

const NEAR_RADIUS = 0.035;

export class InteractionManager {
  constructor(app) {
    this.app = app;
  }

  update(dt) {
    const scene = this.app.activeScene;
    if (!scene) return;
    for (const ix of this.app.input.all) {
      if (!ix.active) continue;
      this._update(ix, scene, dt);
    }
  }

  /** Release everything (scene switches). */
  releaseAll() {
    for (const ix of [...this.app.input.xr, this.app.input.mouse]) {
      if (ix.grabbed) { ix.grabbed.onGrabEnd?.(ix); ix.grabbed = null; }
      if (ix.emptyGrab) { this.app.activeScene?.onEmptyGrabEnd?.(ix, ix.emptyGrab.mode); ix.emptyGrab = null; }
      if (ix.hover) { ix.hover.onHover?.(ix, false); ix.hover = null; }
      ix.uiCapture = null;
    }
  }

  _setHover(ix, target) {
    if (ix.hover === target) return;
    if (ix.hover) ix.hover.onHover?.(ix, false);
    ix.hover = target;
    if (target) {
      target.onHover?.(ix, true);
      ix.pulse(0.15, 12);
    }
  }

  _update(ix, scene, dt) {
    const ui = this.app.ui;
    const audio = this.app.audio;

    // 1. Continue ongoing captures
    if (ix.grabbed) {
      const btn = ix.grabMode === 'secondary' ? ix.grip : ix.pinch;
      if (!btn.pressed) {
        const t = ix.grabbed;
        ix.grabbed = null;
        t.onGrabEnd?.(ix);
        audio.release(ix.grabPos);
      } else {
        ix.grabbed.onGrabUpdate?.(ix, dt);
      }
      ix.rayVisible = ix.grabKind === 'ray';
      return;
    }
    if (ix.emptyGrab) {
      const btn = ix.emptyGrab.mode === 'secondary' ? ix.grip : ix.pinch;
      if (!btn.pressed) {
        const mode = ix.emptyGrab.mode;
        ix.emptyGrab = null;
        scene.onEmptyGrabEnd?.(ix, mode);
      } else {
        scene.onEmptyGrabUpdate?.(ix, ix.emptyGrab.mode, dt);
      }
      ix.rayVisible = false;
      return;
    }
    if (ix.uiCapture) {
      const btn = ix.uiCapture.mode === 'secondary' ? ix.grip : ix.pinch;
      if (!btn.pressed) ui.endCapture(ix);
      else ui.updateCapture(ix);
      ix.rayVisible = true;
      return;
    }

    // 2. Direct poke on UI panels (fingertip)
    if (ui.updatePoke(ix)) {
      this._setHover(ix, null);
      ix.rayVisible = false;
      return;
    }

    // 3. Find the best target
    const items = scene.interactables || [];
    let near = null, nearD = NEAR_RADIUS;
    if (!ix.isMouse) {
      for (const it of items) {
        if (it.enabled === false) continue;
        const d = it.nearDistance ? it.nearDistance(ix.grabPos) : Infinity;
        if (d < nearD) { nearD = d; near = it; }
      }
    }
    let rayT = Infinity, rayTarget = null;
    const uiHit = near ? null : ui.raycast(ix);
    // Tracked hands only use the ray for UI. Their ray usually points at the
    // table, so ray grabbing would grab objects when pinching empty space.
    if (!near && !ix.isHand) {
      for (const it of items) {
        if (it.enabled === false || !it.rayDistance) continue;
        const t = it.rayDistance(ix.rayOrigin, ix.rayDir);
        if (t < rayT) { rayT = t; rayTarget = it; }
      }
    }
    const uiFirst = uiHit && uiHit.t < rayT;
    this._setHover(ix, near || (uiFirst ? null : rayTarget));
    ui.setRayHover(ix, uiFirst ? uiHit : null);

    // only show the ray when it points at a target
    ix.rayVisible = !near && (uiFirst || !!rayTarget);
    ix.rayLength = uiFirst ? uiHit.t : (rayTarget ? rayT : 0.4);

    // 4. Presses
    const pressed = ix.pinch.down ? 'primary' : (ix.grip.down ? 'secondary' : null);
    if (!pressed) return;
    if (near) {
      this._grab(ix, near, pressed, 'near');
    } else if (uiFirst) {
      ui.beginCapture(ix, uiHit, pressed);
    } else if (rayTarget) {
      if (ix.isMouse) ix.grabDepth = rayT;
      this._grab(ix, rayTarget, pressed, 'ray');
    } else if (!(ix.isMouse && pressed === 'primary') // desktop: left-drag on empty space orbits the camera
      && scene.onEmptyGrabStart && scene.onEmptyGrabStart(ix, pressed) !== false) {
      ix.emptyGrab = { mode: pressed };
    }
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
    this._setHover(ix, null);
    target.onGrabStart?.(ix, mode, kind);
    this.app.audio.grab(ix.grabPos);
    ix.pulse(0.5, 25);
  }
}

/** Ray vs sphere helper for interactables. */
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
