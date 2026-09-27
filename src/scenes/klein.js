// Klein Room: a flat universe that isn't orientable.
//
// The room is glued to itself. Walk out through the left or right side and you
// come back in through the other, as in a video game (a torus). Walk out
// through the front or back and you come back in through the other, mirrored:
// that pair of walls is glued with a flip, x → −x. The floor plan is a Klein
// bottle, and the space is a Klein bottle times the interval from floor to ceiling.
//
// Space is flat, so it's drawn as copies of the room, laid out by the gluing
// maps (every other row of copies is mirror-reversed). Copies of you are drawn
// in the other copies of the room. Crossing a flipped wall changes the map from
// room coordinates to the real room into a reflection: everything around you
// is now mirror-reversed, and your left hand fits the right-hand print.

import * as THREE from 'three';
import { SceneBase } from './base.js';
import { BONES } from '../core/handVisuals.js';
import { J } from '../core/input.js';
import { FONTS } from '../core/ui.js';

const W = 3.2, D = 3.2, H = 2.7; // room size (x, z) and height
const N = 2;                      // copies drawn on each side
const COPIES = (2 * N + 1) ** 2;

// Fog that fades things into the sky behind them, by distance from the eye.
// The copies stop N·W = 6.4 m away at the nearest (standing at a wall), and
// must be gone by then in every direction: otherwise the edge of the world
// shows, and a row of copies pops in or out when a wall crossing re-centres
// them. three.js fog can't do that: it has one colour, where the sky is a
// gradient, and it uses depth, which is shorter than the distance towards the
// sides of a wide VR view.
const FOG_NEAR = 4.0, FOG_FAR = N * W - 0.1;
const SKY_FOG_FRAG = /* glsl */ `
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyBottom;
uniform vec3 uSkyGlow;
uniform vec3 uSkySun;
varying vec3 vSkyFog; // eye to this point, world axes
// three.js's NeutralToneMapping (exposure 1), which the sky is drawn with.
// Materials that aren't tone mapped don't include it.
vec3 skyFogTone(vec3 color) {
  float x = min(color.r, min(color.g, color.b));
  color -= x < 0.08 ? x - 6.25 * x * x : 0.04;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < 0.76) return color;
  float newPeak = 1.0 - 0.0576 / (peak - 0.52);
  color *= newPeak / peak;
  return mix(color, vec3(newPeak), 1.0 - 1.0 / (0.15 * (peak - newPeak) + 1.0));
}
`;
// the sky's colour in this direction, as environment.js draws it (without the stars),
// only worked out where there is some fog: not in the room you're standing in
const SKY_FOG_APPLY = /* glsl */ `
float skyFogK = smoothstep(${FOG_NEAR.toFixed(2)}, ${FOG_FAR.toFixed(2)}, length(vSkyFog));
if (skyFogK > 0.0) {
  vec3 d = normalize(vSkyFog);
  vec3 sky = d.y > 0.0 ? mix(uSkyHorizon, uSkyTop, pow(d.y, 0.55)) : mix(uSkyHorizon, uSkyBottom, pow(-d.y, 0.4));
  float sun = max(dot(d, normalize(uSkySun)), 0.0);
  sky += uSkyGlow * (pow(sun, 8.0) * 0.35 + pow(sun, 120.0) * 0.8);
  sky = linearToOutputTexel(vec4(skyFogTone(sky), 1.0)).rgb;
  gl_FragColor.rgb = mix(gl_FragColor.rgb, sky, skyFogK);
}
`;

/** Give a built-in material the sky fog above (in place of three.js fog). */
function skyFog(material, sky) {
  material.fog = false;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, { uSkyTop: sky.uTop, uSkyHorizon: sky.uHorizon, uSkyBottom: sky.uBottom, uSkyGlow: sky.uGlow, uSkySun: sky.uSunDir });
    shader.vertexShader = shader.vertexShader
      .replace('#include <fog_pars_vertex>', 'varying vec3 vSkyFog;')
      .replace('#include <fog_vertex>', 'vSkyFog = mvPosition.xyz * mat3(viewMatrix);'); // view → world rotation
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <fog_pars_fragment>', SKY_FOG_FRAG)
      .replace('#include <fog_fragment>', SKY_FOG_APPLY);
  };
  material.customProgramCacheKey = () => 'klein-sky-fog';
  return material;
}

/** Gluing map for copy (i, j): (x, y, z) → ((−1)^j x + iW, y, z + jD). */
function copyMatrix(i, j) {
  const s = j % 2 === 0 ? 1 : -1;
  return new THREE.Matrix4().set(
    s, 0, 0, i * W,
    0, 1, 0, 0,
    0, 0, 1, j * D,
    0, 0, 0, 1,
  );
}

