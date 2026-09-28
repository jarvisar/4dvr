// Headless smoke test used by CI and `npm run test:smoke`.
//
// 1. serves the production build with `vite preview`
// 2. opens every scene in headless Chrome (SwiftShader WebGL) and fails on
//    uncaught errors or shader/WebGL errors
// 3. runs tools/interaction-test.js, which drives fake tracked hands through
//    the real interaction code, and checks the outcomes
// 4. clicks, drags and scrolls the menu on a flat screen with the mouse
// 5. enters a real WebXR session on an emulated Quest 3 (IWER, `?iwer=headless`)
//    and checks the tutorial, controller ray, menus, the palm button and the menu's grab bar
// Screenshots land in smoke-artifacts/ (uploaded by the CI workflow).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import puppeteer from 'puppeteer-core';

const PORT = 4321;
const BASE = `http://localhost:${PORT}/`;
const OUT = 'smoke-artifacts';
const SCENES = ['playground', 'gallery', 'knots', 'hopf', 'hyperbolic', 'spherical', 'klein', 'quasicrystal'];

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = {
    win32: ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'],
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
    linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
  }[process.platform] || [];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('Chrome not found, set CHROME_PATH');
  return found;
}

async function waitForServer(url, timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Server at ${url} did not start`);
}

// Console messages that are expected in a headless browser without a GPU.
const IGNORED = [/favicon/i, /GPU stall due to ReadPixels/i, /Automatic fallback to software WebGL/i, /WebXR/i];

const failures = [];
const fail = (msg) => { failures.push(msg); console.error(`  ✗ ${msg}`); };
const pass = (msg) => console.log(`  ✓ ${msg}`);

fs.mkdirSync(OUT, { recursive: true });
const vite = path.join('node_modules', 'vite', 'bin', 'vite.js');
const server = spawn(process.execPath, [vite, 'preview', '--port', String(PORT), '--strictPort'], {
  env: { ...process.env, NO_SSL: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(d));

let browser;
try {
  await waitForServer(BASE);
  browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: 'new',
    args: ['--no-sandbox', '--ignore-certificate-errors', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,800'],
  });

  for (const scene of SCENES) {
    console.log(`scene: ${scene}`);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const problems = [];
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const text = m.text();
      if (!IGNORED.some((re) => re.test(text))) problems.push(`console.error: ${text}`);
    });
    await page.goto(`${BASE}?desktop&scene=${scene}`, { waitUntil: 'networkidle0', timeout: 60000 });
    await new Promise((r) => setTimeout(r, 3500));
    const state = await page.evaluate(() => ({ scene: window.__app?.sceneKey, frames: window.__app?.frameCount || 0 }));
    await page.screenshot({ path: path.join(OUT, `${scene}.png`) });
    if (state.scene !== scene) fail(`${scene}: active scene is ${state.scene}`);
    else if (state.frames < 5) fail(`${scene}: only rendered ${state.frames} frames`);
    else pass(`${scene}: rendered ${state.frames} frames`);
    for (const p of problems) fail(`${scene}: ${p}`);
    await page.close();
  }

  console.log('interactions');
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on('pageerror', (e) => fail(`interaction pageerror: ${e.message}`));
  await page.goto(`${BASE}?desktop`, { waitUntil: 'networkidle0', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 3000));
  const r = await page.evaluate(fs.readFileSync('tools/interaction-test.js', 'utf8'));
  await page.screenshot({ path: path.join(OUT, 'interactions.png') });
  fs.writeFileSync(path.join(OUT, 'interactions.json'), JSON.stringify(r, null, 2));
  const checks = [
    ['no exceptions', r.errors.length === 0, r.errors.join('\n')],
    ['pinch grabs a toy', r.grabbedToy],
    ['held toy follows the hand', r.carriedUp > 0.08, r.carriedUp],
    ['held toy is carried through W with the slice', Math.abs(r.carriedThroughW - 0.2) < 0.02, r.carriedThroughW],
    ['release restores dynamics', r.released],
    ['middle-pinch rotates through 4D', r.rotated4D?.changed > 0.5, JSON.stringify(r.rotated4D)],
    ['air pinch scrubs W', r.wScrub > 0.1, r.wScrub],
    ['a tiny air-pinch wobble leaves W alone', r.airDeadzone === 0, r.airDeadzone],
    ['a toy can be grabbed from 4.5 cm off its surface', r.grabAt45mm],
    ['a pinch with the palm towards the face is ignored', r.palmFacingIgnored],
    ['closing the whole hand around a toy grabs it', r.fistGrab],
    ['a fist in empty space does nothing', r.fistInEmptySpace],
    ['a pinch that just missed a toy leaves the slice alone', r.nearMiss && !r.nearMiss.grabbed && !r.nearMiss.emptyGrab && r.nearMiss.w === 0, JSON.stringify(r.nearMiss)],
    ['controllers: either button carries, both turn through 4D, without dropping it', r.controllerModes && Object.values(r.controllerModes).every(Boolean), JSON.stringify(r.controllerModes)],
    ['a hand pulls a toy from out of reach', r.pull?.hover && r.pull.pulled && r.pull.endDist < 0.2, JSON.stringify(r.pull)],
    ['but not with the arm held in close', r.pullNeedsReach],
    ['the bar under a VR panel moves it', r.handle?.near && Math.abs(r.handle.moved - 0.1) < 0.001, JSON.stringify(r.handle)],
    ['closed hand detection', r.fist && !r.fist.pointing && r.fist.closed && r.fist.openingHeld && !r.fist.openHeld, JSON.stringify(r.fist)],
    ['tutorial steps fit their card', r.tutorialLines?.flat().every((n) => n <= 5), JSON.stringify(r.tutorialLines)],
    ['the tutorial hand has targets', r.demoTargets?.every(Boolean), JSON.stringify(r.demoTargets)],
    ['fingertip poke presses a menu button', r.pokedTower],
    ['the poke cursor tracks the fingertip on the panel', r.pokeCursor],
    ['a panel appearing under a fingertip is not pressed', r.appearUnderFinger === 'tower', r.appearUnderFinger],
    ['pressing through it afterwards works', r.pressAfterAppear === 'balls', r.pressAfterAppear],
    ['every scene tip fits the menu in both input modes', r.hintLines && Object.values(r.hintLines).every((n) => n <= 5), JSON.stringify(Object.entries(r.hintLines || {}).filter(([, n]) => n > 5))],
    ['index pinch', r.pinchKinds?.index.pinch && !r.pinchKinds.index.grip, JSON.stringify(r.pinchKinds)],
    ['middle pinch with the index resting near the thumb', r.pinchKinds?.middleWithIndexNear.grip && !r.pinchKinds.middleWithIndexNear.pinch, JSON.stringify(r.pinchKinds)],
    ['a held middle pinch survives the index brushing the thumb', r.pinchKinds?.middleHeldIndexBrushes.grip && !r.pinchKinds.middleHeldIndexBrushes.pinch, JSON.stringify(r.pinchKinds)],
    ['thumb touching both fingers is an index pinch', r.pinchKinds?.bothTouching.pinch && !r.pinchKinds.bothTouching.grip, JSON.stringify(r.pinchKinds)],
    ['opening past 3 cm releases', !r.pinchKinds?.released.pinch && !r.pinchKinds?.released.grip, JSON.stringify(r.pinchKinds)],
    ['glass walls stop a held ball', r.boxBlocksDrag < 0.1, r.boxBlocksDrag],
    ['sealed-box puzzle solvable through W', r.boxSolved],
    ['polytope turns in 4D', r.galleryRotated > 0.5, r.galleryRotated],
    ['air pinch moves the slicing hyperplane', Math.abs(r.gallerySliceW) > 0.3, r.gallerySliceW],
    ['touching the globe paints fibers', r.hopfPainted > 5, r.hopfPainted],
    ['pinch-twist turns the globe', r.globeTurned > 0.5, r.globeTurned],
    ['trefoil is detected as knotted', r.knots?.trefoilMinCrossings >= 3, r.knots?.trefoilMinCrossings],
    ['middle-pinch lifts a strand into W', r.knots?.liftedW > 0.05, r.knots?.liftedW],
    ['flatten returns the rope to our slice', r.knots?.wAfterFlatten < 0.006, r.knots?.wAfterFlatten],
    ['a plain loop has no crossings', r.knots?.circleCrossings === 0, r.knots?.circleCrossings],
    ['hyperbolic re-centering keeps the head in the central cell', r.hyperbolic?.headDistFromOrigin < 1.5, r.hyperbolic?.headDistFromOrigin],
    ['hyperbolic distance traveled is preserved', Math.abs(r.hyperbolic?.homeDistance - 6) < 0.01, r.hyperbolic?.homeDistance],
    ['head pose stays on the hyperboloid', Math.abs(r.hyperbolic?.lorentzCheck + 1) < 1e-3, r.hyperbolic?.lorentzCheck],
    ['S³: walking π reaches the antipode', Math.abs(r.spherical?.antipode - Math.PI) < 1e-3, r.spherical?.antipode],
    ['S³: walking 2π comes back to the start', r.spherical?.around < 1e-3, r.spherical?.around],
    ['S³: head pose stays orthogonal', r.spherical?.orth < 1e-9, r.spherical?.orth],
    ['no 4D shadow from outside the slice when the sun is level', r.shadows?.offSliceStraight === 0, JSON.stringify(r.shadows)],
    ['a tilted 4D sun casts it into the slice', r.shadows?.offSliceTilted > 200, JSON.stringify(r.shadows)],
    ['objects in the slice cast shadows', r.shadows?.inSlice > 200, JSON.stringify(r.shadows)],
    ['opposite cells of the d8 add up to 9', r.dice?.pairsOk, JSON.stringify(r.dice)],
    ['dice come to rest with a result', r.dice?.results.filter((x, i) => x >= 1 && x <= r.dice.sizes[i]).length >= 5, JSON.stringify(r.dice)],
    ['mirror puzzle is solved by the mirror pose only', r.mirror && !r.mirror.before && r.mirror.atTarget && !r.mirror.unmirrored, JSON.stringify(r.mirror)],
    ['4D gravity: nudged moons fall in or escape', r.orbits?.g4.fell === 2 && r.orbits?.g4.escaped === 2, JSON.stringify(r.orbits)],
    ['3D gravity: the same nudges stay in orbit', r.orbits?.g3.orbiting === 4, JSON.stringify(r.orbits)],
    ['worldline: one ball per path in a slice of constant w', r.worldline?.straightBalls === 5, JSON.stringify(r.worldline)],
    ['worldline: disks in a tilted slice', r.worldline?.tiltedDisks > 20 && r.worldline?.tiltedBalls === 0, JSON.stringify(r.worldline)],
    ['worldline: records the mouse for 4 s', r.worldline?.recorded === 1 && r.worldline?.samples > 250, JSON.stringify(r.worldline)],
    ['Penrose floor: every inner edge is shared by two rhombs', r.quasi?.floor.bad === 0 && r.quasi?.floor.checked > 400, JSON.stringify(r.quasi)],
    ['Penrose floor: both rhombs, thick more often by φ', Math.abs(r.quasi?.floor.ratio - 1.618) < 0.12, JSON.stringify(r.quasi)],
    ['moving the slice flips tiles', r.quasi?.flips > 0 && r.quasi?.after.bad === 0, JSON.stringify(r.quasi)],
    ['Klein Room: crossing a pink wall mirrors you, crossing it back undoes it', r.klein?.afterPink && !r.klein?.afterBack && r.klein?.crossings === 2, JSON.stringify(r.klein)],
    ['Klein Room: crossing a cyan wall does not', !r.klein?.afterCyan && r.klein?.inside, JSON.stringify(r.klein)],
    ['3D quasicrystal: every inner face is shared by two rhombohedra', r.quasi?.crystal.bad === 0 && r.quasi?.crystal.checked > 80, JSON.stringify(r.quasi)],
  ];
  for (const [name, ok, detail] of checks) (ok ? pass(name) : fail(`${name} (${detail})`));
  await page.close();

  // On a flat screen the menu is the VR panel's canvas shown in the page. 640
  // px tall so the Hyperplay page has to scroll.
  console.log('desktop menu');
  const dm = await browser.newPage();
  await dm.setViewport({ width: 1280, height: 640 });
  dm.on('pageerror', (e) => fail(`desktop menu pageerror: ${e.message}`));
  await dm.goto(`${BASE}?desktop`, { waitUntil: 'networkidle0', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 3000));
  // page coordinates of the center of a menu widget, found by its label
  const menuAt = (label) => dm.evaluate((label) => {
    const p = window.__app.menu.panel, r = p.canvas.getBoundingClientRect();
    const text = (w) => (w.item ? (typeof w.item.label === 'function' ? w.item.label() : w.item.label) : w.row.label);
    const w = p.widgets.find((w) => text(w) === label);
    return w && [r.left + ((w.x + w.w / 2) / p.width) * r.width, r.top + ((w.y + w.h / 2) / p.height) * r.height];
  }, label);
  const inPage = await dm.evaluate(() => ({ dom: __app.menu.panel.dom, in3D: __app.menu.panel.group.visible, shown: !document.querySelector('.hud-panel').hidden }));
  let [mx, my] = await menuAt('Tower');
  await dm.mouse.click(mx, my);
  await new Promise((r) => setTimeout(r, 300));
  const clicked = await dm.evaluate(() => __app.activeScene.preset);
  const [kx, ky] = await menuAt('Slice position (w)');
  await dm.mouse.move(kx, ky + 6);
  await dm.mouse.down();
  await dm.mouse.move(kx + 60, ky + 6, { steps: 6 });
  await dm.mouse.up();
  await new Promise((r) => setTimeout(r, 300));
  const dragged = await dm.evaluate(() => __app.activeScene.view.w);
  await dm.evaluate(() => __app.activeScene.setW(0));
  await dm.mouse.move(mx, my);
  await dm.mouse.wheel({ deltaY: 300 });
  await new Promise((r) => setTimeout(r, 500));
  const wheeled = await dm.evaluate(() => ({ scrollTop: document.querySelector('.hud-panel').scrollTop, w: __app.activeScene.view.w }));
  await dm.evaluate(() => { document.querySelector('.hud-panel').scrollTop = 0; });
  [mx, my] = await menuAt('Close');
  await dm.mouse.click(mx, my);
  await new Promise((r) => setTimeout(r, 300));
  const closedMenu = await dm.evaluate(() => ({ open: __app.desktopMenu, shown: !document.querySelector('.hud-panel').hidden }));
  await dm.screenshot({ path: path.join(OUT, 'desktop-menu.png') });
  await dm.close();
  const menuChecks = [
    ['the menu is drawn in the page, not in 3D', inPage.dom && !inPage.in3D && inPage.shown, JSON.stringify(inPage)],
    ['clicking a button in it works', clicked === 'tower', clicked],
    ['dragging its slider moves the slice', dragged > 0.05, dragged],
    ['the wheel over it scrolls it and leaves the slice alone', wheeled.scrollTop > 0 && wheeled.w === 0, JSON.stringify(wheeled)],
    ['its close button closes it', !closedMenu.open && !closedMenu.shown, JSON.stringify(closedMenu)],
  ];
  for (const [name, ok, detail] of menuChecks) (ok ? pass(name) : fail(`${name} (${detail})`));

  // A real WebXR session on an emulated Quest 3 (IWER), rendered as one view.
  console.log('vr (IWER emulator)');
  const vr = await browser.newPage();
  await vr.setViewport({ width: 1000, height: 900 });
  await vr.emulateCPUThrottling(6);
  vr.on('pageerror', (e) => fail(`vr pageerror: ${e.message}`));
  // from desktop mode, so the menu goes from the page into the headset
  await vr.goto(`${BASE}?iwer=headless&desktop`, { waitUntil: 'networkidle0', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2500));
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const ev = (js) => vr.evaluate(js);
  // Frame dt is capped, so app time runs slower than wall time on the CI
  // renderer. Wait for things that take app time instead of sleeping.
  const waitFor = async (js, ms = 15000) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(100)) if (await ev(js)) return;
  };
  await ev(`(async () => {
    __xrDevice.position.set(0, 1.6, 0);
    __xrDevice.quaternion.set(-0.1736, 0, 0, 0.9848); // looking 20° down
    await __app.enterVR();
  })()`);
  await sleep(2000);
  // First time in VR: the tutorial starts in Hyperplay, with labels on the controllers
  const started = await ev(`({ presenting: __app.presenting, mode: __app.inputMode, guide: __app.guide.mode, step: __app.guide.tut?.i, card: __app.guide.panel.group.visible, tags: __app.hands.tags.filter((t) => t.mesh.visible).length, menuInPage: __app.menu.panel.dom, menuPx: __app.menu.panel.px })`);
  await vr.screenshot({ path: path.join(OUT, 'vr-tutorial.png') });
  // Point a controller or tracked hand (its target ray) from `from` at a world point
  const aim = (device, target, from = '[0.15, 1.3, -0.1]') => ev(`(() => {
    const t = ${target}, f = ${from};
    const c = __xrDevice.${device}, o = new (t.constructor)(f[0], f[1], f[2]);
    c.position.set(o.x, o.y, o.z);
    const q = new (__app.camera.quaternion.constructor)().setFromUnitVectors(new (t.constructor)(0, 0, -1), t.clone().sub(o).normalize());
    c.quaternion.set(q.x, q.y, q.z, q.w);
  })()`);
  const press = async (button) => {
    await ev(`__xrDevice.controllers.right.updateButtonValue('${button}', 1)`); await sleep(300);
    await ev(`__xrDevice.controllers.right.updateButtonValue('${button}', 0)`); await sleep(300);
  };
  // Step 1: grab something. Point at the big tesseract and pull the trigger.
  await aim('controllers.right', `(() => { const pg = __app.activeScene, t = pg.toys.find((x) => x.enabled && x.obj.inSlice && x.obj.key === 'tesseract'); const p = new (__app.headPosition.constructor)(); t.pullPoint(p); return p; })()`);
  await sleep(300);
  await ev(`__xrDevice.controllers.right.updateButtonValue('trigger', 1)`); await sleep(400);
  const grabbedByRay = await ev(`!!__app.input.xr.find((i) => i.handedness === 'right')?.grabbed`);
  await ev(`__xrDevice.controllers.right.updateButtonValue('trigger', 0)`);
  await waitFor(`__app.guide.tut?.i === 1`);
  const afterGrab = await ev(`({ step: __app.guide.tut?.i, guide: __app.guide.mode })`);
  // Skip the rest with the card's Skip button
  await aim('controllers.right', `(() => { const p = __app.guide.panel, btn = p.widgets.find((w) => w.type === 'button'); return p.fromPanel(btn.x + btn.w / 2, btn.y + btn.h / 2, 0); })()`);
  await sleep(400);
  await press('trigger');
  const skipped = await ev(`({ guide: __app.guide.mode, card: __app.guide.panel.group.visible, done: localStorage.getItem('4dvr.tutorial') })`);

  const menus = {};
  for (const scene of SCENES) {
    await ev(`__app.menu.shown = false; __app.setScene('${scene}', true);`);
    await sleep(500);
    // the first visit to each scene shows its tips (Hyperplay's were in the tutorial)
    const tips = await ev(`__app.guide.mode === 'tips' && __app.guide.panel.group.visible`);
    if (tips) await vr.screenshot({ path: path.join(OUT, `vr-tips-${scene}.png`) });
    await ev(`__app.guide.hide()`);
    await ev(`__xrDevice.controllers.right.updateButtonValue('a-button', 1)`); await sleep(250);
    await ev(`__xrDevice.controllers.right.updateButtonValue('a-button', 0)`); await sleep(900);
    menus[scene] = await ev(`(() => {
      const p = __app.menu.panel;
      const texts = p.widgets.filter((w) => w.type === 'text');
      return { shown: __app.menu.shown, height: +p.height.toFixed(3), truncated: texts.filter((w) => p._wrap(w.row, w.w).length > w.lines).length };
    })()`);
    menus[scene].tips = tips;
    await vr.screenshot({ path: path.join(OUT, `vr-menu-${scene}.png`) });
  }
  // the settings page fits too
  await ev(`__app.menu.setPage('settings')`); await sleep(300);
  const settings = await ev(`(() => { const p = __app.menu.panel; return { height: +p.height.toFixed(3), truncated: p.widgets.filter((w) => w.type === 'text' && p._wrap(w.row, w.w).length > w.lines).length }; })()`);
  await vr.screenshot({ path: path.join(OUT, 'vr-menu-settings.png') });
  await ev(`__app.menu.setPage('scene'); __app.menu.shown = false;`);

  // A new scene should open in front of the person wherever they've walked and
  // turned to. Stand 1 m to the side facing +x, then switch scenes.
  const headPose = (js) => ev(`(() => { ${js} })()`);
  const headNow = `(() => { const f = new (__app.headPosition.constructor)(0, 0, -1).applyQuaternion(__app.headQuaternion); const p = __app.headPosition; return { x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3), fx: +f.x.toFixed(3), fz: +f.z.toFixed(3) }; })()`;
  await headPose(`__xrDevice.position.set(0.8, 1.6, 0.5); __xrDevice.quaternion.set(0, -0.7071, 0, 0.7071);`);
  await sleep(300);
  await ev(`__app.setScene('hyperbolic', true)`);
  await sleep(300);
  const recentred = await ev(headNow);
  // The right stick snap-turns 30° about the head. The left stick moves (and closes the vignette).
  await ev(`__xrDevice.controllers.right.updateAxes('thumbstick', 1, 0)`); await sleep(250);
  await ev(`__xrDevice.controllers.right.updateAxes('thumbstick', 0, 0)`); await sleep(250);
  const turned = await ev(headNow);
  await ev(`__xrDevice.controllers.left.updateAxes('thumbstick', 0, -1)`); await sleep(400);
  const vignetteMoving = await ev(`__app._vignette.level`);
  await ev(`__xrDevice.controllers.left.updateAxes('thumbstick', 0, 0)`);
  // dt is capped per frame, so on a slow CI renderer the vignette opens slower than
  // wall time. Poll for it instead of sleeping a fixed amount.
  let vignetteStill = 1;
  for (const t0 = Date.now(); Date.now() - t0 < 8000; await sleep(100)) {
    vignetteStill = await ev(`__app._vignette.level`);
    if (vignetteStill < 0.05) break;
  }
  await headPose(`__xrDevice.position.set(0, 1.6, 0); __xrDevice.quaternion.set(-0.1736, 0, 0, 0.9848);`);
  await sleep(300);

  // Switch to tracked hands and turn the left palm towards the face. That only
  // shows the small Menu button next to it, not the menu.
  await ev(`__app.setScene('playground', true); __app.menu.shown = false; __xrDevice.primaryInputMode = 'hand';`);
  await sleep(600);
  const tipsOnReturn = await ev(`__app.guide.panel.group.visible`);
  await ev(`(() => { const L = __xrDevice.hands.left; L.position.set(-0.04, 1.2, -0.28); L.quaternion.set(1, 0, 0, 0); })()`);
  await waitFor(`__app.menu.palm.shown && __app.menu.button.opacity > 0.9`);
  const palm = await ev(`({ button: __app.menu.palm.shown && __app.menu.button.group.visible, menu: __app.menu.shown, mode: __app.inputMode })`);
  await vr.screenshot({ path: path.join(OUT, 'vr-palm-button.png') });

  // Move the right index fingertip to a point on a panel (panel coordinates, z in front of it)
  const pokeTo = (panel, x, y, z) => ev(`(() => {
    const R = __xrDevice.hands.right, ix = __app.input.xr.find((i) => i.handedness === 'right');
    const p = ${panel}, tip = ix.joints[9].pos;
    const target = p.fromPanel(${x}, ${y}, ${z});
    R.position.set(R.position.x + target.x - tip.x, R.position.y + target.y - tip.y, R.position.z + target.z - tip.z);
  })()`);
  const btnCenter = (panel, label) => ev(`(() => { const p = ${panel}; const w = p.widgets.find((w) => w.item && (typeof w.item.label === 'function' ? w.item.label() : w.item.label) === '${label}'); return [w.x + w.w / 2, w.y + w.h / 2]; })()`);
  // Bring the right index fingertip 3 cm in front of the Menu button, then move
  // the left hand a little. The button should hold still for the finger.
  const buttonPos = `__app.menu.button.group.position.toArray().map((v) => +v.toFixed(4))`;
  const [bx, by] = await btnCenter('__app.menu.button', 'Menu');
  await pokeTo('__app.menu.button', bx, by, 0.03); await sleep(400);
  const button0 = await ev(buttonPos);
  await ev(`__xrDevice.hands.left.position.set(-0.08, 1.21, -0.28)`); await sleep(400);
  const button1 = await ev(buttonPos);
  // and tap it
  await pokeTo('__app.menu.button', bx, by, -0.004); await sleep(400);
  const opened = await ev(`(() => {
    const g = __app.menu.panel.group, h = __app.headPosition;
    const p = __app.menu.panel, d = Math.hypot(g.position.x - h.x, g.position.z - h.z);
    // how far below eye level the middle of the menu is, in degrees
    const below = Math.atan2(h.y - (g.position.y - p.height * g.scale.y / 2), d) * 180 / Math.PI;
    return { shown: __app.menu.shown, label: __app.menu.button.widgets[0].item.label(), dist: +d.toFixed(3), centerBelowEyes: Math.round(below), height: +p.height.toFixed(3) };
  })()`);
  await pokeTo('__app.menu.button', bx, by, 0.08); await sleep(300);
  await ev(`__xrDevice.hands.right.position.set(0.45, 0.9, -0.1)`); await sleep(500);
  await vr.screenshot({ path: path.join(OUT, 'vr-hand-menu.png') });

  // The menu stays where it opened when the hand that opened it drops
  const menuPos = `__app.menu.panel.group.position.toArray().map((v) => +v.toFixed(4))`;
  const pos0 = await ev(menuPos);
  await ev(`(() => { const L = __xrDevice.hands.left; L.position.set(-0.3, 0.9, -0.1); L.quaternion.set(0, 0, 0, 1); })()`);
  await sleep(700);
  await waitFor(`!__app.menu.palm.shown`);
  const afterDrop = await ev(`({ pos: ${menuPos}, shown: __app.menu.shown, button: __app.menu.palm.shown })`);

  // Poke the "Scenes" page button with the right index fingertip. The page should
  // change and the menu's top row should stay where it was.
  const [sx, sy] = await btnCenter('__app.menu.panel', 'Scenes');
  await pokeTo('__app.menu.panel', sx, sy, 0.03); await sleep(400);
  await pokeTo('__app.menu.panel', sx, sy, -0.004); await sleep(400);
  await pokeTo('__app.menu.panel', sx, sy, 0.05); await sleep(400);
  const paged = await ev(`({ page: __app.menu.page, pos: ${menuPos}, sceneButtons: __app.menu.panel.widgets.filter((w) => w.type === 'tab').length })`);
  await vr.screenshot({ path: path.join(OUT, 'vr-hand-menu-scenes.png') });

  // Point the right hand's ray at the bar under the menu, pinch, and move the hand 15 cm to the right
  await aim('hands.right', `__app.menu.handle.mesh.getWorldPosition(new (__app.headPosition.constructor)())`, '[0.2, 1.1, 0]');
  await sleep(500);
  const handleHover = await ev(`__app.menu.handle.hovers > 0`);
  await ev(`__xrDevice.hands.right.updatePinchValue(1)`); await sleep(500);
  const handleGrabbed = await ev(`__app.menu.handle.grabbedBy?.handedness || null`);
  const moveFrom = await ev(menuPos);
  await ev(`(() => { const R = __xrDevice.hands.right; R.position.set(R.position.x + 0.15, R.position.y, R.position.z); })()`);
  await sleep(700);
  await ev(`__xrDevice.hands.right.updatePinchValue(0)`); await sleep(500);
  const moveTo = await ev(menuPos);
  await vr.screenshot({ path: path.join(OUT, 'vr-menu-moved.png') });

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const turnDeg = Math.round((Math.atan2(-turned.fx, -turned.fz) - Math.atan2(-recentred.fx, -recentred.fz)) * 180 / Math.PI);
  const vrChecks = [
    ['enters an immersive session', started.presenting, JSON.stringify(started)],
    ['the menu leaves the page and is drawn at full resolution', !started.menuInPage && started.menuPx === 2000, JSON.stringify(started)],
    ['the tutorial starts the first time, with labels on the controllers', started.guide === 'tutorial' && started.step === 0 && started.card && started.tags > 0, JSON.stringify(started)],
    ['a controller ray grabs a toy', grabbedByRay],
    ['grabbing and letting go finishes the first step', afterGrab.step === 1, JSON.stringify(afterGrab)],
    ['the controller ray presses Skip tutorial, and it stays done', skipped.guide === null && !skipped.card && skipped.done === '1', JSON.stringify(skipped)],
    ['A button opens the menu in every scene', Object.values(menus).every((m) => m.shown), JSON.stringify(menus)],
    ['menu text is never cut off', Object.values(menus).every((m) => m.truncated === 0) && settings.truncated === 0, JSON.stringify({ menus, settings })],
    ['each new scene shows its tips once', SCENES.slice(1).every((s) => menus[s].tips) && !menus.playground.tips && !tipsOnReturn, JSON.stringify({ menus, tipsOnReturn })],
    ['a new scene opens in front of the person', Math.abs(recentred.x) < 0.02 && Math.abs(recentred.z) < 0.02 && recentred.fz < -0.99, JSON.stringify(recentred)],
    ['right stick snap-turns 30° about the head', turnDeg === -30 && Math.abs(turned.x - recentred.x) < 0.01 && Math.abs(turned.z - recentred.z) < 0.01, JSON.stringify({ recentred, turned, turnDeg })],
    ['stick movement closes the comfort vignette, and it opens when stopped', vignetteMoving > 0.3 && vignetteStill < 0.05, JSON.stringify({ vignetteMoving, vignetteStill })],
    ['palm towards the face shows the Menu button, not the menu', palm.button && !palm.menu && palm.mode === 'hands', JSON.stringify(palm)],
    ['the button holds still while the other hand reaches for it', dist(button0, button1) < 0.002, JSON.stringify({ button0, button1 })],
    ['tapping it with the other hand opens the menu in front, 20-40° below eye level', opened.shown && opened.label === 'Close' && opened.dist > 0.35 && opened.dist < 0.55 && opened.centerBelowEyes >= 20 && opened.centerBelowEyes <= 40, JSON.stringify(opened)],
    ['the menu stays put when the hand drops', afterDrop.shown && !afterDrop.button && dist(afterDrop.pos, pos0) < 0.001, JSON.stringify({ pos0, afterDrop })],
    ['a fingertip poke switches the menu to its Scenes page', paged.page === 'scenes' && paged.sceneButtons === SCENES.length, JSON.stringify(paged)],
    ['switching pages leaves the top of the menu in place', dist(paged.pos, pos0) < 0.005, JSON.stringify({ pos0, paged })],
    ['a hand pinch on the bar under the menu grabs it', handleHover && handleGrabbed === 'right', JSON.stringify({ handleHover, handleGrabbed })],
    ['and moves the menu with the hand', moveTo[0] - moveFrom[0] > 0.1, JSON.stringify({ moveFrom, moveTo })],
  ];
  for (const [name, ok, detail] of vrChecks) (ok ? pass(name) : fail(`${name} (${detail})`));
} catch (e) {
  fail(String(e.stack || e));
} finally {
  if (browser) await browser.close();
  server.kill();
}

if (failures.length) {
  console.error(`\n${failures.length} smoke check(s) failed`);
  process.exit(1);
}
console.log('\nall smoke checks passed');
