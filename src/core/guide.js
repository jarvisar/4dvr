// Guidance in VR: a tutorial the first time Hyperplay is opened, a card with a
// scene's tips the first time it's opened, the "How to play" card, and a short
// reminder of how to open the menu for people who've done the tutorial.
//
// The tutorial teaches one thing at a time and moves on once it's been done.
// A see-through hand shows each hand gesture, the fingers to use pulse on the
// tracked hands, and controllers get a label for the button. A scene with a
// tutorial provides tutorial(), demoTarget(kind, out) and guideAnchor(out).

import * as THREE from 'three';
import { UIPanel, COLORS, facePanel } from './ui.js';
import { GhostHand } from './handVisuals.js';
import { blendPose, pinchPoint } from './handPoses.js';
import { J } from './input.js';
import { pref } from './prefs.js';

const INTRO = '4D objects are shown as their 3D cross-sections, or slices. The fourth direction is called w: +w is ana (pink) and −w is kata (blue).';
export const POINTER_HINT = 'Point and select to grab objects or press buttons. The Menu button below your view opens scene options. Some actions need tracked hands or controllers.';

// Controls that work the same way in every scene. What pinching empty space or
// the sticks do depends on the scene, so that's in each scene's tips.
const LEGEND = {
  pointers: [
    ['Point and select', 'Grab objects and press buttons. Hold select to move what you grabbed.'],
    ['Menu below your view', 'Select it for scene options and settings.'],
  ],
  hands: [
    ['Pinch or grab', 'Pick things up and move them.'],
    ['Middle-finger pinch', 'Turn or move things through w, the fourth direction.'],
    ['Palm toward you', 'Shows a Menu button. Tap it with your other hand.'],
    ['Fingertip', 'Press buttons. Point and pinch to use distant ones.'],
  ],
  controllers: [
    ['Trigger or grip', 'Pick things up and move them. Point at distant things and buttons to use them.'],
    ['Trigger and grip', 'Hold both to turn or move things through w, the fourth direction.'],
    ['A or X', 'Open or close the menu.'],
  ],
};
const MENU_HOW = {
  pointers: 'Select the Menu button below your view to open the menu.',
  hands: 'Turn a palm toward you and tap Menu with your other hand to open the menu.',
  controllers: 'Press A or X to open the menu.',
};

// Cards you read and press open this far in front, this far below eye level
// (their center, about 21° down) and turned this far to the left (about 32°),
// so they're in reach and mostly beside a scene's exhibit, not on top of it
const CARD_DIST = 0.45;
const CARD_DROP = 0.17;
const CARD_TURN = 0.55;
// The tutorial card floats over the far side of the Hyperplay table, about
// 1.2 m away, so it's drawn larger. Its text is then about 1.2° tall.
const TUTORIAL_SCALE = 2.3;
const REMINDER_TIME = 8;
const STEP_PAUSE = 1.2; // seconds a finished step stays up before the next one

const TIPS_INDEX = [J['thumb-tip'], J['index-finger-tip']];
const TIPS_MIDDLE = [J['thumb-tip'], J['middle-finger-tip']];
const CYAN = new THREE.Color('#33c3ff');
const PINK = new THREE.Color('#ff4f9a');

const UP = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _f = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _p = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();

const ease = (t) => THREE.MathUtils.smoothstep(t, 0, 1);
// 0 to 1 over [a, b]
const span = (t, a, b) => THREE.MathUtils.clamp((t - a) / (b - a), 0, 1);

