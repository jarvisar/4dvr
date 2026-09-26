// Evaluated inside the page by tools/smoke.mjs:
//   node tools/smoke.mjs "http://localhost:5199/?desktop" out.png 3000 @tools/interaction-test.js
// Drives fake tracked-hand interactors through the real InteractionManager and
// scene code paths, and reports what happened. Returns a JSON summary.
(async () => {
  const app = window.__app;
  const THREE = { Vector3: app.camera.position.constructor, Quaternion: app.camera.quaternion.constructor };
  const out = { errors: [] };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const Interactor = app.input.xr[0].constructor;

  function fakeHand(handedness = 'right') {
    const ix = new Interactor(9);
    ix.kind = 'hand';
    ix.handedness = handedness;
    ix.active = true;
    ix.jointsValid = true;
    ix.hasPoke = false;
    ix.pokePos.set(99, 99, 99);
    return ix;
  }
  const step = (ix, n = 1, dt = 1 / 72) => {
    for (let i = 0; i < n; i++) {
      app.interaction._update(ix, app.activeScene, dt);
      app.activeScene.update(dt, app.time += dt);
      ix._record(app.time);
    }
  };
  const press = (btn, on) => btn.set(on);

  try {
    // ---------------- Playground ----------------
    app.setScene('playground', true);
    const pg = app.activeScene;
    pg.loadPreset('sandbox');
    for (let i = 0; i < 90; i++) pg.update(1 / 72, app.time += 1 / 72); // let things settle
    const toy = pg.toys.find((t) => t.obj.inSlice && t.enabled && t.obj.key === 'tesseract');
    const c = pg.stage.localToWorld(new THREE.Vector3(toy.obj.slicePos[0], toy.obj.slicePos[1], toy.obj.slicePos[2]));
    const hand = fakeHand();
    hand.grabPos.copy(c);
    out.nearDistance = +toy.nearDistance(c).toFixed(4);
    step(hand, 1);
    press(hand.pinch, true);
    step(hand, 1);
    out.grabbedToy = hand.grabbed === toy;
    const x0 = toy.body.x.slice();
    for (let i = 0; i < 30; i++) { hand.grabPos.y += 0.004; hand.grabPos.x += 0.002; step(hand, 1); }
    out.carriedUp = +(toy.body.x[1] - x0[1]).toFixed(3);
    // carry through W while holding: move the slice
    const w0 = toy.body.x[3];
    pg.setW(pg.view.w + 0.2);
    step(hand, 20);
    out.carriedThroughW = +(toy.body.x[3] - w0).toFixed(3);
    press(hand.pinch, false);
    step(hand, 1);
    out.released = hand.grabbed === null && !toy.body.held;
    pg.setW(0);

    // secondary: 4D trackball
    for (let i = 0; i < 60; i++) pg.update(1 / 72, app.time += 1 / 72);
    const toy2 = pg.toys.find((t) => t.obj.inSlice && t.enabled);
    const c2 = pg.stage.localToWorld(new THREE.Vector3(...toy2.obj.slicePos.slice(0, 3)));
    hand.grabPos.copy(c2);
    step(hand, 1);
    press(hand.grip, true);
    step(hand, 1);
    const R0 = Array.from(toy2.body.R);
    for (let i = 0; i < 20; i++) { hand.grabPos.x += 0.005; step(hand, 1); }
    const wMix = Math.abs(toy2.body.R[3]) + Math.abs(toy2.body.R[7]) + Math.abs(toy2.body.R[11]);
    out.rotated4D = { grabbed: hand.grabbed === toy2, changed: +R0.reduce((s, v, i) => s + Math.abs(v - toy2.body.R[i]), 0).toFixed(3), wCoupling: +wMix.toFixed(3) };
    press(hand.grip, false);
    step(hand, 1);

    // empty-air W scrub
    hand.grabPos.set(0.9, 1.3, 0.4); // away from everything
    step(hand, 1);
    const wBefore = pg.view.w;
    press(hand.pinch, true);
    step(hand, 1);
    out.emptyGrab = !!hand.emptyGrab;
    // a small wobble (a pinch that just missed an object) leaves the slice alone
    hand.grabPos.y += 0.008; step(hand, 1);
    out.airDeadzone = +(pg.view.w - wBefore).toFixed(4);
    hand.grabPos.y -= 0.008; step(hand, 1);
    for (let i = 0; i < 10; i++) { hand.grabPos.y += 0.01; step(hand, 1); }
    out.wScrub = +(pg.view.w - wBefore).toFixed(3);
    press(hand.pinch, false);
    step(hand, 1);

    // UI poke on the (desktop-placed) menu: press the "Tower" preset button
    const menu = app.menu.panel;
    menu.group.visible = true; menu.opacity = 1; menu.group.updateMatrixWorld(true);
    const btn = menu.widgets.find((w) => w.item && w.item.label === 'Tower');
    const onButton = (b, z) => menu.fromPanel(b.x + b.w / 2, b.y + b.h / 2, z, hand.pokePos);
    hand.hasPoke = true;
    onButton(btn, 0.03);
    step(hand, 1);
    onButton(btn, 0.0);
    step(hand, 1);
    out.pokedTower = pg.preset === 'tower';
    out.pokeCursor = hand.pokeHit.panel === menu;
    onButton(btn, 0.05);
    step(hand, 1);

    // a panel that appears with a fingertip already at its surface isn't pressed,
    // and pressing through it afterwards still works
    const balls = menu.widgets.find((w) => w.item && w.item.label === 'Hyperballs');
    const at = (z) => onButton(balls, z);
    menu.group.visible = false;
    at(0.002); step(hand, 1);
    menu.group.visible = true; menu.group.updateMatrixWorld(true);
    step(hand, 2);
    out.appearUnderFinger = pg.preset; // still 'tower'
    at(0.03); step(hand, 1);
    at(0.0); step(hand, 1);
    out.pressAfterAppear = pg.preset; // now 'balls'
    at(0.05); step(hand, 1);
    hand.hasPoke = false;

    // every scene's tips (every Hyperplay preset, hands and controllers) fit the
    // 5 lines the menu gives them
    const hintW = app.menu.panel.width - 2 * 0.014;
    const hintLines = {};
    for (const def of app.sceneList) {
      app.setScene(def.key, true);
      const sc = app.activeScene;
      const presets = def.key === 'playground' ? ['sandbox', 'box', 'mirror', 'dice', 'orbits', 'shadows', 'worldline'] : [null];
      for (const p of presets) {
        if (p) sc.loadPreset(p);
        for (const mode of ['hands', 'controllers']) {
          hintLines[`${def.key}${p ? `/${p}` : ''}/${mode}`] = app.menu.panel._wrapString(sc.hint(mode), hintW, 500).length;
        }
      }
    }
    out.hintLines = hintLines;
    app.setScene('playground', true);
    pg.loadPreset('tower');

    // pinch classification (thumb–index and thumb–middle distances, metres)
    const classify = app.input.constructor.classifyPinch;
    out.pinchKinds = {
      index: classify(0.015, 0.045, false, false),
      middleWithIndexNear: classify(0.026, 0.015, false, false),
      middleHeldIndexBrushes: classify(0.012, 0.021, false, true),
      bothTouching: classify(0.015, 0.016, false, false),
      released: classify(0.031, 0.05, true, false),
    };

    // sealed box puzzle: ball can't be dragged through glass
    pg.loadPreset('box');
    for (let i = 0; i < 30; i++) pg.update(1 / 72, app.time += 1 / 72);
    const ball = pg.ball;
    const bc = pg.stage.localToWorld(new THREE.Vector3(...ball.obj.slicePos.slice(0, 3)));
    hand.grabPos.copy(bc);
    step(hand, 1);
    press(hand.pinch, true);
    step(hand, 1);
    for (let i = 0; i < 40; i++) { hand.grabPos.x += 0.01; step(hand, 1); }
    out.boxBlocksDrag = +ball.body.x[0].toFixed(3); // should stay < ~0.12
    // go around through W
    for (let i = 0; i < 40; i++) { hand.grabPos.x -= 0.01; step(hand, 1); }
    pg.setW(0.2); step(hand, 20);
    for (let i = 0; i < 30; i++) { hand.grabPos.x += 0.01; step(hand, 1); }
    pg.setW(0); step(hand, 20);
    press(hand.pinch, false); step(hand, 60);
    out.boxSolved = pg.boxGoal.done;
    out.ballX = +ball.body.x[0].toFixed(3);

    // ---------------- Gallery ----------------
    app.setScene('gallery', true);
    const gal = app.activeScene;
    for (const k of ['simplex', 'orthoplex', 'icositetrachoron', 'hecatonicosachoron', 'hexacosichoron', 'duoprism', 'net', 'tiger', 'duocylinder', 'tesseract']) {
      gal.setShape(k);
      gal.update(1 / 72, app.time += 1 / 72);
    }
    gal.mode = 'stereo'; gal.update(1 / 72, app.time += 1 / 72);
    gal.mode = 'perspective';
    const gh = fakeHand();
    gh.grabPos.copy(gal.center);
    step(gh, 1);
    press(gh.grip, true); step(gh, 1);
    const g0 = Array.from(gal.R);
    for (let i = 0; i < 15; i++) { gh.grabPos.z -= 0.006; step(gh, 1); }
    out.galleryRotated = +g0.reduce((s, v, i) => s + Math.abs(v - gal.R[i]), 0).toFixed(3);
    press(gh.grip, false); step(gh, 1);
    gh.grabPos.set(0.8, 1.0, 0.3);
    step(gh, 1);
    press(gh.pinch, true); step(gh, 1);
    for (let i = 0; i < 10; i++) { gh.grabPos.y -= 0.01; step(gh, 1); }
    out.gallerySliceW = +gal.sliceW.toFixed(3);
    press(gh.pinch, false); step(gh, 1);

    // ---------------- Hopf ----------------
    app.setScene('hopf', true);
    const hopf = app.activeScene;
    const n0 = hopf.fibers.length;
    const hp = fakeHand();
    hp.hasPoke = true;
    for (let i = 0; i < 20; i++) {
      const a = i * 0.15;
      hopf._paintAt(hopf.globeCenter.clone().add(new THREE.Vector3(Math.cos(a), Math.sin(a) * 0.5, Math.sin(a)).normalize().multiplyScalar(hopf.globeR + 0.004)));
    }
    out.hopfPainted = hopf.fibers.length - n0;
    hp.hasPoke = false;
    hp.grabPos.copy(hopf.globeCenter);
    step(hp, 1);
    press(hp.pinch, true); step(hp, 1);
    for (let i = 0; i < 10; i++) { hp.grabQuat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.08)); step(hp, 1); }
    out.globeTurned = +(2 * Math.acos(Math.min(1, Math.abs(hopf.globeQ.w)))).toFixed(3);
    press(hp.pinch, false); step(hp, 1);

    // ---------------- Knots ----------------
    app.setScene('knots', true);
    const kn = app.activeScene;
    const dirs = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.577, 0.577, 0.577]];
    kn.load('trefoil');
    for (let i = 0; i < 30; i++) kn.update(1 / 72);
    const trefoilMin = Math.min(...dirs.map((d) => kn.rope.projectedCrossings(0, d)));
    const kh = fakeHand();
    const kp = kn.rope.p;
    kh.grabPos.set(kp[0], kp[1], kp[2]);
    kn.group.localToWorld(kh.grabPos);
    step(kh, 1);
    press(kh.grip, true); step(kh, 1);
    for (let i = 0; i < 30; i++) { kh.grabPos.y += 0.003; step(kh, 1); }
    const liftedW = kn.rope.maxAbsW();
    press(kh.grip, false); step(kh, 1);
    kn.flattenT = 1.5;
    for (let i = 0; i < 200; i++) kn.update(1 / 72);
    kn.load('hopf');
    out.knots = {
      trefoilMinCrossings: trefoilMin,
      liftedW: +liftedW.toFixed(3),
      wAfterFlatten: +kn.rope.maxAbsW().toFixed(4),
      circleCrossings: Math.max(...dirs.map((d) => kn.rope.projectedCrossings(0, d))),
    };

    // ---------------- Hyperbolic ----------------
    app.setScene('hyperbolic', true);
    const hy = app.activeScene;
    for (let i = 0; i < 3; i++) hy.update(1 / 72);
    const parity0 = hy.parity;
    for (let i = 0; i < 300; i++) { hy._translateLocal([0, 0, -0.02]); hy.update(1 / 72); }
    const p = [hy.Hm[3], hy.Hm[7], hy.Hm[11], hy.Hm[15]];
    out.hyperbolic = {
      headDistFromOrigin: +Math.acosh(p[3]).toFixed(3),
      homeDistance: +hy.homeDistance.toFixed(3),
      recenters: hy.parity !== parity0 ? 'odd' : 'even',
      lorentzCheck: +(p[0] ** 2 + p[1] ** 2 + p[2] ** 2 - p[3] ** 2).toFixed(6),
    };

    // ---------------- Spherical ----------------
    app.setScene('spherical', true);
    const sp = app.activeScene;
    sp.setTiling('c8');
    sp.goHome();
    sp.update(1 / 72);
    const walk = (dist, n = 400) => { for (let i = 0; i < n; i++) { sp._translateLocal(0, 0, -dist / n); sp.update(1 / 72); } };
    walk(Math.PI);
    const antipode = sp.homeDistance;
    walk(Math.PI);
    let orth = 0;
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
      let d = 0;
      for (let k = 0; k < 4; k++) d += sp.Hm[r * 4 + k] * sp.Hm[c * 4 + k];
      orth = Math.max(orth, Math.abs(d - (r === c ? 1 : 0)));
    }
    out.spherical = { antipode: +antipode.toFixed(4), around: +sp.homeDistance.toFixed(4), orth: +orth.toExponential(2) };
    sp.setTiling('c120');

    // ---------------- Hyperplay additions ----------------
    app.setScene('playground', true);
    const pgx = app.activeScene;
    const tick = (n) => { for (let i = 0; i < n; i++) pgx.update(1 / 72, app.time += 1 / 72); };
    // 4D shadows: a hypersphere just outside the slice (w = 0.12, r = 0.06)
    pgx.loadPreset('sandbox');
    pgx.clear();
    const ball4 = pgx.add('hypersphere', { scale: 0.06, pos: [0, 0.06, 0, 0.12] });
    const shadowArea = (sunDeg) => {
      pgx.sunW = sunDeg * Math.PI / 180;
      tick(1);
      pgx.shadow4.dirty = true;
      pgx.shadow4.render(app.renderer);
      const size = pgx.shadow4.rt.width, buf = new Uint8Array(size * size * 4);
      app.renderer.readRenderTargetPixels(pgx.shadow4.rt, 0, 0, size, size, buf);
      let n = 0;
      for (let i = 0; i < buf.length; i += 4) if (buf[i] > 127) n++;
      return n;
    };
    const offSliceStraight = shadowArea(0);
    const offSliceTilted = shadowArea(50);
    ball4.body.x[3] = 0;
    const inSlice = shadowArea(0);
    out.shadows = { offSliceStraight, offSliceTilted, inSlice };

    // dice
    pgx.loadPreset('dice');
    const d8 = pgx.dice[1];
    let pairsOk = true;
    d8.normals.forEach((n, i) => {
      const j = d8.normals.findIndex((m) => n[0] * m[0] + n[1] * m[1] + n[2] * m[2] + n[3] * m[3] < -0.999);
      if (j < 0 || d8.nums[i] + d8.nums[j] !== 9) pairsOk = false;
    });
    tick(900);
    out.dice = { pairsOk, results: pgx.dice.map((d) => d.result), sizes: pgx.dice.map((d) => d.nums.length) };

    // mirror puzzle: solved only by the mirror-image pose
    pgx.loadPreset('mirror');
    const piece = pgx.mirror.piece.body, tgt = pgx.mirrorTarget;
    const before = pgx._mirrorSolved();
    piece.x.splice(0, 4, ...tgt.pos);
    piece.R.set(tgt.R);
    const atTarget = pgx._mirrorSolved();
    // the same pose without the half-turn through w: a proper 3D rotation
    const flipXW = new Float64Array([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1]);
    const R3 = new Float64Array(16);
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { let v = 0; for (let k = 0; k < 4; k++) v += tgt.R[r * 4 + k] * flipXW[k * 4 + c]; R3[r * 4 + c] = v; }
    piece.R.set(R3);
    const unmirrored = pgx._mirrorSolved();
    out.mirror = { before, atTarget, unmirrored };

    // orbits: 4D gravity has no stable orbits, 3D gravity does
    pgx.gravity4 = true;
    pgx.loadPreset('orbits');
    tick(72 * 16);
    const g4 = { orbiting: pgx.moons.length, ...pgx.orbitStats };
    pgx.gravity4 = false;
    pgx.launchMoons();
    tick(72 * 16);
    const g3 = { orbiting: pgx.moons.length, ...pgx.orbitStats };
    pgx.gravity4 = true;
    out.orbits = { g4, g3 };

    // worldline: one ball per path in a slice of constant w, stacks of disks in a tilted one
    pgx.loadPreset('worldline');
    pgx.playing = false;
    pgx.setW(0.1);
    tick(1);
    const straightBalls = pgx.worldline.balls.geo.instanceCount;
    pgx.view.setAngles(0.5, 0);
    tick(1);
    const tiltedDisks = pgx.worldline.disks.geo.instanceCount, tiltedBalls = pgx.worldline.balls.geo.instanceCount;
    // record the (desktop) mouse for 4 s
    pgx.startRecording();
    const mouse = app.input.mouse;
    for (let i = 0; i < 72 * 7.2; i++) {
      const a = i / 20;
      mouse.grabPos.copy(pgx.stage.localToWorld(new THREE.Vector3(Math.cos(a) * 0.15, 0.15, Math.sin(a) * 0.15)));
      pgx.update(1 / 72, app.time += 1 / 72);
    }
    out.worldline = { straightBalls, tiltedDisks, tiltedBalls, recorded: pgx.worldline.chains.length, samples: pgx.worldline.chains[0]?.n || 0 };
    pgx.loadPreset('sandbox');

    // ---------------- Klein Room ----------------
    app.setScene('klein', true);
    const kl = app.activeScene;
    kl.reset();
    kl.update(1 / 72, app.time);
    // the head starts 0.6 m from the room's centre; moving the room 2.5 m back walks through the pink wall ahead
    kl._moveRoom(0, 2.5); kl.update(1 / 72, app.time);
    const afterPink = kl.mirrored;
    kl._moveRoom(0, -2.5); kl.update(1 / 72, app.time);
    const afterBack = kl.mirrored;
    kl._moveRoom(2.4, 0); kl.update(1 / 72, app.time);
    const afterCyan = kl.mirrored;
    const head = app.headPosition.clone().applyMatrix4(kl.Minv);
    out.klein = { afterPink, afterBack, afterCyan, crossings: kl.crossings - 1, inside: Math.abs(head.x) <= 1.6 && Math.abs(head.z) <= 1.6 };
    kl.reset();

    // ---------------- Quasicrystals ----------------
    // A tiling has no gaps or overlaps when every edge (face in 3D) away from the
    // rim belongs to exactly two tiles.
    app.setScene('quasicrystal', true);
    const qc = app.activeScene;
    qc.reset();
    const r3 = (x) => Math.round(x * 1e4);
    const floorCheck = () => {
      const f = qc.floor, P = f.geo.attributes.position.array, count = new Map();
      let thick = 0;
      for (let t = 0; t < f.count; t++) {
        const c = [0, 1, 2, 3].map((k) => [P[(t * 4 + k) * 3], P[(t * 4 + k) * 3 + 2]]);
        const a = (c[1][0] - c[0][0]) * (c[3][1] - c[0][1]) - (c[1][1] - c[0][1]) * (c[3][0] - c[0][0]);
        if (Math.abs(a) / (f.edge * f.edge) > 0.8) thick++;
        for (let k = 0; k < 4; k++) {
          const p = c[k], q = c[(k + 1) % 4];
          const key = [`${r3(p[0])},${r3(p[1])}`, `${r3(q[0])},${r3(q[1])}`].sort().join('|');
          const mid = Math.hypot((p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
          const e = count.get(key) || { n: 0, mid };
          e.n++;
          count.set(key, e);
        }
      }
      let bad = 0, checked = 0;
      for (const e of count.values()) if (e.mid < f.radius - 3 * f.edge) { checked++; if (e.n !== 2) bad++; }
      return { tiles: f.count, checked, bad, ratio: +(thick / (f.count - thick)).toFixed(3) };
    };
    const floor0 = floorCheck();
    const flips0 = qc.flipCount;
    for (let i = 0; i < 20; i++) { qc.shift(0.013, 0.007, 0); qc.rebuild(app.time += 0.1); }
    const after = floorCheck();
    qc.setMode('crystal');
    const cr = qc.crystal, F = cr.faceGeo.attributes.position.array, faces = new Map();
    for (let t = 0; t < cr.count; t++) for (let f = 0; f < 6; f++) {
      const base = (t * 36 + f * 6) * 3;
      const pts = [0, 1, 2, 5].map((k) => [F[base + k * 3], F[base + k * 3 + 1], F[base + k * 3 + 2]]);
      const key = pts.map((p) => p.map(r3).join(',')).sort().join('|');
      const c = pts.reduce((s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4, s[2] + p[2] / 4], [0, 0, 0]);
      const e = faces.get(key) || { n: 0, r: Math.hypot(...c) };
      e.n++;
      faces.set(key, e);
    }
    let cbad = 0, cchecked = 0;
    for (const e of faces.values()) if (e.r < cr.radius - 3 * cr.edge) { cchecked++; if (e.n !== 2) cbad++; }
    qc.setMode('floor');
    out.quasi = { floor: floor0, after, flips: qc.flipCount - flips0, crystal: { tiles: cr.count, checked: cchecked, bad: cbad } };
  } catch (e) {
    out.errors.push(String(e && e.stack || e));
  }
  return out;
})();
