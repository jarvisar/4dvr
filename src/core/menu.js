// Hand menu (shown when a palm faces the head; A/X on controllers; fixed in
// the scene on desktop) and the instructions panel shown when entering VR.

import * as THREE from 'three';
import { UIPanel } from './ui.js';
import { J } from './input.js';

const UP = new THREE.Vector3(0, 1, 0);
const _pos = new THREE.Vector3();
const _to = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();

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
    const rows = [
      { type: 'title', text: scene.title, sub: scene.subtitle },
      {
        type: 'tabs',
        options: app.sceneList.map((s) => ({ label: s.short, value: s.key, small: true })),
        get: () => app.sceneKey,
        set: (k) => app.setScene(k),
      },
      ...scene.menuRows(),
      {
        type: 'buttons',
        items: [
          { label: () => (this.pinned ? 'Unpin menu' : 'Pin menu here'), onClick: () => this.togglePin(), small: true },
          { label: 'Help', onClick: () => app.welcome.show(), small: true },
        ],
      },
      { type: 'text', text: () => scene.hint(), lines: 4 },
    ];
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

  update(dt) {
    const app = this.app;
    const g = this.panel.group;
    if (!app.activeScene) return;
    if (!app.presenting) {
      const pose = app.activeScene.desktopMenuPose;
      g.visible = !!pose && app.desktopMenu;
      if (pose) {
        g.position.copy(pose.position);
        this._face(g.position, pose.lookAt, 1);
      }
      this.panel.opacity = 1;
      return;
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
    const controllers = this.app.input.xr.some((ix) => ix.kind === 'controller');
    const text = controllers
      ? 'Trigger: grab and throw. Grip: rotate an object through 4D.\nStick up/down: move the slice along W. Stick left/right: rotate the slice.\nA / X: open the menu. Point at distant objects and UI and pull the trigger to use them.'
      : 'Pinch (thumb + index) to grab and throw. Middle-finger pinch an object and move your hand to rotate it through 4D.\nPinch empty space and move up or down to move the slice along W.\nTurn a palm towards your face to open the menu.';
    this.panel.setRows([
      { type: 'title', text: 'ana + kata', sub: 'How to use' },
      { type: 'text', text: 'The 4D scenes are shown as 3D cross-sections. Ana is the +w direction and kata is the -w direction.', lines: 3, color: '#dfe2ff' },
      { type: 'text', text, lines: 6 },
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