function mergeColored(parts) {
  const pos = [], nrm = [], col = [], index = [];
  for (const { geo, color, matrix } of parts) {
    if (matrix) geo.applyMatrix4(matrix);
    const c = new THREE.Color(color);
    const base = pos.length / 3;
    const gp = geo.attributes.position, gn = geo.attributes.normal;
    for (let i = 0; i < gp.count; i++) {
      pos.push(gp.getX(i), gp.getY(i), gp.getZ(i));
      nrm.push(gn.getX(i), gn.getY(i), gn.getZ(i));
      col.push(c.r, c.g, c.b);
    }
    if (geo.index) for (let i = 0; i < geo.index.count; i++) index.push(base + geo.index.getX(i));
    else for (let i = 0; i < gp.count; i++) index.push(base + i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(index);
  return g;
}

const at = (x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => new THREE.Matrix4().compose(
  new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));

const CYAN = '#33c3ff', PINK = '#ff4f9a';
const INK = '#2b2f3a', SLATE = '#3a3f4d', STONE = '#eee8de';
// the frame: a square pillar at each corner, and a lintel along the top of each wall
const PILLAR = 0.16, LINTEL = 0.2, CAP = 0.22, CAP_H = 0.06, BASE_H = 0.1;
const JAMB_TOP = H - LINTEL - CAP_H; // where the pillar's capital starts
// things standing in the room: (x, z) and the size of their plinths
const CLOCK = { x: -0.9, z: -0.8, size: 0.34, top: 1.0 };
const PLATE = { x: 0.2, z: -1.0, size: 0.44, top: 0.9 };
const HELIX = { x: 0.9, z: 0.8, size: 0.44, top: 0.8 };
const CLOCK_C = new THREE.Vector3(CLOCK.x, 1.3, CLOCK.z); // centre of the clock, inside its body
const SIGN_POS = new THREE.Vector3(-0.2, 1.9, -D / 2 + 0.05); // facing +z, into the room

/**
 * Everything in the room that doesn't move and is lit, in room coordinates,
 * merged into one mesh. The pillars and lintels are shared with the copies
 * next door, so each copy only draws the ones on its +x and +z sides; the
 * copies on the other sides draw the rest.
 */
function roomGeometry() {
  const parts = [];
  const add = (geo, color, matrix) => parts.push({ geo, color, matrix });
  const box = (sx, sy, sz) => new THREE.BoxGeometry(sx, sy, sz);
  add(box(PILLAR, H, PILLAR), SLATE, at(W / 2, H / 2, D / 2));
  add(box(CAP, BASE_H, CAP), SLATE, at(W / 2, BASE_H / 2, D / 2));
  add(box(CAP, CAP_H, CAP), SLATE, at(W / 2, JAMB_TOP + CAP_H / 2, D / 2));
  add(box(PILLAR, LINTEL, D), SLATE, at(W / 2, H - LINTEL / 2, 0));
  add(box(W, LINTEL, PILLAR), SLATE, at(0, H - LINTEL / 2, D / 2));
  // gallery plinths: a dark recessed foot, and a top slab that overhangs a little
  for (const { x, z, size, top } of [CLOCK, PLATE, HELIX]) {
    add(box(size - 0.04, 0.05, size - 0.04), INK, at(x, 0.025, z));
    add(box(size, top - 0.08, size), STONE, at(x, 0.05 + (top - 0.08) / 2, z));
    add(box(size + 0.03, 0.03, size + 0.03), SLATE, at(x, top - 0.015, z));
  }
  // a helix, which is chiral: this one twists to the right
  const helixPts = Array.from({ length: 60 }, (_, k) => {
    const t = k / 59, a = t * Math.PI * 6;
    return new THREE.Vector3(Math.cos(a) * 0.14, HELIX.top + 0.02 + t * 0.7, -Math.sin(a) * 0.14);
  });
  add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(helixPts), 160, 0.025, 8, false), '#e76f51', at(HELIX.x, 0, HELIX.z));
  // the tube is open-ended: round off both ends
  for (const p of [helixPts[0], helixPts[59]]) add(new THREE.SphereGeometry(0.025, 12, 8), '#e76f51', at(HELIX.x + p.x, p.y, HELIX.z + p.z));
  // the clock: a body facing +z with a bezel round the face (see clockFaceTexture()), on a stand
  // thinner than the body (0.03), so where it runs up behind the face it stays inside it
  add(new THREE.CylinderGeometry(0.21, 0.21, 0.03, 48).rotateX(Math.PI / 2), INK, at(CLOCK_C.x, CLOCK_C.y, CLOCK_C.z));
  add(new THREE.TorusGeometry(0.205, 0.013, 8, 48), INK, at(CLOCK_C.x, CLOCK_C.y, CLOCK_C.z + 0.015));
  add(box(0.03, 0.3, 0.02), INK, at(CLOCK_C.x, CLOCK.top + 0.08, CLOCK_C.z));
  // the pin the hands turn on (see update()), from the face out past the second hand
  add(new THREE.CylinderGeometry(0.008, 0.008, 0.02, 12).rotateX(Math.PI / 2), INK, at(CLOCK_C.x, CLOCK_C.y, CLOCK_C.z + 0.025));
  // a board behind the sign, so from behind it isn't a bare one-sided plane, hung from the lintel
  add(box(1.24, 0.34, 0.02), INK, at(SIGN_POS.x, SIGN_POS.y, SIGN_POS.z - 0.011));
  const rod = H - LINTEL - (SIGN_POS.y + 0.17);
  for (const dx of [-0.5, 0.5]) add(new THREE.CylinderGeometry(0.006, 0.006, rod, 6), INK, at(SIGN_POS.x + dx, SIGN_POS.y + 0.17 + rod / 2, SIGN_POS.z - 0.011));
  return mergeColored(parts);
}

