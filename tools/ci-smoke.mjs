// Headless smoke test used by CI and `npm run test:smoke`.
//
// 1. serves the production build with `vite preview`
// 2. opens every scene in headless Chrome (SwiftShader WebGL) and fails on
//    uncaught errors or shader/WebGL errors
// 3. runs tools/interaction-test.js, which drives fake tracked hands through
//    the real interaction code, and checks the outcomes
// Screenshots land in smoke-artifacts/ (uploaded by the CI workflow).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import puppeteer from 'puppeteer-core';

const PORT = 4321;
const BASE = `http://localhost:${PORT}/`;
const OUT = 'smoke-artifacts';
const SCENES = ['playground', 'gallery', 'knots', 'hopf', 'hyperbolic'];

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
  ];
  for (const [name, ok, detail] of checks) (ok ? pass(name) : fail(`${name} (${detail})`));
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
