// Small per-browser preferences. Storage can be unavailable (private mode),
// in which case the defaults are used and nothing is saved.

const PREFIX = '4dvr.';

export const pref = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(PREFIX + key);
      return v === null ? fallback : v === '1';
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(PREFIX + key, value ? '1' : '0'); } catch { /* ignore */ }
  },
  // Saved list of strings, e.g. the scenes whose tips have been shown
  list(key) {
    try { return new Set((localStorage.getItem(PREFIX + key) || '').split(',').filter(Boolean)); } catch { return new Set(); }
  },
  setList(key, set) {
    try { localStorage.setItem(PREFIX + key, [...set].join(',')); } catch { /* ignore */ }
  },
};

// Auto-rotation starts off for visitors who ask for reduced motion (desktop browsers report this)
export const REDUCED_MOTION = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
