// Headless smoke test used by CI and `npm run test:smoke`.
//
// 1. serves the production build with `vite preview`
// 2. opens every scene in headless Chrome (SwiftShader WebGL) and fails on
//    uncaught errors or shader/WebGL errors
// 3. runs tools/interaction-test.js, which drives fake tracked hands through
//    the real interaction code, and checks the outcomes
// 4. enters a real WebXR session on an emulated Quest 3 (IWER, `?iwer=headless`)
//    and checks the controls panel, controller ray, menus and the hand menu
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
  if (!found) throw new Error('Chrome not found; set CHROME_PATH');
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
    ['touching the globe paints fibres', r.hopfPainted > 5, r.hopfPainted],
    ['pinch-twist turns the globe', r.globeTurned > 0.5, r.globeTurned],
    ['trefoil is detected as knotted', r.knots?.trefoilMinCrossings >= 3, r.knots?.trefoilMinCrossings],
    ['middle-pinch lifts a strand into W', r.knots?.liftedW > 0.05, r.knots?.liftedW],
    ['flatten returns the rope to our slice', r.knots?.wAfterFlatten < 0.006, r.knots?.wAfterFlatten],
    ['a plain loop has no crossings', r.knots?.circleCrossings === 0, r.knots?.circleCrossings],
    ['hyperbolic re-centring keeps the head in the central cell', r.hyperbolic?.headDistFromOrigin < 1.5, r.hyperbolic?.headDistFromOrigin],
    ['hyperbolic distance travelled is preserved', Math.abs(r.hyperbolic?.homeDistance - 6) < 0.01, r.hyperbolic?.homeDistance],
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

  // A real WebXR session on an emulated Quest 3 (IWER), rendered as one view.
  console.log('vr (IWER emulator)');
  const vr = await browser.newPage();
  await vr.setViewport({ width: 1000, height: 900 });
  vr.on('pageerror', (e) => fail(`vr pageerror: ${e.message}`));
  await vr.goto(`${BASE}?iwer=headless`, { waitUntil: 'networkidle0', timeout: 60000 });
  await new Promise((r) => setTimeout(r, 2500));
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const ev = (js) => vr.evaluate(js);
  await ev(`(async () => {
    __xrDevice.position.set(0, 1.6, 0);
    __xrDevice.quaternion.set(-0.1736, 0, 0, 0.9848); // looking 20° down
    await __app.enterVR();
  })()`);
  await sleep(2000);
  const started = await ev(`({ presenting: __app.presenting, welcome: __app.welcome.panel.group.visible, mode: __app.inputMode })`);
  await vr.screenshot({ path: path.join(OUT, 'vr-welcome.png') });
  // aim the right controller at the welcome panel's Close button and pull the trigger
  await ev(`(() => {
    const p = __app.welcome.panel, btn = p.widgets.find((w) => w.type === 'button');
    const target = p.mesh.localToWorld(new (p.group.position.constructor)((btn.x + btn.w / 2) / p.width - 0.5, 0.5 - (btn.y + btn.h / 2) / p.height, 0));
    const c = __xrDevice.controllers.right;
    c.position.set(0.15, 1.3, -0.1);
    const d = target.clone().sub(new (target.constructor)(0.15, 1.3, -0.1)).normalize();
    const q = new (__app.camera.quaternion.constructor)().setFromUnitVectors(new (target.constructor)(0, 0, -1), d);
    c.quaternion.set(q.x, q.y, q.z, q.w);
  })()`);
  await sleep(400);
  await ev(`__xrDevice.controllers.right.updateButtonValue('trigger', 1)`); await sleep(300);
  await ev(`__xrDevice.controllers.right.updateButtonValue('trigger', 0)`); await sleep(300);
  const closed = await ev(`!__app.welcome.panel.group.visible`);
  const menus = {};
  for (const scene of SCENES) {
    await ev(`__app.setScene('${scene}', true); __app.menu.pinned = false; __app.menu.shown = false;`);
    await sleep(500);
    // the first visit to each scene shows its tips (the first scene's were in the welcome panel)
    const tips = await ev(`__app.welcome.panel.group.visible`);
    if (tips) await vr.screenshot({ path: path.join(OUT, `vr-tips-${scene}.png`) });
    await ev(`__app.welcome.hide()`);
    await ev(`__xrDevice.controllers.right.updateButtonValue('a-button', 1)`); await sleep(250);
    await ev(`__xrDevice.controllers.right.updateButtonValue('a-button', 0)`); await sleep(900);
    menus[scene] = await ev(`(() => {
      const p = __app.menu.panel;
      const texts = p.widgets.filter((w) => w.type === 'text');
      return { shown: __app.menu.shown, height: p.height, truncated: texts.filter((w) => p._wrap(w.row, w.w).length > w.lines).length };
    })()`);
    menus[scene].tips = tips;
    await vr.screenshot({ path: path.join(OUT, `vr-menu-${scene}.png`) });
  }

  // A new scene opens in front of the person wherever they've walked and turned to:
  // stand 1 m to the side facing +x, then switch scenes.
  const headPose = (js) => ev(`(() => { ${js} })()`);
  const headNow = `(() => { const f = new (__app.headPosition.constructor)(0, 0, -1).applyQuaternion(__app.headQuaternion); const p = __app.headPosition; return { x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3), fx: +f.x.toFixed(3), fz: +f.z.toFixed(3) }; })()`;
  await headPose(`__xrDevice.position.set(0.8, 1.6, 0.5); __xrDevice.quaternion.set(0, -0.7071, 0, 0.7071);`);
  await sleep(300);
  await ev(`__app.setScene('hyperbolic', true)`);
  await sleep(300);
  const recentred = await ev(headNow);
  // snap turn: the right stick turns 30° about the head; the left stick moves (and closes the vignette)
  await ev(`__xrDevice.controllers.right.updateAxes('thumbstick', 1, 0)`); await sleep(250);
  await ev(`__xrDevice.controllers.right.updateAxes('thumbstick', 0, 0)`); await sleep(250);
  const turned = await ev(headNow);
  await ev(`__xrDevice.controllers.left.updateAxes('thumbstick', 0, -1)`); await sleep(400);
  const vignetteMoving = await ev(`__app._vignette.level`);
  await ev(`__xrDevice.controllers.left.updateAxes('thumbstick', 0, 0)`);
  // dt is capped per frame, so on a slow CI renderer the vignette opens slower than
  // wall time: poll for it rather than sleeping a fixed amount
  let vignetteStill = 1;
  for (const t0 = Date.now(); Date.now() - t0 < 8000; await sleep(100)) {
    vignetteStill = await ev(`__app._vignette.level`);
    if (vignetteStill < 0.05) break;
  }
  await headPose(`__xrDevice.position.set(0, 1.6, 0); __xrDevice.quaternion.set(-0.1736, 0, 0, 0.9848);`);
  await sleep(300);

  // switch to tracked hands and turn the left palm towards the face
  await ev(`__app.setScene('playground', true); __app.menu.pinned = false; __app.menu.shown = false; __xrDevice.primaryInputMode = 'hand';`);
  await sleep(600);
  const tipsOnReturn = await ev(`__app.welcome.panel.group.visible`);
  await ev(`(() => { const L = __xrDevice.hands.left; L.position.set(-0.04, 1.2, -0.28); L.quaternion.set(1, 0, 0, 0); })()`);
  await sleep(1200);
  const hand = await ev(`({ shown: __app.menu.shown, owner: __app.menu.owner?.handedness, mode: __app.inputMode })`);
  await vr.screenshot({ path: path.join(OUT, 'vr-hand-menu.png') });

  // Bring the right index fingertip 5 cm in front of the menu, then move the left
  // hand: the menu holds still while it's about to be pressed, and follows again after.
  const menuPos = `(() => { const p = __app.menu.panel.group.position; return [p.x, p.y, p.z]; })()`;
  await ev(`(() => {
    const R = __xrDevice.hands.right, ix = __app.input.xr.find((i) => i.handedness === 'right');
    const tip = ix.joints[9].pos, p = __app.menu.panel;
    const target = p.fromPanel(p.width / 2, p.height / 2, 0.05);
    R.position.set(R.position.x + target.x - tip.x, R.position.y + target.y - tip.y, R.position.z + target.z - tip.z);
  })()`);
  await sleep(500);
  const held0 = await ev(menuPos);
  await ev(`__xrDevice.hands.left.position.set(-0.16, 1.2, -0.28)`);
  await sleep(600);
  const held = await ev(`({ pos: ${menuPos}, shown: __app.menu.shown, inUse: __app.menu.inUse })`);
  await ev(`__xrDevice.hands.right.position.set(0.45, 0.9, -0.1)`);
  await sleep(800);
  const released = await ev(`({ pos: ${menuPos}, shown: __app.menu.shown })`);
  // poke the "Scenes" page button with the right index fingertip: the page
  // changes and the menu's top row stays where it was
  const pokeAt = (label, z) => ev(`(() => {
    const R = __xrDevice.hands.right, ix = __app.input.xr.find((i) => i.handedness === 'right');
    const p = __app.menu.panel, tip = ix.joints[9].pos;
    const w = p.widgets.find((w) => w.item && (typeof w.item.label === 'function' ? w.item.label() : w.item.label) === '${label}');
    const target = p.fromPanel(w.x + w.w / 2, w.y + w.h / 2, ${z});
    R.position.set(R.position.x + target.x - tip.x, R.position.y + target.y - tip.y, R.position.z + target.z - tip.z);
  })()`);
  await pokeAt('Scenes', 0.03); await sleep(400);
  const top0 = await ev(menuPos);
  await pokeAt('Scenes', -0.004); await sleep(400);
  await pokeAt('Scenes', 0.05); await sleep(400);
  const paged = await ev(`({ page: __app.menu.page, pos: ${menuPos}, sceneButtons: __app.menu.panel.widgets.filter((w) => w.type === 'tab').length })`);
  await vr.screenshot({ path: path.join(OUT, 'vr-hand-menu-scenes.png') });
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const turnDeg = Math.round((Math.atan2(-turned.fx, -turned.fz) - Math.atan2(-recentred.fx, -recentred.fz)) * 180 / Math.PI);
  const vrChecks = [
    ['enters an immersive session', started.presenting, JSON.stringify(started)],
    ['shows the controls panel on entry', started.welcome, JSON.stringify(started)],
    ['controller ray presses a panel button', closed],
    ['A button opens the menu in every scene', Object.values(menus).every((m) => m.shown), JSON.stringify(menus)],
    ['menu text is never cut off', Object.values(menus).every((m) => m.truncated === 0), JSON.stringify(menus)],
    ['each new scene shows its tips once', SCENES.slice(1).every((s) => menus[s].tips) && !tipsOnReturn, JSON.stringify({ menus, tipsOnReturn })],
    ['a new scene opens in front of the person', Math.abs(recentred.x) < 0.02 && Math.abs(recentred.z) < 0.02 && recentred.fz < -0.99, JSON.stringify(recentred)],
    ['right stick snap-turns 30° about the head', turnDeg === -30 && Math.abs(turned.x - recentred.x) < 0.01 && Math.abs(turned.z - recentred.z) < 0.01, JSON.stringify({ recentred, turned, turnDeg })],
    ['stick movement closes the comfort vignette, and it opens when stopped', vignetteMoving > 0.3 && vignetteStill < 0.05, JSON.stringify({ vignetteMoving, vignetteStill })],
    ['palm towards the face opens the hand menu', hand.shown && hand.owner === 'left' && hand.mode === 'hands', JSON.stringify(hand)],
    ['the hand menu holds still while the other hand reaches for it', held.inUse && held.shown && dist(held.pos, held0) < 0.005, JSON.stringify({ held0, held })],
    ['and follows the hand again afterwards', released.shown && dist(released.pos, held.pos) > 0.06, JSON.stringify({ held, released })],
    ['a fingertip poke switches the menu to its Scenes page', paged.page === 'scenes' && paged.sceneButtons === SCENES.length, JSON.stringify(paged)],
    ['switching pages leaves the top of the menu in place', dist(paged.pos, top0) < 0.005, JSON.stringify({ top0, paged })],
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
