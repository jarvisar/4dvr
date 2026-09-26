import { App } from './core/app.js';
import { PlaygroundScene } from './scenes/playground.js';

const SCENES = [
  { key: 'playground', short: 'Hyperplay', create: (app) => new PlaygroundScene(app) },
];

async function loadExtraScenes() {
  // Other scenes are loaded separately so the first one starts sooner.
  const [{ GalleryScene }, { KnotScene }, { HopfScene }, { HyperbolicScene }] = await Promise.all([
    import('./scenes/gallery.js'),
    import('./scenes/knots.js'),
    import('./scenes/hopf.js'),
    import('./scenes/hyperbolic.js'),
  ]);
  SCENES.push(
    { key: 'gallery', short: 'Polytopes', create: (app) => new GalleryScene(app) },
    { key: 'knots', short: 'Knots', create: (app) => new KnotScene(app) },
    { key: 'hopf', short: 'Hopf', create: (app) => new HopfScene(app) },
    { key: 'hyperbolic', short: 'Hyperbolic', create: (app) => new HyperbolicScene(app) },
  );
}

const $ = (id) => document.getElementById(id);
const overlay = $('overlay');
const hud = $('hud');
const tabs = $('scene-tabs');
const helpBox = $('hud-help');
const helpList = $('hud-help-list');
const hudId = $('hud-id');
const menuBtn = $('hud-menu');
const helpBtn = $('hud-help-toggle');
const statsEl = $('hud-stats');
const vrBtn = $('enter-vr');
const deskBtn = $('enter-desktop');
const hudVr = $('hud-vr');
const note = $('xr-note');
const status = $('xr-status');
const statusText = $('xr-status-text');
const index = $('scene-index');

let app;
try {
  app = new App($('app'), SCENES);
} catch (e) {
  note.textContent = `Could not start WebGL 2 (${e.message}). Try an up-to-date browser.`;
  throw e;
}
window.__app = app; // for debugging from the console and for tools/ci-smoke.mjs

// small per-browser preferences; storage can be unavailable (private mode)
const pref = {
  get(k, d) { try { const v = localStorage.getItem(`4dvr.${k}`); return v === null ? d : v === '1'; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`4dvr.${k}`, v ? '1' : '0'); } catch { /* ignore */ } },
};

// --- scenes ---------------------------------------------------------------------
let pendingScene = null;
function requestScene(key) {
  if (SCENES.some((s) => s.key === key)) app.setScene(key);
  else pendingScene = key; // still loading
}

function renderTabs() {
  tabs.innerHTML = '';
  SCENES.forEach((s, i) => {
    const b = document.createElement('button');
    b.innerHTML = `<i>${i + 1}</i>${s.short}`;
    b.title = `${s.short} (${i + 1})`;
    b.className = s.key === app.sceneKey ? 'active' : '';
    b.onclick = () => app.setScene(s.key);
    tabs.appendChild(b);
  });
  const i = SCENES.findIndex((s) => s.key === app.sceneKey);
  hudId.innerHTML = `Scene <b>${String(i + 1).padStart(2, '0')}</b> · ${app.activeScene?.title || ''}`;
  // "<b>Key</b> does something · …" → one row per control
  helpList.innerHTML = (app.activeScene?.desktopHelp() || '')
    .split(' · ')
    .map((item) => `<li>${item}</li>`)
    .join('');
  for (const b of index.querySelectorAll('button')) b.classList.toggle('selected', b.dataset.scene === app.sceneKey);
}

app.onSceneChanged = () => {
  renderTabs();
  const url = new URL(location.href);
  url.searchParams.set('scene', app.sceneKey);
  history.replaceState(null, '', url);
};

app.onSessionChange = (on) => {
  hud.hidden = on;
  app.hudActive = !on;
  if (!on) overlay.classList.add('hidden');
};

const initial = new URLSearchParams(location.search).get('scene') || 'playground';
app.setScene('playground', true);
loadExtraScenes().then(() => {
  renderTabs();
  app.menu.rebuild(); // the VR menu's scene tabs
  const key = pendingScene || initial;
  pendingScene = null;
  if (key !== 'playground' && SCENES.some((s) => s.key === key)) app.setScene(key, true);
}).catch((e) => console.error('Failed to load scenes', e));

// --- HUD toggles ------------------------------------------------------------------
function setHelp(open) {
  helpBox.classList.toggle('closed', !open);
  helpBtn.classList.toggle('on', open);
  pref.set('help', open);
}
app.onDesktopHelp = () => setHelp(helpBox.classList.contains('closed'));
helpBtn.onclick = app.onDesktopHelp;
setHelp(pref.get('help', window.innerWidth >= 720));

app.onDesktopMenuChanged = (on) => menuBtn.classList.toggle('on', on);
menuBtn.onclick = () => app.setDesktopMenu(!app.desktopMenu);
menuBtn.classList.toggle('on', app.desktopMenu);

if (app.statsEnabled) {
  statsEl.hidden = false;
  app.onStats = () => { statsEl.textContent = app.statsText; };
}

// --- WebXR availability -------------------------------------------------------
let xrOk = false;
function setStatus(text, state) {
  statusText.textContent = text;
  status.className = `status ${state}`;
}
setStatus('Checking headset', 'pending');

async function checkXR() {
  if (!('xr' in navigator)) {
    setStatus('No WebXR', 'off');
    note.textContent = window.isSecureContext
      ? 'This browser has no WebXR. Open the page in the Meta Quest Browser to enter VR.'
      : 'WebXR needs HTTPS. Serve over https (npm run dev does this) and open it on your headset.';
  } else {
    xrOk = await navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
    if (xrOk) {
      setStatus('Headset ready', 'ok');
      note.textContent = 'Hand tracking and controllers are both supported.';
      hudVr.hidden = false;
    } else {
      setStatus('No headset', 'off');
      note.textContent = 'No VR headset detected. Every scene also works with a mouse and keyboard.';
    }
  }
  // the available path is the primary action
  vrBtn.disabled = !xrOk;
  vrBtn.textContent = xrOk ? 'Enter VR' : 'VR unavailable';
  vrBtn.classList.toggle('primary', xrOk);
  deskBtn.classList.toggle('primary', !xrOk);
}
checkXR();

const enterVR = async () => {
  try {
    overlay.classList.add('hidden');
    await app.enterVR();
  } catch (e) {
    console.error(e);
    note.textContent = `Could not start VR: ${e.message}`;
    overlay.classList.remove('hidden');
  }
};
vrBtn.onclick = enterVR;
hudVr.onclick = enterVR;

function enterDesktop() {
  app.audio.unlock();
  overlay.classList.add('hidden');
  hud.hidden = false;
  app.hudActive = true;
  renderTabs();
}
deskBtn.onclick = enterDesktop;

// Scene index: with a headset, pick the scene to enter VR in; without one, go straight in.
index.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-scene]');
  if (!b) return;
  requestScene(b.dataset.scene);
  for (const x of index.querySelectorAll('button')) x.classList.toggle('selected', x === b);
  if (!xrOk) enterDesktop();
});

if (new URLSearchParams(location.search).has('desktop')) enterDesktop();
