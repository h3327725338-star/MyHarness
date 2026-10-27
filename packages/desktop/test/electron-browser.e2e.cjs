/*
 * Real-Electron smoke test for the built-in browser (Windows). It is not part of `node --test test/*.test.cjs`
 * because it needs an Electron main process:
 *
 *   npm exec -w @myharness/desktop -- electron packages/desktop/test/electron-browser.e2e.cjs --phase=1 --profile=<dir> --downloads=<dir>
 *   npm exec -w @myharness/desktop -- electron packages/desktop/test/electron-browser.e2e.cjs --phase=2 --profile=<dir> --downloads=<dir>
 *
 * Phase 1 creates a tab, drives the full command surface (navigation, text/DOM/interactive, click/type/exec/scroll,
 * screenshot, accessibility tree, downloads, popup windows, permission denial), checks native visibility and bounds and
 * stores a cookie plus localStorage. Phase 2 opens the same origin again and verifies the cookie/localStorage survived the
 * restart. Both phases use a fixed port so the origin is the same. The harness fails with exit code 1 at the first
 * broken invariant; it prints a JSON report instead of claiming success without evidence. `--hidden` keeps the window
 * off screen and every page muted (nothing takes the focus or plays sound while someone uses the computer); the
 * native-visibility checks then cover the tab views only.
 */
