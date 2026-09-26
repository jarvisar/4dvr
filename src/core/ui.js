// VR UI panels drawn to a canvas texture, with fingertip and ray input.
//
// Panels are laid out from a list of rows and only redrawn when a displayed
// value changes. Buttons are at least 22 mm tall, following Meta's hand
// interaction guidelines.

import * as THREE from 'three';

const PX_PER_M = 2000;
const PAD = 0.014;
const GAP = 0.008;
const ROW_H = { title: 0.05, tabs: 0.038, buttons: 0.036, toggles: 0.036, slider: 0.052, text: 0.0 };

const COLORS = {
  bg: 'rgba(15, 17, 29, 0.9)',
  border: 'rgba(255,255,255,0.14)',
  ink: '#eef0ff',
  muted: '#9aa0bf',
  btn: 'rgba(255,255,255,0.07)',
  btnHover: 'rgba(255,255,255,0.16)',
  ana: '#ff4f9a',
  kata: '#33c3ff',
  accent: '#8b7bff',
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const FONT = "'Segoe UI', Roboto, system-ui, sans-serif";

export class UIPanel {
  constructor(ui, { width = 0.3, rows = [], name = 'panel' } = {}) {
    this.ui = ui;
    this.name = name;
    this.width = width;
    this.height = 0.1;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, toneMapped: false, depthWrite: false, opacity: 1 });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    this.mesh.renderOrder = 20;
    this.group = new THREE.Group();
    this.group.add(this.mesh);
    this.group.name = name;
    this.widgets = [];
    this.hover = new Map();   // interactor -> widget
    this.pressed = new Map(); // interactor -> widget
    this.pokeZ = new Map();
    this.opacity = 1;
    this.interactive = true;
    this._sig = '';
    this._lastDraw = 0;
    this.setRows(rows);
  }

  get visible() {
    return this.group.visible && this.opacity > 0.3;
  }

  setRows(rows) {
    this.rows = rows;
    this.widgets = [];
    let y = PAD;
    const w = this.width - PAD * 2;
    for (const row of rows) {
      if (row.type === 'title') {
        this.widgets.push({ type: 'title', row, x: PAD, y, w, h: ROW_H.title });
        y += ROW_H.title;
      } else if (row.type === 'tabs' || row.type === 'buttons' || row.type === 'toggles') {
        const items = row.type === 'tabs' ? row.options : row.items;
        const cols = row.columns || items.length;
        const h = row.height || ROW_H[row.type];
        const bw = (w - GAP * (cols - 1)) / cols;
        items.forEach((item, i) => {
          const c = i % cols, r = Math.floor(i / cols);
          this.widgets.push({ type: row.type === 'tabs' ? 'tab' : row.type === 'toggles' ? 'toggle' : 'button', row, item, x: PAD + c * (bw + GAP), y: y + r * (h + GAP), w: bw, h });
        });
        const nr = Math.ceil(items.length / cols);
        y += nr * h + (nr - 1) * GAP;
      } else if (row.type === 'slider') {
        this.widgets.push({ type: 'slider', row, x: PAD, y, w, h: ROW_H.slider });
        y += ROW_H.slider;
      } else if (row.type === 'text') {
        const h = (row.lines || 2) * 0.0158 + 0.004;
        this.widgets.push({ type: 'text', row, x: PAD, y, w, h });
        y += h;
      } else if (row.type === 'spacer') {
        y += row.h || 0.006;
        continue;
      }
      y += GAP;
    }
    this.height = y - GAP + PAD;
    this.canvas.width = Math.round(this.width * PX_PER_M);
    this.canvas.height = Math.round(this.height * PX_PER_M);
    this.mesh.scale.set(this.width, this.height, 1);
    this.texture.dispose();
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.material.map = this.texture;
    this._sig = '';
    this.draw(true);
  }

  _signature() {
    let s = '';
    for (const w of this.widgets) {
      const r = w.row;
      if (w.type === 'tab') s += r.get() === w.item.value ? '1' : '0';
      else if (w.type === 'toggle') s += w.item.get() ? '1' : '0';
      else if (w.type === 'button' && w.item.active) s += w.item.active() ? '1' : '0';
      else if (w.type === 'slider') s += r.get().toFixed(3);
      else if (w.type === 'text' && typeof r.text === 'function') s += r.text();
      else if (w.type === 'title' && typeof r.text === 'function') s += r.text();
      s += '|';
    }
    for (const w of this.hover.values()) s += 'h' + this.widgets.indexOf(w);
    for (const w of this.pressed.values()) s += 'p' + this.widgets.indexOf(w);
    return s;
  }

  update(time) {
    if (!this.group.visible) return;
    const sig = this._signature();
    if (sig !== this._sig && time - this._lastDraw > 0.03) {
      this._sig = sig;
      this._lastDraw = time;
      this.draw();
    }
    this.material.opacity = this.opacity;
  }

  draw() {
    const ctx = this.ctx;
    const S = PX_PER_M;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    roundRect(ctx, 2, 2, W - 4, H - 4, 0.018 * S);
    ctx.fillStyle = COLORS.bg;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = COLORS.border;
    ctx.stroke();

    const hovered = new Set(this.hover.values());
    const pressed = new Set(this.pressed.values());

    for (const w of this.widgets) {
      const x = w.x * S, y = w.y * S, ww = w.w * S, hh = w.h * S;
      const r = w.row;
      if (w.type === 'title') {
        const text = typeof r.text === 'function' ? r.text() : r.text;
        ctx.fillStyle = COLORS.ink;
        ctx.font = `700 ${0.021 * S}px ${FONT}`;
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        ctx.fillText(text, x, y + 0.024 * S);
        if (r.sub) {
          ctx.fillStyle = COLORS.muted;
          ctx.font = `400 ${0.0125 * S}px ${FONT}`;
          ctx.fillText(r.sub, x, y + 0.042 * S);
        }
        // ana→kata accent line
        const g = ctx.createLinearGradient(x, 0, x + ww, 0);
        g.addColorStop(0, COLORS.ana); g.addColorStop(1, COLORS.kata);
        ctx.fillStyle = g;
        ctx.fillRect(x, y + hh - 0.002 * S, ww, 0.0012 * S);
      } else if (w.type === 'button' || w.type === 'tab' || w.type === 'toggle') {
        const on = w.type === 'tab' ? r.get() === w.item.value : w.type === 'toggle' ? w.item.get() : (w.item.active ? w.item.active() : false);
        const isHover = hovered.has(w), isPressed = pressed.has(w);
        roundRect(ctx, x, y, ww, hh, 0.009 * S);
        if (on && w.type !== 'toggle') {
          const g = ctx.createLinearGradient(x, y, x + ww, y + hh);
          g.addColorStop(0, 'rgba(255,79,154,0.85)'); g.addColorStop(1, 'rgba(51,195,255,0.85)');
          ctx.fillStyle = g;
        } else {
          ctx.fillStyle = isPressed ? 'rgba(255,255,255,0.26)' : isHover ? COLORS.btnHover : COLORS.btn;
        }
        ctx.fill();
        if (isHover || isPressed) {
          ctx.lineWidth = 3;
          ctx.strokeStyle = 'rgba(255,255,255,0.55)';
          ctx.stroke();
        }
        let tx = x + ww / 2;
        ctx.textAlign = 'center';
        if (w.type === 'toggle') {
          // pill switch on the left
          const pw = 0.018 * S, ph = 0.011 * S, px = x + 0.008 * S, py = y + hh / 2 - ph / 2;
          roundRect(ctx, px, py, pw, ph, ph / 2);
          ctx.fillStyle = on ? COLORS.kata : 'rgba(255,255,255,0.18)';
          ctx.fill();
          ctx.beginPath();
          ctx.arc(on ? px + pw - ph / 2 : px + ph / 2, py + ph / 2, ph * 0.38, 0, Math.PI * 2);
          ctx.fillStyle = '#fff';
          ctx.fill();
          tx = px + pw + 0.006 * S;
          ctx.textAlign = 'left';
        }
        ctx.fillStyle = COLORS.ink;
        const label = typeof w.item.label === 'function' ? w.item.label() : w.item.label;
        let size = (w.item.small ? 0.0105 : 0.0122) * S;
        ctx.font = `600 ${size}px ${FONT}`;
        const maxW = w.type === 'toggle' ? ww - (tx - x) - 0.004 * S : ww - 0.008 * S;
        while (ctx.measureText(label).width > maxW && size > 0.007 * S) {
          size *= 0.92;
          ctx.font = `600 ${size}px ${FONT}`;
        }
        ctx.textBaseline = 'middle';
        ctx.fillText(label, tx, y + hh / 2 + 0.0008 * S);
      } else if (w.type === 'slider') {
        const v = r.get();
        const t = (v - r.min) / (r.max - r.min);
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        ctx.fillStyle = COLORS.muted;
        ctx.font = `600 ${0.0115 * S}px ${FONT}`;
        ctx.fillText(r.label, x, y + 0.013 * S);
        ctx.textAlign = 'right';
        ctx.fillStyle = COLORS.ink;
        ctx.fillText(r.format ? r.format(v) : v.toFixed(2), x + ww, y + 0.013 * S);
        const ty = y + 0.031 * S, th = 0.008 * S;
        roundRect(ctx, x, ty - th / 2, ww, th, th / 2);
        ctx.fillStyle = 'rgba(255,255,255,0.1)';
        ctx.fill();
        const g = ctx.createLinearGradient(x, 0, x + ww, 0);
        g.addColorStop(0, r.gradient ? r.gradient[0] : COLORS.kata);
        g.addColorStop(1, r.gradient ? r.gradient[1] : COLORS.ana);
        roundRect(ctx, x, ty - th / 2, Math.max(th, ww * t), th, th / 2);
        ctx.fillStyle = g;
        ctx.fill();
        if (r.center !== undefined) {
          const cx = x + ww * ((r.center - r.min) / (r.max - r.min));
          ctx.fillStyle = 'rgba(255,255,255,0.5)';
          ctx.fillRect(cx - 1, ty - th, 2, th * 2);
        }
        const kx = x + ww * t;
        const active = hovered.has(w) || pressed.has(w);
        ctx.beginPath();
        ctx.arc(kx, ty, (active ? 0.0105 : 0.009) * S, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        ctx.stroke();
      } else if (w.type === 'text') {
        const text = typeof r.text === 'function' ? r.text() : r.text;
        ctx.fillStyle = r.color || COLORS.muted;
        ctx.font = `${r.bold ? 600 : 400} ${0.0112 * S}px ${FONT}`;
        ctx.textAlign = r.align || 'left';
        ctx.textBaseline = 'alphabetic';
        const lines = wrapText(ctx, text, ww);
        const ax = r.align === 'center' ? x + ww / 2 : x;
        lines.slice(0, r.lines || 2).forEach((line, i) => ctx.fillText(line, ax, y + (0.0125 + i * 0.0158) * S));
      }
    }
    this.texture.needsUpdate = true;
  }

  /** Panel-local point (metres, origin at top-left, y down) for a world point. */
  toPanel(world, out = new THREE.Vector3()) {
    out.copy(world);
    this.group.worldToLocal(out);
    out.x += this.width / 2;
    out.y = this.height / 2 - out.y;
    return out; // z = distance in front of the panel
  }

  widgetAt(px, py, pad = 0.004) {
    for (const w of this.widgets) {
      if (w.type === 'title' || w.type === 'text') continue;
      if (px >= w.x - pad && px <= w.x + w.w + pad && py >= w.y - pad && py <= w.y + w.h + pad) return w;
    }
    return null;
  }

  activate(w, px) {
    const audio = this.ui.app.audio;
    if (w.type === 'button') { w.item.onClick?.(); audio.click(); }
    else if (w.type === 'tab') { w.row.set(w.item.value); audio.click(); }
    else if (w.type === 'toggle') { const v = !w.item.get(); w.item.set(v); audio.toggle(v); }
    else if (w.type === 'slider') this.dragSlider(w, px);
  }

  dragSlider(w, px) {
    const r = w.row;
    let t = THREE.MathUtils.clamp((px - w.x) / w.w, 0, 1);
    let v = r.min + t * (r.max - r.min);
    if (r.step) v = Math.round(v / r.step) * r.step;
    if (r.center !== undefined && Math.abs(v - r.center) < (r.max - r.min) * 0.02) v = r.center; // detent
    r.set(v);
  }
}