export class Guide {
  constructor(app) {
    this.app = app;
    this.panel = app.ui.add(new UIPanel(app.ui, { width: 0.4, name: 'guide' }));
    // Drawn over the world like the menu, so an exhibit or the table doesn't cut through it
    this.panel.material.depthTest = false;
    this.panel.group.visible = false;
    this.seen = pref.list('tips'); // scenes whose tips have been shown in this browser
    this.mode = null; // 'tutorial', 'tips', 'controls', 'reminder' or null
    this.shownT = 0;
    this.tut = null;
    this._tutorialNext = false;

    this.ghost = new GhostHand(app.scene);
    this._pose = Array.from({ length: 25 }, () => new THREE.Vector3());
    this._demo = { t: 0, kind: null, hand: 'right', a: new THREE.Vector3(), b: new THREE.Vector3(), q0: new THREE.Quaternion(), q1: new THREE.Quaternion(), pos: new THREE.Vector3() };
    // the Menu button next to the demonstration hand. Only for show.
    this.demoButton = app.ui.add(new UIPanel(app.ui, { width: 0.09, name: 'demo-button', rows: [{ type: 'buttons', height: 0.04, items: [{ label: 'Menu', onClick: () => {}, active: () => true }] }] }));
    this.demoButton.interactive = false;
    this.demoButton.material.depthTest = false;
    this.demoButton.group.visible = false;
  }

  get _input() { return this.app.inputMode === 'controllers' ? 'controllers' : this.app.inputMode === 'pointers' ? 'pointers' : 'hands'; }

  _hint(scene, input) { return input === 'pointers' ? POINTER_HINT : scene.hint(input); }

  // Entering VR, once the head pose is known
  sessionStarted() {
    const scene = this.app.activeScene;
    if (!pref.get('tutorial', false)) {
      if (scene?.tutorial) this.startTutorial();
      else this.showControls();
    } else {
      this.showReminder();
    }
  }

  sessionEnded() {
    this.tut = null;
    this.mode = null;
    this.panel.group.visible = false;
    this.ghost.hide();
    this.demoButton.group.visible = false;
    this.app.hands.fingerHint = null;
  }

  // After switching scenes in VR
  sceneEntered() {
    const app = this.app;
    const scene = app.activeScene;
    const key = app.sceneKey;
    if (this.tut) this.stopTutorial(); // left in the middle. "How to play" starts it again.
    if (scene?.tutorial && (this._tutorialNext || !pref.get('tutorial', false))) {
      this._tutorialNext = false;
      this.startTutorial();
      return;
    }
    this._tutorialNext = false;
    // an open menu already shows the new scene's tips on its first page
    if (!key || this.seen.has(key) || app.menu.shown) {
      this._markSeen();
      this.hide();
      return;
    }
    this.showTips();
  }

  // "How to play" in the menu
  howToPlay() {
    if (this.app.activeScene?.tutorial) this.startTutorial();
    else this.showControls();
  }

  menuOpened() {
    // the menu opens in the same spot as these cards, and has the same tips
    if (this.mode === 'tips' || this.mode === 'controls' || this.mode === 'reminder') this.hide();
  }

  hide() {
    this.panel.group.visible = false;
    if (this.mode !== 'tutorial') this.mode = null;
  }

  // --- cards ---------------------------------------------------------------------

  showTips() {
    const app = this.app;
    const scene = app.activeScene;
    if (!scene) return;
    const input = this._input;
    this.panel.width = 0.4;
    this.panel.setRows([
      { type: 'title', text: scene.title, sub: scene.subtitle },
      { type: 'text', text: this._hint(scene, input), lines: 7, color: COLORS.ink },
      { type: 'text', text: `${MENU_HOW[input]} "How to play" in its settings shows this again.`, lines: 3 },
      { type: 'buttons', items: [{ label: 'Got it', onClick: () => this.hide(), active: () => true }], height: 0.042 },
    ]);
    this._markSeen();
    this._show('tips');
  }

  // General controls and this scene's tips
  showControls() {
    const app = this.app;
    const scene = app.activeScene;
    const input = this._input;
    const buttons = [{ label: 'Got it', onClick: () => this.hide(), active: () => true }];
    if (!scene?.tutorial && input !== 'pointers') buttons.push({ label: 'Tutorial', onClick: () => this._tutorialElsewhere() });
    this.panel.width = 0.46;
    this.panel.setRows([
      { type: 'title', text: 'How to play', sub: scene ? scene.title : '' },
      // only where things are shown as slices. Elsewhere pink and blue mean other things.
      ...(scene?.crossSections ? [{ type: 'text', text: INTRO, lines: 3, color: COLORS.ink }] : []),
      { type: 'legend', items: LEGEND[input] },
      ...(scene ? [{ type: 'spacer', h: 0.004 }, { type: 'text', text: this._hint(scene, input), lines: 6 }] : []),
      { type: 'buttons', columns: buttons.length, items: buttons, height: 0.042 },
    ]);
    this._markSeen();
    this._show('controls');
  }

