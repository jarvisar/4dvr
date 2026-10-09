import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const BASE = process.env.QA_BASE || 'http://127.0.0.1:5173/';
const OUT = 'smoke-artifacts/qa-input';
fs.mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--ignore-certificate-errors', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,800'],
});
const results = {};
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${BASE}?desktop`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__app?.sceneList.length === 8);
  results.desktop = await page.evaluate(async () => {
    const app = window.__app;
    app.renderer.setAnimationLoop(null);
    const out = {};
    const input = app.input, mouse = input.mouse, canvas = app.renderer.domElement;
    // These events exercise app handlers. Synthetic pointers cannot use native capture.
    canvas.setPointerCapture = () => {};
    canvas.releasePointerCapture = () => {};
    const V = app.camera.position.constructor;
    const tick = () => {
      input.update(1 / 72, app.time += 1 / 72);
      app.interaction.update(1 / 72);
    };
    app.setScene('playground', true);
    const pg = app.activeScene;
    pg.loadPreset('sandbox');
    for (let i = 0; i < 120; i++) pg.update(1 / 72, app.time += 1 / 72);
    app.camera.updateMatrixWorld(true);
    pg.root.updateMatrixWorld(true);
    const toy = pg.toys.find((t) => t.enabled && t.obj.inSlice && t.obj.key === 'tesseract');
    const c = new V(); toy.pullPoint(c);
    const ndc = c.clone().project(app.camera);
    const rect = canvas.getBoundingClientRect();
    const x = rect.left + (ndc.x + 1) * rect.width / 2;
    const y = rect.top + (1 - ndc.y) * rect.height / 2;
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: x, clientY: y }));
    tick();
    out.beforeBlur = { pinch: mouse.pinch.pressed, grabbed: !!mouse.grabbed, key: mouse.grabbed?.obj?.key };
    window.dispatchEvent(new Event('blur'));
    tick();
    canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, pointerType: 'mouse', buttons: 0, clientX: x + 90, clientY: y }));
    tick();
    out.afterBlurAndReleasedMove = { pinch: mouse.pinch.pressed, grabbed: !!mouse.grabbed, buttons: input._buttons };
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 0 }));
    tick();
    out.afterExplicitUp = { pinch: mouse.pinch.pressed, grabbed: !!mouse.grabbed };
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: 1, clientX: x, clientY: y })); tick();
    canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, pointerType: 'mouse', buttons: 0, clientX: x, clientY: y })); tick();
    out.releasedMove = { pinch: mouse.pinch.pressed, grabbed: !!mouse.grabbed };
    const dispatchTouch = (type, id, x, y, buttons = 1) => (type === 'pointerup' || type === 'pointercancel' ? window : canvas).dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: id, pointerType: 'touch', button: 0, buttons, clientX: x, clientY: y }));
    dispatchTouch('pointerdown', 20, 20, 20); tick();
    out.oneTouch = { pinch: mouse.pinch.pressed, grip: mouse.grip.pressed };
    dispatchTouch('pointerdown', 21, 80, 20); tick();
    out.twoTouch = { pinch: mouse.pinch.pressed, grip: mouse.grip.pressed, twoFinger: input.twoFinger, orbit: app.orbit.enabled };
    dispatchTouch('pointerup', 21, 80, 20, 0); tick();
    out.oneRemaining = { pinch: mouse.pinch.pressed, grip: mouse.grip.pressed, twoFinger: input.twoFinger };
    dispatchTouch('pointercancel', 20, 20, 20, 0); tick();
    out.touchCancelled = { pinch: mouse.pinch.pressed, grip: mouse.grip.pressed, touches: input._touches.size, orbit: app.orbit.enabled };
    dispatchTouch('pointerdown', 22, 20, 20); tick();
    window.dispatchEvent(new Event('blur')); tick();
    out.touchBlur = { pinch: mouse.pinch.pressed, touches: input._touches.size, twoFinger: input.twoFinger };
    dispatchTouch('pointercancel', 22, 20, 20, 0); tick();
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 30, pointerType: 'pen', button: 0, buttons: 1, clientX: x, clientY: y })); tick();
    canvas.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, pointerId: 30, pointerType: 'pen', buttons: 0 })); tick();
    out.penCaptureLost = { pinch: mouse.pinch.pressed, grabbed: !!mouse.grabbed };
    const panel = app.menu.panel;
    panel.group.visible = true; panel.opacity = 1; panel.group.position.set(0, 1.5, -0.5); panel.group.updateMatrixWorld(true);
    const pokingHand = new app.input.xr[0].constructor(12);
    pokingHand.kind = 'hand'; pokingHand.active = true; pokingHand.hasPoke = true;
    const tower = panel.widgets.find((w) => w.item?.label === 'Tower');
    const pokeAt = (z) => panel.fromPanel(tower.x + tower.w / 2, tower.y + tower.h / 2, z, pokingHand.pokePos);
    pokeAt(0.03); app.ui.updatePoke(pokingHand);
    const presetBeforeGap = pg.preset;
    pokingHand.hasPoke = false; app.ui.updatePoke(pokingHand);
    const forgottenDepth = !panel.pokeZ.has(pokingHand);
    pokeAt(0); pokingHand.hasPoke = true; app.ui.updatePoke(pokingHand);
    const unchangedOnReturn = pg.preset === presetBeforeGap;
    pokeAt(0.03); app.ui.updatePoke(pokingHand);
    pokeAt(0); app.ui.updatePoke(pokingHand);
    out.pokeTrackingGap = { forgottenDepth, unchangedOnReturn, pressAfterReturn: pg.preset === 'tower' };
    app.setScene('hyperbolic', true);
    const hy = app.activeScene;
    const before = hy.homeDistance;
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'w', code: 'KeyW' }));
    for (let i = 0; i < 50; i++) hy.update(1 / 72);
    out.walkKeyboard = { before, after: hy.homeDistance };
    window.dispatchEvent(new Event('blur'));
    const dist = hy.homeDistance;
    for (let i = 0; i < 50; i++) hy.update(1 / 72);
    out.walkBlur = { before: dist, after: hy.homeDistance };
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 31, pointerType: 'mouse', button: 0, buttons: 1, clientX: 20, clientY: 20 }));
    const hadLookDrag = !!hy.walk._drag;
    window.dispatchEvent(new Event('blur'));
    const yaw = hy.walk.yaw;
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 31, pointerType: 'mouse', buttons: 0, clientX: 100, clientY: 100 }));
    out.walkLookBlur = { hadLookDrag, drag: !!hy.walk._drag, yawUnchanged: hy.walk.yaw === yaw };
    app.hudActive = false;
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'w', code: 'KeyW' }));
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 32, pointerType: 'mouse', button: 0, buttons: 1, clientX: 20, clientY: 20 }));
    out.walkOnHome = { keys: hy.walk.keys.size, drag: !!hy.walk._drag };
    app.input.clearDesktop();
    app.hudActive = true;
    app.setQuality('low');
    app.setLargeUI(true);
    app.setComfort('turn', 'smooth');
    app.setComfort('vignette', false);
    out.saved = { quality: localStorage.getItem('4dvr.quality'), largeUI: localStorage.getItem('4dvr.largeui'), turn: localStorage.getItem('4dvr.turn'), vignette: localStorage.getItem('4dvr.vignette') };
    return out;
  });
  await page.reload({ waitUntil: 'networkidle0' });
  results.restored = await page.evaluate(() => ({ quality: __app.quality, largeUI: __app.largeUI, turn: __app.comfort.turn, vignette: __app.comfort.vignette }));
  await page.goto(`${BASE}?desktop&quality=high`, { waitUntil: 'networkidle0' });
  results.override = await page.evaluate(() => ({ quality: __app.quality, saved: localStorage.getItem('4dvr.quality') }));
  await page.evaluate(() => { localStorage.clear(); });
  const vr = await browser.newPage();
  vr.on('pageerror', (e) => errors.push(`XR: ${e.message}`));
  await vr.setViewport({ width: 1280, height: 800 });
  await vr.goto(`${BASE}?iwer=headless&desktop`, { waitUntil: 'networkidle0' });
  await vr.waitForFunction(() => window.__app?.sceneList.length === 8 && window.__xrDevice);
  await vr.evaluate(async () => {
    __xrDevice.position.set(0, 1.6, 0);
    __xrDevice.quaternion.set(-0.1736, 0, 0, 0.9848);
    await __app.enterVR();
  });
  await vr.waitForFunction(() => __app.guide.tut?.i === 0 && __app.input.xr.some((i) => i.active));
  const aimAtToy = () => vr.evaluate(() => {
    const app = __app;
    const V = app.camera.position.constructor;
    const target = new V();
    app.activeScene.toys.find((t) => t.enabled && t.obj.inSlice && t.obj.key === 'tesseract').pullPoint(target);
    const from = new V(0.15, 1.3, -0.1);
    const q = new (app.camera.quaternion.constructor)().setFromUnitVectors(new V(0, 0, -1), target.clone().sub(from).normalize());
    __xrDevice.controllers.right.position.set(from.x, from.y, from.z);
    __xrDevice.controllers.right.quaternion.set(q.x, q.y, q.z, q.w);
  });
  await aimAtToy();
  await new Promise((r) => setTimeout(r, 350));
  await vr.evaluate(() => __xrDevice.controllers.right.updateButtonValue('trigger', 1));
  await vr.waitForFunction(() => __app.input.xr.some((i) => i.grabbed));
  await vr.evaluate(() => __xrDevice.controllers.right.updateButtonValue('trigger', 0));
  await vr.waitForFunction(() => __app.guide.tut?.i === 1, { timeout: 20000 });
  await vr.evaluate(() => __xrDevice.controllers.left.updateAxes('thumbstick', 0, -1));
  await vr.waitForFunction(() => __app.guide.tut?.i === 2, { timeout: 20000 });
  results.tutorialHeldTransition = await vr.evaluate(() => ({ w: __app.activeScene.view.w, stillHeld: __app.input.xr.some((i) => i.stick.y < -0.5) }));
  await vr.evaluate(() => __xrDevice.controllers.left.updateAxes('thumbstick', 0, 0));
  await vr.waitForFunction(() => Math.abs(__app.activeScene.view.w) < 0.03, { timeout: 20000 });
  results.tutorialHeldTransition.afterRelease = await vr.evaluate(() => __app.activeScene.view.w);
  await aimAtToy();
  await new Promise((r) => setTimeout(r, 350));
  await vr.evaluate(() => {
    __xrDevice.controllers.right.updateButtonValue('trigger', 1);
    __xrDevice.controllers.right.updateButtonValue('squeeze', 1);
  });
  await vr.waitForFunction(() => __app.input.xr.some((i) => i.grabbed && i.grabMode === 'secondary'));
  // holding it still doesn't finish the step, turning it does
  await new Promise((r) => setTimeout(r, 800));
  results.tutorialTurnStill = await vr.evaluate(() => __app.guide.tut?.i);
  await vr.evaluate(() => { const p = __xrDevice.controllers.right.position; p.set(p.x + 0.1, p.y, p.z); });
  await vr.waitForFunction(() => __app.guide.tut?.i === 3, { timeout: 20000 });
  await vr.evaluate(() => {
    __xrDevice.controllers.right.updateButtonValue('trigger', 0);
    __xrDevice.controllers.right.updateButtonValue('squeeze', 0);
    __xrDevice.controllers.right.updateButtonValue('a-button', 1);
  });
  await vr.waitForFunction(() => __app.menu.shown);
  await vr.evaluate(() => __xrDevice.controllers.right.updateButtonValue('a-button', 0));
  await vr.waitForFunction(() => __app.guide.tut?.finished, { timeout: 20000 });
  await vr.evaluate(() => __app.menu.close());
  await vr.waitForFunction(() => __app.guide.panel.group.visible);
  results.fullControllerTutorial = await vr.evaluate(() => ({ finished: __app.guide.tut.finished, steps: __app.guide.tut.i, saved: localStorage.getItem('4dvr.tutorial'), card: __app.guide.panel.rows[0].text }));
  await vr.screenshot({ path: `${OUT}/tutorial-complete.png` });
  await vr.evaluate(() => __app.guide.startTutorial());
  results.xr = await vr.evaluate(async () => {
    const app = __app;
    app.renderer.setAnimationLoop(null);
    const out = { started: { presenting: app.presenting, mode: app.inputMode, guide: app.guide.mode } };
    const V = app.camera.position.constructor;
    const Q = app.camera.quaternion.constructor;
    const right = app.input.xr.find((i) => i.handedness === 'right');
    out.right = { kind: right.kind, source: !!right.source };
    const inputModule = await import('/src/core/input.js');
    const poses = await import('/src/core/handPoses.js');
    const fakeController = new inputModule.Interactor(10);
    fakeController.kind = 'controller'; fakeController.active = true;
    const buttons = Array.from({ length: 6 }, () => ({ value: 0, pressed: false }));
    fakeController.source = { gamepad: { buttons, axes: [0, 0, 0, 0] } };
    const spaces = { ctrl: app.input.spaces[0].ctrl, grip: app.input.spaces[0].grip };
    const readController = () => app.input._updateXR(fakeController, spaces, app.input.smoothers[0], 1 / 72, app.time += 1 / 72, app.headPosition);
    buttons[0].value = 0.61; readController();
    const triggerStarts = fakeController.pinch.pressed && fakeController.pinch.down;
    buttons[0].value = 0.4; readController();
    const triggerHysteresis = fakeController.pinch.pressed && !fakeController.pinch.down;
    buttons[1].value = 0.7; readController();
    const bothSecondary = !fakeController.pinch.pressed && fakeController.grip.pressed;
    buttons[0].value = 0; readController();
    const squeezePrimary = fakeController.pinch.pressed && !fakeController.grip.pressed;
    buttons[1].value = 0.34; readController();
    const fullRelease = !fakeController.pinch.pressed && !fakeController.grip.pressed;
    fakeController.source.gamepad.axes = [0, 0, 0.11, -0.8]; readController();
    const deadzone = fakeController.stick.x === 0 && fakeController.stick.y === -0.8;
    out.controllerButtons = { triggerStarts, triggerHysteresis, bothSecondary, squeezePrimary, fullRelease, deadzone };
    const fakeHand = new inputModule.Interactor(11);
    fakeHand.kind = 'hand'; fakeHand.active = true; fakeHand.source = { hand: {} }; fakeHand.handedness = 'right';
    const joints = Object.fromEntries(inputModule.JOINT_NAMES.map((name) => [name, { visible: true, matrixWorld: new (app.rig.matrixWorld.constructor)(), jointRadius: 0.008 }]));
    const handSpaces = { ...spaces, hand: { joints } };
    const points = inputModule.JOINT_NAMES.map(() => new V());
    const pose = (pinch) => {
      poses.blendPose(points, 'relaxed', 'pinch', pinch, 'right');
      inputModule.JOINT_NAMES.forEach((name, i) => joints[name].matrixWorld.makeTranslation(points[i].x + 0.2, points[i].y + 1.2, points[i].z - 0.2));
    };
    const readHand = (dt = 1 / 72) => app.input._updateXR(fakeHand, handSpaces, app.input.smoothers[0], dt, app.time += dt, app.headPosition);
    pose(1); readHand();
    const pinchStarts = fakeHand.pinch.pressed && fakeHand.pinch.down;
    pose(0); readHand(0.03);
    const briefReleaseHeld = fakeHand.pinch.pressed;
    readHand(0.05);
    const deliberateRelease = !fakeHand.pinch.pressed;
    pose(1); readHand();
    joints.wrist.visible = false; readHand(0.1);
    const briefTrackingGapHeld = fakeHand.pinch.pressed && !fakeHand.hasPoke;
    readHand(0.11);
    const longTrackingGapReleased = !fakeHand.pinch.pressed;
    joints.wrist.visible = true; readHand();
    const resumesValid = fakeHand.jointsValid && fakeHand.pinch.pressed;
    out.handTracking = { pinchStarts, briefReleaseHeld, deliberateRelease, briefTrackingGapHeld, longTrackingGapReleased, resumesValid };
    const originalScene = app.activeScene;
    const originalSources = app.input.xr.map((ix) => ({ active: ix.active, kind: ix.kind, handedness: ix.handedness }));
    const originalRig = app.rig.quaternion.clone();
    app.activeScene = { locomotion: true };
    out.singleController = {};
    for (const handedness of ['left', 'right']) {
      for (const ix of app.input.xr) { ix.active = ix.handedness === handedness; ix.stick.set(0, 0); }
      const only = app.input.xr.find((ix) => ix.active);
      only.stick.set(0, -0.8);
      app._updateTurn(1 / 72);
      out.singleController[handedness] = only.stick.y === -0.8;
    }
    for (let i = 0; i < app.input.xr.length; i++) { Object.assign(app.input.xr[i], originalSources[i]); app.input.xr[i].stick.set(0, 0); }
    right.stick.set(0.8, -0.8); app._snapArmed = true;
    app._updateTurn(1 / 72);
    out.singleController.twoControllerRightReservedForTurn = right.stick.x === 0 && right.stick.y === 0;
    app.activeScene = originalScene;
    app.rig.quaternion.copy(originalRig); app.rig.updateMatrixWorld(true);
    app.guide.stopTutorial();
    app.menu.open(); app.menu.setPage('scene'); app.menu.panel.opacity = 1; app.menu.panel.group.visible = true;
    app.menu.panel.group.updateMatrixWorld(true);
    const p = app.menu.panel;
    const w = p.widgets.find((w) => w.type === 'slider');
    const start = p.fromPanel(w.x + w.w * 0.5, w.y + w.h / 2, 0);
    right.rayOrigin.copy(app.headPosition).add(new V(0.1, -0.1, 0));
    right.rayDir.copy(start).sub(right.rayOrigin).normalize();
    right.pinch.set(true);
    const hit = app.ui.raycast(right);
    app.ui.beginCapture(right, hit, 'primary');
    out.sliderCapture = { type: right.uiCapture?.widget?.type, before: app.activeScene.view.w };
    app.menu.close();
    right.pinch.set(true);
    for (let i = 0; i < 60; i++) app.menu.update(1 / 72);
    const end = p.fromPanel(w.x + w.w * 0.9, w.y + w.h / 2, 0);
    right.rayDir.copy(end).sub(right.rayOrigin).normalize();
    app.interaction._update(right, app.activeScene, 1 / 72);
    out.hiddenCapture = { shown: app.menu.shown, visible: p.group.visible, captured: !!right.uiCapture, after: app.activeScene.view.w };
    app.interaction.release(right);
    const transient = app.activeScene.toys.find((t) => t.enabled && t.obj.inSlice);
    app.interaction._grab(right, transient, 'primary', 'near');
    app.input.spaces[right.index].ctrl.dispatchEvent({ type: 'disconnected' });
    out.controllerDisconnected = { active: right.active, held: !!right.grabbed, physicalHeld: transient.body.held, source: !!right.source };
    // One hand can open the menu without needing a second hand to tap it.
    const left = app.input.xr[0];
    for (const ix of app.input.xr) app.interaction.release(ix);
    left.kind = 'hand'; left.active = true; left.jointsValid = true; left.openness = 1; left.fist = false;
    left.pinchStrength = 0; left.palmFacingHead = 1;
    left.joints[0].pos.copy(app.headPosition).add(new V(0, -0.1, -0.3));
    left.joints[12].pos.copy(left.joints[0].pos).add(new V(0, 0.08, 0));
    left.palmPos.copy(left.joints[0].pos);
    app.menu.palm.ix = null; app.menu.palm.t = 0; app.menu.palm.shown = false;
    app.menu.palm.armed = true; app.menu.palm.seen = [-Infinity, -Infinity];
    app.menu.noHandsT = -1;
    for (let i = 0; i < 170; i++) { app.time += 1 / 72; app.menu.update(1 / 72); }
    out.oneHandMenu = { shown: app.menu.shown, palm: app.menu.palm.shown, armed: app.menu.palm.armed };
    app.menu.close();
    // The tracked hand and no-gamepad pointer paths both use the real InputSystem reader.
    const ix = app.input.xr[0], sp = app.input.spaces[0];
    sp.ctrl.dispatchEvent({ type: 'disconnected' });
    sp.ctrl.dispatchEvent({ type: 'connected', data: { handedness: 'none', targetRayMode: 'gaze' } });
    sp.ctrl.dispatchEvent({ type: 'selectstart' });
    app.input._updateXR(ix, sp, app.input.smoothers[0], 1 / 72, app.time += 1 / 72, app.headPosition);
    out.pointerSelect = { kind: ix.kind, pressed: ix.pinch.pressed, grip: ix.grip.pressed };
    sp.ctrl.dispatchEvent({ type: 'selectend' });
    app.input._updateXR(ix, sp, app.input.smoothers[0], 1 / 72, app.time += 1 / 72, app.headPosition);
    out.pointerRelease = { pressed: ix.pinch.pressed };
    // Remove the other controller, mirroring headsets with only a gaze or look/pinch input.
    for (const s of app.input.spaces) s.ctrl.dispatchEvent({ type: 'disconnected' });
    sp.ctrl.dispatchEvent({ type: 'connected', data: { handedness: 'none', targetRayMode: 'gaze' } });
    app.guide.startTutorial();
    for (let i = 0; i < 140; i++) app.menu.update(1 / 72);
    out.pointerInstructions = { mode: app.inputMode, guide: app.guide.mode, first: app.guide.panel.rows.find((r) => r.type === 'text').text, tutorial: !!app.guide.tut, menuButton: app.menu.button.group.visible };
    out.pointerLayout = app.guide.panel.widgets.filter((w) => w.type === 'text').every((w) => app.guide.panel._wrap(w.row, w.w).length <= w.lines);
    app.menu.rebuild();
    out.pointerMenuLayout = app.menu.panel.widgets.filter((w) => w.type === 'text').every((w) => app.menu.panel._wrap(w.row, w.w).length <= w.lines);
    await app.renderer.xr.getSession().end();
    out.afterEnd = { presenting: app.presenting, rig: app.rig.position.toArray(), guide: app.guide.mode, menu: app.menu.shown, held: app.input.xr.some((i) => i.grabbed || i.uiCapture || i.emptyGrab) };
    return out;
  });
  await vr.evaluate(async () => {
    __app.renderer.setAnimationLoop((t, frame) => __app._frame(t, frame));
    await __app.enterVR();
  });
  await vr.waitForFunction(() => __app.presenting && __app.input.xr.some((i) => i.active && i.kind === 'controller'));
  results.reentry = await vr.evaluate(() => ({ presenting: __app.presenting, mode: __app.inputMode, active: __app.input.xr.filter((i) => i.active).length }));
  await vr.evaluate(async () => { await __app.renderer.xr.getSession().end(); });
  await vr.screenshot({ path: `${OUT}/after-session.png` });
} catch (e) {
  errors.push(e.stack || String(e));
} finally {
  results.errors = errors;
  results.checks = {
    'mouse grab ends on blur even without pointerup': results.desktop?.beforeBlur.grabbed && !results.desktop?.afterBlurAndReleasedMove.pinch && !results.desktop?.afterBlurAndReleasedMove.grabbed,
    'released mouse movement clears missed pointerup': !results.desktop?.releasedMove.pinch && !results.desktop?.releasedMove.grabbed,
    'lost pen capture clears action': !results.desktop?.penCaptureLost.pinch && !results.desktop?.penCaptureLost.grabbed,
    'tracking return cannot press UI until a new fingertip movement': results.desktop?.pokeTrackingGap.forgottenDepth && results.desktop?.pokeTrackingGap.unchangedOnReturn && results.desktop?.pokeTrackingGap.pressAfterReturn,
    'touch blur clears all tracked touches': results.desktop?.touchBlur.touches === 0 && !results.desktop?.touchBlur.pinch,
    'touch cancel restores orbit': results.desktop?.touchCancelled.touches === 0 && results.desktop?.touchCancelled.orbit,
    'one and two finger controls select their intended modes': results.desktop?.oneTouch.pinch && !results.desktop?.oneTouch.grip && !results.desktop?.twoTouch.pinch && results.desktop?.twoTouch.grip,
    'keyboard movement stops on blur': results.desktop?.walkBlur.before === results.desktop?.walkBlur.after,
    'look drag stops on blur': results.desktop?.walkLookBlur.hadLookDrag && !results.desktop?.walkLookBlur.drag && results.desktop?.walkLookBlur.yawUnchanged,
    'start screen does not collect walking inputs': results.desktop?.walkOnHome.keys === 0 && !results.desktop?.walkOnHome.drag,
    'preferences survive reload': results.restored?.quality === 'low' && results.restored?.largeUI && results.restored?.turn === 'smooth' && results.restored?.vignette === false,
    'quality URL override preserves saved choice': results.override?.quality === 'high' && results.override?.saved === 'low',
    'closing XR menu cancels invisible slider capture': results.xr?.sliderCapture.type === 'slider' && !results.xr?.hiddenCapture.captured && results.xr?.hiddenCapture.after === results.xr?.sliderCapture.before,
    'controller thresholds, primary/secondary buttons and stick deadzone': Object.values(results.xr?.controllerButtons || {}).length === 6 && Object.values(results.xr?.controllerButtons || {}).every(Boolean),
    'tracked hand release debounce and tracking-loss grace': Object.values(results.xr?.handTracking || {}).length === 6 && Object.values(results.xr?.handTracking || {}).every(Boolean),
    'sole controller movement axis works with either hand': Object.values(results.xr?.singleController || {}).length === 3 && Object.values(results.xr?.singleController || {}).every(Boolean),
    'controller disconnect drops its object and tracking state': results.xr?.controllerDisconnected.active === false && !results.xr?.controllerDisconnected.held && !results.xr?.controllerDisconnected.physicalHeld && !results.xr?.controllerDisconnected.source,
    'one-hand palm dwell opens menu': results.xr?.oneHandMenu.shown && results.xr?.oneHandMenu.palm && !results.xr?.oneHandMenu.armed,
    'pointer select and release': results.xr?.pointerSelect.pressed && !results.xr?.pointerRelease.pressed,
    'pointer controls avoid impossible tracked-hand tutorial': results.xr?.pointerInstructions.mode === 'pointers' && results.xr?.pointerInstructions.guide === 'controls' && !results.xr?.pointerInstructions.tutorial && results.xr?.pointerInstructions.menuButton,
    'pointer cards and menu text fit': results.xr?.pointerLayout && results.xr?.pointerMenuLayout,
    'session ends with no held interactions': results.xr?.afterEnd.presenting === false && !results.xr?.afterEnd.held && results.xr?.afterEnd.guide === null,
    'XR session can start again with both controllers': results.reentry?.presenting && results.reentry?.mode === 'controllers' && results.reentry?.active === 2,
    'tutorial turn step needs the object to turn': results.tutorialTurnStill === 2,
    'all four controller tutorial steps complete through real XR input': results.fullControllerTutorial?.finished && results.fullControllerTutorial?.steps === 4 && results.fullControllerTutorial?.saved === '1' && results.fullControllerTutorial?.card === 'Tutorial done',
    'tutorial restores visible objects after held slice-stick release': results.tutorialHeldTransition?.stillHeld && Math.abs(results.tutorialHeldTransition.w) > 0.1 && Math.abs(results.tutorialHeldTransition.afterRelease) < 0.03,
    'no runtime errors': errors.length === 0,
  };
  fs.writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  await browser.close();
  if (Object.values(results.checks).some((passed) => !passed)) process.exitCode = 1;
}
