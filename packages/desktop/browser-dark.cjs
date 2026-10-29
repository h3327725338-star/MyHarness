// Dark mode for websites in the built-in browser, the way the Dark Reader extension does it: Dark Reader's own engine
// (npm package `darkreader`, MIT) runs in each tab's isolated world and recolors the page from its real styles, instead
// of inverting the picture. The isolated world (999) is the one of browser-tab-preload.cjs: the site's own scripts can
// neither see the engine nor call the fetch bridge the preload gives it. Cross-origin stylesheets and images, which the
// engine must read to recolor them, are fetched by the host through the tab's own session, so CORS does not leave half
// of a page white. Frames of the page's own site (the Google account menu over Gmail, for one) share its renderer and
// are recolored too, each in its own isolated world (applyDarkToFrames); a frame of another site runs in another process
// and keeps its own colors.
// A site with a dark theme of its own is shown in that theme instead: the host tells the tab the reader prefers dark
// (`prefers-color-scheme`), and the engine runs only when the page stays light (detectNativeDark).
const { readFileSync, writeFileSync, renameSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const WORLD = 999;
const MODES = ['auto', 'on', 'off'];
const MAX_FETCH_BYTES = 12 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;
const HEX_COLOR = /^#[0-9a-f]{6}$/iu;
/** Dark Reader's own default page darkness (#181a1b); see pageBackground. */
const MAX_PAGE_LIGHTNESS = 0.1;

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
  const read = () => {
    const next = { mode: 'auto', sites: {} };
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (MODES.includes(saved?.mode)) next.mode = saved.mode;
      if (saved?.sites && typeof saved.sites === 'object')
        for (const [host, value] of Object.entries(saved.sites)) if (host && (value === 'on' || value === 'off')) next.sites[host] = value;
    } catch { /* missing or unreadable: follow the app */ }
    return next;
  };
  let state = read();
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
    /** Read the file again (browser sync wrote it, browser-sync.cjs). */
    reload() { state = read(); },
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

function toHsl(hex) {
  const [r, g, b] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const chroma = max - min;
  if (chroma === 0) return { h: 0, s: 0, l };
  let h = (max === r ? ((g - b) / chroma) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4) * 60;
  if (h < 0) h += 360;
  return { h, s: chroma / (1 - Math.abs(2 * l - 1)), l };
}

