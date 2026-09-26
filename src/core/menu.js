// Hand menu (shown when a palm faces the head; A/X on controllers; a HUD
// fixed to the camera on desktop) and the instructions panel shown when
// entering VR.

import * as THREE from 'three';
import { UIPanel, COLORS } from './ui.js';
import { J } from './input.js';
import { QUALITY } from './quality.js';

const UP = new THREE.Vector3(0, 1, 0);
const _pos = new THREE.Vector3();
const _to = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();

// Desktop HUD layout in CSS pixels. main.js replaces the margins with
// app.hudInsets, measured from the HTML tab bar and buttons.
const HUD = { top: 76, bottom: 76, right: 16, minW: 280, maxW: 440 };

export class HandMenu {
  constructor(app) {
    this.app = app;
    this.panel = app.ui.add(new UIPanel(app.ui, { width: 0.3, name: 'hand-menu' }));
    this.panel.group.visible = false;
    this.panel.opacity = 0;
    this.pinned = false;
    this.owner = null;
    this.showT = 0;
    this.hideT = 0;
    this.shown = false;
  }

  rebuild() {
    const app = this.app;
    const scene = app.activeScene;
    if (!scene) return;
    const vr = app.presenting;
    const rows = [
      { type: 'title', text: scene.title, sub: scene.subtitle },
      // desktop has the HTML tab bar instead
      ...(vr ? [{
        type: 'tabs',
        columns: Math.ceil(app.sceneList.length / Math.ceil(app.sceneList.length / 5)), // at most 5 per row
        options: app.sceneList.map((s) => ({ label: s.short, value: s.key, small: true })),
        get: () => app.sceneKey,
        set: (k) => app.setScene(k),
      }] : []),
      ...scene.menuRows(),
      {
        type: 'text', lines: 2,
        text: () => (app.qualityPending ? 'Graphics quality. The resolution changes the next time you enter VR.' : 'Graphics quality'),
      },
      {
        type: 'tabs',
        options: Object.entries(QUALITY).map(([value, q]) => ({ label: q.label, value, small: true })),
        get: () => app.quality,
        set: (k) => app.setQuality(k),
      },
      // desktop has Menu and Help buttons in the HTML HUD instead
      ...(vr ? [{
        type: 'buttons',
        items: [
          { label: () => (this.pinned ? 'Unpin menu' : 'Pin menu here'), onClick: () => this.togglePin(), small: true },
          { label: 'Help', onClick: () => app.welcome.show(), small: true },
        ],
      }] : []),
      { type: 'text', text: () => scene.hint(app.inputMode), lines: 5 },
    ];
    if (app.statsEnabled) rows.push({ type: 'text', text: () => app.statsText, lines: 2, color: '#eceef4' });
    this.panel.setRows(rows);
  }

  togglePin() {
    this.pinned = !this.pinned;
    if (!this.pinned && this.owner === null) this.shown = false;
  }

  /** Pin the menu floating in front of the head. */
  summonInFront() {
    const cam = this.app.camera;
    const head = this.app.headPosition;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
    fwd.y = 0;
    fwd.normalize();
    this.panel.group.position.copy(head).addScaledVector(fwd, 0.45).addScaledVector(UP, -0.18);
    this._face(this.panel.group.position, head, 1);
    this.pinned = true;
    this.shown = true;
  }

  _face(pos, head, alpha) {
    // Matrix4.lookAt(eye, target) builds a basis whose +Z points from target to
    // eye, so passing (head, pos) turns the panel's front (+Z) towards the head.
    _m.lookAt(head, pos, UP);
    _q.setFromRotationMatrix(_m);
    this.panel.group.quaternion.slerp(_q, alpha);
  }

  /**
   * Desktop: park the panel in camera space so it appears at a fixed spot on
   * screen (right edge, below the tab bar), scaled to fit the viewport.
   */
  _placeHud() {
    const cam = this.app.camera;
    const W = window.innerWidth, H = window.innerHeight;
    const pw = this.panel.width, ph = this.panel.height;
    const tan = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    const { top, bottom, right } = this.app.hudInsets || HUD;
    const narrow = W < 720;
    let wpx = narrow ? Math.min(W - 2 * right, HUD.maxW) : THREE.MathUtils.clamp(W * 0.27, HUD.minW, HUD.maxW);
    let hpx = (wpx * ph) / pw;
    const availH = H - top - bottom;
    if (hpx > availH) { hpx = Math.max(120, availH); wpx = (hpx * pw) / ph; }
    const d = (ph * H) / (hpx * 2 * tan); // distance at which ph metres spans hpx pixels
    const cx = narrow ? W / 2 : W - right - wpx / 2;
    const cy = top + hpx / 2;
    const g = this.panel.group;
    g.position.set((cx / W * 2 - 1) * d * tan * cam.aspect, (1 - (cy / H) * 2) * d * tan, -d);
    g.quaternion.identity();
    g.scale.setScalar(1);
  }

