// Net of the tesseract: 8 cubes laid out in 3D that fold into a tesseract.
//
// The base cube is the cell w = -1. Each of its six neighbors rotates by θ in
// its (axis, w) plane around the face it shares with the base cube. The last
// cube is attached to the -y neighbor and rotates around its far face.

import { AXIS_COLORS } from './tetmesh.js';

const CUBE_VERTS = [];
for (let i = 0; i < 8; i++) CUBE_VERTS.push([(i & 1) ? 1 : -1, (i & 2) ? 1 : -1, (i & 4) ? 1 : -1]);
const CUBE_EDGES = [];
for (let i = 0; i < 8; i++) for (let b = 0; b < 3; b++) if (!(i & (1 << b))) CUBE_EDGES.push([i, i | (1 << b)]);
const CUBE_FACES = [
  [0, 1, 3, 2], [4, 5, 7, 6], [0, 1, 5, 4], [2, 3, 7, 6], [0, 2, 6, 4], [1, 3, 7, 5],
];

/**
 * @param {number} t fold amount 0 (flat net) … 1 (closed tesseract)
 * @returns {{vertices:number[][], edges:number[][], faces:{verts:number[]}[], edgeColors:number[][], faceColors:number[][]}}
 */
export function tesseractNet(t) {
  const th = t * Math.PI / 2;
  const c = Math.cos(th), s = Math.sin(th);
  const cubes = [];

  // base cube: cell w = -1
  cubes.push({ color: AXIS_COLORS[7], map: (x, y, z) => [x, y, z, -1] });

  // six neighbours: cell x_a = σ
  for (let a = 0; a < 3; a++) {
    for (const sg of [1, -1]) {
      const color = AXIS_COLORS[a * 2 + (sg > 0 ? 0 : 1)];
      cubes.push({
        color,
        map: (x, y, z) => {
          // unfolded, this cube sits at x_a = σ(1 + u), u ∈ [0, 2]
          const p = [x, y, z];
          const u = p[a] * sg + 1; // local coordinate −1..1 → u 0..2
          const out = [p[0], p[1], p[2], -1];
          // hinge at x_a = σ, w = −1; the strip direction σe_a turns towards +w
          out[a] = sg * (1 + u * c);
          out[3] = -1 + u * s;
          return out;
        },
      });
    }
  }

  // opposite cell w = +1, attached beyond the −y neighbour
  cubes.push({
    color: AXIS_COLORS[6],
    map: (x, y, z) => {
      const v = -y + 1; // 0..2 along −y beyond the hinge
      const sLen = 2 + v * c; // along the (rotated) strip
      const h = v * s;        // off the strip, towards its rotated normal
      // strip dir d = c(−e_y) + s e_w ; normal n = −s(−e_y) + c e_w
      const yy = -1 + sLen * (-c) + h * s;
      const ww = -1 + sLen * s + h * c;
      return [x, yy, z, ww];
    },
  });

  const vertices = [], edges = [], faces = [], edgeColors = [], faceColors = [];
  cubes.forEach((cube) => {
    const base = vertices.length;
    for (const v of CUBE_VERTS) vertices.push(cube.map(v[0], v[1], v[2]).map((x) => x * 0.5));
    for (const [a, b] of CUBE_EDGES) { edges.push([base + a, base + b]); edgeColors.push(cube.color); }
    for (const f of CUBE_FACES) { faces.push({ verts: f.map((i) => base + i) }); faceColors.push(cube.color); }
  });
  return { vertices, edges, faces, edgeColors, faceColors };
}
