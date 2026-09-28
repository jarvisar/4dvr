// The menu. In VR, turning a palm towards your face shows a small Menu button
// next to that hand, and tapping it with the other hand opens the menu in
// front of you. A/X does the same on controllers. The menu stays where it
// opened until it's closed (it doesn't follow the hand or the head), and the
// bar under it moves it. On desktop it's a HUD fixed to the camera.
//
// The palm used to open the whole menu next to the hand. That opened every
// time someone looked at their hand, and it invited pinching with the palm
// towards the face, which Quest keeps for its own menu.

import * as THREE from 'three';
import { UIPanel, PanelHandle, COLORS, facePanel } from './ui.js';
import { J } from './input.js';
import { QUALITY } from './quality.js';

const UP = new THREE.Vector3(0, 1, 0);
const _pos = new THREE.Vector3();
const _to = new THREE.Vector3();
const _side = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _loc = new THREE.Vector3();

// Desktop HUD layout in CSS pixels. main.js replaces the margins with
// app.hudInsets, measured from the HTML tab bar and buttons.
const HUD = { top: 76, bottom: 76, right: 16, minW: 280, maxW: 440 };

// The palm button shows when a flat, open hand has its palm towards the head
// (cosine of the angle between the palm normal and the direction to the head)
// while the person looks towards it (cosine of the angle between the view
// direction and the hand, about 37°), for SHOW_DELAY seconds. The looser KEEP
// values keep it up once it's showing.
const PALM_SHOW = 0.72;
const PALM_KEEP = 0.45;
const LOOK_SHOW = 0.8;
const LOOK_KEEP = 0.55;
const FLAT = 0.8;
const SHOW_DELAY = 0.3;
const HIDE_DELAY = 0.35;
// One-handed use: when the other hand hasn't been seen for ALONE_AFTER
// seconds, holding the palm up for DWELL_OPEN seconds opens the menu too. A bar
// under the button fills up meanwhile.
const ALONE_AFTER = 4;
const DWELL_OPEN = 1.5;

// Where the menu opens: this far in front of the head, with its top edge this
// far below eye level. A 50 cm tall page then centers about 30° below eye
// level, where Meta and Microsoft put panels you touch.
const OPEN_DIST = 0.45;
const OPEN_TOP = 0.05;

