// The viewer's slice of the 4D world.
//
// slice space = rot * (world4 - (0, 0, 0, w))
//
// `w` moves the slice along the w axis. `rot` rotates it in the xw and zw
// planes and leaves y (gravity) unchanged.

import * as R4 from '../math/rot4.js';
import * as THREE from 'three';

export const ANA_COLOR = new THREE.Color('#ff4f9a');  // +w
export const KATA_COLOR = new THREE.Color('#33c3ff'); // −w

const _t = [0, 0, 0, 0];
const _rx = R4.mat4();
const _rz = R4.mat4();

export class SliceView {
  constructor() {
    this.w = 0;
    this.wMin = -1;
    this.wMax = 1;
    this.angleXW = 0;
    this.angleZW = 0;
    this.rot = R4.mat4();
    this.rotT = R4.mat4();
  }

  setW(w) {
    this.w = Math.min(this.wMax, Math.max(this.wMin, w));
  }

  setAngles(xw, zw) {
    this.angleXW = xw;
    this.angleZW = zw;
    R4.planeRotation(_rx, 0, 3, xw);
    R4.planeRotation(_rz, 2, 3, zw);
    R4.multiply(this.rot, _rx, _rz);
    R4.transpose(this.rotT, this.rot);
  }

  toSlice(out, p) {
    _t[0] = p[0]; _t[1] = p[1]; _t[2] = p[2]; _t[3] = p[3] - this.w;
    return R4.apply(out, this.rot, _t);
  }

  toWorld(out, s) {
    R4.applyT(out, this.rot, s);
    out[3] += this.w;
    return out;
  }

  rotToSlice(out, R) {
    return R4.multiply(out, this.rot, R);
  }

  rotToWorld(out, M) {
    return R4.multiply(out, this.rotT, M);
  }
}
