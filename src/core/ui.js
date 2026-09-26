// VR UI panels drawn to a canvas texture, with fingertip and ray input.
//
// Panels are laid out from a list of rows and only redrawn when a displayed
// value changes. Buttons are at least 22 mm tall, following Meta's hand
// interaction guidelines.

import * as THREE from 'three';

const PX_PER_M = 2000;
const PAD = 0.014;
const GAP = 0.007;
const ROW_H = { title: 0.054, tabs: 0.036, buttons: 0.036, toggles: 0.036, slider: 0.054, text: 0.0 };
const TEXT_SIZE = 0.0108;
const LINE_H = 0.0158;
// button labels: default and minimum font size (m), padding on each side
const LABEL = { size: 0.0116, small: 0.0102, min: 0.0068, pad: 0.004 };

// Same colours and fonts as style.css: dark panels with a hairline frame,
// top-left / bottom-right corners cut at 45°, white-filled selection. Pink
// (ana, +w) and cyan (kata, −w) are only used where they mean a direction along w.
export const COLORS = {
  bg: 'rgba(9, 10, 15, 0.94)',
  frame: 'rgba(255, 255, 255, 0.14)',
  ink: '#eceef4',
  inkDark: '#0a0b10',
  muted: '#8a90a3',
  dim: 'rgba(255, 255, 255, 0.22)',
  btn: 'rgba(255, 255, 255, 0.045)',
  btnLine: 'rgba(255, 255, 255, 0.1)',
  btnHover: 'rgba(255, 255, 255, 0.11)',
  btnPress: 'rgba(255, 255, 255, 0.22)',
  ana: '#ff4f9a',
  kata: '#33c3ff',
};

export const FONTS = {
  display: "'Chakra Petch', 'Segoe UI', system-ui, sans-serif",
  sans: "'IBM Plex Sans', 'Segoe UI', system-ui, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, Consolas, monospace",
};

/** Rectangle with the top-left and bottom-right corners cut at 45°. */
function chamfer(ctx, x, y, w, h, c) {
  ctx.beginPath();
  ctx.moveTo(x + c, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h - c);
  ctx.lineTo(x + w - c, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + c);
  ctx.closePath();
}