function fromHsl({ h, s, l }) {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - chroma / 2;
  const [r, g, b] = h < 60 ? [chroma, x, 0] : h < 120 ? [x, chroma, 0] : h < 180 ? [0, chroma, x] : h < 240 ? [0, x, chroma] : h < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return `#${[r, g, b].map((value) => Math.round((value + m) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The color a dark page is painted in: the app's background in its own tint, but no lighter than Dark Reader's
 * default. The engine maps every light surface of a page between this color and a fixed lightness (0.4), so a lighter
 * background squeezes them together: in the app's panel color a white list, the page around it, a search box and a
 * selected row kept about half of their difference and read as one gray. A light interface's color is not taken.
 */
function pageBackground(colors) {
  const app = typeof colors?.background === 'string' && HEX_COLOR.test(colors.background) ? colors.background : '';
  const value = app && toHsl(app).l < 0.5 ? app : '#1e1f1f';
  const color = toHsl(value);
  return color.l <= MAX_PAGE_LIGHTNESS ? value : fromHsl({ ...color, l: MAX_PAGE_LIGHTNESS });
}

/** The text color of a dark page: the app's while it is light (a light interface reports dark text). */
function pageText(colors) {
  const app = typeof colors?.text === 'string' && HEX_COLOR.test(colors.text) ? colors.text : '';
  return app && toHsl(app).l > 0.5 ? app : '#e3e3e3';
}

/**
 * The rules a page that will be dark wears while it loads, before the engine runs (see browser-view.cjs): Dark Reader's
 * own loading style. Not only the root and the body: a web app paints white panels of its own long before its scripts
 * are done (Gmail stayed white for a second or two), so every element gets the dark background, a light text color and
 * a muted border until the engine has recolored the page.
 */
function loadingCanvas(colors) {
  const background = pageBackground(colors);
  const border = fromHsl({ ...toHsl(background), l: Math.min(1, toHsl(background).l + 0.16) });
  return `html, body, body :not(iframe) { background-color: ${background} !important; border-color: ${border} !important; color: ${pageText(colors)} !important; } html { color-scheme: dark !important; }`;
}

/** Dark Reader's theme at the engine's own contrast: a lower one moved a page's surfaces closer still. */
function themeFor(colors) {
  return {
    mode: 1,
    brightness: 100,
    contrast: 100,
    sepia: 0,
    darkSchemeBackgroundColor: pageBackground(colors),
    darkSchemeTextColor: pageText(colors),
  };
}

/**
 * Icons drawn through a mask (`mask-image`) take their color from `background-color`. The engine treats that color as
 * ink only when the mask and the color are in the same CSS rule; a site that sets them in two rules (Gmail's side bar,
 * many icon sets) had its icons darkened like a background, dark gray on the dark page. This pass looks at the masked
 * elements of the page, and an icon with too little contrast against what lies behind it gets its color with the
 * lightness turned around (the hue kept) from a stylesheet the engine neither recolors nor keeps once it is turned off.
 * It runs again while the page changes. It runs in the engine's isolated world as the source of this function, so the
 * site cannot see it.
 */
function iconInk() {
  const existing = globalThis.__myharnessIconInk;
  if (existing) return existing.start();
  const MAX_ICON = 96;
  const MIN_CONTRAST = 3;
  const ATTRIBUTES = { '': 'data-mh-ink', '::before': 'data-mh-ink-before', '::after': 'data-mh-ink-after' };
  const style = document.createElement('style');
  style.className = 'darkreader darkreader--myharness-ink';
  const paint = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
  const rgba = (value) => {
    if (!value || value === 'transparent') return null;
    paint.clearRect(0, 0, 1, 1);
    paint.fillStyle = '#00000000';
    paint.fillStyle = value;
    paint.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
    return a ? { r, g, b, a: a / 255 } : null;
  };
  const luminance = ({ r, g, b }) => {
    const channel = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const contrast = (one, two) => {
    const [high, low] = [luminance(one), luminance(two)].sort((a, b) => b - a);
    return (high + 0.05) / (low + 0.05);
  };
  let page = { r: 24, g: 26, b: 27, a: 1 };
  /** The dark page color of the engine's theme (set by darkScript before this runs). */
  const readPage = () => {
    try { page = rgba(JSON.parse(globalThis.__myharnessDarkTheme || 'null')?.darkSchemeBackgroundColor) || page; } catch { /* keep the last one */ }
  };
  /** The color an icon is drawn over: the nearest box from `element` up with a background of its own, else the page. */
  const behind = (element) => {
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const color = rgba(getComputedStyle(node).backgroundColor);
      if (color && color.a >= 0.5) return color;
    }
    return page;
  };
  /** The icon's color with its lightness turned around, light over a dark backdrop and dark over a light one. */
  const turned = ({ r, g, b }, backdrop) => {
    const [x, y, z] = [r / 255, g / 255, b / 255];
    const max = Math.max(x, y, z);
    const min = Math.min(x, y, z);
    const l = (max + min) / 2;
    const chroma = max - min;
    let h = 0;
    if (chroma) h = (max === x ? ((y - z) / chroma) % 6 : max === y ? (z - x) / chroma + 2 : (x - y) / chroma + 4) * 60;
    if (h < 0) h += 360;
    const s = chroma ? chroma / (1 - Math.abs(2 * l - 1)) : 0;
    const dark = luminance(backdrop) < 0.5;
    const next = dark ? Math.min(0.85, Math.max(0.62, 1 - l)) : Math.min(0.4, Math.max(0.15, 1 - l));
    const c = (1 - Math.abs(2 * next - 1)) * s;
    const k = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = next - c / 2;
    const [p, q, w] = h < 60 ? [c, k, 0] : h < 120 ? [k, c, 0] : h < 180 ? [0, c, k] : h < 240 ? [0, k, c] : h < 300 ? [k, 0, c] : [c, 0, k];
    return `#${[p, q, w].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('')}`;
  };
  /** A selector list cut at its top-level commas. */
  const split = (list) => {
    const parts = [];
    let depth = 0;
    let start = 0;
    let quote = '';
    for (let i = 0; i < list.length; i++) {
      const ch = list[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === ',' && depth === 0) {
        parts.push(list.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(list.slice(start));
    return parts.map((part) => part.trim()).filter(Boolean);
  };
  const isMasked = (declarations) => /url\(|image-set\(/.test(`${declarations.maskImage || ''} ${declarations.webkitMaskImage || ''}`);
  /** What the page's style rules mask: the elements (and their ::before / ::after) to look at. */
  const collect = () => {
    const selectors = new Set();
    const visit = (rules) => {
      for (const rule of rules) {
        if (rule.selectorText !== undefined && rule.style && isMasked(rule.style)) selectors.add(rule.selectorText);
        if (rule.cssRules?.length) visit(rule.cssRules);
      }
    };
    for (const sheet of [...document.styleSheets, ...(document.adoptedStyleSheets || [])]) {
      if (sheet.ownerNode === style) continue;
      // A stylesheet of another origin cannot be read here; the engine's own readable copy of it is in the list too.
      try { visit(sheet.cssRules); } catch { /* not readable */ }
    }
    const targets = [{ selector: '[style*="mask"]', pseudo: '' }];
    for (const list of selectors) {
      for (const part of split(list)) {
        const match = /::?(before|after)\s*$/iu.exec(part);
        const host = match ? part.slice(0, match.index).trim() || '*' : part;
        if (!host.includes('::')) targets.push({ selector: host, pseudo: match ? `::${match[1].toLowerCase()}` : '' });
      }
    }
    return targets;
  };
  let targets = [];
  let sheetsKey = '';
  let marks = new Map();
  const apply = (found) => {
    const next = new Map();
    for (const [element, attribute, color] of found) {
      const entry = next.get(element) || {};
      entry[attribute] = color;
      next.set(element, entry);
    }
    for (const [element, entry] of marks) {
      for (const attribute of Object.keys(entry)) if (next.get(element)?.[attribute] === undefined) element.removeAttribute(attribute);
    }
    const rules = new Set();
    for (const [element, entry] of next) {
      for (const [attribute, color] of Object.entries(entry)) {
        if (element.getAttribute(attribute) !== color) element.setAttribute(attribute, color);
        const pseudo = attribute.endsWith('-before') ? '::before' : attribute.endsWith('-after') ? '::after' : '';
        // Two id parts outweigh the site's own class rules, `!important` ones included.
        rules.add(`[${attribute}="${color}"]:not(#mh-ink-none):not(#mh-ink-none)${pseudo} { background-color: ${color} !important; }`);
      }
    }
    marks = next;
    const css = [...rules].sort().join('\n');
    if (style.textContent !== css) style.textContent = css;
  };
  let timer = 0;
  let last = 0;
  let observer = null;
  const kicks = [];
  const run = () => {
    timer = 0;
    last = performance.now();
    if (!globalThis.DarkReader?.isEnabled()) return;
    if (!style.isConnected) (document.head || document.documentElement).append(style);
    const key = `${document.styleSheets.length}:${document.adoptedStyleSheets?.length || 0}`;
    if (key !== sheetsKey) {
      sheetsKey = key;
      targets = collect();
    }
    // The colors are read without this pass's own rules (one style recalculation, no frame painted in between).
    const sheet = style.sheet;
    if (sheet) sheet.disabled = true;
    const found = [];
    try {
      for (const { selector, pseudo } of targets) {
        let elements;
        try { elements = document.querySelectorAll(selector); } catch { continue; }
        for (const element of elements) {
          const computed = getComputedStyle(element, pseudo || null);
          if (!isMasked(computed)) continue;
          const box = pseudo ? { width: parseFloat(computed.width), height: parseFloat(computed.height) } : element.getBoundingClientRect();
          if (!(box.width > 0 && box.height > 0 && box.width <= MAX_ICON && box.height <= MAX_ICON)) continue;
          const color = rgba(computed.backgroundColor);
          if (!color || color.a < 0.3) continue;
          const backdrop = behind(pseudo ? element : element.parentElement);
          if (contrast(color, backdrop) < MIN_CONTRAST) found.push([element, ATTRIBUTES[pseudo], turned(color, backdrop)]);
        }
      }
    } finally {
      if (sheet) sheet.disabled = false;
    }
    apply(found);
  };
  /** At most one pass a second while the page keeps changing. */
  const schedule = () => {
    if (!timer) timer = setTimeout(run, Math.max(0, 1000 - (performance.now() - last)));
  };
  const start = () => {
    readPage();
    if (!observer) {
      observer = new MutationObserver(schedule);
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    }
    // The engine reads stylesheets of other origins later; the first passes follow it.
    for (const delay of [0, 500, 1500, 4000]) kicks.push(setTimeout(run, delay));
    return true;
  };
  const stop = () => {
    observer?.disconnect();
    observer = null;
    clearTimeout(timer);
    timer = 0;
    for (const kick of kicks.splice(0)) clearTimeout(kick);
    apply([]);
    style.remove();
    sheetsKey = '';
    return true;
  };
  globalThis.__myharnessIconInk = { start, stop, run };
  return start();
}

/** The script that turns the engine on (in these colors) or off in one document, the top one or a frame. */
function darkScript(enabled, colors) {
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
        globalThis.__myharnessDarkTheme = ${JSON.stringify(theme)};
        if (DarkReader.isEnabled()) (${iconInk.toString()})();
        return DarkReader.isEnabled();
      })()`
    : `(() => { globalThis.__myharnessIconInk?.stop(); if (globalThis.DarkReader) DarkReader.disable(); globalThis.__myharnessDarkTheme = null; return false; })()`;
  // One script: the engine is defined once per document, then turned on or off; its value is the script's result.
  return enabled ? `if (!globalThis.DarkReader) {
${engineSource()}
}
${run}` : run;
}

/** Recolor (or restore) one page. Resolves true when the engine is running afterwards. */
async function applyDark(contents, enabled, colors) {
  if (!contents || contents.isDestroyed() || !engineSource()) return false;
  try {
    return (await contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code: darkScript(enabled, colors) }])) === true;
  } catch {
    return false;
  }
}

/**
 * The same in the page's frames that share its renderer, which are the frames of its own site: the Google account menu
 * over Gmail is one. Left alone, such a frame stayed white over the dark page, in an opaque box besides: the engine
 * gives `<iframe>` elements `color-scheme: dark`, and a frame whose document does not match it gets a solid canvas. The
 * preload reaches each frame by its token (browser-tab-preload.cjs `__myharnessDarkFrames`) and skips one that already
 * shows this state, so the engine is not sent again for every frame that loads. A frame has no fetch bridge, so its
 * cross-origin stylesheets keep their colors; a frame of another site runs in another process and keeps all of them.
 * Resolves with the number of frames the engine was turned on in.
 */
async function applyDarkToFrames(contents, enabled, colors) {
  if (!contents || contents.isDestroyed() || !engineSource()) return 0;
  let tokens;
  try {
    const top = contents.mainFrame;
    tokens = top.framesInSubtree
      .filter((frame) => frame !== top && !frame.detached && frame.processId === top.processId)
      .map((frame) => frame.frameToken);
  } catch {
    return 0;
  }
  if (!tokens.length) return 0;
  const theme = JSON.stringify(JSON.stringify(themeFor(colors)));
  const settled = enabled
    ? `globalThis.DarkReader?.isEnabled() === true && globalThis.__myharnessDarkTheme === ${theme} && !!document.querySelector('.darkreader')`
    : '!globalThis.DarkReader?.isEnabled()';
  const code = `globalThis.__myharnessDarkFrames ? globalThis.__myharnessDarkFrames(${JSON.stringify(tokens)}, ${JSON.stringify(darkScript(enabled, colors))}, ${JSON.stringify(settled)}) : 0`;
  try {
    return Number(await contents.executeJavaScriptInIsolatedWorld(WORLD, [{ code }])) || 0;
  } catch {
    return 0;
  }
}

/**
 * Whether the page, told that the reader prefers dark (`prefers-color-scheme: dark`, emulated per tab by the host), now
 * shows its own dark theme. Then the site's design is kept and Dark Reader stays off. It waits briefly for stylesheets
 * that are still loading, sets the preload's dark canvas aside for one synchronous read (no frame is painted in between)
 * and looks at the page's surface at five points: the top bar, the middle and three points lower down. The surface at a
 * point is the nearest box with a background of its own that is wide (a third of the page), not a button or a badge,
 * and it counts as dark only below the lightness of the dark themes sites use (about #454545). A light page with a
 * blue banner and a blue button in the middle (Devpost) once passed as dark that way and stayed light. With no surface
 * of its own anywhere, the root's `color-scheme` decides.
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
    const root = document.documentElement;
    const width = innerWidth || root.clientWidth;
    const height = innerHeight || root.clientHeight;
    const surface = (element) => {
      for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
        const color = rgba(getComputedStyle(node).backgroundColor);
        if (!color) continue;
        if (node === root || node === document.body) return color;
        const box = node.getBoundingClientRect();
        if (box.width >= width / 3 && box.height >= 40) return color;
      }
      return null;
    };
    const scheme = ((getComputedStyle(root).colorScheme || '') + ' ' + (document.querySelector('meta[name="color-scheme"]')?.content || '')).replace(/,/g, ' ');
    const canvasDark = scheme.split(' ').includes('dark');
    const probes = [[0.5, Math.min(24, height / 4) / height], [0.5, 0.5], [0.25, 0.7], [0.75, 0.7], [0.5, 0.88]]
      .map(([x, y]) => document.elementFromPoint(width * x, height * y))
      .filter(Boolean);
    const votes = probes.map(surface).map((color) => (color ? luminance(color) < 0.06 : canvasDark));
    if (!votes.length) votes.push(surface(document.body) ? luminance(surface(document.body)) < 0.06 : canvasDark);
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

module.exports = { MODES, createDarkStore, applyDark, applyDarkToFrames, detectNativeDark, putCanvas, dropCanvas, darkFetch, engineSource, pageBackground, themeFor, loadingCanvas };
