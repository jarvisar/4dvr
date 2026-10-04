// VR UI panels drawn to a canvas texture, with fingertip and ray input.
//
// Panels are laid out from a list of rows and only redrawn when a displayed
// value changes. Buttons are at least 22 mm tall with a gap of about 1 cm,
// following Meta's hand interaction guidelines.
//
// On a flat screen the menu's canvas is shown in the page instead (DomPanel).

import * as THREE from 'three';

// Canvas resolution in VR. A panel shown in the page uses the screen's instead.
// About 24 texels per degree at the menu's distance, close to the Quest 3's
// 25 pixels per degree, so text isn't magnified on the way to the display.
export const PX_PER_M = 3000;
// line widths are given in pixels at this resolution and scaled from it
const LINE_PX_PER_M = 2000;
const PAD = 0.014;
const GAP = 0.009;
// how far outside a widget a fingertip or ray still hits it. Less than half the
// gap, so neighbors never overlap.
const HIT_PAD = 0.003;
// a title row without a subtitle is shorter
const ROW_H = { title: 0.054, titleOnly: 0.036, tabs: 0.036, buttons: 0.036, toggles: 0.036, slider: 0.054, text: 0.0 };
// close button at the right end of a title row. It stays above the subtitle.
const CLOSE_SIZE = 0.03;
// corner radius of the plate and of buttons (m)
const PLATE_R = 0.005;
const BTN_R = 0.003;
const TEXT_SIZE = 0.0108;
const LINE_H = 0.0158;
const LEGEND_GAP = 0.005; // between the entries of a legend row
// button labels: default and minimum font size (m), padding on each side
const LABEL = { size: 0.0122, small: 0.0108, min: 0.0068, pad: 0.004 };
// toggles: checkbox size and left inset, and where the label starts (m)
const CHECK = { size: 0.0115, x: 0.009, textX: 0.0275 };
// widgets draw at most this far above or below their box (hover rings), in m
const BAND_PAD = 0.004;

// Same look as style.css. Charcoal plates with a black rim, beveled gradient
// buttons, and glossy blue for whatever is selected. Pairs are the top and
// bottom of a vertical gradient. Pink (ana, +w) and cyan (kata, -w) are only
// used where they mean a direction along w.
export const COLORS = {
  plate: 'rgba(20, 20, 20, 0.95)',
  plateTop: 'rgba(38, 38, 38, 0.95)',
  titlebar: ['#3d3d3d', '#262626'],
  edge: '#050505',
  ink: '#eeeeee',
  muted: '#a6a6a6',
  faint: '#6c6c6c',
  btn: ['#4a4a4a', '#2d2d2d'],
  btnHover: ['#585858', '#393939'],
  btnPress: ['#232323', '#323232'],
  btnOff: 'rgba(40, 40, 40, 0.6)', // a button that does nothing right now
  select: ['#2c75c9', '#1a55a2'], // white text on the top has 4.8:1 contrast
  selectHover: ['#2f79cd', '#1d5cad'],
  selectIn: ['#1a55a2', '#2c75c9'], // pressed in, for the selected page tab
  selectEdge: '#0c3163',
  well: '#0b0b0b', // slider grooves
  accent: '#4d9cf8',
  glow: 'rgba(77, 156, 248, 0.9)', // hover rings
  label: 'rgba(20, 20, 20, 0.9)', // plate behind text labels in the scenes
  ana: '#ff4f9a',
  kata: '#33c3ff',
};

