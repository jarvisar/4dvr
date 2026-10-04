import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const base = process.env.QA_BASE || 'http://127.0.0.1:5173/';
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox', '--ignore-certificate-errors', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
const page = await browser.newPage();
const out = 'smoke-artifacts/qa-ux';
fs.mkdirSync(out, { recursive: true });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const result = [];
async function state() {
  return page.evaluate(() => ({
    scene: window.__app.sceneKey,
    preset: window.__app.activeScene.preset,
    quality: window.__app.quality,
    focus: { tag: document.activeElement.tagName, text: document.activeElement.textContent?.slice(0, 60), key: document.activeElement.dataset.key },
    scroll: { top: document.querySelector('.hud-panel').scrollTop, height: document.querySelector('.hud-panel').scrollHeight, visibleHeight: document.querySelector('.hud-panel').clientHeight },
    controls: [...document.querySelectorAll('.hud-panel button')].map((b) => ({ text: b.textContent, key: b.dataset.key })),
  }));
}
try {
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(`${base}?desktop&quality=high`, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForFunction(() => window.__app?.sceneList.length === 8);
  await page.evaluate(() => { window.__app.activeScene.loadPreset('shadows'); window.__app.setDesktopMenu(true); });
  await pause(300);
  await page.evaluate(() => [...document.querySelectorAll('.hud-panel button')].find((b) => b.textContent === 'Low').focus());
  result.push({ test: 'before low', ...await state() });
  await page.keyboard.press('Enter');
  await pause(400);
  result.push({ test: 'after low', ...await state() });
  await page.screenshot({ path: `${out}/shadows-keyboard-low.png` });
  await page.setViewport({ width: 1280, height: 600 });
  await page.evaluate(() => { window.__app.setQuality('high'); window.__app.activeScene.loadPreset('sandbox'); });
  await pause(300);
  await page.evaluate(() => { document.querySelector('.hud-panel').scrollTop = 10000; });
  await pause(300);
  result.push({ test: 'before scene switch at menu bottom', ...await state() });
  await page.click('#scene-tabs button:nth-child(2)');
  await page.waitForFunction(() => window.__app.sceneKey === 'gallery');
  await pause(400);
  result.push({ test: 'after gallery switch', ...await state() });
  await page.screenshot({ path: `${out}/gallery-retained-menu-scroll.png` });
  await page.evaluate(() => { window.__app.setScene('playground', true); document.querySelector('.hud-panel').scrollTop = 0; });
  await pause(300);
  await page.evaluate(() => [...document.querySelectorAll('.hud-panel button')].find((b) => b.textContent === 'Close').focus());
  await page.keyboard.press('Enter');
  await pause(300);
  result.push({ test: 'keyboard close focus', ...await state() });
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(`${base}about/`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForFunction(() => [...document.images].every((im) => im.complete && im.naturalWidth > 0), { timeout: 20000 });
  result.push({ test: 'topic lazy image after scroll', images: await page.evaluate(() => [...document.images].map((im) => ({ src: im.src, complete: im.complete, naturalWidth: im.naturalWidth }))) });
} finally {
  fs.writeFileSync(`${out}/focus-results.json`, JSON.stringify(result, null, 2));
  await browser.close();
}
const checks = {
  'graphics change keeps keyboard focus': result.find((r) => r.test === 'after low')?.focus.text === 'Low',
  'changing scenes resets menu scroll': result.find((r) => r.test === 'after gallery switch')?.scroll.top === 0,
  'keyboard close restores menu focus': result.find((r) => r.test === 'keyboard close focus')?.focus.text === 'Menu M',
  'topic lazy images load when reached': result.find((r) => r.test === 'topic lazy image after scroll')?.images.every((im) => im.complete && im.naturalWidth > 0),
};
fs.writeFileSync(`${out}/focus-checks.json`, JSON.stringify(checks, null, 2));
console.log(JSON.stringify(checks, null, 2));
if (Object.values(checks).some((pass) => !pass)) process.exitCode = 1;
