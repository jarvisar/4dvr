// Tracked hand rendering (joints and bones as two instanced meshes), pinch
// indicators, pointer rays and cursors.

import * as THREE from 'three';
import { J } from './input.js';

const CHAINS = [
  ['wrist', 'thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
  ['wrist', 'index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip'],
  ['wrist', 'middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip'],
  ['wrist', 'ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip'],
  ['wrist', 'pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip'],
  ['index-finger-phalanx-proximal', 'middle-finger-phalanx-proximal', 'ring-finger-phalanx-proximal', 'pinky-finger-phalanx-proximal'],
];
const BONES = [];
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

function handMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uBase: { value: new THREE.Color('#dfe6ff') }, uOpacity: { value: 0.85 } },
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
const TINT_POKE = new THREE.Color('#8b7bff');

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

    // pointing rays + cursors
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
  }

  update() {
    const app = this.app;
    let ji = 0, bi = 0;
    const tintJ = this.joints.geometry.attributes.instanceTint;
    const tintB = this.bones.geometry.attributes.instanceTint;
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
        if ((j === J['thumb-tip'] || j === J['index-finger-tip']) && ix.pinchStrength > 0.4) tint = ix.pinch.pressed ? TINT_PINCH : TINT_NONE;
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
      // pinch ring
      if (ix.pinchStrength > 0.25 && !ix.uiEngaged) {
        const thumb = ix.joints[J['thumb-tip']].pos;
        const other = ix.joints[ix.grip.pressed ? J['middle-finger-tip'] : J['index-finger-tip']].pos;
        ring.visible = true;
        ring.position.addVectors(thumb, other).multiplyScalar(0.5);
        ring.lookAt(app.headPosition);
        const s = 0.006 + 0.012 * (1 - ix.pinchStrength);
        ring.scale.setScalar(ix.pinch.pressed || ix.grip.pressed ? 0.007 : s);
        ring.material.color.copy(ix.grip.pressed ? TINT_GRIP : ix.pinch.pressed ? TINT_PINCH : new THREE.Color('#ffffff'));
        ring.material.opacity = 0.35 + 0.6 * ix.pinchStrength;
      }
    });
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
}
