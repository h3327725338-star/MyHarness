/*
 * Real-Electron test of page popups in the built-in browser and of links in an HTML file preview (Windows). Not part of
 * `node --test`, because it needs an Electron main process:
 *
 *   npm exec -w @myharness/desktop -- electron packages/desktop/test/electron-popup-preview.e2e.cjs --profile=<empty dir>
 *
 * The window is never shown (nothing takes the focus). It covers a sign-in style popup (`window.open` with features)
 * that becomes a workspace tab, keeps `window.opener`, posts its result back and closes itself, the same for a popup that
 * starts at about:blank and is steered by its opener, and an HTML preview frame whose link to another site opens a
 * website tab instead of blanking the frame, while a link to the file's own pages still navigates the frame. It prints a
 * JSON report and exits 1 at any broken invariant.
 */
const { app, BrowserWindow, webContents } = require('electron');
const http = require('node:http');
const { mkdirSync } = require('node:fs');

const args = Object.fromEntries(process.argv.slice(2).filter((value) => value.startsWith('--')).map((value) => {
  const [key, ...rest] = value.slice(2).split('=');
  return [key, rest.join('=')];
}));
const profile = args.profile;
const PORT = Number(args.port || 47853);
if (!profile) {
  console.error('usage: electron electron-popup-preview.e2e.cjs --profile=<dir> [--port=47853]');
  app.exit(2);
}
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-features', 'MediaRouter,CalculateNativeWinOcclusion');
// The two parts use a window each; closing the first must not end the run.
app.on('window-all-closed', () => {});
const uncaught = [];
process.on('uncaughtException', (error) => { uncaught.push(error.stack || error.message); });

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

const OPENER = `<!doctype html><html><head><meta charset="utf-8"><title>Opener</title></head><body style="margin:0">
<button id="features" style="position:absolute;left:20px;top:20px;width:160px;height:40px">Sign in</button>
<button id="blank" style="position:absolute;left:20px;top:100px;width:160px;height:40px">Blank</button>
<button id="stay" style="position:absolute;left:20px;top:180px;width:160px;height:40px">Stay</button>
<div id="log"></div>
<script>
const log = [];
addEventListener('message', (event) => { log.push(String(event.data)); document.getElementById('log').textContent = log.join('|'); });
features.onclick = () => window.open('/popup?n=1', 'signin', 'width=480,height=600');
stay.onclick = () => window.open('/popup?n=3&stay=1', 'stays', 'width=400,height=400');
blank.onclick = () => { const w = window.open('', 'steered', 'width=400,height=400'); w.location.href = '/popup?n=2'; };
</script></body></html>`;
// What a sign-in popup does at the end: report to the page that opened it, then close itself.
const POPUP = '<!doctype html><title>Popup</title><script>const n = new URLSearchParams(location.search).get("n"); if (window.opener) window.opener.postMessage("done:" + n, "*"); if (!new URLSearchParams(location.search).has("stay")) setTimeout(() => window.close(), 300);</script>';
const APP = '<!doctype html><title>App</title><iframe id="preview" sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads" src="/api/files/site/token/page.html" style="width:600px;height:400px"></iframe>';
const PAGE = (other) => `<!doctype html><title>Preview</title><a id="ext" href="${other}/external">site</a> <a id="own" href="second.html">second</a>`;

async function main() {
  const origin = `http://127.0.0.1:${PORT}`;
  const other = `http://localhost:${PORT}`;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, origin);
    const html = (body) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(body); };
    if (url.pathname === '/opener') return html(OPENER);
    if (url.pathname === '/popup') return html(POPUP);
    if (url.pathname === '/app') return html(APP);
    if (url.pathname === '/api/files/site/token/page.html') return html(PAGE(other));
    if (url.pathname === '/api/files/site/token/second.html') return html('<!doctype html><title>Second</title><p>second page</p>');
    if (url.pathname === '/external') return html('<!doctype html><title>External</title>');
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });
  try {
    await popups(origin);
    await previewLinks(origin, other);
  } finally {
    server.close();
  }
  report.passed = report.failures.length === 0;
}

