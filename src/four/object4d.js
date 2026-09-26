// A 4D object: position and rotation in 4D, plus its slice, ghost and shadow meshes.

import * as THREE from 'three';
import * as R4 from '../math/rot4.js';
import { getShape } from './shapes.js';
import { createSliceMaterials } from './sliceMaterial.js';
import { createHypersphereMaterials, hypersphereGeometry } from './hypersphereMaterial.js';
import { ANA_COLOR, KATA_COLOR } from './sliceView.js';

const _M = R4.mat4();
const _MT = R4.mat4();
const _P = [0, 0, 0, 0];

export class Object4D {
  constructor(shapeKey, { scale = 0.1, scale4 = null, position = [0, 0, 0, 0], rotation = null, tint = null, tintAmount = 0.0, ghosts = true, opacity = 1 } = {}) {
    this.shape = getShape(shapeKey);
    this.key = shapeKey;
    this.scale = scale;
    // optional per-axis scale (only valid for shapes whose normals are axis-aligned, e.g. the tesseract)
    this.scale4 = scale4;
    this.pos = position.slice();
    this.R = rotation ? R4.copy(R4.mat4(), rotation) : R4.mat4();
    this.ghostsEnabled = ghosts;
    this.ghostRange = 0.9;
    this.highlight = 0;
    this.highlightTarget = 0;
    this.body = null;
    this.grabbed = false;
    this.slicePos = [0, 0, 0, 0]; // centre in slice space (updated in sync)
    this.sliceRadius = 0;         // bounding radius of the current cross-section
    this.inSlice = false;

    this.group = new THREE.Group();
    const geom = this.shape.isSphere ? hypersphereGeometry() : this.shape.tetMesh.geometry;
    this.mats = this.shape.isSphere
      ? createHypersphereMaterials()
      : createSliceMaterials(this.shape.tetMesh, { pattern: this.shape.pattern });
    if (tint) {
      this.mats.solid.uniforms.uTint.value.set(tint);
      this.mats.solid.uniforms.uTintAmount.value = tintAmount;
    }
    if (opacity < 1 && this.mats.solid.uniforms.uOpacity) {
      this.mats.solid.uniforms.uOpacity.value = opacity;
      this.mats.solid.transparent = true;
      this.mats.solid.depthWrite = false;
      this.mats.solid.side = THREE.DoubleSide;
    }

    this.mesh = new THREE.Mesh(geom, this.mats.solid);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.mesh.customDepthMaterial = this.mats.depth;
    this.group.add(this.mesh);

    this.ghost = new THREE.Mesh(geom, this.mats.ghost);
    this.ghost.frustumCulled = false;
    this.ghost.renderOrder = 5;
    this.group.add(this.ghost);
  }

  get radius() {
    if (this.scale4) return this.shape.radius * Math.max(...this.scale4);
    return this.shape.radius * this.scale;
  }

  setHighlight(v) {
    this.highlightTarget = v;
  }

  /** Push pose → uniforms for the current slice view. */
  sync(view, dt = 0) {
    view.rotToSlice(_M, this.R);
    view.toSlice(_P, this.pos);
    const r = this.radius;
    const dw = _P[3];
    this.slicePos[0] = _P[0]; this.slicePos[1] = _P[1]; this.slicePos[2] = _P[2]; this.slicePos[3] = dw;
    this.inSlice = Math.abs(dw) < r;
    this.sliceRadius = this.inSlice ? Math.sqrt(r * r - dw * dw) : 0;

    this.highlight += (this.highlightTarget - this.highlight) * Math.min(1, dt * 12);

    const u = this.mats.solid.uniforms;
    const g = this.mats.ghost.uniforms;
    const sh = this.mats.shared;
    if (this.shape.isSphere) {
      sh.uPos.value.set(_P[0], _P[1], _P[2], dw);
      sh.uSliceRadius.value = this.sliceRadius;
      sh.uRadius.value = r;
      R4.transpose(_MT, _M);
      R4.toThreeMatrix(sh.uRotInv.value, _MT, 1);
      g.uPos.value.set(_P[0], _P[1], _P[2], 0);
      g.uSliceRadius.value = r;
    } else {
      R4.toThreeMatrix(sh.uRot.value, _M, this.scale4 || this.scale);
      sh.uPos.value.set(_P[0], _P[1], _P[2], dw);
      sh.uLineScale.value = (this.scale4 ? Math.min(...this.scale4) : this.scale) * this.group.scale.x;
      g.uPos.value.set(_P[0], _P[1], _P[2], 0);
    }
    u.uHighlight.value = this.highlight;

    this.mesh.visible = this.inSlice;

    // Ghost: the object's cross-section through its own center, colored by the
    // sign of w. Fades in as the object leaves the slice and out with distance.
    const adw = Math.abs(dw);
    let ga = 0;
    if (this.ghostsEnabled) {
      const fadeIn = smoothstep(r * 0.3, r * 1.05, adw);
      const fadeOut = 1 - smoothstep(this.ghostRange * 0.55, this.ghostRange, adw);
      ga = 0.85 * fadeIn * fadeOut;
    }
    g.uGhostAlpha.value = ga;
    g.uGhostColor.value.copy(dw > 0 ? ANA_COLOR : KATA_COLOR);
    this.ghost.visible = ga > 0.01;
  }

  dispose() {
    this.mats.solid.dispose();
    this.mats.ghost.dispose();
    this.mats.depth.dispose();
    this.group.removeFromParent();
  }
}

export function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