export const FONTS = {
  sans: "'Open Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif",
  mono: "'Inconsolata', Consolas, monospace",
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function setFont(ctx, weight, size, family) {
  ctx.font = `${weight} ${size}px ${family}`;
}

// Fill the current path with a vertical gradient from y to y + h
function fillV(ctx, y, h, [top, bottom]) {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fill();
}

function shadow(ctx, color = 'transparent', dy = 0, blur = 0) {
  ctx.shadowColor = color;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = dy;
  ctx.shadowBlur = blur;
}

// Unit plane whose v runs down the canvas, for textures uploaded without a flip
function panelGeometry() {
  const g = new THREE.PlaneGeometry(1, 1);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
  return g;
}

const isLabelled = (w) => w.type === 'button' || w.type === 'tab' || w.type === 'toggle';
// Items (and slider rows) can have disabled(), for options that don't apply
// right now. They're drawn faded and can't be pressed.
const isDisabled = (w) => !!(w.type === 'slider' ? w.row.disabled?.() : w.item?.disabled?.());
const _band = new THREE.Box2();
const _bandAt = new THREE.Vector2();

export class UIPanel {
  // `anchor: 'top'` puts the group's origin at the middle of the top edge
  // instead of the center, so rows below can change without moving the top.
  constructor(ui, { width = 0.3, rows = [], name = 'panel', anchor = 'center' } = {}) {
    this.ui = ui;
    this.name = name;
    this.width = width;
    this.anchorTop = anchor === 'top';
    this.height = 0.1;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.texture = this._makeTexture();
    // same canvas, used as the source for partial uploads (see _uploadRows). Never uploaded itself.
    this._source = new THREE.Texture(this.canvas);
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, toneMapped: false, depthWrite: false, opacity: 1 });
    this.mesh = new THREE.Mesh(panelGeometry(), this.material);
    this.mesh.renderOrder = 20;
    this.group = new THREE.Group();
    this.group.add(this.mesh);
    this.group.name = name;
    this.widgets = [];
    this.hover = new Map();   // widget per interactor
    this.pressed = new Map(); // widget per interactor
    this.pokeZ = new Map();
    this.opacity = 1;
    this.interactive = true;
    this.px = PX_PER_M;       // canvas pixels per meter
    this.dom = false;         // true while the canvas is shown in the page (see DomPanel)
    this._drawn = [];         // what each widget showed when last drawn (see _changedBand)
    this._fit = new Map();    // label font size per row, as { key, size } (see _fitRow)
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
        const h = row.sub ? ROW_H.title : ROW_H.titleOnly;
        this.widgets.push({ type: 'title', row, x: PAD, y, w, h });
        if (row.close) {
          // its own row object, so its label isn't fitted along with anything else
          const item = { label: 'Close', icon: 'close', onClick: row.close };
          this.widgets.push({ type: 'button', row: { type: 'buttons', items: [item] }, item, x: PAD + w - CLOSE_SIZE, y, w: CLOSE_SIZE, h: CLOSE_SIZE });
        }
        y += h;
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
        setFont(this.ctx, 600, TEXT_SIZE * this.px, FONTS.sans);
        const widest = Math.max(...row.items.map(([key]) => this.ctx.measureText(key).width)) / this.px;
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
    this.canvas.width = Math.round(this.width * this.px);
    this.canvas.height = Math.round(this.height * this.px);
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
    this.onLayout?.();
  }

  // What a widget shows, as a string that changes whenever it needs a redraw
  _state(w, hovered, pressed) {
    const r = w.row;
    let s = '';
    if (w.item && typeof w.item.label === 'function') s += w.item.label(); // e.g. Play / Pause
    if (w.type === 'tab') s += r.get() === w.item.value ? '1' : '0';
    else if (w.type === 'toggle') s += w.item.get() ? '1' : '0';
    else if (w.type === 'button' && w.item.active) s += w.item.active() ? '1' : '0';
    else if (w.type === 'slider') s += r.get().toFixed(3);
    else if (w.type === 'text' && typeof r.text === 'function') s += r.text();
    else if (w.type === 'title') s += (typeof r.text === 'function' ? r.text() : '') + (typeof r.sub === 'function' ? r.sub() : '');
    if (isDisabled(w)) s += 'd';
    if (hovered) s += 'h';
    if (pressed) s += 'p';
    return s;
  }

  // Band of the canvas { y0, y1 } (meters) covering the widgets that changed
  // since the last draw, or null when nothing changed.
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
    if (!this.group.visible && !this.dom) return;
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

  // Lines of a text row wrapped to w meters
  _wrap(row, w) {
    const text = typeof row.text === 'function' ? row.text() : row.text;
    return this._wrapString(text, w, row.bold ? 600 : 500);
  }

  _wrapString(text, w, weight) {
    setFont(this.ctx, weight, TEXT_SIZE * this.px, FONTS.sans);
    return wrapText(this.ctx, text, w * this.px);
  }

  // Lays the panel out again at a new canvas resolution
  setPixelsPerMeter(px) {
    if (px === this.px) return;
    this.px = px;
    this.setRows(this.rows);
  }

  // Font size (px) for a button row's labels. It's the largest size that fits
  // every label in the row, so a row never mixes sizes. Only measured again
  // when a label changes.
  _fitRow(row) {
    const ws = this._rowWidgets.get(row);
    let key = '';
    for (const w of ws) key += labelText(w.item) + '\n';
    const known = this._fit.get(row);
    if (known && known.key === key) return known.size;
    const ctx = this.ctx;
    const S = this.px;
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

  // Draw the panel. With a band ({ y0, y1 } in meters) only that strip of the
  // canvas is redrawn, clipped and uploaded. The plate and every widget that
  // reaches into it get drawn again, so it ends up the same as a full redraw.
  // A live value (a slider, a distance) then costs a small upload instead of
  // the whole panel texture.
  draw(band = null) {
    const ctx = this.ctx;
    const S = this.px;
    const lw = (n) => Math.max(1, (n * S) / LINE_PX_PER_M);
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

    // panel: plate with a black rim and a faint highlight just inside it
    const inset = lw(2);
    const plate = () => roundRect(ctx, inset, inset, W - 2 * inset, H - 2 * inset, PLATE_R * S);
    plate();
    const sheen = ctx.createLinearGradient(0, 0, 0, Math.min(H, 0.08 * S));
    sheen.addColorStop(0, COLORS.plateTop);
    sheen.addColorStop(1, COLORS.plate);
    ctx.fillStyle = sheen;
    ctx.fill();
    const rim = () => {
      plate();
      ctx.lineWidth = lw(2);
      ctx.strokeStyle = COLORS.edge;
      ctx.stroke();
      roundRect(ctx, inset * 2, inset * 2, W - 4 * inset, H - 4 * inset, PLATE_R * S - inset);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.stroke();
    };
    rim();

    const hovered = this._hovered;
    const pressed = this._pressed;
    this._relayout = false;
    // etched line: dark, with a light line under it
    const etch = (x0, yy, x1) => {
      ctx.fillStyle = COLORS.edge;
      ctx.fillRect(x0, yy, x1 - x0, lw(2));
      ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
      ctx.fillRect(x0, yy + lw(2), x1 - x0, lw(2));
    };
    // 1px highlight along the top of the current path
    const bevel = (top, alpha) => {
      ctx.save();
      ctx.clip();
      ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
      ctx.fillRect(0, top + lw(1), W, lw(2));
      ctx.restore();
    };

    for (const w of this.widgets) {
      if (band && !reaches(w)) continue;
      const x = w.x * S, y = w.y * S, ww = w.w * S, hh = w.h * S;
      const r = w.row;
      if (w.type === 'title') {
        const text = typeof r.text === 'function' ? r.text() : r.text;
        const lineY = y + hh - 0.001 * S;
        const bar = w.y <= PAD + 1e-6;
        if (bar) {
          // the first title gets a title bar across the top of the plate
          ctx.save();
          plate();
          ctx.clip();
          ctx.beginPath();
          ctx.rect(0, 0, W, lineY);
          fillV(ctx, 0, lineY, COLORS.titlebar);
          ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
          ctx.fillRect(0, inset * 2, W, lw(2));
          ctx.restore();
          rim();
        }
        etch(bar ? inset * 2 : x, lineY, bar ? W - inset * 2 : x + ww);
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        ctx.fillStyle = COLORS.ink;
        shadow(ctx, 'rgba(0, 0, 0, 0.85)', -lw(2));
        setFont(ctx, 700, 0.0195 * S, FONTS.sans);
        ctx.fillText(String(text), x, y + 0.0205 * S);
        const sub = typeof r.sub === 'function' ? r.sub() : r.sub;
        if (sub) {
          ctx.fillStyle = COLORS.muted;
          setFont(ctx, 500, 0.0106 * S, FONTS.sans);
          ctx.fillText(String(sub), x, y + 0.0375 * S);
        }
        shadow(ctx);
      } else if (w.type === 'button' || w.type === 'tab' || w.type === 'toggle') {
        const on = w.type === 'tab' ? r.get() === w.item.value : w.type === 'toggle' ? w.item.get() : (w.item.active ? w.item.active() : false);
        const off = isDisabled(w);
        const isHover = !off && hovered.has(w), isPressed = !off && pressed.has(w);
        const selected = on && w.type !== 'toggle' && !off;
        const pages = r.style === 'pages';
        if (pages) {
          // The menu's page tabs are one segmented control, so they read as
          // switching pages rather than as more buttons. Each tab's segment
          // reaches halfway into the gaps beside it, and the selected page is
          // pressed in.
          const ws = this._rowWidgets.get(r);
          const i = ws.indexOf(w), last = ws[ws.length - 1];
          const tx = ws[0].x * S, tw = (last.x + last.w) * S - tx;
          const track = () => roundRect(ctx, tx, y, tw, hh, BTN_R * S);
          if (i === 0) {
            track();
            fillV(ctx, y, hh, COLORS.btn);
            bevel(y, 0.14);
          }
          const sx0 = i === 0 ? tx : ((ws[i - 1].x + ws[i - 1].w + w.x) / 2) * S;
          const sx1 = w === last ? tx + tw : ((w.x + w.w + ws[i + 1].x) / 2) * S;
          ctx.save();
          track();
          ctx.clip();
          if (selected || isHover || isPressed) {
            ctx.beginPath();
            ctx.rect(sx0, y, sx1 - sx0, hh);
            fillV(ctx, y, hh, selected ? COLORS.selectIn : isPressed ? COLORS.btnPress : COLORS.btnHover);
            if (selected) {
              const g = ctx.createLinearGradient(0, y, 0, y + 0.005 * S);
              g.addColorStop(0, 'rgba(0, 0, 0, 0.4)');
              g.addColorStop(1, 'rgba(0, 0, 0, 0)');
              ctx.fillStyle = g;
              ctx.fillRect(sx0, y, sx1 - sx0, 0.005 * S);
            }
          }
          if (i > 0) {
            ctx.fillStyle = COLORS.edge;
            ctx.fillRect(sx0 - lw(1), y, lw(2), hh);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.07)';
            ctx.fillRect(sx0 + lw(1), y, lw(2), hh);
          }
          // a ring on hover shows what a finger or ray is on
          if (isHover || isPressed) {
            ctx.lineWidth = lw(3);
            ctx.strokeStyle = selected ? '#fff' : COLORS.glow;
            ctx.strokeRect(sx0 + lw(3), y + lw(3), sx1 - sx0 - lw(6), hh - lw(6));
          }
          ctx.restore();
          if (w === last) {
            track();
            ctx.lineWidth = lw(2);
            ctx.strokeStyle = COLORS.edge;
            ctx.stroke();
          }
        } else {
          roundRect(ctx, x, y, ww, hh, BTN_R * S);
          if (off) {
            ctx.fillStyle = COLORS.btnOff;
            ctx.fill();
          } else {
            fillV(ctx, y, hh, selected ? (isHover ? COLORS.selectHover : COLORS.select) : isPressed ? COLORS.btnPress : isHover ? COLORS.btnHover : COLORS.btn);
            if (!isPressed) bevel(y, selected ? 0.28 : 0.14);
          }
          ctx.lineWidth = lw(2);
          ctx.strokeStyle = selected ? COLORS.selectEdge : COLORS.edge;
          ctx.stroke();
          // a glowing ring on hover shows what a finger or ray is on
          if (isHover || isPressed) {
            shadow(ctx, selected ? 'rgba(255, 255, 255, 0.6)' : COLORS.glow, 0, 0.003 * S);
            ctx.lineWidth = lw(3);
            ctx.strokeStyle = selected ? '#fff' : COLORS.glow;
            ctx.stroke();
            shadow(ctx);
          }
        }
        if (w.item.icon === 'close') {
          const c = 0.0052 * S, cx = x + ww / 2, cy = y + hh / 2;
          ctx.beginPath();
          ctx.moveTo(cx - c, cy - c); ctx.lineTo(cx + c, cy + c);
          ctx.moveTo(cx + c, cy - c); ctx.lineTo(cx - c, cy + c);
          ctx.lineWidth = 0.0017 * S;
          ctx.lineCap = 'round';
          ctx.strokeStyle = COLORS.ink;
          shadow(ctx, 'rgba(0, 0, 0, 0.7)', -lw(2));
          ctx.stroke();
          shadow(ctx);
          continue;
        }
        let tx = x + ww / 2;
        ctx.textAlign = 'center';
        if (w.type === 'toggle') {
          // checkbox: a light box when off, blue with a white check mark when on
          const sz = CHECK.size * S, px = x + CHECK.x * S, py = y + hh / 2 - sz / 2;
          roundRect(ctx, px, py, sz, sz, 0.0022 * S);
          fillV(ctx, py, sz, off ? [COLORS.faint, '#454545'] : on ? ['#4b94e6', '#1c5cab'] : ['#f4f4f4', '#bdbdbd']);
          ctx.lineWidth = lw(2);
          ctx.strokeStyle = on && !off ? COLORS.selectEdge : COLORS.edge;
          ctx.stroke();
          if (on) {
            ctx.beginPath();
            ctx.moveTo(px + sz * 0.24, py + sz * 0.52);
            ctx.lineTo(px + sz * 0.43, py + sz * 0.7);
            ctx.lineTo(px + sz * 0.77, py + sz * 0.32);
            ctx.lineWidth = lw(4);
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.strokeStyle = '#fff';
            shadow(ctx, 'rgba(0, 0, 0, 0.5)', -lw(2));
            ctx.stroke();
            shadow(ctx);
          }
          tx = x + CHECK.textX * S;
          ctx.textAlign = 'left';
        }
        ctx.fillStyle = off ? COLORS.faint : selected ? '#fff' : pages ? '#dcdcdc' : (w.type === 'toggle' && !on ? '#d0d0d0' : COLORS.ink);
        setFont(ctx, 600, this._fitRow(r), FONTS.sans);
        ctx.textBaseline = 'middle';
        if (!off) shadow(ctx, 'rgba(0, 0, 0, 0.6)', -lw(2));
        ctx.fillText(labelText(w.item), tx, y + hh / 2 + 0.0006 * S);
        shadow(ctx);
      } else if (w.type === 'slider') {
        const v = r.get();
        const span = r.max - r.min;
        const t = THREE.MathUtils.clamp((v - r.min) / span, 0, 1);
        const off = isDisabled(w);
        ctx.textBaseline = 'alphabetic';
        ctx.textAlign = 'left';
        ctx.fillStyle = off ? COLORS.faint : COLORS.muted;
        setFont(ctx, 500, 0.0106 * S, FONTS.sans);
        ctx.fillText(String(r.label), x, y + 0.0125 * S);
        // the value in a small recessed readout
        const value = r.format ? r.format(v) : v.toFixed(2);
        setFont(ctx, 600, 0.0118 * S, FONTS.mono);
        const vw = ctx.measureText(value).width + 0.007 * S;
        roundRect(ctx, x + ww - vw, y + 0.0013 * S, vw, 0.0148 * S, 0.002 * S);
        ctx.fillStyle = COLORS.well;
        ctx.fill();
        ctx.lineWidth = lw(2);
        ctx.strokeStyle = COLORS.edge;
        ctx.stroke();
        ctx.textAlign = 'right';
        ctx.fillStyle = off ? COLORS.faint : COLORS.ink;
        ctx.fillText(value, x + ww - 0.0035 * S, y + 0.0122 * S);

        // groove, with a light line under it so it looks cut into the plate
        const ty = y + 0.032 * S;
        const th = 0.0045 * S;
        roundRect(ctx, x, ty - th / 2, ww, th, th / 2);
        ctx.fillStyle = COLORS.well;
        ctx.fill();
        ctx.lineWidth = lw(2);
        ctx.strokeStyle = COLORS.edge;
        ctx.stroke();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.fillRect(x + th / 2, ty + th / 2 + lw(1), ww - th, lw(2));
        // center detent mark
        const from = r.center !== undefined ? (r.center - r.min) / span : 0;
        if (r.center !== undefined) {
          ctx.fillStyle = off ? COLORS.faint : COLORS.muted;
          ctx.fillRect(x + ww * from - lw(3) / 2, ty - 0.0075 * S, lw(3), 0.015 * S);
        }
        // fill from the center detent (or the minimum) to the value
        const x0 = x + ww * Math.min(from, t), x1 = x + ww * Math.max(from, t);
        roundRect(ctx, x0, ty - th / 2, Math.max(th, x1 - x0), th, th / 2);
        if (off) {
          ctx.fillStyle = '#2a2a2a';
          ctx.fill();
        } else if (r.gradient) {
          const g = ctx.createLinearGradient(x, 0, x + ww, 0);
          g.addColorStop(0, r.gradient[0]); g.addColorStop(1, r.gradient[1]);
          ctx.fillStyle = g;
          ctx.fill();
          bevel(ty - th / 2, 0.35);
        } else {
          fillV(ctx, ty - th / 2, th, ['#6aacf5', '#2668b8']);
          bevel(ty - th / 2, 0.35);
        }
        // knob: a glossy round handle, larger with a halo while hovered or held
        const kx = x + ww * t;
        const active = !off && (hovered.has(w) || pressed.has(w));
        const kr = (active ? 0.0078 : 0.0066) * S;
        if (active) {
          ctx.beginPath();
          ctx.arc(kx, ty, kr + 0.004 * S, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(77, 156, 248, 0.35)';
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(kx, ty, kr, 0, Math.PI * 2);
        shadow(ctx, 'rgba(0, 0, 0, 0.6)', lw(2), lw(4));
        fillV(ctx, ty - kr, kr * 2, off ? [COLORS.faint, '#454545'] : ['#fdfdfd', '#adadad']);
        shadow(ctx);
        ctx.lineWidth = lw(2);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.8)';
        ctx.stroke();
      } else if (w.type === 'text') {
        const lines = this._wrap(r, w.w);
        if (lines.length > w.lines && w.lines < (r.lines || 8)) this._relayout = true;
        // text past the row's line limit gets cut, so the last line says so
        else if (lines.length > w.lines) lines[w.lines - 1] = ellipsize(ctx, lines[w.lines - 1], ww);
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
    // In the page the canvas is shown as it is. The texture is uploaded whole
    // if the panel is drawn in 3D again.
    if (band && !this.dom) this._uploadRows(y0, y1);
    else this.texture.needsUpdate = true;
    this.onDraw?.();
  }

  // Copy canvas rows y0 to y1 (pixels) into the texture instead of uploading all of it
  _uploadRows(y0, y1) {
    _band.min.set(0, y0);
    _band.max.set(this.canvas.width, y1);
    _bandAt.set(0, y0);
    this.ui.app.renderer.copyTextureToTexture(this._source, this.texture, _band, _bandAt);
  }

  // Panel-local point (meters, origin at top-left, y down) for a world point
  toPanel(world, out = new THREE.Vector3()) {
    out.copy(world);
    this.group.worldToLocal(out);
    out.x += this.width / 2;
    out.y = (this.anchorTop ? 0 : this.height / 2) - out.y;
    return out; // z = distance in front of the panel
  }

  // Inverse of toPanel
  fromPanel(x, y, z = 0, out = new THREE.Vector3()) {
    out.set(x - this.width / 2, (this.anchorTop ? 0 : this.height / 2) - y, z);
    return this.group.localToWorld(out);
  }

  widgetAt(px, py, pad = HIT_PAD) {
    for (const w of this.widgets) {
      if (w.type === 'title' || w.type === 'text' || w.type === 'legend') continue;
      if (px >= w.x - pad && px <= w.x + w.w + pad && py >= w.y - pad && py <= w.y + w.h + pad) return isDisabled(w) ? null : w;
    }
    return null;
  }

  activate(w, px) {
    if (isDisabled(w)) return;
    const audio = this.ui.app.audio;
    if (w.type === 'button') { w.item.onClick?.(); audio.click(); }
    else if (w.type === 'tab') { w.row.set(w.item.value); audio.click(); }
    else if (w.type === 'toggle') { const v = !w.item.get(); w.item.set(v); audio.toggle(v); }
    else if (w.type === 'slider') this.dragSlider(w, px);
  }

  dragSlider(w, px) {
    const r = w.row;
    if (isDisabled(w)) return;
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

function ellipsize(ctx, line, maxW) {
  const words = line.split(' ');
  while (words.length > 1 && ctx.measureText(`${words.join(' ')}…`).width > maxW) words.pop();
  return `${words.join(' ')}…`;
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

// Shows a panel's canvas in the page instead of in 3D. The menu uses this on
// a flat screen. It then keeps one size in every scene and scrolls when it
// doesn't fit, instead of shrinking with the window.
//
// The canvas is drawn at the screen's resolution. The mouse and touch use the
// same widgets as in VR, but buttons act on release like normal buttons, so a
// touch that scrolls the panel doesn't press anything. Sliders act on press
// with a mouse. With touch they wait for the finger to move sideways, since
// moving up or down scrolls the panel.
//
// For the keyboard and screen readers, every widget also gets an invisible
// DOM control laid over it (a button, checkbox or range input, or text). They
// let pointer events through, so the mouse and touch still go to the canvas.
const DOM_POINTER = { index: -1 }; // hover and press key, separate from the 3D interactors
const TAP_SLOP = 8; // CSS pixels a press can move and still be a click

const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
const setAttr = (el, name, value) => {
  if (value === null) el.removeAttribute(name);
  else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
};
const valueOf = (v) => (typeof v === 'function' ? v() : v);

export class DomPanel {
  constructor(panel, parent, label) {
    this.panel = panel;
    this.shown = false;
    this.el = document.createElement('div');
    this.el.className = 'hud-panel';
    this.el.hidden = true;
    this.el.setAttribute('role', 'region');
    this.el.setAttribute('aria-label', label);
    panel.canvas.setAttribute('aria-hidden', 'true'); // the controls below stand in for it
    this.controls = document.createElement('div');
    this.controls.className = 'hud-panel-controls';
    this.el.append(panel.canvas, this.controls);
    parent.append(this.el);
    this._w = 0;
    this._h = 0;
    this._down = null;
    this._drag = null;
    this._items = [];
    panel.onLayout = () => { this.update(); this._build(); };
    panel.onDraw = () => this._sync();
    const c = panel.canvas;
    c.style.touchAction = 'pan-y'; // vertical swipes scroll the panel
    c.addEventListener('pointermove', (e) => this._move(e));
    c.addEventListener('pointerdown', (e) => this._press(e));
    c.addEventListener('pointerup', (e) => this._release(e));
    c.addEventListener('pointercancel', () => this._end());
    c.addEventListener('pointerleave', () => { if (!this._drag) { this._hover(null); this._end(); } });
    c.addEventListener('contextmenu', (e) => e.preventDefault()); // no "Save image" menu, same as the 3D canvas
    this.el.addEventListener('scroll', () => this._fade(), { passive: true });
    new ResizeObserver(() => this._fade()).observe(this.el); // its height depends on the window and the page's other controls
    window.addEventListener('resize', () => { if (this.shown) this.fit(); });
  }

  setShown(on) {
    if (on === this.shown) return;
    this.shown = on;
    this.el.hidden = !on;
    this.panel.dom = on;
    if (on) {
      this.fit();
      this._build(); // fit() only lays the panel out again if its resolution changed
    } else {
      this._end();
      this._hover(null);
      this.panel.setPixelsPerMeter(PX_PER_M); // back to the VR resolution
    }
  }

  // Lays a DOM control over each widget. Runs after every layout. A button can
  // rebuild the rows it's in (a preset rebuilds the menu), so keyboard focus
  // goes back to the same control even when another row was inserted.
  _build() {
    if (!this.shown) return;
    const p = this.panel;
    const identity = (w) => JSON.stringify([w.type, w.type === 'slider' ? w.row.label : w.item?.value ?? labelText(w.item)]);
    const focusedItem = this._items.find((it) => it.el === document.activeElement);
    const focused = focusedItem ? identity(focusedItem.w) : null;
    const title = valueOf(p.rows.find((row) => row.type === 'title')?.text);
    if (this._pageTitle !== undefined && title !== this._pageTitle) this.el.scrollTop = 0;
    this._pageTitle = title;
    const s = p.px / (window.devicePixelRatio || 1); // CSS pixels per meter
    this._items = p.widgets.map((w) => {
      const box = document.createElement('div');
      Object.assign(box.style, { left: `${w.x * s}px`, top: `${w.y * s}px`, width: `${w.w * s}px`, height: `${w.h * s}px` });
      const item = { w, box, el: null, sub: null, value: null };
      if (w.type === 'title') {
        item.el = document.createElement('h2');
        item.sub = document.createElement('p');
        box.append(item.el, item.sub);
        return item;
      }
      if (w.type === 'text' || w.type === 'legend') {
        item.el = document.createElement('p');
        box.append(item.el);
        return item;
      }
      const r = w.row;
      const ri = p.rows.indexOf(r); // -1 for the title row's close button
      let el;
      if (w.type === 'slider') {
        el = document.createElement('input');
        el.type = 'range';
        el.min = r.min;
        el.max = r.max;
        el.step = 'any';
        el.setAttribute('aria-label', r.label);
        el.addEventListener('input', () => { if (!isDisabled(w)) r.set(+el.value); });
        // Keys are handled here instead of by the input's own steps, which
        // don't always land on the ends or the center exactly
        el.addEventListener('keydown', (e) => {
          const span = r.max - r.min, step = r.step || span / 50;
          const k = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 10, PageDown: -10 }[e.key];
          let v;
          if (k) v = r.get() + k * step;
          else if (e.key === 'Home') v = r.min;
          else if (e.key === 'End') v = r.max;
          else return;
          e.preventDefault();
          if (r.center !== undefined && Math.abs(v - r.center) < step / 2) v = r.center;
          if (!isDisabled(w)) r.set(THREE.MathUtils.clamp(v, r.min, r.max));
        });
        el.dataset.key = `${ri}`;
      } else {
        el = document.createElement('button');
        el.type = 'button';
        if (w.type === 'toggle') el.setAttribute('role', 'checkbox');
        el.addEventListener('click', () => p.activate(w, w.x + w.w / 2));
        el.dataset.key = ri < 0 ? 'close' : `${ri}.${(r.options || r.items).indexOf(w.item)}`;
      }
      item.el = el;
      box.append(el);
      return item;
    });
    this.controls.replaceChildren(...this._items.map((it) => it.box));
    this._sync();
    if (focused) this._items.find((it) => it.el.dataset.key && identity(it.w) === focused)?.el.focus({ preventScroll: true });
  }

  // Keeps the DOM controls' labels, states and values the same as the canvas
  _sync() {
    if (!this.shown) return;
    for (const it of this._items) {
      const { w, el } = it;
      const r = w.row;
      if (w.type === 'title') {
        setText(el, String(valueOf(r.text)));
        setText(it.sub, String(valueOf(r.sub) || ''));
        continue;
      }
      if (w.type === 'text') { setText(el, String(valueOf(r.text))); continue; }
      if (w.type === 'legend') { setText(el, r.items.map(([k, t]) => `${k}: ${t}`).join(' ')); continue; }
      setAttr(el, 'aria-disabled', isDisabled(w) ? 'true' : null);
      if (w.type === 'slider') {
        const v = r.get();
        if (v !== it.value) {
          it.value = v;
          el.value = v;
          setAttr(el, 'aria-valuetext', r.format ? r.format(v) : v.toFixed(2));
        }
        continue;
      }
      setText(el, labelText(w.item));
      if (w.type === 'tab') setAttr(el, 'aria-pressed', r.get() === w.item.value ? 'true' : 'false');
      else if (w.type === 'toggle') setAttr(el, 'aria-checked', w.item.get() ? 'true' : 'false');
      else setAttr(el, 'aria-current', w.item.active?.() ? 'true' : null); // e.g. the preset that's loaded
    }
  }

  // Draw the canvas at the width CSS gives the panel, in device pixels
  fit() {
    const dpr = window.devicePixelRatio || 1;
    this.panel.setPixelsPerMeter(Math.max(1, Math.round(this.el.clientWidth * dpr)) / this.panel.width);
    this.update();
    this._fade();
  }

  // Sizes the canvas element after the panel is laid out (its height depends on its rows)
  update() {
    const c = this.panel.canvas;
    if (!this.shown || (c.width === this._w && c.height === this._h)) return;
    this._w = c.width;
    this._h = c.height;
    const dpr = window.devicePixelRatio || 1;
    c.style.width = `${c.width / dpr}px`;
    c.style.height = `${c.height / dpr}px`;
    this.el.style.borderRadius = `${(PLATE_R * this.panel.px) / dpr}px`; // the plate's corners
    this._fade();
  }

  // fade the edge that has more of the panel past it, like the scene tabs
  _fade() {
    const el = this.el, max = el.scrollHeight - el.clientHeight;
    el.classList.toggle('more-below', max > 1 && el.scrollTop < max - 1);
    el.classList.toggle('more-above', max > 1 && el.scrollTop > 1);
  }

  _at(e) {
    const r = this.panel.canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * this.panel.width, ((e.clientY - r.top) / r.height) * this.panel.height];
  }

  _hover(w) {
    const p = this.panel;
    if (w) p.hover.set(DOM_POINTER, w);
    else p.hover.delete(DOM_POINTER);
    p.canvas.style.cursor = w ? 'pointer' : '';
  }

  _move(e) {
    const [x, y] = this._at(e);
    if (this._drag) { this.panel.dragSlider(this._drag, x); return; }
    if (e.pointerType !== 'touch') this._hover(this.panel.widgetAt(x, y, 0));
    const d = this._down;
    if (!d) return;
    const dx = Math.abs(e.clientX - d.cx), dy = Math.abs(e.clientY - d.cy);
    if (d.w.type === 'slider' && dx > TAP_SLOP && dx > dy) this._startDrag(d.w, e, x);
    else if (Math.hypot(dx, dy) > TAP_SLOP) this._end();
  }

  _press(e) {
    if (e.button !== 0) return;
    this.panel.ui.app.audio.unlock(); // like a press on the 3D canvas, since ?desktop skips the start screen's click
    const [x, y] = this._at(e);
    const w = this.panel.widgetAt(x, y, 0);
    if (!w) return;
    this.panel.pressed.set(DOM_POINTER, w);
    if (w.type === 'slider' && e.pointerType !== 'touch') this._startDrag(w, e, x);
    else this._down = { w, cx: e.clientX, cy: e.clientY };
  }

  _startDrag(w, e, x) {
    this._down = null;
    this._drag = w;
    this.panel.canvas.setPointerCapture(e.pointerId);
    this.panel.activate(w, x);
  }

  _release(e) {
    const d = this._down;
    if (d) {
      const [x, y] = this._at(e);
      if (this.panel.widgetAt(x, y, 0) === d.w) this.panel.activate(d.w, x);
    }
    this._end();
  }

  _end() {
    this._down = null;
    this._drag = null;
    this.panel.pressed.delete(DOM_POINTER);
  }
}

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const _c = new THREE.Vector3();
const _hp = new THREE.Vector3();
const _wq = new THREE.Quaternion();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _u = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _look = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const HANDLE_HALF = 0.04;
const HANDLE_IDLE = new THREE.Color('#a6a6a6');
const HANDLE_HOT = new THREE.Color('#ffffff');

// Bar under a VR panel for moving it, like the one under Quest system windows.
// It's grabbed like an object (pinch, trigger or grip, up close or with a ray,
// including a tracked hand's ray). The panel keeps facing the head as it moves.
export class PanelHandle {
  constructor(ui, panel) {
    this.ui = ui;
    this.panel = panel;
    this.isUI = true;
    this.nearRadius = 0.025;
    this.mat = new THREE.MeshBasicMaterial({ color: HANDLE_IDLE.clone(), transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
    this.mesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.0045, HANDLE_HALF * 2, 4, 12).rotateZ(Math.PI / 2), this.mat);
    this.mesh.renderOrder = 21;
    panel.group.add(this.mesh);
    this.hovers = 0;
    this.grabbedBy = null;
    this._offset = new THREE.Vector3();
  }

  get enabled() { return this.ui.app.presenting && this.panel.visible; }

  // Centered 16 mm under the panel. Called every frame since the panel's height changes with its page.
  update() {
    const p = this.panel;
    this.mesh.visible = this.ui.app.presenting; // the menu is also the desktop HUD, which doesn't move
    this.mesh.position.set(0, (p.anchorTop ? -p.height : -p.height / 2) - 0.016, 0.002);
    const hot = this.hovers > 0 || this.grabbedBy;
    this.mat.color.copy(hot ? HANDLE_HOT : HANDLE_IDLE);
    this.mat.opacity = p.opacity * (hot ? 1 : 0.8);
    this.mesh.scale.set(hot ? 1.15 : 1, hot ? 1.4 : 1, hot ? 1.4 : 1);
  }

  _segment() {
    this.mesh.updateWorldMatrix(true, false);
    this.mesh.localToWorld(_a.set(-HANDLE_HALF, 0, 0));
    this.mesh.localToWorld(_b.set(HANDLE_HALF, 0, 0));
  }

  nearDistance(p) {
    this._segment();
    _u.subVectors(_b, _a);
    const t = THREE.MathUtils.clamp(_c.subVectors(p, _a).dot(_u) / _u.lengthSq(), 0, 1);
    return _c.copy(_a).addScaledVector(_u, t).distanceTo(p) - 0.006;
  }

  // Ray parameter where the ray passes within 2 cm of the bar, or Infinity
  rayDistance(o, d) {
    this._segment();
    _u.subVectors(_b, _a);
    const w0 = _c.subVectors(o, _a);
    const b = d.dot(_u), c = _u.dot(_u), dd = d.dot(w0), e = _u.dot(w0);
    const den = c - b * b;
    if (den < 1e-9) return Infinity;
    const s = Math.max(0, (b * e - c * dd) / den);
    const t = THREE.MathUtils.clamp((e - b * dd) / den, 0, 1);
    const gap = _hp.copy(o).addScaledVector(d, s).distanceTo(_p.copy(_a).addScaledVector(_u, t));
    return gap < 0.02 ? s : Infinity;
  }

  _grabPoint(ix, out) {
    if (this.kind === 'ray') return out.copy(ix.rayOrigin).addScaledVector(ix.rayDir, this._rayT);
    return out.copy(ix.grabPos);
  }

  onHover(ix, on) { this.hovers = Math.max(0, this.hovers + (on ? 1 : -1)); }

  onGrabStart(ix, mode, kind) {
    this.grabbedBy = ix;
    this.kind = kind === 'ray' ? 'ray' : 'near';
    if (this.kind === 'ray') this._rayT = Math.min(this.rayDistance(ix.rayOrigin, ix.rayDir), 3);
    this._offset.copy(this.panel.group.position).sub(this._grabPoint(ix, _hp));
  }

  onGrabUpdate(ix) {
    const g = this.panel.group;
    g.position.copy(this._grabPoint(ix, _hp)).add(this._offset);
    facePanel(this.panel, this.ui.app.headPosition);
  }

  onGrabEnd() { this.grabbedBy = null; }
}

// Turn a panel so its center faces the head, without rolling it
export function facePanel(panel, head, alpha = 1) {
  const g = panel.group;
  _c.copy(g.position);
  if (panel.anchorTop) _c.y -= (panel.height / 2) * g.scale.y;
  // leaning back no further than panel.maxTilt, if it has one (see HandMenu)
  _look.subVectors(head, _c);
  if (panel.maxTilt !== undefined) _look.y = Math.min(_look.y, Math.hypot(_look.x, _look.z) * Math.tan(panel.maxTilt));
  // Matrix4.lookAt(eye, target) builds a basis whose +Z points from target to
  // eye, so passing (head, center) turns the panel's front (+Z) toward the head.
  _m4.lookAt(_look.add(_c), _c, UP);
  _wq.setFromRotationMatrix(_m4);
  g.quaternion.slerp(_wq, alpha);
}

export class UISystem {
  constructor(app) {
    this.app = app;
    this.panels = [];
    this.handles = []; // PanelHandles, which the InteractionManager treats like interactables
    this.root = new THREE.Group();
    this.root.name = 'ui';
    app.scene.add(this.root);
    // Canvas text only uses web fonts that have finished loading, so lay out
    // and redraw every panel once they arrive.
    if (document.fonts?.load) {
      const faces = [`700 20px ${FONTS.sans}`, `600 20px ${FONTS.sans}`, `500 20px ${FONTS.sans}`, `600 20px ${FONTS.mono}`];
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
    for (const h of this.handles) h.update();
  }

  // Fingertip poke. Returns true when the finger is engaged with a panel.
  updatePoke(ix) {
    ix.pokeHit.panel = null;
    if (!ix.hasPoke) { this.forget(ix); return false; }
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

  // Ray vs visible panels
  raycast(ix) {
    let best = null;
    for (const p of this.panels) {
      if (!p.visible || !p.interactive || p.ownerIx === ix) continue;
      p.group.getWorldPosition(_c);
      _n.set(0, 0, 1).applyQuaternion(p.group.getWorldQuaternion(_wq));
      const denom = _n.dot(ix.rayDir);
      if (denom > -1e-4) continue; // parallel or from behind
      const t = _n.dot(_p.subVectors(_c, ix.rayOrigin)) / denom;
      if (t <= 0 || (best && t > best.t)) continue;
      _hp.copy(ix.rayOrigin).addScaledVector(ix.rayDir, t);
      p.toPanel(_hp, _p);
      if (_p.x < 0 || _p.x > p.width || _p.y < 0 || _p.y > p.height) continue;
      best = { t, panel: p, widget: p.widgetAt(_p.x, _p.y), x: _p.x, y: _p.y };
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
    if (!p.visible) { this.endCapture(ix); return; }
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

  // Closing a panel also ends drags that could keep changing it while hidden.
  cancelPanel(panel) {
    for (const ix of [...this.app.input.xr, this.app.input.mouse]) {
      if (ix.uiCapture?.panel === panel || ix.grabbed?.panel === panel) this.app.interaction.release(ix);
      panel.hover.delete(ix);
      panel.pressed.delete(ix);
      panel.pokeZ.delete(ix);
    }
  }

  // Drops an interactor's hover and press on every panel
  forget(ix) {
    for (const p of this.panels) { p.hover.delete(ix); p.pressed.delete(ix); p.pokeZ.delete(ix); }
    ix.pokeHit.panel = null;
    ix.uiEngaged = false;
  }

  endCapture(ix) {
    const cap = ix.uiCapture;
    if (cap) cap.panel.pressed.delete(ix);
    ix.uiCapture = null;
  }
}
