// Hand poses for the tutorial's demonstration hand. Joint positions in mm,
// relative to the wrist joint (x, y, z per joint in the order of JOINT_NAMES),
// for a left hand: fingers along -z, palm towards -y, thumb towards +x. The
// right hand is the same with x flipped.
//
// Captured on a Quest. Taken from IWER's relaxed and pinch poses
// (https://github.com/meta-quest/immersive-web-emulation-runtime, MIT license,
// Copyright (c) Meta Platforms, Inc. and affiliates).

import * as THREE from 'three';
import { J } from './input.js';

const POSES = {
  relaxed: [0, 0, 0, 30.2, -16.1, -34.5, 51, -26.7, -57.2, 72.7, -32.9, -82.3, 86.8, -40.3, -101.1, 19.8, -9.5, -36.5, 23.6, -7.3, -96, 29.9, -8.7, -133.4, 33.5, -15.2, -156.5, 35.4, -21.8, -177.8, 3.6, -7.7, -34.3, 1.7, -2.5, -95.6, -3.5, -1.7, -138.3, -6.6, -9.6, -164.5, -9.8, -16.4, -188.3, -15, -6, -34.8, -17.5, -6.5, -88.7, -26.5, -2.8, -126.4, -31.6, -7.6, -152.1, -34.8, -13.2, -175.6, -23, -9.4, -34.1, -35.1, -13.7, -77.9, -47.8, -11.6, -105.8, -55.7, -16.9, -123.7, -62.2, -21.9, -144.1],
  pinch: [0, 0, 0, 20.5, -25, -38.4, 24.4, -48.8, -60.3, 21.9, -69.4, -86.9, 20.5, -86.3, -104.7, 15, -14, -38.4, 23.6, -7.3, -96, 24.5, -41.7, -111.9, 22.4, -65.8, -109, 18.7, -87.4, -104.4, -1.2, -9.9, -36.2, 1.7, -2.5, -95.6, 0.5, -16.8, -136.1, 0, -34.1, -157.6, -0.9, -49.2, -177.4, -15, -6, -34.8, -17.5, -6.5, -88.7, -22.6, -5.7, -127.3, -24.3, -14.9, -152.2, -24.5, -24.3, -174.7, -23, -9.4, -34.1, -35.1, -13.7, -77.9, -45, -8.6, -106.5, -51.1, -12.1, -125.5, -55.6, -15.3, -146.8],
};
export const JOINT_RADII = [21.5, 19.4, 12.3, 9.8, 8.8, 21.2, 10.3, 8.5, 7.6, 6.6, 21.2, 11.2, 8, 7.6, 6.6, 19.1, 9.9, 7.6, 7.2, 6.2, 18.1, 8.5, 6.8, 6.4, 5.4].map((r) => r / 1000);

// A pose blended between two of the above, in meters, for one hand
export function blendPose(out, from, to, t, handedness) {
  const a = POSES[from], b = POSES[to];
  const sx = handedness === 'right' ? -1 : 1;
  for (let j = 0; j < 25; j++) {
    const i = j * 3;
    out[j].set(
      sx * (a[i] + (b[i] - a[i]) * t) / 1000,
      (a[i + 1] + (b[i + 1] - a[i + 1]) * t) / 1000,
      (a[i + 2] + (b[i + 2] - a[i + 2]) * t) / 1000,
    );
  }
  return out;
}

// Where the thumb and index tips meet in the pinch pose, relative to the wrist
export function pinchPoint(handedness, out = new THREE.Vector3()) {
  const p = POSES.pinch, t = J['thumb-tip'] * 3, i = J['index-finger-tip'] * 3;
  const sx = handedness === 'right' ? -1 : 1;
  return out.set(sx * (p[t] + p[i]) / 2000, (p[t + 1] + p[i + 1]) / 2000, (p[t + 2] + p[i + 2]) / 2000);
}
