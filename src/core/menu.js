// Hand menu (shown when a palm faces the head; A/X on controllers; a HUD
// fixed to the camera on desktop) and the guide panel shown when entering VR
// and the first time each scene is opened.

import * as THREE from 'three';
import { UIPanel, COLORS } from './ui.js';
import { J } from './input.js';
import { QUALITY } from './quality.js';
import { pref } from './prefs.js';

const UP = new THREE.Vector3(0, 1, 0);
const _pos = new THREE.Vector3();
const _to = new THREE.Vector3();
const _side = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _loc = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();

// Desktop HUD layout in CSS pixels. main.js replaces the margins with
// app.hudInsets, measured from the HTML tab bar and buttons.
const HUD = { top: 76, bottom: 76, right: 16, minW: 280, maxW: 440 };

// Palm menu: how directly the palm has to face the head to open it and to keep
// it open, and how close to the hand the person has to be looking to open it
// (cosine of the angle between the view direction and the hand, about 50°).
const PALM_OPEN = 0.72;
const PALM_KEEP = 0.4;
const LOOK_OPEN = 0.64;

export class HandMenu {
  constructor(app) {
    this.app = app;
    // anchored at the top edge, so switching pages doesn't move the buttons at the top
    this.panel = app.ui.add(new UIPanel(app.ui, { width: 0.3, name: 'hand-menu', anchor: 'top' }));
    // Drawn over the world: on desktop it's a HUD, and in VR it's always held
    // close in front, where a long page shouldn't disappear into the Hyperplay
    // table. Hands still draw over it.
    this.panel.material.depthTest = false;
    this.panel.group.visible = false;
    this.panel.opacity = 0;
    this.page = 'scene'; // in VR: 'scene', 'scenes' or 'settings'
    this.hiddenT = 0;
    this.pinned = false;
    this.summoned = false; // opened in front of the head with A/X, rather than pinned by hand
    this.owner = null;
    this.showT = 0;
    this.hideT = 0;
    this.shown = false;
    this.inUse = false;
  }

  /**
   * The VR menu has three short pages instead of one long one, since it's held
   * up next to a hand: this scene's options, the list of scenes, and settings.
   * The desktop menu is one page; the HTML HUD has the scene tabs and help.
   */
  rebuild() {
    const app = this.app;
    const scene = app.activeScene;
    if (!scene) return;
    const title = { type: 'title', text: scene.title, sub: scene.subtitle };
    const hint = { type: 'text', text: () => scene.hint(app.inputMode), lines: 5 };
    const quality = [
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
    ];
    let rows;
    if (!app.presenting) {
      rows = [title, ...scene.menuRows(), ...quality, hint];
    } else {
      const page = (label, key) => ({ label, small: true, onClick: () => this.setPage(key), active: () => this.page === key });
      rows = [title, {
        type: 'buttons', columns: 4,
        items: [
          page(scene.short, 'scene'), page('Scenes', 'scenes'), page('Settings', 'settings'),
          { label: () => (this.summoned ? 'Close' : this.pinned ? 'Unpin' : 'Pin'), small: true, onClick: () => this.togglePin(), active: () => this.pinned && !this.summoned },
        ],
      }];
      if (this.page === 'scenes') {
        rows.push({
          type: 'tabs', columns: 2, height: 0.04,
          options: app.sceneList.map((s) => ({ label: s.title || s.short, value: s.key })),
          get: () => app.sceneKey,
          set: (k) => app.setScene(k),
        });
      } else if (this.page === 'settings') {
        rows.push(
          { type: 'buttons', items: [{ label: 'How to play', onClick: () => app.welcome.show() }] },
          ...quality,
          { type: 'text', lines: 1, text: 'Comfort, in scenes you move through' },
          {
            type: 'toggles', columns: 2,
            items: [
              { label: 'Vignette', get: () => app.comfort.vignette, set: (v) => app.setComfort('vignette', v) },
              { label: 'Snap turn', get: () => app.comfort.snapTurn, set: (v) => app.setComfort('snapTurn', v) },
            ],
          },
        );
      } else {
        rows.push(...scene.menuRows(), hint);
      }
    }
    if (app.statsEnabled) rows.push({ type: 'text', text: () => app.statsText, lines: 2, color: COLORS.ink });
    this.panel.setRows(rows);
  }

  setPage(page) {
    if (page === this.page) return;
    this.page = page;
    this.rebuild();
  }

  togglePin() {
    this.pinned = !this.pinned;
    this.summoned = false;
    if (!this.pinned && this.owner === null) this.shown = false;
  }