  update(dt) {
    const app = this.app;
    const g = this.panel.group;
    if (!app.activeScene) return;
    if (!app.presenting) {
      if (g.parent !== app.camera) app.camera.add(g);
      this.panel.material.depthTest = false; // HUD: always on top of the scene
      g.visible = app.desktopMenu && app.hudActive;
      if (g.visible) this._placeHud();
      this.panel.opacity = 1;
      return;
    }
    if (g.parent !== app.ui.root) {
      app.ui.root.add(g);
      this.panel.material.depthTest = true;
    }

    // Controllers: A/X toggles a floating menu
    for (const ix of app.input.xr) {
      if (ix.kind === 'controller' && ix.btnA.down) {
        if (this.pinned && this.shown) { this.pinned = false; this.shown = false; } else this.summonInFront();
      }
    }

    this.panel.ownerIx = this.pinned ? null : this.owner; // the hand holding the menu can't poke it
    if (this.pinned) {
      this.shown = true;
    } else {
      // Hands: show the menu above a hand whose palm faces the head
      let cand = null;
      for (const ix of app.input.xr) {
        if (ix.kind !== 'hand' || !ix.jointsValid || ix.grabbed || ix.emptyGrab) continue;
        const thr = this.owner === ix && this.shown ? 0.4 : 0.72;
        if (ix.palmFacingHead > thr && (!cand || ix.palmFacingHead > cand.palmFacingHead)) cand = ix;
      }
      const beingUsed = app.input.xr.some((ix) => ix !== this.owner && ix.uiEngaged && this.panel.hover.has(ix));
      if (cand) {
        this.hideT = 0;
        this.showT += dt;
        if (this.showT > 0.12) {
          if (!this.shown || this.owner !== cand) this._snap = true;
          this.shown = true;
          this.owner = cand;
        }
      } else if (!beingUsed) {
        this.showT = 0;
        this.hideT += dt;
        if (this.hideT > 0.25) { this.shown = false; }
      }
      if (this.shown && this.owner && this.owner.jointsValid) {
        const o = this.owner;
        const wrist = o.joints[J.wrist].pos;
        const knuckle = o.joints[J['middle-finger-phalanx-proximal']].pos;
        const head = app.headPosition;
        _pos.addVectors(wrist, knuckle).multiplyScalar(0.5);
        _to.subVectors(head, _pos).setY(0).normalize();
        _pos.addScaledVector(UP, this.panel.height / 2 + 0.1).addScaledVector(_to, 0.03);
        const a = this._snap ? 1 : 1 - Math.exp(-dt * 16);
        g.position.lerp(_pos, a);
        this._face(g.position, head, this._snap ? 1 : 1 - Math.exp(-dt * 12));
        this._snap = false;
      }
    }

    const target = this.shown ? 1 : 0;
    this.panel.opacity += (target - this.panel.opacity) * Math.min(1, dt * 14);
    g.visible = this.panel.opacity > 0.02;
    const s = 0.92 + 0.08 * this.panel.opacity;
    g.scale.setScalar(s);
  }
}

export class WelcomePanel {
  constructor(app) {
    this.app = app;
    this.panel = app.ui.add(new UIPanel(app.ui, { width: 0.46, name: 'welcome' }));
    this.panel.group.visible = false;
    this.rebuild();
  }

  rebuild() {
    const controllers = this.app.inputMode === 'controllers';
    const text = controllers
      ? 'Trigger: grab and throw. Grip: rotate an object through 4D.\nStick up/down: move the slice along w. Stick left/right: rotate the slice.\nA / X: open the menu. Point at distant objects and the menu and pull the trigger to use them.'
      : 'Pinch (thumb + index) to grab and throw. Middle-finger pinch an object and move your hand to rotate it through 4D.\nPinch empty space and move up or down to move the slice along w.\nTurn a palm towards your face to open the menu.';
    this.panel.setRows([
      { type: 'title', text: '4D VR', sub: 'Controls' },
      { type: 'text', text: '4D objects are shown as 3D cross-sections. The fourth axis is w. The +w direction is called ana and -w is called kata.', lines: 3, color: COLORS.ink },
      { type: 'text', text, lines: 8 },
      { type: 'buttons', items: [{ label: 'Close', onClick: () => this.hide() }], height: 0.042 },
    ]);
  }

  show() {
    this.rebuild();
    const app = this.app;
    const head = app.headPosition;
    const q = app.camera.getWorldQuaternion(new THREE.Quaternion());
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q).setY(0).normalize();
    const g = this.panel.group;
    g.position.copy(head).addScaledVector(fwd, 0.55).addScaledVector(UP, -0.1);
    _m.lookAt(head, g.position, UP);
    g.quaternion.setFromRotationMatrix(_m);
    g.visible = true;
    this.panel.opacity = 1;
  }

  hide() {
    this.panel.group.visible = false;
  }
}
