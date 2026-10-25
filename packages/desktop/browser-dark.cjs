// Dark mode for websites in the built-in browser, the way the Dark Reader extension does it: Dark Reader's own engine
// (npm package `darkreader`, MIT) runs in each tab's isolated world and recolors the page from its real styles, instead
// of inverting the picture. The isolated world (999) is the one of browser-tab-preload.cjs: the site's own scripts can
// neither see the engine nor call the fetch bridge the preload gives it. Cross-origin stylesheets and images, which the
// engine must read to recolor them, are fetched by the host through the tab's own session, so CORS does not leave half
// of a page white. Only the top document is recolored; an embedded frame keeps its own colors.
// A site with a dark theme of its own is shown in that theme instead: the host tells the tab the reader prefers dark
// (`prefers-color-scheme`), and the engine runs only when the page stays light (detectNativeDark).
const { readFileSync, writeFileSync, renameSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const WORLD = 999;
const MODES = ['auto', 'on', 'off'];
const MAX_FETCH_BYTES = 12 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;

let source;
/** The engine's script text (read once). The packaged app carries it in its runtime folder (see build.mjs). */
function engineSource() {
  if (source !== undefined) return source;
  const candidates = [];
  try { candidates.push(require.resolve('darkreader/darkreader.js')); } catch { /* not installed beside the host */ }
  candidates.push(join(__dirname, 'runtime', 'node_modules', 'darkreader', 'darkreader.js'));
  for (const file of candidates) {
    try { if (existsSync(file)) { source = readFileSync(file, 'utf8'); return source; } } catch { /* try the next one */ }
  }
  source = '';
  return source;
}

/**
 * The user's choice, kept in the host profile: `mode` "auto" (dark while the app itself is dark), "on" or "off", and
 * sites (by host name) where it is turned the other way.
 */
function createDarkStore(file, log) {
  let state = { mode: 'auto', sites: {} };
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    if (MODES.includes(saved?.mode)) state.mode = saved.mode;
    if (saved?.sites && typeof saved.sites === 'object')
      for (const [host, value] of Object.entries(saved.sites)) if (host && (value === 'on' || value === 'off')) state.sites[host] = value;
  } catch { /* missing or unreadable: follow the app */ }
  const save = () => {
    if (!file) return;
    try {
      const temp = `${file}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: 1, ...state }, null, 2));
      renameSync(temp, file);
    } catch (error) { log?.(`无法保存网页深色模式设置：${error.message}`); }
  };
  const hostOf = (url) => { try { const parsed = new URL(url); return /^https?:$/u.test(parsed.protocol) ? parsed.host : ''; } catch { return ''; } };
  return {
    get: () => ({ mode: state.mode, sites: { ...state.sites } }),
    hostOf,
    /** Whether `url` is shown dark, given whether the app itself is dark right now. */
    wanted(url, appDark) {
      const host = hostOf(url);
      if (!host) return false;
      const site = state.sites[host];
      if (site) return site === 'on';
      return state.mode === 'on' || (state.mode === 'auto' && appDark);
    },
    setMode(mode) {
      if (!MODES.includes(mode)) throw new Error('未知的深色模式');
      state = { ...state, mode };
      save();
    },
    /** Turn one site the other way from the general mode; `value` undefined follows the general mode again. */
    setSite(url, value) {
      const host = hostOf(url);
      if (!host) throw new Error('这个页面不能设置深色模式');
      const sites = { ...state.sites };
      if (value === 'on' || value === 'off') sites[host] = value; else delete sites[host];
      state = { ...state, sites };
      save();
    },
  };
}

/** Dark Reader's theme, in the app's own colors when the page gave them. */
function themeFor(colors) {
  const color = (value, fallback) => (typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value) ? value : fallback);
  return {
    mode: 1,
    brightness: 100,
    contrast: 95,
    sepia: 0,
    darkSchemeBackgroundColor: color(colors?.background, '#1e1f1f'),
    darkSchemeTextColor: color(colors?.text, '#e3e3e3'),
  };
}

/** Recolor (or restore) one page. Resolves true when the engine is running afterwards. */
async function applyDark(contents, enabled, colors) {
  if (!contents || contents.isDestroyed()) return false;
  const code = engineSource();
  if (!code) return false;
  const theme = JSON.stringify(themeFor(colors));
  const run = enabled
    ? `(() => {
        const bridge = globalThis.__myharnessDarkFetch;
        if (bridge) {
          const load = async (url) => {
            const answer = await bridge(String(url));
            if (!answer || !answer.ok) throw new Error('无法读取 ' + url);
            return answer;
          };
          const bytes = (answer) => Uint8Array.from(atob(answer.body), (c) => c.charCodeAt(0));
          // Every stylesheet or image of another origin goes through the host (the engine's own fetch skips some hosts).
          DarkReader.Plugins = {
            fetch: async (request) => {
              const answer = await load(request.url);
              return request.responseType === 'data-url'
                ? 'data:' + (answer.type || request.mimeType || 'application/octet-stream').split(';')[0] + ';base64,' + answer.body
                : new TextDecoder().decode(bytes(answer));
            },
          };
          DarkReader.setFetchMethod(async (url) => {
            const answer = await load(url);
            return new Response(bytes(answer), { status: answer.status, headers: { 'content-type': answer.type || '' } });
          });
        }
        DarkReader.enable(${theme});
        return DarkReader.isEnabled();
      })()`
    : `(() => { if (globalThis.DarkReader) DarkReader.disable(); return false; })()`;
  // One script: the engine is defined once per document, then turned on or off; its value is the script's result.
  const script = enabled ? `if (!globalThis.DarkReader) {
${code}
}
${run}` : run;
  try {
    return (await contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: script }])) === true;
  } catch {
    return false;
  }
}

/**
 * Whether the page, told that the reader prefers dark (`prefers-color-scheme: dark`, emulated per tab by the host), now
 * shows its own dark theme. Then the site's design is kept and Dark Reader stays off. It waits briefly for stylesheets
 * that are still loading, sets the preload's dark canvas aside for one synchronous read (no frame is painted in between)
 * and looks at the color behind the middle of the page and the top bar, falling back to the root's `color-scheme`.
 */
const NATIVE_DARK = `(async () => {
  const sheets = [...document.querySelectorAll('link[rel~="stylesheet"]')].filter((link) => !link.sheet && !link.disabled);
  if (sheets.length) {
    await Promise.race([
      Promise.all(sheets.map((link) => new Promise((done) => { link.addEventListener('load', done, { once: true }); link.addEventListener('error', done, { once: true }); }))),
      new Promise((done) => setTimeout(done, 1500)),
    ]);
  }
  const canvas = globalThis.__myharnessDarkCanvas?.sheet;
  if (canvas) canvas.disabled = true;
  try {
    const paint = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
    const rgba = (value) => {
      if (!value || value === 'transparent') return null;
      paint.clearRect(0, 0, 1, 1);
      paint.fillStyle = '#00000000';
      paint.fillStyle = value;
      paint.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
      return a < 128 ? null : { r, g, b };
    };
    const luminance = ({ r, g, b }) => {
      const channel = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const behind = (element) => {
      for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
        const color = rgba(getComputedStyle(node).backgroundColor);
        if (color) return color;
      }
      return null;
    };
    const root = document.documentElement;
    const scheme = ((getComputedStyle(root).colorScheme || '') + ' ' + (document.querySelector('meta[name="color-scheme"]')?.content || '')).replace(/,/g, ' ');
    const canvasDark = scheme.split(' ').includes('dark');
    const width = innerWidth || root.clientWidth;
    const height = innerHeight || root.clientHeight;
    const probes = [[width / 2, height / 2], [width / 2, Math.min(24, height / 4)]]
      .map(([x, y]) => document.elementFromPoint(x, y))
      .filter(Boolean);
    const colors = probes.map(behind);
    const votes = colors.map((color) => (color ? luminance(color) < 0.2 : canvasDark));
    if (!votes.length) votes.push(behind(document.body) ? luminance(behind(document.body)) < 0.2 : canvasDark);
    return votes.every(Boolean);
  } catch {
    return false;
  } finally {
    if (canvas) canvas.disabled = false;
  }
})()`;

/**
 * The dark canvas a page wears while it loads (see browser-view.cjs) is a <style> element kept in the isolated world as
 * `__myharnessDarkCanvas`: the preload puts it in before the first paint, the host puts it in if the preload did not, and
 * the host takes it out again. Not `insertCSS`: in this Electron `removeInsertedCSS` leaves the rules in force, so a page
 * kept the canvas color for good after its colors were settled.
 */
async function putCanvas(contents, css) {
  if (!contents || contents.isDestroyed()) return;
  const code = `(() => {
    if (globalThis.__myharnessDarkSettled || !document.documentElement) return;
    // The preload's element may exist and still wait for the document to have a root: it goes in now.
    let style = globalThis.__myharnessDarkCanvas;
    if (!style) {
      style = document.createElement('style');
      style.textContent = ${JSON.stringify(css)};
      globalThis.__myharnessDarkCanvas = style;
    }
    if (!style.isConnected) (document.head || document.documentElement).append(style);
  })()`;
  try { await contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]); } catch { /* page is going away */ }
}

async function dropCanvas(contents) {
  if (!contents || contents.isDestroyed()) return;
  const code = '(() => { globalThis.__myharnessDarkSettled = true; globalThis.__myharnessDarkCanvas?.remove(); globalThis.__myharnessDarkCanvas = null; })()';
  try { await contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code }]); } catch { /* page is going away */ }
}

/** Resolves true when the page shows its own dark theme (see NATIVE_DARK). */
async function detectNativeDark(contents) {
  if (!contents || contents.isDestroyed()) return false;
  try {
    return (await contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: NATIVE_DARK }])) === true;
  } catch {
    return false;
  }
}

/**
 * The bridge's other end: a GET through the tab's own session (its cookies, no CORS), for the stylesheets and images
 * the engine reads. Only web addresses, bounded in time and size; the body travels as base64.
 */
async function darkFetch(session, url) {
  let target;
  try { target = new URL(String(url)); } catch { return { ok: false, status: 0 }; }
  if (!/^https?:$/u.test(target.protocol)) return { ok: false, status: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await session.fetch(target.href, { signal: controller.signal, credentials: 'include' });
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MAX_FETCH_BYTES) return { ok: false, status: 413 };
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_FETCH_BYTES) return { ok: false, status: 413 };
    return { ok: response.ok, status: response.status, type: response.headers.get('content-type') || '', body: buffer.toString('base64') };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { MODES, createDarkStore, applyDark, detectNativeDark, putCanvas, dropCanvas, darkFetch, engineSource, themeFor };
