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
    for (let i = 0; i < 10; i++) { hand.grabPos.y += 0.01; step(hand, 1); }
    out.wScrub = +(pg.view.w - wBefore).toFixed(3);
    press(hand.pinch, false);
    step(hand, 1);

    // UI poke on the (desktop-placed) menu: press the "Tower" preset button
    const menu = app.menu.panel;
    menu.group.visible = true; menu.opacity = 1; menu.group.updateMatrixWorld(true);
    const btn = menu.widgets.find((w) => w.item && w.item.label === 'Tower');
    const local = new THREE.Vector3(btn.x + btn.w / 2 - menu.width / 2, menu.height / 2 - (btn.y + btn.h / 2), 0.03);
    hand.hasPoke = true;
    hand.pokePos.copy(menu.group.localToWorld(local.clone()));
    step(hand, 1);
    local.z = 0.0;
    hand.pokePos.copy(menu.group.localToWorld(local.clone()));
    step(hand, 1);
    out.pokedTower = pg.preset === 'tower';
    local.z = 0.05;
    hand.pokePos.copy(menu.group.localToWorld(local.clone()));
    step(hand, 1);
    hand.hasPoke = false;

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
  } catch (e) {
    out.errors.push(String(e && e.stack || e));
  }
  return out;
})();