  /** Pin the menu floating in front of the head, its top edge just above eye level. */
  summonInFront() {
    const cam = this.app.camera;
    const head = this.app.headPosition;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
    fwd.y = 0;
    fwd.normalize();
    this._opening();
    this.panel.group.position.copy(head).addScaledVector(fwd, 0.45).addScaledVector(UP, 0.05);
    this._face(this.panel.group.position, head, 1);
    this.pinned = true;
    this.summoned = true;
    this.shown = true;
  }

  /**
   * After a scene switch the menu shows the new scene's page, and a menu
   * opened with A/X closes (the new scene's tips appear where it was).
   */
  sceneChanged() {
    this.page = 'scene';
    if (!this.summoned) return;
    this.summoned = false;
    this.pinned = false;
    this.shown = false;
  }

  /** A menu that has been closed for a while opens on the scene's page again. */
  _opening() {
    if (this.hiddenT > 2) this.setPage('scene');
    this.hiddenT = 0;
  }

  _face(pos, head, alpha) {
    // Matrix4.lookAt(eye, target) builds a basis whose +Z points from target to
    // eye, so passing (head, pos) turns the panel's front (+Z) towards the head.
    _m.lookAt(head, pos, UP);
    _q.setFromRotationMatrix(_m);
    this.panel.group.quaternion.slerp(_q, alpha);
  }

  /** Is a point (a fingertip) in the space just in front of the panel? */
  _nearPanel(p) {
    const pn = this.panel;
    pn.toPanel(p, _loc);
    const m = 0.06;
    return _loc.x > -m && _loc.x < pn.width + m && _loc.y > -m && _loc.y < pn.height + m && _loc.z > -0.05 && _loc.z < 0.15;
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
    const cy = top; // the panel hangs from its top edge (anchor: 'top')
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
      g.visible = app.desktopMenu && app.hudActive;
      if (g.visible) this._placeHud();
      this.panel.opacity = 1;
      return;
    }
    if (g.parent !== app.ui.root) app.ui.root.add(g);

    // Controllers: A/X toggles a floating menu
    for (const ix of app.input.xr) {
      if (ix.kind === 'controller' && ix.btnA.down) {
        if (this.pinned && this.shown) { this.pinned = false; this.summoned = false; this.shown = false; } else this.summonInFront();
      }
    }

    this.panel.ownerIx = this.pinned ? null : this.owner; // the hand holding the menu can't poke it
    this.inUse = false;
    if (this.pinned) {
      this.shown = true;
    } else {
      // Hands: show the menu next to a hand whose palm faces the head, while
      // the person is looking towards it (a palm turned up at waist height, or
      // while looking at something else, doesn't open it)
      const head = app.headPosition;
      _fwd.set(0, 0, -1).applyQuaternion(app.headQuaternion);
      let cand = null;
      for (const ix of app.input.xr) {
        if (ix.kind !== 'hand' || !ix.jointsValid || ix.grabbed || ix.emptyGrab) continue;
        const showing = this.owner === ix && this.shown;
        if (ix.palmFacingHead < (showing ? PALM_KEEP : PALM_OPEN)) continue;
        if (!showing && _to.subVectors(ix.joints[J.wrist].pos, head).normalize().dot(_fwd) < LOOK_OPEN) continue;
        if (!cand || ix.palmFacingHead > cand.palmFacingHead) cand = ix;
      }
      // The other hand reaching for the open menu keeps it open and holds it
      // still, so a button doesn't drift away from the finger about to press it.
      this.inUse = this.shown && this.panel.opacity > 0.3
        && app.input.xr.some((ix) => ix !== this.owner && ix.active && ix.hasPoke && this._nearPanel(ix.pokePos));
      if (this.inUse) {
        this.showT = 0;
        this.hideT = 0;
      } else if (cand) {
        this.hideT = 0;
        this.showT += dt;
        if (this.showT > 0.12) {
          if (!this.shown || this.owner !== cand) this._snap = true;
          if (!this.shown) this._opening();
          this.shown = true;
          this.owner = cand;
        }
      } else {
        this.showT = 0;
        this.hideT += dt;
        if (this.hideT > 0.25) { this.shown = false; }
      }
      if (this.shown && !this.inUse && this.owner && this.owner.jointsValid) this._follow(this.owner, dt);
    }

