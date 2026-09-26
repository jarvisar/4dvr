// Hyperplane slicing on the GPU.
//
// Each tetrahedron is drawn as 4 indexed vertices (two triangles). The vertex
// shader reads the tetrahedron's corners from a float texture, transforms them
// into slice space (where the viewer's slice is the hyperplane w = 0) and
// checks which side of it each corner is on. A 16-entry table gives the
// cross-section (triangle, quad or nothing), and each output vertex is placed
// where a tetrahedron edge crosses w = 0. Triangles are wound to match the 4D
// normal so back-face culling works.
//
// An object's pose is two uniforms (a mat4 and a vec4), so moving it costs no
// geometry updates.

import * as THREE from 'three';
import { TEX_WIDTH, TEXELS_PER_TET } from './tetmesh.js';
import { LIGHT, LIGHTING_GLSL } from '../core/lighting.js';

const EDGES = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
const edgeIndex = (i, j) => EDGES.findIndex(([a, b]) => (a === Math.min(i, j) && b === Math.max(i, j)));

function buildCaseTable() {
  const table = [];
  for (let m = 0; m < 16; m++) {
    const pos = [0, 1, 2, 3].filter((i) => m & (1 << i));
    const neg = [0, 1, 2, 3].filter((i) => !(m & (1 << i)));
    let poly;
    if (pos.length === 1 || pos.length === 3) {
      const single = pos.length === 1 ? pos[0] : neg[0];
      const others = pos.length === 1 ? neg : pos;
      poly = others.map((o) => edgeIndex(single, o));
      poly.push(poly[2]); // pad: the 2nd triangle degenerates
    } else if (pos.length === 2) {
      const [a, b] = pos, [c, d] = neg;
      poly = [edgeIndex(a, c), edgeIndex(a, d), edgeIndex(b, d), edgeIndex(b, c)];
    } else {
      poly = [0, 0, 0, 0];
    }
    table.push(...poly);
  }
  return table;
}

const CASES = buildCaseTable();

export const SLICE_VERTEX_GLSL = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;

uniform sampler2D uTets;
uniform mat4 uRot;        // object -> slice space, linear part (includes scale)
uniform vec4 uPos;        // object origin in slice space; w = offset from the slice
uniform float uLineScale; // object-units -> metres, for edge line width

varying vec3 vNormalW;
varying vec3 vPosW;
varying vec3 vColor;
varying float vRidge;
varying vec4 vObj;

const int CASES[64] = int[64](${CASES.join(',')});
const int EA[6] = int[6](0, 0, 0, 1, 1, 2);
const int EB[6] = int[6](1, 2, 3, 2, 3, 3);

vec4 fetchTexel(int i) {
  return texelFetch(uTets, ivec2(i % ${TEX_WIDTH}, i / ${TEX_WIDTH}), 0);
}

vec3 corner(int c, int mask, vec4 q0, vec4 q1, vec4 q2, vec4 q3) {
  int e = CASES[mask * 4 + c];
  vec4 qa = EA[e] == 0 ? q0 : (EA[e] == 1 ? q1 : q2);
  vec4 qb = EB[e] == 1 ? q1 : (EB[e] == 2 ? q2 : q3);
  float t = qa.w / (qa.w - qb.w);
  return mix(qa.xyz, qb.xyz, t);
}

