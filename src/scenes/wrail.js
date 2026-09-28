// Vertical slider next to the table that shows the slice position on the w
// axis, with a colored tag for each object's w (like the W indicator in 4D
// Toys). Grab the ring or the rail to move the slice.

import * as THREE from 'three';
import { ANA_COLOR, KATA_COLOR } from '../four/sliceView.js';
import { makeLabel } from './base.js';

const ROD_VERT = /* glsl */ `
varying float vT;
varying vec3 vN;
varying vec3 vP;
void main() {
  vT = position.y + 0.5;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vP = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const ROD_FRAG = /* glsl */ `
uniform vec3 uAna;
uniform vec3 uKata;
uniform float uSlice;
varying float vT;
varying vec3 vN;
varying vec3 vP;
void main() {
  vec3 c = vT > 0.5 ? mix(vec3(0.92), uAna, (vT - 0.5) * 2.0) : mix(uKata, vec3(0.92), vT * 2.0);
  vec3 V = normalize(cameraPosition - vP);
  float f = pow(1.0 - abs(dot(normalize(vN), V)), 2.0);
  float band = 1.0 - smoothstep(0.0, 0.02, abs(vT - uSlice));
  c = c * (0.55 + 0.45 * f) + band * 0.6;
  gl_FragColor = vec4(c, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _l = new THREE.Vector3();
const _w0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _col = new THREE.Color();
const RING_ACTIVE = new THREE.Color('#bff3ff');
const RING_IDLE = new THREE.Color('#ffffff');
const RING_R = 0.02, RING_TUBE = 0.0035, RING_ACTIVE_SCALE = 1.25;
const TAG_R = 0.0065, TAG_IN_SLICE = 1.2;
// tag columns start just outside the enlarged ring so tags at the slice don't poke through it
const TAG_X0 = (RING_R + RING_TUBE) * RING_ACTIVE_SCALE + TAG_R * TAG_IN_SLICE + 0.001;
const KATA_OUT = 0.02; // the kata label's distance in front of the post

export class WRail {
  constructor(playground, position, { height = 0.46, base = 0.06 } = {}) {
    this.pg = playground;
    this.view = playground.view;
    this.height = height;
    this.base = base;
    this.group = new THREE.Group();
    this.group.position.copy(position);
    playground.stage.add(this.group);

    this.rodMat = new THREE.ShaderMaterial({
      uniforms: { uAna: { value: ANA_COLOR.clone() }, uKata: { value: KATA_COLOR.clone() }, uSlice: { value: 0.5 } },
      vertexShader: ROD_VERT,
      fragmentShader: ROD_FRAG,
    });
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.0045, 0.0045, 1, 16, 1), this.rodMat);
    rod.scale.set(1, height, 1);
    rod.position.y = base + height / 2;
    this.group.add(rod);

    // post down to the table with a small foot, which sits on the table's ledge outside the rim
    const postMat = new THREE.MeshStandardMaterial({ color: '#c9c4bd', roughness: 0.6, metalness: 0.1 });
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.003, 0.003, base, 8), postMat);
    post.position.y = base / 2;
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.024, 0.008, 32), postMat);
    foot.position.y = 0.004;
    this.group.add(post, foot);

    // ticks every 10 cm of w
    const tickGeo = new THREE.BoxGeometry(0.014, 0.0012, 0.0012);
    const tickMat = new THREE.MeshBasicMaterial({ color: '#8d8a99', toneMapped: false });
    for (let w = Math.ceil(this.view.wMin * 10) / 10; w <= this.view.wMax + 1e-6; w += 0.1) {
      const t = new THREE.Mesh(tickGeo, tickMat);
      t.position.y = this.yFor(w);
      if (Math.abs(w) < 1e-6) t.scale.x = 1.8;
      this.group.add(t);
    }

    this.ringMat = new THREE.MeshBasicMaterial({ color: '#ffffff', toneMapped: false, transparent: true, opacity: 0.95 });
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(RING_R, RING_TUBE, 12, 40).rotateX(Math.PI / 2), this.ringMat);
    this.disc = new THREE.Mesh(
      new THREE.CircleGeometry(RING_R, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, toneMapped: false }),
    );
    this.ring.add(this.disc);
    this.group.add(this.ring);

    this.maxTags = 64;
    this.tags = new THREE.InstancedMesh(new THREE.SphereGeometry(TAG_R, 12, 8), new THREE.MeshBasicMaterial({ toneMapped: false }), this.maxTags);
    this.tags.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.tags.frustumCulled = false;
    this.group.add(this.tags);

    // ana goes above the rod. kata goes beside the post and update() moves it to the viewer's side.
    const plate = 'rgba(27,31,38,0.92)'; // the text alone is hard to see against the light sky
    const ana = makeLabel('ana  +w', { size: 0.018, color: '#ff8fbf', bg: plate });
    ana.position.set(0, base + height + 0.022, 0);
    const kata = makeLabel('kata  −w', { size: 0.018, color: '#7fd8ff', bg: plate });
    kata.position.set(0, base - 0.018, KATA_OUT);
    this.kata = kata;
    this.labels = [ana, kata];
    this.group.add(ana, kata);

    this.hovered = false;
    this.grabbedBy = null;
  }

  yFor(w) {
    const v = this.view;
    return this.base + ((w - v.wMin) / (v.wMax - v.wMin)) * this.height;
  }

  wFor(y) {
    const v = this.view;
    return v.wMin + ((y - this.base) / this.height) * (v.wMax - v.wMin);
  }

  // Sets _a and _b to the rail's world-space endpoints
  _segment() {
    _a.set(0, this.base, 0); this.group.localToWorld(_a);
    _b.set(0, this.base + this.height, 0); this.group.localToWorld(_b);
  }

  nearDistance(p) {
    this._segment();
    const ab = _l.subVectors(_b, _a);
    const t = THREE.MathUtils.clamp(_w0.subVectors(p, _a).dot(ab) / ab.lengthSq(), 0, 1);
    const closest = _p1.copy(_a).addScaledVector(ab, t);
    return closest.distanceTo(p) - 0.022;
  }

  rayDistance(o, d) {
    this._segment();
    // closest approach between the ray and the rail segment
    const u = _l.subVectors(_b, _a);
    const w0 = _w0.subVectors(o, _a);
    const a = d.dot(d), b = d.dot(u), c = u.dot(u), dd = d.dot(w0), e = u.dot(w0);
    const den = a * c - b * b;
    if (den < 1e-9) return Infinity;
    let s = (b * e - c * dd) / den;
    let t = THREE.MathUtils.clamp((a * e - b * dd) / den, 0, 1);
    s = Math.max(0, s);
    const p1 = _p1.copy(o).addScaledVector(d, s);
    const p2 = _p2.copy(_a).addScaledVector(u, t);
    return p1.distanceTo(p2) < 0.03 ? s : Infinity;
  }

  onHover(ix, on) { this.hovered = on; }

  onGrabStart(ix, mode, kind) {
    this.grabbedBy = ix;
    this.kind = kind;
    this._startHand = this._handY(ix);
    this._startW = this.view.w;
    // grabbing the rail away from the ring jumps the slice there
    const ringY = this.yFor(this.view.w);
    if (Math.abs(this._startHand - ringY) > 0.03) {
      this.pg.setW(this.wFor(this._startHand));
      this._startW = this.view.w;
    }
  }

  _handY(ix) {
    if (this.kind === 'ray' || ix.isMouse) {
      // project the ray onto the rail's vertical line
      this._segment();
      const t = this.rayDistanceParam(ix.rayOrigin, ix.rayDir);
      return t;
    }
    return this.group.worldToLocal(ix.grabPos.clone()).y;
  }

  rayDistanceParam(o, d) {
    const u = _l.subVectors(_b, _a);
    const w0 = _w0.subVectors(o, _a);
    const a = d.dot(d), b = d.dot(u), c = u.dot(u), dd = d.dot(w0), e = u.dot(w0);
    const den = a * c - b * b;
    const t = den > 1e-9 ? (a * e - b * dd) / den : 0;
    return this.base + t * this.height;
  }

  onGrabUpdate(ix) {
    const y = this._handY(ix);
    this.pg.setW(this._startW + (y - this._startHand) * (this.view.wMax - this.view.wMin) / this.height);
  }

  onGrabEnd() { this.grabbedBy = null; }

  update(objects) {
    const v = this.view;
    const y = this.yFor(v.w);
    this.ring.position.y = y;
    this.rodMat.uniforms.uSlice.value = (y - this.base) / this.height;
    const active = this.hovered || this.grabbedBy;
    const s = active ? RING_ACTIVE_SCALE : 1;
    this.ring.scale.setScalar(s);
    this.ringMat.color.copy(active ? RING_ACTIVE : RING_IDLE);

    const m = _m;
    const col = _col;
    let n = 0;
    for (const o of objects) {
      if (n >= this.maxTags || o.hideTag) continue;
      const w = o.obj.pos[3];
      if (w < v.wMin - 0.05 || w > v.wMax + 0.05) continue;
      const k = n % 3;
      const ox = TAG_X0 + k * 0.011;
      const scale = o.obj.inSlice ? TAG_IN_SLICE : 0.8;
      m.makeScale(scale, scale, scale).setPosition(ox, this.yFor(w), 0);
      this.tags.setMatrixAt(n, m);
      col.copy(o.tagColor);
      if (!o.obj.inSlice) col.multiplyScalar(0.45);
      this.tags.setColorAt(n, col);
      n++;
    }
    this.tags.count = n;
    this.tags.instanceMatrix.needsUpdate = true;
    if (this.tags.instanceColor) this.tags.instanceColor.needsUpdate = true;

    // labels face the viewer, and kata stays on the viewer's side of the post
    const head = this.pg.app.headPosition;
    const toHead = this.group.worldToLocal(_p2.copy(head)).setY(0);
    if (toHead.lengthSq() > 1e-6) {
      toHead.setLength(KATA_OUT);
      this.kata.position.x = toHead.x;
      this.kata.position.z = toHead.z;
    }
    for (const l of this.labels) {
      const wp = l.getWorldPosition(_p1);
      l.lookAt(head.x, wp.y, head.z);
    }
  }
}