async function popups(origin) {
  const window = new BrowserWindow({ width: 1280, height: 900, show: false });
  const status = [];
  const realSend = window.webContents.send.bind(window.webContents);
  window.webContents.send = (channel, payload) => { if (channel === 'desktop:status') status.push(payload); return realSend(channel, payload); };
  const { createBrowser } = require('../browser-view.cjs');
  const browser = createBrowser(window, () => {}, { profileDir: profile });
  const run = (command) => browser.command(command);
  const pageLog = async () => (await run({ action: 'exec', tabId: 'opener', code: "document.getElementById('log').textContent" })).result || '';
  await run({ action: 'open', tabId: 'opener', url: `${origin}/opener`, rect: { x: 0, y: 0, width: 900, height: 700 } });
  check(await until(async () => { const state = await run({ action: 'state', tabId: 'opener' }); return state.loading === false && state.title === 'Opener'; }), 'the opener page loads');

  for (const [n, y, name] of [[1, 40, 'a sign-in popup'], [2, 120, 'a popup that starts at about:blank']]) {
    const before = status.length;
    await run({ action: 'mouse', tabId: 'opener', kind: 'click', x: 100, y });
    const created = await until(() => status.slice(before).find((event) => event.type === 'newTab'), 8000);
    check(created && created.tabId === 'opener', `${name} becomes a workspace tab the opener's panel is told about`, created);
    check(await until(async () => (await pageLog()).includes(`done:${n}`), 8000), `${name} keeps window.opener and reports back to the page`, await pageLog());
    const closed = await until(() => status.slice(before).find((event) => event.type === 'closed' && event.tabId === created?.newTabId), 8000);
    check(closed && closed.selfClosed === true && closed.openerId === 'opener', `${name} that closes itself closes its tab and names the opener`, closed);
    const list = await run({ action: 'list' });
    check(list.length === 1 && list[0].tabId === 'opener', `${name} leaves no tab behind`, list.map((tab) => tab.tabId));
  }
  // The app window closing while a popup tab is still open: the popup's contents go with it, and nothing may try to place a
  // view in the window that is already gone (that was an uncaught error dialog in the main process).
  const before = status.length;
  await run({ action: 'mouse', tabId: 'opener', kind: 'click', x: 100, y: 200 });
  check(await until(() => status.slice(before).find((event) => event.type === 'newTab'), 8000), 'a popup that stays open becomes a tab');
  window.destroy();
  // Quitting the app destroys every page, the popup's included, after the window is gone.
  for (const contents of webContents.getAllWebContents()) if (contents.getURL().includes('stay=1')) contents.close();
  await wait(800);
  check(uncaught.length === 0, 'closing the window with a popup tab open raises no error in the main process', uncaught);
  browser.destroy();
}

async function previewLinks(origin, other) {
  const window = new BrowserWindow({ width: 1000, height: 700, show: false });
  const opened = [];
  const { attachPreviewLinks } = require('../preview-links.cjs');
  attachPreviewLinks(window.webContents, { serviceUrl: () => `${origin}/`, open: (url) => { opened.push(url); } });
  await window.loadURL(`${origin}/app`);
  const frame = await until(() => { const found = window.webContents.mainFrame.frames[0]; return found && found.url.endsWith('/page.html') ? found : undefined; });
  check(!!frame, 'the preview frame loads');
  if (!frame) return;
  await frame.executeJavaScript("document.getElementById('ext').click()");
  check(await until(() => opened.length === 1, 5000) && opened[0] === `${other}/external`, 'a link to another site opens as a website tab', opened);
  await wait(500);
  check(window.webContents.mainFrame.frames[0]?.url.endsWith('/page.html'), 'the preview keeps its page instead of going blank', window.webContents.mainFrame.frames[0]?.url);
  await window.webContents.mainFrame.frames[0].executeJavaScript("document.getElementById('own').click()");
  check(await until(() => window.webContents.mainFrame.frames[0]?.url.endsWith('/second.html'), 5000), 'a link to the file\'s own page still navigates the preview', window.webContents.mainFrame.frames[0]?.url);
  check(opened.length === 1, 'the file\'s own page is not opened as a website tab', opened);
  window.destroy();
}

// A step that never settles must still end the run with a report instead of hanging.
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
