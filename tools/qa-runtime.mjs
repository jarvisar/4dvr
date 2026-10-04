import assert from 'node:assert/strict';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const base = process.env.QA_BASE || 'http://127.0.0.1:5173/';
const out = 'smoke-artifacts/qa-runtime';
fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--ignore-certificate-errors', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
});
const results = [];
async function check(name, run) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (new URL(request.url()).hostname === 'fonts.googleapis.com') request.respond({ status: 200, contentType: 'text/css', body: '' });
    else request.continue();
  });
  try {
    await run(page);
    results.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
    await page.screenshot({ path: `${out}/${results.length}.png` });
  } finally { await page.close(); }
}
const ready = async (page, search = '?desktop') => {
  await page.goto(base + search, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__app?.sceneList.length === 8 && __app.frameCount > 3);
};

try {
  await check('inherited property names in quality URLs fall back to a valid preset', async (page) => {
    await ready(page, '?desktop&quality=constructor');
    assert.equal(await page.evaluate(() => __app.quality), 'high');
    assert.ok(await page.evaluate(() => __app.renderer.domElement.width > 0));
  });
  await check('corrupt saved quality falls back to a valid preset', async (page) => {
    await page.evaluateOnNewDocument(() => localStorage.setItem('4dvr.quality', '__proto__'));
    await ready(page);
    assert.equal(await page.evaluate(() => __app.quality), 'high');
  });
  await check('latest scene selection wins during a transition', async (page) => {
    await ready(page);
    await page.evaluate(() => { __app.setScene('gallery'); __app.setScene('playground'); });
    await new Promise((r) => setTimeout(r, 1800));
    assert.equal(await page.evaluate(() => __app.sceneKey), 'playground');
  });
  await check('VR rejection from desktop preserves desktop view and focus', async (page) => {
    await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'xr', {
      configurable: true,
      value: { isSessionSupported: async () => true, addEventListener() {} },
    }));
    await ready(page);
    await page.waitForFunction(() => !document.getElementById('hud-vr').hidden);
    await page.evaluate(() => {
      __app.enterVR = async () => { throw new Error('Headset permission denied'); };
    });
    await page.click('#hud-vr');
    await page.waitForFunction(() => document.getElementById('announce').textContent.includes('Could not start VR'));
    assert.equal(await page.evaluate(() => document.getElementById('overlay').classList.contains('hidden')), true);
    assert.match(await page.$eval('#announce', (el) => el.textContent), /Could not start VR/);
    assert.equal(await page.evaluate(() => document.getElementById('overlay').contains(document.activeElement)), false);
  });
  await check('WebGL startup failure leaves an actionable failure screen', async (page) => {
    await page.evaluateOnNewDocument(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...args) {
        return type === 'webgl2' ? null : original.call(this, type, ...args);
      };
    });
    await page.goto(base, { waitUntil: 'networkidle0' });
    assert.match(await page.$eval('#xr-note', (el) => el.textContent), /Could not start/);
    assert.equal(await page.$eval('#enter-desktop', (el) => el.disabled), true);
    assert.equal(await page.$eval('#xr-status', (el) => el.classList.contains('pending')), false);
    assert.ok(await page.$('#retry-start'));
  });
  await check('failed lazy scene import keeps recovery available after VR rejection', async (page) => {
    await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'xr', {
      configurable: true,
      value: { isSessionSupported: async () => true, addEventListener() {} },
    }));
    page.removeAllListeners('request');
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.hostname === 'fonts.googleapis.com') request.respond({ status: 200, contentType: 'text/css', body: '' });
      else if (/\/(?:scenes\/hopf\.js|assets\/hopf-[^/]+\.js)$/.test(url.pathname)) request.abort('failed');
      else request.continue();
    });
    await page.goto(base + '?desktop&scene=hopf', { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => !document.getElementById('retry-scenes').hidden && !document.getElementById('hud-vr').hidden);
    const sceneFailure = await page.$eval('#scene-load-status', (el) => el.textContent);
    assert.match(sceneFailure, /could not load/);
    await page.evaluate(() => {
      __app.enterVR = async () => { throw new Error('Headset permission denied'); };
    });
    await page.click('#hud-vr');
    await page.waitForFunction(() => document.getElementById('scene-load-status').textContent.includes('Could not start VR'));
    const notice = await page.$eval('#scene-load-status', (el) => el.textContent);
    assert.ok(notice.includes(sceneFailure), 'The scene-load explanation must survive a VR failure');
    assert.equal(await page.$eval('#retry-scenes', (el) => el.hidden), false);
    assert.equal(await page.evaluate(() => document.getElementById('overlay').classList.contains('hidden')), true);
    await page.evaluate(() => { __app.onSessionChange(true); __app.onSessionChange(false); });
    assert.equal(await page.$eval('#scene-load-status', (el) => el.textContent), sceneFailure);
    assert.equal(await page.$eval('#retry-scenes', (el) => el.hidden), false);
    const [reload] = await Promise.all([
      page.waitForRequest((request) => request.isNavigationRequest() && request.frame() === page.mainFrame()),
      page.click('#retry-scenes'),
    ]);
    assert.equal(new URL(reload.url()).searchParams.get('scene'), 'hopf');
  });
  await check('unavailable local storage leaves all scenes usable', async (page) => {
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage blocked', 'SecurityError'); } });
    });
    await ready(page);
    assert.equal(await page.evaluate(() => __app.quality), 'high');
  });
  await check('frame rate reflects wall time while slow physics steps stay capped', async (page) => {
    await ready(page);
    const result = await page.evaluate(() => {
      __app.renderer.setAnimationLoop(null);
      __app._lastT = 0;
      __app._fpsT = 0;
      __app._fpsN = 0;
      const start = __app.time;
      for (let i = 1; i <= 30; i++) __app._frame(i * 200);
      return { fps: __app.fps, simulated: __app.time - start };
    });
    assert.ok(Math.abs(result.fps - 5) < 0.001, `Expected 5 fps, got ${result.fps}`);
    assert.ok(Math.abs(result.simulated - 1.5) < 0.001);
  });
} finally {
  fs.writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
  await browser.close();
}
if (results.some((result) => !result.passed)) process.exitCode = 1;
