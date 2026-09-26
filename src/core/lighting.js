// Lighting shared by the custom shaders: hemisphere ambient, one directional
// light, specular and a fresnel rim. The uniform objects are shared by
// reference, so changing them updates every material.

import * as THREE from 'three';

export const LIGHT = {
  uSunDir: { value: new THREE.Vector3(0.45, 0.85, 0.35).normalize() },
  uSunColor: { value: new THREE.Color(1.0, 0.96, 0.9).multiplyScalar(1.15) },
  uSkyColor: { value: new THREE.Color('#b9d4ff').multiplyScalar(0.62) },
  uGroundColor: { value: new THREE.Color('#e8d9c8').multiplyScalar(0.34) },
  uRimColor: { value: new THREE.Color('#ffffff') },
  uRimStrength: { value: 0.22 },
};

export function setLightingPreset(preset) {
  const p = LIGHTING_PRESETS[preset] || LIGHTING_PRESETS.studio;
  LIGHT.uSunDir.value.copy(p.sunDir).normalize();
  LIGHT.uSunColor.value.copy(p.sun);
  LIGHT.uSkyColor.value.copy(p.sky);
  LIGHT.uGroundColor.value.copy(p.ground);
  LIGHT.uRimColor.value.copy(p.rim);
  LIGHT.uRimStrength.value = p.rimStrength;
}

export const LIGHTING_PRESETS = {
  studio: {
    sunDir: new THREE.Vector3(0.45, 0.85, 0.35),
    sun: new THREE.Color(1.0, 0.96, 0.9).multiplyScalar(1.15),
    sky: new THREE.Color('#b9d4ff').multiplyScalar(0.62),
    ground: new THREE.Color('#e8d9c8').multiplyScalar(0.34),
    rim: new THREE.Color('#ffffff'),
    rimStrength: 0.22,
  },
  night: {
    sunDir: new THREE.Vector3(-0.3, 0.9, 0.4),
    sun: new THREE.Color('#c9d6ff').multiplyScalar(0.9),
    sky: new THREE.Color('#5a6bb0').multiplyScalar(0.55),
    ground: new THREE.Color('#302040').multiplyScalar(0.5),
    rim: new THREE.Color('#9fd8ff'),
    rimStrength: 0.45,
  },
};

export const LIGHTING_GLSL = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uGroundColor;
uniform vec3 uRimColor;
uniform float uRimStrength;

vec3 shade(vec3 albedo, vec3 N, vec3 V, float gloss) {
  float ndl = max(dot(N, uSunDir), 0.0);
  // wrap lighting so the unlit side isn't a flat color
  float wrap = max((dot(N, uSunDir) + 0.35) / 1.35, 0.0);
  vec3 ambient = mix(uGroundColor, uSkyColor, 0.5 + 0.5 * N.y);
  vec3 H = normalize(uSunDir + V);
  float spec = pow(max(dot(N, H), 0.0), mix(16.0, 90.0, gloss)) * mix(0.08, 0.45, gloss);
  float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
  vec3 col = albedo * (ambient + uSunColor * (0.75 * ndl + 0.25 * wrap));
  col += uSunColor * spec * ndl;
  col += uRimColor * fres * uRimStrength;
  return col;
}
`;
