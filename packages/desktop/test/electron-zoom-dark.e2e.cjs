/*
 * Real-Electron check of page zoom and website dark mode in the built-in browser (Windows). Not part of
 * `node --test test/*.test.cjs` because it needs an Electron main process:
 *
 *   packages/desktop/node_modules/electron/dist/electron.exe <absolute path of this file> --profile=<dir>
 *
 * It serves a white page whose colors partly come from a stylesheet on another origin without CORS headers, turns dark
 * mode on (Dark Reader's engine in the tab's isolated world, cross-origin CSS through the host), turns it off for the
 * site, zooms the tab (remembered per site), clicks by selector at 150 % and checks that the app window's own zoom
 * scales the view's box. It also selects text on the page and translates it through the in-page "译" button and the
 * context-menu path (the host's translate function is a stub here). The window stays off screen and never takes the
 * focus. Exit code 1 at the first failure.
 */
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const { mkdirSync, readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const args = Object.fromEntries(
  process.argv.slice(2).filter((value) => value.startsWith('--')).map((value) => {
    const [key, ...rest] = value.slice(2).split('=');
    return [key, rest.join('=')];
  }),
);
const profile = args.profile;
if (!profile) {
  console.error('usage: electron electron-zoom-dark.e2e.cjs --profile=<dir>');
  app.exit(2);
}
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');

const report = { checks: [], failures: [] };
const check = (ok, name, detail) => {
  report.checks.push({ name, ok: !!ok, detail });
  if (!ok) report.failures.push(`${name}: ${JSON.stringify(detail)}`);
  return !!ok;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await wait(80);
  }
  return undefined;
};

const PAGE = (cssPort) => `<!doctype html><html><head><meta charset="utf-8"><title>Zoom Dark</title>
<link rel="stylesheet" href="http://127.0.0.1:${cssPort}/remote.css">
<style>body { background: #ffffff; color: #111111; } #local { background: #f4f4f4; height: 40px; }</style></head>
<body><h1>White page</h1><div id="local">local</div><div id="remote" class="remote-box">remote</div>
<button id="go" style="margin: 300px 0 0 400px" onclick="document.getElementById('out').textContent='clicked'">Go</button><div id="out">idle</div></body></html>`;

