import * as THREE from 'three';
import { FONTS } from '../core/ui.js';

/** Common scene contract used by the App, menu and interaction manager. */
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
    this.shadows = false; // only scenes with shadow receivers pay for the shadow pass
  }

  enter() { this.app.scene.add(this.root); }
  exit() { this.root.removeFromParent(); }
  update() {}
  menuRows() { return []; }
  hint() { return ''; }
  desktopHelp() { return ''; }
}

/** Text label on a plane (canvas texture). Free it with disposeLabel(). */
export function makeLabel(text, { size = 0.02, color = '#ffffff', weight = 600, bg = null, pad = 0.35 } = {}) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const px = 64;
  const font = `${weight} ${px}px ${FONTS.mono}`;
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
    // plate with cut corners, matching the UI panels
    const c = h * 0.28;
    ctx.fillStyle = bg;
    ctx.beginPath();
    ctx.moveTo(c, 0); ctx.lineTo(w, 0); ctx.lineTo(w, h - c); ctx.lineTo(w - c, h); ctx.lineTo(0, h); ctx.lineTo(0, c);
    ctx.closePath();
    ctx.fill();
  }
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2 + px * 0.04);
}

/** Remove a label from the scene and free its GPU resources. */
export function disposeLabel(mesh) {
  if (!mesh) return;
  mesh.removeFromParent();
  mesh.geometry.dispose();
  mesh.material.map?.dispose();
  mesh.material.dispose();
}

/**
 * Label for frequently changing text (readouts). The canvas has a fixed size,
 * sized for `template`, and is redrawn in place, so updates allocate nothing.
 */
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

/** Additive particle burst, used when a puzzle is solved. */
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
