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
const LEGEND_GAP = 0.005; // between the entries of a legend row
// button labels: default and minimum font size (m), padding on each side
const LABEL = { size: 0.0122, small: 0.0108, min: 0.0068, pad: 0.004 };
// toggles: checkbox size and left inset, and where the label starts (m)
const CHECK = { size: 0.0115, x: 0.009, textX: 0.0275 };
// widgets draw at most this far above or below their box (hover rings), in m
const BAND_PAD = 0.004;

// Same colours and fonts as style.css: slate panels with rounded corners, grey
// buttons, blue for whatever is selected. Pink (ana, +w) and cyan (kata, −w)
// are only used where they mean a direction along w.
export const COLORS = {
  bg: 'rgba(27, 31, 38, 0.95)',
  frame: 'rgba(255, 255, 255, 0.1)',
  ink: '#e6e8ec',
  muted: '#9aa3b0',
  btn: '#2c323c',
  btnHover: '#3b4350',
  btnPress: '#4a5362',
  select: '#1f6bd1',
  selectHover: '#2a76db',
  accent: '#1a9fff',
  ana: '#ff4f9a',
  kata: '#33c3ff',
};

export const FONTS = {
  sans: "'Figtree', 'Segoe UI', system-ui, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, Consolas, monospace",
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function setFont(ctx, weight, size, family) {
  ctx.font = `${weight} ${size}px ${family}`;
}

/** A unit plane whose v runs down the canvas, for textures uploaded without a flip. */
function panelGeometry() {
  const g = new THREE.PlaneGeometry(1, 1);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  return g;
}

const isLabelled = (w) => w.type === 'button' || w.type === 'tab' || w.type === 'toggle';
const _band = new THREE.Box2();
const _bandAt = new THREE.Vector2();

export class UIPanel {
  /**
   * `anchor: 'top'` puts the group's origin at the middle of the top edge
   * instead of the centre, so rows below can change without moving the top.
   */
  constructor(ui, { width = 0.3, rows = [], name = 'panel', anchor = 'center' } = {}) {
    this.ui = ui;
    this.name = name;
    this.width = width;
    this.anchorTop = anchor === 'top';
    this.height = 0.1;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.texture = this._makeTexture();
    // the same canvas as the source of partial uploads (see _uploadRows); never uploaded itself
    this._source = new THREE.Texture(this.canvas);
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, toneMapped: false, depthWrite: false, opacity: 1 });
    this.mesh = new THREE.Mesh(panelGeometry(), this.material);
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
    this._drawn = [];         // what each widget showed when last drawn (see _changedBand)
    this._fit = new Map();    // row -> { key, size }: label font size (see _fitRow)
    this._hovered = new Set();
    this._pressed = new Set();
    this._lastDraw = 0;
    this.setRows(rows);
  }

  _makeTexture() {
    const t = new THREE.CanvasTexture(this.canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    // Canvas row 0 is texture row 0 (the plane's v is flipped instead), so a
    // band of rows can be uploaded by its canvas coordinates.
    t.flipY = false;
    return t;
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
      } else if (row.type === 'legend') {
        // two columns: a gesture or button, then what it does
        setFont(this.ctx, 600, TEXT_SIZE * PX_PER_M, FONTS.sans);
        const widest = Math.max(...row.items.map(([key]) => this.ctx.measureText(key).width)) / PX_PER_M;
        const kw = Math.min(w * 0.4, widest + 0.014);
        const items = row.items.map(([key, text]) => {
          const k = this._wrapString(key, kw - 0.008, 600);
          const t = this._wrapString(text, w - kw, 500);
          return { k, t, n: Math.max(k.length, t.length) };
        });
        const h = items.reduce((s, it) => s + it.n * LINE_H, 0) + (items.length - 1) * LEGEND_GAP + 0.004;
        this.widgets.push({ type: 'legend', row, x: PAD, y, w, h, items, kw });
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
    this.mesh.position.y = this.anchorTop ? -this.height / 2 : 0;
    this.texture.dispose();
    this.texture = this._makeTexture();
    this.material.map = this.texture;
    this._rowWidgets = new Map();
    for (const w of this.widgets) {
      if (!this._rowWidgets.has(w.row)) this._rowWidgets.set(w.row, []);
      this._rowWidgets.get(w.row).push(w);
    }
    this._fit.clear();
    this._drawn.length = 0;
    this._changedBand(); // record what the widgets show now
    this.draw();
  }

  /** What a widget shows, as a string that changes when it has to be redrawn. */
  _state(w, hovered, pressed) {
    const r = w.row;
    let s = '';
    if (w.item && typeof w.item.label === 'function') s += w.item.label(); // e.g. Play / Pause
    if (w.type === 'tab') s += r.get() === w.item.value ? '1' : '0';
    else if (w.type === 'toggle') s += w.item.get() ? '1' : '0';
    else if (w.type === 'button' && w.item.active) s += w.item.active() ? '1' : '0';
    else if (w.type === 'slider') s += r.get().toFixed(3);
    else if (w.type === 'text' && typeof r.text === 'function') s += r.text();
    else if (w.type === 'title' && typeof r.text === 'function') s += r.text();
    if (hovered) s += 'h';
    if (pressed) s += 'p';
    return s;
  }

  /**
   * The widgets that show something different since the last draw, as a band
   * of the canvas { y0, y1 } in metres, or null when nothing changed.
   */
  _changedBand() {
    const hovered = this._hovered, pressed = this._pressed;
    hovered.clear();
    pressed.clear();
    for (const w of this.hover.values()) hovered.add(w);
    for (const w of this.pressed.values()) pressed.add(w);
    let y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < this.widgets.length; i++) {
      const w = this.widgets[i];
      const s = this._state(w, hovered.has(w), pressed.has(w));
      if (s === this._drawn[i]) continue;
      this._drawn[i] = s;
      y0 = Math.min(y0, w.y - BAND_PAD);
      y1 = Math.max(y1, w.y + w.h + BAND_PAD);
    }
    return y0 <= y1 ? { y0, y1 } : null;
  }

  update(time) {
    if (!this.group.visible) return;
    if (time - this._lastDraw > 0.03) {
      const band = this._changedBand();
      if (band) {
        this._lastDraw = time;
        this.draw(band);
        if (this._relayout) this.setRows(this.rows); // a text row outgrew its space
      }
    }
    this.material.opacity = this.opacity;
  }

  /** Lines of a text row wrapped to `w` metres. */
  _wrap(row, w) {
    const text = typeof row.text === 'function' ? row.text() : row.text;
    return this._wrapString(text, w, row.bold ? 600 : 500);
  }

  _wrapString(text, w, weight) {
    setFont(this.ctx, weight, TEXT_SIZE * PX_PER_M, FONTS.sans);
    return wrapText(this.ctx, text, w * PX_PER_M);
  }

  /**
   * Font size (px) for a button row's labels: the largest that fits every
   * label in the row, so a row never mixes sizes. Measured again only when a
   * label changes.
   */
  _fitRow(row) {
    const ws = this._rowWidgets.get(row);
    let key = '';
    for (const w of ws) key += labelText(w.item) + '\n';
    const known = this._fit.get(row);
    if (known && known.key === key) return known.size;
    const ctx = this.ctx;
    const S = PX_PER_M;
    let fit = Infinity;
    for (const w of ws) {
      const label = labelText(w.item);
      const maxW = (w.type === 'toggle' ? w.w - CHECK.textX - LABEL.pad : w.w - 2 * LABEL.pad) * S;
      let size = (w.item.small ? LABEL.small : LABEL.size) * S;
      setFont(ctx, 600, size, FONTS.sans);
      while (ctx.measureText(label).width > maxW && size > LABEL.min * S) {
        size = Math.max(LABEL.min * S, size * 0.95);
        setFont(ctx, 600, size, FONTS.sans);
      }
      fit = Math.min(fit, size);
    }
    this._fit.set(row, { key, size: fit });
    return fit;
  }

  /**
   * Draw the panel. With a band ({ y0, y1 } in metres) only that strip of the
   * canvas is redrawn, clipped, and uploaded: the plate and every widget that
   * reaches into it are drawn again, so it ends up exactly as a full redraw
   * would. A live value (a slider, a distance) then costs a small upload
   * instead of the whole panel texture.
   */
  draw(band = null) {
    const ctx = this.ctx;
    const S = PX_PER_M;
    const W = this.canvas.width, H = this.canvas.height;
    let y0 = 0, y1 = H;
    if (band) {
      y0 = Math.max(0, Math.floor(band.y0 * S));
      y1 = Math.min(H, Math.ceil(band.y1 * S));
    }
    const reaches = (w) => (w.y + w.h + BAND_PAD) * S > y0 && (w.y - BAND_PAD) * S < y1;
    // Draw and upload it whole when the band is most of it, or when a new label
    // changes its row's font size (the row can reach outside the band).
    if (band && (y1 - y0 > H * 0.6 || this.widgets.some((w) => isLabelled(w) && reaches(w) && this._fit.get(w.row)?.size !== this._fitRow(w.row)))) {
      band = null;
      y0 = 0;
      y1 = H;
    }

    ctx.save();
    if (band) {
      ctx.beginPath();
      ctx.rect(0, y0, W, y1 - y0);
      ctx.clip();
    }
    ctx.clearRect(0, y0, W, y1 - y0);

    // panel: plate with a hairline frame
    const inset = 2;
    roundRect(ctx, inset, inset, W - 2 * inset, H - 2 * inset, 0.01 * S);
    ctx.fillStyle = COLORS.bg;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = COLORS.frame;
    ctx.stroke();

    const hovered = this._hovered;
    const pressed = this._pressed;
    this._relayout = false;

    for (const w of this.widgets) {
      if (band && !reaches(w)) continue;
      const x = w.x * S, y = w.y * S, ww = w.w * S, hh = w.h * S;
      const r = w.row;
      if (w.type === 'title') {
        const text = typeof r.text === 'function' ? r.text() : r.text;
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        ctx.fillStyle = COLORS.ink;
        setFont(ctx, 700, 0.0195 * S, FONTS.sans);
        ctx.fillText(String(text), x, y + 0.022 * S);
        if (r.sub) {
          ctx.fillStyle = COLORS.muted;
          setFont(ctx, 500, 0.0106 * S, FONTS.sans);
          ctx.fillText(String(r.sub), x, y + 0.0385 * S);
        }
        ctx.fillStyle = COLORS.frame;
        ctx.fillRect(x, y + hh - 0.004 * S, ww, 2);
      } else if (w.type === 'button' || w.type === 'tab' || w.type === 'toggle') {
        const on = w.type === 'tab' ? r.get() === w.item.value : w.type === 'toggle' ? w.item.get() : (w.item.active ? w.item.active() : false);
        const isHover = hovered.has(w), isPressed = pressed.has(w);
        const selected = on && w.type !== 'toggle';
        roundRect(ctx, x, y, ww, hh, 0.0035 * S);
        ctx.fillStyle = selected ? (isHover ? COLORS.selectHover : COLORS.select) : isPressed ? COLORS.btnPress : isHover ? COLORS.btnHover : COLORS.btn;
        ctx.fill();
        // a ring on hover shows what a finger or ray is on
        if (isHover || isPressed) {
          ctx.lineWidth = 3;
          ctx.strokeStyle = selected ? '#fff' : 'rgba(255, 255, 255, 0.5)';
          ctx.stroke();
        }
        let tx = x + ww / 2;
        ctx.textAlign = 'center';
        if (w.type === 'toggle') {
          // checkbox: outlined when off, blue with a check mark when on
          const sz = CHECK.size * S, px = x + CHECK.x * S, py = y + hh / 2 - sz / 2;
          roundRect(ctx, px, py, sz, sz, 0.0022 * S);
          if (on) {
            ctx.fillStyle = COLORS.accent;
            ctx.fill();
            ctx.beginPath();
            ctx.moveTo(px + sz * 0.24, py + sz * 0.52);
            ctx.lineTo(px + sz * 0.43, py + sz * 0.7);
            ctx.lineTo(px + sz * 0.77, py + sz * 0.32);
            ctx.lineWidth = 4;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.strokeStyle = '#0e1116';
            ctx.stroke();
          } else {
            ctx.lineWidth = 3;
            ctx.strokeStyle = COLORS.muted;
            ctx.stroke();
          }
          tx = x + CHECK.textX * S;
          ctx.textAlign = 'left';
        }
        ctx.fillStyle = selected ? '#fff' : (w.type === 'toggle' && !on ? '#c3c8d0' : COLORS.ink);
        setFont(ctx, 600, this._fitRow(r), FONTS.sans);
        ctx.textBaseline = 'middle';
        ctx.fillText(labelText(w.item), tx, y + hh / 2 + 0.0006 * S);
      } else if (w.type === 'slider') {
        const v = r.get();
        const span = r.max - r.min;
        const t = THREE.MathUtils.clamp((v - r.min) / span, 0, 1);
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        ctx.fillStyle = COLORS.muted;
        setFont(ctx, 500, 0.0106 * S, FONTS.sans);
        ctx.fillText(String(r.label), x, y + 0.0125 * S);
        ctx.textAlign = 'right';
        ctx.fillStyle = COLORS.ink;
        setFont(ctx, 500, 0.0108 * S, FONTS.mono);
        ctx.fillText(r.format ? r.format(v) : v.toFixed(2), x + ww, y + 0.0125 * S);

        const ty = y + 0.032 * S;
        const th = 0.003 * S;
        roundRect(ctx, x, ty - th / 2, ww, th, th / 2);
        ctx.fillStyle = COLORS.btnHover;
        ctx.fill();
        // centre detent mark
        const from = r.center !== undefined ? (r.center - r.min) / span : 0;
        if (r.center !== undefined) {
          ctx.fillStyle = COLORS.muted;
          ctx.fillRect(x + ww * from - 1.5, ty - 0.0075 * S, 3, 0.015 * S);
        }
        // fill from the centre detent (or the minimum) to the value
        const x0 = x + ww * Math.min(from, t), x1 = x + ww * Math.max(from, t);
        let fill = COLORS.accent;
        if (r.gradient) {
          fill = ctx.createLinearGradient(x, 0, x + ww, 0);
          fill.addColorStop(0, r.gradient[0]); fill.addColorStop(1, r.gradient[1]);
        }
        roundRect(ctx, x0, ty - th / 2, Math.max(th, x1 - x0), th, th / 2);
        ctx.fillStyle = fill;
        ctx.fill();
        // knob: a round handle, larger with a halo while hovered or held
        const kx = x + ww * t;
        const active = hovered.has(w) || pressed.has(w);
        const kr = (active ? 0.0075 : 0.0062) * S;
        if (active) {
          ctx.beginPath();
          ctx.arc(kx, ty, kr + 0.004 * S, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(26, 159, 255, 0.3)';
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(kx, ty, kr, 0, Math.PI * 2);
        ctx.fillStyle = COLORS.ink;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.35)';
        ctx.stroke();
      } else if (w.type === 'text') {
        const lines = this._wrap(r, w.w);
        if (lines.length > w.lines && w.lines < (r.lines || 8)) this._relayout = true;
        ctx.fillStyle = r.color || COLORS.muted;
        ctx.textAlign = r.align || 'left';
        ctx.textBaseline = 'alphabetic';
        const ax = r.align === 'center' ? x + ww / 2 : x;
        lines.slice(0, w.lines).forEach((line, i) => ctx.fillText(line, ax, y + (0.0125 + i * LINE_H) * S));
      } else if (w.type === 'legend') {
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        let yy = y;
        for (const it of w.items) {
          ctx.fillStyle = COLORS.ink;
          setFont(ctx, 600, TEXT_SIZE * S, FONTS.sans);
          it.k.forEach((line, i) => ctx.fillText(line, x, yy + (0.0125 + i * LINE_H) * S));
          ctx.fillStyle = COLORS.muted;
          setFont(ctx, 500, TEXT_SIZE * S, FONTS.sans);
          it.t.forEach((line, i) => ctx.fillText(line, x + w.kw * S, yy + (0.0125 + i * LINE_H) * S));
          yy += (it.n * LINE_H + LEGEND_GAP) * S;
        }
      }
    }
    ctx.restore();
    setFont(ctx, 400, 10, FONTS.sans);
    if (band) this._uploadRows(y0, y1);
    else this.texture.needsUpdate = true;
  }

  /** Copy canvas rows y0..y1 (pixels) into the texture, instead of uploading all of it. */
  _uploadRows(y0, y1) {
    _band.min.set(0, y0);
    _band.max.set(this.canvas.width, y1);
    _bandAt.set(0, y0);
    this.ui.app.renderer.copyTextureToTexture(this._source, this.texture, _band, _bandAt);
  }

  /** Panel-local point (metres, origin at top-left, y down) for a world point. */
  toPanel(world, out = new THREE.Vector3()) {
    out.copy(world);
    this.group.worldToLocal(out);
    out.x += this.width / 2;
    out.y = (this.anchorTop ? 0 : this.height / 2) - out.y;
    return out; // z = distance in front of the panel
  }

  /** World point for a panel-local point (the inverse of toPanel). */
  fromPanel(x, y, z = 0, out = new THREE.Vector3()) {
    out.set(x - this.width / 2, (this.anchorTop ? 0 : this.height / 2) - y, z);
    return this.group.localToWorld(out);
  }

  widgetAt(px, py, pad = 0.004) {
    for (const w of this.widgets) {
      if (w.type === 'title' || w.type === 'text' || w.type === 'legend') continue;
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
  return String(typeof item.label === 'function' ? item.label() : item.label);
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
      const faces = [`700 20px ${FONTS.sans}`, `600 20px ${FONTS.sans}`, `500 20px ${FONTS.sans}`, `500 20px ${FONTS.mono}`];
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
    ix.pokeHit.panel = null;
    if (!ix.hasPoke) return false;
    let engaged = false;
    for (const p of this.panels) {
      if (!p.visible || !p.interactive || p.ownerIx === ix) { p.hover.delete(ix); p.pokeZ.delete(ix); continue; }
      p.toPanel(ix.pokePos, _p);
      const inside = _p.x > -0.01 && _p.x < p.width + 0.01 && _p.y > -0.01 && _p.y < p.height + 0.01;
      // A press needs the finger to move through the surface while the panel is
      // shown. A panel that appears with a finger already at its surface doesn't
      // count, so there's no previous depth on its first frame.
      const prevZ = p.pokeZ.has(ix) ? p.pokeZ.get(ix) : _p.z;
      p.pokeZ.set(ix, _p.z);
      const hit = ix.pokeHit;
      const pressedW = p.pressed.get(ix);
      if (pressedW) {
        if (_p.z > 0.018 || !inside) {
          p.pressed.delete(ix);
        } else {
          if (pressedW.type === 'slider') p.dragSlider(pressedW, _p.x);
          engaged = true;
          ix.uiEngaged = true;
          hit.panel = p; hit.x = _p.x; hit.y = _p.y; hit.z = _p.z;
          continue;
        }
      }
      if (inside && _p.z < 0.045 && _p.z > -0.03) {
        engaged = true;
        hit.panel = p; hit.x = _p.x; hit.y = _p.y; hit.z = _p.z;
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
    const p = cap.panel;
    p.group.getWorldPosition(_c);
    _n.set(0, 0, 1).applyQuaternion(p.group.getWorldQuaternion(_wq));
    const denom = _n.dot(ix.rayDir);
    if (Math.abs(denom) < 1e-4) return;
    const t = _n.dot(_p.subVectors(_c, ix.rayOrigin)) / denom;
    if (t > 0) ix.rayLength = t; // the ray and its cursor end on the panel while it's held
    if (!cap.widget || cap.widget.type !== 'slider') return;
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