function setFont(ctx, weight, size, family, spacing = 0) {
  ctx.font = `${weight} ${size}px ${family}`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${spacing}px`;
}

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
        // as tall as the current text needs, up to row.lines
        const lines = Math.max(1, Math.min(row.lines || 8, this._wrap(row, w).length));
        const h = lines * LINE_H + 0.004;
        this.widgets.push({ type: 'text', row, x: PAD, y, w, h, lines });
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
      if (this._relayout) this.setRows(this.rows); // a text row outgrew its space
    }
    this.material.opacity = this.opacity;
  }

  /** Lines of a text row wrapped to `w` metres. */
  _wrap(row, w) {
    const text = typeof row.text === 'function' ? row.text() : row.text;
    setFont(this.ctx, row.bold ? 600 : 400, TEXT_SIZE * PX_PER_M, FONTS.sans);
    return wrapText(this.ctx, text, w * PX_PER_M);
  }

  /**
   * Font size and letter spacing (px) for each button row's labels: the
   * largest that fits every label in the row, so a row never mixes sizes.
   * Letter spacing is removed before the size is reduced.
   */
  _fitLabels() {
    const ctx = this.ctx;
    const S = PX_PER_M;
    const fit = new Map();
    for (const w of this.widgets) {
      if (w.type !== 'button' && w.type !== 'tab' && w.type !== 'toggle') continue;
      const label = labelText(w.item);
      const maxW = (w.type === 'toggle' ? w.w - 0.027 - LABEL.pad : w.w - 2 * LABEL.pad) * S;
      let size = (w.item.small ? LABEL.small : LABEL.size) * S;
      let spacing = size * 0.06;
      setFont(ctx, 600, size, FONTS.display, spacing);
      if (ctx.measureText(label).width > maxW) {
        spacing = 0;
        setFont(ctx, 600, size, FONTS.display, 0);
        while (ctx.measureText(label).width > maxW && size > LABEL.min * S) {
          size = Math.max(LABEL.min * S, size * 0.95);
          setFont(ctx, 600, size, FONTS.display, 0);
        }
      }
      const f = fit.get(w.row);
      fit.set(w.row, f ? { size: Math.min(f.size, size), spacing: Math.min(f.spacing, spacing) } : { size, spacing });
    }
    return fit;
  }

  draw() {
    const ctx = this.ctx;
    const S = PX_PER_M;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);

    // panel: plate with a hairline frame
    const inset = 2;
    chamfer(ctx, inset, inset, W - 2 * inset, H - 2 * inset, 0.012 * S);
    ctx.fillStyle = COLORS.bg;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = COLORS.frame;
    ctx.stroke();

    const hovered = new Set(this.hover.values());
    const pressed = new Set(this.pressed.values());
    const labelFit = this._fitLabels();
    this._relayout = false;

    for (const w of this.widgets) {
      const x = w.x * S, y = w.y * S, ww = w.w * S, hh = w.h * S;
      const r = w.row;
      if (w.type === 'title') {
        const text = typeof r.text === 'function' ? r.text() : r.text;
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        ctx.fillStyle = COLORS.ink;
        setFont(ctx, 700, 0.0195 * S, FONTS.display, 0.0012 * S);
        ctx.fillText(String(text).toUpperCase(), x, y + 0.022 * S);
        if (r.sub) {
          ctx.fillStyle = COLORS.muted;
          setFont(ctx, 400, 0.0098 * S, FONTS.mono, 0.0006 * S);
          ctx.fillText(String(r.sub).toUpperCase(), x, y + 0.038 * S);
        }
        ctx.fillStyle = COLORS.frame;
        ctx.fillRect(x, y + hh - 0.004 * S, ww, 2);
      } else if (w.type === 'button' || w.type === 'tab' || w.type === 'toggle') {
        const on = w.type === 'tab' ? r.get() === w.item.value : w.type === 'toggle' ? w.item.get() : (w.item.active ? w.item.active() : false);
        const isHover = hovered.has(w), isPressed = pressed.has(w);
        const selected = on && w.type !== 'toggle';
        const bc = 0.0055 * S;
        chamfer(ctx, x, y, ww, hh, bc);
        ctx.fillStyle = selected ? COLORS.ink : isPressed ? COLORS.btnPress : isHover ? COLORS.btnHover : COLORS.btn;
        ctx.fill();
        if (!selected || isHover) {
          ctx.lineWidth = isHover || isPressed ? 3 : 2;
          ctx.strokeStyle = isHover || isPressed ? 'rgba(255,255,255,0.6)' : COLORS.btnLine;
          ctx.stroke();
        }
        let tx = x + ww / 2;
        ctx.textAlign = 'center';
        if (w.type === 'toggle') {
          // square indicator, filled when on
          const sz = 0.011 * S, px = x + 0.009 * S, py = y + hh / 2 - sz / 2;
          ctx.lineWidth = 3;
          ctx.strokeStyle = on ? COLORS.ink : COLORS.dim;
          ctx.strokeRect(px, py, sz, sz);
          if (on) { ctx.fillStyle = COLORS.ink; ctx.fillRect(px + 5, py + 5, sz - 10, sz - 10); }
          tx = px + sz + 0.007 * S;
          ctx.textAlign = 'left';
        }
        ctx.fillStyle = selected ? COLORS.inkDark : (w.type === 'toggle' && !on ? '#b9bdcb' : COLORS.ink);
        const { size, spacing } = labelFit.get(r);
        setFont(ctx, selected ? 700 : 600, size, FONTS.display, spacing); // dark-on-light text looks thinner
        ctx.textBaseline = 'middle';
        ctx.fillText(labelText(w.item), tx, y + hh / 2 + 0.0009 * S);
      } else if (w.type === 'slider') {
        const v = r.get();
        const span = r.max - r.min;
        const t = THREE.MathUtils.clamp((v - r.min) / span, 0, 1);
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        ctx.fillStyle = COLORS.muted;
        setFont(ctx, 500, 0.0094 * S, FONTS.mono, 0.0005 * S);
        ctx.fillText(String(r.label).toUpperCase(), x, y + 0.012 * S);
        ctx.textAlign = 'right';
        ctx.fillStyle = COLORS.ink;
        setFont(ctx, 500, 0.0112 * S, FONTS.mono);
        ctx.fillText(r.format ? r.format(v) : v.toFixed(2), x + ww, y + 0.0125 * S);

        const ty = y + 0.031 * S;
        // scale: hairline with ticks every 10%, taller at the ends and the centre
        ctx.fillStyle = COLORS.dim;
        ctx.fillRect(x, ty - 1, ww, 2);
        for (let i = 0; i <= 10; i++) {
          const major = i === 0 || i === 10 || (r.center !== undefined && Math.abs(r.min + (i / 10) * span - r.center) < span * 0.01);
          const th = (major ? 0.009 : 0.004) * S;
          ctx.fillRect(x + (ww - 2) * (i / 10), ty + 0.004 * S, 2, th);
        }
        // fill from the centre detent (or the minimum) to the value
        const from = r.center !== undefined ? (r.center - r.min) / span : 0;
        const x0 = x + ww * Math.min(from, t), x1 = x + ww * Math.max(from, t);
        let fill = COLORS.ink;
        if (r.gradient) {
          fill = ctx.createLinearGradient(x, 0, x + ww, 0);
          fill.addColorStop(0, r.gradient[0]); fill.addColorStop(1, r.gradient[1]);
        }
        ctx.fillStyle = fill;
        ctx.fillRect(x0, ty - 3, Math.max(2, x1 - x0), 6);
        // knob: a vertical index bar
        const kx = x + ww * t;
        const active = hovered.has(w) || pressed.has(w);
        const kw = (active ? 0.0048 : 0.0036) * S, kh = (active ? 0.022 : 0.018) * S;
        ctx.fillStyle = COLORS.inkDark;
        ctx.fillRect(kx - kw / 2 - 3, ty - kh / 2 - 3, kw + 6, kh + 6);
        ctx.fillStyle = COLORS.ink;
        ctx.fillRect(kx - kw / 2, ty - kh / 2, kw, kh);
      } else if (w.type === 'text') {
        const lines = this._wrap(r, w.w);
        if (lines.length > w.lines && w.lines < (r.lines || 8)) this._relayout = true;
        ctx.fillStyle = r.color || COLORS.muted;
        ctx.textAlign = r.align || 'left';
        ctx.textBaseline = 'alphabetic';
        const ax = r.align === 'center' ? x + ww / 2 : x;
        lines.slice(0, w.lines).forEach((line, i) => ctx.fillText(line, ax, y + (0.0125 + i * LINE_H) * S));
      }
    }
    setFont(ctx, 400, 10, FONTS.sans);
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

function labelText(item) {
  return String(typeof item.label === 'function' ? item.label() : item.label).toUpperCase();
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
const _wq = new THREE.Quaternion();

export class UISystem {
  constructor(app) {
    this.app = app;
    this.panels = [];
    this.root = new THREE.Group();
    this.root.name = 'ui';
    app.scene.add(this.root);
    // Canvas text only uses web fonts that have finished loading, so lay out
    // and redraw every panel once they arrive.
    if (document.fonts?.load) {
      const faces = [`700 20px ${FONTS.display}`, `600 20px ${FONTS.display}`, `400 20px ${FONTS.sans}`, `500 20px ${FONTS.mono}`];
      Promise.all(faces.map((f) => document.fonts.load(f)))
        .then(() => { for (const p of this.panels) p.setRows(p.rows); })
        .catch(() => {});
    }
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
      if (!p.visible || !p.interactive || p.ownerIx === ix) { p.hover.delete(ix); p.pokeZ.delete(ix); continue; }
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
      _n.set(0, 0, 1).applyQuaternion(p.group.getWorldQuaternion(_wq));
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
    _n.set(0, 0, 1).applyQuaternion(p.group.getWorldQuaternion(_wq));
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
