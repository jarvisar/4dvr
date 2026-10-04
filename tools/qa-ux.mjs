import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const base = process.env.QA_BASE || 'http://127.0.0.1:5173/';
const out = 'smoke-artifacts/qa-ux';
fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--ignore-certificate-errors', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
});
const results = [];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function snapshot(page) {
  return page.evaluate(() => {
    const r = (el) => { const b = el?.getBoundingClientRect(); return b && { x: b.x, y: b.y, width: b.width, height: b.height, right: b.right, bottom: b.bottom }; };
    const visible = (el) => el && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
    return {
      size: [innerWidth, innerHeight], touch: window.__app?.touch, scene: window.__app?.sceneKey,
      overflow: document.documentElement.scrollWidth > innerWidth,
      overlay: { visible: visible(document.querySelector('#overlay')), rect: r(document.querySelector('#overlay')), scrollHeight: document.querySelector('#overlay').scrollHeight },
      tabs: r(document.querySelector('#scene-tabs')), tools: r(document.querySelector('.hud-tools')),
      help: { visible: visible(document.querySelector('#hud-help')), rect: r(document.querySelector('#hud-help')), text: document.querySelector('#hud-help-list').textContent },
      menu: { visible: visible(document.querySelector('.hud-panel')), rect: r(document.querySelector('.hud-panel')), scrollHeight: document.querySelector('.hud-panel').scrollHeight, text: document.querySelector('.hud-panel-controls').textContent },
      status: document.querySelector('#xr-status').textContent.trim(),
      focus: { tag: document.activeElement.tagName, id: document.activeElement.id, text: document.activeElement.textContent?.slice(0, 80) },
      visibleLinks: [...document.querySelectorAll('a')].filter(visible).map((a) => [a.textContent, a.href]),
    };
  });
}

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(base, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForFunction(() => window.__app?.sceneList.length === 8);
  await page.screenshot({ path: `${out}/desktop-landing.png` });
  results.push({ test: 'desktop landing', state: await snapshot(page) });
  await page.focus('#enter-desktop');
  await page.keyboard.press('Enter');
  await pause(650);
  results.push({ test: 'keyboard enter desktop', state: await snapshot(page) });
  await page.keyboard.press('Tab');
  results.push({ test: 'first tab after entering', state: await snapshot(page) });
  await page.focus('#hud-menu');
  if (!(await page.evaluate(() => window.__app.desktopMenu))) await page.keyboard.press('Enter');
  await pause(150);
  await page.keyboard.press('Tab');
  results.push({ test: 'tab after menu toggle', state: await snapshot(page) });
  await page.focus('.hud-panel input[type=range]');
  const sliderBefore = await page.$eval('.hud-panel input[type=range]', (el) => +el.value);
  await page.keyboard.press('ArrowRight');
  await pause(250);
  const sliderAfter = await page.$eval('.hud-panel input[type=range]', (el) => +el.value);
  await page.keyboard.press('Escape');
  await pause(250);
  results.push({ test: 'slider keyboard and escape', sliderBefore, sliderAfter, state: await snapshot(page) });

  const scenes = ['playground', 'gallery', 'knots', 'hopf', 'hyperbolic', 'spherical', 'klein', 'quasicrystal'];
  for (const [i, scene] of scenes.entries()) {
    await page.focus(`#scene-tabs button:nth-child(${i + 1})`);
    await page.keyboard.press('Enter');
    await page.waitForFunction((key) => window.__app.sceneKey === key, { timeout: 30000 }, scene);
    await page.evaluate(() => { window.__app.setDesktopMenu(true); });
    await pause(350);
    const state = await snapshot(page);
    results.push({ test: `desktop scene ${scene}`, state });
    await page.screenshot({ path: `${out}/desktop-${scene}.png` });
  }
  for (const size of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 768, height: 1024 }, { width: 640, height: 480 }]) {
    const mobile = size.width === 320 || size.width === 390 || size.width === 844;
    await page.setViewport({ ...size, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
    await page.goto(base, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.waitForFunction(() => window.__app?.sceneList.length === 8);
    results.push({ test: `landing ${size.width}x${size.height}`, state: await snapshot(page) });
    await page.screenshot({ path: `${out}/landing-${size.width}x${size.height}.png` });
    await page.click('#scene-index button[data-scene=playground]');
    await pause(500);
    await page.evaluate(() => window.__app.setDesktopMenu(true));
    await pause(350);
    results.push({ test: `menu ${size.width}x${size.height}`, state: await snapshot(page) });
    await page.screenshot({ path: `${out}/menu-${size.width}x${size.height}.png` });
    await page.click('#hud-help-toggle');
    await pause(350);
    results.push({ test: `help ${size.width}x${size.height}`, state: await snapshot(page) });
  }

  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page.goto(`${base}?desktop`, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForFunction(() => window.__app?.sceneList.length === 8);
  for (const scene of scenes) {
    await page.evaluate((key) => window.__app.setScene(key, true), scene);
    await page.evaluate(() => window.__app.setDesktopMenu(true));
    await pause(300);
    results.push({ test: `mobile scene ${scene}`, state: await snapshot(page) });
    await page.screenshot({ path: `${out}/mobile-${scene}.png` });
  }

  for (const slug of ['about', '120-cell', 'hopf-fibration', 'hyperbolic-space', 'klein-bottle']) {
    await page.goto(`${base}${slug}/`, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForFunction(() => [...document.images].every((im) => im.complete && im.naturalWidth > 0), { timeout: 20000 });
    const data = await page.evaluate(() => ({ title: document.title, width: innerWidth, documentWidth: document.documentElement.scrollWidth, brokenImages: [...document.images].filter((im) => !im.complete || !im.naturalWidth).map((im) => im.src), links: [...document.querySelectorAll('a')].map((a) => [a.textContent, a.href]), h1: document.querySelector('h1')?.textContent }));
    results.push({ test: `topic ${slug} mobile`, ...data });
    await page.screenshot({ path: `${out}/topic-${slug}-mobile.png`, fullPage: true });
  }
  results.push({ test: 'page errors', errors });
} finally {
  fs.writeFileSync(`${out}/results.json`, JSON.stringify(results, null, 2));
  await browser.close();
}
const desktop = results.filter((r) => r.test.startsWith('desktop scene '));
const mobile = results.filter((r) => r.test.startsWith('mobile scene '));
const checks = {
  'eight desktop scenes render correct controls': desktop.length === 8 && desktop.every((r) => r.state.scene === r.test.split(' ').at(-1) && r.state.menu.visible),
  'eight mobile scenes render correct controls': mobile.length === 8 && mobile.every((r) => r.state.scene === r.test.split(' ').at(-1) && r.state.touch && r.state.menu.visible),
  'no viewport has horizontal overflow': results.filter((r) => r.state).every((r) => !r.state.overflow),
  'menus stay within tested viewports': results.filter((r) => r.state?.menu.visible).every((r) => { const b = r.state.menu.rect; return b.x >= 0 && b.y >= 0 && b.right <= r.state.size[0] && b.bottom <= r.state.size[1]; }),
  'keyboard slider works and Escape returns focus': results.find((r) => r.test === 'slider keyboard and escape')?.sliderAfter > results.find((r) => r.test === 'slider keyboard and escape')?.sliderBefore && results.find((r) => r.test === 'slider keyboard and escape')?.state.focus.id === 'hud-menu',
  'topic pages and images fit': results.filter((r) => r.test.startsWith('topic ')).every((r) => r.documentWidth <= r.width && r.brokenImages.length === 0 && r.h1),
  'no uncaught runtime errors': results.find((r) => r.test === 'page errors')?.errors.length === 0,
};
fs.writeFileSync(`${out}/checks.json`, JSON.stringify(checks, null, 2));
console.log(JSON.stringify(checks, null, 2));
console.log(`Saved ${results.length} checks to ${out}/results.json`);
if (Object.values(checks).some((pass) => !pass)) process.exitCode = 1;
