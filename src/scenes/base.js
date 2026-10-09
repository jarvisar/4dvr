import * as THREE from 'three';
import { FONTS } from '../core/ui.js';

// Base class for scenes. The App, menu and interaction manager expect these fields and methods.
export class SceneBase {
  constructor(app) {
    this.app = app;
    this.root = new THREE.Group();
    this.interactables = [];
    this.title = 'Scene';
    this.subtitle = '';
    this.short = 'Scene';
    this.mood = 'studio';
    this.desktopView = { position: new THREE.Vector3(0, 1.6, 0.6), target: new THREE.Vector3(0, 1.1, -0.6) };
  }

  enter() { this.app.scene.add(this.root); }
  exit() { this.root.removeFromParent(); }
  update() {}
  menuRows() { return []; }
  hint() { return ''; }
  desktopHelp() { return ''; }
}

const LOOK = 0.004;     // radians per CSS pixel dragged
const TURN_SPEED = 1.8; // radians per second with the arrow keys
const _euler = new THREE.Euler();

// Desktop controls for the scenes you walk through. WASD moves, Q/E go down and
// up where that's possible, Shift is faster, and dragging empty space looks
// around. The up and down arrows move and the left and right arrows turn, so
// the keyboard alone is enough. Keys go by position (KeyboardEvent.code), so on
// an AZERTY keyboard WASD is ZQSD.
export class WalkControls {
  constructor(app) {
    this.app = app;
    this.yaw = 0;
    this.pitch = 0;
    this.keys = new Set();
    this._drag = null; // the pointer that's looking around
    const canvas = app.renderer.domElement;
    const end = (e) => { if (e.pointerId === this._drag?.id) this._drag = null; };
    this._listeners = [
      [window, 'keydown', (e) => {
        // a slider in the menu uses the arrow keys itself
        if (app.presenting || !app.hudActive || e.ctrlKey || e.metaKey || e.altKey || e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
        this.keys.add(e.code);
      }],
      [window, 'keyup', (e) => this.keys.delete(e.code)],
      [window, 'blur', () => this.clear()], // keyup never arrives after alt-tab
      [canvas, 'pointerdown', (e) => {
        // a second finger pulls you along instead (see InputSystem)
        if (this._drag) { if (e.pointerType === 'touch') this._drag = null; return; }
        // App's pointer gate has already checked whether this press hit something
        if (app.presenting || !app.hudActive || e.button !== 0 || !app.pointerOnEmpty) return;
        this._drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      }],
      // Deltas come from clientX/Y. movementX is missing for touch in some
      // browsers and in device pixels in others.
      [window, 'pointermove', (e) => {
        const d = this._drag;
        if (app.presenting || !app.hudActive) { this._drag = null; return; }
        if (!d || e.pointerId !== d.id) return;
        // the release was missed, like after letting go outside the window
        if (!(e.buttons & 1)) { this._drag = null; return; }
        this.yaw -= (e.clientX - d.x) * LOOK;
        this.pitch = THREE.MathUtils.clamp(this.pitch - (e.clientY - d.y) * LOOK, -1.4, 1.4);
        d.x = e.clientX;
        d.y = e.clientY;
      }],
      [window, 'pointerup', end],
      [window, 'pointercancel', end],
      [canvas, 'lostpointercapture', end],
    ];
  }

  attach() {
    for (const [el, type, fn] of this._listeners) el.addEventListener(type, fn);
  }

  detach() {
    for (const [el, type, fn] of this._listeners) el.removeEventListener(type, fn);
    this.clear();
  }

  clear() {
    this.keys.clear();
    this._drag = null;
  }

  get fast() { return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'); }

  // Held keys as a direction in the camera's axes (x right, y up, z back), not normalized
  direction(out) {
    const k = this.keys;
    return out.set(
      (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0),
      (k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') ? 1 : 0),
      (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0),
    );
  }

  // Turns with the arrow keys and points the camera, which the scene has
  // already put in place. The head pose is updated too, since the scene reads
  // it later in the same frame.
  update(dt) {
    const app = this.app, cam = app.camera;
    this.yaw += ((this.keys.has('ArrowLeft') ? 1 : 0) - (this.keys.has('ArrowRight') ? 1 : 0)) * TURN_SPEED * dt;
    cam.quaternion.setFromEuler(_euler.set(this.pitch, this.yaw, 0, 'YXZ'));
    cam.updateMatrixWorld();
    cam.getWorldPosition(app.headPosition);
    cam.getWorldQuaternion(app.headQuaternion);
  }
}

// Text on a plane using a canvas texture. Free it with disposeLabel().
export function makeLabel(text, { size = 0.02, color = '#ffffff', weight = 600, bg = null, pad = 0.35 } = {}) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const px = 64;
  const font = `${weight} ${px}px ${FONTS.sans}`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width + px * pad * 2);
  const h = Math.ceil(px * (1 + pad * 2) * 0.9);
  canvas.width = w; canvas.height = h;
  drawLabel(ctx, text, { w, h, px, font, color, bg });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size * (w / h), size), mat);
  mesh.renderOrder = 15;
  return mesh;
}

