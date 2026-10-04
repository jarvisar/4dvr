import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const base = process.env.QA_BASE || 'http://127.0.0.1:5173/';
fs.mkdirSync('smoke-artifacts/qa-ux', { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox', '--ignore-certificate-errors', '--enable-unsafe-swiftshader', '--use-angle=swiftshader'] });
const page = await browser.newPage();
const results = [];
const checks = {};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(`${base}?desktop`, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForFunction(() => window.__app?.sceneList.length === 8);
  for (const scene of ['playground', 'gallery', 'knots', 'hopf', 'quasicrystal']) {
    await page.evaluate((key) => { window.__app.setScene(key, true); window.__app.setDesktopMenu(false); }, scene);
    await pause(300);
    const before = await page.evaluate(() => window.__app.camera.position.toArray());
    await page.mouse.move(800, 750);
    await page.mouse.down();
    await page.mouse.move(800, 100, { steps: 15 });
    await page.mouse.up();
    await pause(800);
    const after = await page.evaluate(() => ({ position: window.__app.camera.position.toArray(), empty: window.__app.pointerOnEmpty, floor: Math.max(0, window.__app.activeScene.tableY || 0) + 0.05 }));
    checks[`Orbit stays above the floor or table in ${scene}`] = after.empty && after.position[1] >= after.floor - 0.00001;
    results.push({ test: `camera after upward drag ${scene}`, before, ...after });
    await page.screenshot({ path: `smoke-artifacts/qa-ux/camera-after-drag-${scene}.png` });
    await page.evaluate(() => window.__app.setDesktopMenu(true));
    await pause(250);
    await page.evaluate(() => [...document.querySelectorAll('.hud-panel button')].find((button) => button.textContent === 'Reset view').focus());
    await page.keyboard.press('Enter');
    await pause(400);
    const reset = await page.evaluate(() => ({ position: window.__app.camera.position.toArray(), expected: window.__app.activeScene.desktopView.position.toArray(), target: window.__app.orbit.target.toArray(), expectedTarget: window.__app.activeScene.desktopView.target.toArray() }));
    checks[`Reset view restores camera in ${scene}`] = reset.position.every((value, i) => Math.abs(value - reset.expected[i]) < 0.01) && reset.target.every((value, i) => Math.abs(value - reset.expectedTarget[i]) < 0.01);
    results.push({ test: `Reset view ${scene}`, ...reset });
  }
  await page.click('#hud-home');
  await page.click('#enter-desktop');
  await pause(450);
  const resumed = await page.evaluate(() => ({ position: window.__app.camera.position.toArray(), scene: window.__app.sceneKey, hud: !document.querySelector('#hud').hidden }));
  checks['Home and resume keep usable scene view'] = resumed.scene === 'quasicrystal' && resumed.hud && resumed.position[1] >= 0.05;
  results.push({ test: 'camera after Home and resume', ...resumed });
} finally {
  fs.writeFileSync('smoke-artifacts/qa-ux/camera-results.json', JSON.stringify({ checks, results }, null, 2));
  await browser.close();
}
console.log(JSON.stringify(checks, null, 2));
if (Object.values(checks).some((pass) => !pass)) process.exitCode = 1;