/** A flat arrow on the floor, pointing along +x. */
function arrowGeometry(len = 0.3, shaft = 0.022, head = 0.07, headLen = 0.08) {
  const s = new THREE.Shape()
    .moveTo(-len / 2, -shaft / 2).lineTo(len / 2 - headLen, -shaft / 2).lineTo(len / 2 - headLen, -head / 2)
    .lineTo(len / 2, 0)
    .lineTo(len / 2 - headLen, head / 2).lineTo(len / 2 - headLen, shaft / 2).lineTo(-len / 2, shaft / 2);
  return new THREE.ShapeGeometry(s).rotateX(-Math.PI / 2);
}

/**
 * The glowing lines, drawn unlit: each wall is outlined as a doorway, along
 * the floor, up the pillars and under the lintel. Cyan where the walls are
 * glued straight across, pink where they're glued with a flip. Like the
 * frame, each copy draws the outlines on its +x and +z sides.
 */
function glowGeometry() {
  const parts = [];
  const add = (geo, color, matrix) => parts.push({ geo, color, matrix });
  const box = (sx, sy, sz) => new THREE.BoxGeometry(sx, sy, sz);
  add(box(0.04, 0.006, D), CYAN, at(W / 2, 0.003, 0));
  add(box(W, 0.006, 0.04), PINK, at(0, 0.003, D / 2));
  const jamb = JAMB_TOP - BASE_H, off = PILLAR / 2 + 0.003;
  for (const s of [-1, 1]) {
    add(box(0.03, jamb, 0.006), CYAN, at(W / 2, BASE_H + jamb / 2, D / 2 + s * off));
    add(box(0.006, jamb, 0.03), PINK, at(W / 2 + s * off, BASE_H + jamb / 2, D / 2));
  }
  add(box(0.03, 0.006, D - CAP), CYAN, at(W / 2, H - LINTEL - 0.003, 0));
  add(box(W - CAP, 0.006, 0.03), PINK, at(0, H - LINTEL - 0.003, D / 2));
  // arrows along the edges, as on a diagram of a Klein bottle. Every arrow points the same way in
  // the room, so across a cyan edge the arrows agree, and across a pink edge (seen in the next,
  // mirrored copy) they point opposite ways: that's the flip
  const inset = CAP / 2 - 0.045; // on the dark sill (see floorTexture()), clear of the line
  for (const s of [-1, 1]) {
    add(arrowGeometry(), PINK, at(0, 0.003, s * (D / 2 - inset)));
    add(arrowGeometry(), CYAN, at(s * (W / 2 - inset), 0.003, 0, 0, -Math.PI / 2));
  }
  return mergeColored(parts);
}

/** A texture drawn on a canvas; with text, it's drawn again once the web fonts have loaded. */
function canvasTexture(width, height, draw, { text = false, anisotropy = 4 } = {}) {
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  const g = c.getContext('2d');
  draw(g, width, height);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = anisotropy;
  if (text && document.fonts?.load) {
    Promise.all([700, 600].map((w) => document.fonts.load(`${w} 20px ${FONTS.sans}`)))
      .then(() => { draw(g, width, height); t.needsUpdate = true; })
      .catch(() => {});
  }
  return t;
}