function wrapText(ctx, text, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const test = line ? line + ' ' + word : word;
      if (ctx.measureText(test).width > maxW && line) { out.push(line); line = word; } else line = test;
    }
    out.push(line);
  }
  return out;
}

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _c = new THREE.Vector3();
const _hp = new THREE.Vector3();

export class UISystem {
  constructor(app) {
    this.app = app;
    this.panels = [];
    this.root = new THREE.Group();
    this.root.name = 'ui';
    app.scene.add(this.root);
  }

  add(panel) {
    this.panels.push(panel);
    this.root.add(panel.group);
    return panel;
  }

  remove(panel) {
    this.panels = this.panels.filter((p) => p !== panel);
    panel.group.removeFromParent();
  }

  update(time) {
    for (const p of this.panels) p.update(time);
  }

  /** Fingertip poke. Returns true when the finger is engaged with a panel. */
  updatePoke(ix) {
    if (!ix.hasPoke) return false;
    let engaged = false;
    for (const p of this.panels) {
      if (!p.visible || !p.interactive || p.ownerIx === ix) { p.hover.delete(ix); continue; }
      p.toPanel(ix.pokePos, _p);
      const inside = _p.x > -0.01 && _p.x < p.width + 0.01 && _p.y > -0.01 && _p.y < p.height + 0.01;
      const prevZ = p.pokeZ.has(ix) ? p.pokeZ.get(ix) : 1;
      p.pokeZ.set(ix, _p.z);
      const pressedW = p.pressed.get(ix);
      if (pressedW) {
        if (_p.z > 0.018 || !inside) {
          p.pressed.delete(ix);
        } else {
          if (pressedW.type === 'slider') p.dragSlider(pressedW, _p.x);
          engaged = true;
          ix.uiEngaged = true;
          continue;
        }
      }
      if (inside && _p.z < 0.045 && _p.z > -0.03) {
        engaged = true;
        const w = p.widgetAt(_p.x, _p.y);
        if (w !== p.hover.get(ix)) {
          if (w) { this.app.audio.hover(); ix.pulse(0.1, 8); }
          p.hover.set(ix, w);
        }
        if (w && _p.z < 0.006 && prevZ >= 0.006) {
          p.pressed.set(ix, w);
          p.activate(w, _p.x);
          ix.pulse(0.6, 20);
        }
      } else {
        p.hover.delete(ix);
      }
    }
    ix.uiEngaged = engaged;
    return engaged;
  }

