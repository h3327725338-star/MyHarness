/*
 * Real-Electron check of four built-in browser behaviours (Windows). Not part of `node --test`, because it needs an
 * Electron main process:
 *
 *   packages/desktop/node_modules/electron/dist/electron.exe <absolute path of this file> --profile=<empty dir>
 *
 * - A frame inside the page that moves within itself (Gmail's side panel does) leaves the tab's address alone; only the
 *   page's own in-page moves change it.
 * - The website language chosen in the toolbar reaches every part of a site: the Accept-Language header of the page,
 *   its frames, its requests and its workers, and navigator.language(s) in the page, in a frame of another site and in
 *   a worker.
 * - Sound: a tab opened for the Agent (`muted: true`) starts muted and a popup it opens stays muted, a tab the user
 *   opens plays; the state reports audible/muted and `mute` switches it.
 * - Reading for the Agent in a hidden tab: `read` with `scroll` loads an endless list to its end and keeps every row of
 *   a list that recycles its rows, returns links and tables, and the Agent's `find` reports matches without focusing
 *   the page.
 *
 * The window is never shown (nothing takes the focus). It prints a JSON report and exits 1 at any broken invariant.
 */
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const args = Object.fromEntries(process.argv.slice(2).filter((value) => value.startsWith('--')).map((value) => {
  const [key, ...rest] = value.slice(2).split('=');
  return [key, rest.join('=')];
}));
const profile = args.profile;
const PORT = Number(args.port || 47861);
if (!profile) {
  console.error('usage: electron electron-browser-fixes.e2e.cjs --profile=<dir> [--port=47861]');
  app.exit(2);
}
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
// As main.cjs does at start: the saved website language is the engine's language too (frames of other sites, workers).
writeFileSync(join(profile, 'browser-language.json'), JSON.stringify({ version: 1, language: 'zh-CN' }));
require('../browser-language.cjs').applyEngineLanguage(app, join(profile, 'browser-language.json'));
app.commandLine.appendSwitch('disable-features', 'MediaRouter,CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.on('window-all-closed', () => {});

const report = { checks: [], failures: [] };
const check = (ok, name, detail) => {
  report.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) });
  process.stderr.write(`${ok ? 'ok' : 'FAIL'} - ${name}\n`);
  if (!ok) report.failures.push(`${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  return !!ok;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await wait(60);
  }
  return undefined;
};

// Headers the server saw, by path.
const seen = new Map();
const html = (body) => `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
// A short tone made in the page (no file needed): the tab is audible while it plays.
const TONE = `<script>
window.playTone = () => { const ctx = new AudioContext(); const osc = ctx.createOscillator(); const gain = ctx.createGain(); gain.gain.value = 0.05; osc.connect(gain).connect(ctx.destination); osc.start(); window.toneCtx = ctx; return ctx.state; };
</script>`;

async function main() {
  const origin = `http://127.0.0.1:${PORT}`;
  const other = `http://localhost:${PORT}`;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, origin);
    seen.set(url.pathname, request.headers['accept-language'] || '');
    const send = (type, body) => { response.writeHead(200, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' }); response.end(body); };
    if (url.pathname === '/frames') return send('text/html', html(`<title>Frames</title><iframe id="side" src="${other}/side" style="width:300px;height:200px"></iframe>`));
    if (url.pathname === '/side') return send('text/html', html('<title>Side</title><script>window.move = (n) => history.pushState({}, "", "/side/panel?n=" + n);</script>'));
    if (url.pathname === '/lang') return send('text/html', html(`<title>Lang</title><iframe id="cross" src="${other}/lang-frame"></iframe><script>
      window.workerLang = () => new Promise((resolve) => { const w = new Worker('/lang-worker.js'); w.onmessage = (event) => resolve(event.data); });
      window.fetchLang = () => fetch('/lang-fetch').then((r) => r.text());
    </script>`));
    if (url.pathname === '/lang-frame') return send('text/html', html('<title>Frame</title><script>window.langs = JSON.stringify([navigator.language, navigator.languages]);</script>'));
    if (url.pathname === '/lang-worker.js') return send('text/javascript', "fetch('/lang-from-worker').then(() => postMessage(JSON.stringify([navigator.language, navigator.languages])));");
    if (url.pathname === '/lang-fetch' || url.pathname === '/lang-from-worker') return send('text/plain', 'ok');
    // An endless list: 20 rows, 20 more each time the end comes into view, 100 in all.
    if (url.pathname === '/feed') return send('text/html', html(`<title>Feed</title><table id="t"><tr><th>Name</th><th>Score</th></tr><tr><td>Ann</td><td>3</td></tr></table><div id="list"></div><a href="/about">About us</a><script>
      let count = 0; const list = document.getElementById('list');
      const more = () => { for (let i = 0; i < 20 && count < 100; i++) { const row = document.createElement('p'); row.style.height = '60px'; row.textContent = 'feed row ' + (++count); list.append(row); } };
      more(); addEventListener('scroll', () => { if (innerHeight + scrollY >= document.body.scrollHeight - 200) setTimeout(more, 150); });
    </script>`));
    // A list that keeps only the rows on screen (virtual scrolling) inside its own scrolling box.
    if (url.pathname === '/virtual') return send('text/html', html(`<title>Virtual</title><div id="box" style="height:500px;overflow:auto"><div id="pad" style="height:12000px;position:relative"></div></div><script>
      const box = document.getElementById('box'), pad = document.getElementById('pad');
      const draw = () => { pad.textContent = ''; const first = Math.floor(box.scrollTop / 40); for (let i = first; i < first + 14 && i < 300; i++) { const row = document.createElement('div'); row.style.cssText = 'position:absolute;height:40px;top:' + (i * 40) + 'px'; row.textContent = 'virtual item ' + (i + 1); pad.append(row); } };
      draw(); box.addEventListener('scroll', draw);
    </script>`));
    // An endless list that loads its next part when a marker below it comes into view (IntersectionObserver).
    if (url.pathname === '/io-feed') return send('text/html', html(`<title>IO feed</title><div id="list"></div><div id="end">end marker</div><script>
      let count = 0; const list = document.getElementById('list');
      const more = () => { for (let i = 0; i < 20 && count < 80; i++) { const row = document.createElement('p'); row.style.height = '60px'; row.textContent = 'io row ' + (++count); list.append(row); } };
      more(); new IntersectionObserver((entries) => { if (entries[0].isIntersecting) setTimeout(more, 100); }).observe(document.getElementById('end'));
    </script>`));
    if (url.pathname === '/sound') return send('text/html', html(`<title>Sound</title>${TONE}<button id="pop" onclick="window.open('/sound?popup=1', 'p', 'width=300,height=300')">pop</button>`));
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });
  const window = new BrowserWindow({ width: 1280, height: 900, show: false });
  const status = [];
  const realSend = window.webContents.send.bind(window.webContents);
  window.webContents.send = (channel, payload) => { if (channel === 'desktop:status') status.push(payload); return realSend(channel, payload); };
  const { createBrowser } = require('../browser-view.cjs');
  const browser = createBrowser(window, () => {}, { profileDir: profile });
  const run = (command, context) => browser.command(command, context);
  const rect = { x: 0, y: 0, width: 900, height: 700 };
  const loaded = (tabId, title) => until(async () => { const state = await run({ action: 'state', tabId }); return state.loading === false && state.title === title ? state : undefined; });
  try {
    // ---- A frame moving within itself is not the tab's address ------------------------------------------------------
    await run({ action: 'open', tabId: 'frames', url: `${origin}/frames`, rect });
    check(await loaded('frames', 'Frames'), 'the page with a side frame loads');
    const frame = await until(() => run({ action: 'exec', tabId: 'frames', code: "document.getElementById('side').contentWindow ? 1 : 0" }).then((value) => value?.result === 1));
    check(frame, 'the side frame is there');
    const contents = require('electron').webContents.getAllWebContents().find((item) => item.getURL() === `${origin}/frames`);
    const side = await until(() => contents?.mainFrame.frames.find((item) => item.url.startsWith(`${other}/side`)));
    await side?.executeJavaScript('window.move(1)');
    await wait(500);
    const after = await run({ action: 'state', tabId: 'frames' });
    check(after.url === `${origin}/frames`, 'the frame moving within itself leaves the tab address alone', after.url);
    await run({ action: 'exec', tabId: 'frames', code: "history.pushState({}, '', '/frames#inbox'); 1" });
    check(await until(async () => (await run({ action: 'state', tabId: 'frames' })).url === `${origin}/frames#inbox`), "the page's own in-page move still changes the address");

    // ---- Website language --------------------------------------------------------------------------------------------
    await run({ action: 'language', language: 'zh-CN' });
    await run({ action: 'open', tabId: 'lang', url: `${origin}/lang`, rect });
    check(await loaded('lang', 'Lang'), 'the language page loads');
    const header = (path) => seen.get(path) || '';
    check(header('/lang').startsWith('zh-CN'), 'the page request says zh-CN first', header('/lang'));
    check(await until(() => header('/lang-frame')), 'the frame of another site is requested');
    check(header('/lang-frame').startsWith('zh-CN'), 'the frame request says zh-CN first', header('/lang-frame'));
    await run({ action: 'exec', tabId: 'lang', code: 'fetchLang()' });
    check(header('/lang-fetch').startsWith('zh-CN'), "the page's own request says zh-CN first", header('/lang-fetch'));
    const page = (await run({ action: 'exec', tabId: 'lang', code: 'JSON.stringify([navigator.language, navigator.languages])' })).result;
    check(JSON.parse(page || '[]')[0] === 'zh-CN', 'navigator.language in the page is zh-CN', page);
    const langContents = require('electron').webContents.getAllWebContents().find((item) => item.getURL() === `${origin}/lang`);
    const cross = await until(() => langContents?.mainFrame.frames.find((item) => item.url.startsWith(`${other}/lang-frame`)));
    const crossLangs = cross ? await cross.executeJavaScript('window.langs') : '';
    check(JSON.parse(crossLangs || '[]')[0] === 'zh-CN', 'navigator.language in a frame of another site is zh-CN', crossLangs);
    const worker = (await run({ action: 'exec', tabId: 'lang', code: 'workerLang()' })).result;
    check(JSON.parse(worker || '[]')[0] === 'zh-CN', 'navigator.language in a worker is zh-CN', worker);
    check(header('/lang-from-worker').startsWith('zh-CN'), "the worker's request says zh-CN first", header('/lang-from-worker'));

    // ---- Sound -------------------------------------------------------------------------------------------------------
    await run({ action: 'ensure', tabId: 'agent-sound', url: `${origin}/sound`, muted: true }, { agent: true });
    check(await loaded('agent-sound', 'Sound'), 'the Agent tab loads');
    await run({ action: 'exec', tabId: 'agent-sound', code: 'playTone()' });
    const agentState = await until(async () => { const state = await run({ action: 'state', tabId: 'agent-sound' }); return state.audible ? state : undefined; }, 6000);
    check(agentState?.muted === true, 'a tab opened for the Agent plays muted', agentState);
    await run({ action: 'open', tabId: 'user-sound', url: `${origin}/sound`, rect });
    check(await loaded('user-sound', 'Sound'), 'the user tab loads');
    await run({ action: 'exec', tabId: 'user-sound', code: 'playTone()' });
    const userState = await until(async () => { const state = await run({ action: 'state', tabId: 'user-sound' }); return state.audible ? state : undefined; }, 6000);
    check(userState && userState.muted === false, 'a tab the user opens plays with sound', userState);
    check(status.some((event) => event.type === 'state' && event.tabId === 'user-sound' && event.state?.audible === true), 'the panel is told the tab is playing');
    const unmuted = await run({ action: 'mute', tabId: 'agent-sound', muted: false });
    check(unmuted?.muted === false, 'mute: false turns the sound of the Agent tab on', unmuted);
    const muted = await run({ action: 'mute', tabId: 'user-sound', muted: true });
    check(muted?.muted === true, 'mute: true silences the user tab', muted);
    await run({ action: 'mute', tabId: 'agent-sound', muted: true });
    const before = status.length;
    await run({ action: 'mouse', tabId: 'agent-sound', kind: 'click', selector: '#pop' }, { agent: true });
    const created = await until(() => status.slice(before).find((event) => event.type === 'newTab'), 8000);
    check(created, 'the Agent tab opens a popup tab');
    const popupState = created ? await run({ action: 'state', tabId: created.newTabId }) : undefined;
    check(popupState?.muted === true, 'a popup of a muted Agent tab is muted too', popupState);

    // ---- Reading whole pages for the Agent -------------------------------------------------------------------------
    await run({ action: 'ensure', tabId: 'feed', url: `${origin}/feed`, muted: true }, { agent: true });
    check(await loaded('feed', 'Feed'), 'the endless list loads in a hidden tab');
    const plain = await run({ action: 'read', tabId: 'feed', links: true, tables: true }, { agent: true });
    check(plain?.ok && plain.text.includes('feed row 20') && !plain.text.includes('feed row 21'), 'read without scroll reads what is loaded', plain?.text?.slice(-60));
    check(plain?.links?.some((link) => link.text === 'About us' && link.href === `${origin}/about`), 'read returns the links', plain?.links);
    check(JSON.stringify(plain?.tables) === JSON.stringify([[['Name', 'Score'], ['Ann', '3']]]), 'read returns the tables as rows of cells', plain?.tables);
    const scrolled = await run({ action: 'read', tabId: 'feed', scroll: true, settleMs: 300 }, { agent: true });
    check(scrolled?.ok && scrolled.text.includes('feed row 100') && scrolled.atEnd === true, 'read with scroll loads the endless list to its end', { scrolls: scrolled?.scrolls, atEnd: scrolled?.atEnd, tail: scrolled?.text?.slice(-40) });
    await run({ action: 'ensure', tabId: 'virtual', url: `${origin}/virtual`, muted: true }, { agent: true });
    check(await loaded('virtual', 'Virtual'), 'the virtual list loads');
    const virtual = await run({ action: 'read', tabId: 'virtual', scroll: true, settleMs: 120, maxScrolls: 80 }, { agent: true });
    const rows = (virtual?.text || '').split('\n').filter((line) => line.startsWith('virtual item '));
    check(rows.length === 300 && rows[0] === 'virtual item 1' && rows.at(-1) === 'virtual item 300', 'read with scroll keeps every row of a list that recycles its rows', { rows: rows.length, first: rows[0], last: rows.at(-1) });
    const reader = await run({ action: 'readUrl', url: `${origin}/io-feed`, scroll: true, settleMs: 300 }, { agent: true });
    // Electron crashes in getFocusedWebContents() while an off-screen page outlives its window (browser-view.cjs readAddress).
    const focusedAfterReading = require('electron').webContents.getFocusedWebContents();
    check(focusedAfterReading === null || Number.isInteger(focusedAfterReading.id), 'asking for the focused page right after a reading does not crash');
    check(reader?.ok && reader.text.includes('io row 80') && reader.atEnd === true, 'a reader page loads a list that grows when its end comes into view', { scrolls: reader?.scrolls, atEnd: reader?.atEnd, tail: reader?.text?.slice(-30) });
    const readers = await Promise.all([1, 2, 3].map(() => run({ action: 'readUrl', url: `${origin}/feed` }, { agent: true })));
    check(readers.every((item) => item?.ok && item.title === 'Feed'), 'several reader pages read side by side', readers.map((item) => item?.title));
    check(!require('electron').webContents.getAllWebContents().some((item) => item.getURL().startsWith(`${origin}/io-feed`)), 'reader pages are closed after reading');
    check((await run({ action: 'list' })).every((item) => !String(item.url).includes('/io-feed')), 'reader pages never become workspace tabs');
    const focusBefore = require('electron').webContents.getFocusedWebContents()?.id ?? null;
    const found = await run({ action: 'find', tabId: 'feed', text: 'feed row 7' }, { agent: true });
    check(found?.matches >= 1 && found.elements?.length >= 1, "the Agent's find reports where the words are", found);
    const focusAfter = require('electron').webContents.getFocusedWebContents()?.id ?? null;
    const feedContents = require('electron').webContents.getAllWebContents().find((item) => item.getURL() === `${origin}/feed`);
    check(focusAfter === focusBefore && focusAfter !== feedContents?.id, "the Agent's find does not move the keyboard focus to the page", { focusBefore, focusAfter });
  } finally {
    browser.destroy();
    window.destroy();
    server.close();
  }
  report.passed = report.failures.length === 0;
}

setTimeout(() => {
  report.failures.push('watchdog: the run did not finish within 90 s');
  console.log(JSON.stringify(report, null, 1));
  app.exit(1);
}, 90000).unref();

app.whenReady()
  .then(main)
  .catch((error) => { report.failures.push(`crash: ${error.stack || error.message}`); })
  .finally(() => {
    console.log(JSON.stringify(report, null, 1));
    app.exit(report.failures.length === 0 && report.passed ? 0 : 1);
  });
