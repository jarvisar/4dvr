import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const out = 'smoke-artifacts/qa-scenes';
fs.mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox', '--ignore-certificate-errors', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--window-size=1280,800'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.setRequestInterception(true);
page.on('request', request => {
  if (new URL(request.url()).hostname === 'fonts.googleapis.com') request.respond({ status: 200, contentType: 'text/css', body: '' });
  else request.continue();
});
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/favicon|GPU stall|software WebGL/.test(m.text())) errors.push(m.text()); });
try {
  const url = new URL(process.env.QA_BASE || 'http://127.0.0.1:5173/');
  url.searchParams.set('desktop', '');
  await page.goto(url.href, { waitUntil: 'networkidle0', timeout: 120000 });
  await page.waitForFunction(() => window.__app?.frameCount > 5);
  await page.evaluate(() => window.__app.renderer.setAnimationLoop(null));
  const records = [];
  for (const key of ['playground', 'gallery', 'knots', 'hopf', 'hyperbolic', 'spherical', 'klein', 'quasicrystal']) {
    console.log(`Testing ${key}`);
    const result = await page.evaluate(async key => {
      const app = window.__app;
      const R = await import('/src/math/rot4.js');
      app.setScene(key, true);
      const s = app.activeScene;
      const checks = [];
      const finite = (name, a) => { if (a && !Array.from(a).every(Number.isFinite)) checks.push({ name, failure: 'Nonfinite values', values: Array.from(a) }); };
      const inspect = label => {
        finite(label + ': rotation', s.R || s.Hm || s.viewR);
        finite(label + ': rope', s.rope?.p);
        for (const t of s.toys || []) { finite(label + ': toy position', t.body.x); finite(label + ': toy rotation', t.body.R); }
        s.root.traverse(o => { for (const [name, a] of Object.entries(o.geometry?.attributes || {})) finite(label + ': ' + name, a.array); });
      };
      let time = app.time;
      const tick = n => {
        const shadows = app.env.shadows;
        // These are simulation/control checks. Avoid queueing thousands of
        // offscreen renders on SwiftShader; the normal smoke test covers them.
        if (s.shadow4) app.env.shadows = false;
        try { for (let j=0;j<n;j++) { time += 1/72; s.update(1/72,time); } }
        finally { app.env.shadows = shadows; }
        inspect('after ticks');
      };
      const getLabel = x => typeof x.label === 'function' ? x.label() : x.label;
      const disabled = x => typeof x.disabled === 'function' ? x.disabled() : x.disabled;
      const buttons = s.menuRows().filter(r=>r.type==='buttons').flatMap(r=>r.items).map(getLabel);
      const exerciseControls = () => {
        for (const row of s.menuRows()) {
          if (disabled(row)) continue;
          if (row.type==='tabs') {
            const prev = row.get();
            for (const option of row.options) {
              if (disabled(option)) continue;
              row.set(option.value); tick(8); checks.push({ name: option.label, get: row.get(), passed: row.get() === option.value });
            }
            row.set(prev);
          }
          if (row.type==='slider') {
            const prev=row.get();
            for (const val of [row.min, row.max, (row.min+row.max)/2]) { row.set(val); tick(8); checks.push({ name: row.label, set:val, get:row.get(), passed: Math.abs(val-row.get()) < 1e-6 }); }
            row.set(prev);
          }
          if (row.type==='toggles') for (const item of row.items) {
            if (disabled(item)) continue;
            const prev=item.get(); item.set(!prev); tick(4); checks.push({ name:getLabel(item), passed:item.get()===!prev }); item.set(prev);
          }
        }
      };
      for (const name of buttons) {
        const item = s.menuRows().filter(r=>r.type==='buttons').flatMap(r=>r.items).find(x=>getLabel(x)===name);
        if (!item || disabled(item)) continue;
        item.onClick(); tick(key==='playground'?36:12);
        checks.push({ name, passed: true });
        exerciseControls();
        for (const dynamic of s.menuRows().filter(r=>r.type==='buttons').flatMap(r=>r.items)) {
          const label = getLabel(dynamic);
          if (buttons.includes(label) || disabled(dynamic)) continue;
          dynamic.onClick(); tick(12); checks.push({name:label,passed:true});
        }
      }
      exerciseControls();
      tick(8);
      if (s.shadow4 && app.env.shadows) { s.shadow4.enabled = true; s.shadow4.dirty = true; s.shadow4.render(app.renderer); }
      app.renderer.render(app.scene, app.camera);
      return { key, checks, geometryCount: app.renderer.info.memory.geometries, textures:app.renderer.info.memory.textures };
    }, key);
    records.push(result);
    fs.writeFileSync(`${out}/scene-checks.json`, JSON.stringify({ records, errors }, null, 2));
    await page.screenshot({ path: `${out}/${key}-controls.png` });
    console.log(`${key}: ${result.checks.length} checks, failures ${result.checks.filter(c=>c.failure || c.passed===false).length}`);
  }
  fs.writeFileSync(`${out}/scene-checks.json`, JSON.stringify({ records, errors }, null, 2));
  console.log(JSON.stringify({ total:records.reduce((n,r)=>n+r.checks.length,0), failures:records.flatMap(r=>r.checks.filter(c=>c.failure || c.passed===false).map(c=>({scene:r.key,...c}))), errors }, null, 2));
  if (errors.length || records.some(r=>r.checks.some(c=>c.failure || c.passed===false))) process.exitCode=1;
} finally {
  let timer;
  try {
    await Promise.race([
      browser.close(),
      new Promise(resolve => { timer = setTimeout(() => { browser.process()?.kill(); resolve(); }, 10000); }),
    ]);
  } finally { clearTimeout(timer); }
}
