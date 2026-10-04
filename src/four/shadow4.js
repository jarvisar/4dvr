// 4D shadows on the table.
//
// The sun shines along a 4D direction. An object's shadow on the floor
// hyperplane y = 0 (a 3-space) is its projection along that direction. The
// viewer sees the part of it in their slice (w = 0), which is a flat region on
// the table. If the sun has no w component, points keep their w when they're
// projected, so this is just the shadow of the cross-section. If it does,
// objects outside the slice can cast shadows into it, and objects in the slice
// can cast shadows that fall outside it.
//
// The shadows are drawn top-down into a mask texture, only when something
// moved, and the table's material multiplies its color by the mask (see
// receive()). Polytopes use the slice shader compiled with SHADOW4 (see
// sliceMaterial.js). A hypersphere's shadow is done per pixel instead. It's
// the floor points whose line toward the sun passes within r of the center.

import * as THREE from 'three';
import { SLICE_VERTEX_GLSL } from './sliceMaterial.js';

const MASK_FRAG = /* glsl */ `void main() { gl_FragColor = vec4(1.0); }`;

// A floor point p can only be in shadow if it's within r / sun.y of c', the
// point where the line from the center toward the sun meets the floor. That
// line is at least |p - c'| sun.y away from p. So the quad only covers that
// square of the mask, and the fragment shader decides the exact shape.
const SPHERE_VERT = /* glsl */ `
uniform vec4 uPos;
uniform float uRadius;
uniform vec4 uSun;
uniform float uExtent;
varying vec2 vXZ;
void main() {
  vec4 c = uPos - (uPos.y / uSun.y) * uSun;
  vXZ = c.xz + position.xy * (uRadius / uSun.y);
  gl_Position = vec4(vXZ / uExtent, 0.0, 1.0);
}
`;

const SPHERE_FRAG = /* glsl */ `
uniform vec4 uPos;     // center in slice space
uniform float uRadius;
uniform vec4 uSun;
varying vec2 vXZ;
void main() {
  vec4 d = vec4(vXZ.x, 0.0, vXZ.y, 0.0) - uPos;
  float a = dot(d, uSun);
  // Distance from the center to the line toward the sun. The fragment shader
  // runs once per texel, not per sample, so the edge is antialiased here. The
  // coverage ramps over one texel instead of switching on and off.
  float dist = sqrt(max(dot(d, d) - a * a, 0.0));
  float cover = clamp((uRadius - dist) / max(fwidth(dist), 1e-6) + 0.5, 0.0, 1.0);
  if (cover <= 0.0) discard;
  gl_FragColor = vec4(cover);
}
`;

// Shadows can overlap in the mask. Max blending keeps the darker one where an
// antialiased edge lands on another shadow.
const MASK_BLEND = { blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor };

// Spliced into the receiving material (see receive()).
const RECEIVER_VERT_HEAD = /* glsl */ `
uniform float uShadowExtent;
varying vec2 vShadowUv;
`;
const RECEIVER_VERT = /* glsl */ `
vShadowUv = transformed.xz / (2.0 * uShadowExtent) + 0.5;
`;
const RECEIVER_FRAG_HEAD = /* glsl */ `
uniform sampler2D uShadowMask;
uniform float uShadowTexel;
uniform float uShadowStrength;
varying vec2 vShadowUv;
float shadow4Factor() {
  // The blur below reads texels up to 2.4 away. A mip level 3 texel covers 8x8
  // of them, so if level 3 is 0 here, every texel the blur reads is 0 (or has
  // a sliver of antialiased edge too faint to see). Most of the table has no
  // shadow nearby, so this skips the other 9 reads.
  if (uShadowStrength == 0.0 || textureLod(uShadowMask, vShadowUv, 3.0).r == 0.0) return 1.0;
  // small blur for soft edges
  float m = 0.0;
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++) {
    m += textureLod(uShadowMask, vShadowUv + vec2(float(i), float(j)) * uShadowTexel * 1.4, 0.0).r;
  }
  return 1.0 - uShadowStrength * m / 9.0;
}
`;
// Applied after tone mapping and sRGB encoding, so the shadow darkens the
// displayed color by the same factor whatever the lighting.
const RECEIVER_FRAG = /* glsl */ `
gl_FragColor.rgb *= shadow4Factor();
`;

