// Graphics quality presets. On standalone headsets the GPU cost is mostly the
// number of pixels shaded, so the presets trade render resolution and foveation.
//
// resolution: fraction of the display's native resolution in VR (see App._xrScale),
//   and of the device pixel ratio (up to 2) on desktop.
// foveation: fixed foveation in VR, 0 (off) to 1 (high). The edges of the view are
//   rendered at lower resolution, where the lenses blur them anyway.
// shadows: the 4D shadows on the Hyperplay table.
//
// Antialiasing (4x MSAA) is always on. It is cheap on the Quest's tiled GPU and
// can't be changed without recreating the WebGL context.
export const QUALITY = {
  low: { label: 'Low', resolution: 0.6, foveation: 1, shadows: false },
  medium: { label: 'Medium', resolution: 0.8, foveation: 0.33, shadows: true },
  high: { label: 'High', resolution: 1, foveation: 0, shadows: true },
};

const KEY = '4dvr.quality';

/** The saved preset, or medium on the Quest 1 and 2 and high elsewhere. */
export function initialQuality() {
  try {
    const saved = localStorage.getItem(KEY);
    if (QUALITY[saved]) return saved;
  } catch { /* storage unavailable (private mode) */ }
  return /Quest( [12])?[;)]/.test(navigator.userAgent) ? 'medium' : 'high';
}

export function saveQuality(key) {
  try { localStorage.setItem(KEY, key); } catch { /* ignore */ }
}