/**
 * The floor, seen from above with −z at the top: tiles inside a dark sill,
 * where the rooms meet, as wide as the bases of the pillars, a large F whose mirror image is easy to recognise,
 * and soft shadows under the things standing on it. It's drawn unlit, so the
 * shadows are painted in.
 */
function floorTexture() {
  const S = 2048, px = S / W; // W = D
  const X = (x) => (x + W / 2) * px, Z = (z) => (z + D / 2) * px;
  return canvasTexture(S, S, (g) => {
    g.fillStyle = '#474c59';
    g.fillRect(0, 0, S, S);
    // 7 × 7 tiles, with a slightly different shade each
    const N_T = 7, t0 = -(W - CAP) / 2, T = -2 * t0 / N_T;
    let seed = 11;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let a = 0; a < N_T; a++) for (let b = 0; b < N_T; b++) {
      const [r, gr, bl] = (a + b) % 2 ? [236, 231, 222] : [216, 209, 197];
      const k = 1 + (rand() - 0.5) * 0.035;
      g.fillStyle = `rgb(${Math.round(r * k)}, ${Math.round(gr * k)}, ${Math.round(bl * k)})`;
      g.fillRect(X(t0 + a * T), Z(t0 + b * T), T * px, T * px);
    }
    g.strokeStyle = 'rgba(70, 60, 50, 0.28)';
    g.lineWidth = 3;
    g.beginPath();
    for (let k = 1; k < N_T; k++) {
      const p = t0 + k * T;
      g.moveTo(X(p), Z(t0)); g.lineTo(X(p), Z(-t0));
      g.moveTo(X(t0), Z(p)); g.lineTo(X(-t0), Z(p));
    }
    g.stroke();
    // a brass line round the tiles
    g.strokeStyle = '#b39862';
    g.lineWidth = 6;
    g.strokeRect(X(t0), Z(t0), N_T * T * px, N_T * T * px);
    // the F, inlaid, reading the right way from the starting spot
    const F = [[-0.38, -0.1], [0.12, -0.1], [0.12, 0.06], [-0.22, 0.06], [-0.22, 0.22], [0, 0.22], [0, 0.38], [-0.22, 0.38], [-0.22, 0.8], [-0.38, 0.8]];
    g.beginPath();
    for (const [x, z] of F) g.lineTo(X(x), Z(z));
    g.closePath();
    g.fillStyle = '#3d5a80';
    g.fill();
    g.lineWidth = 5;
    g.stroke(); // brass, as above
    // soft shadows: the shape is drawn off the canvas, so only its blurred shadow lands on it
    const shadow = (x, z, size, blur, alpha) => {
      g.save();
      g.shadowColor = `rgba(22, 20, 32, ${alpha})`;
      g.shadowBlur = blur * px;
      g.shadowOffsetX = S;
      g.fillRect(X(x - size / 2) - S, Z(z - size / 2), size * px, size * px);
      g.restore();
    };
    for (const x of [-W / 2, W / 2]) for (const z of [-D / 2, D / 2]) shadow(x, z, CAP + 0.04, 0.1, 0.55);
    for (const { x, z, size } of [CLOCK, PLATE, HELIX]) shadow(x, z, size, 0.09, 0.5);
  }, { anisotropy: 8 });
}

/** A right hand, palm down, seen from above with the fingers towards −z: the thumb is on the left. */
function handPrintTexture() {
  return canvasTexture(512, 512, (g) => {
    g.fillStyle = INK;
    g.fillRect(0, 0, 512, 512);
    g.strokeStyle = 'rgba(255, 217, 61, 0.4)';
    g.lineWidth = 6;
    g.beginPath();
    g.roundRect(16, 16, 480, 480, 36);
    g.stroke();
    g.fillStyle = g.strokeStyle = '#ffd93d';
    g.lineCap = 'round';
    g.beginPath();
    g.roundRect(172, 222, 172, 180, [46, 54, 84, 84]);
    g.fill();
    for (const [x, len, a, w] of [[194, 112, -0.1, 40], [240, 132, -0.02, 42], [285, 122, 0.06, 40], [324, 90, 0.16, 34]]) {
      g.lineWidth = w;
      g.beginPath();
      g.moveTo(x, 256);
      g.lineTo(x + Math.sin(a) * len, 256 - Math.cos(a) * len);
      g.stroke();
    }
    g.lineWidth = 46;
    g.beginPath();
    g.moveTo(196, 352);
    g.quadraticCurveTo(136, 322, 112, 258);
    g.stroke();
    g.fillStyle = '#f7f3ec';
    g.font = `700 38px ${FONTS.sans}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('RIGHT HAND', 256, 452);
  }, { text: true });
}

function signTexture() {
  return canvasTexture(1024, 256, (g) => {
    g.fillStyle = '#f7f3ec';
    g.fillRect(0, 0, 1024, 256);
    g.fillStyle = INK;
    g.font = `700 108px ${FONTS.sans}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('KLEIN ROOM →', 512, 134);
  }, { text: true });
}