const _clear = new THREE.Color();

export class Shadow4 {
  // extent is the half-size (m) of the square of floor the mask covers, centered on the origin
  constructor({ extent = 0.64, size = 512, strength = 0.42 } = {}) {
    // Multisampled because a texel is 2.5 mm, and with one sample per texel a
    // shadow edge that moves by a fraction of that (a stack settling, a slow
    // drag) flips whole texels on and off, which flickers. With 4 samples the
    // edge texels get partial coverage and change gradually. It's cheap on the
    // Quest's tiled GPU since the resolve happens in tile memory, and the mask
    // is only redrawn when something moved.
    // Mipmapped for the receiver's quick "no shadow nearby" test.
    this.rt = new THREE.WebGLRenderTarget(size, size, { samples: 4, depthBuffer: false, magFilter: THREE.LinearFilter, minFilter: THREE.LinearMipmapNearestFilter, generateMipmaps: true });
    this.scene = new THREE.Scene();
    this.camera = new THREE.Camera(); // the mask shaders ignore the camera
    this.uniforms = { uSun: { value: new THREE.Vector4(0, 1, 0, 0) }, uExtent: { value: extent } };
    this.proxies = new Map();
    this.sphereQuad = new THREE.PlaneGeometry(2, 2);
    this.strength = strength;
    this.receiverUniforms = {
      uShadowMask: { value: this.rt.texture },
      uShadowExtent: this.uniforms.uExtent,
      uShadowTexel: { value: 1 / size },
      uShadowStrength: { value: strength },
    };
    this.dirty = true;
  }

  // Makes a built-in material (like MeshLambertMaterial) darken by the mask.
  // The mesh's local x and z have to match the shadow's, with the mask's
  // center at the local origin. The shadow is part of the surface's own
  // shading instead of a second surface on top, so nothing can z-fight with
  // it, and it only darkens this surface (not the bases of objects standing
  // on it).
  receive(material) {
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.receiverUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${RECEIVER_VERT_HEAD}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${RECEIVER_VERT}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${RECEIVER_FRAG_HEAD}`)
        .replace('#include <dithering_fragment>', `#include <dithering_fragment>\n${RECEIVER_FRAG}`);
    };
    material.customProgramCacheKey = () => 'shadow4-receiver';
    return material;
  }

  // Graphics preset shadow setting. Off skips the mask reads and redraws.
  set enabled(on) {
    this.receiverUniforms.uShadowStrength.value = on ? this.strength : 0;
  }

  // Direction toward the sun, in slice space. y has to be > 0.
  setSun(x, y, z, w) {
    const u = this.uniforms.uSun.value;
    if (u.x === x && u.y === y && u.z === z && u.w === w) return;
    u.set(x, y, z, w);
    this.dirty = true;
  }

  // Start casting a shadow for an Object4D. Its pose uniforms are shared.
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
        ...MASK_BLEND,
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
        ...MASK_BLEND,
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
    mesh.removeFromParent(); // material not disposed, to keep its shader program (see Object4D.dispose)
    this.proxies.delete(obj);
    this.dirty = true;
  }

  // Whether the object's shadow can reach the slice. Projecting a point q to
  // the floor gives it w = q.w - q.y k, with k = sun.w / sun.y. Points within r
  // of the center c end up within r √(1 + k²) of c.w - c.y k. Skipping the
  // rest saves drawing every tetrahedron of objects far along w.
  _reachesSlice(obj) {
    const s = this.uniforms.uSun.value, c = obj.slicePos;
    const k = s.w / s.y;
    return Math.abs(c[3] - c[1] * k) <= obj.radius * Math.sqrt(1 + k * k) * 1.001;
  }

  // Call before the frame is rendered. Only redraws when something changed.
  render(renderer) {
    if (!this.dirty) return;
    this.dirty = false;
    for (const [obj, mesh] of this.proxies) mesh.visible = this._reachesSlice(obj);
    // Turn XR off while rendering to the texture during an XR frame, so three.js uses our camera and target
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
  }
}