  // For people who've done the tutorial before
  showReminder() {
    this.panel.width = 0.3;
    this.panel.setRows([{ type: 'text', text: MENU_HOW[this._input], lines: 3, color: COLORS.ink, align: 'center' }]);
    this._show('reminder');
  }

  // The tutorial is in Hyperplay, so go there first
  _tutorialElsewhere() {
    this.hide();
    const def = this.app.sceneList.find((s) => s.key === 'playground');
    if (!def) return;
    this._tutorialNext = true;
    this.app.setScene(def.key);
  }

  _markSeen() {
    const key = this.app.sceneKey;
    if (!key || this.seen.has(key)) return;
    this.seen.add(key);
    pref.setList('tips', this.seen);
  }

  _show(mode) {
    this.mode = mode;
    this.shownT = 0;
    this._shownInput = this._input;
    const app = this.app;
    const head = app.headPosition;
    const g = this.panel.group;
    _fwd.set(0, 0, -1).applyQuaternion(app.headQuaternion).setY(0);
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize().applyAxisAngle(UP, CARD_TURN);
    g.scale.setScalar(app.uiScale);
    g.position.copy(head).addScaledVector(_fwd, CARD_DIST * Math.sqrt(app.uiScale));
    g.position.y -= mode === 'reminder' ? CARD_DROP + 0.05 : CARD_DROP;
    facePanel(this.panel, head);
    g.visible = true;
    this.panel.opacity = 1;
  }

  // --- tutorial ----------------------------------------------------------------------

  startTutorial() {
    const app = this.app;
    const scene = app.activeScene;
    if (!scene?.tutorial) return;
    app.menu.close();
    if (this._input === 'pointers') {
      this.tut = null;
      this.ghost.hide();
      this.demoButton.group.visible = false;
      app.hands.fingerHint = null;
      this.showControls();
      return;
    }
    this.tut = { steps: scene.tutorial(), i: 0, doneT: -1, finished: false, finishT: 0 };
    this._markSeen();
    this.mode = 'tutorial';
    this._demo.t = 0;
    this._demo.kind = null;
    this._buildStep();
    this.panel.group.visible = true;
    this.panel.opacity = 1;
  }

  // Ends the tutorial, finished or not. It isn't started again automatically.
  stopTutorial() {
    pref.set('tutorial', true);
    this.tut = null;
    this.mode = null;
    this.panel.group.visible = false;
    this.ghost.hide();
    this.demoButton.group.visible = false;
    this.app.hands.fingerHint = null;
  }

  _buildStep() {
    const t = this.tut;
    const input = this._input;
    this._builtInput = input;
    this.panel.width = 0.27;
    if (t.finished) {
      this.panel.setRows([
        { type: 'title', text: 'Tutorial done', sub: '' },
        { type: 'text', text: 'The menu has presets, the other scenes and settings. "How to play" in its settings runs this again.', lines: 4, color: COLORS.ink },
        { type: 'buttons', items: [{ label: 'Close', onClick: () => this.stopTutorial(), active: () => true }], height: 0.036 },
      ]);
      return;
    }
    const step = t.steps[t.i];
    this.panel.setRows([
      { type: 'title', text: step.title, sub: () => (t.doneT >= 0 ? 'Done' : `Step ${t.i + 1} of ${t.steps.length}`) },
      { type: 'text', text: step.text[input], lines: 5, color: COLORS.ink },
      { type: 'buttons', items: [{ label: 'Skip tutorial', small: true, onClick: () => this.stopTutorial() }], height: 0.032 },
    ]);
  }

