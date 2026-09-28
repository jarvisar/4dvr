// Tracked hand rendering (joints and bones as two instanced meshes), pinch
// indicators, pointer rays and cursors, the fingertip cursor on panels, and
// short readouts next to the hand while a gesture changes something.

import * as THREE from 'three';
import { J } from './input.js';
import { FONTS } from './ui.js';
import { JOINT_RADII } from './handPoses.js';

const CHAINS = [
  ['wrist', 'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
  ['wrist', 'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip'],
  ['wrist', 'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip'],
  ['wrist', 'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip'],
  ['wrist', 'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip'],
  ['index-finger-phalanx-proximal', 'middle-finger-phalanx-proximal', 'ring-finger-phalanx-proximal', 'pinky-finger-phalanx-proximal'],
];
// Joint index pairs for the hand's bones (also used to draw hands in other spaces)
export const BONES = [];
for (const chain of CHAINS) for (let i = 0; i + 1 < chain.length; i++) BONES.push([J[chain[i]], J[chain[i + 1]]]);

const HAND_VERT = /* glsl */ `
attribute vec3 instanceTint;
varying vec3 vN;
varying vec3 vP;
varying vec3 vTint;
void main() {
  vTint = instanceTint;
  vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vP = w.xyz;
  vN = normalize(mat3(modelMatrix * instanceMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const HAND_FRAG = /* glsl */ `
uniform vec3 uBase;
uniform float uOpacity;
varying vec3 vN;
varying vec3 vP;
varying vec3 vTint;
void main() {
  vec3 V = normalize(cameraPosition - vP);
  float f = pow(1.0 - abs(dot(normalize(vN), V)), 2.0);
  vec3 c = mix(uBase * 0.55, vec3(1.0), f * 0.6) + vTint;
  gl_FragColor = vec4(c, uOpacity * (0.55 + 0.45 * f));
  #include <colorspace_fragment>
}
`;

function handMaterial(color = '#dfe6ff', opacity = 0.85) {
  return new THREE.ShaderMaterial({
    uniforms: { uBase: { value: new THREE.Color(color) }, uOpacity: { value: opacity } },
    vertexShader: HAND_VERT,
    fragmentShader: HAND_FRAG,
    transparent: true,
    depthWrite: true,
  });
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const TINT_NONE = new THREE.Color(0, 0, 0);
const TINT_PINCH = new THREE.Color('#33c3ff');
const TINT_GRIP = new THREE.Color('#ff4f9a');
const TINT_POKE = new THREE.Color('#eceef4');
const RING_IDLE = new THREE.Color('#ffffff');
const POKE_PRESS = new THREE.Color('#1a9fff');
const READOUT_HOLD = 0.12; // seconds a readout stays up after its last update
const TIPS = [J['thumb-tip'], J['index-finger-tip'], J['middle-finger-tip'], J['ring-finger-tip'], J['pinky-finger-tip']];

const _joints = Array.from({ length: 25 }, () => new THREE.Vector3());
const _w = new THREE.Vector3();

// A see-through hand that shows a gesture, for the tutorial. Drawn like the
// tracked hands but in light blue, from the poses in handPoses.js.
export class GhostHand {
  constructor(parent) {
    this.joints = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8), handMaterial('#5ab8ff', 0), 25);
    this.bones = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 8, 1, true).translate(0, 0.5, 0), handMaterial('#5ab8ff', 0), BONES.length);
    for (const im of [this.joints, this.bones]) {
      im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      // brighter than the shader's shading alone, so it stands out on the light table
      const tint = new Float32Array(im.count * 3);
      for (let i = 0; i < tint.length; i += 3) { tint[i] = 0.1; tint[i + 1] = 0.3; tint[i + 2] = 0.5; }
      im.geometry.setAttribute('instanceTint', new THREE.InstancedBufferAttribute(tint, 3));
      im.renderOrder = 29;
      im.visible = false;
      parent.add(im);
    }
  }

  // Joints from blendPose(), relative to the wrist, placed at a wrist pose in world space
  set(local, wristPos, wristQuat, opacity) {
    const on = opacity > 0.01;
    this.joints.visible = this.bones.visible = on;
    if (!on) return;
    for (let j = 0; j < 25; j++) _joints[j].copy(local[j]).applyQuaternion(wristQuat).add(wristPos);
    for (let j = 0; j < 25; j++) {
      const r = JOINT_RADII[j] * 0.7;
      this.joints.setMatrixAt(j, _m.compose(_joints[j], _q.identity(), _s.set(r, r, r)));
    }
    BONES.forEach(([a, b], i) => {
      _w.subVectors(_joints[b], _joints[a]);
      const len = _w.length();
      const r = Math.max(0.003, Math.min(JOINT_RADII[a], JOINT_RADII[b]) * 0.38);
      _q.setFromUnitVectors(_up, _w.divideScalar(len || 1));
      this.bones.setMatrixAt(i, _m.compose(_joints[a], _q, _s.set(r, len, r)));
    });
    this.joints.instanceMatrix.needsUpdate = true;
    this.bones.instanceMatrix.needsUpdate = true;
    this.joints.material.uniforms.uOpacity.value = opacity * 0.9;
    this.bones.material.uniforms.uOpacity.value = opacity * 0.9;
  }

  hide() { this.joints.visible = this.bones.visible = false; }
}

// One-line label on a dark plate that hugs the text. Redrawn in place on a
// fixed size canvas, so updates allocate nothing.
class Readout {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 640; this.canvas.height = 88;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    const h = 0.02;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(h * (640 / 88), h),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    this.mesh.renderOrder = 35;
    this.mesh.visible = false;
    this.text = null;
    this.ix = null;
    this.t = -1;
  }

  set(text, color) {
    if (text === this.text && color === this.color) return;
    this.text = text; this.color = color;
    const ctx = this.ctx, W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.font = `600 44px ${FONTS.mono}`;
    const tw = Math.min(W - 4, ctx.measureText(text).width + 40);
    ctx.fillStyle = 'rgba(27, 31, 38, 0.92)';
    ctx.beginPath();
    ctx.roundRect((W - tw) / 2, 4, tw, H - 8, 18);
    ctx.fill();
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, W / 2, H / 2 + 2);
    this.texture.needsUpdate = true;
  }
}

export class HandVisuals {
  constructor(app) {
    this.app = app;
    this.group = new THREE.Group();
    this.group.name = 'hand-visuals';
    app.scene.add(this.group);

    const nJ = 25 * 2, nB = BONES.length * 2;
    this.joints = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8), handMaterial(), nJ);
    this.bones = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 8, 1, true).translate(0, 0.5, 0), handMaterial(), nB);
    for (const im of [this.joints, this.bones]) {
      im.frustumCulled = false;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.geometry.setAttribute('instanceTint', new THREE.InstancedBufferAttribute(new Float32Array(im.count * 3), 3));
      im.renderOrder = 30;
      this.group.add(im);
    }

    // pinch ring between thumb and finger
    this.rings = [0, 1].map(() => {
      const m = new THREE.Mesh(
        new THREE.TorusGeometry(1, 0.12, 8, 32),
        new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.8, depthWrite: false, toneMapped: false }),
      );
      m.renderOrder = 31;
      this.group.add(m);
      return m;
    });

    // pointing rays and cursors
    // unit-length cylinder from the origin along −Z (scaled to the hit distance)
    const rayGeo = new THREE.CylinderGeometry(0.0012, 0.0025, 1, 6, 1, true).translate(0, -0.5, 0).rotateX(Math.PI / 2);
    this.rays = [0, 1, 2].map(() => {
      const mat = new THREE.ShaderMaterial({
        uniforms: { uColor: { value: new THREE.Color('#bfe8ff') } },
        vertexShader: 'varying float vT; void main(){ vT = -position.z; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: 'uniform vec3 uColor; varying float vT; void main(){ float a = smoothstep(0.0, 0.08, vT) * (1.0 - smoothstep(0.6, 1.0, vT)) * 0.7; gl_FragColor = vec4(uColor, a); }',
        transparent: true,
        depthWrite: false,
      });
      const ray = new THREE.Mesh(rayGeo, mat);
      ray.renderOrder = 32;
      const cursor = new THREE.Mesh(new THREE.RingGeometry(0.004, 0.0075, 24), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.9, depthTest: false, toneMapped: false }));
      cursor.renderOrder = 33;
      this.group.add(ray, cursor);
      return { ray, cursor };
    });

    // fingertip cursor on a panel. The ring under the finger closes as it
    // approaches the surface, so it's clear where a press will land.
    this.pokeCursors = [0, 1].map(() => {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(0.0035, 0.0055, 32),
        new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, depthWrite: false, toneMapped: false }),
      );
      m.renderOrder = 34; // after the panels (20), but still hidden behind the finger itself
      m.visible = false;
      this.group.add(m);
      return m;
    });

    // one readout per interactor (two hands or controllers, and the mouse)
    this.readouts = [0, 1, 2].map(() => {
      const r = new Readout();
      this.group.add(r.mesh);
      return r;
    });
    // tutorial labels above each controller, e.g. which button grabs
    this.tags = [0, 1].map(() => {
      const r = new Readout();
      this.group.add(r.mesh);
      return r;
    });
    // tutorial: fingertips that pulse on the tracked hands, e.g. the thumb
    // and middle finger for a middle-finger pinch. { joints, color } or null.
    this.fingerHint = null;
    this._hintTint = new THREE.Color();
  }

  // Label above a controller for as long as it's called every frame
  tag(ix, text) {
    const r = this.tags[ix.index];
    if (!r) return;
    r.set(text, '#ffffff');
    r.ix = ix;
    r.t = this.app.time;
  }

  // Show a short readout next to an interactor's hand, e.g. the slice position
  // while a pinch in empty space moves it. Call it every frame the value is live.
  readout(ix, text, color = '#ffffff') {
    const r = this.readouts[ix.index];
    if (!r) return;
    r.set(text, color);
    r.ix = ix;
    r.t = this.app.time;
  }

  update() {
    const app = this.app;
    let ji = 0, bi = 0;
    const tintJ = this.joints.geometry.attributes.instanceTint;
    const tintB = this.bones.geometry.attributes.instanceTint;
    const hint = this.fingerHint;
    if (hint) this._hintTint.copy(hint.color).multiplyScalar(0.35 + 0.35 * Math.sin(app.time * 6));
    app.input.xr.forEach((ix, h) => {
      const ring = this.rings[h];
      ring.visible = false;
      if (!app.presenting || ix.kind !== 'hand' || !ix.jointsValid) return;
      for (let j = 0; j < 25; j++) {
        const jt = ix.joints[j];
        const r = Math.max(0.004, jt.radius * 0.8);
        _m.compose(jt.pos, _q.identity(), _s.set(r, r, r));
        this.joints.setMatrixAt(ji, _m);
        let tint = TINT_NONE;
        if (hint && hint.joints.includes(j) && !ix.pinch.pressed && !ix.grip.pressed) tint = this._hintTint;
        if ((j === J['thumb-tip'] || j === J['index-finger-tip']) && ix.pinchStrength > 0.4) tint = ix.pinch.pressed ? TINT_PINCH : tint;
        if (ix.palmGrab && TIPS.includes(j)) tint = TINT_PINCH;
        if ((j === J['thumb-tip'] || j === J['middle-finger-tip']) && ix.grip.pressed) tint = TINT_GRIP;
        if (j === J['index-finger-tip'] && ix.uiEngaged) tint = TINT_POKE;
        tintJ.setXYZ(ji, tint.r, tint.g, tint.b);
        ji++;
      }
      for (const [a, b] of BONES) {
        const pa = ix.joints[a].pos, pb = ix.joints[b].pos;
        _v.subVectors(pb, pa);
        const len = _v.length();
        const r = Math.max(0.0025, Math.min(ix.joints[a].radius, ix.joints[b].radius) * 0.45);
        _q.setFromUnitVectors(_up, _v.divideScalar(len || 1));
        _m.compose(pa, _q, _s.set(r, len, r));
        this.bones.setMatrixAt(bi, _m);
        tintB.setXYZ(bi, 0, 0, 0);
        bi++;
      }
      // pinch ring between the thumb and whichever finger is closing on it. It
      // shrinks as they close, so both pinches show before they trigger.
      const middle = ix.grip.pressed || (!ix.pinch.pressed && ix.gripStrength > ix.pinchStrength);
      const strength = middle ? ix.gripStrength : ix.pinchStrength;
      if (strength > 0.25 && !ix.uiEngaged && !ix.fist && !ix.palmGrab) {
        const thumb = ix.joints[J['thumb-tip']].pos;
        const other = ix.joints[middle ? J['middle-finger-tip'] : J['index-finger-tip']].pos;
        ring.visible = true;
        ring.position.addVectors(thumb, other).multiplyScalar(0.5);
        ring.lookAt(app.headPosition);
        const s = 0.006 + 0.012 * (1 - strength);
        ring.scale.setScalar(ix.pinch.pressed || ix.grip.pressed ? 0.007 : s);
        ring.material.color.copy(ix.grip.pressed ? TINT_GRIP : ix.pinch.pressed ? TINT_PINCH : RING_IDLE);
        ring.material.opacity = 0.35 + 0.6 * strength;
      }
    });

    // fingertip cursors on panels (hands and controller tips)
    app.input.xr.forEach((ix, h) => {
      const c = this.pokeCursors[h];
      const hit = ix.pokeHit;
      c.visible = app.presenting && ix.active && !!hit.panel && hit.z > -0.01;
      if (!c.visible) return;
      const p = hit.panel;
      p.fromPanel(hit.x, hit.y, 0.0015, c.position);
      p.group.getWorldQuaternion(c.quaternion);
      const t = THREE.MathUtils.clamp(hit.z / 0.045, 0, 1); // 0 at the surface, 1 at the edge of hover range
      const pressing = p.pressed.has(ix);
      c.scale.setScalar(pressing ? 0.9 : 0.9 + 1.4 * t);
      c.material.color.copy(pressing ? POKE_PRESS : RING_IDLE);
      c.material.opacity = (pressing ? 1 : 0.3 + 0.6 * (1 - t)) * p.opacity;
    });

    // readouts sit just above the hand (or the mouse's drag point) and face the head,
    // at the size they would have half a meter away. Controller tags sit a little higher.
    for (const r of this.readouts) this._placeLabel(r, 0.045);
    for (const r of this.tags) this._placeLabel(r, 0.08, !!this.readouts[r.ix?.index]?.mesh.visible);
    this.joints.count = ji;
    this.bones.count = bi;
    this.joints.instanceMatrix.needsUpdate = true;
    this.bones.instanceMatrix.needsUpdate = true;
    tintJ.needsUpdate = true;
    tintB.needsUpdate = true;
    this.joints.visible = ji > 0;
    this.bones.visible = bi > 0;

    // rays
    const list = app.presenting ? app.input.xr : [];
    this.rays.forEach((r, i) => {
      const ix = list[i];
      const show = !!ix && ix.active && ix.rayVisible;
      r.ray.visible = show;
      r.cursor.visible = show && ix.rayLength < 20;
      if (!show) return;
      r.ray.position.copy(ix.rayOrigin);
      r.ray.quaternion.copy(ix.rayQuat);
      r.ray.scale.set(1, 1, Math.max(0.05, ix.rayLength));
      r.cursor.position.copy(ix.rayOrigin).addScaledVector(ix.rayDir, ix.rayLength - 0.002);
      r.cursor.lookAt(app.headPosition);
      const s = 0.6 + ix.rayLength * 0.5;
      r.cursor.scale.setScalar(ix.pinch.pressed || ix.grip.pressed ? s * 0.7 : s);
    });
  }

  _placeLabel(r, above, hidden = false) {
    const app = this.app;
    const on = !hidden && !!r.ix && app.time - r.t < READOUT_HOLD;
    r.mesh.visible = on;
    if (!on) return;
    const s = Math.max(1, r.ix.grabPos.distanceTo(app.headPosition) / 0.5);
    r.mesh.position.copy(r.ix.grabPos).addScaledVector(_up, above * s);
    r.mesh.scale.setScalar(s);
    r.mesh.lookAt(app.headPosition);
  }
}
