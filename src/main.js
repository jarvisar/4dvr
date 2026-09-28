import { App } from './core/app.js';
import { pref } from './core/prefs.js';
import { PlaygroundScene } from './scenes/playground.js';
import { prebuildShapes } from './four/shapes.js';

const SCENES = [
  { key: 'playground', short: 'Hyperplay', title: 'Hyperplay', create: (app) => new PlaygroundScene(app) },
];

async function loadExtraScenes() {
  // Other scenes are loaded separately so the first one starts sooner.
  const [{ GalleryScene }, { KnotScene }, { HopfScene }, { HyperbolicScene }, { SphericalScene }, { KleinScene }, { QuasicrystalScene }] = await Promise.all([
    import('./scenes/gallery.js'),
    import('./scenes/knots.js'),
    import('./scenes/hopf.js'),
    import('./scenes/hyperbolic.js'),
    import('./scenes/spherical.js'),
    import('./scenes/klein.js'),
    import('./scenes/quasicrystal.js'),
  ]);
  SCENES.push(
    { key: 'gallery', short: 'Polytopes', title: 'Polytope Lab', create: (app) => new GalleryScene(app) },
    { key: 'knots', short: 'Knots', title: 'Knot Lab', create: (app) => new KnotScene(app) },
    { key: 'hopf', short: 'Hopf', title: 'Hopf Garden', create: (app) => new HopfScene(app) },
    { key: 'hyperbolic', short: 'Hyperbolic', title: 'Hyperbolic Space', create: (app) => new HyperbolicScene(app) },
    { key: 'spherical', short: 'Spherical', title: 'Spherical Space', create: (app) => new SphericalScene(app) },
    { key: 'klein', short: 'Klein', title: 'Klein Room', create: (app) => new KleinScene(app) },
    { key: 'quasicrystal', short: 'Penrose', title: 'Quasicrystals', create: (app) => new QuasicrystalScene(app) },
  );
}

const $ = (id) => document.getElementById(id);
const overlay = $('overlay');
const hud = $('hud');
const hudTop = hud.querySelector('.hud-top');
const tabs = $('scene-tabs');
const helpBox = $('hud-help');
const helpList = $('hud-help-list');
const menuBtn = $('hud-menu');
const helpBtn = $('hud-help-toggle');
const toolsEl = hud.querySelector('.hud-tools');
const statsEl = $('hud-stats');
const vrBtn = $('enter-vr');
const deskBtn = $('enter-desktop');
const hudVr = $('hud-vr');
const actions = $('actions');
const status = $('xr-status');
const note = $('xr-note');
const index = $('scene-index');

// touch screens get touch instructions in the controls card
const touch = matchMedia('(hover: none) and (pointer: coarse)').matches;
// below this width the controls card and the menu would overlap, so only one is open at a time
const cramped = () => window.innerWidth < 800;

const params = new URLSearchParams(location.search);
if (params.has('iwer')) {
  // WebXR emulation for testing and demos without a headset (see core/emulator.js)
  await import('./core/emulator.js')
    .then((m) => m.installEmulator(params.get('iwer')))
    .catch((e) => console.error('Could not load the WebXR emulator', e));
}

let app;
try {
  app = new App($('app'), SCENES);
} catch (e) {
  note.textContent = `Could not start WebGL 2 (${e.message}). Try an up-to-date browser.`;
  throw e;
}
window.__app = app; // for debugging from the console and for tools/ci-smoke.mjs

// --- scenes ---------------------------------------------------------------------
let pendingScene = null;
function requestScene(key) {
  if (SCENES.some((s) => s.key === key)) app.setScene(key);
  else pendingScene = key; // still loading
}

function renderTabs() {
  tabs.innerHTML = '';
  let active = null;
  SCENES.forEach((s, i) => {
    const b = document.createElement('button');
    b.innerHTML = `<i>${i + 1}</i>${s.short}`;
    b.title = `${s.short} (${i + 1})`;
    if (s.key === app.sceneKey) {
      b.className = 'active';
      b.setAttribute('aria-current', 'true');
      active = b;
    }
    b.onclick = () => app.setScene(s.key);
    tabs.appendChild(b);
  });
  // split the help string ("<b>Key</b> does something · ...") into one row per control
  helpList.innerHTML = (app.activeScene?.desktopHelp({ touch }) || '')
    .split(' · ')
    .map((item) => `<li>${item}</li>`)
    .join('');
  markSelected((b) => b.dataset.scene === app.sceneKey);
  if (active && !hud.hidden) {
    // keep the current scene's tab in view when the bar scrolls (phones)
    const t = tabs.getBoundingClientRect(), a = active.getBoundingClientRect();
    tabs.scrollLeft += a.left - t.left - (t.width - a.width) / 2;
  }
  updateTabFade();
  measureHud();
}

// marks the scene VR will start in on the start screen's scene list
function markSelected(test) {
  for (const b of index.querySelectorAll('button')) {
    const on = test(b);
    b.classList.toggle('selected', on);
    b.setAttribute('aria-pressed', String(on));
  }
}

function updateTabFade() {
  const max = tabs.scrollWidth - tabs.clientWidth;
  tabs.classList.toggle('more-left', max > 1 && tabs.scrollLeft > 1);
  tabs.classList.toggle('more-right', max > 1 && tabs.scrollLeft < max - 1);
}
tabs.addEventListener('scroll', updateTabFade, { passive: true });