    this.hiddenT = this.shown ? 0 : this.hiddenT + dt;
    const target = this.shown ? 1 : 0;
    this.panel.opacity += (target - this.panel.opacity) * Math.min(1, dt * 14);
    g.visible = this.panel.opacity > 0.02;
    const s = 0.92 + 0.08 * this.panel.opacity;
    g.scale.setScalar(s);
  }

  /**
   * Place the panel beside the palm on the side towards the body's midline
   * (the little-finger side), where the other hand can reach all of it without
   * crossing over, rather than towering above the hand. Its top edge is a
   * little above the hand, but not above eye level.
   */
  _follow(o, dt) {
    const app = this.app;
    const head = app.headPosition;
    const wrist = o.joints[J.wrist].pos;
    const knuckle = o.joints[J['middle-finger-phalanx-proximal']].pos;
    _pos.addVectors(wrist, knuckle).multiplyScalar(0.5);
    _side.set(1, 0, 0).applyQuaternion(app.headQuaternion).setY(0).normalize();
    if (o.handedness === 'right') _side.negate();
    _to.subVectors(head, _pos).setY(0).normalize();
    const pn = this.panel;
    const top = Math.min(_pos.y + 0.2, head.y + 0.05);
    _pos.addScaledVector(_side, pn.width / 2 + 0.06).addScaledVector(_to, 0.02);
    _pos.y = top;
    const g = pn.group;
    const a = this._snap ? 1 : 1 - Math.exp(-dt * 16);
    g.position.lerp(_pos, a);
    this._face(g.position, head, this._snap ? 1 : 1 - Math.exp(-dt * 12));
    this._snap = false;
  }
}

const INTRO = '4D objects are shown as their 3D cross-sections, or slices. The fourth direction is called w: +w is ana (pink) and −w is kata (blue).';

// Controls that work the same way in every scene. What pinching empty space or
// the sticks do depends on the scene, so that's in each scene's tips.
const LEGEND = {
  hands: [
    ['Pinch', 'Grab, move and throw, with your thumb and index finger.'],
    ['Middle-finger pinch', 'Turn or move things through w, the fourth direction.'],
    ['Palm to your face', 'Open the menu next to your hand.'],
    ['Fingertip', 'Press buttons. Point and pinch to use distant ones.'],
  ],
  controllers: [
    ['Trigger', 'Grab, move and throw. Point and pull it to use distant objects and buttons.'],
    ['Grip', 'Turn or move things through w, the fourth direction.'],
    ['A or X', 'Open the menu.'],
  ],
};

/** How to play: shown on entering VR, from the menu, and the first time each scene opens. */
export class WelcomePanel {
  constructor(app) {
    this.app = app;
    this.panel = app.ui.add(new UIPanel(app.ui, { width: 0.46, name: 'welcome' }));
    this.panel.group.visible = false;
    this.seen = pref.list('tips'); // scenes whose tips have been shown in this browser
    this.rebuild(true);
  }

  rebuild(intro) {
    const app = this.app;
    const scene = app.activeScene;
    const mode = app.inputMode === 'controllers' ? 'controllers' : 'hands';
    const tips = scene ? scene.hint(mode) : '';
    const done = { type: 'buttons', items: [{ label: 'Got it', onClick: () => this.hide(), active: () => true }], height: 0.042 };
    if (intro || !scene) {
      this.panel.width = 0.46;
      this.panel.setRows([
        { type: 'title', text: '4D VR', sub: 'How to play' },
        { type: 'text', text: INTRO, lines: 3, color: COLORS.ink },
        { type: 'legend', items: LEGEND[mode] },
        ...(scene ? [
          { type: 'spacer', h: 0.004 },
          { type: 'text', text: scene.title, bold: true, lines: 1, color: COLORS.ink },
          { type: 'text', text: tips, lines: 6 },
        ] : []),
        done,
      ]);
    } else {
      const menu = mode === 'controllers' ? 'Press A or X for the menu.' : 'Turn a palm towards your face for the menu.';
      this.panel.width = 0.4;
      this.panel.setRows([
        { type: 'title', text: scene.title, sub: scene.subtitle },
        { type: 'text', text: tips, lines: 7, color: COLORS.ink },
        { type: 'text', text: `${menu} "How to play" in it shows this again.`, lines: 2 },
        done,
      ]);
    }
  }

  /** The full guide: general controls and the current scene's tips. */
  show() {
    this.rebuild(true);
    this._markSeen();
    this._place();
  }

  /** The current scene's tips, the first time it's opened in this browser. Otherwise hide the guide. */
  showSceneTips() {
    const key = this.app.sceneKey;
    if (!key || this.seen.has(key)) { this.hide(); return; }
    this.rebuild(false);
    this._markSeen();
    this._place();
  }

  _markSeen() {
    const key = this.app.sceneKey;
    if (!key || this.seen.has(key)) return;
    this.seen.add(key);
    pref.setList('tips', this.seen);
  }

  _place() {
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