  update(dt) {
    const app = this.app;
    if (!app.presenting) {
      if (this.panel.group.visible) this.hide();
      this.ghost.hide();
      this.demoButton.group.visible = false;
      return;
    }
    this.shownT += dt;
    if (this.mode === 'tutorial' && this.tut) {
      if (this._input === 'pointers') {
        this.tut = null;
        this.ghost.hide();
        this.demoButton.group.visible = false;
        this.app.hands.fingerHint = null;
        this.showControls();
        return;
      }
      // a scene switch stops it in sceneEntered(), but that's a frame later
      if (!app.activeScene?.tutorial) { this.stopTutorial(); return; }
      this._updateTutorial(dt);
      return;
    }
    if (!this.panel.group.visible) return;
    if (this._shownInput !== this._input) {
      // switched between hands and controllers while it was up
      if (this.mode === 'tips') this.showTips();
      else if (this.mode === 'controls') this.showControls();
      else if (this.mode === 'reminder') this.showReminder();
    }
    const busy = app.input.xr.some((ix) => ix.grabbed || ix.emptyGrab);
    if (this.mode === 'reminder' && (this.shownT > REMINDER_TIME || busy)) this.hide();
    // Tips go away once the person starts doing something. They're on the menu's first page too.
    if ((this.mode === 'tips' || this.mode === 'controls') && this.shownT > 1.5 && busy) this.hide();
  }

  _updateTutorial(dt) {
    const app = this.app;
    const t = this.tut;
    const scene = app.activeScene;
    const input = this._input;
    if (this._builtInput !== input) this._buildStep();
    // The menu opens in front of the card and the demonstration hand, so they
    // wait while it's open. The last step opens it, so the "Tutorial done"
    // card shows once it's closed.
    const menuOpen = app.menu.shown;
    this.panel.group.visible = !menuOpen;

    if (t.finished) {
      if (!menuOpen) t.finishT += dt;
      app.hands.fingerHint = null;
      this.ghost.hide();
      this.demoButton.group.visible = false;
      if (t.finishT > 15) this.stopTutorial();
      else this._placeTutorialCard();
      return;
    }

    const step = t.steps[t.i];
    if (t.doneT < 0 && step.done(dt)) {
      t.doneT = 0;
      app.audio.spawn();
      for (const ix of app.input.xr) ix.pulse(0.4, 60);
    }
    if (t.doneT >= 0) {
      t.doneT += dt;
      if (t.doneT > STEP_PAUSE) {
        t.i++;
        t.doneT = -1;
        this._demo.kind = null;
        if (t.i >= t.steps.length) {
          t.finished = true;
          pref.set('tutorial', true); // even if the session ends before the card is closed
        } else t.steps[t.i].start?.();
        this._buildStep();
        return;
      }
    }

    const active = t.doneT < 0 && !menuOpen;
    app.hands.fingerHint = active && input === 'hands' && step.fingers
      ? { joints: step.fingers === 'middle' ? TIPS_MIDDLE : TIPS_INDEX, color: step.fingers === 'middle' ? PINK : CYAN }
      : null;
    if (active && input === 'controllers' && step.tag) {
      for (const ix of app.input.xr) {
        if (ix.kind === 'controller' && ix.active && !ix.busy) app.hands.tag(ix, step.tag);
      }
    }
    if (active && input === 'hands' && step.demo) this._updateDemo(dt, step.demo, scene);
    else { this.ghost.hide(); this.demoButton.group.visible = false; }
    this._placeTutorialCard();
  }

  _placeTutorialCard() {
    const app = this.app;
    const g = this.panel.group;
    if (!app.activeScene.guideAnchor(g.position)) return;
    g.scale.setScalar(TUTORIAL_SCALE * app.uiScale);
    facePanel(this.panel, app.headPosition);
  }

  // --- demonstration hand ----------------------------------------------------------

