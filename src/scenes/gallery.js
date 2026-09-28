// Polytope Lab: regular 4-polytopes and curved 4D shapes, shown as rotatable
// projections. In perspective mode the cross-section is drawn inside the
// projection at the matching scale.

import * as THREE from 'three';
import * as R4 from '../math/rot4.js';
import { SceneBase, makeLabel, disposeLabel } from './base.js';
import { ProjectedWire } from '../four/projection.js';
import { Object4D } from '../four/object4d.js';
import { SliceView } from '../four/sliceView.js';
import * as P from '../four/polytopes.js';
import { tesseractNet } from '../four/tesseractNet.js';
import { raySphere } from '../core/interaction.js';
import { GHOST_STYLE } from '../four/sliceMaterial.js';
import { REDUCED_MOTION } from '../core/prefs.js';

const POLYS = {
  simplex: { label: '5-cell', get: P.simplex, blurb: '4D simplex. 5 tetrahedral cells.' },
  tesseract: { label: 'Tesseract', get: P.tesseract, blurb: '4D cube. 8 cubic cells.' },
  orthoplex: { label: '16-cell', get: P.orthoplex, blurb: '4D cross-polytope. 16 tetrahedral cells, dual of the tesseract.' },
  icositetrachoron: { label: '24-cell', get: P.icositetrachoron, blurb: '24 octahedral cells. Self-dual, with no 3D equivalent.' },
  hecatonicosachoron: { label: '120-cell', get: P.hecatonicosachoron, blurb: '120 dodecahedral cells, three around each edge.' },
  hexacosichoron: { label: '600-cell', get: P.hexacosichoron, blurb: '600 tetrahedral cells, twenty around each vertex.' },
  duoprism: { label: '6-6 duoprism', short: 'Duoprism', get: () => P.duoprism(6, 6), blurb: 'Product of two hexagons. 12 hexagonal prism cells.' },
};
const SMOOTH = {
  duocylinder: 'Product of two discs. Its two curved cells meet at a flat torus.',
  tiger: 'Points within a fixed distance of a flat torus. Its surface is a 3-torus, and its cross-sections are often two tori.',
  spheritorus: 'Points within a fixed distance of a circle. Cross-sections are tori or pairs of spheres.',
  torisphere: 'Points within a fixed distance of a 2-sphere. Cross-sections are spherical shells, tori or spheres.',
  cubinder: 'Product of a disc and a square.',
  spherinder: 'Product of a ball and a line segment.',
};
const LABELS = { duocylinder: 'Duocylinder', tiger: 'Tiger', spheritorus: 'Spheritorus', torisphere: 'Torisphere', cubinder: 'Cubinder', spherinder: 'Spherinder' };

const EW = [0, 0, 0, 1];
const AIR_DEADZONE = 0.012; // meters a pinch in empty space moves before it does anything
const NAMEPLATE_OUT = 0.205; // nameplate's distance from the column's axis (radius there about 0.163)
const _E = R4.mat4();
const _M = R4.mat4();
const _M2 = R4.mat4();
const _q = new THREE.Quaternion();
const _hp = new THREE.Vector3();
const _hq = new THREE.Quaternion();

export class GalleryScene extends SceneBase {
  constructor(app) {
    super(app);
    this.key = 'gallery';
    this.title = 'Polytope Lab';
    this.short = 'Polytopes';
    this.subtitle = 'Regular 4-polytopes, projected and sliced';
    this.mood = 'dusk';

    this.center = new THREE.Vector3(0, 1.3, -0.62);
    this.S = 0.19; // meters per unit in the projection
    this.eye = 2.4;
    this.R = R4.mat4();
    R4.multiply(this.R, R4.planeRotation(R4.mat4(), 0, 3, 0.35), R4.planeRotation(R4.mat4(), 1, 2, 0.5));
    this.spin = R4.biv();
    this.auto = !REDUCED_MOTION;
    this.mode = 'perspective';
    this.showFaces = true;
    this.showSlice = true;
    this.sliceW = 0;
    this.fold = 1;
    this.foldAnim = null;
    this.shapeKey = 'tesseract';
    this.faceAlpha = 0.09;

    this.pivot = new THREE.Group();
    this.root.add(this.pivot);
    this.wire = new ProjectedWire();
    this.pivot.add(this.wire.group);
    this.sliceView = new SliceView();
    this.sliceView.wMin = -10; this.sliceView.wMax = 10;
    this.sliceObjs = new Map();

    this._buildPedestal();
    this.handle = this._makeHandle();
    this.interactables = [this.handle];
    this.setShape('tesseract');
    this._layout();

    this.desktopView = { position: new THREE.Vector3(0, 1.42, 0.12), target: this.center.clone() };
  }

