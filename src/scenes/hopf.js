// Hopf Garden: the Hopf fibration splits the 3-sphere into great circles, one
// for each point of a 2-sphere. Touching the globe (the 2-sphere) adds the
// fiber for that point, stereographically projected from S³. Any two fibers
// are linked, and the fibers over a circle on the globe form a torus.
//
// h(q) = q i q̄ maps S³ to S². The fiber over p is { q e^{iθ} }. Rotating the
// globe by a unit quaternion u maps q to u q, a 4D rotation that keeps each
// fiber over its base point.

import * as THREE from 'three';
import * as R4 from '../math/rot4.js';
import { SceneBase, makeLabel } from './base.js';
import { LIGHT, LIGHTING_GLSL } from '../core/lighting.js';
import { raySphere } from '../core/interaction.js';
import { REDUCED_MOTION } from '../core/prefs.js';

const MAX_FIBERS = 360;
const SEGMENTS = 96;
const RADIAL = 5;

const FIBER_VERT = /* glsl */ `
uniform mat4 uRot;
uniform float uScale;
uniform float uRadius;
uniform float uMaxR;
uniform vec3 uGlobe;     // world centre and radius of the globe
uniform float uGlobeR;
attribute vec4 aQ;
attribute vec3 aColor;
attribute float aSeed;
varying vec3 vN;
varying vec3 vP;
varying vec3 vColor;
varying float vT;
varying float vFade;
varying float vSeed;

vec4 fiber(float th) {
  float c = cos(th), s = sin(th);
  vec4 q = aQ; // q · (cos θ + i sin θ)
  return vec4(q.x * c - q.y * s, q.x * s + q.y * c, q.z * c + q.w * s, q.w * c - q.z * s);
}
vec3 stereo(vec4 q) {
  return q.xyz / max(1.0 - q.w, 1e-4);
}
void main() {
  // Stereographic projection sends every great circle to an exact circle (or a
  // line). Find the circle from three of its points, then place the vertices
  // evenly around it so large circles stay smooth.
  vec3 a0 = stereo(uRot * fiber(0.0));
  vec3 a1 = stereo(uRot * fiber(2.0943951));
  vec3 a2 = stereo(uRot * fiber(4.1887902));
  vec3 ea = a1 - a0, eb = a2 - a0;
  vec3 n = cross(ea, eb);
  float nn = dot(n, n);
  vec3 c = a0 + cross(dot(ea, ea) * eb - dot(eb, eb) * ea, n) / (2.0 * max(nn, 1e-12));
  float R = length(a0 - c);
  vec3 u = (a0 - c) / max(R, 1e-9);
  vec3 nh = n / sqrt(max(nn, 1e-24));
  vec3 v = cross(nh, u);
  float phi = position.x * 6.28318530718;
  vec3 radial = cos(phi) * u + sin(phi) * v;
  vec3 p0 = c + R * radial;
  // tube cross-section in the (radial, normal) plane; thickness follows the
  // conformal factor (|p|² + 1) / 2 so tubes have constant width on S³
  float ang = position.y;
  vec3 dir = cos(ang) * radial + sin(ang) * nh;
  float k0 = 0.5 * (dot(p0, p0) + 1.0);
  float valid = step(1e-10, nn) * step(R * uScale, 60.0); // not a line / absurdly large circle
  vFade = valid * (1.0 - smoothstep(uMaxR * 0.55, uMaxR, length(p0) * uScale));
  float r = uRadius * clamp(k0, 0.6, 4.0) * (0.25 + 0.75 * vFade);
  // Large circles reach the floor (y = 0), the globe and the viewer. The tube
  // narrows to nothing before it meets them, instead of cutting into them (or,
  // in VR, being cut open by the near plane). Thinning keeps it opaque, so
  // nothing needs sorting.
  vec3 cw = (modelMatrix * vec4(p0 * uScale, 1.0)).xyz;
  r *= smoothstep(0.0, 0.12, cw.y)
    * smoothstep(uGlobeR, uGlobeR + 0.03, distance(cw, uGlobe))
    * smoothstep(0.1, 0.3, distance(cw, cameraPosition));
  vec3 pos = p0 * uScale + dir * r;
  vec4 world = modelMatrix * vec4(pos, 1.0);
  vP = world.xyz;
  vN = normalize(mat3(modelMatrix) * dir);
  vColor = aColor;
  vT = position.x;
  vSeed = aSeed;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FIBER_FRAG = /* glsl */ `
