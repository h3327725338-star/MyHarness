/*
 * Real-Electron test of the Agent's view in a narrow panel and of click-started downloads (Windows). Not
 * part of `node --test`, because it needs an Electron main process:
 *
 *   npm exec -w @myharness/desktop -- electron packages/desktop/test/electron-agent-view.e2e.cjs --profile=<empty dir>
 *
 * The view only behaves like the app's when the window is composited, so the window is shown, but inactive,
 * unfocusable, off the taskbar and far outside every screen: nothing appears and nothing takes the focus. It checks that
 * a tab the Agent drives in a 426 px wide panel is laid out at the desktop size while the panel shows the part that fits
 * (never a scaled-down picture), that the Agent's screenshot is the whole page, that a person's click gives the page the
 * panel's size back, that the Agent's click at a page point lands there, that a click between two controls names the
 * nearest one, that a background tab is laid out at the desktop size, and that a click on a download link reports the
 * saved file. It prints a JSON report and exits 1 at any broken invariant.
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

// A button, two links with a gap between them, a red mark in the top-right corner of a 426 px viewport, a blue one at the
// right edge of whatever width the page has, and a download link.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Agent View</title></head>
<body style="margin:0;font:14px sans-serif">
<button id="far" style="position:absolute;left:300px;top:30px;width:60px;height:40px">Far</button>
<canvas id="mark" width="10" height="10" style="position:absolute;left:416px;top:0;width:10px;height:10px"></canvas>
<canvas id="edge" width="10" height="10" style="position:absolute;right:0;top:20px;width:10px;height:10px"></canvas>
<script>
// Painted pixels, not a CSS background: dark mode (Dark Reader, when installed) recolors styles but not drawings. The
// canvases are drawn by the CPU (willReadFrequently): a GPU-backed canvas loses its drawing when the GPU process restarts,
// which happens on a desktop nobody looks at, and the marks were then missing from the pictures.
const markPen = document.getElementById('mark').getContext('2d', { willReadFrequently: true });
markPen.fillStyle = 'rgb(255,0,0)';
markPen.fillRect(0, 0, 10, 10);
const edgePen = document.getElementById('edge').getContext('2d', { willReadFrequently: true });
edgePen.fillStyle = 'rgb(0,0,255)';
edgePen.fillRect(0, 0, 10, 10);
</script>
<div id="pages" style="position:absolute;left:40px;top:160px;width:120px;height:30px"><a href="#1" style="position:absolute;left:0;top:6px">1</a><a href="#2" style="position:absolute;left:40px;top:6px">2</a></div>
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

  // --- the Agent drives the visible tab: the page gets the desktop size, the panel shows the part that fits --------
  const shot = await agent({ action: 'snapshot', tabId: 'narrow' });
  const state = await page({ action: 'state', tabId: 'narrow' });
  check(state.bounds?.x === panel.x && state.bounds?.width === 1280 && state.bounds?.height === 900, "the view is laid out at the desktop width from the panel's left edge", state.bounds);
  const narrowView = browser.tabs.find((tab) => tab.id === 'narrow').view;
  const stageBox = window.contentView.children.find((child) => child.children?.includes(narrowView))?.getBounds();
  check(stageBox?.x === panel.x && stageBox?.y === panel.y && stageBox?.width === panel.width && stageBox?.height === panel.height, 'what shows is still only the panel: the wider page is cut at its edge', stageBox);
  const during = await size('narrow');
  check(during?.w === 1280 && during?.h === 900, 'the page is laid out at the desktop size while the Agent acts', during);
  check(shot.width === 1280 && shot.height === 900, 'the Agent screenshot is the whole page', { width: shot.width, height: shot.height });
  const picture = nativeImage.createFromDataURL(shot.snapshot);
  const pixels = picture.toBitmap();
  const at = (x, y) => { const index = (y * picture.getSize().width + x) * 4; return [pixels[index + 2], pixels[index + 1], pixels[index]]; };
  const corner = at(421, 4);
  check(corner[0] > 200 && corner[1] < 60 && corner[2] < 60, 'a page point is in the picture where it is on the page, at full resolution', corner);
  const edge = at(1275, 24);
  check(edge[2] > 200 && edge[0] < 60 && edge[1] < 60, "the page's right edge beyond the panel is in the picture too", edge);

  pictures.length = 0;
  const fallback = await until(() => pictures.find((event) => event.width === 1280), 4000);
  const fallbackSize = fallback && nativeImage.createFromDataURL(fallback.snapshot).getSize();
  check(fallback?.height === 900 && fallbackSize?.width === 1280 && fallbackSize?.height === 900, 'the fallback picture is the whole view, cut by the panel like the view', { event: fallback && { width: fallback.width, height: fallback.height }, image: fallbackSize });

  const clicked = await agent({ action: 'mouse', tabId: 'narrow', kind: 'click', x: 330, y: 50 });
  check(clicked.target?.text === 'Far', 'the click reports the control at that point', clicked.target);
  await until(async () => (await log('narrow')).includes('far:'));
  check((await log('narrow')).includes('far:330,50:true'), 'the Agent click lands on the exact page point', await log('narrow'));
  check((await size('narrow'))?.w === 1280, "the Agent's own click does not give the page back", await size('narrow'));

  // Between link "1" (ends near x=48) and link "2" (starts at x=80): the result names "2" or "1" as the nearest control.
  const gap = await agent({ action: 'mouse', tabId: 'narrow', kind: 'move', x: 70, y: 175 });
  const near = await agent({ action: 'mouse', tabId: 'narrow', kind: 'click', x: 74, y: 175 });
  check(gap.ok && near.target?.missed === true && near.target.nearest?.text === '2' && near.target.nearest.distance <= 24, 'a click on the gap next to a link names the nearest control and its centre', near.target);

  // A person's click in the panel gives the page the panel's size back.
  await wait(1700);
  const contents = narrowView.webContents;
  contents.sendInputEvent({ type: 'mouseDown', x: 20, y: 400, button: 'left', clickCount: 1 });
  contents.sendInputEvent({ type: 'mouseUp', x: 20, y: 400, button: 'left', clickCount: 1 });
  const back = await until(async () => { const value = await size('narrow'); return value?.w === 426 ? value : undefined; }, 4000);
  check(back?.w === 426 && back?.h === 900, 'a person clicking in the page gives it the panel size back', back || (await size('narrow')));

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
