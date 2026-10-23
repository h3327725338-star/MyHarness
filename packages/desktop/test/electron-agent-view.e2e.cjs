/*
 * Real-Electron test of the Agent's desktop-size view in a narrow panel and of click-started downloads (Windows). Not
 * part of `node --test`, because it needs an Electron main process:
 *
 *   npm exec -w @myharness/desktop -- electron packages/desktop/test/electron-agent-view.e2e.cjs --profile=<empty dir>
 *
 * The scaled view only behaves like the app's when the window is composited, so the window is shown, but inactive,
 * unfocusable, off the taskbar and far outside every screen: nothing appears and nothing takes the focus. It checks that
 * a tab the Agent drives in a 426 px wide panel is laid out at 1280×800, that its screenshot is the full desktop picture,
 * that the Agent's click at a page point lands there, that a person's own click hands the page back to the panel size,
 * and that a click on a download link reports the saved file. It prints a JSON report and exits 1 at any broken invariant.
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const http = require('node:http');
const path = require('node:path');
const { mkdirSync, existsSync } = require('node:fs');

const args = Object.fromEntries(process.argv.slice(2).filter((value) => value.startsWith('--')).map((value) => {
  const [key, ...rest] = value.slice(2).split('=');
  return [key, rest.join('=')];
}));
const profile = args.profile;
const PORT = Number(args.port || 47861);
if (!profile) {
  console.error('usage: electron electron-agent-view.e2e.cjs --profile=<dir> [--port=47861]');
  app.exit(2);
}
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
// Downloads of this run stay in the throwaway profile, never in the user's Downloads folder.
const downloads = path.join(profile, 'downloads');
mkdirSync(downloads, { recursive: true });
app.setPath('downloads', downloads);
app.commandLine.appendSwitch('disable-features', 'MediaRouter,CalculateNativeWinOcclusion');

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

// A desktop page: a button far right that a 426 px layout would not even have on screen, a red mark in the top-right
// corner of a 1280 px viewport, and a download link.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Agent View</title></head>
<body style="margin:0;font:14px sans-serif">
<button id="far" style="position:absolute;left:980px;top:30px;width:60px;height:40px">Far</button>
<div style="position:absolute;left:1270px;top:0;width:10px;height:10px;background:rgb(255,0,0)"></div>
<a id="file" href="/files/notes.docx" style="position:absolute;left:40px;top:120px">Download notes.docx</a>
<div id="log" style="position:absolute;left:20px;top:200px"></div>
<script>
const add = (text) => { const log = document.getElementById('log'); log.textContent += (log.textContent ? '|' : '') + text; };
far.addEventListener('click', (event) => add('far:' + event.clientX + ',' + event.clientY + ':' + event.isTrusted));
addEventListener('mousedown', (event) => { if (event.target === document.body) add('body-down'); });
</script></body></html>`;

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(PAGE); return; }
  if (url.pathname === '/files/notes.docx') {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="notes.docx"' });
    response.end(Buffer.alloc(4096, 7));
    return;
  }
  response.writeHead(404); response.end();
});

async function main() {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${PORT}`;
  const window = new BrowserWindow({ width: 1400, height: 1000, x: -20000, y: -20000, show: false, skipTaskbar: true, focusable: false, frame: false });
  window.showInactive();
  const { createBrowser } = require('../browser-view.cjs');
  // The host's status messages go to the window's page; the snapshots among them are collected here.
  const pictures = [];
  const sendStatus = window.webContents.send.bind(window.webContents);
  window.webContents.send = (channel, value) => { if (value?.type === 'snapshot') pictures.push(value); return sendStatus(channel, value); };
  const browser = createBrowser(window, () => {}, { profileDir: profile });
  const page = (command) => browser.command(command);
  const agent = (command) => browser.command(command, { agent: true });
  const log = async (tabId) => (await page({ action: 'exec', tabId, code: "document.getElementById('log').textContent" })).result || '';
  const size = async (tabId) => (await page({ action: 'exec', tabId, code: '({ w: innerWidth, h: innerHeight })' })).result;

  const panel = { x: 900, y: 60, width: 426, height: 900 };
  await page({ action: 'open', tabId: 'narrow', url: `${origin}/`, rect: panel });
  check(await until(async () => (await page({ action: 'state', tabId: 'narrow' })).title === 'Agent View'), 'the page loads');
  const before = await size('narrow');
  check(before?.w === 426, 'before the Agent acts, the page has the panel size', before);

  // --- the Agent's desktop-size view ------------------------------------------------------------------------------
  const shot = await agent({ action: 'snapshot', tabId: 'narrow' });
  check(shot.width === 1280 && shot.height === 800, 'the Agent screenshot is the 1280×800 desktop picture', { width: shot.width, height: shot.height });
  const picture = nativeImage.createFromDataURL(shot.snapshot);
  const pixels = picture.toBitmap();
  const at = (x, y) => { const index = (y * picture.getSize().width + x) * 4; return [pixels[index + 2], pixels[index + 1], pixels[index]]; };
  const corner = at(1275, 4);
  check(corner[0] > 200 && corner[1] < 60 && corner[2] < 60, 'the right edge of the desktop layout is in the picture at full resolution', corner);
  const during = await size('narrow');
  check(during?.w === 1280 && during?.h === 800, 'the page is laid out at 1280×800 for the Agent', during);
  const state = await page({ action: 'state', tabId: 'narrow' });
  check(state.agentView && state.bounds?.width === 426 && state.bounds?.height === 266, 'the panel shows the desktop page scaled down to its width', { agentView: state.agentView, bounds: state.bounds });

  // The fallback picture drawn under the native view has the scaled view's box, not the whole panel.
  pictures.length = 0;
  const fallback = await until(() => pictures.find((event) => event.width === 426), 4000);
  const fallbackSize = fallback && nativeImage.createFromDataURL(fallback.snapshot).getSize();
  check(fallback?.height === 266 && fallbackSize?.width === 426 && fallbackSize?.height === 266, 'the fallback picture covers only the scaled view', { event: fallback && { width: fallback.width, height: fallback.height }, image: fallbackSize, sizes: pictures.map((event) => [event.width, event.height]) });

  const clicked = await agent({ action: 'mouse', tabId: 'narrow', kind: 'click', x: 1010, y: 50 });
  check(clicked.target?.text === 'Far', 'the click reports the control at that desktop point', clicked.target);
  await until(async () => (await log('narrow')).includes('far:'));
  check((await log('narrow')).includes('far:1010,50:true'), 'the Agent click lands on the exact page point of the scaled view', await log('narrow'));

  // --- a person's own click hands the page back -------------------------------------------------------------------
  await wait(1700);
  const contents = browser.tabs.find((tab) => tab.id === 'narrow').view.webContents;
  contents.sendInputEvent({ type: 'mouseDown', x: 200, y: 200, button: 'left', clickCount: 1 });
  contents.sendInputEvent({ type: 'mouseUp', x: 200, y: 200, button: 'left', clickCount: 1 });
  const back = await until(async () => { const value = await size('narrow'); return value?.w === 426 ? value : undefined; }, 5000);
  check(back, 'a person clicking in the page gets the panel-size layout back', await size('narrow'));
  const after = await page({ action: 'state', tabId: 'narrow' });
  check(!after.agentView && after.bounds?.width === 426 && after.bounds?.height === 900, 'the view fills the panel again', { agentView: after.agentView, bounds: after.bounds });

  // --- background tabs --------------------------------------------------------------------------------------------
  await page({ action: 'ensure', tabId: 'back', url: `${origin}/` });
  await until(async () => (await page({ action: 'state', tabId: 'back' })).title === 'Agent View');
  const background = await size('back');
  check(background?.w === 1280 && background?.h === 900, 'a background tab is laid out at least at the desktop size', background);

  // --- a click that downloads -------------------------------------------------------------------------------------
  const download = await agent({ action: 'mouse', tabId: 'narrow', kind: 'click', x: 60, y: 125 });
  const file = download.downloads?.[0];
  check(file?.state === 'completed' && file.name === 'notes.docx' && existsSync(file.savePath) && path.dirname(file.savePath) === downloads, 'the click that downloads reports the finished file and its path', download.downloads);
  const direct = await agent({ action: 'download', tabId: 'back', url: `${origin}/files/notes.docx` });
  check(direct.downloads?.[0]?.state === 'completed' && direct.downloads[0].name === 'notes (1).docx' && existsSync(direct.downloads[0].savePath), 'download saves a link and returns the path', direct.downloads);

  await page({ action: 'close', tabId: '*' });
  report.passed = report.failures.length === 0;
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
    server.close();
    console.log(JSON.stringify(report, null, 1));
    app.exit(report.failures.length === 0 && report.passed ? 0 : 1);
  });
