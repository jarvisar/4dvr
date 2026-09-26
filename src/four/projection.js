// 4D to 3D projection rendering.
//
// Edges are instanced tubes, vertices are instanced spheres and faces are
// translucent triangles. All of them store 4D coordinates, and the vertex
// shader rotates and projects them:
//   perspective: eye on the w axis at distance E, p = xyz * E / (E - w)
//   stereographic: from the pole of the 3-sphere, p = xyz / (1 - w)
// In stereographic mode edges are subdivided and normalized onto S³, so they
// project to arcs. Color shows w (blue for kata, pink for ana), and edges are
// highlighted where they cross the slicing hyperplane.

import * as THREE from 'three';
import { LIGHT, LIGHTING_GLSL } from '../core/lighting.js';
import { ANA_COLOR, KATA_COLOR } from './sliceView.js';

export const PROJ_UNIFORMS_GLSL = /* glsl */ `
uniform mat4 uRot;
uniform int uMode;       // 0 perspective, 1 stereographic
uniform float uEye;      // perspective eye distance along w
uniform float uScale;    // metres per unit
uniform float uMaxR;     // fade out beyond this projected radius (units)

vec4 prep(vec4 p) {
  if (uMode == 1) p = normalize(p);
  return uRot * p;
}
vec3 project(vec4 q, out float s) {
  if (uMode == 0) {
    s = uEye / max(uEye - q.w, 0.05);
  } else {
    s = 1.0 / max(1.0 - q.w, 0.004);
  }
  return q.xyz * s;
}
`;

const EDGE_VERT = /* glsl */ `
${PROJ_UNIFORMS_GLSL}
attribute vec4 aA;
attribute vec4 aB;
attribute vec3 aColor;
uniform float uRadius;
varying vec3 vN;
varying vec3 vP;
varying float vW;
varying float vFade;
varying vec3 vColor;

void main() {
  float t = position.x;        // along the edge
  float ang = position.y;      // around the tube
  float s0, s1;
  vec4 q0 = prep(mix(aA, aB, t));
  vec4 q1 = prep(mix(aA, aB, t + 0.01));
  vec3 p0 = project(q0, s0);
  vec3 p1 = project(q1, s1);
  vec3 T = normalize(p1 - p0 + 1e-6);
  vec3 helper = abs(T.y) < 0.92 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 N = normalize(cross(T, helper));
  vec3 B = cross(T, N);
  vec3 dir = cos(ang) * N + sin(ang) * B;
  vFade = 1.0 - smoothstep(uMaxR * 0.7, uMaxR, length(p0));
  // shrink the radius instead of fading alpha, so edges stay opaque (no sorting needed)
  float r = uRadius * clamp(s0, 0.35, 2.6) * vFade;
  vec3 pos = p0 * uScale + dir * r;
  vec4 world = modelMatrix * vec4(pos, 1.0);
  vP = world.xyz;
  vN = normalize(mat3(modelMatrix) * dir);
  vW = q0.w;
  vColor = aColor;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const VERT_VERT = /* glsl */ `
