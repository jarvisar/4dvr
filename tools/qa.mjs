import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.env.QA_PORT || 4322);
const base = `http://127.0.0.1:${port}/`;
const candidates = {
  win32: ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'],
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
}[process.platform] || [];
const chrome = process.env.CHROME_PATH || candidates.find((candidate) => fs.existsSync(candidate));
if (!chrome) throw new Error('Chrome not found, set CHROME_PATH');
const env = { ...process.env, NO_SSL: '1', QA_BASE: base, CHROME_PATH: chrome };
const server = spawn(process.execPath, [path.join('node_modules', 'vite', 'bin', 'vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
});
server.stderr.on('data', (data) => process.stderr.write(data));
const results = [];
try {
  let ready = false;
  for (const start = Date.now(); Date.now() - start < 30000;) {
    if (server.exitCode !== null) throw new Error(`QA server exited with ${server.exitCode}`);
    try { ready = (await fetch(base)).ok; } catch { /* not ready */ }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('QA server did not start');
  for (const script of ['qa-runtime', 'qa-scenes', 'qa-scenes-deep', 'qa-scenes-math', 'qa-input', 'qa-ux', 'qa-ux-focus', 'qa-ux-navigation', 'qa-ux-camera']) {
    console.log(`\n${script}`);
    const start = Date.now();
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [`tools/${script}.mjs`], { env, stdio: 'inherit', windowsHide: true });
      child.once('error', reject);
      child.once('exit', (exitCode) => resolve(exitCode ?? 1));
    });
    results.push({ script, passed: code === 0, exitCode: code, seconds: (Date.now() - start) / 1000 });
  }
} finally {
  server.kill();
  fs.mkdirSync('smoke-artifacts', { recursive: true });
  fs.writeFileSync('smoke-artifacts/qa-suite.json', JSON.stringify(results, null, 2));
}
console.log(`\n${results.filter((result) => result.passed).length}/${results.length} QA suites passed`);
if (results.some((result) => !result.passed)) process.exitCode = 1;
