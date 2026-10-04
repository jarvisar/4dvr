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
    { key: 'quasicrystal', short: 'Quasicrystals', title: 'Quasicrystals', create: (app) => new QuasicrystalScene(app) },
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
if (touch) deskBtn.textContent = 'Explore with touch';
// On narrow or short screens (phones) the controls card and the menu would
// overlap or leave no room for the scene, so only one is open at a time
const cramped = () => window.innerWidth < 800 || window.innerHeight < 540;

const params = new URLSearchParams(location.search);
if (params.has('iwer')) {
  // WebXR emulation for testing and demos without a headset (see core/emulator.js)
  await import('./core/emulator.js')
    .then((m) => m.installEmulator(params.get('iwer')))
    .catch((e) => console.error('Could not load the WebXR emulator', e));
}

const app = new App($('app'), SCENES);
window.__app = app; // for debugging from the console and for tools/ci-smoke.mjs
app.menu.mountHud(hud);
const menuPanel = app.menu.hud.el;
menuPanel.id = 'hud-menu-panel';

let sceneLoadError = '';
function hudMessage(text = '') {
  const message = [sceneLoadError, text].filter(Boolean).join(' ');
  $('scene-load-status').textContent = message;
  $('retry-scenes').hidden = !sceneLoadError;
  $('hud-notice').hidden = false;
  measureHud();
  app.announce(message);
}

// --- scenes ---------------------------------------------------------------------
let pendingScene = null;
function requestScene(key) {
  if (SCENES.some((s) => s.key === key)) app.setScene(key);
  else pendingScene = key; // still loading
}

function renderTabs() {
  // the tabs are rebuilt, so a keyboard user's focus moves to the new scene's tab
  const hadFocus = tabs.contains(document.activeElement);
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
  // split the help string ("<b>Key</b> does something · ...") into one row per
  // control. A row that doesn't start with a key is a note, like what needs a mouse.
  helpList.innerHTML = (app.activeScene?.desktopHelp({ touch }) || '')
    .split(' · ')
    .map((item) => (item.startsWith('<b>') ? `<li>${item}</li>` : `<li class="note">${item}</li>`))
    .join('');
  markSelected((b) => b.dataset.scene === app.sceneKey);
  if (hadFocus) active?.focus({ preventScroll: true });
  if (active && !hud.hidden) {
    // keep the current scene's tab in view when the bar scrolls (phones)
    const t = tabs.getBoundingClientRect(), a = active.getBoundingClientRect();
    tabs.scrollLeft += a.left - t.left - (t.width - a.width) / 2;
  }
  updateTabFade();
  measureHud();
}

// marks the scene that's showing on the start screen's scene list, which is the one VR starts in
function markSelected(test) {
  for (const b of index.querySelectorAll('button')) {
    const on = test(b);
    b.classList.toggle('selected', on);
    if (on) b.setAttribute('aria-current', 'true');
    else b.removeAttribute('aria-current');
  }
}

function updateTabFade() {
  const max = tabs.scrollWidth - tabs.clientWidth;
  tabs.classList.toggle('more-left', max > 1 && tabs.scrollLeft > 1);
  tabs.classList.toggle('more-right', max > 1 && tabs.scrollLeft < max - 1);
}
tabs.addEventListener('scroll', updateTabFade, { passive: true });

// The menu panel fits between the tab bar and whatever is along the bottom
// edge (the Enter VR button, or the Menu and Help buttons on phones).
// style.css places it with these.
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
  const tabsBottom = Math.round(hudTop.getBoundingClientRect().bottom + 10);
  hud.style.setProperty('--hud-tabs-bottom', `${tabsBottom}px`);
  const notice = $('hud-notice');
  const top = notice.hidden ? tabsBottom : Math.round(notice.getBoundingClientRect().bottom + 10);
  hud.style.setProperty('--hud-top', `${top}px`);
  hud.style.setProperty('--hud-bottom', `${Math.round(H - bottom)}px`);
}
window.addEventListener('resize', () => {
  // a window made too small for both panels keeps the menu, without saving the help as closed
  if (cramped() && app.desktopMenu && !helpBox.classList.contains('closed')) setHelp(false, false);
  updateTabFade();
  measureHud();
});

// Screen readers get what's only shown in 3D. Not in VR, where there's no screen reader.
const announcer = $('announce');
app.onAnnounce = (text) => {
  if (app.presenting) return;
  announcer.textContent = '';
  setTimeout(() => { announcer.textContent = text; }, 50); // so the same message twice is read twice
};
app.renderer.domElement.setAttribute('role', 'img');