// The desktop menu is drawn in the 3D canvas. Tell it where the HTML controls
// are so it fits between them.
function measureHud() {
  if (hud.hidden) return;
  const H = window.innerHeight;
  const edge = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--edge')) || 16;
  let bottom = H - edge;
  for (const el of [hudVr, toolsEl]) {
    if (el.hidden) continue;
    const r = el.getBoundingClientRect();
    if (r.height && r.top > H / 2) bottom = Math.min(bottom, r.top - 10);
  }
  app.hudInsets = { top: hudTop.getBoundingClientRect().bottom + 10, bottom: H - bottom, right: edge };
}
window.addEventListener('resize', () => { updateTabFade(); measureHud(); });

app.onSceneChanged = () => {
  renderTabs();
  const url = new URL(location.href);
  url.searchParams.set('scene', app.sceneKey);
  history.replaceState(null, '', url);
};

app.onSessionChange = (on) => {
  hud.hidden = on;
  app.hudActive = !on;
  overlay.classList.add('hidden'); // also when a session starts without the Enter VR button
  if (!on) renderTabs();
};

const initial = params.get('scene') || 'playground';
app.setScene('playground', true);
loadExtraScenes().then(() => {
  renderTabs();
  app.menu.rebuild(); // the VR menu's scene tabs
  const key = pendingScene || initial;
  pendingScene = null;
  if (key !== 'playground' && SCENES.some((s) => s.key === key)) app.setScene(key, true);
  // Build the remaining 4D shapes and upload them to the GPU in idle time. This
  // only runs before VR starts. In the headset they're built on first use instead.
  prebuildShapes(() => !app.presenting, (shape) => {
    if (shape.tetMesh) app.renderer.initTexture(shape.tetMesh.texture);
  });
  // Compile the shaders of things that are hidden until VR (tracked hands,
  // pointer rays, the comfort vignette, the scene fade) now, so they don't
  // stall the headset the first time they appear.
  if (!app.presenting) app.renderer.compileAsync(app.scene, app.camera).catch(() => {});
}).catch((e) => console.error('Failed to load scenes', e));

// --- HUD toggles ------------------------------------------------------------------
function setHelp(open) {
  helpBox.classList.toggle('closed', !open);
  helpBtn.classList.toggle('on', open);
  helpBtn.setAttribute('aria-pressed', String(open));
  pref.set('help', open);
  if (open && cramped() && app.desktopMenu) app.setDesktopMenu(false);
}
app.onDesktopHelp = () => setHelp(helpBox.classList.contains('closed'));
helpBtn.onclick = app.onDesktopHelp;

function syncMenuButton(on) {
  menuBtn.classList.toggle('on', on);
  menuBtn.setAttribute('aria-pressed', String(on));
}
app.onDesktopMenuChanged = (on) => {
  syncMenuButton(on);
  if (on && cramped() && !helpBox.classList.contains('closed')) setHelp(false);
};
menuBtn.onclick = () => app.setDesktopMenu(!app.desktopMenu);
// A button clicked with the mouse gives up focus, so Space and Enter go to the
// scene afterwards instead of clicking it again (detail is 0 for keyboard clicks).
hud.addEventListener('click', (e) => { if (e.detail > 0) e.target.closest('button')?.blur(); });
syncMenuButton(app.desktopMenu);
setHelp(pref.get('help', !cramped()));

if (app.statsEnabled) {
  statsEl.hidden = false;
  app.onStats = () => { statsEl.textContent = app.statsText; };
}

// --- WebXR availability -------------------------------------------------------
let xrOk = false;
function setStatus(text, state) {
  note.textContent = text;
  status.className = `status ${state}`;
}

async function checkXR() {
  if (!('xr' in navigator)) {
    setStatus(window.isSecureContext
      ? 'This browser has no WebXR. Open the page in the Meta Quest Browser to use VR.'
      : 'WebXR needs HTTPS. Open the https:// address (npm run dev serves it) on your headset.', 'off');
  } else {
    xrOk = await navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
    if (xrOk) {
      setStatus(params.has('iwer')
        ? 'Emulated headset (IWER). Use the emulator controls to move the headset, controllers and hands.'
        : 'Headset ready. Hands and controllers both work.', 'ok');
      hudVr.hidden = false;
    } else {
      setStatus('No VR headset found. Every scene also works with a mouse, keyboard or touch.', 'off');
    }
  }
  if (!xrOk && window.isSecureContext && !params.has('iwer')) {
    // offer the in-browser headset emulator for demos
    const url = new URL(location.href);
    url.searchParams.set('iwer', '');
    const a = document.createElement('a');
    a.href = url.search.replace('iwer=', 'iwer');
    a.textContent = 'Try the VR emulator';
    note.append(' ', a);
  }
  vrBtn.disabled = !xrOk;
  vrBtn.textContent = xrOk ? 'Enter VR' : 'VR unavailable';
  vrBtn.classList.toggle('primary', xrOk);
  deskBtn.classList.toggle('primary', !xrOk);
  actions.classList.toggle('no-xr', !xrOk);
  measureHud();
}
checkXR();

const enterVR = async () => {
  try {
    overlay.classList.add('hidden');
    await app.enterVR();
  } catch (e) {
    console.error(e);
    setStatus(`Could not start VR: ${e.message}`, 'off');
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

// Scene index. With a headset this picks the scene to enter VR in. Without one it goes straight in.
index.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-scene]');
  if (!b) return;
  requestScene(b.dataset.scene);
  markSelected((x) => x === b);
  if (!xrOk) enterDesktop();
});

if (params.has('desktop')) enterDesktop();
