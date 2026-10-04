import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const base = process.env.QA_BASE || 'http://127.0.0.1:5173/';
const out = 'smoke-artifacts/qa-ux';
fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox', '--ignore-certificate-errors', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const checks = {};

async function geometry(page) {
  return page.evaluate(() => {
    const box = (id) => { const r = document.querySelector(id).getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
    return { width: innerWidth, height: innerHeight, vr: box('#hud-vr'), tools: box('.hud-tools'), tabs: box('#scene-tabs'), menu: box('.hud-panel'), notice: box('#hud-notice'), overflow: document.documentElement.scrollWidth > innerWidth };
  });
}
const overlap = (a, b) => a.width > 0 && b.width > 0 && a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;

try {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'xr', { configurable: true, value: { isSessionSupported: async () => true, addEventListener() {} } }));
  for (const size of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 640, height: 360 }]) {
    await page.setViewport({ ...size, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await page.goto(`${base}?desktop`, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.waitForFunction(() => window.__app?.sceneList.length === 8 && !document.querySelector('#hud-vr').hidden);
    const g = await geometry(page);
    const key = `${size.width}x${size.height}`;
    checks[`VR and three navigation buttons fit ${key}`] = !g.overflow && !overlap(g.vr, g.tools) && !overlap(g.tabs, g.tools) && g.tools.right <= g.width && g.vr.x >= 0;
    results.push({ test: `VR available ${key}`, geometry: g });
    await page.screenshot({ path: `${out}/vr-ready-${key}.png` });
    await page.evaluate(() => window.__app.setScene('quasicrystal', true));
    await page.click('#hud-home');
    await pause(400);
    const home = await page.evaluate(() => ({ hudHidden: document.querySelector('#hud').hidden, startVisible: getComputedStyle(document.querySelector('#overlay')).visibility === 'visible', selected: document.querySelector('#scene-index button.selected')?.dataset.scene, focus: document.activeElement.id, links: [...document.querySelectorAll('.pages a')].length, scene: window.__app.sceneKey }));
    checks[`Home restores selected scene and links ${key}`] = home.hudHidden && home.startVisible && home.selected === 'quasicrystal' && home.focus === 'enter-desktop' && home.links === 5;
    await page.click('#enter-desktop');
    await pause(400);
    checks[`Resume preserves scene ${key}`] = await page.evaluate(() => !document.querySelector('#hud').hidden && window.__app.sceneKey === 'quasicrystal');
    results.push({ test: `Home and resume ${key}`, ...home });
  }
  await page.close();

  const failed = await browser.newPage();
  await failed.setRequestInterception(true);
  failed.on('request', (request) => /\/(?:src\/scenes\/gallery\.js|assets\/gallery-[^/]+\.js)(?:\?|$)/.test(request.url()) ? request.abort() : request.continue());
  for (const size of [{ width: 1280, height: 800 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
    await failed.setViewport({ ...size, isMobile: size.width < 1000, hasTouch: size.width < 1000 });
    await failed.goto(`${base}?desktop`, { waitUntil: 'networkidle0', timeout: 60000 });
    await failed.waitForFunction(() => !document.querySelector('#hud-notice').hidden, { timeout: 20000 });
    await failed.evaluate(() => window.__app.setDesktopMenu(true));
    await pause(300);
    const g = await geometry(failed);
    const status = await failed.evaluate(() => ({ text: document.querySelector('#scene-load-status').textContent, retryVisible: !document.querySelector('#retry-scenes').hidden, role: document.querySelector('#scene-load-status').getAttribute('role'), rendered: window.__app.frameCount > 3 }));
    const key = `${size.width}x${size.height}`;
    checks[`Load failure notice and menu fit ${key}`] = !g.overflow && !overlap(g.notice, g.menu) && !overlap(g.notice, g.tabs) && g.notice.x >= 0 && g.notice.right <= g.width && status.retryVisible && status.role === 'status' && status.rendered;
    results.push({ test: `Failed scene notice ${key}`, geometry: g, status });
    await failed.screenshot({ path: `${out}/failed-scene-${key}.png` });
  }
  await failed.close();
} finally {
  fs.writeFileSync(`${out}/navigation-results.json`, JSON.stringify({ checks, results }, null, 2));
  await browser.close();
}
console.log(JSON.stringify(checks, null, 2));
if (Object.values(checks).some((pass) => !pass)) process.exitCode = 1;