/** The clock's face, with numerals, which read backwards in a mirrored copy. */
function clockFaceTexture() {
  return canvasTexture(512, 512, (g) => {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#f7f3ec';
    g.fillRect(0, 0, 512, 512);
    g.translate(256, 256);
    g.fillStyle = INK;
    for (let k = 0; k < 60; k++) {
      g.save();
      g.rotate((k / 60) * Math.PI * 2);
      if (k % 5 === 0) g.fillRect(-5, -236, 10, 30);
      else g.fillRect(-2, -236, 4, 13);
      g.restore();
    }
    g.font = `600 54px ${FONTS.sans}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (let h = 1; h <= 12; h++) {
      const a = (h / 12) * Math.PI * 2;
      g.fillText(String(h), Math.sin(a) * 168, -Math.cos(a) * 168 + 3);
    }
  }, { text: true });
}

/**
 * Instances that may be mirror images. three.js decides which side of a
 * triangle faces the camera per object, not per instance, so mirrored
 * instances go into a second mesh that is itself mirrored (scale x = −1).
 */
class MirrorableInstances {
  constructor(parent, geo, mat, count) {
    this.meshes = [0, 1].map((k) => {
      const m = new THREE.InstancedMesh(geo, mat, count);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      if (k === 1) m.scale.x = -1;
      parent.add(m);
      return m;
    });
    this.n = [0, 0];
  }

  begin() { this.n[0] = 0; this.n[1] = 0; }

  push(matrix) {
    if (matrix.determinant() >= 0) this.meshes[0].setMatrixAt(this.n[0]++, matrix);
    else this.meshes[1].setMatrixAt(this.n[1]++, _fm.multiplyMatrices(FLIP_X, matrix)); // the mesh's own flip undoes this one
  }

  end() {
    this.meshes.forEach((m, k) => {
      m.count = this.n[k];
      m.visible = this.n[k] > 0;
      m.instanceMatrix.needsUpdate = true;
    });
  }
}

const FLIP_X = new THREE.Matrix4().makeScale(-1, 1, 1);
const _fm = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _headM = new THREE.Matrix4();
const _bodyM = new THREE.Matrix4();
const _bodyQ = new THREE.Quaternion();
const HEAD_SHAPE = at(0, 0.02, 0.07, 0, 0, 0, 0.08, 0.105, 0.1);
const VISOR_SHAPE = at(0, 0, -0.035);
const NECK_TOP = new THREE.Vector3(0, -0.05, 0.07); // head space, 3.5 cm inside the bottom of the head
const _neckM = new THREE.Matrix4();
const _hourM = new THREE.Matrix4();
const _minM = new THREE.Matrix4();
const _secM = new THREE.Matrix4();
const MAX_PARTS = 25 + BONES.length;
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
const _up = new THREE.Vector3(0, 1, 0);

/** A clock hand at time t (s), a turn per period, dz in front of the clock's centre, stretched by (sx, sy, sz). */
function clockHand(m, t, period, dz, sx = 1, sy = 1, sz = 1) {
  return m.makeRotationZ(-((t % period) / period) * Math.PI * 2).scale(_s.set(sx, sy, sz)).setPosition(CLOCK_C.x, CLOCK_C.y, CLOCK_C.z + dz);
}

export class KleinScene extends SceneBase {
  constructor(app) {
    super(app);
    this.key = 'klein';
    this.title = 'Klein Room';
    this.short = 'Klein';
    this.subtitle = 'A room glued to itself with a flip';
    this.mood = 'klein';
    this.noOrbit = true;
    this.locomotion = true; // snap turn and the comfort vignette (see App)
    this.showSelf = true;

    this.copies = [];
    for (let i = -N; i <= N; i++) for (let j = -N; j <= N; j++) this.copies.push({ i, j, C: copyMatrix(i, j) });
    this.M = new THREE.Matrix4();    // room → real world
    this.Minv = new THREE.Matrix4();
    this.crossings = 0;

    const sky = app.env.skyMat.uniforms;
    const inst = (geo, mat, count) => new MirrorableInstances(this.root, geo, skyFog(mat, sky), count);
    // the parts of the room that don't move, in room coordinates: one instance per copy.
    // The floor is unlit, with its shading painted in, as it covers so much of the view.
    // The rest is Lambert: at this roughness, Standard's highlight barely shows,
    // and it costs about twice as much per pixel.
    this.platePos = new THREE.Vector3(PLATE.x, PLATE.top + 0.002, PLATE.z);
    this.plateMat = new THREE.MeshBasicMaterial({ map: handPrintTexture(), toneMapped: false });
    this.fixed = [
      inst(roomGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }), COPIES),
      inst(new THREE.PlaneGeometry(W, D).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: floorTexture(), toneMapped: false }), COPIES),
      inst(glowGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }), COPIES),
      inst(new THREE.PlaneGeometry(1.2, 0.3).translate(SIGN_POS.x, SIGN_POS.y, SIGN_POS.z), new THREE.MeshBasicMaterial({ map: signTexture(), toneMapped: false }), COPIES),
      inst(new THREE.CircleGeometry(0.2, 48).translate(CLOCK_C.x, CLOCK_C.y, CLOCK_C.z + 0.017), new THREE.MeshBasicMaterial({ map: clockFaceTexture(), toneMapped: false }), COPIES),
      inst(new THREE.PlaneGeometry(0.34, 0.34).rotateX(-Math.PI / 2).translate(this.platePos.x, this.platePos.y, this.platePos.z), this.plateMat, COPIES),
    ];
    // the clock's hands: hour and minute hands are one box, stretched (see update()), with a short tail
    this.hands = inst(new THREE.BoxGeometry(1, 1, 1).translate(0, 0.4, 0), new THREE.MeshLambertMaterial({ color: INK }), 2 * COPIES);
    this.secondHand = inst(new THREE.BoxGeometry(0.006, 0.22, 0.004).translate(0, 0.07, 0), new THREE.MeshLambertMaterial({ color: '#e63946' }), COPIES);

    // copies of you: head, headset, neck, body and hands
    const skin = new THREE.MeshLambertMaterial({ color: '#f0cdb0' });
    this.head = inst(new THREE.SphereGeometry(1, 24, 16), skin, COPIES);
    this.visor = inst(new THREE.BoxGeometry(0.19, 0.1, 0.09), new THREE.MeshLambertMaterial({ color: '#d6d9e0' }), COPIES);
    this.neck = inst(new THREE.CylinderGeometry(1, 1, 1, 12, 1, true).translate(0, 0.5, 0), skin, COPIES);
    this.torso = inst(new THREE.CapsuleGeometry(0.15, 0.45, 8, 20), new THREE.MeshLambertMaterial({ color: '#5b6fc4' }), COPIES);
    this.joints = inst(new THREE.SphereGeometry(1, 10, 8), skin, COPIES * 50);
    this.bones = inst(new THREE.CylinderGeometry(1, 1, 1, 8).translate(0, 0.5, 0), skin, COPIES * BONES.length * 2);
    this.desktopView = { position: new THREE.Vector3(0, 1.6, 0.6), target: new THREE.Vector3(0, 1.4, -1) };
    this.yaw = 0;
    this.pitch = 0;
    this.keys = new Set();
    this._onKeyDown = (e) => { if (!e.ctrlKey && !e.metaKey && !e.altKey) this.keys.add(e.key.toLowerCase()); };
    this._onKeyUp = (e) => this.keys.delete(e.key.toLowerCase());
    this._onBlur = () => this.keys.clear();
    this._onPointerMove = (e) => {
      if (this.app.presenting || !(e.buttons & 1) || !this.app.pointerOnEmpty) return;
      this.yaw -= e.movementX * 0.004;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.004, -1.4, 1.4);
    };
    this._placeRoom();
  }

  get mirrored() { return this.M.determinant() < 0; }

  reset() {
    this.M.identity();
    this.crossings = 0;
    this._placeRoom();
  }

  /** Room copies and fixed objects, after M changes. */
  _placeRoom() {
    this.Minv.copy(this.M).invert();
    for (const m of this.fixed) m.begin();
    for (const c of this.copies) {
      c.world = (c.world || new THREE.Matrix4()).multiplyMatrices(this.M, c.C);
      for (const m of this.fixed) m.push(c.world);
    }
    for (const m of this.fixed) m.end();
  }

  enter() {
    super.enter();
    this.tzOffset = new Date().getTimezoneOffset() * 60000;
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    this.app.renderer.domElement.addEventListener('pointermove', this._onPointerMove);
    if (!this.app.presenting) { this.yaw = 0; this.pitch = 0; }
  }

  exit() {
    super.exit();
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    this.keys.clear();
    this.app.renderer.domElement.removeEventListener('pointermove', this._onPointerMove);
  }

  /** Move the room by a real-world displacement (the viewer moves the opposite way). */
  _moveRoom(dx, dz) {
    _m.makeTranslation(dx, 0, dz);
    this.M.premultiply(_m);
    this._placeRoom();
  }

  onEmptyGrabStart(ix) {
    this.pull = { last: ix.grabPos.clone() };
    return true;
  }

  onEmptyGrabUpdate(ix) {
    if (!this.pull) return;
    const d = _v.copy(ix.grabPos).sub(this.pull.last);
    this.pull.last.copy(ix.grabPos);
    const gain = ix.isMouse ? 2.5 : 3.0;
    this.app.addMotion(Math.hypot(d.x, d.z) * gain);
    this._moveRoom(d.x * gain, d.z * gain); // pulling the room towards you moves you forwards
  }

  onEmptyGrabEnd() { this.pull = null; }

  /** Keep the head inside the central copy: crossing a wall re-glues the room around you. */
  _wrap() {
    const p = _v.copy(this.app.headPosition).applyMatrix4(this.Minv);
    let g = null;
    if (p.x > W / 2) g = copyMatrix(1, 0);
    else if (p.x < -W / 2) g = copyMatrix(-1, 0);
    else if (p.z > D / 2) g = copyMatrix(0, 1);
    else if (p.z < -D / 2) g = copyMatrix(0, -1);
    if (!g) return;
    // the head is now in copy g of the room: re-label so it's in the central one
    this.M.multiply(g);
    this.crossings++;
    this._placeRoom();
    this.app.audio._tone({ freq: this.mirrored ? 440 : 660, type: 'triangle', dur: 0.2, gain: 0.07 });
  }

  update(dt) {
    const app = this.app;
    if (!app.presenting) {
      app.camera.position.copy(this.desktopView.position);
      app.camera.quaternion.setFromEuler(_e.set(this.pitch, this.yaw, 0, 'YXZ'));
      app.camera.updateMatrixWorld();
      app.camera.getWorldPosition(app.headPosition);
      app.camera.getWorldQuaternion(app.headQuaternion);
      const f = (this.keys.has('w') ? 1 : 0) - (this.keys.has('s') ? 1 : 0), s = (this.keys.has('d') ? 1 : 0) - (this.keys.has('a') ? 1 : 0);
      if (f || s) {
        const sp = (this.keys.has('shift') ? 3.0 : 1.4) * dt;
        const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
        this._moveRoom(-(fx * f + Math.cos(this.yaw) * s) * sp, -(fz * f - Math.sin(this.yaw) * s) * sp);
      }
    }
    for (const ix of app.input.xr) {
      if (ix.kind !== 'controller' || (!ix.stick.x && !ix.stick.y)) continue;
      _v2.set(ix.stick.x, 0, ix.stick.y).applyQuaternion(ix.rayQuat).setY(0).multiplyScalar(-dt * 1.2);
      app.addMotion(_v2.length());
      this._moveRoom(_v2.x, _v2.z);
    }
    this._wrap();

    // the clock tells the local time, its hands turning clockwise in the room's own frame
    const t = (Date.now() - this.tzOffset) / 1000;
    clockHand(_hourM, t, 43200, 0.0205, 0.022, 0.12, 0.004);
    clockHand(_minM, t, 3600, 0.0255, 0.015, 0.175, 0.004);
    clockHand(_secM, t, 60, 0.0295);
    this.hands.begin();
    this.secondHand.begin();
    for (const c of this.copies) {
      this.hands.push(_m.multiplyMatrices(c.world, _hourM));
      this.hands.push(_m.multiplyMatrices(c.world, _minM));
      this.secondHand.push(_m.multiplyMatrices(c.world, _secM));
    }
    this.hands.end();
    this.secondHand.end();

    this._updateSelf();
    this._updatePlate();
  }

  /** Copies of you in the other copies of the room. */
  _updateSelf() {
    const app = this.app;
    const parts = [this.head, this.visor, this.neck, this.torso, this.joints, this.bones];
    for (const m of parts) m.begin();
    if (this.showSelf) {
      _headM.compose(app.headPosition, app.headQuaternion, _s.set(1, 1, 1));
      const fwd = _v.set(0, 0, -1).applyQuaternion(app.headQuaternion).setY(0).normalize();
      _bodyQ.setFromAxisAngle(_up, Math.atan2(-fwd.x, -fwd.z));
      _v2.copy(app.headPosition).addScaledVector(fwd, -0.08);
      _v2.y -= 0.52;
      _bodyM.compose(_v2, _bodyQ, _s.set(1.1, 1, 0.75));
      // neck: from inside the top of the torso to inside the bottom of the head,
      // which turns and tilts on it (the body only turns)
      _v2.y += 0.33;
      _v.copy(NECK_TOP).applyMatrix4(_headM).sub(_v2);
      const len = _v.length();
      _neckM.compose(_v2, _q.setFromUnitVectors(_up, _v.divideScalar(len || 1)), _s.set(0.045, len, 0.045));
      // the hands' joints and bones in the real world, computed once
      const hand = this._handParts || (this._handParts = Array.from({ length: 2 * MAX_PARTS }, () => new THREE.Matrix4()));
      let np = 0, nJoints = 0;
      if (app.presenting) {
        for (const ix of app.input.xr) {
          if (ix.kind !== 'hand' || !ix.jointsValid) continue;
          for (let j = 0; j < 25; j++) {
            const r = Math.max(0.005, ix.joints[j].radius * 0.9);
            hand[np++].compose(ix.joints[j].pos, _q.identity(), _s.set(r, r, r));
          }
          nJoints += 25;
        }
        for (const ix of app.input.xr) {
          if (ix.kind !== 'hand' || !ix.jointsValid) continue;
          for (const [a, b] of BONES) {
            const pa = ix.joints[a].pos;
            _v.subVectors(ix.joints[b].pos, pa);
            const len = _v.length();
            const r = Math.max(0.004, Math.min(ix.joints[a].radius, ix.joints[b].radius) * 0.6);
            _q.setFromUnitVectors(_up, _v.divideScalar(len || 1));
            hand[np++].compose(pa, _q, _s.set(r, len, r));
          }
        }
      }
      for (const c of this.copies) {
        if (c.i === 0 && c.j === 0) continue; // that one is you
        // real world → room → this copy → real world
        _m.multiplyMatrices(c.world, this.Minv);
        this.head.push(_m2.multiplyMatrices(_m, _headM).multiply(HEAD_SHAPE));
        this.visor.push(_m2.multiplyMatrices(_m, _headM).multiply(VISOR_SHAPE));
        this.neck.push(_m2.multiplyMatrices(_m, _neckM));
        this.torso.push(_m2.multiplyMatrices(_m, _bodyM));
        for (let p = 0; p < np; p++) (p < nJoints ? this.joints : this.bones).push(_m2.multiplyMatrices(_m, hand[p]));
      }
    }
    for (const m of parts) m.end();
  }

  /** Which hand fits the print right now: with the room mirrored around you, it's your left. */
  _updatePlate() {
    let fits = null;
    if (this.app.presenting) {
      for (const ix of this.app.input.xr) {
        if (ix.kind !== 'hand' || !ix.jointsValid) continue;
        const palm = _v.copy(ix.joints[J.wrist].pos).lerp(ix.joints[J['middle-finger-phalanx-proximal']].pos, 0.6).applyMatrix4(this.Minv);
        if (palm.distanceTo(this.platePos) > 0.12) continue;
        // in room coordinates a hand is right-handed if it's a right hand and the room isn't mirrored around you
        const right = (ix.handedness === 'right') !== this.mirrored;
        fits = right;
      }
    }
    this.plateMat.color.set(fits === null ? '#ffffff' : fits ? '#8dff9a' : '#ff8d8d');
    this.fits = fits;
  }

  menuRows() {
    return [
      { type: 'buttons', items: [{ label: 'Back to the start', onClick: () => this.reset() }] },
      { type: 'toggles', items: [{ label: 'Show copies of yourself', get: () => this.showSelf, set: (v) => { this.showSelf = v; } }] },
      {
        type: 'text', lines: 2, color: '#dfe2ff',
        text: () => `Walls crossed: ${this.crossings}. You are ${this.mirrored ? 'mirror-reversed: your left hand fits the right-hand print' : 'the right way round'}.`,
      },
    ];
  }

  hint(mode) {
    const sticks = this.app.comfort.snapTurn ? 'Walk, or use the left stick (the right stick turns)' : 'Walk, or use the sticks';
    const move = { hands: 'Walk, or pinch empty space and pull', controllers: sticks, desktop: 'Use WASD' }[mode];
    return `${move} to move. The cyan walls are glued straight across. The pink walls are glued with a flip, so crossing one leaves you mirror-reversed: text reads backwards and your left hand fits the right-hand print.`;
  }

  desktopHelp({ touch } = {}) {
    if (touch) return '<b>Drag</b> to look around · moving needs a keyboard or a headset';
    return '<b>WASD</b> move (<b>Shift</b> faster) · <b>drag</b> to look · <b>right-drag</b> to pull · <b>M</b> menu';
  }
}
