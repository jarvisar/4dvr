// Synthesized sound effects (no audio files): UI clicks, grabs, collisions and
// a tone while moving along W. Sounds are positioned with WebAudio panners.

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    this.lastHit = 0;
    this.voices = 0;
  }

  // Has to be called from a user gesture (Enter VR or the first click)
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.7;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 6;
      this.master.connect(comp).connect(this.ctx.destination);
      this._noise = this._makeNoise();
      this._initScrub();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  _makeNoise() {
    const len = this.ctx.sampleRate * 0.5;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  updateListener(camera) {
    if (!this.ctx) return;
    const l = this.ctx.listener;
    const e = camera.matrixWorld.elements;
    const px = e[12], py = e[13], pz = e[14];
    const fx = -e[8], fy = -e[9], fz = -e[10];
    const ux = e[4], uy = e[5], uz = e[6];
    if (l.positionX) {
      const t = this.ctx.currentTime;
      l.positionX.setTargetAtTime(px, t, 0.02); l.positionY.setTargetAtTime(py, t, 0.02); l.positionZ.setTargetAtTime(pz, t, 0.02);
      l.forwardX.setTargetAtTime(fx, t, 0.02); l.forwardY.setTargetAtTime(fy, t, 0.02); l.forwardZ.setTargetAtTime(fz, t, 0.02);
      l.upX.setTargetAtTime(ux, t, 0.02); l.upY.setTargetAtTime(uy, t, 0.02); l.upZ.setTargetAtTime(uz, t, 0.02);
    } else {
      l.setPosition(px, py, pz);
      l.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  _out(pos) {
    if (!pos) return this.master;
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 0.5;
    p.rolloffFactor = 1.2;
    if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; } else p.setPosition(pos.x, pos.y, pos.z);
    p.connect(this.master);
    return p;
  }

  _tone({ freq = 440, type = 'sine', dur = 0.12, gain = 0.2, attack = 0.004, pos = null, slide = 0, delay = 0 }) {
    if (!this.ctx || !this.enabled) return;
    if (this.voices > 24) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this._out(pos));
    o.start(t);
    o.stop(t + dur + 0.02);
    this.voices++;
    o.onended = () => { this.voices--; };
  }

  click() { this._tone({ freq: 1320, type: 'triangle', dur: 0.05, gain: 0.12 }); this._tone({ freq: 2640, dur: 0.03, gain: 0.04 }); }
  hover() { this._tone({ freq: 2200, dur: 0.025, gain: 0.025 }); }
  toggle(on) { this._tone({ freq: on ? 880 : 660, type: 'triangle', dur: 0.07, gain: 0.1, slide: on ? 1.5 : 0.66 }); }
  grab(pos) { this._tone({ freq: 520, type: 'sine', dur: 0.09, gain: 0.14, slide: 1.6, pos }); }
  release(pos) { this._tone({ freq: 700, type: 'sine', dur: 0.08, gain: 0.09, slide: 0.6, pos }); }
  spawn(pos) {
    this._tone({ freq: 392, type: 'triangle', dur: 0.18, gain: 0.1, pos });
    this._tone({ freq: 587, type: 'sine', dur: 0.22, gain: 0.08, pos, delay: 0.05 });
  }
  whoosh(pos) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass'; f.Q.value = 1.2;
    f.frequency.setValueAtTime(400, t);
    f.frequency.exponentialRampToValueAtTime(2400, t + 0.35);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    src.connect(f).connect(g).connect(this._out(pos));
    src.start(t); src.stop(t + 0.45);
  }

  // Percussive knock. Pitch comes from object size and volume from impact speed.
  hit(pos, speed, size = 0.1) {
    if (!this.ctx || !this.enabled) return;
    const now = this.ctx.currentTime;
    if (now - this.lastHit < 0.025 || speed < 0.15) return;
    this.lastHit = now;
    const vol = Math.min(0.5, 0.05 + speed * 0.18);
    const base = 180 / Math.max(0.04, size) * 0.12;
    this._tone({ freq: base * (0.9 + Math.random() * 0.2), type: 'sine', dur: 0.12, gain: vol, pos, slide: 0.7 });
    const src = this.ctx.createBufferSource();
    src.buffer = this._noise;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = base * 6; f.Q.value = 3;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol * 0.6, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);
    src.connect(f).connect(g).connect(this._out(pos));
    src.start(now, Math.random() * 0.3); src.stop(now + 0.06);
  }

  _initScrub() {
    const o = this.ctx.createOscillator();
    const o2 = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    const f = this.ctx.createBiquadFilter();
    o.type = 'sawtooth'; o2.type = 'sine';
    f.type = 'lowpass'; f.frequency.value = 900; f.Q.value = 4;
    g.gain.value = 0;
    o.connect(f); o2.connect(f); f.connect(g).connect(this.master);
    o.start(); o2.start();
    this._scrub = { o, o2, g, f, level: 0 };
  }

  // Continuous tone while moving through W. w01 (0 to 1) sets the pitch and speed sets the volume.
  scrub(w01, speed) {
    if (!this.ctx || !this._scrub) return;
    const s = this._scrub;
    const t = this.ctx.currentTime;
    const target = Math.min(0.06, speed * 0.25);
    const freq = 110 * Math.pow(2, w01 * 2);
    s.o.frequency.setTargetAtTime(freq, t, 0.03);
    s.o2.frequency.setTargetAtTime(freq * 2.001, t, 0.03);
    s.f.frequency.setTargetAtTime(500 + w01 * 1500, t, 0.05);
    s.g.gain.setTargetAtTime(this.enabled ? target : 0, t, target > s.level ? 0.02 : 0.12);
    s.level = target;
  }

  // Fades it out, for when nothing will update it anymore
  stopScrub() {
    const s = this._scrub;
    if (!s) return;
    s.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
    s.level = 0;
  }
}