export class HandMenu {
  constructor(app) {
    this.app = app;
    // anchored at the top edge, so switching pages doesn't move the buttons at the top
    this.panel = app.ui.add(new UIPanel(app.ui, { width: 0.3, name: 'hand-menu', anchor: 'top' }));
    // Drawn over the world, so a long page doesn't disappear into the Hyperplay
    // table. Hands still draw over it.
    this.panel.material.depthTest = false;
    this.panel.group.visible = false;
    this.panel.opacity = 0;
    this.handle = new PanelHandle(app.ui, this.panel);
    app.ui.handles.push(this.handle);
    this.page = 'scene'; // in VR: 'scene', 'scenes' or 'settings'
    this.hiddenT = 0;
    this.shown = false;

    // the Menu / Close button next to a palm
    this.button = app.ui.add(new UIPanel(app.ui, {
      width: 0.09, name: 'palm-button',
      rows: [{ type: 'buttons', height: 0.04, items: [{ label: () => (this.shown ? 'Close' : 'Menu'), onClick: () => this.toggle(this.palm.ix?.palmPos), active: () => !this.shown }] }],
    }));
    this.button.material.depthTest = false;
    this.button.group.visible = false;
    this.button.opacity = 0;
    this.dwellBar = new THREE.Mesh(new THREE.PlaneGeometry(0.062, 0.004), new THREE.ShaderMaterial({
      uniforms: { uFill: { value: 0 }, uOpacity: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform float uFill; uniform float uOpacity; varying vec2 vUv; void main() { vec3 c = vUv.x < uFill ? vec3(0.1, 0.62, 1.0) : vec3(0.23, 0.26, 0.31); gl_FragColor = vec4(c, uOpacity); }',
      transparent: true, depthTest: false, depthWrite: false,
    }));
    this.dwellBar.renderOrder = 21;
    this.dwellBar.position.set(0, -this.button.height / 2 - 0.006, 0.001);
    this.button.group.add(this.dwellBar);
    this.palm = { ix: null, t: 0, hideT: 0, shown: false, dwell: 0, armed: true, seen: [-Infinity, -Infinity] };
  }

  // The VR menu has three short pages instead of one long one. The pages are
  // this scene's options, the list of scenes, and settings. The desktop menu is
  // one page, and the HTML HUD has the scene tabs and help.
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
        items: [page(scene.short, 'scene'), page('Scenes', 'scenes'), page('Settings', 'settings'), { label: 'Close', small: true, onClick: () => this.close() }],
      }];
      if (this.page === 'scenes') {
        rows.push({
          type: 'tabs', columns: 2, height: 0.04,
          options: app.sceneList.map((s) => ({ label: s.title || s.short, value: s.key })),
          get: () => app.sceneKey,
          set: (k) => app.setScene(k),
        });
      } else if (this.page === 'settings') {
        const howTo = { label: 'How to play', onClick: () => { this.close(); app.guide.howToPlay(); } };
        rows.push(
          ...(scene.locomotion ? [{ type: 'buttons', items: [howTo] }] : [
            { type: 'buttons', columns: 2, items: [howTo, { label: 'Recenter', onClick: () => app.refit() }] },
            { type: 'text', lines: 2, text: 'Recenter moves the scene in front of you and fits it to your height, for example after sitting down.' },
          ]),
          ...quality,
          { type: 'text', lines: 3, text: 'Comfort, in scenes you move through. The vignette darkens the edges of your view while you move, and snap turn turns in 30° steps.' },
          {
            type: 'toggles', columns: 2,
            items: [
              { label: 'Vignette', get: () => app.comfort.vignette, set: (v) => app.setComfort('vignette', v) },
              { label: 'Snap turn', get: () => app.comfort.snapTurn, set: (v) => app.setComfort('snapTurn', v) },
            ],
          },
          {
            type: 'toggles', columns: 2,
            items: [{ label: 'Larger menus', get: () => app.largeUI, set: (v) => app.setLargeUI(v) }],
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

  toggle(from) {
    if (this.shown) this.close();
    else this.open(from);
  }

  // Open in front of the head, turned a little towards `from` (the hand or
  // controller that opened it)
  open(from = null) {
    if (this.hiddenT > 2) this.setPage('scene');
    this.hiddenT = 0;
    this._place(from);
    this.shown = true;
    this.app.audio.toggle(true);
    this.app.guide.menuOpened();
  }

  close() {
    if (!this.shown) return;
    this.shown = false;
    this.app.audio.toggle(false);
  }

  _place(from) {
    const app = this.app;
    const head = app.headPosition;
    _fwd.set(0, 0, -1).applyQuaternion(app.headQuaternion).setY(0);
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1); // looking straight up or down
    _fwd.normalize();
    if (from) {
      _to.subVectors(from, head).setY(0);
      if (_to.lengthSq() > 1e-4) {
        // signed angle from the view direction to the hand, about the vertical
        const a = Math.atan2(_fwd.z * _to.x - _fwd.x * _to.z, _fwd.x * _to.x + _fwd.z * _to.z);
        _fwd.applyAxisAngle(UP, THREE.MathUtils.clamp(a * 0.6, -0.45, 0.45));
      }
    }
    const pn = this.panel, g = pn.group;
    const s = app.uiScale;
    let top = head.y - OPEN_TOP;
    // a finger pressing a button that hangs below a table top would disappear into the table
    const floor = app.activeScene?.menuFloorY;
    if (floor !== undefined) top = Math.max(top, floor + pn.height * s);
    g.position.copy(head).addScaledVector(_fwd, OPEN_DIST * Math.sqrt(s));
    g.position.y = top;
    g.scale.setScalar(s);
    facePanel(pn, head);
  }

  // After a scene switch the menu shows the new scene's page. An open menu
  // stays open where it was relative to the person (App moves it).
  sceneChanged() {
    this.page = 'scene';
  }

  // Is a point (a fingertip) just in front of a panel?
  _nearPanel(pn, p, m = 0.06) {
    pn.toPanel(p, _loc);
    return _loc.x > -m && _loc.x < pn.width + m && _loc.y > -m && _loc.y < pn.height + m && _loc.z > -0.05 && _loc.z < 0.15;
  }

  // Desktop only. Parks the panel in camera space so it sits at a fixed spot on
  // screen (right edge, below the tab bar), scaled to fit the viewport.
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
    const d = (ph * H) / (hpx * 2 * tan); // distance at which ph meters spans hpx pixels
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
      this.button.group.visible = false;
      return;
    }
    if (g.parent !== app.ui.root) app.ui.root.add(g);

    // Controllers: A/X opens and closes it
    for (const ix of app.input.xr) {
      if (ix.kind === 'controller' && ix.btnA.down) this.toggle(ix.grabPos);
    }
    this._updatePalm(dt);

    this.hiddenT = this.shown ? 0 : this.hiddenT + dt;
    const target = this.shown ? 1 : 0;
    this.panel.opacity += (target - this.panel.opacity) * Math.min(1, dt * 14);
    g.visible = this.panel.opacity > 0.02;
    g.scale.setScalar((0.92 + 0.08 * this.panel.opacity) * app.uiScale);
  }

  _updatePalm(dt) {
    const app = this.app;
    const P = this.palm;
    const head = app.headPosition;
    _fwd.set(0, 0, -1).applyQuaternion(app.headQuaternion);
    let cand = null;
    for (const ix of app.input.xr) {
      if (ix.kind !== 'hand' || !ix.jointsValid) continue;
      P.seen[ix.index] = app.time;
      if (ix.busy || ix.fist) continue;
      const showing = P.shown && P.ix === ix;
      if (ix.palmFacingHead < (showing ? PALM_KEEP : PALM_SHOW)) continue;
      if (!showing && (ix.openness < FLAT || ix.pinchStrength > 0.5)) continue;
      const look = _to.subVectors(ix.joints[J.wrist].pos, head).normalize().dot(_fwd);
      if (look < (showing ? LOOK_KEEP : LOOK_SHOW)) continue;
      if (!cand || ix.palmFacingHead > cand.palmFacingHead) cand = ix;
    }
    // The other hand reaching for the button keeps it up and holds it still,
    // so it doesn't drift away from the finger about to press it.
    const reaching = P.shown && this.button.opacity > 0.3
      && app.input.xr.some((ix) => ix !== P.ix && ix.active && ix.hasPoke && this._nearPanel(this.button, ix.pokePos, 0.04));
    if (reaching) {
      P.hideT = 0;
    } else if (cand) {
      if (cand !== P.ix) { P.ix = cand; P.t = 0; P.shown = false; }
      P.hideT = 0;
      P.t += dt;
      if (!P.shown && P.t > SHOW_DELAY) { P.shown = true; this._snap = true; }
    } else {
      P.t = 0;
      P.hideT += dt;
      if (P.hideT > HIDE_DELAY) { P.shown = false; P.armed = true; }
    }
    this.button.ownerIx = P.ix; // the hand it's next to can't press it
    if (P.shown && !reaching && P.ix?.jointsValid) this._follow(P.ix, dt);

    // one-handed: hold the palm up to open it
    const other = app.input.xr.find((ix) => ix !== P.ix);
    const alone = P.shown && cand === P.ix && !reaching && !this.shown && P.armed && other
      && app.time - P.seen[other.index] > ALONE_AFTER;
    P.dwell = alone ? P.dwell + dt : 0;
    if (P.dwell > DWELL_OPEN) {
      P.dwell = 0;
      P.armed = false; // the palm has to go down before it can open it again
      this.open(P.ix.palmPos);
    }

    const b = this.button;
    b.opacity += ((P.shown ? 1 : 0) - b.opacity) * Math.min(1, dt * 16);
    b.group.visible = b.opacity > 0.02;
    b.group.scale.setScalar((0.85 + 0.15 * b.opacity) * app.uiScale);
    const bar = this.dwellBar.material.uniforms;
    bar.uFill.value = P.dwell / DWELL_OPEN;
    bar.uOpacity.value = P.dwell > 0.15 ? b.opacity : 0;
  }

  // Keep the button beside the palm on the side towards the body's midline
  // (the little-finger side), where the other hand reaches it without crossing
  // over, and away from the thumb and index where Quest shows its own menu icon.
  _follow(o, dt) {
    const app = this.app;
    const head = app.headPosition;
    const wrist = o.joints[J.wrist].pos;
    const knuckle = o.joints[J['middle-finger-phalanx-proximal']].pos;
    _pos.addVectors(wrist, knuckle).multiplyScalar(0.5);
    _side.set(1, 0, 0).applyQuaternion(app.headQuaternion).setY(0).normalize();
    if (o.handedness === 'right') _side.negate();
    _to.subVectors(head, _pos).normalize();
    _pos.addScaledVector(_side, 0.1 * app.uiScale).addScaledVector(_to, 0.03).addScaledVector(UP, 0.02);
    const g = this.button.group;
    g.position.lerp(_pos, this._snap ? 1 : 1 - Math.exp(-dt * 18));
    facePanel(this.button, head, this._snap ? 1 : 1 - Math.exp(-dt * 12));
    this._snap = false;
  }
}
