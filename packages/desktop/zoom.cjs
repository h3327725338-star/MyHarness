// Page zoom of the desktop app: Ctrl + "+" / Ctrl + "-" / Ctrl + 0 and Ctrl + mouse wheel, in the app's own window and
// in every website tab of the built-in browser. The window has no menu (window.setMenu(null)), so Chromium's own zoom
// accelerators are gone and the host provides them. Steps follow Chrome's zoom levels. The app window keeps one zoom
// (desktop-prefs.json); a website keeps its zoom per host, as in Chrome (browser-zoom.json in the host profile).
const { readFileSync, writeFileSync, renameSync } = require('node:fs');

const LEVELS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const MIN = LEVELS[0];
const MAX = LEVELS[LEVELS.length - 1];

/** A zoom factor within the supported range, or 1 for anything that is not a usable number. */
function cleanZoom(value) {
  const factor = Number(value);
  if (!Number.isFinite(factor) || factor <= 0) return 1;
  return Math.min(MAX, Math.max(MIN, Math.round(factor * 100) / 100));
}

/** The next level from `current`: `direction` 1 zooms in, -1 out, 0 resets to 100 %. */
function stepZoom(current, direction) {
  if (direction === 0) return 1;
  const factor = cleanZoom(current);
  if (direction > 0) return LEVELS.find((level) => level > factor + 0.001) ?? MAX;
  return [...LEVELS].reverse().find((level) => level < factor - 0.001) ?? MIN;
}

/**
 * The zoom command of a key press (Electron `before-input-event` input): 1 for Ctrl + "=" / "+" (main keyboard or
 * numpad), -1 for Ctrl + "-", 0 for Ctrl + "0"; undefined for anything else. Alt combinations are left alone.
 */
function zoomKey(input) {
  if (!input || input.type !== 'keyDown' || !(input.control || input.meta) || input.alt) return undefined;
  const key = String(input.key || '');
  const code = String(input.code || '');
  if (key === '+' || key === '=' || code === 'Equal' || code === 'NumpadAdd') return 1;
  if (key === '-' || key === '_' || code === 'Minus' || code === 'NumpadSubtract') return -1;
  if (key === '0' || code === 'Digit0' || code === 'Numpad0') return 0;
  return undefined;
}

/**
 * Makes `contents` zoomable by keyboard and Ctrl + wheel. `apply(factor)` sets and remembers the new factor (and may
 * tell the page); `current()` reads the factor in force.
 */
function attachZoom(contents, { current, apply }) {
  contents.on('before-input-event', (event, input) => {
    const direction = zoomKey(input);
    if (direction === undefined) return;
    event.preventDefault();
    apply(stepZoom(current(), direction));
  });
  // Ctrl + wheel (and a touchpad pinch) arrives as a direction; without a handler Electron does nothing.
  contents.on('zoom-changed', (_event, direction) => apply(stepZoom(current(), direction === 'in' ? 1 : -1)));
}

/** Zoom factors of websites by host name, kept in `file`; 100 % is the absence of an entry. */
function createSiteZoomStore(file, log) {
  const read = () => {
    const next = {};
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved && typeof saved.sites === 'object') {
        for (const [host, factor] of Object.entries(saved.sites)) if (typeof host === 'string' && host) next[host] = cleanZoom(factor);
      }
    } catch { /* missing or unreadable: every site at 100 % */ }
    return next;
  };
  let sites = read();
  let timer;
  let pending = false;
  const save = () => {
    clearTimeout(timer);
    pending = true;
    timer = setTimeout(() => {
      pending = false;
      try {
        const temp = `${file}.tmp`;
        writeFileSync(temp, JSON.stringify({ version: 1, sites }, null, 2));
        renameSync(temp, file);
      } catch (error) { log?.(`无法保存网页缩放：${error.message}`); }
    }, 300);
    timer.unref?.();
  };
  const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };
  return {
    get: (url) => sites[hostOf(url)] ?? 1,
    /** Read the file again (browser sync wrote it); a change of this computer still waiting to be saved wins. */
    reload() { if (!pending) sites = read(); },
    set(url, factor) {
      const host = hostOf(url);
      if (!host) return;
      const value = cleanZoom(factor);
      if (value === 1) delete sites[host]; else sites[host] = value;
      sites = { ...sites };
      save();
    },
  };
}

module.exports = { LEVELS, cleanZoom, stepZoom, zoomKey, attachZoom, createSiteZoomStore };
