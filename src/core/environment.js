// Sky dome, floor grid and lights, with a preset per scene.

import * as THREE from 'three';
import { LIGHT, setLightingPreset } from './lighting.js';

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww; // pin to the far plane
}
`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uBottom;
uniform vec3 uSunDir;
uniform vec3 uGlow;
uniform float uStars;
varying vec3 vDir;

float hash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = h > 0.0 ? mix(uHorizon, uTop, pow(h, 0.55)) : mix(uHorizon, uBottom, pow(-h, 0.4));
  float sun = max(dot(d, normalize(uSunDir)), 0.0);
  col += uGlow * (pow(sun, 8.0) * 0.35 + pow(sun, 120.0) * 0.8);
  if (uStars > 0.0) {
    // stars: at most one per grid cell, randomly offset, drawn as small discs
    vec3 g = d * 160.0;
    vec3 cell = floor(g);
    float s = hash(cell);
    // only 1.5% of cells have a star, so skip the other hashes for the rest
    if (s >= 0.985) {
      vec3 jitter = vec3(hash(cell + 1.3), hash(cell + 2.7), hash(cell + 4.1)) * 0.6 + 0.2;
      float dist = length(fract(g) - jitter);
      float star = 1.0 - smoothstep(0.02, 0.09, dist);
      star *= smoothstep(-0.1, 0.3, h + 0.2);
      col += vec3(0.8, 0.9, 1.0) * star * uStars * (0.35 + 0.65 * hash(cell + 3.1));
    }
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

const FLOOR_VERT = /* glsl */ `
varying vec3 vPosW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vPosW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const FLOOR_FRAG = /* glsl */ `
uniform vec3 uBase;
uniform vec3 uLine;
uniform vec3 uFade;
uniform float uRadius;
varying vec3 vPosW;

float gridLine(vec2 p, float spacing, float width) {
  vec2 g = abs(fract(p / spacing - 0.5) - 0.5) * spacing;
  vec2 fw = fwidth(p);
  vec2 l = 1.0 - smoothstep(vec2(width) - fw, vec2(width) + fw, g);
  return max(l.x, l.y);
}

void main() {
  vec2 p = vPosW.xz;
  float r = length(p);
  float major = gridLine(p, 1.0, 0.006);
  float minor = gridLine(p, 0.25, 0.003) * 0.45;
  float lines = max(major, minor) * (1.0 - smoothstep(uRadius * 0.25, uRadius * 0.9, r));
  vec3 col = mix(uBase, uLine, lines);
  // soft vignette towards the horizon colour
  col = mix(col, uFade, smoothstep(uRadius * 0.2, uRadius, r));
  // slightly darker near the center of the room
  col *= 0.92 + 0.08 * smoothstep(0.0, 2.5, r);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export const MOODS = {
  studio: {
    top: '#8fb4ea', horizon: '#eef1f6', bottom: '#d8d2ca', glow: '#fff3dc', stars: 0,
    floorBase: '#dcd8d2', floorLine: '#b9b3ab', light: 'studio', floor: true,
  },
  dusk: {
    top: '#07080c', horizon: '#252a36', bottom: '#08090d', glow: '#9fb8ff', stars: 0.35,
    floorBase: '#0e1016', floorLine: '#2a2f3c', light: 'night', floor: true,
  },
  void: {
    top: '#040509', horizon: '#121626', bottom: '#030407', glow: '#6f8cff', stars: 1,
    floorBase: '#08090e', floorLine: '#1a1e2c', light: 'night', floor: true,
  },
  hyperbolic: {
    top: '#070812', horizon: '#1a1030', bottom: '#050510', glow: '#ff7ad9', stars: 0.4,
    floorBase: '#000000', floorLine: '#000000', light: 'night', floor: false,
  },
  quasi: {
    top: '#0c0d18', horizon: '#1b1d2b', bottom: '#0a0b12', glow: '#ffd7a0', stars: 0.5,
    floorBase: '#000000', floorLine: '#000000', light: 'night', floor: false,
  },
  klein: {
    top: '#151a26', horizon: '#2a2f40', bottom: '#12151d', glow: '#ffe0b0', stars: 0.4,
    floorBase: '#000000', floorLine: '#000000', light: 'studio', floor: false,
  },
  spherical: {
    top: '#0c0814', horizon: '#1a1224', bottom: '#07050b', glow: '#ffb38a', stars: 0.3,
    floorBase: '#000000', floorLine: '#000000', light: 'night', floor: false,
  },
};

export class Environment {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'environment';
    scene.add(this.group);

    this.skyMat = new THREE.ShaderMaterial({
      uniforms: {
        uTop: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uBottom: { value: new THREE.Color() },
        uGlow: { value: new THREE.Color() },
        uSunDir: LIGHT.uSunDir,
        uStars: { value: 0 },
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(50, 48, 24), this.skyMat);
    // Drawn after the other opaque objects: it sits on the far plane, so the
    // depth test skips every sky pixel that something else already covers.
    this.sky.renderOrder = 100;
    this.sky.frustumCulled = false;
    this.group.add(this.sky);

    this.floorMat = new THREE.ShaderMaterial({
      uniforms: {
        uBase: { value: new THREE.Color() },
        uLine: { value: new THREE.Color() },
        uFade: { value: new THREE.Color() },
        uRadius: { value: 24 },
      },
      vertexShader: FLOOR_VERT,
      fragmentShader: FLOOR_FRAG,
    });
    this.floor = new THREE.Mesh(new THREE.CircleGeometry(24, 64).rotateX(-Math.PI / 2), this.floorMat);
    this.group.add(this.floor);

    this.hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1.0);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.0);
    this.group.add(this.hemi, this.sun, this.sun.target);
    this.aimSun(new THREE.Vector3(0, 1, -0.6));
    // The graphics preset's shadow setting. The three.js shadow map isn't used:
    // Hyperplay draws its own 4D shadows (four/shadow4.js) and reads this.
    this.shadows = true;
  }

  setMood(name) {
    const m = MOODS[name] || MOODS.studio;
    const u = this.skyMat.uniforms;
    u.uTop.value.set(m.top);
    u.uHorizon.value.set(m.horizon);
    u.uBottom.value.set(m.bottom);
    u.uGlow.value.set(m.glow);
    u.uStars.value = m.stars;
    this.floorMat.uniforms.uBase.value.set(m.floorBase);
    this.floorMat.uniforms.uLine.value.set(m.floorLine);
    this.floorMat.uniforms.uFade.value.set(m.horizon).lerp(new THREE.Color(m.floorBase), 0.35);
    this.floor.visible = m.floor;
    setLightingPreset(m.light);
    // match the three.js lights to the custom shader lighting
    this.hemi.color.copy(LIGHT.uSkyColor.value).multiplyScalar(1.6);
    this.hemi.groundColor.copy(LIGHT.uGroundColor.value).multiplyScalar(1.6);
    this.sun.color.copy(LIGHT.uSunColor.value);
    this.sun.intensity = 2.2;
    this.mood = name;
    this.aimSun(this._focus);
  }

  /** Point the directional light at center, along the lighting preset's sun direction. */
  aimSun(center) {
    this._focus = center.clone();
    this.sun.position.copy(center).addScaledVector(LIGHT.uSunDir.value, 3);
    this.sun.target.position.copy(center);
    this.sun.target.updateMatrixWorld();
  }

  setShadows(enabled) {
    this.shadows = enabled;
  }
}
