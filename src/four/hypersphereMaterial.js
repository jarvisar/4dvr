// Hypersphere rendering. A hyperplane at distance d from the center of a
// hypersphere of radius r cuts it in a sphere of radius sqrt(r² − d²), so a
// regular sphere mesh is used instead of tetrahedra. The fragment shader maps
// each point back onto the hypersphere (object space) and colors it by the
// largest coordinate, which makes rotation in 4D visible.

import * as THREE from 'three';
import { LIGHT, LIGHTING_GLSL } from '../core/lighting.js';
import { AXIS_COLORS } from './tetmesh.js';
import { GHOST_STYLE, PREMULTIPLIED_BLEND } from './sliceMaterial.js';

let sharedGeometry = null;
export function hypersphereGeometry() {
  if (!sharedGeometry) sharedGeometry = new THREE.SphereGeometry(1, 48, 32);
  return sharedGeometry;
}

const VERT = /* glsl */ `
uniform vec4 uPos;          // centre in slice space
uniform float uSliceRadius; // radius of the 3D cross-section
varying vec3 vLocal;
varying vec3 vPosW;
varying vec3 vNormalW;
void main() {
  vLocal = position;
  vec4 world = modelMatrix * vec4(uPos.xyz + position * uSliceRadius, 1.0);
  vPosW = world.xyz;
  vNormalW = normalize(mat3(modelMatrix) * position);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const DEPTH_FRAG = /* glsl */ `void main() { gl_FragColor = vec4(1.0); }`;

const FRAG = /* glsl */ `
precision highp float;
${LIGHTING_GLSL}
uniform mat4 uRotInv;       // slice space -> object space (unit sphere)
uniform vec4 uPos;
uniform float uSliceRadius;
uniform float uRadius;
uniform vec3 uColors[8];
uniform float uHighlight;
uniform vec3 uHighlightColor;
uniform vec3 uTint;
uniform float uTintAmount;
uniform float uGhost;
uniform vec3 uGhostColor;
uniform float uGhostAlpha;
uniform float uGhostAdd;
varying vec3 vLocal;
varying vec3 vPosW;
varying vec3 vNormalW;

void main() {
  vec3 dir = normalize(vLocal);
  vec4 s = vec4(dir * uSliceRadius, -uPos.w);
  vec4 p = (uRotInv * s) / uRadius;           // point on the unit 3-sphere
  vec4 ap = abs(p);
  // Color by the axis with the largest |component| (8 regions, one per tesseract cell).
  int axis = 0; float m1 = ap.x;
  if (ap.y > m1) { axis = 1; m1 = ap.y; }
  if (ap.z > m1) { axis = 2; m1 = ap.z; }
  if (ap.w > m1) { axis = 3; m1 = ap.w; }
  float m2 = 0.0;
  if (axis != 0) m2 = max(m2, ap.x);
  if (axis != 1) m2 = max(m2, ap.y);
  if (axis != 2) m2 = max(m2, ap.z);
  if (axis != 3) m2 = max(m2, ap.w);
  float comp = axis == 0 ? p.x : (axis == 1 ? p.y : (axis == 2 ? p.z : p.w));
  int idx = axis * 2 + (comp >= 0.0 ? 0 : 1);
  vec3 albedo = uColors[0];
  for (int i = 1; i < 8; i++) if (i == idx) albedo = uColors[i];
  albedo = mix(albedo, uTint, uTintAmount);

  float edge = m1 - m2;
  float fw = max(fwidth(edge), 1e-4);
  float line = 1.0 - smoothstep(0.02 - fw, 0.02 + fw, edge);

  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vPosW);

  if (uGhost > 0.5) {
    float fres = pow(1.0 - abs(dot(N, V)), 2.5);
    float a = clamp(uGhostAlpha * (0.08 + 0.75 * fres + 0.6 * line), 0.0, 1.0);
    gl_FragColor = vec4(uGhostColor * a, a * (1.0 - uGhostAdd));
    #include <colorspace_fragment>
    return;
  }

  albedo = mix(albedo, albedo * 0.25, line * 0.85);
  vec3 col = shade(albedo, N, V, 0.7);
  float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.0);
  col += uHighlightColor * uHighlight * (0.18 + 0.9 * rim);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export function createHypersphereMaterials(colors = AXIS_COLORS) {
  const shared = {
    uPos: { value: new THREE.Vector4() },
    uSliceRadius: { value: 0 },
    uRotInv: { value: new THREE.Matrix4() },
    uRadius: { value: 1 },
    uColors: { value: colors.map((c) => new THREE.Color(c[0], c[1], c[2])) },
  };
  const solid = new THREE.ShaderMaterial({
    name: 'hypersphere',
    uniforms: {
      ...LIGHT,
      ...shared,
      uHighlight: { value: 0 },
      uHighlightColor: { value: new THREE.Color('#9ff3ff') },
      uTint: { value: new THREE.Color(1, 1, 1) },
      uTintAmount: { value: 0 },
      uGhost: { value: 0 },
      uGhostColor: { value: new THREE.Color() },
      uGhostAlpha: { value: 0 },
      uGhostAdd: GHOST_STYLE.uGhostAdd,
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
  });
  const ghost = new THREE.ShaderMaterial({
    name: 'hypersphere-ghost',
    uniforms: {
      ...LIGHT,
      ...shared,
      uPos: { value: new THREE.Vector4() },
      uSliceRadius: { value: 0 },
      uHighlight: { value: 0 },
      uHighlightColor: { value: new THREE.Color() },
      uTint: { value: new THREE.Color(1, 1, 1) },
      uTintAmount: { value: 0 },
      uGhost: { value: 1 },
      uGhostColor: { value: new THREE.Color('#ff4f9a') },
      uGhostAlpha: { value: 0 },
      uGhostAdd: GHOST_STYLE.uGhostAdd,
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    ...PREMULTIPLIED_BLEND,
  });
  const depth = new THREE.ShaderMaterial({
    name: 'hypersphere-depth',
    uniforms: shared,
    vertexShader: VERT,
    fragmentShader: DEPTH_FRAG,
  });
  return { solid, ghost, depth, shared };
}
