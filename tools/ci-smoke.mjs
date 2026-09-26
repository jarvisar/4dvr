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
const SCENES = ['playground', 'flatland', 'gallery', 'knots', 'hopf', 'hyperbolic', 'spherical', 'klein', 'quasicrystal'];

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
    ['fingertip poke presses a menu button', r.pokedTower],
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
    ['Flatland: lift the gem out of the sealed vault', r.flatland?.gemGrabbed && r.flatland?.gemOut, JSON.stringify(r.flatland)],
    ['Flatland: a Flatlander put back upside down is mirrored', r.flatland?.triGrabbed && r.flatland?.triFlipped && r.flatland?.triBack, JSON.stringify(r.flatland)],
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
    await ev(`__xrDevice.controllers.right.updateButtonValue('a-button', 1)`); await sleep(250);
    await ev(`__xrDevice.controllers.right.updateButtonValue('a-button', 0)`); await sleep(900);
    menus[scene] = await ev(`(() => {
      const p = __app.menu.panel;
      const texts = p.widgets.filter((w) => w.type === 'text');
      return { shown: __app.menu.shown, height: p.height, truncated: texts.filter((w) => p._wrap(w.row, w.w).length > w.lines).length };
    })()`);
    await vr.screenshot({ path: path.join(OUT, `vr-menu-${scene}.png`) });
  }
  // switch to tracked hands and turn the left palm towards the face
  await ev(`__app.setScene('playground', true); __app.menu.pinned = false; __app.menu.shown = false; __xrDevice.primaryInputMode = 'hand';`);
  await sleep(600);
  await ev(`(() => { const L = __xrDevice.hands.left; L.position.set(-0.04, 1.2, -0.28); L.quaternion.set(1, 0, 0, 0); })()`);
  await sleep(1200);
  const hand = await ev(`({ shown: __app.menu.shown, owner: __app.menu.owner?.handedness, mode: __app.inputMode })`);
  await vr.screenshot({ path: path.join(OUT, 'vr-hand-menu.png') });
  const vrChecks = [
    ['enters an immersive session', started.presenting, JSON.stringify(started)],
    ['shows the controls panel on entry', started.welcome, JSON.stringify(started)],
    ['controller ray presses a panel button', closed],
    ['A button opens the menu in every scene', Object.values(menus).every((m) => m.shown), JSON.stringify(menus)],
    ['menu text is never cut off', Object.values(menus).every((m) => m.truncated === 0), JSON.stringify(menus)],
    ['palm towards the face opens the hand menu', hand.shown && hand.owner === 'left' && hand.mode === 'hands', JSON.stringify(hand)],
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