  _buildPedestal() {
    const mat = new THREE.MeshStandardMaterial({ color: '#1a1d26', roughness: 0.55, metalness: 0.3 });
    const topR = 0.16, tube = 0.006;
    this.column = new THREE.Mesh(new THREE.CylinderGeometry(topR, 0.2, 1, 48), mat); // tapers towards the top
    // a bead around the top edge, flush with it, and the glow inside it
    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(topR - tube, tube, 12, 96).rotateX(Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: '#eceef4', toneMapped: false }),
    );
    this.glow = new THREE.Mesh(
      new THREE.CircleGeometry(topR - 2 * tube, 48).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: '#9fb8ff', transparent: true, opacity: 0.08, depthWrite: false, toneMapped: false }),
    );
    this.root.add(this.column, this.ring, this.glow);
    this.nameplate = null;
  }

  _layout() {
    const c = this.center;
    this.pivot.position.copy(c);
    const topY = c.y - 0.42;
    this.column.scale.y = topY;
    this.column.position.set(c.x, topY / 2, c.z);
    this.ring.position.set(c.x, topY + 0.002, c.z);
    this.glow.position.set(c.x, topY + 0.003, c.z);
    if (this.nameplate) this.nameplate.position.set(c.x, topY - 0.06, c.z + NAMEPLATE_OUT); // update() keeps it on the viewer's side
    this.app.env.aimSun(c);
    if (this.desktopView) this.desktopView.target.copy(c);
  }

  onUserReady() {
    this.center.y = THREE.MathUtils.clamp(this.app.headPosition.y - 0.3, 1.0, 1.6);
    this._layout();
  }

  enter() {
    super.enter();
    GHOST_STYLE.uGhostAdd.value = 0.7;
    this._layout();
  }

  exit() {
    super.exit();
    GHOST_STYLE.uGhostAdd.value = 0;
  }

  get isPolytope() { return !!POLYS[this.shapeKey]; }
  get isNet() { return this.shapeKey === 'net'; }

  setShape(key) {
    this.shapeKey = key;
    let info;
    if (POLYS[key]) {
      const poly = POLYS[key].get();
      const big = poly.faces.length > 200;
      this.wire.setGeometry(poly, { faceSubdiv: big ? 1 : 2 });
      this.wire.edgeMat.uniforms.uRadius.value = big ? 0.0022 : 0.0034;
      this.wire.vertMat.uniforms.uRadius.value = big ? 0.0034 : 0.0065;
      this.faceAlpha = big ? 0.028 : 0.06;
      info = `${POLYS[key].label} · ${poly.vertices.length} vertices · ${poly.edges.length} edges · ${poly.faces.length} faces · ${poly.cells.length} cells`;
      if (this.mode === 'slice' && this._forcedSlice) { this.mode = 'perspective'; this._forcedSlice = false; }
    } else if (key === 'net') {
      this.fold = 0;
      this._netFold = null;
      this._netStereo = null;
      this.foldAnim = { from: 0, to: 1, t: 0, delay: 0.8 };
      this._updateNet();
      this.wire.edgeMat.uniforms.uRadius.value = 0.0034;
      this.wire.vertMat.uniforms.uRadius.value = 0.006;
      this.faceAlpha = 0.1;
      R4.identity(this.R);
      R4.multiply(this.R, R4.planeRotation(R4.mat4(), 1, 2, -0.35), R4.planeRotation(R4.mat4(), 0, 2, 0.5));
      this.spin.fill(0);
      this.auto = false;
      if (this.mode !== 'perspective') this.mode = 'perspective';
      this._forcedSlice = false;
      info = 'Tesseract net · 8 cubes';
    } else {
      this.wire.setGeometry({ vertices: [], edges: [], faces: [] });
      if (this.mode !== 'slice') { this.mode = 'slice'; this._forcedSlice = true; }
      info = `${LABELS[key]} · a curved 4D solid`;
    }
    for (const [k, o] of this.sliceObjs) o.group.visible = false;
    if (key !== 'net') {
      let o = this.sliceObjs.get(key);
      if (!o) {
        o = new Object4D(key, { scale: this.S, ghosts: false, opacity: 0.82 });
        o.mesh.renderOrder = 9; // after the additive faces, so the slice keeps its colors
        // A curved shape's slice can be two tori or a torus in a shell, and its
        // triangles aren't drawn back to front. Without depth writes, a far
        // surface drawn later would cover a nearer one.
        o.mats.solid.depthWrite = true;
        this.pivot.add(o.group);
        this.sliceObjs.set(key, o);
      }
      o.group.visible = true;
    }
    this.info = info;
    disposeLabel(this.nameplate);
    this.nameplate = makeLabel(POLYS[key]?.label || LABELS[key] || 'Tesseract net', { size: 0.024, color: '#e8eaf0' });
    this.root.add(this.nameplate);
    this._layout();
    if (this.app.activeScene === this) this.app.menu.rebuild();
  }

  _updateNet() {
    // only rebuild while folding, or when the projection changes
    const stereo = this.mode === 'stereo';
    if (this.fold === this._netFold && stereo === this._netStereo) return;
    this._netFold = this.fold;
    this._netStereo = stereo;
    const net = tesseractNet(this.fold);
    // stereographic edges are arcs, so the faces are curved to meet them
    this.wire.setGeometry(net, { faceSubdiv: stereo ? 2 : 0, edgeColors: net.edgeColors, faceColors: net.faceColors });
  }

  _makeHandle() {
    const scene = this;
    return {
      nearDistance(p) {
        // only the inner 80% grabs the shape. Pinching outside that is an empty-space gesture.
        const r = scene._radius() * 0.8;
        const d = p.distanceTo(scene.center) - r;
        return d < 0 ? -0.001 : d;
      },
      rayDistance(o, d) { return raySphere(o, d, scene.center, scene._radius()); },
      onHover(ix, on) { scene.hover = on; },
      onGrabStart(ix, mode, kind) {
        scene.grab = { ix, mode, kind, startR: R4.copy(R4.mat4(), scene.R), prevR: R4.copy(R4.mat4(), scene.R) };
        ix.pose(kind, _hp, _hq);
        scene.grab.startHand = _hp.clone();
        scene.grab.startQInv = _hq.clone().invert();
        scene.spin.fill(0);
      },
      onGrabUpdate(ix, dt) {
        if (scene.grab?.ix !== ix) return;
        scene._grabUpdate(ix, dt);
        if (scene.grab?.mode === 'secondary') scene.app.hands.readout(ix, 'turning through w');
      },
      onGrabEnd(ix) { if (scene.grab?.ix === ix) scene.grab = null; },
    };
  }

  _radius() {
    const ext = this.mode === 'stereo' ? 1.4 : this.mode === 'slice' ? 1.0 : this.eye / (this.eye - 1);
    return Math.min(0.42, this.S * ext * (this.mode === 'slice' ? 1.6 : 1));
  }

  _grabUpdate(ix, dt) {
    const g = this.grab;
    ix.pose(g.kind, _hp, _hq);
    const dq = _q.copy(_hq).multiply(g.startQInv);
    R4.fromQuaternion(_E, dq);
    R4.multiply(_M, _E, g.startR);
    if (g.mode === 'secondary' || g.air) {
      const d = _hp.clone().sub(g.startHand);
      const len = d.length();
      if (len > 1e-4) {
        R4.rotationInPlane(_M2, EW, [d.x / len, d.y / len, d.z / len, 0], len / (ix.isMouse ? 0.25 : 0.12));
        R4.multiply(_M, _M2, g.air ? g.startR : _M);
      }
    }
    // angular velocity estimate, used for inertia after release
    R4.transpose(_M2, this.R);
    R4.multiply(_M2, _M, _M2);
    const inv = 1 / Math.max(dt, 1e-3);
    for (let k = 0; k < 6; k++) {
      const [i, j] = R4.PLANES[k];
      const w = (_M2[i * 4 + j] - _M2[j * 4 + i]) * 0.5 * inv;
      this.spin[k] = this.spin[k] * 0.6 + w * 0.4;
    }
    R4.copy(this.R, _M);
  }

  // --- air gestures -----------------------------------------------------------

  onEmptyGrabStart(ix, mode) {
    ix.pose('near', _hp, _hq);
    this.pending = { mode, start: _hp.clone() };
    return true;
  }

  // The gesture starts once the hand has moved a little, from where it is
  // then, so a pinch that just missed the shape changes nothing.
  _beginAir(ix, mode) {
    ix.pose('near', _hp, _hq);
    if (mode === 'primary') {
      this.air = { ix, start: _hp.clone(), w: this.sliceW };
    } else if (!this.grab) { // not while the other hand holds the shape
      this.grab = { ix, mode, kind: 'near', air: true, startR: R4.copy(R4.mat4(), this.R), startHand: _hp.clone(), startQInv: _hq.clone().invert() };
      this.spin.fill(0);
    }
  }

  onEmptyGrabUpdate(ix, mode, dt) {
    if (this.pending) {
      ix.pose('near', _hp, _hq);
      if (_hp.distanceTo(this.pending.start) < AIR_DEADZONE) return;
      this.pending = null;
      this._beginAir(ix, mode);
      return;
    }
    if (mode === 'primary' && this.air) {
      ix.pose('near', _hp, _hq);
      this.sliceW = THREE.MathUtils.clamp(this.air.w + (_hp.y - this.air.start.y) * (ix.isMouse ? 3 : 5), -1.05, 1.05);
      this.app.hands.readout(ix, `slice w ${this.sliceW >= 0 ? '+' : '−'}${Math.abs(this.sliceW).toFixed(2)}`, this.sliceW > 0.005 ? '#ff8fbf' : this.sliceW < -0.005 ? '#7fd8ff' : '#ffffff');
    } else if (this.grab?.air && this.grab.ix === ix) {
      this._grabUpdate(ix, dt);
      this.app.hands.readout(ix, 'turning through w');
    }
  }

  onEmptyGrabEnd(ix) { this.pending = null; this.air = null; if (this.grab?.air && this.grab.ix === ix) this.grab = null; }

  onWheel(delta) { this.sliceW = THREE.MathUtils.clamp(this.sliceW - delta * 0.001, -1.05, 1.05); }

  onKey(e) {
    const k = e.key.toLowerCase();
    if (k === 'q' || e.key === 'ArrowDown') this.sliceW = Math.max(-1.05, this.sliceW - 0.03);
    if (k === 'e' || e.key === 'ArrowUp') this.sliceW = Math.min(1.05, this.sliceW + 0.03);
    if (k === 'p' && (this.isPolytope || this.isNet)) this.mode = this.mode === 'perspective' ? 'stereo' : 'perspective';
    if (k === ' ') this.auto = !this.auto;
    if (k === 'f') this.showFaces = !this.showFaces;
  }

  // ---------------------------------------------------------------------------

  update(dt, time) {
    for (const ix of this.app.input.xr) {
      if (ix.kind !== 'controller') continue;
      if (ix.stick.y) this.sliceW = THREE.MathUtils.clamp(this.sliceW - ix.stick.y * dt * 0.8, -1.05, 1.05);
      if (ix.stick.x && !ix.grabbed) {
        R4.planeRotation(_M, 0, 3, ix.stick.x * dt * 1.2);
        R4.multiply(this.R, _M, this.R);
      }
    }

    if (!this.grab) {
      // inertia after release, plus auto-rotation
      const damp = Math.exp(-dt * 1.2);
      for (let k = 0; k < 6; k++) this.spin[k] *= damp;
      R4.expBivector(_M, this.spin, dt);
      R4.multiply(this.R, _M, this.R);
      if (this.auto) {
        const a = [0, 0, 0.22, 0.12, 0, 0]; // xw and yz, a double rotation
        R4.expBivector(_M, a, dt);
        R4.multiply(this.R, _M, this.R);
      }
      R4.orthonormalize(this.R);
    }

    if (this.foldAnim) {
      const f = this.foldAnim;
      if (f.delay > 0) f.delay -= dt;
      else {
        f.t = Math.min(1, f.t + dt / 3.2);
        const e = f.t < 0.5 ? 2 * f.t * f.t : 1 - Math.pow(-2 * f.t + 2, 2) / 2;
        this.fold = f.from + (f.to - f.from) * e;
        if (f.t >= 1) this.foldAnim = null;
      }
    }
    if (this.isNet) this._updateNet();

    // projection uniforms
    const w = this.wire;
    R4.toThreeMatrix(w.shared.uRot.value, this.R, 1);
    w.mode = this.mode === 'stereo' ? 'stereo' : 'perspective';
    w.shared.uEye.value = this.eye;
    // stereographic projection is unbounded near the pole, so use a smaller
    // scale and fade out anything past ~3 units
    const stereo = this.mode === 'stereo';
    w.shared.uScale.value = stereo ? this.S * 0.5 : this.S;
    w.shared.uMaxR.value = stereo ? 3.2 : 7;
    w.shared.uSliceW.value = this.sliceW;
    w.shared.uShowSlice.value = this.showSlice && this.mode !== 'slice' ? 1 : 0;
    w.faceOpacity = this.showFaces && this.mode !== 'slice' ? this.faceAlpha * (stereo ? 0.6 : 1) : 0;
    w.group.visible = this.mode !== 'slice';
    w.tint = this.isNet ? 0.75 : 0;
    const hl = this.hover || this.grab ? 1.25 : 1;
    w.group.scale.setScalar(THREE.MathUtils.lerp(w.group.scale.x, hl > 1 ? 1.02 : 1, Math.min(1, dt * 10)));

    // the solid cross-section
    const o = this.sliceObjs.get(this.shapeKey);
    if (o) {
      const persp = this.mode === 'perspective';
      const sliceMode = this.mode === 'slice';
      const visible = (this.showSlice && persp) || sliceMode;
      o.group.visible = visible && !this.isNet;
      if (o.group.visible) {
        const S = sliceMode ? this.S * 1.6 : this.S;
        o.scale = S;
        R4.copy(o.R, this.R);
        o.pos[0] = o.pos[1] = o.pos[2] = o.pos[3] = 0;
        this.sliceView.w = this.sliceW * S;
        // at the projection's scale for that w, including its hover enlargement, so it meets the edges
        o.group.scale.setScalar(persp ? (this.eye / (this.eye - this.sliceW)) * w.group.scale.x : 1);
        o.sync(this.sliceView, dt);
        o.setHighlight(this.hover || this.grab ? 0.35 : 0);
      }
    }

    if (this.nameplate) {
      // Keep it in front of the column on the viewer's side, facing them. If it
      // only turned in place, its inner edge would swing into the column when
      // seen from the side.
      const head = this.app.headPosition, c = this.center, np = this.nameplate.position;
      const dx = head.x - c.x, dz = head.z - c.z, d = Math.hypot(dx, dz);
      if (d > 1e-3) np.set(c.x + (dx / d) * NAMEPLATE_OUT, np.y, c.z + (dz / d) * NAMEPLATE_OUT);
      this.nameplate.lookAt(head.x, np.y, head.z);
    }
  }

  menuRows() {
    const polyItems = Object.entries(POLYS).map(([k, v]) => ({ label: v.short || v.label, small: true, onClick: () => this.setShape(k), active: () => this.shapeKey === k }));
    polyItems.push({ label: 'Net fold', small: true, onClick: () => this.setShape('net'), active: () => this.shapeKey === 'net' });
    const smoothItems = Object.keys(SMOOTH).map((k) => ({ label: LABELS[k], small: true, onClick: () => this.setShape(k), active: () => this.shapeKey === k }));
    const curved = () => !this.isPolytope && !this.isNet; // curved shapes are only shown as slices
    const sliceOnly = () => this.mode === 'slice'; // no projection, so no faces or slice inside it
    const rows = [
      { type: 'buttons', columns: 4, items: polyItems },
      { type: 'buttons', columns: 3, items: smoothItems },
      {
        type: 'tabs',
        options: [
          { label: 'Perspective', value: 'perspective', small: true, disabled: curved },
          { label: 'Stereographic', value: 'stereo', small: true, disabled: curved },
          { label: 'Slice only', value: 'slice', small: true, disabled: () => this.isNet }, // the net has no solid to slice
        ],
        get: () => this.mode,
        set: (v) => { if (this.isPolytope || v === 'slice' || this.isNet) { if (v !== this.mode) this._forcedSlice = false; this.mode = v; } },
      },
      { type: 'slider', label: 'Slicing hyperplane (w)', min: -1.05, max: 1.05, center: 0, get: () => this.sliceW, set: (v) => { this.sliceW = v; }, format: (v) => v.toFixed(2), gradient: ['#33c3ff', '#ff4f9a'] },
    ];
    if (this.isNet) {
      rows.push({ type: 'slider', label: 'Fold into 4D', min: 0, max: 1, get: () => this.fold, set: (v) => { this.fold = v; this.foldAnim = null; }, format: (v) => `${Math.round(v * 90)}°` });
    }
    rows.push(
      {
        type: 'toggles', columns: 3,
        items: [
          { label: 'Auto-rotate', get: () => this.auto, set: (v) => { this.auto = v; } },
          { label: 'Faces', get: () => this.showFaces, set: (v) => { this.showFaces = v; }, disabled: sliceOnly },
          { label: 'Slice', get: () => this.showSlice, set: (v) => { this.showSlice = v; }, disabled: sliceOnly },
        ],
      },
      {
        type: 'buttons', columns: 3,
        items: [
          { label: 'Reset rotation', small: true, onClick: () => { R4.identity(this.R); this.spin.fill(0); } },
          { label: 'Isoclinic (xy+zw)', small: true, onClick: () => { this.spin = [1.2, 0, 0, 0, 0, 1.2]; this.auto = false; } },
          { label: 'Rotate xw', small: true, onClick: () => { this.spin = [0, 0, 1.6, 0, 0, 0]; this.auto = false; } },
        ],
      },
    );
    return rows;
  }

  hint(mode) {
    const blurb = POLYS[this.shapeKey]?.blurb || SMOOTH[this.shapeKey] || 'The 8 cells of a tesseract, unfolded into 3D. Use the fold slider to fold them back into a tesseract.';
    if (mode === 'desktop') return blurb;
    if (mode === 'controllers') return `${blurb} Trigger or grip to turn it. Hold both to turn it through 4D. Stick up/down moves the slicing hyperplane, left/right turns it in xw.`;
    return `${blurb} Pinch it to turn it. Middle-finger pinch it and move your hand to turn it through 4D. Pinch empty space next to it and move up or down to move the slicing hyperplane.`;
  }

  desktopHelp({ touch } = {}) {
    if (touch) return '<b>Drag</b> the shape to rotate it · <b>Drag</b> empty space to orbit · The menu moves the slicing hyperplane and rotates the shape through 4D.';
    return '<b>Drag</b> the shape to rotate it · <b>Right-drag</b> to rotate the shape through 4D · <b>Wheel</b> or <b>Q/E</b> move the slicing hyperplane · <b>Drag</b> empty space to orbit · <b>P</b> switch between perspective and stereographic · <b>Space</b> start or stop auto-rotate · <b>F</b> show or hide faces';
  }
}
