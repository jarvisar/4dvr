// Loads the app in headless Chrome (SwiftShader WebGL), optionally runs a JS
// snippet, saves a screenshot and prints console output and errors.
//
//   node tools/smoke.mjs <url> <out.png> [waitMs] [jsToEvaluate]
//
// Set CHROME_PATH if Chrome lives somewhere else.

import puppeteer from 'puppeteer-core';

const url = process.argv[2] || 'http://localhost:5173/?desktop';
const out = process.argv[3] || 'shot.png';
const wait = parseInt(process.argv[4] || '2500', 10);
import fs from 'fs';
// a leading '@' means "read the snippet from this file"
const evalArg = process.argv[5] || '';
const evalJs = evalArg.startsWith('@') ? fs.readFileSync(evalArg.slice(1), 'utf8') : evalArg;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--ignore-certificate-errors', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,800'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack}`));
await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
await new Promise((r) => setTimeout(r, wait));
if (evalJs) {
  const res = await page.evaluate(evalJs);
  if (res !== undefined) console.log('eval:', typeof res === 'string' ? res : JSON.stringify(res));
  await new Promise((r) => setTimeout(r, 1500));
}
await page.screenshot({ path: out });

// collapse repeated lines so a per-frame error doesn't flood the output
const counts = new Map();
for (const l of logs) counts.set(l, (counts.get(l) || 0) + 1);
for (const [l, n] of counts) console.log(n > 1 ? `(x${n}) ${l}` : l);
await browser.close();