function drawLabel(ctx, text, { w, h, px, font, color, bg }) {
  ctx.clearRect(0, 0, w, h);
  if (bg) {
    // plate to match the UI panels, a little lighter at the top with a dark rim
    ctx.beginPath();
    ctx.roundRect(1.5, 1.5, w - 3, h - 3, h * 0.16);
    ctx.fillStyle = bg;
    ctx.fill();
    const sheen = ctx.createLinearGradient(0, 0, 0, h);
    sheen.addColorStop(0, 'rgba(255, 255, 255, 0.14)');
    sheen.addColorStop(0.55, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = sheen;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.stroke();
  }
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2 + px * 0.04);
}

export function disposeLabel(mesh) {
  if (!mesh) return;
  mesh.removeFromParent();
  mesh.geometry.dispose();
  mesh.material.map?.dispose();
  mesh.material.dispose();
}

// For text that changes often, like readouts. The canvas is a fixed size, fit to
// `template`, and gets redrawn in place so updates don't allocate anything.
export class TextLabel {
  constructor({ size = 0.02, template = 'w = -00.0 cm', weight = 500, bg = null, pad = 0.35 } = {}) {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.px = 64;
    this.font = `${weight} ${this.px}px ${FONTS.mono}`;
    this.ctx.font = this.font;
    this.w = Math.ceil(this.ctx.measureText(template).width + this.px * pad * 2);
    this.h = Math.ceil(this.px * (1 + pad * 2) * 0.9);
    this.canvas.width = this.w; this.canvas.height = this.h;
    this.bg = bg;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(size * (this.w / this.h), size),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthWrite: false, toneMapped: false }),
    );
    this.mesh.renderOrder = 15;
    this.text = null;
  }

  setText(text, color = '#ffffff') {
    if (text === this.text && color === this.color) return;
    this.text = text; this.color = color;
    drawLabel(this.ctx, text, { w: this.w, h: this.h, px: this.px, font: this.font, color, bg: this.bg });
    this.texture.needsUpdate = true;
  }
}

// Particle burst for when a puzzle is solved
export class Burst {
  constructor(parent, count = 90) {
    this.count = count;
    const g = new THREE.BufferGeometry();
    this.pos = new Float32Array(count * 3);
    this.col = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    this.mat = new THREE.PointsMaterial({ size: 0.012, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.life = 0;
    parent.add(this.points);
  }

  fire(center, colors = ['#ff4f9a', '#33c3ff', '#ffd93d', '#8b7bff'], speed = 1.2) {
    const c = new THREE.Color();
    for (let i = 0; i < this.count; i++) {
      this.pos[i * 3] = center.x; this.pos[i * 3 + 1] = center.y; this.pos[i * 3 + 2] = center.z;
      const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, s = speed * (0.4 + Math.random() * 0.6);
      const r = Math.sqrt(1 - u * u);
      this.vel[i * 3] = r * Math.cos(a) * s; this.vel[i * 3 + 1] = Math.abs(u) * s + 0.6; this.vel[i * 3 + 2] = r * Math.sin(a) * s;
      c.set(colors[i % colors.length]);
      this.col[i * 3] = c.r; this.col[i * 3 + 1] = c.g; this.col[i * 3 + 2] = c.b;
    }
    const attr = this.points.geometry.attributes;
    attr.position.needsUpdate = true;
    attr.color.needsUpdate = true;
    this.life = 1.6;
    this.points.visible = true;
  }

  update(dt) {
    if (this.life <= 0) return;
    this.life -= dt;
    for (let i = 0; i < this.count; i++) {
      this.vel[i * 3 + 1] -= 3.5 * dt;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.mat.opacity = Math.min(1, this.life);
    if (this.life <= 0) this.points.visible = false;
  }
}
