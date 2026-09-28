// Showcase screenshots for the README (docs/screenshots/), taken from the
// production build in headless Chrome (SwiftShader WebGL) with the HUD hidden.
// `npm run screenshots` builds first. Re-run it after changing how a scene looks.
//
//   node tools/screenshots.mjs [name…]   only retake the named shots

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import puppeteer from 'puppeteer-core';

const PORT = 4322;
const BASE = `http://127.0.0.1:${PORT}/`;
const OUT = path.join('docs', 'screenshots');
const SIZE = { width: 1280, height: 720 };

// Each setup runs in the page once the scene has started. They are serialized
// into the page, so they can only use the page's globals.
const SHOTS = [
  {
    name: 'hyperplay', scene: 'playground',
    setup: () => {
      const app = window.__app, s = app.activeScene;
      s.loadPreset('sandbox');
      for (let i = 0; i < 72 * 6; i++) s.update(1 / 72, i / 72); // let everything settle
      app.camera.position.set(0.34, 1.34, -0.02);
      app.orbit.target.set(0.02, 0.93, -0.74);
    },
  },
  {
    name: 'polytopes', scene: 'gallery',
    setup: () => {
      const app = window.__app, s = app.activeScene;
      s.setShape('hecatonicosachoron');
      app.camera.position.set(0.18, 1.5, -0.02);
      app.orbit.target.copy(s.center);
    },
  },
  { name: 'hopf', scene: 'hopf', setup: () => {} },
  { name: 'hyperbolic', scene: 'hyperbolic', setup: () => {} },
  { name: 'spherical', scene: 'spherical', setup: () => {} }, // straight ahead is the back of your own head, the long way round
  {
    name: 'klein', scene: 'klein',
    setup: () => {
      const s = window.__app.activeScene;
      s.desktopView.position.set(0.5, 1.6, 1.2);
      s.walk.yaw = 0.5;
      s.walk.pitch = -0.15;
    },
  },
];

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
      if ((await fetch(url)).ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Server at ${url} did not start`);
}

const only = process.argv.slice(2);
fs.mkdirSync(OUT, { recursive: true });
const vite = path.join('node_modules', 'vite', 'bin', 'vite.js');
const server = spawn(process.execPath, [vite, 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
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
    args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', `--window-size=${SIZE.width},${SIZE.height}`],
  });
  for (const shot of SHOTS) {
    if (only.length && !only.includes(shot.name)) continue;
    const page = await browser.newPage();
    await page.setViewport(SIZE);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${BASE}?desktop&scene=${shot.scene}`, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.waitForFunction((k) => window.__app?.sceneKey === k && window.__app.frameCount > 3, { timeout: 60000 }, shot.scene);
    await page.evaluate(() => {
      document.getElementById('hud').style.display = 'none';
      window.__app.setDesktopMenu(false);
    });
    await page.evaluate(shot.setup);
    await new Promise((r) => setTimeout(r, 5000)); // wait a few slow software-rendered frames, and for intro messages to fade
    if (errors.length) throw new Error(`${shot.name}: ${errors.join('; ')}`);
    const file = path.join(OUT, `${shot.name}.jpg`);
    await page.screenshot({ path: file, type: 'jpeg', quality: 88 });
    console.log(`  ${file}`);
    await page.close();
  }
} finally {
  if (browser) await browser.close();
  server.kill();
}