  /** Ray vs visible panels. */
  raycast(ix) {
    let best = null;
    for (const p of this.panels) {
      if (!p.visible || !p.interactive) continue;
      p.group.getWorldPosition(_c);
      _n.set(0, 0, 1).applyQuaternion(p.group.getWorldQuaternion(new THREE.Quaternion()));
      const denom = _n.dot(ix.rayDir);
      if (denom > -1e-4) continue; // parallel or from behind
      const t = _n.dot(_p.subVectors(_c, ix.rayOrigin)) / denom;
      if (t <= 0 || (best && t > best.t)) continue;
      _hp.copy(ix.rayOrigin).addScaledVector(ix.rayDir, t);
      p.toPanel(_hp, _p);
      if (_p.x < 0 || _p.x > p.width || _p.y < 0 || _p.y > p.height) continue;
      best = { t, panel: p, widget: p.widgetAt(_p.x, _p.y, 0.002), x: _p.x, y: _p.y };
    }
    return best;
  }

  setRayHover(ix, hit) {
    for (const p of this.panels) {
      if (hit && hit.panel === p && hit.widget) {
        if (p.hover.get(ix) !== hit.widget) { p.hover.set(ix, hit.widget); ix.pulse(0.1, 8); }
      } else if (!ix.uiEngaged) p.hover.delete(ix);
    }
  }

  beginCapture(ix, hit, mode) {
    ix.uiCapture = { panel: hit.panel, widget: hit.widget, mode };
    if (hit.widget) {
      hit.panel.pressed.set(ix, hit.widget);
      hit.panel.activate(hit.widget, hit.x);
      ix.pulse(0.5, 18);
    }
  }

  updateCapture(ix) {
    const cap = ix.uiCapture;
    if (!cap.widget || cap.widget.type !== 'slider') return;
    const p = cap.panel;
    p.group.getWorldPosition(_c);
    _n.set(0, 0, 1).applyQuaternion(p.group.getWorldQuaternion(new THREE.Quaternion()));
    const denom = _n.dot(ix.rayDir);
    if (Math.abs(denom) < 1e-4) return;
    const t = _n.dot(_p.subVectors(_c, ix.rayOrigin)) / denom;
    _hp.copy(ix.rayOrigin).addScaledVector(ix.rayDir, t);
    p.toPanel(_hp, _p);
    p.dragSlider(cap.widget, _p.x);
  }

  endCapture(ix) {
    const cap = ix.uiCapture;
    if (cap) cap.panel.pressed.delete(ix);
    ix.uiCapture = null;
  }
}