${PROJ_UNIFORMS_GLSL}
attribute vec4 aP;
uniform float uRadius;
varying vec3 vN;
varying vec3 vP;
varying float vW;
varying float vFade;
varying vec3 vColor;
void main() {
  float s;
  vec4 q = prep(aP);
  vec3 c = project(q, s);
  vFade = 1.0 - smoothstep(uMaxR * 0.7, uMaxR, length(c));
  float r = uRadius * clamp(s, 0.35, 2.6) * vFade;
  vec4 world = modelMatrix * vec4(c * uScale + position * r, 1.0);
  vP = world.xyz;
  vN = normalize(mat3(modelMatrix) * position);
  vW = q.w;
  vColor = vec3(1.0);
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const WIRE_FRAG = /* glsl */ `
${LIGHTING_GLSL}
uniform vec3 uAna;
uniform vec3 uKata;
uniform float uSliceW;
uniform float uShowSlice;
uniform float uTint;
uniform float uOpacity;
varying vec3 vN;
varying vec3 vP;
varying float vW;
varying float vFade;
varying vec3 vColor;
void main() {
  if (vFade <= 0.01) discard;
  vec3 N = normalize(vN);
  vec3 V = normalize(cameraPosition - vP);
  float k = clamp(vW * 0.5 + 0.5, 0.0, 1.0);
  vec3 depth = k > 0.5 ? mix(vec3(0.95), uAna, (k - 0.5) * 2.0) : mix(uKata, vec3(0.95), k * 2.0);
  vec3 base = mix(depth, vColor, uTint);
  vec3 col = shade(base, N, V, 0.6) * 0.8 + base * 0.35;
  float band = (1.0 - smoothstep(0.015, 0.05, abs(vW - uSliceW))) * uShowSlice;
  col = mix(col, vec3(1.0, 0.98, 0.85) * 2.2, band);
  gl_FragColor = vec4(col, uOpacity * vFade);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const FACE_VERT = /* glsl */ `
${PROJ_UNIFORMS_GLSL}
attribute vec4 a4;
attribute vec3 aColor;
varying float vW;
varying vec3 vColor;
varying vec3 vP;
varying float vFade;
void main() {
  float s;
  vec4 q = prep(a4);
  vec3 c = project(q, s);
  vec4 world = modelMatrix * vec4(c * uScale, 1.0);
  vP = world.xyz;
  vW = q.w;
  vColor = aColor;
  vFade = 1.0 - smoothstep(uMaxR * 0.6, uMaxR, length(c));
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FACE_FRAG = /* glsl */ `
uniform vec3 uAna;
uniform vec3 uKata;
uniform float uOpacity;
uniform float uTint;
varying float vW;
varying vec3 vColor;
varying vec3 vP;
varying float vFade;
void main() {
  float k = clamp(vW * 0.5 + 0.5, 0.0, 1.0);
  vec3 depth = mix(uKata, uAna, k);
  vec3 c = mix(depth, vColor, uTint);
  float a = uOpacity * vFade;
  gl_FragColor = vec4(c * a, 0.0); // additive (premultiplied, alpha 0)
  #include <colorspace_fragment>
}
`;

function edgeTubeGeometry(segments, radial) {
  const pos = [];
  const index = [];
  for (let i = 0; i <= segments; i++) {
    for (let j = 0; j < radial; j++) pos.push(i / segments, (j / radial) * Math.PI * 2, 0);
  }
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < radial; j++) {
      const a = i * radial + j, b = i * radial + ((j + 1) % radial), c = (i + 1) * radial + j, d = (i + 1) * radial + ((j + 1) % radial);
      index.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(index);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);
  return g;
}

/**
 * A projected wireframe for any set of 4D edges/vertices/faces.
 * geometry: { vertices: [[x,y,z,w]], edges: [[a,b]], faces: [{verts:[...]}] }
 */
export class ProjectedWire {
  constructor({ maxEdges = 1300, maxVerts = 700, maxFaceTris = 60000, segments = 12 } = {}) {
    this.group = new THREE.Group();
    this.shared = {
      uRot: { value: new THREE.Matrix4() },
      uMode: { value: 0 },
      uEye: { value: 2.4 },
      uScale: { value: 0.18 },
      uMaxR: { value: 7 },
      uAna: { value: ANA_COLOR.clone() },
      uKata: { value: KATA_COLOR.clone() },
      uSliceW: { value: 0 },
      uShowSlice: { value: 1 },
    };

    // edges
    this.edgeGeo = edgeTubeGeometry(segments, 7);
    this.aA = new THREE.InstancedBufferAttribute(new Float32Array(maxEdges * 4), 4);
    this.aB = new THREE.InstancedBufferAttribute(new Float32Array(maxEdges * 4), 4);
    this.aEC = new THREE.InstancedBufferAttribute(new Float32Array(maxEdges * 3).fill(1), 3);
    for (const a of [this.aA, this.aB, this.aEC]) a.setUsage(THREE.DynamicDrawUsage);
    this.edgeGeo.setAttribute('aA', this.aA);
    this.edgeGeo.setAttribute('aB', this.aB);
    this.edgeGeo.setAttribute('aColor', this.aEC);
    this.edgeMat = new THREE.ShaderMaterial({
      uniforms: { ...LIGHT, ...this.shared, uRadius: { value: 0.0032 }, uTint: { value: 0 }, uOpacity: { value: 1 } },
      vertexShader: EDGE_VERT,
      fragmentShader: WIRE_FRAG,
    });
    this.edges = new THREE.Mesh(this.edgeGeo, this.edgeMat);
    this.edges.frustumCulled = false;
    this.group.add(this.edges);

    // vertices
    const sph = new THREE.SphereGeometry(1, 10, 8);
    this.vertGeo = new THREE.InstancedBufferGeometry();
    this.vertGeo.index = sph.index;
    this.vertGeo.setAttribute('position', sph.attributes.position);
    this.aP = new THREE.InstancedBufferAttribute(new Float32Array(maxVerts * 4), 4);
    this.aP.setUsage(THREE.DynamicDrawUsage);
    this.vertGeo.setAttribute('aP', this.aP);
    this.vertMat = new THREE.ShaderMaterial({
      uniforms: { ...LIGHT, ...this.shared, uRadius: { value: 0.0065 }, uTint: { value: 0 }, uOpacity: { value: 1 } },
      vertexShader: VERT_VERT,
      fragmentShader: WIRE_FRAG,
    });
    this.verts = new THREE.Mesh(this.vertGeo, this.vertMat);
    this.verts.frustumCulled = false;
    this.group.add(this.verts);

    // faces
    this.maxFaceTris = maxFaceTris;
    this.faceGeo = new THREE.BufferGeometry();
    this.a4 = new THREE.BufferAttribute(new Float32Array(maxFaceTris * 3 * 4), 4);
    this.aFC = new THREE.BufferAttribute(new Float32Array(maxFaceTris * 3 * 3), 3);
    this.a4.setUsage(THREE.DynamicDrawUsage);
    this.aFC.setUsage(THREE.DynamicDrawUsage);
    this.faceGeo.setAttribute('a4', this.a4);
    this.faceGeo.setAttribute('aColor', this.aFC);
    this.faceGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxFaceTris * 3), 1));
    this.faceGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);
    this.faceMat = new THREE.ShaderMaterial({
      uniforms: { ...this.shared, uOpacity: { value: 0.1 }, uTint: { value: 0 } },
      vertexShader: FACE_VERT,
      fragmentShader: FACE_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    this.faces = new THREE.Mesh(this.faceGeo, this.faceMat);
    this.faces.frustumCulled = false;
    this.faces.renderOrder = 8;
    this.group.add(this.faces);
  }

  /** Upload a polytope-like description. faceSubdiv > 0 curves faces (for stereographic). */
  setGeometry(geo, { faceSubdiv = 2, edgeColors = null, faceColors = null } = {}) {
    const { vertices, edges, faces } = geo;
    const nE = Math.min(edges.length, this.aA.count);
    for (let i = 0; i < nE; i++) {
      const a = vertices[edges[i][0]], b = vertices[edges[i][1]];
      this.aA.setXYZW(i, a[0], a[1], a[2], a[3]);
      this.aB.setXYZW(i, b[0], b[1], b[2], b[3]);
      const c = edgeColors ? edgeColors[i] : [1, 1, 1];
      this.aEC.setXYZ(i, c[0], c[1], c[2]);
    }
    this.edgeGeo.instanceCount = nE;
    this.aA.needsUpdate = this.aB.needsUpdate = this.aEC.needsUpdate = true;

    const nV = Math.min(vertices.length, this.aP.count);
    for (let i = 0; i < nV; i++) this.aP.setXYZW(i, ...vertices[i]);
    this.vertGeo.instanceCount = nV;
    this.aP.needsUpdate = true;

    let t = 0;
    const put = (p, c) => {
      this.a4.setXYZW(t, p[0], p[1], p[2], p[3]);
      this.aFC.setXYZ(t, c[0], c[1], c[2]);
      t++;
    };
    const lerp4 = (a, b, s) => [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s, a[3] + (b[3] - a[3]) * s];
    const n = 1 << faceSubdiv;
    (faces || []).forEach((f, fi) => {
      const c = faceColors ? faceColors[fi] : [1, 1, 1];
      const pts = f.verts.map((i) => vertices[i]);
      const center = pts.reduce((acc, p) => acc.map((x, k) => x + p[k] / pts.length), [0, 0, 0, 0]);
      for (let k = 0; k < pts.length; k++) {
        const A = center, B = pts[k], C = pts[(k + 1) % pts.length];
        // subdivide triangle ABC into n² small triangles
        const P = (i, j) => lerp4(lerp4(A, B, i / n), lerp4(A, C, i / n), i === 0 ? 0 : j / i);
        for (let i = 0; i < n; i++) {
          for (let j = 0; j <= i; j++) {
            if ((t + 6) / 3 > this.maxFaceTris) return;
            put(P(i, j), c); put(P(i + 1, j), c); put(P(i + 1, j + 1), c);
            if (j < i) { put(P(i, j), c); put(P(i + 1, j + 1), c); put(P(i, j + 1), c); }
          }
        }
      }
    });
    this.faceGeo.setDrawRange(0, t);
    this.a4.needsUpdate = this.aFC.needsUpdate = true;
  }

  set mode(m) { this.shared.uMode.value = m === 'stereo' ? 1 : 0; }
  set scale(s) { this.shared.uScale.value = s; }
  set eye(e) { this.shared.uEye.value = e; }
  set faceOpacity(o) { this.faceMat.uniforms.uOpacity.value = o; this.faces.visible = o > 0.001; }
  set tint(t) { this.edgeMat.uniforms.uTint.value = t; this.faceMat.uniforms.uTint.value = t; }
  set wireOpacity(o) {
    for (const m of [this.edgeMat, this.vertMat]) {
      m.uniforms.uOpacity.value = o;
      m.transparent = o < 0.999;
      m.depthWrite = o >= 0.999;
    }
  }
}