const { app, BrowserWindow, session } = require('electron');
const http = require('node:http');
const { fork } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const { mkdirSync, readFileSync, statSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const args = Object.fromEntries(
  process.argv.slice(2).filter((value) => value.startsWith('--')).map((value) => {
    const [key, ...rest] = value.slice(2).split('=');
    return [key, rest.join('=')];
  }),
);
const phase = args.phase || '1';
// Resolved: Chromium interrupts every download when the downloads folder is set as a path mixing back and forward slashes.
const profile = args.profile && resolve(args.profile);
const downloads = args.downloads && resolve(args.downloads);
const PORT = Number(args.port || 47831);
if (!profile || !downloads) {
  console.error('usage: electron electron-browser.e2e.cjs --phase=1|2 --profile=<dir> --downloads=<dir> [--port=47831]');
  app.exit(2);
}
mkdirSync(profile, { recursive: true });
mkdirSync(downloads, { recursive: true });
app.setPath('userData', profile);
app.setPath('downloads', downloads);
app.commandLine.appendSwitch('disable-features', 'MediaRouter,CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
if (args.hidden !== undefined) app.on('web-contents-created', (_event, contents) => contents.setAudioMuted(true));

const report = { phase, checks: [], events: [], failures: [] };
const check = (ok, name, detail) => {
  report.checks.push({ name, ok: !!ok, detail });
  if (!ok) report.failures.push(`${name}${detail === undefined ? '' : `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  return !!ok;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await wait(50);
  }
  return undefined;
};

const PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><title>E2E Page</title>
<h1 id="heading">Hello E2E</h1>
<input id="name" placeholder="name">
<input id="file" type="file">
<input id="clearing" type="file">
<button id="go" onclick="document.getElementById('out').textContent='clicked:'+document.getElementById('name').value">Go</button>
<div id="out">idle</div>
<p>find me one</p><p>find me two</p>
<a id="pop" href="/popup" target="_blank">popup</a>
<a id="dl" href="/download">download</a>
<script>
document.getElementById('name').addEventListener('input', function (event) {
  document.getElementById('out').textContent = 'typed:' + event.target.value;
});
// Like many upload pages: take the file in the change handler, then empty the input so the same file can be chosen again.
window.__uploads = [];
document.getElementById('clearing').addEventListener('change', function (event) {
  window.__uploads.push(event.target.files[0] ? event.target.files[0].name : 'none');
  event.target.value = '';
});
window.__e2e = { ready: true, href: location.href };
</script>`;
const POPUP = '<!doctype html><title>Popup</title><h2>Popup page</h2>';
const big = randomBytes(2 * 1024 * 1024);
const bigHash = createHash('sha256').update(big).digest('hex');

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(PAGE);
    return;
  }
  if (url.pathname === '/popup') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(POPUP);
    return;
  }
  if (url.pathname === '/download') {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="e2e-download.bin"', 'content-length': big.length });
    response.end(big);
    return;
  }
  if (url.pathname === '/slow') {
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="e2e-slow.bin"', 'content-length': 8 * 1024 * 1024 });
    let sent = 0;
    const timer = setInterval(() => {
      if (sent >= 8 * 1024 * 1024) { clearInterval(timer); response.end(); return; }
      response.write(Buffer.alloc(64 * 1024, 1));
      sent += 64 * 1024;
    }, 40);
    request.on('close', () => clearInterval(timer));
    return;
  }
  response.writeHead(404);
  response.end('not found');
});

async function main() {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${PORT}`;
  const window = new BrowserWindow({ width: 1280, height: 900, show: args.hidden === undefined, webPreferences: { sandbox: true }, backgroundColor: '#202020' });
  const status = [];
  const realSend = window.webContents.send.bind(window.webContents);
  window.webContents.send = (channel, payload) => {
    if (channel === 'desktop:status') status.push(payload);
    return realSend(channel, payload);
  };
  const { createBrowser } = require('../browser-view.cjs');
  const workspaceRoot = join(profile, 'workspace');
  const outsideFile = join(profile, 'outside.txt');
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(join(workspaceRoot, 'upload-source.txt'), 'upload me\n');
  mkdirSync(join(workspaceRoot, 'folder'), { recursive: true });
  writeFileSync(outsideFile, 'not allowed\n');
  const browser = createBrowser(window, (message) => report.events.push(`log:${message}`), { workspaceRoot });

  // --- permission + page commands ---------------------------------------------------------------
  const tab = await browser.command({ action: 'open', url: origin, rect: { x: 100, y: 80, width: 700, height: 600 } });
  const id = tab.tabId;
  check(!!id, 'opens a tab');
  const view = browser.tabs[0].view;
  check(view.getVisible() === true, 'a tab opened with bounds is visible');
  // Tab views live in one container view that has the shown box; a view's own bounds are relative to that container.
  const inWindow = (tabView) => {
    const own = tabView.getBounds();
    const container = window.contentView.children.find((child) => child.children.includes(tabView));
    const origin = container ? container.getBounds() : { x: 0, y: 0 };
    return { x: origin.x + own.x, y: origin.y + own.y, width: own.width, height: own.height };
  };
  const bounds = inWindow(view);
  check(bounds.x === 100 && bounds.y === 80 && bounds.width === 700 && bounds.height === 600, 'bounds are exactly the requested rectangle', bounds);
  const state = await until(async () => {
    const value = await browser.command({ action: 'state', tabId: id });
    return value?.title === 'E2E Page' && value.loading === false ? value : undefined;
  });
  check(!!state, 'the page title and load state are reported', status.filter((value) => value.type === 'state').slice(-1));
  const text = await browser.command({ action: 'text', tabId: id });
  check(/Hello E2E/.test(text.result || ''), 'reads the page text', text.result && text.result.slice(0, 80));
  const dom = await browser.command({ action: 'dom', tabId: id });
  check(/id="heading"/.test(dom.html || ''), 'reads the page DOM');
  const interactive = await browser.command({ action: 'interactive', tabId: id });
  check(interactive.elements.some((entry) => entry.id === 'go') && interactive.elements.some((entry) => entry.id === 'name'), 'lists interactive elements');
  const found = await browser.command({ action: 'find', tabId: id, text: 'find me' });
  check(found.ok === true && found.matches === 2 && found.activeMatch >= 1, 'finds text in the page and reports the real match count', found);
  const next = await browser.command({ action: 'find', tabId: id, text: 'find me', findNext: true, forward: true });
  check(next.ok === true && next.matches === 2 && next.activeMatch === 2, 'moves to the next match', next);
  const stopped = await browser.command({ action: 'stopFind', tabId: id });
  check(stopped.ok === true, 'stops the find and clears the selection');
  // Upload: only a real file inside the workspace can be handed to the page's file input.
  const uploaded = await browser.command({ action: 'upload', tabId: id, selector: '#file', path: 'upload-source.txt' });
  check(uploaded.ok === true && uploaded.name === 'upload-source.txt', 'a workspace file is uploaded into the page input', uploaded);
  const fileState = await browser.command({ action: 'exec', tabId: id, code: '(() => { const f = document.querySelector("#file").files[0]; return f ? { name: f.name, size: f.size } : null; })()' });
  check(fileState.result && fileState.result.name === 'upload-source.txt' && fileState.result.size === 10, 'the page sees the uploaded file', fileState.result);
  const intoClearing = await browser.command({ action: 'upload', tabId: id, selector: '#clearing', path: 'upload-source.txt' });
  check(intoClearing.ok === true && intoClearing.count === 1, 'an upload counts although the page empties its input on change', intoClearing);
  const handled = await browser.command({ action: 'exec', tabId: id, code: 'window.__uploads' });
  check(JSON.stringify(handled.result) === '["upload-source.txt"]', 'the page handled the chosen file once, not twice', handled.result);
  await assertRejects(() => browser.command({ action: 'upload', tabId: id, selector: '#file', path: outsideFile }), /只能上传当前工作区内的文件/, 'a file outside the workspace is refused');
  await assertRejects(() => browser.command({ action: 'upload', tabId: id, selector: '#file', path: 'folder' }), /普通文件/, 'a directory is refused');
  await assertRejects(() => browser.command({ action: 'upload', tabId: id, selector: '#file', path: 'missing.txt' }), /不存在/, 'a missing file is refused');
  await assertRejects(() => browser.command({ action: 'upload', tabId: id, selector: '#name', path: 'upload-source.txt' }), /input type="file"/, 'a non-file input is refused');
  // The Agent tool, end to end: real IPC to this Electron main process, real WebContentsView commands, faux model turn.
  const toolRun = await runWorkspaceTool(browser, origin, id, workspaceRoot);
  const toolText = Array.isArray(toolRun.report.results) ? toolRun.report.results.join('\n') : '';
  check(toolRun.code === 0 && toolRun.report.ok === true, 'the Agent workspace tool runs through real IPC', { code: toolRun.code, failures: toolRun.report.error || toolRun.errors.slice(-800), output: toolRun.output.slice(-800) });
  check(/desktop_host=connected/.test(toolText), 'the tool reports a connected desktop host', toolText.slice(0, 400));
  check(/opened browser tab/.test(toolText), 'the tool opens the real browser tab', toolText.slice(0, 400));
  check(/2 match\(es\)/.test(toolText), 'the tool finds in the real page', toolText.slice(-500));
  check(/uploaded upload-source\.txt/.test(toolText), 'the tool uploads a workspace file into the real page', toolText.slice(-500));
  check(toolRun.actions.includes('browser:ensure') && toolRun.actions.includes('browser:find') && toolRun.actions.includes('browser:upload'), 'the tool used the real browser command surface', toolRun.actions);
  const typed = await browser.command({ action: 'type', tabId: id, selector: '#name', text: 'Ada' });
  check(typed.ok === true && typed.value === 'Ada', 'types into a field', typed);
  await wait(120);
  const afterType = await browser.command({ action: 'text', tabId: id });
  check(/typed:Ada/.test(afterType.result || ''), 'the page saw the typed input event', afterType.result && afterType.result.slice(0, 80));
  const clicked = await browser.command({ action: 'click', tabId: id, selector: '#go' });
  check(clicked.ok === true, 'clicks a button');
  await wait(120);
  const afterClick = await browser.command({ action: 'text', tabId: id });
  check(/clicked:Ada/.test(afterClick.result || ''), 'the button handler ran', afterClick.result && afterClick.result.slice(0, 80));
  const executed = await browser.command({ action: 'exec', tabId: id, code: '({ ready: window.__e2e.ready, title: document.title })' });
  check(executed.result && executed.result.ready === true && executed.result.title === 'E2E Page', 'executes page JavaScript', executed.result);
  const scrolled = await browser.command({ action: 'scroll', tabId: id, x: 0, y: 40 });
  // The page may be too short to scroll; the answer must still say how far it moved and what it tried.
  check(scrolled.ok && typeof scrolled.moved === 'number' && ['script', 'wheel'].includes(scrolled.how), 'scrolls the page', scrolled);
  let ax = { nodes: [] };
  try {
    ax = await browser.command({ action: 'ax', tabId: id });
  } catch (error) {
    report.events.push(`ax-error:${error.message}`);
  }
  check(ax.nodes.length > 0, 'reads the accessibility tree', { nodes: ax.nodes.length });
  const shot = await browser.command({ action: 'snapshot', tabId: id });
  check(/^data:image\/png;base64,/.test(shot.snapshot || ''), 'captures a real PNG of the visible page', { bytes: String(shot.snapshot || '').length });

  // --- permissions: asked, explicitly allowed, remembered for the session, revocable --------------
  await browser.command({ action: 'exec', tabId: id, code: `(() => {
    window.__perm = [];
    try { Notification.requestPermission().then(v => window.__perm.push('notification:' + v)).catch(e => window.__perm.push('notification-error:' + e.name)); } catch (e) { window.__perm.push('notification-throw:' + e.name); }
    return true;
  })()` });
  const permissionAsk = await until(() => status.find((value) => value.type === 'permission-request' && value.permission === 'notifications'), 8000);
  check(!!permissionAsk && permissionAsk.allowed === undefined, 'a site permission request waits for an explicit decision', permissionAsk);
  const beforeAnswer = await browser.command({ action: 'exec', tabId: id, code: 'window.__perm' });
  check(Array.isArray(beforeAnswer.result) && beforeAnswer.result.length === 0, 'the page is not granted before the decision', beforeAnswer.result);
  if (permissionAsk) {
    const allowed = await browser.command({ action: 'permission', requestId: permissionAsk.requestId, allow: true });
    check(allowed.allowed === true && allowed.origin === origin, 'an explicit allow is applied', allowed);
    const granted = await until(async () => {
      const value = await browser.command({ action: 'exec', tabId: id, code: 'window.__perm' });
      return Array.isArray(value.result) && value.result.includes('notification:granted') ? value.result : undefined;
    }, 8000);
    check(!!granted, 'the page observes the granted permission', granted);
    const decided = await browser.command({ action: 'permissions', origin });
    check(decided.permissions.some((entry) => entry.permission === 'notifications' && entry.allowed === true), 'the session remembers the allow decision', decided);
    const revoked = await browser.command({ action: 'revokePermission', origin, permissions: ['notifications'] });
    check(revoked.ok === true && revoked.revoked === 1, 'the decision can be revoked', revoked);
    const afterRevoke = await browser.command({ action: 'permissions', origin });
    check(!afterRevoke.permissions.some((entry) => entry.permission === 'notifications'), 'the revoked decision is gone', afterRevoke);
  }
  // A second, different permission is denied explicitly; the page must see the denial.
  await browser.command({ action: 'exec', tabId: id, code: `(() => {
    window.__perm2 = [];
    try { navigator.geolocation.getCurrentPosition(() => window.__perm2.push('geo:granted'), (error) => window.__perm2.push('geo:' + error.code)); } catch (e) { window.__perm2.push('geo-throw:' + e.name); }
    return true;
  })()` });
  const geoAsk = await until(() => status.find((value) => value.type === 'permission-request' && value.permission.startsWith('geolocation')), 8000);
  check(!!geoAsk, 'a geolocation request asks instead of being granted silently', geoAsk);
  if (geoAsk) {
    await browser.command({ action: 'permission', requestId: geoAsk.requestId, allow: false });
    const denied = await until(async () => {
      const value = await browser.command({ action: 'exec', tabId: id, code: 'window.__perm2' });
      return Array.isArray(value.result) && value.result.some((entry) => String(entry).startsWith('geo:')) ? value.result : undefined;
    }, 8000);
    check(!!denied, 'the page observes the denied permission', denied);
  }

  // --- popup windows become workspace tabs ------------------------------------------------------
  // The tab that appears now (earlier steps may have left other tabs open besides this one).
  const beforePopup = new Set((await browser.command({ action: 'list' })).map((entry) => entry.tabId));
  await browser.command({ action: 'exec', tabId: id, code: `void window.open('${origin}/popup', '_blank')` });
  const popupTab = await until(async () => {
    const list = await browser.command({ action: 'list' });
    return list.find((entry) => !beforePopup.has(entry.tabId));
  }, 10000);
  check(!!popupTab, 'a page-requested window becomes a separate browser tab', { before: [...beforePopup] });
  if (popupTab) {
    const popupState = await until(async () => {
      const value = await browser.command({ action: 'state', tabId: popupTab.tabId });
      return value.title === 'Popup' ? value : undefined;
    }, 10000);
    check(!!popupState, 'the popup tab loads its own page', popupState);
  }

  // --- downloads: real file bytes, progress, cancel --------------------------------------------
  await browser.command({ action: 'activate', tabId: id, rect: { x: 100, y: 80, width: 700, height: 600 } });
  await browser.command({ action: 'navigate', tabId: id, url: `${origin}/` });
  await until(() => status.some((value) => value.tabId === id && value.type === 'state' && value.state.loading === false), 10000);
  await browser.command({ action: 'exec', tabId: id, code: `document.getElementById('dl').click()` });
  const completed = await until(() => status.find((value) => value.type === 'download' && value.state === 'completed'), 20000);
  check(!!completed, 'a download completes and is reported', status.filter((value) => value.type === 'download').slice(-1));
  if (completed) {
    const file = readFileSync(completed.savePath);
    check(statSize(completed.savePath) === big.length, 'the downloaded file has the server bytes', statSize(completed.savePath));
    check(createHash('sha256').update(file).digest('hex') === bigHash, 'the downloaded file content matches');
    check(completed.savePath.startsWith(downloads), 'the download was saved in the configured downloads folder', completed.savePath);
  }
  await browser.command({ action: 'exec', tabId: id, code: `location.href = '${origin}/slow'` });
  const started = await until(() => status.find((value) => value.type === 'download' && value.state === 'started' && value.name === 'e2e-slow.bin'), 15000);
  check(!!started, 'the slow download started');
  if (started) {
    const cancelled = await browser.command({ action: 'download-cancel', id: started.id });
    check(cancelled.ok === true, 'the download can be cancelled by id');
    const final = await until(() => status.find((value) => value.type === 'download' && value.id === started.id && value.state === 'cancelled'), 10000);
    check(!!final, 'the cancelled download reports its cancelled state', status.filter((value) => value.id === started.id).slice(-1));
    const retry = await browser.command({ action: 'download-retry', id: started.id });
    check(retry.ok === true, 'a finished download can be retried');
  }
  const network = await browser.command({ action: 'network', tabId: id });
  check(network.requests.length > 0 && network.requests.every((entry) => !('headers' in entry) && !('body' in entry)), 'network metadata is reported without headers or bodies', { count: network.requests.length });

  // --- visibility invariants while switching, resizing and maximizing ---------------------------
  const second = await browser.command({ action: 'open', url: `${origin}/popup`, rect: { x: 20, y: 30, width: 500, height: 400 } });
  const views = () => browser.tabs.map((entry) => ({ id: entry.id, visible: entry.view.getVisible(), bounds: entry.view.getBounds() }));
  check(views().filter((entry) => entry.visible).map((entry) => entry.id).join() === second.tabId, 'only the active browser tab is visible', views());
  const hiddenBack = await browser.command({ action: 'activate', tabId: id });
  check(hiddenBack.visible === false, 'activating a tab without fresh bounds keeps it hidden', hiddenBack);
  check(views().every((entry) => entry.visible === false), 'no other view stays visible after activation', views());
  await browser.command({ action: 'bounds', tabId: id, rect: { x: 40, y: 50, width: 640, height: 520 } });
  check(views().find((entry) => entry.id === id).visible === true, 'fresh bounds show the active tab again');
  await browser.command({ action: 'hide' });
  check(views().every((entry) => entry.visible === false), 'hide() hides every view');
  await browser.command({ action: 'bounds', tabId: id, rect: { x: 40, y: 50, width: 640, height: 520 } });
  window.setContentSize(900, 700);
  browser.refresh();
  const resized = inWindow(browser.tabs.find((entry) => entry.id === id).view);
  const [contentWidth, contentHeight] = window.getContentSize();
  check(resized.x + resized.width <= contentWidth && resized.y + resized.height <= contentHeight, 'a resize re-clamps the native view into the content area', { resized, contentWidth, contentHeight });
  // The page's rectangle is re-measured by the page itself; the native host must not draw a stale box after the resize.
  await browser.command({ action: 'bounds', tabId: id, rect: { x: 40, y: 50, width: 640, height: 520 } });
  const restored = browser.tabs.find((entry) => entry.id === id).view.getBounds();
  check(restored.width === 640 && restored.height === 520, 'new bounds after a resize are applied as measured', restored);

  // --- persistence: cookie and localStorage survive a restart (phase 2) -------------------------
  if (phase === '1') {
    const stored = await browser.command({ action: 'exec', tabId: id, code: `(() => {
      document.cookie = 'e2e=1; max-age=3600; path=/; SameSite=Lax';
      localStorage.setItem('e2e', 'yes');
      return document.cookie.includes('e2e=1') && localStorage.getItem('e2e') === 'yes';
    })()` });
    check(stored.result === true, 'phase 1 stores a cookie and localStorage');
    const partition = session.fromPartition('persist:myharness-third-party');
    if (partition.flushStorageData) partition.flushStorageData();
    await partition.cookies.flushStore();
    await wait(500);
  } else {
    const read = await browser.command({ action: 'exec', tabId: id, code: `({ cookie: document.cookie, local: localStorage.getItem('e2e') })` });
    check(/e2e=1/.test(read.result?.cookie || ''), 'the cookie survived the restart', read.result);
    check(read.result?.local === 'yes', 'localStorage survived the restart', read.result);
  }

  // --- close cleans the native view; unsafe URLs stay rejected ----------------------------------
  const closedId = id;
  await browser.command({ action: 'close', tabId: id });
  check(browser.tabs.every((entry) => entry.id !== closedId), 'closing removes the tab and its view');
  await assertRejects(() => browser.command({ action: 'open', url: 'file:///C:/Windows' }), /http/, 'file URLs are rejected');
  await assertRejects(() => browser.command({ action: 'open', url: 'https://user:pass@example.com/' }), /http/, 'URLs with credentials are rejected');
  await browser.command({ action: 'close', tabId: '*' });
  check(browser.tabs.length === 0, 'close(*) removes every tab');
  report.passed = report.failures.length === 0;
  if (report.passed) report.events.push('e2e:passed');
}

function statSize(file) {
  try { return statSync(file).size; } catch { return -1; }
}

/**
 * Run the real `workspace` Agent tool in a child process over a real IPC channel, with this Electron main process as the
 * host. The model is the test harness's faux stream (an isolated model channel), but every browser command below is the
 * real WebContentsView command surface. `origin` and `tabId` must name the already-open real tab.
 */
async function runWorkspaceTool(browser, origin, tabId, workspaceRoot) {
  const repo = resolve(__dirname, '../../..');
  const fixture = join(repo, 'packages/coding-agent/test/fixtures/workspace-tool-ipc-child.ts');
  const loader = pathToFileURL(join(repo, 'scripts/dev-fast-loader.mjs')).href;
  const child = fork(fixture, [], {
    execArgv: ['--import', loader],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      MYHARNESS_DESKTOP_HOST: '1',
      WORKSPACE_IPC_PAGE_URL: origin,
      WORKSPACE_IPC_FIND: 'find me',
      WORKSPACE_IPC_UPLOAD: 'upload-source.txt',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  const pageState = {
    tabs: [
      { id: 'changes', type: 'changes' },
      // The address as the page stores it (normalized, with the trailing slash): opening it again finds this tab.
      { id: tabId, type: 'browser', url: new URL(origin).href },
    ],
    activeId: tabId,
    panelOpen: true,
    closed: [],
    media: null,
  };
  const actions = [];
  let output = '';
  let errors = '';
  child.stdout?.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr?.on('data', (chunk) => { errors += chunk.toString(); });
  child.on('message', async (message) => {
    if (message?.type !== 'myharness:browser-command') return;
    const action = String(message.action || '');
    const command = message.command || {};
    actions.push(`${action}:${String(command.action)}`);
    try {
      const value = action === 'workspace' ? pageState : await browser.command(command);
      child.send({ type: 'myharness:browser-result', requestId: message.requestId, ok: true, value });
    } catch (error) {
      child.send({ type: 'myharness:browser-result', requestId: message.requestId, ok: false, error: error?.message || String(error) });
    }
  });
  const code = await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    new Promise((resolveTimeout) => setTimeout(() => { child.kill(); resolveTimeout('timeout'); }, 90000)),
  ]);
  const report = (() => {
    const line = output.trim().split(/\r?\n/).filter(Boolean).at(-1);
    try { return JSON.parse(line || '{}'); } catch { return {}; }
  })();
  return { code, report, actions, output, errors, workspaceRoot };
}

async function assertRejects(fn, pattern, name) {
  try {
    await fn();
    check(false, name, 'the command succeeded');
  } catch (error) {
    check(pattern.test(error.message), name, error.message);
  }
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (error) {
    report.failures.push(`threw: ${error?.stack || error}`);
  } finally {
    try {
      const partition = session.fromPartition('persist:myharness-third-party');
      if (partition.flushStorageData) partition.flushStorageData();
      await partition.cookies.flushStore();
    } catch { /* best effort */ }
    server.close();
    await wait(300);
    const output = args.report || join(downloads, `electron-browser-${phase}.json`);
    try { writeFileSync(output, JSON.stringify(report, null, 2)); } catch { /* temp dir may be gone */ }
    console.log(JSON.stringify({ passed: report.passed === true, failures: report.failures, report: output }));
    app.exit(report.passed === true ? 0 : 1);
  }
});