app.onSceneChanged = () => {
  renderTabs();
  const scene = app.activeScene;
  app.renderer.domElement.setAttribute('aria-label', `${scene.title}, 3D view. ${scene.subtitle}`);
  if (app.hudActive) app.announce(scene.title);
  const url = new URL(location.href);
  url.searchParams.set('scene', app.sceneKey);
  history.replaceState(null, '', url);
};

app.onSessionChange = (on) => {
  hud.hidden = on;
  app.hudActive = !on;
  if (on) {
    if (sceneLoadError) hudMessage();
    else $('hud-notice').hidden = true;
  }
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
}).catch((e) => {
  console.error('Failed to load scenes', e);
  const requested = pendingScene || initial;
  const message = 'The other scenes could not load. Check your connection and reload to try again.';
  sceneLoadError = message;
  hudMessage();
  note.textContent = message;
  for (const button of index.querySelectorAll('button')) button.disabled = button.dataset.scene !== 'playground';
  $('retry-scenes').onclick = () => {
    const url = new URL(location.href);
    url.searchParams.set('scene', requested);
    location.assign(url);
  };
});

// --- HUD toggles ------------------------------------------------------------------
function setHelp(open, save = true) {
  helpBox.classList.toggle('closed', !open);
  helpBtn.classList.toggle('on', open);
  helpBtn.setAttribute('aria-expanded', String(open));
  if (save) pref.set('help', open);
  if (open && cramped() && app.desktopMenu) app.setDesktopMenu(false);
}
app.onDesktopHelp = () => setHelp(helpBox.classList.contains('closed'));
helpBtn.onclick = app.onDesktopHelp;

function syncMenuButton(on) {
  menuBtn.classList.toggle('on', on);
  menuBtn.setAttribute('aria-expanded', String(on));
}
app.onDesktopMenuChanged = (on) => {
  syncMenuButton(on);
  if (on && cramped() && !helpBox.classList.contains('closed')) setHelp(false);
  if (!on && menuPanel.contains(document.activeElement)) menuBtn.focus({ preventScroll: true });
};
menuBtn.onclick = () => app.setDesktopMenu(!app.desktopMenu);
// Escape closes the menu when the keyboard is in it
hud.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !menuPanel.contains(e.target)) return;
  app.setDesktopMenu(false);
  menuBtn.focus();
});
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
// Chrome on Android phones offers VR through a phone viewer (Cardboard), where
// the controls here don't work well. Touch stays the main way in there.
const phone = /Android.*Mobile/i.test(navigator.userAgent) && !/VR|Quest|Pico|Wolvic/i.test(navigator.userAgent);
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
        : phone ? 'VR works with a phone viewer like Cardboard. Every scene also works with touch.'
          : 'Headset ready. Hands and controllers both work.', 'ok');
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
  const vrFirst = xrOk && !phone;
  vrBtn.classList.toggle('primary', vrFirst);
  deskBtn.classList.toggle('primary', !vrFirst);
  actions.classList.toggle('xr', vrFirst);
  hudVr.hidden = !xrOk;
  measureHud();
}
checkXR();
// a headset plugged in after the page loaded, like Quest Link on a PC
navigator.xr?.addEventListener?.('devicechange', checkXR);

let enteringVR = false;
const enterVR = async () => {
  if (enteringVR || app.presenting) return;
  const fromDesktop = app.hudActive;
  enteringVR = true;
  vrBtn.disabled = true;
  hudVr.disabled = true;
  try {
    await app.enterVR();
  } catch (e) {
    console.error(e);
    const message = `Could not start VR: ${e.message}. You can keep using desktop mode or try again.`;
    setStatus(message, 'off');
    if (fromDesktop) hudMessage(message);
    else overlay.classList.remove('hidden');
  } finally {
    enteringVR = false;
    vrBtn.disabled = !xrOk;
    hudVr.disabled = !xrOk;
  }
};
vrBtn.onclick = enterVR;
hudVr.onclick = enterVR;

// Sound can only start from a click or key press, so ?desktop leaves it for the first one
function enterDesktop(fromClick = true) {
  if (fromClick) app.audio.unlock();
  overlay.classList.add('hidden');
  hud.hidden = false;
  app.hudActive = true;
  renderTabs();
}
deskBtn.onclick = enterDesktop;
$('hud-home').onclick = () => {
  app.input.clearDesktop();
  app.activeScene?.walk?.clear();
  app.interaction.releaseAll();
  app.hudActive = false;
  hud.hidden = true;
  overlay.classList.remove('hidden');
  deskBtn.focus();
};

// Scene index. With a headset this picks the scene to enter VR in. Without one, or on a phone, it goes straight in.
index.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-scene]');
  if (!b) return;
  requestScene(b.dataset.scene);
  markSelected((x) => x === b);
  if (!xrOk || phone) enterDesktop();
});

if (params.has('desktop')) enterDesktop(false);