const pages = http.createServer((request, response) => {
  pages.lastLanguage = request.headers['accept-language'];
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  // A page whose body arrives late: what it shows while it loads is what a slow site shows.
  if (request.url === '/slow') {
    response.write('<!doctype html><html><head><meta charset="utf-8"><title>Slow</title><style>body { background: #ffffff; color: #111111; }</style></head><body><p>first part</p>');
    setTimeout(() => response.end('<p>rest</p></body></html>'), 2500);
    return;
  }
  // A site with a dark theme of its own (prefers-color-scheme): it is shown in that theme, Dark Reader stays off.
  if (request.url === '/native') {
    response.end('<!doctype html><html><head><meta charset="utf-8"><title>Native</title><meta name="color-scheme" content="light dark"><style>body { background: #ffffff; color: #111111; } @media (prefers-color-scheme: dark) { body { background: #121212; color: #eeeeee; } }</style></head><body><h1>Own dark theme</h1></body></html>');
    return;
  }
  response.end(PAGE(pages.cssPort));
});
// Another origin, no Access-Control-Allow-Origin: the page itself could not read this stylesheet's rules.
const styles = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/css' });
  response.end('.remote-box { background-color: #fafafa; color: #000000; height: 40px; }');
});
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/** Relative luminance (0 black … 1 white) of a computed `rgb(...)` color. */
const luminance = (rgb) => {
  const [r, g, b] = String(rgb).match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

async function main() {
  const pagePort = await listen(pages);
  pages.cssPort = await listen(styles);
  const origin = `http://127.0.0.1:${pagePort}`;
  const window = new BrowserWindow({ width: 1280, height: 900, x: -3000, y: -3000, show: false, focusable: false, webPreferences: { sandbox: true }, backgroundColor: '#202020' });
  window.showInactive();
  await window.loadURL('data:text/html,<title>app</title><p>app page</p>');
  const status = [];
  const realSend = window.webContents.send.bind(window.webContents);
  window.webContents.send = (channel, payload) => {
    if (channel === 'desktop:status') status.push(payload);
    return realSend(channel, payload);
  };
  const { createBrowser } = require('../browser-view.cjs');
  const asked = [];
  const translate = async (text) => { asked.push(text); return { translation: `译:${text}`, model: 'stub/model' }; };
  const browser = createBrowser(window, () => undefined, { profileDir: profile, translate });
  // Start like the app does before the page reported its theme: light, so the first load shows the site's own colors.
  await browser.command({ action: 'darkMode', appDark: false });
  const tab = await browser.command({ action: 'open', url: origin, rect: { x: 100, y: 80, width: 900, height: 700 } });
  const id = tab.tabId;
  const loaded = await until(async () => {
    const state = await browser.command({ action: 'state', tabId: id });
    return state.title === 'Zoom Dark' && !state.loading ? state : undefined;
  });
  check(!!loaded, 'the page loads');
  const colors = async () => (await browser.command({
    action: 'exec', tabId: id,
    code: '({ body: getComputedStyle(document.body).backgroundColor, local: getComputedStyle(document.getElementById("local")).backgroundColor, remote: getComputedStyle(document.getElementById("remote")).backgroundColor, text: getComputedStyle(document.body).color })',
  })).result;
  const before = await colors();
  check(luminance(before.body) > 0.9 && luminance(before.remote) > 0.9, 'the page starts white', before);

  // --- dark mode -----------------------------------------------------------------------------------------------------
  const mode = await browser.command({ action: 'darkMode', appDark: true, colors: { background: '#1c1d1d', text: '#e3e5e5' } });
  check(mode.mode === 'auto' && mode.appDark === true, 'the app reports a dark interface; the mode follows it', mode);
  const darkened = await until(async () => {
    const value = await colors();
    return luminance(value.body) < 0.05 && luminance(value.local) < 0.1 && luminance(value.remote) < 0.1 ? value : undefined;
  }, 20000);
  check(!!darkened, 'the page, its own styles and the cross-origin stylesheet are recolored dark', darkened || (await colors()));
  if (darkened) check(luminance(darkened.text) > 0.5, 'the text becomes light', darkened.text);
  const darkState = await browser.command({ action: 'state', tabId: id });
  check(darkState.dark === true && darkState.darkMode === 'auto' && darkState.darkSite === null, 'the tab state reports dark mode', { dark: darkState.dark, darkMode: darkState.darkMode, darkSite: darkState.darkSite });
  check(status.some((value) => value.tabId === id && value.type === 'dark' && value.dark === true), 'the workspace hears that the tab turned dark');
  const isolated = await browser.tabs[0].view.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: 'typeof globalThis.__myharnessDarkFetch' }]);
  check(isolated === 'function', 'the engine world has the host fetch bridge of the preload', isolated);
  const pageWorld = await browser.command({ action: 'exec', tabId: id, code: '({ engine: typeof window.DarkReader, bridge: typeof window.__myharnessDarkFetch })' });
  check(pageWorld.result.engine === 'undefined' && pageWorld.result.bridge === 'undefined', "the site's own scripts see neither the engine nor the fetch bridge", pageWorld.result);

  // A dark site never shows white while it loads: before the engine runs, the body and the canvas are already dark.
  const slowLoad = browser.command({ action: 'navigate', tabId: id, url: `${origin}/slow` }).catch(() => undefined);
  const early = await until(async () => {
    const value = (await browser.command({ action: 'exec', tabId: id, code: '(() => document.body && document.title === "Slow" ? { body: getComputedStyle(document.body).backgroundColor, ready: document.readyState } : null)()' })).result;
    return value?.ready === 'loading' ? value : undefined;
  }, 5000);
  check(!!early && luminance(early.body) < 0.05, 'a dark site is dark while it is still loading', early);
  await slowLoad;
  await browser.command({ action: 'navigate', tabId: id, url: origin });
  await until(async () => {
    const state = await browser.command({ action: 'state', tabId: id });
    return state.title === 'Zoom Dark' && !state.loading && state.dark;
  }, 20000);

  // A menu of the app opening over the page hides the native view: a fresh picture of the site takes its place first.
  await browser.command({ action: 'bounds', tabId: id, rect: { x: 100, y: 80, width: 900, height: 700 } });
  await wait(400);
  await browser.command({ action: 'exec', tabId: id, code: '(() => { window.__resizes = 0; addEventListener("resize", () => { window.__resizes += 1; }); return innerWidth; })()' });
  const shotsBefore = status.filter((value) => value.tabId === id && value.type === 'snapshot' && value.snapshot).length;
  await browser.command({ action: 'bounds', tabId: id, rect: null });
  const shotsAfter = status.filter((value) => value.tabId === id && value.type === 'snapshot' && value.snapshot).length;
  check(shotsAfter > shotsBefore, 'hiding the view sends a picture of the page first', { shotsBefore, shotsAfter });
  check(browser.tabs[0].view.getVisible() === false, 'and then hides the view');
  await browser.command({ action: 'bounds', tabId: id, rect: { x: 100, y: 80, width: 900, height: 700 } });
  await wait(300);
  const resizes = (await browser.command({ action: 'exec', tabId: id, code: 'window.__resizes' })).result;
  check(resizes === 0, 'a menu opening and closing over the page does not resize (re-lay out) the site', { resizes });

  const off = await browser.command({ action: 'darkSite', tabId: id, value: 'off' });
  check(off.dark === false && off.darkSite === 'off', 'dark mode can be turned off for this site', off);
  const restored = await until(async () => {
    const value = await colors();
    return luminance(value.body) > 0.9 ? value : undefined;
  });
  check(!!restored, 'the site gets its own colors back', restored || { colors: await colors(), styles: (await browser.command({ action: 'exec', tabId: id, code: '[...document.querySelectorAll("style")].map((s) => s.textContent.slice(0, 80))' })).result });
  const saved = JSON.parse(readFileSync(join(profile, 'browser-dark.json'), 'utf8'));
  check(saved.sites[`127.0.0.1:${pagePort}`] === 'off', 'the site choice is kept in the profile', saved);
  await browser.command({ action: 'darkSite', tabId: id, value: null });
  await browser.command({ action: 'darkMode', appDark: false });
  await wait(300);
  check(luminance((await colors()).body) > 0.9, '"auto" leaves sites alone while the interface is light');

  // A site's own dark theme comes first: told that the reader prefers dark, it turns dark by itself and keeps its design.
  await browser.command({ action: 'darkMode', appDark: true, colors: { background: '#1c1d1d', text: '#e3e5e5' } });
  await browser.command({ action: 'navigate', tabId: id, url: `${origin}/native` });
  const native = await until(async () => {
    const state = await browser.command({ action: 'state', tabId: id });
    return state.title === 'Native' && !state.loading && state.dark ? state : undefined;
  }, 20000);
  check(native?.darkNative === true, 'a site with its own dark theme is reported as using it', native && { dark: native.dark, darkNative: native.darkNative });
  const nativeLook = (await browser.command({ action: 'exec', tabId: id, code: '({ body: getComputedStyle(document.body).backgroundColor, text: getComputedStyle(document.body).color, prefers: matchMedia("(prefers-color-scheme: dark)").matches })' })).result;
  check(nativeLook.prefers === true && nativeLook.body === 'rgb(18, 18, 18)' && nativeLook.text === 'rgb(238, 238, 238)', "the page shows the site's own dark colors, untouched", nativeLook);
  const engineOn = await browser.tabs[0].view.webContents.executeJavaScriptInIsolatedWorld(999, [{ code: '!!(globalThis.DarkReader && DarkReader.isEnabled())' }]);
  check(engineOn === false, 'Dark Reader does not run over a site that is dark by itself', engineOn);
  await browser.command({ action: 'darkMode', appDark: false });
  await wait(300);
  const nativeOff = await browser.command({ action: 'state', tabId: id });
  const systemDark = require('electron').nativeTheme.shouldUseDarkColors;
  const prefersAfter = (await browser.command({ action: 'exec', tabId: id, code: 'matchMedia("(prefers-color-scheme: dark)").matches' })).result;
  check(nativeOff.dark === false && prefersAfter === systemDark, 'turning dark off gives the site the system preference again', { dark: nativeOff.dark, prefersAfter, systemDark });
  check(!browser.tabs[0].view.webContents.debugger.isAttached(), 'and lets the page debugger go');
  await browser.command({ action: 'navigate', tabId: id, url: origin });
  await until(async () => {
    const state = await browser.command({ action: 'state', tabId: id });
    return state.title === 'Zoom Dark' && !state.loading;
  });

  // --- zoom ----------------------------------------------------------------------------------------------------------
  const zoomed = await browser.command({ action: 'zoom', tabId: id, direction: 1 });
  check(zoomed.zoom === 1.1, 'zooms in one step', zoomed);
  const deeper = await browser.command({ action: 'zoom', tabId: id, factor: 1.5 });
  check(deeper.zoom === 1.5 && browser.tabs[0].view.webContents.getZoomFactor() === 1.5, 'zooms to an exact factor', deeper);
  check(status.some((value) => value.tabId === id && value.type === 'zoom' && value.zoom === 1.5), 'the workspace hears the zoom');
  const clicked = await browser.command({ action: 'click', tabId: id, selector: '#go' });
  await wait(150);
  const out = await browser.command({ action: 'exec', tabId: id, code: 'document.getElementById("out").textContent' });
  check(clicked.ok === true && out.result === 'clicked', 'a click by selector still hits its element at 150 %', { clicked, out: out.result });
  await until(() => existsSync(join(profile, 'browser-zoom.json')), 3000);
  const zoomFile = JSON.parse(readFileSync(join(profile, 'browser-zoom.json'), 'utf8'));
  check(zoomFile.sites[`127.0.0.1:${pagePort}`] === 1.5, 'the zoom is remembered for the site', zoomFile);
  await browser.command({ action: 'navigate', tabId: id, url: `${origin}/again` });
  await until(async () => !(await browser.command({ action: 'state', tabId: id })).loading);
  check((await browser.command({ action: 'state', tabId: id })).zoom === 1.5, 'another page of the same site opens at that zoom');
  const reset = await browser.command({ action: 'zoom', tabId: id, direction: 0 });
  check(reset.zoom === 1, 'Ctrl+0 resets to 100 %', reset);

  // --- selection translation ----------------------------------------------------------------------------------------
  const contents = browser.tabs[0].view.webContents;
  const heading = (await browser.command({ action: 'exec', tabId: id, code: '(() => { const r = document.querySelector("h1").getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width }; })()' })).result;
  const mouse = (type, x, y, extra = {}) => contents.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, ...extra });
  mouse('mouseDown', heading.x + 2, heading.y);
  for (let k = 1; k <= 6; k++) mouse('mouseMove', heading.x + 2 + ((heading.w - 4) * k) / 6, heading.y, { modifiers: ['leftButtonDown'] });
  const releaseX = heading.x + heading.w - 2;
  mouse('mouseUp', releaseX, heading.y);
  await wait(300);
  const selected = (await browser.command({ action: 'exec', tabId: id, code: 'getSelection().toString()' })).result;
  check(selected === 'White page', 'text on the page is selected by dragging', selected);
  const shadow = (await browser.command({ action: 'exec', tabId: id, code: '(() => { const el = document.querySelector("myharness-translate"); return el ? { found: true, open: el.shadowRoot !== null } : { found: false }; })()' })).result;
  check(shadow.found && shadow.open === false, "the 译 button lives in a closed shadow root the site's scripts cannot open", shadow);
  // The button sits just below the release point (see browser-tab-preload.cjs).
  mouse('mouseDown', Math.min(releaseX, 900 - 88) + 20, heading.y + 20);
  mouse('mouseUp', Math.min(releaseX, 900 - 88) + 20, heading.y + 20);
  const viaButton = await until(() => asked.length >= 1, 5000);
  check(viaButton && asked[0] === 'White page', 'the 译 button asks the host to translate the selection', asked);
  contents.send('mh-browser:translate-selection', { text: '  local  ', x: 50, y: 50 });
  const viaMenu = await until(() => asked.length >= 2, 5000);
  check(viaMenu && asked[1] === 'local', 'the context-menu item translates the selected text', asked);
  const pageSees = (await browser.command({ action: 'exec', tabId: id, code: 'typeof window.__myharnessDarkFetch' })).result;
  check(pageSees === 'undefined', 'the page world still sees nothing of the helper');

  // --- the browser's language reaches the site ---------------------------------------------------------------------
  const defaultHeader = pages.lastLanguage;
  const chosen = await browser.command({ action: 'language', language: 'ja' });
  check(chosen.language === 'ja' && (await browser.command({ action: 'state', tabId: id })).language === 'ja', 'the browser language is set', chosen);
  const reloaded = await until(() => pages.lastLanguage && pages.lastLanguage.startsWith('ja') ? pages.lastLanguage : undefined, 8000);
  check(reloaded === 'ja,en-US;q=0.9,en;q=0.8', 'the active tab loads again and the site is asked in that language', { reloaded, defaultHeader });
  await until(async () => !(await browser.command({ action: 'state', tabId: id })).loading, 8000);
  const navigatorLanguages = (await browser.command({ action: 'exec', tabId: id, code: '[navigator.language, ...navigator.languages].join(" ")' })).result;
  check(navigatorLanguages === 'ja ja en-US en', "the page's scripts read the same language", navigatorLanguages);
  check(JSON.parse(readFileSync(join(profile, 'browser-language.json'), 'utf8')).language === 'ja', 'the language is kept in the profile');
  await browser.command({ action: 'language', language: '' });
  await until(() => pages.lastLanguage === defaultHeader, 8000);
  check(pages.lastLanguage === defaultHeader, 'the system default sends the engine header again', { now: pages.lastLanguage, defaultHeader });

  // --- the app window's own zoom scales the box the page measured ------------------------------------------------------
  window.webContents.setZoomFactor(1.25);
  await browser.command({ action: 'bounds', tabId: id, rect: { x: 100, y: 80, width: 400, height: 300 } });
  // The view's box on the window (its own bounds are relative to the container that cuts it).
  const box = (await browser.command({ action: 'state', tabId: id })).bounds;
  check(box.x === 125 && box.y === 100 && box.width === 500 && box.height === 375, 'with the app at 125 % the view covers the measured box in window pixels', box);
}

app.whenReady().then(main)
  .catch((error) => { report.failures.push(`crash: ${error.stack || error.message}`); })
  .finally(() => {
    console.log(JSON.stringify({ ok: report.failures.length === 0, failures: report.failures, checks: report.checks.map((c) => `${c.ok ? 'ok ' : 'FAIL'} ${c.name}`) }, null, 2));
    pages.close();
    styles.close();
    app.exit(report.failures.length ? 1 : 0);
  });
app.on('window-all-closed', () => undefined);