  // Sets up one loop of a demo: which hand, where it starts and ends, and how it's turned
  _planDemo(kind, scene) {
    const app = this.app;
    const d = this._demo;
    const head = app.headPosition;
    _fwd.set(0, 0, -1).applyQuaternion(app.headQuaternion).setY(0).normalize();
    _right.set(-_fwd.z, 0, _fwd.x);
    if (kind === 'palm') {
      d.hand = 'left';
      d.pos.copy(head).addScaledVector(_fwd, 0.34).addScaledVector(_right, -0.12).addScaledVector(UP, -0.3);
      // from palm down with the fingers forward, to the palm facing the head with the fingers up
      this._basis(d.q0, _f.copy(_fwd).addScaledVector(UP, -0.3).normalize(), UP);
      _p.subVectors(head, d.pos).normalize();
      this._basis(d.q1, UP, _y.copy(_p).negate());
      return true;
    }
    if (!scene.demoTarget(kind, d.pos)) return false;
    // the hand on the target's side
    d.hand = _p.subVectors(d.pos, head).dot(_right) < -0.05 ? 'left' : 'right';
    const shoulder = _x.copy(head).addScaledVector(_right, d.hand === 'left' ? -0.17 : 0.17).addScaledVector(UP, -0.22);
    // fingers toward the target from the shoulder, palm down
    if (kind === 'air') _f.copy(_fwd).addScaledVector(UP, -0.35).normalize();
    else _f.subVectors(d.pos, shoulder).normalize();
    this._basis(d.q0, _f, UP);
    d.q1.copy(d.q0);
    // wrist where the pinch point lands on the target, and a start point back and up from it
    d.b.copy(d.pos).sub(pinchPoint(d.hand, _p).applyQuaternion(d.q0));
    d.a.copy(d.b).addScaledVector(_f, -0.1).addScaledVector(UP, 0.07);
    return true;
  }

  // Wrist rotation with the fingers (-z) along `fingers` and the back of the hand (+y) toward `back`
  _basis(out, fingers, back) {
    _z.copy(fingers).negate();
    _y.copy(back).addScaledVector(_z, -back.dot(_z)).normalize();
    _x.crossVectors(_y, _z);
    return out.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
  }

  _updateDemo(dt, kind, scene) {
    const d = this._demo;
    const LOOP = { grab: 3.4, air: 4.2, palm: 3.8 }[kind];
    d.t += dt;
    if (d.kind !== kind || d.t >= LOOP) {
      d.t = d.kind === kind ? d.t % LOOP : 0;
      d.kind = kind;
      if (!this._planDemo(kind, scene)) { d.kind = null; this.ghost.hide(); return; }
    }
    const t = d.t;
    let pinch = 0, opacity = 0;
    const wrist = _p;
    _q.copy(d.q0);
    if (kind === 'grab') {
      // reach in, pinch, hold, let go, back out
      opacity = Math.min(span(t, 0, 0.3), 1 - span(t, 2.1, 2.5));
      wrist.lerpVectors(d.a, d.b, ease(span(t, 0.3, 1.0) - span(t, 2.1, 2.5)));
      pinch = ease(span(t, 1.0, 1.3) - span(t, 1.8, 2.1));
    } else if (kind === 'air') {
      // pinch, up, down, back to the middle, let go
      opacity = Math.min(span(t, 0, 0.3), 1 - span(t, 3.1, 3.4));
      pinch = ease(span(t, 0.3, 0.6) - span(t, 2.8, 3.1));
      const y = 0.08 * (ease(span(t, 0.6, 1.2)) - 2 * ease(span(t, 1.2, 2.2)) + ease(span(t, 2.2, 2.8)));
      wrist.copy(d.b).addScaledVector(UP, y);
    } else {
      // turn the palm toward the face, then the Menu button shows next to it
      opacity = Math.min(span(t, 0, 0.3), 1 - span(t, 2.9, 3.2));
      _q.slerpQuaternions(d.q0, d.q1, ease(span(t, 0.3, 1.1)));
      wrist.copy(d.pos);
    }
    blendPose(this._pose, 'relaxed', 'pinch', pinch, d.hand);
    this.ghost.set(this._pose, wrist, _q, opacity);

    const b = this.demoButton;
    const show = kind === 'palm' && t > 1.3 && t < 3.2;
    b.group.visible = show;
    if (show) {
      const app = this.app;
      _right.set(1, 0, 0).applyQuaternion(app.headQuaternion).setY(0).normalize();
      b.group.position.copy(d.pos).addScaledVector(UP, 0.09).addScaledVector(_right, 0.08);
      b.opacity = Math.min(span(t, 1.3, 1.5), 1 - span(t, 2.9, 3.2)) * 0.7;
      b.group.scale.setScalar(app.uiScale);
      facePanel(b, app.headPosition);
    }
  }
}