${LIGHTING_GLSL}
uniform float uTime;
uniform float uFlow;
varying vec3 vN;
varying vec3 vP;
varying vec3 vColor;
varying float vT;
varying float vFade;
varying float vSeed;
void main() {
  if (vFade < 0.02) discard;
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vP);
  vec3 col = shade(vColor, N, V, 0.7) * 0.75 + vColor * 0.3;
  float ph = fract(vT * 3.0 - uTime * 0.18 + vSeed);
  float pulse = smoothstep(0.0, 0.03, ph) * (1.0 - smoothstep(0.03, 0.16, ph));
  col += (vColor * 0.8 + 0.5) * pulse * uFlow * 1.4;
  gl_FragColor = vec4(col, vFade);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const GLOBE_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vL;
varying vec3 vP;
void main() {
  vL = position;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vP = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const GLOBE_FRAG = /* glsl */ `
${LIGHTING_GLSL}
uniform float uHighlight;
varying vec3 vN;
varying vec3 vL;
varying vec3 vP;
void main() {
  vec3 d = normalize(vL);
  // latitude/longitude measured around the fibration axis (+x)
  float lat = asin(clamp(d.x, -1.0, 1.0));
  float lon = atan(d.z, d.y);
  float gl = abs(fract(lat / 0.2617994 + 0.5) - 0.5);
  float go = abs(fract(lon / 0.5235988 + 0.5) - 0.5);
  float fw = fwidth(lat / 0.2617994) + fwidth(lon / 0.5235988) * 0.5;
  float grid = 1.0 - smoothstep(0.0, fw * 1.5 + 0.02, min(gl, go));
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vP);
  vec3 base = vec3(0.05, 0.06, 0.12) + vec3(0.25, 0.3, 0.55) * grid;
  float pole = smoothstep(0.985, 0.995, d.x);
  base += vec3(1.0, 0.9, 0.6) * pole;
  vec3 col = shade(base, N, V, 0.9) + base * 0.4;
  col += vec3(0.6, 0.8, 1.0) * pow(1.0 - max(dot(N, V), 0.0), 2.5) * (0.5 + uHighlight);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function tubeGeometry() {
  const pos = [];
  const index = [];
  for (let i = 0; i <= SEGMENTS; i++) for (let j = 0; j < RADIAL; j++) pos.push(i / SEGMENTS, (j / RADIAL) * Math.PI * 2, 0);
  for (let i = 0; i < SEGMENTS; i++) for (let j = 0; j < RADIAL; j++) {
    const a = i * RADIAL + j, b = i * RADIAL + ((j + 1) % RADIAL), c = (i + 1) * RADIAL + j, d = (i + 1) * RADIAL + ((j + 1) % RADIAL);
    index.push(a, c, b, b, c, d);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 50);
  return g;
}

/** A unit quaternion q (as [a,b,c,d] = a + bi + cj + dk) with q·i·q̄ = p. */
export function hopfLift(p) {
  const [x, y, z] = p;
  const d = x; // dot(i, p)
  if (d < -0.9999) return [0, 0, 1, 0]; // q = j rotates i to −i
  // rotation taking i to p: q = normalize(1 + i·p, i × p), with i × p = (0, −z, y)
  const q = [1 + d, 0, -z, y];
  const l = Math.hypot(...q);
  return q.map((v) => v / l);
}

/** 4×4 matrix of left multiplication by the unit quaternion (THREE.Quaternion) u. */
function leftMulMatrix(out, u) {
  const u0 = u.w, u1 = u.x, u2 = u.y, u3 = u.z;
  out.set([
    u0, -u1, -u2, -u3,
    u1, u0, -u3, u2,
    u2, u3, u0, -u1,
    u3, -u2, u1, u0,
  ]);
  return out;
}

function baseColor(p) {
  const c = new THREE.Color();
  const hue = (Math.atan2(p[2], p[1]) / (Math.PI * 2) + 1) % 1;
  c.setHSL(hue, 0.85, 0.5 + 0.22 * p[0]);
  return c;
}

const _hp = new THREE.Vector3();
const _hq = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _M = R4.mat4();
const _L = R4.mat4();
const AUTO_SPIN = [0, 0, 0.07, 0, 0.045, 0];
const EW = [0, 0, 0, 1];

export class HopfScene extends SceneBase {
  constructor(app) {
    super(app);
    this.key = 'hopf';
    this.title = 'Hopf Garden';
    this.short = 'Hopf';
    this.subtitle = 'Hopf fibration of the 3-sphere';
    this.mood = 'void';

    this.center = new THREE.Vector3(0, 1.45, -1.45);
    this.globeCenter = new THREE.Vector3(-0.28, 1.15, -0.42);
    this.globeR = 0.085;
    this.scale = 0.3;
    this.flow = true;
    this.spin4 = !REDUCED_MOTION;
    this.fibers = [];
    this.viewR = R4.mat4();
    this.viewSpin = R4.biv();
    this.globeQ = new THREE.Quaternion();
    this.globeSpin = new THREE.Vector3();

    this._buildFibers();
    this._buildGlobe();

    this.labels = [];
    const l1 = makeLabel('S²: touch to add fibers', { size: 0.016, color: '#e8eaf0', bg: 'rgba(27,31,38,0.92)' });
    this.globeLabel = l1;
    this.root.add(l1);

    this.interactables = [this._globeHandle()];
    this.preset('tori');
    this._layout();

    this.desktopView = { position: new THREE.Vector3(0.35, 1.55, 0.75), target: new THREE.Vector3(-0.1, 1.3, -1.0) };
  }

  _buildFibers() {
    const g = tubeGeometry();
    this.aQ = new THREE.InstancedBufferAttribute(new Float32Array(MAX_FIBERS * 4), 4);
    this.aC = new THREE.InstancedBufferAttribute(new Float32Array(MAX_FIBERS * 3), 3);
    this.aS = new THREE.InstancedBufferAttribute(new Float32Array(MAX_FIBERS), 1);
    g.setAttribute('aQ', this.aQ);
    g.setAttribute('aColor', this.aC);
    g.setAttribute('aSeed', this.aS);
    g.instanceCount = 0;
    this.fiberGeo = g;
    this.fiberMat = new THREE.ShaderMaterial({
      uniforms: {
        ...LIGHT,
        uRot: { value: new THREE.Matrix4() },
        uScale: { value: this.scale },
        uRadius: { value: 0.0032 },
        uMaxR: { value: 5 },
        uGlobe: { value: this.globeCenter }, // the same Vector3, so it follows _layout()
        uGlobeR: { value: this.globeR },
        uTime: { value: 0 },
        uFlow: { value: 1 },
      },
      vertexShader: FIBER_VERT,
      fragmentShader: FIBER_FRAG,
      transparent: true,
    });
    this.fiberMesh = new THREE.Mesh(g, this.fiberMat);
    this.fiberMesh.frustumCulled = false;
    this.fiberRoot = new THREE.Group();
    this.fiberRoot.add(this.fiberMesh);
    this.root.add(this.fiberRoot);
  }

  _buildGlobe() {
    this.globe = new THREE.Group();
    this.globeMat = new THREE.ShaderMaterial({ uniforms: { ...LIGHT, uHighlight: { value: 0 } }, vertexShader: GLOBE_VERT, fragmentShader: GLOBE_FRAG });
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), this.globeMat);
    this.globeInner = new THREE.Group();
    this.globeInner.add(sphere);
    this.dots = new THREE.InstancedMesh(new THREE.SphereGeometry(0.035, 8, 6), new THREE.MeshBasicMaterial({ toneMapped: false }), MAX_FIBERS);
    this.dots.count = 0;
    this.dots.frustumCulled = false;
    this.globeInner.add(this.dots);
    this.globe.add(this.globeInner);
    // stand
    const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.02, 1, 12), new THREE.MeshStandardMaterial({ color: '#3a3f66', roughness: 0.4, metalness: 0.5 }));
    this.stand = stand;
    this.root.add(this.globe, stand);
  }

  _layout() {
    this.globe.position.copy(this.globeCenter);
    this.globeInner.scale.setScalar(this.globeR);
    const h = this.globeCenter.y - this.globeR - 0.01;
    this.stand.scale.y = h;
    this.stand.position.set(this.globeCenter.x, h / 2, this.globeCenter.z);
    this.fiberRoot.position.copy(this.center);
    this.globeLabel.position.copy(this.globeCenter).add(new THREE.Vector3(0, this.globeR + 0.03, 0));
    if (this.desktopView) this.desktopView.target.set(-0.1, this.center.y - 0.15, -0.8);
  }

  onUserReady() {
    const y = this.app.headPosition.y;
    this.center.y = y - 0.05;
    this.globeCenter.y = THREE.MathUtils.clamp(y - 0.42, 0.85, 1.4);
    this._layout();
  }

  // --- fibres -----------------------------------------------------------------

  addFiber(p, { dedupe = 0.035 } = {}) {
    if (this.fibers.length >= MAX_FIBERS) return false;
    const l = Math.hypot(...p);
    const pn = p.map((x) => x / l);
    for (const f of this.fibers) {
      if (f.p[0] * pn[0] + f.p[1] * pn[1] + f.p[2] * pn[2] > 1 - dedupe * dedupe * 0.5) return false;
    }
    const i = this.fibers.length;
    const q = hopfLift(pn);
    const c = baseColor(pn);
    this.fibers.push({ p: pn, q, c });
    this.aQ.setXYZW(i, q[0], q[1], q[2], q[3]);
    this.aC.setXYZ(i, c.r, c.g, c.b);
    this.aS.setX(i, Math.random());
    this.aQ.needsUpdate = this.aC.needsUpdate = this.aS.needsUpdate = true;
    this.fiberGeo.instanceCount = this.fibers.length;
    const m = new THREE.Matrix4().setPosition(pn[0], pn[1], pn[2]);
    this.dots.setMatrixAt(i, m);
    this.dots.setColorAt(i, c);
    this.dots.count = this.fibers.length;
    this.dots.instanceMatrix.needsUpdate = true;
    if (this.dots.instanceColor) this.dots.instanceColor.needsUpdate = true;
    return true;
  }

  clearFibers() {
    this.fibers = [];
    this.fiberGeo.instanceCount = 0;
    this.dots.count = 0;
  }

  preset(name) {
    this.clearFibers();
    this.presetName = name;
    const circle = (lat, n, phase = 0) => {
      for (let k = 0; k < n; k++) {
        const a = phase + (k / n) * Math.PI * 2;
        const c = Math.cos(lat);
        this.addFiber([Math.sin(lat), c * Math.cos(a), c * Math.sin(a)], { dedupe: 0 });
      }
    };
    if (name === 'tori') {
      circle(0.95, 14); circle(0.45, 22, 0.1); circle(-0.1, 26, 0.2); circle(-0.6, 24, 0.3);
    } else if (name === 'clifford') {
      circle(0, 40);
    } else if (name === 'link') {
      this.addFiber([0.2, 0.9, 0.3], { dedupe: 0 });
      this.addFiber([-0.4, -0.3, 0.8], { dedupe: 0 });
    } else if (name === 'spiral') {
      const n = 160;
      for (let k = 0; k < n; k++) {
        const t = k / (n - 1);
        const lat = Math.asin(1 - 2 * t) * 0.97;
        const lon = t * Math.PI * 2 * 5;
        this.addFiber([Math.sin(lat), Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon)], { dedupe: 0 });
      }
    } else if (name === 'random') {
      for (let k = 0; k < 90; k++) {
        const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
        this.addFiber([u, r * Math.cos(a), r * Math.sin(a)], { dedupe: 0.05 });
      }
    }
  }

  // --- globe interaction ---------------------------------------------------------

  _globeHandle() {
    const s = this;
    return {
      nearDistance(p) { return p.distanceTo(s.globeCenter) - s.globeR; },
      rayDistance(o, d) { return raySphere(o, d, s.globeCenter, s.globeR); },
      onHover(ix, on) { s.globeHover = on; },
      onGrabStart(ix, mode, kind) {
        if (ix.isMouse && mode === 'primary') { s.paintRay = ix; return; }
        ix.pose(kind, _hp, _hq);
        s.globeGrab = { ix, kind, startQ: s.globeQ.clone(), startHandInv: _hq.clone().invert(), prev: s.globeQ.clone(), mouseStart: ix.isMouse ? _hp.clone() : null };
        s.globeSpin.set(0, 0, 0);
      },
      onGrabUpdate(ix, dt) {
        if (s.paintRay === ix) return;
        const g = s.globeGrab;
        if (!g) return;
        ix.pose(g.kind, _hp, _hq);
        if (g.mouseStart) {
          // desktop: drag to roll the globe
          const d = _hp.clone().sub(g.mouseStart);
          const axis = new THREE.Vector3(-d.y, d.x, 0);
          const ang = axis.length() * 6;
          const dq = ang > 1e-5 ? new THREE.Quaternion().setFromAxisAngle(axis.normalize(), ang) : new THREE.Quaternion();
          s.globeQ.copy(dq.multiply(g.startQ));
        } else {
          const dq = _hq.clone().multiply(g.startHandInv);
          s.globeQ.copy(dq.multiply(g.startQ));
        }
        // spin estimate for release
        const delta = s.globeQ.clone().multiply(g.prev.clone().invert());
        if (delta.w < 0) { delta.x *= -1; delta.y *= -1; delta.z *= -1; delta.w *= -1; }
        const ang = 2 * Math.acos(Math.min(1, delta.w));
        const sn = Math.sqrt(Math.max(1e-9, 1 - delta.w * delta.w));
        _v.set(delta.x / sn, delta.y / sn, delta.z / sn).multiplyScalar(ang / Math.max(dt, 1e-3));
        s.globeSpin.lerp(_v, 0.4);
        g.prev.copy(s.globeQ);
      },
      onGrabEnd(ix) {
        if (s.paintRay === ix) { s.paintRay = null; return; }
        s.globeGrab = null;
        if (s.globeSpin.length() > 8) s.globeSpin.setLength(8);
      },
    };
  }

  _paintAt(worldPoint) {
    _v.copy(worldPoint).sub(this.globeCenter).normalize();
    _v.applyQuaternion(this.globeQ.clone().invert());
    if (this.addFiber([_v.x, _v.y, _v.z])) {
      if (this.fibers.length % 3 === 0) this.app.audio._tone({ freq: 500 + 500 * (_v.x + 1), dur: 0.08, gain: 0.05, type: 'sine' });
      return true;
    }
    return false;
  }

  // --- air gestures: pinch empty space and drag to rotate S³ in 4D ------------------

  onEmptyGrabStart(ix, mode) {
    ix.pose('near', _hp, _hq);
    this.air = { start: _hp.clone(), startR: R4.copy(R4.mat4(), this.viewR), prevR: R4.copy(R4.mat4(), this.viewR) };
    this.viewSpin.fill(0);
    return true;
  }

  onEmptyGrabUpdate(ix, mode, dt) {
    if (!this.air) return;
    ix.pose('near', _hp, _hq);
    const d = _hp.clone().sub(this.air.start);
    const len = d.length();
    if (len < 1e-4) return;
    const M = R4.rotationInPlane(R4.mat4(), EW, [d.x / len, d.y / len, d.z / len, 0], len / (ix.isMouse ? 0.3 : 0.18));
    R4.multiply(this.viewR, M, this.air.startR);
    this.app.hands.readout(ix, 'turning S³ through w');
    // spin estimate
    const T = R4.transpose(R4.mat4(), this.air.prevR);
    R4.multiply(T, this.viewR, T);
    for (let k = 0; k < 6; k++) {
      const [i, j] = R4.PLANES[k];
      this.viewSpin[k] = this.viewSpin[k] * 0.6 + (T[i * 4 + j] - T[j * 4 + i]) * 0.5 / Math.max(dt, 1e-3) * 0.4;
    }
    R4.copy(this.air.prevR, this.viewR);
  }

  onEmptyGrabEnd() { this.air = null; }

  onKey(e) {
    const k = e.key.toLowerCase();
    if (k === 'c') this.clearFibers();
    if (k === 'f') this.flow = !this.flow;
    if (k === ' ') this.spin4 = !this.spin4;
  }

  update(dt, time) {
    // add fibers where a fingertip or controller tip touches the globe
    if (this.app.presenting) {
      for (const ix of this.app.input.xr) {
        if (!ix.active || !ix.hasPoke || ix.grabbed || ix.uiEngaged) continue;
        const d = ix.pokePos.distanceTo(this.globeCenter);
        if (d < this.globeR + 0.012 && d > this.globeR * 0.4) {
          if (this._paintAt(ix.pokePos)) ix.pulse(0.2, 10);
        }
      }
    }
    if (this.paintRay) {
      const ix = this.paintRay;
      const t = raySphere(ix.rayOrigin, ix.rayDir, this.globeCenter, this.globeR);
      if (t < Infinity) this._paintAt(ix.rayOrigin.clone().addScaledVector(ix.rayDir, t));
    }

    // globe inertia
    if (!this.globeGrab && this.globeSpin.lengthSq() > 1e-6) {
      const ang = this.globeSpin.length() * dt;
      const dq = _dq.setFromAxisAngle(_axis.copy(this.globeSpin).normalize(), ang);
      this.globeQ.premultiply(dq).normalize();
      this.globeSpin.multiplyScalar(Math.exp(-dt * 0.6));
    }
    this.globeInner.quaternion.copy(this.globeQ);
    this.globeMat.uniforms.uHighlight.value = this.globeHover || this.globeGrab ? 0.8 : 0;

    // 4D view: inertia after release, plus auto-rotation
    if (!this.air) {
      const damp = Math.exp(-dt * 0.8);
      for (let k = 0; k < 6; k++) this.viewSpin[k] *= damp;
      const M = R4.expBivector(_M, this.viewSpin, dt);
      R4.multiply(this.viewR, M, this.viewR);
      if (this.spin4) {
        const A = R4.expBivector(_M, AUTO_SPIN, dt);
        R4.multiply(this.viewR, A, this.viewR);
      }
      R4.orthonormalize(this.viewR);
    }

    const L = leftMulMatrix(_L, this.globeQ);
    const total = R4.multiply(_M, this.viewR, L);
    R4.toThreeMatrix(this.fiberMat.uniforms.uRot.value, total, 1);
    this.fiberMat.uniforms.uTime.value = time;
    this.fiberMat.uniforms.uFlow.value = this.flow ? 1 : 0;
    this.fiberMat.uniforms.uScale.value = this.scale;

    const head = this.app.headPosition;
    this.globeLabel.lookAt(head.x, this.globeLabel.position.y, head.z);
  }

  menuRows() {
    return [
      {
        type: 'buttons', columns: 3,
        items: [
          { label: 'Nested tori', onClick: () => this.preset('tori'), active: () => this.presetName === 'tori' },
          { label: 'Clifford torus', onClick: () => this.preset('clifford'), active: () => this.presetName === 'clifford' },
          { label: 'Hopf link', onClick: () => this.preset('link'), active: () => this.presetName === 'link' },
          { label: 'Spiral', onClick: () => this.preset('spiral'), active: () => this.presetName === 'spiral' },
          { label: 'Random', onClick: () => this.preset('random'), active: () => this.presetName === 'random' },
          { label: 'Clear', onClick: () => { this.clearFibers(); this.presetName = null; } },
        ],
      },
      { type: 'slider', label: 'Projection size', min: 0.2, max: 0.8, get: () => this.scale, set: (v) => { this.scale = v; }, format: (v) => `${(v * 100).toFixed(0)} cm` },
      {
        type: 'toggles', columns: 2,
        items: [
          { label: 'Light pulses', get: () => this.flow, set: (v) => { this.flow = v; } },
          { label: 'Auto-rotate', get: () => this.spin4, set: (v) => { this.spin4 = v; } },
        ],
      },
      {
        type: 'buttons', columns: 2,
        items: [
          { label: 'Reset 4D view', small: true, onClick: () => { R4.identity(this.viewR); this.viewSpin.fill(0); } },
          { label: 'Spin globe', small: true, onClick: () => { this.globeSpin.set(0.3, 1.4, 0.2); } },
        ],
      },
    ];
  }

  hint(mode) {
    const n = `${this.fibers.length} fibers.`;
    if (mode === 'desktop') return `${n} Each point on the globe corresponds to one circle (fiber) of the 3-sphere.`;
    if (mode === 'controllers') return `${n} Touch the globe with a controller to add the fiber for that point. Trigger on the globe and turn the controller to rotate all fibers. Trigger in empty space and drag to rotate S³ in 4D.`;
    return `${n} Touch the globe to add the fiber for that point. Pinch the globe and rotate your hand to rotate all fibers. Pinch empty space and drag to rotate S³ in 4D.`;
  }

  desktopHelp({ touch } = {}) {
    if (touch) return '<b>Drag on the globe</b> to add fibers · <b>Drag</b> empty space to orbit · <b>Menu</b>: presets and settings';
    return '<b>Drag on the globe</b> to add fibers · <b>Right-drag the globe</b> to rotate it · <b>Right-drag empty space</b> to rotate S³ in 4D · drag empty space to orbit · <b>C</b> clear · <b>F</b> pulses · <b>Space</b> auto-rotate · <b>M</b> menu';
  }
}