void main() {
  int tet = gl_VertexID / 4;
  int cornerId = gl_VertexID - tet * 4;
  int base = tet * ${TEXELS_PER_TET};

  // Quick reject: every corner is within 'reach' of corner 0, so its w differs
  // from q0.w by at most |w row of uRot| * reach. If that can't reach w = 0 the
  // whole tetrahedron is on one side (the mask test below would cull it too).
  vec4 p0 = fetchTexel(base);
  vec4 q0 = uRot * p0 + uPos;
  float reach = fetchTexel(base + 9).x;
  float wRow = length(vec4(uRot[0][3], uRot[1][3], uRot[2][3], uRot[3][3]));
  if (abs(q0.w) > wRow * reach * 1.001 + 1e-5) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  vec4 p1 = fetchTexel(base + 1);
  vec4 p2 = fetchTexel(base + 2);
  vec4 p3 = fetchTexel(base + 3);
  vec4 q1 = uRot * p1 + uPos;
  vec4 q2 = uRot * p2 + uPos;
  vec4 q3 = uRot * p3 + uPos;

  int mask = (q0.w > 0.0 ? 1 : 0) | (q1.w > 0.0 ? 2 : 0) | (q2.w > 0.0 ? 4 : 0) | (q3.w > 0.0 ? 8 : 0);
  if (mask == 0 || mask == 15) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  vec4 n0 = fetchTexel(base + 4);
  vec4 n1 = fetchTexel(base + 5);
  vec4 n2 = fetchTexel(base + 6);
  vec4 n3 = fetchTexel(base + 7);
  vec4 extra = fetchTexel(base + 8);

  // Wind the polygon so its front face follows the (projected) outward normal.
  vec3 c0 = corner(0, mask, q0, q1, q2, q3);
  vec3 c1 = corner(1, mask, q0, q1, q2, q3);
  vec3 c2 = corner(2, mask, q0, q1, q2, q3);
  vec3 gn = cross(c1 - c0, c2 - c0);
  vec3 avgN = (uRot * (n0 + n1 + n2 + n3)).xyz;
  bool flip = dot(gn, avgN) < 0.0;
  // Index buffer draws (0,1,2)+(0,2,3); swapping corners 1<->3 reverses both triangles.
  int pc = flip ? ((4 - cornerId) & 3) : cornerId;

  int e = CASES[mask * 4 + pc];
  int a = EA[e];
  int b = EB[e];
  vec4 qa = a == 0 ? q0 : (a == 1 ? q1 : q2);
  vec4 qb = b == 1 ? q1 : (b == 2 ? q2 : q3);
  vec4 pa = a == 0 ? p0 : (a == 1 ? p1 : p2);
  vec4 pb = b == 1 ? p1 : (b == 2 ? p2 : p3);
  vec4 na = a == 0 ? n0 : (a == 1 ? n1 : n2);
  vec4 nb = b == 1 ? n1 : (b == 2 ? n2 : n3);
  float t = qa.w / (qa.w - qb.w);

  vec3 pos = mix(qa.xyz, qb.xyz, t);
  vec3 n = (uRot * mix(na, nb, t)).xyz;
  if (dot(n, n) < 1e-10) n = flip ? -gn : gn;

  vObj = mix(pa, pb, t);
  vColor = extra.rgb;
  vRidge = extra.w > 0.0 ? (a == 0 ? (1.0 - t) : 0.0) * extra.w * uLineScale : 1000.0;

  vec4 world = modelMatrix * vec4(pos, 1.0);
  vPosW = world.xyz;
  vNormalW = normalize(mat3(modelMatrix) * n);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

export const PATTERN_GLSL = /* glsl */ `
uniform int uPattern;
// 0: none, 1: two-angle checker (duocylinder, tori), 2: spherinder, 3: cubinder
float patternValue(vec4 p) {
  if (uPattern == 1) {
    float a = atan(p.y, p.x), b = atan(p.w, p.z);
    return sin(a * 4.0) * sin(b * 4.0);
  } else if (uPattern == 2) {
    float a = atan(p.z, p.x);
    return sin(a * 3.0) * sin(p.w * 14.0 + 0.001);
  } else if (uPattern == 3) {
    float a = atan(p.y, p.x);
    return sin(a * 4.0) * sin((p.z + p.w) * 9.0);
  }
  return 0.0;
}
float patternMask(vec4 p) {
  if (uPattern == 0) return 0.0;
  float s = patternValue(p);
  float fw = max(fwidth(s), 1e-4);
  return smoothstep(-fw, fw, s);
}
`;

const SOLID_FRAGMENT = /* glsl */ `
precision highp float;
${LIGHTING_GLSL}
${PATTERN_GLSL}
uniform vec3 uTint;
uniform float uTintAmount;
uniform float uHighlight;
uniform vec3 uHighlightColor;
uniform float uLineWidth;
uniform float uGloss;
uniform float uOpacity;

varying vec3 vNormalW;
varying vec3 vPosW;
varying vec3 vColor;
varying float vRidge;
varying vec4 vObj;

void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vPosW);
  float facing = dot(N, V);
  if (facing < 0.0) N = normalize(N - facing * V); // silhouette fix-up

  vec3 albedo = mix(vColor, uTint, uTintAmount);
  albedo *= mix(1.0, 0.72, patternMask(vObj));

  float fw = fwidth(vRidge);
  float line = 1.0 - smoothstep(uLineWidth - fw, uLineWidth + fw, vRidge);
  albedo = mix(albedo, albedo * 0.22, line * 0.9);

  vec3 col = shade(albedo, N, V, uGloss);
  float rim = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 2.0);
  col += uHighlightColor * uHighlight * (0.18 + 0.9 * rim);
  // translucent objects are more opaque at grazing angles and on edges
  float alpha = uOpacity < 1.0 ? mix(uOpacity, 1.0, rim * 0.7 + line * 0.6) : 1.0;
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const GHOST_FRAGMENT = /* glsl */ `
precision highp float;
uniform vec3 uGhostColor;
uniform float uGhostAlpha;
uniform float uGhostAdd; // 0 = normal 'over' blending (light scenes), 1 = additive glow (dark scenes)
uniform float uLineWidth;

varying vec3 vNormalW;
varying vec3 vPosW;
varying vec3 vColor;
varying float vRidge;
varying vec4 vObj;

void main() {
  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vPosW);
  float fres = pow(1.0 - abs(dot(N, V)), 2.5);
  float fw = fwidth(vRidge);
  float line = 1.0 - smoothstep(uLineWidth - fw, uLineWidth + fw, vRidge);
  float a = clamp(uGhostAlpha * (0.08 + 0.7 * fres + 0.8 * line), 0.0, 1.0);
  gl_FragColor = vec4(uGhostColor * a, a * (1.0 - uGhostAdd)); // premultiplied
  #include <colorspace_fragment>
}
`;

/** Shared ghost style: scenes set uGhostAdd to 0 (light) or ~0.7 (dark). */
export const GHOST_STYLE = { uGhostAdd: { value: 0 } };
export const PREMULTIPLIED_BLEND = {
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
};

const DEPTH_FRAGMENT = /* glsl */ `
void main() { gl_FragColor = vec4(1.0); }
`;

/**
 * Per-object uniform bundle. The solid, ghost and shadow-depth materials
 * share the uniforms that describe the object's pose.
 */
export function createSliceMaterials(tetMesh, { pattern = 0, gloss = 0.5 } = {}) {
  const shared = {
    uTets: { value: tetMesh.texture },
    uRot: { value: new THREE.Matrix4() },
    uPos: { value: new THREE.Vector4() },
    uLineScale: { value: 1 },
    uLineWidth: { value: 0.0032 },
    uPattern: { value: pattern },
  };

  const solid = new THREE.ShaderMaterial({
    name: 'slice-solid',
    uniforms: {
      ...LIGHT,
      ...shared,
      uTint: { value: new THREE.Color(1, 1, 1) },
      uTintAmount: { value: 0 },
      uHighlight: { value: 0 },
      uHighlightColor: { value: new THREE.Color('#9ff3ff') },
      uGloss: { value: gloss },
      uOpacity: { value: 1 },
    },
    vertexShader: SLICE_VERTEX_GLSL,
    fragmentShader: SOLID_FRAGMENT,
    side: THREE.FrontSide,
  });
  solid.shadowSide = THREE.DoubleSide;

  const ghostUniforms = {
    ...shared,
    uPos: { value: new THREE.Vector4() }, // ghost slices through the object's own centre
    uGhostColor: { value: new THREE.Color('#ff4f9a') },
    uGhostAlpha: { value: 0 },
    uGhostAdd: GHOST_STYLE.uGhostAdd,
  };
  const ghost = new THREE.ShaderMaterial({
    name: 'slice-ghost',
    uniforms: ghostUniforms,
    vertexShader: SLICE_VERTEX_GLSL,
    fragmentShader: GHOST_FRAGMENT,
    transparent: true,
    depthWrite: false,
    ...PREMULTIPLIED_BLEND,
    side: THREE.DoubleSide,
  });

  const depth = new THREE.ShaderMaterial({
    name: 'slice-depth',
    uniforms: shared,
    vertexShader: SLICE_VERTEX_GLSL,
    fragmentShader: DEPTH_FRAGMENT,
  });

  return { solid, ghost, depth, shared };
}
