// 4D shadows on the table.
//
// A 4D sun shines along a 4D direction. An object's shadow on the floor
// hyperplane y = 0 (a 3-space) is its projection along that direction, and the
// viewer sees the part of it that lies in their slice, w = 0: a flat region
// on the table. If the sun has no w component, points keep their w while they
// are projected, so this is just the shadow of the cross-section. If it does,
// objects outside the slice can cast shadows into it, and objects in the slice
// cast shadows that fall outside it.
//
// The shadow regions are drawn top-down into a mask texture (only when
// something moved) and the table multiplies its colour by the mask.
// Polytopes use the slice shader compiled with SHADOW4 (see sliceMaterial.js);
// a hypersphere's shadow is found per pixel: the floor points whose line
// towards the sun passes within r of the centre.

import * as THREE from 'three';
import { SLICE_VERTEX_GLSL } from './sliceMaterial.js';

const MASK_FRAG = /* glsl */ `void main() { gl_FragColor = vec4(1.0); }`;

const SPHERE_VERT = /* glsl */ `
uniform float uExtent;
varying vec2 vXZ;
void main() {
  vXZ = position.xy * uExtent;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const SPHERE_FRAG = /* glsl */ `
uniform vec4 uPos;     // centre in slice space
uniform float uRadius;
uniform vec4 uSun;
varying vec2 vXZ;
void main() {
  vec4 d = vec4(vXZ.x, 0.0, vXZ.y, 0.0) - uPos;
  float a = dot(d, uSun);
  if (dot(d, d) - a * a > uRadius * uRadius) discard;
  gl_FragColor = vec4(1.0);
}
`;

const OVERLAY_VERT = /* glsl */ `
uniform float uExtent;
varying vec2 vUv;
void main() {
  vUv = position.xz / (2.0 * uExtent) + 0.5;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const OVERLAY_FRAG = /* glsl */ `
uniform sampler2D uMask;
uniform float uTexel;
uniform float uStrength;
varying vec2 vUv;
void main() {
  // small blur for soft edges
  float m = 0.0;
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
    m += texture2D(uMask, vUv + vec2(float(i), float(j)) * uTexel * 1.4).r;
  }
  m /= 9.0;
  gl_FragColor = vec4(vec3(1.0 - uStrength * m), 1.0); // multiplied into the table colour
}
`;

const _clear = new THREE.Color();

export class Shadow4 {
  /** extent: half-size (m) of the square area of floor the mask covers, centred on the origin. */
  constructor({ extent = 0.64, size = 512, strength = 0.42 } = {}) {
    this.rt = new THREE.WebGLRenderTarget(size, size, { depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter });
    this.scene = new THREE.Scene();
    this.camera = new THREE.Camera(); // the mask shaders ignore the camera
    this.uniforms = { uSun: { value: new THREE.Vector4(0, 1, 0, 0) }, uExtent: { value: extent } };
    this.proxies = new Map();
    this.sphereQuad = new THREE.PlaneGeometry(2, 2);

    this.overlay = new THREE.Mesh(
      new THREE.CircleGeometry(extent, 96).rotateX(-Math.PI / 2),
      new THREE.ShaderMaterial({
        uniforms: { uMask: { value: this.rt.texture }, uExtent: this.uniforms.uExtent, uTexel: { value: 1 / size }, uStrength: { value: strength } },
        vertexShader: OVERLAY_VERT,
        fragmentShader: OVERLAY_FRAG,
        transparent: true,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.ZeroFactor,
        blendDst: THREE.SrcColorFactor,
      }),
    );
    this.overlay.renderOrder = 1;
    this.dirty = true;
  }

  /** Direction towards the sun, in slice space (x, y, z, w); y must be > 0. */
  setSun(x, y, z, w) {
    const u = this.uniforms.uSun.value;
    if (u.x === x && u.y === y && u.z === z && u.w === w) return;
    u.set(x, y, z, w);
    this.dirty = true;
  }

  /** Start casting a shadow for an Object4D (its pose uniforms are shared). */
  add(obj) {
    const sh = obj.mats.shared;
    let mesh;
    if (obj.shape.isSphere) {
      mesh = new THREE.Mesh(this.sphereQuad, new THREE.ShaderMaterial({
        uniforms: { uPos: sh.uPos, uRadius: sh.uRadius, ...this.uniforms },
        vertexShader: SPHERE_VERT,
        fragmentShader: SPHERE_FRAG,
        depthTest: false,
        depthWrite: false,
      }));
    } else {
      mesh = new THREE.Mesh(obj.shape.tetMesh.geometry, new THREE.ShaderMaterial({
        uniforms: { ...sh, ...this.uniforms },
        defines: { SHADOW4: '' },
        vertexShader: SLICE_VERTEX_GLSL,
        fragmentShader: MASK_FRAG,
        side: THREE.DoubleSide,
        depthTest: false,
        depthWrite: false,
      }));
    }
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    this.proxies.set(obj, mesh);
    this.dirty = true;
  }

  remove(obj) {
    const mesh = this.proxies.get(obj);
    if (!mesh) return;
    mesh.removeFromParent();
    mesh.material.dispose();
    this.proxies.delete(obj);
    this.dirty = true;
  }

  /** Redraw the mask if anything changed. Call before the frame is rendered. */
  render(renderer) {
    if (!this.dirty) return;
    this.dirty = false;
    // render-to-texture during an XR frame: turn XR off so three.js uses our camera and target
    const xr = renderer.xr.enabled;
    const prev = renderer.getRenderTarget();
    renderer.getClearColor(_clear);
    const alpha = renderer.getClearAlpha();
    renderer.xr.enabled = false;
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, false, false);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prev);
    renderer.setClearColor(_clear, alpha);
    renderer.xr.enabled = xr;
  }

  dispose() {
    for (const obj of [...this.proxies.keys()]) this.remove(obj);
    this.rt.dispose();
    this.overlay.geometry.dispose();
    this.overlay.material.dispose();
  }
}
