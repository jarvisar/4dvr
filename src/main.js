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

let app;
try {
  app = new App(document.getElementById('app'), SCENES);
} catch (e) {
  document.getElementById('xr-note').textContent = `Could not start WebGL 2 (${e.message}). Try an up-to-date browser.`;
  throw e;
}
window.__app = app; // for debugging from the console and for tools/ci-smoke.mjs

const overlay = document.getElementById('overlay');
const hud = document.getElementById('hud');
const tabs = document.getElementById('scene-tabs');
const help = document.getElementById('hud-help');
const vrBtn = document.getElementById('enter-vr');
const hudVr = document.getElementById('hud-vr');
const note = document.getElementById('xr-note');

function renderTabs() {
  tabs.innerHTML = '';
  for (const s of SCENES) {
    const b = document.createElement('button');
    b.textContent = s.short;
    b.className = s.key === app.sceneKey ? 'active' : '';
    b.onclick = () => app.setScene(s.key);
    tabs.appendChild(b);
  }
  help.innerHTML = app.activeScene?.desktopHelp() || '';
}

app.onSceneChanged = () => {
  renderTabs();
  const url = new URL(location.href);
  url.searchParams.set('scene', app.sceneKey);
  history.replaceState(null, '', url);
};

app.onSessionChange = (on) => {
  hud.hidden = on;
  if (!on) overlay.classList.add('hidden');
};

const initial = new URLSearchParams(location.search).get('scene') || 'playground';
app.setScene('playground', true);
loadExtraScenes().then(() => {
  renderTabs();
  if (initial !== 'playground' && SCENES.some((s) => s.key === initial)) app.setScene(initial, true);
}).catch((e) => console.error('Failed to load scenes', e));

// --- WebXR availability -------------------------------------------------------
async function checkXR() {
  if (!('xr' in navigator)) {
    vrBtn.textContent = 'VR not available';
    note.textContent = window.isSecureContext
      ? 'This browser has no WebXR. Open the page in the Meta Quest Browser to enter VR.'
      : 'WebXR needs HTTPS. Serve over https (npm run dev does this) and open it on your headset.';
    return;
  }
  const ok = await navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
  if (ok) {
    vrBtn.disabled = false;
    vrBtn.textContent = 'Enter VR';
    hudVr.hidden = false;
    note.textContent = 'Supports hand tracking and controllers.';
  } else {
    vrBtn.textContent = 'No headset found';
    note.textContent = 'No VR headset detected. All scenes can also be used on desktop.';
  }
}
checkXR();

const enter = async () => {
  try {
    overlay.classList.add('hidden');
    await app.enterVR();
  } catch (e) {
    console.error(e);
    note.textContent = `Could not start VR: ${e.message}`;
    overlay.classList.remove('hidden');
  }
};
vrBtn.onclick = enter;
hudVr.onclick = enter;

document.getElementById('enter-desktop').onclick = () => {
  app.audio.unlock();
  overlay.classList.add('hidden');
  hud.hidden = false;
  renderTabs();
};

if (new URLSearchParams(location.search).has('desktop')) {
  overlay.classList.add('hidden');
  hud.hidden = false;
  renderTabs();
}
