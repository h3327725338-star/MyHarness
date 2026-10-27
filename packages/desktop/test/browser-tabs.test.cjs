const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

/** Where a view is on the window: its bounds are relative to the container the host keeps the tab views in. */
function onWindow(view) {
  const stage = view.parent?.bounds;
  return view.bounds && stage ? { ...view.bounds, x: view.bounds.x + stage.x, y: view.bounds.y + stage.y } : view.bounds;
}

/** Load browser-view.cjs with a small Electron stand-in: real views cannot be created outside Electron. */
function loadBrowser() {
  const file = path.join(__dirname, '../browser-view.cjs');
  const events = [];
  const contents = [];
  const webRequest = { onCompleted: (handler) => { webRequest.completed = handler; }, onErrorOccurred: (handler) => { webRequest.failed = handler; } };
  const makeContents = (id) => {
    const handlers = new Map();
    const webContents = {
      id,
      url: '',
      on(event, handler) { handlers.set(event, handler); return this; },
      once(event, handler) { handlers.set(event, handler); return this; },
      setWindowOpenHandler(handler) { this.openHandler = handler; },
      async loadURL(url) { this.url = url; webContents.loaded.push(url); },
      downloadURL(url) { webContents.downloaded.push(url); },
      executeJavaScript: async (code) => { webContents.executed.push(code); return { ok: true, code }; },
      capturePage: async () => ({ isEmpty: () => false, toPNG: () => Buffer.from('png'), toJPEG: () => Buffer.from('jpg') }),
      navigationHistory: { canGoBack: () => true, canGoForward: () => false, goBack() {}, goForward() {} },
      isDestroyed: () => false,
      isLoading: () => false,
      isLoadingMainFrame: () => false,
      getURL() { return this.url; },
      reload() {}, stop() {},
      // `exec` runs through Runtime.evaluate; it answers with the expression it was given.
      debugger: { isAttached: () => false, attach() {}, detach() {}, on() {}, sendCommand: async (method, params) => (method === 'Runtime.evaluate' ? { result: { type: 'object', objectId: params.expression } } : method === 'Runtime.callFunctionOn' ? { result: { value: { ok: true, code: params.objectId } } } : { nodes: [] }) },
      close() { webContents.closed = true; },
      handlers,
    };
    webContents.loaded = [];
    webContents.executed = [];
    webContents.downloaded = [];
    contents.push(webContents);
    return webContents;
  };
  let nextId = 1;
  const downloadHandlers = {};
  const permission = {};
  const desktopSession = {
    setPermissionRequestHandler(handler) { permission.request = handler; },
    setPermissionCheckHandler(handler) { permission.check = handler; },
    on(event, handler) { downloadHandlers[event] = handler; },
    webRequest,
  };
  const electron = {
    // The container all tab views live in (it cuts the active view at the part the page leaves uncovered).
    View: class { addChildView(child) { child.parent = this; } removeChildView(child) { if (child.parent === this) child.parent = null; } setBounds(bounds) { this.bounds = bounds; } },
    WebContentsView: class {
      constructor(options) { this.webContents = options?.webContents || makeContents(nextId++); this.visible = false; this.bounds = null; }
      setVisible(value) { this.visible = value; this.visibleCalls = (this.visibleCalls || 0) + 1; }
      getVisible() { return this.visible; }
      setBounds(bounds) { this.bounds = bounds; }
      getBounds() { return this.bounds; }
    },
    session: { fromPartition: () => desktopSession },
    Menu: { buildFromTemplate: () => ({ popup() {} }) },
    shell: { openExternal: async () => undefined },
    app: { getPath: () => os.tmpdir() },
  };
  const module = new Module(file);
  const original = module.require;
  module.require = (name) => (name === 'electron' ? electron : original.call(module, name));
  module._compile(fs.readFileSync(file, 'utf8'), file);
  const window = {
    isDestroyed: () => false,
    webContents: { send: (channel, value) => events.push({ channel, value }) },
    contentView: { children: 0, addChildView() { this.children += 1; }, removeChildView() { this.children -= 1; } },
    size: [1200, 800],
    getContentSize() { return this.size; },
  };
  const browser = module.exports.createBrowser(window, () => {});
  return { browser, events, contents, webRequest, window, download: downloadHandlers['will-download'], permission };
}

/** A download item shaped like Electron's DownloadItem, recording cancellation and listeners. */
function makeDownload() {
  const handlers = new Map();
  const item = {
    filename: 'report.csv',
    url: 'https://example.com/report.csv',
    savePath: '',
    total: 2048,
    received: 0,
    cancelled: false,
    on(event, handler) { handlers.set(event, handler); },
    once(event, handler) { handlers.set(event, handler); },
    getFilename() { return item.filename; },
    getURL() { return item.url; },
    setSavePath(value) { item.savePath = value; },
    getSavePath() { return item.savePath; },
    getTotalBytes() { return item.total; },
    getReceivedBytes() { return item.received; },
    cancel() { item.cancelled = true; },
    handlers,
  };
  return item;
}

test('browser tabs open, activate, report state and close independently', async () => {
  const { browser, events } = loadBrowser();
  const first = await browser.command({ action: 'open', url: 'https://example.com/a' });
  assert.equal(first.url, 'https://example.com/a');
  assert.equal(first.tabId.startsWith('tab'), true);
  const second = await browser.command({ action: 'open', url: 'https://example.com/b' });
  assert.notEqual(second.tabId, first.tabId);
  const list = await browser.command({ action: 'list' });
  assert.equal(list.length, 2);
  const activated = await browser.command({ action: 'activate', tabId: first.tabId, rect: { x: 10, y: 20, width: 400, height: 500 } });
  assert.equal(activated.tabId, first.tabId);
  assert.equal(activated.canGoBack, true);
  assert.equal(activated.canGoForward, false);
  await browser.command({ action: 'close', tabId: second.tabId });
  assert.equal((await browser.command({ action: 'list' })).length, 1);
  assert.equal(events.some((event) => event.value?.type === 'closed'), true);
  browser.destroy();
  assert.equal(browser.tabs.length, 0);
});

test('page commands run against the addressed tab and reject unknown actions or unsafe URLs', async () => {
  const { browser } = loadBrowser();
  const tab = await browser.command({ action: 'open', url: 'https://example.com/' });
  const exec = await browser.command({ action: 'exec', tabId: tab.tabId, code: '1 + 1' });
  assert.equal(exec.result.ok, true);
  assert.equal(exec.result.code, '1 + 1');
  const clicked = await browser.command({ action: 'click', tabId: tab.tabId, selector: '#submit' });
  assert.equal(clicked.ok, true);
  await assert.rejects(() => browser.command({ action: 'open', url: 'file:///C:/Windows' }), /http/);
  await assert.rejects(() => browser.command({ action: 'nope' }), /未知的浏览器命令/);
  await assert.rejects(() => browser.command({ action: 'snapshot', tabId: 'missing' }), /没有浏览器标签/);
  browser.destroy();
});

test('the page owns the tab id: ensure creates it once, keeps its page and does not reload on re-activation', async () => {
  const { browser, contents } = loadBrowser();
  const id = 'browser:https://example.com/dashboard';
  const created = await browser.command({ action: 'ensure', tabId: id, url: 'https://example.com/dashboard' });
  assert.equal(created.tabId, id);
  assert.equal(created.created, true);
  // The first navigation is asynchronous; wait for the load to be recorded.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const loadedOnce = contents[0].loaded.length;
  const again = await browser.command({ action: 'ensure', tabId: id, url: 'https://example.com/dashboard' });
  assert.equal(again.created, undefined);
  assert.equal(contents.length, 1, 'a second ensure must not create another view');
  assert.equal(contents[0].loaded.length, loadedOnce, 'a second ensure must not navigate again');
  const opened = await browser.command({ action: 'open', tabId: id });
  assert.equal(opened.tabId, id);
  assert.equal(contents.length, 1);
  browser.destroy();
});

test('click and type address elements by interactive index as well as by selector', async () => {
  const { browser, contents } = loadBrowser();
  const tab = await browser.command({ action: 'open', url: 'https://example.com/form' });
  const cdp = [];
  contents[0].debugger.sendCommand = async (method, params) => { cdp.push({ method, params }); return {}; };
  await browser.command({ action: 'click', tabId: tab.tabId, index: 2 });
  await browser.command({ action: 'type', tabId: tab.tabId, index: 1, text: 'hello' });
  await browser.command({ action: 'click', tabId: tab.tabId, label: 'Sign in' });
  const codes = contents[0].executed || [];
  // The element is located in the page by the same index list (or by its visible text), then acted on.
  assert.equal(codes.some((code) => code.includes('"index":2')), true);
  assert.equal(codes.some((code) => code.includes('"index":1')), true);
  assert.equal(codes.some((code) => code.includes('"label":"Sign in"')), true);
  // The text arrives through the input method, like a person typing, not as a value assigned by a script.
  assert.deepEqual(cdp.find((entry) => entry.method === 'Input.insertText')?.params, { text: 'hello' });
  await assert.rejects(() => browser.command({ action: 'click', tabId: tab.tabId }), /selector、index 或 label/);
  browser.destroy();
});

test('downloads and request metadata are listed per tab and stay bounded', async () => {
  const { browser, webRequest } = loadBrowser();
  const tab = await browser.command({ action: 'open', url: 'https://example.com/' });
  const contentsId = browser.tabs[0].view.webContents.id;
  webRequest.completed({ webContentsId: contentsId, method: 'GET', url: 'https://example.com/app.js', statusCode: 200, resourceType: 'script' });
  webRequest.failed({ webContentsId: contentsId, method: 'GET', url: 'https://example.com/missing', error: 'net::ERR_FAILED', resourceType: 'xhr' });
  const network = await browser.command({ action: 'network', tabId: tab.tabId });
  assert.equal(network.requests.length, 2);
  assert.equal(network.requests[0].status, 200);
  assert.equal(network.requests[1].error, 'net::ERR_FAILED');
  assert.equal((await browser.command({ action: 'downloads' })).downloads.length, 0);
  browser.destroy();
});

test('a hidden tab reporting its old box never steals the active tab or hides it', async () => {
  const { browser } = loadBrowser();
  const first = await browser.command({ action: 'open', url: 'https://example.com/a', rect: { x: 0, y: 0, width: 300, height: 200 } });
  const second = await browser.command({ action: 'open', url: 'https://example.com/b', rect: { x: 0, y: 0, width: 300, height: 200 } });
  assert.equal(browser.tabs.find((tab) => tab.id === second.tabId).view.getVisible(), true);
  await browser.command({ action: 'bounds', tabId: first.tabId, rect: { x: 5, y: 5, width: 100, height: 100 } });
  assert.equal(browser.tabs.find((tab) => tab.id === first.tabId).view.getVisible(), false);
  assert.equal(browser.tabs.find((tab) => tab.id === second.tabId).view.getVisible(), true);
  browser.destroy();
});

test('site permissions are asked, remembered for the session, denied by default and revocable', async () => {
  const { browser, contents, events, permission } = loadBrowser();
  const tab = await browser.command({ action: 'open', url: 'https://example.com/', rect: { x: 0, y: 0, width: 300, height: 200 } });
  const contents0 = contents[0];
  let answer;
  permission.request(contents0, 'notifications', (value) => { answer = value; }, { requestingUrl: 'https://example.com/' });
  assert.equal(answer, undefined, 'nothing is granted before the user answers');
  const ask = events.find((event) => event.value?.type === 'permission-request');
  assert.ok(ask, 'the request is reported to the workspace');
  assert.equal(ask.value.tabId, tab.tabId);
  assert.equal(ask.value.permission, 'notifications');
  assert.equal(ask.value.origin, 'https://example.com');
  assert.equal(permission.check(contents0, 'notifications', 'https://example.com/'), false, 'an undecided check is denied');

  const allowed = await browser.command({ action: 'permission', requestId: ask.value.requestId, allow: true });
  assert.equal(allowed.allowed, true);
  assert.equal(answer, true, 'the pending page callback receives the decision');
  assert.equal(permission.check(contents0, 'notifications', 'https://example.com/'), true);
  const list = await browser.command({ action: 'permissions', origin: 'https://example.com' });
  assert.deepEqual(list.permissions, [{ origin: 'https://example.com', permission: 'notifications', allowed: true }]);

  let remembered;
  permission.request(contents0, 'notifications', (value) => { remembered = value; }, { requestingUrl: 'https://example.com/settings' });
  assert.equal(remembered, true, 'a remembered allow is applied without another prompt');

  await browser.command({ action: 'revokePermission', origin: 'https://example.com', permissions: ['notifications'] });
  assert.equal(permission.check(contents0, 'notifications', 'https://example.com/'), false, 'revoking clears the decision');
  let again;
  permission.request(contents0, 'notifications', (value) => { again = value; }, { requestingUrl: 'https://example.com/' });
  assert.equal(again, undefined, 'after revoking, the next request asks again');

  let pendingDeny;
  permission.request(contents0, 'clipboard-read', (value) => { pendingDeny = value; }, { requestingUrl: 'https://example.com/' });
  await browser.command({ action: 'close', tabId: tab.tabId });
  assert.equal(pendingDeny, false, 'closing the tab denies a request that is still pending');
  await assert.rejects(() => browser.command({ action: 'permission', requestId: 'missing', allow: true }), /没有待处理的网站权限请求/);
  browser.destroy();
});

test('permission wiring asks the workspace, defaults to denial and enforces the sandbox', async () => {
  const file = path.join(__dirname, '../browser-view.cjs');
  const source = fs.readFileSync(file, 'utf8');
  assert.match(source, /setPermissionRequestHandler/);
  assert.match(source, /type: 'permission-request'/);
  assert.match(source, /PERMISSION_TIMEOUT_MS/);
  assert.match(source, /revokePermission/);
  assert.match(source, /callback\(false\)/);
  assert.match(source, /persist:myharness-third-party/);
  assert.match(source, /contextIsolation: true, nodeIntegration: false, sandbox: true/);
});

test('activating without fresh bounds hides every view and never reuses an old rectangle', async () => {
  const { browser } = loadBrowser();
  const first = await browser.command({ action: 'open', url: 'https://example.com/a', rect: { x: 10, y: 20, width: 400, height: 500 } });
  assert.equal(browser.tabs[0].view.getVisible(), true);
  assert.deepEqual(onWindow(browser.tabs[0].view), { x: 10, y: 20, width: 400, height: 500 });
  // Switching back to the same tab must not show it at the previous rectangle: only a fresh bounds after activation may.
  const second = await browser.command({ action: 'activate', tabId: first.tabId });
  assert.equal(second.visible, false);
  assert.equal(browser.tabs[0].view.getVisible(), false);
  await browser.command({ action: 'bounds', tabId: first.tabId, rect: { x: 50, y: 60, width: 300, height: 400 } });
  assert.equal(browser.tabs[0].view.getVisible(), true);
  assert.deepEqual(onWindow(browser.tabs[0].view), { x: 50, y: 60, width: 300, height: 400 });
  // A null rectangle (tab scrolled away, panel closing) hides immediately and forgets the box.
  await browser.command({ action: 'bounds', tabId: first.tabId, rect: null });
  assert.equal(browser.tabs[0].view.getVisible(), false);
  assert.equal(browser.rectangle, null);
  await browser.command({ action: 'hide' });
  assert.equal(browser.tabs[0].view.getVisible(), false);
  browser.destroy();
});

test('only the active browser tab is visible; closing it does not promote another view to the old box', async () => {
  const { browser } = loadBrowser();
  const first = await browser.command({ action: 'open', url: 'https://example.com/a', rect: { x: 1, y: 2, width: 300, height: 200 } });
  const second = await browser.command({ action: 'open', url: 'https://example.com/b', rect: { x: 1, y: 2, width: 300, height: 200 } });
  const views = () => browser.tabs.map((tab) => ({ id: tab.id, visible: tab.view.getVisible() }));
  assert.deepEqual(views().filter((tab) => tab.visible).map((tab) => tab.id), [second.tabId]);
  await browser.command({ action: 'close', tabId: second.tabId });
  assert.equal(browser.tabs.length, 1);
  assert.equal(browser.tabs[0].view.getVisible(), false, 'closing the active tab must not show the remaining view');
  assert.equal(browser.rectangle, null);
  assert.ok(first.tabId);
  browser.destroy();
});

test('closing a tab cancels its downloads, clears its timers and stops its screenshot interval', async () => {
  const { browser, contents, download } = loadBrowser();
  const tab = await browser.command({ action: 'open', url: 'https://example.com/', rect: { x: 0, y: 0, width: 300, height: 200 } });
  const live = browser.tabs[0];
  contents[0].handlers.get('did-start-loading')();
  assert.ok(live.timer, 'a load must schedule its timeout');
  assert.ok(live.pictures, 'a visible tab takes the fallback screenshot periodically');
  const item = makeDownload();
  download({}, item, contents[0]);
  assert.equal(item.cancelled, false);
  browser.command({ action: 'close', tabId: tab.tabId });
  assert.equal(item.cancelled, true, 'closing the tab must cancel a download that belongs to it');
  assert.equal(live.destroyed, true);
  assert.equal(live.timers.size, 0);
  assert.equal(live.pictures, undefined);
  assert.equal(live.downloads.size, 0);
  assert.equal(contents[0].closed, true);
  assert.equal(browser.tabs.length, 0);
  browser.destroy();
});

test('downloads report progress, can be cancelled by id and retried after they finish', async () => {
  const { browser, contents, events, download } = loadBrowser();
  await browser.command({ action: 'open', url: 'https://example.com/', rect: { x: 0, y: 0, width: 300, height: 200 } });
  const item = makeDownload();
  download({}, item, contents[0]);
  assert.equal(item.savePath.startsWith(os.tmpdir()), true, 'the file is saved to the downloads folder');
  const started = events.find((event) => event.value?.type === 'download' && event.value.state === 'started');
  assert.ok(started);
  const id = started.value.id;
  await browser.command({ action: 'download-cancel', id });
  assert.equal(item.cancelled, true);
  item.handlers.get('done')({}, 'cancelled');
  const listed = await browser.command({ action: 'downloads' });
  assert.equal(listed.downloads.length, 1);
  assert.equal(listed.downloads[0].state, 'cancelled');
  const retried = await browser.command({ action: 'download-retry', id });
  assert.equal(retried.ok, true);
  assert.deepEqual(contents[0].downloaded, [item.url]);
  await assert.rejects(() => browser.command({ action: 'download-cancel', id: 'missing' }), /没有正在进行的下载/);
  browser.destroy();
});

test('window resize re-clamps the native view and a zero-sized window hides it', async () => {
  const { browser, window } = loadBrowser();
  await browser.command({ action: 'open', url: 'https://example.com/', rect: { x: 1000, y: 700, width: 400, height: 300 } });
  const view = browser.tabs[0].view;
  assert.deepEqual(onWindow(view), { x: 1000, y: 700, width: 200, height: 100 });
  window.size = [800, 600];
  browser.refresh();
  // The page's rectangle is still the old one; the host clamps it into the new content area instead of drawing outside.
  assert.deepEqual(onWindow(view), { x: 799, y: 599, width: 1, height: 1 });
  assert.equal(view.getVisible(), true);
  window.size = [0, 0];
  browser.refresh();
  assert.equal(view.getVisible(), false);
  browser.destroy();
});

test('at an app zoom the view ends where the page box ends and reaches the window edges', async () => {
  const { browser, window } = loadBrowser();
  window.size = [1105, 1032];
  window.webContents.getZoomFactor = () => 1.1;
  await browser.command({ action: 'open', url: 'https://example.com/', rect: { x: 0, y: 84, width: 1004, height: 854 } });
  // Rounding each size on its own stopped a pixel short of the window's right and bottom edges (y 92 + height 939).
  assert.deepEqual(onWindow(browser.tabs[0].view), { x: 0, y: 92, width: 1105, height: 940 });
  browser.destroy();
});

test('a clip cuts the active view at the uncovered part without resizing it', async () => {
  const { browser } = loadBrowser();
  const rect = { x: 100, y: 50, width: 800, height: 600 };
  const opened = await browser.command({ action: 'open', url: 'https://example.com/', rect });
  const view = browser.tabs[0].view;
  // A sidebar floats over the left 300px of the box: only the rest is shown, and the page keeps its full size.
  await browser.command({ action: 'bounds', tabId: opened.tabId, rect, clip: { x: 400, y: 50, width: 500, height: 600 } });
  assert.equal(view.getVisible(), true);
  assert.deepEqual(view.parent.bounds, { x: 400, y: 50, width: 500, height: 600 });
  assert.deepEqual(view.bounds, { x: -300, y: 0, width: 800, height: 600 });
  assert.deepEqual(onWindow(view), rect);
  // The state reports the view's box on the window, not inside its container.
  assert.deepEqual((await browser.command({ action: 'state', tabId: opened.tabId })).bounds, rect);
  // A clip that leaves nothing of the box hides the view, which keeps its size.
  await browser.command({ action: 'bounds', tabId: opened.tabId, rect, clip: { x: 950, y: 50, width: 100, height: 600 } });
  assert.equal(view.getVisible(), false);
  assert.deepEqual(view.bounds, { x: -300, y: 0, width: 800, height: 600 });
  // Without a clip the whole box is shown again.
  await browser.command({ action: 'bounds', tabId: opened.tabId, rect });
  assert.equal(view.getVisible(), true);
  assert.deepEqual(view.parent.bounds, rect);
  assert.deepEqual(view.bounds, { x: 0, y: 0, width: 800, height: 600 });
  browser.destroy();
});

test('a view hidden for an animation sends moving frames until it is placed again', async () => {
  const { browser, contents, events } = loadBrowser();
  const rect = { x: 0, y: 0, width: 640, height: 480 };
  const opened = await browser.command({ action: 'open', url: 'https://example.com/', rect });
  const page = contents[0];
  const captures = [];
  let counter = 0;
  page.capturePage = async (area, options) => {
    captures.push({ visible: browser.tabs[0].view.getVisible(), options });
    // Two captures in a row show the same picture: an unchanged frame is not sent again.
    const picture = Buffer.from(`frame${Math.floor(counter++ / 2)}`);
    return { isEmpty: () => false, toPNG: () => picture, toJPEG: () => picture };
  };
  const frames = () => events.filter((event) => event.value?.type === 'frame').map((event) => Buffer.from(event.value.frame.split(',')[1], 'base64').toString());
  await browser.command({ action: 'bounds', tabId: opened.tabId, rect: null, live: true });
  assert.equal(browser.tabs[0].view.getVisible(), false);
  await new Promise((done) => setTimeout(done, 260));
  const live = captures.filter((entry) => entry.options?.stayHidden === true);
  assert.ok(live.length >= 3, `frames are captured while the view is hidden (${live.length})`);
  assert.ok(live.every((entry) => !entry.visible), 'the view is never shown for a frame');
  const sent = frames();
  assert.ok(sent.length >= 2);
  assert.equal(new Set(sent).size, sent.length, 'unchanged frames are not repeated');
  assert.equal(events.filter((event) => event.value?.type === 'frame').at(-1).value.width, 640);
  // The view is placed again: the frames end.
  await browser.command({ action: 'bounds', tabId: opened.tabId, rect });
  const count = captures.length;
  await new Promise((done) => setTimeout(done, 150));
  assert.ok(captures.filter((entry) => entry.options?.stayHidden === true).length <= live.length + 1 || captures.length === count);
  const settled = captures.length;
  await new Promise((done) => setTimeout(done, 150));
  assert.equal(captures.filter((entry) => entry.options?.stayHidden === true && captures.indexOf(entry) >= settled).length, 0, 'no frames after the view is back');
  // A plain hide (no animation) sends no frames either.
  await browser.command({ action: 'bounds', tabId: opened.tabId, rect: null });
  const before = captures.filter((entry) => entry.options?.stayHidden === true).length;
  await new Promise((done) => setTimeout(done, 150));
  assert.equal(captures.filter((entry) => entry.options?.stayHidden === true).length, before);
  browser.destroy();
});


test('Ctrl+T, Ctrl+W and Ctrl+F pressed inside the page reach the workspace', async () => {
  const { browser, contents, events } = loadBrowser();
  const tab = await browser.command({ action: 'open', url: 'https://example.com/' });
  const press = (input) => {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    contents[0].handlers.get('before-input-event')(event, input);
    return event;
  };
  const shortcuts = () => events.filter((event) => event.value?.type === 'shortcut').map((event) => event.value);
  // The native view has no tab strip of its own: the panel owns both buttons, so the page only reports the key.
  const newTab = press({ type: 'keyDown', key: 't', control: true });
  assert.equal(newTab.prevented, true);
  assert.equal(shortcuts().some((value) => value.shortcut === 'new-tab' && value.tabId === tab.tabId), true);
  const closeTab = press({ type: 'keyDown', key: 'w', control: true });
  assert.equal(closeTab.prevented, true);
  assert.equal(shortcuts().some((value) => value.shortcut === 'close-tab'), true);
  assert.equal(press({ type: 'keyDown', key: 'f', control: true }).prevented, true);
  assert.equal(events.some((event) => event.value?.type === 'find-open'), true);
  // Modified keys and key releases are left to the page.
  assert.equal(press({ type: 'keyDown', key: 't', control: true, alt: true }).prevented, false);
  assert.equal(press({ type: 'keyDown', key: 'w', control: true, shift: true }).prevented, false);
  assert.equal(press({ type: 'keyUp', key: 't', control: true }).prevented, false);
  assert.equal(shortcuts().length, 2);
  browser.destroy();
});

test('website tabs send a Chrome user agent without Electron or app tokens', () => {
  const { chromeUserAgent } = require('../browser-view.cjs');
  const fallback = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) MyHarness/0.0.3 Chrome/152.0.7977.167 Electron/44.8.0 Safari/537.36';
  assert.equal(chromeUserAgent(fallback, '152.0.7977.167'), 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36');
  // Without a usable Chromium version the original string is kept rather than inventing one.
  assert.equal(chromeUserAgent(fallback, undefined), fallback);
});

test('only the sites that refuse Electron get the Chrome user agent; bot checks see the engine itself', () => {
  const { wantsChromeAgent } = require('../browser-view.cjs');
  for (const url of ['https://web.whatsapp.com/', 'https://teams.microsoft.com/v2/', 'https://teams.live.com/', 'https://teams.cloud.microsoft/']) assert.equal(wantsChromeAgent(url), true, url);
  for (const url of ['https://sudocode.chat/sign-in', 'https://challenges.cloudflare.com/x', 'https://notwhatsapp.com/', 'not a url']) assert.equal(wantsChromeAgent(url), false, url);
});

test('a page popup keeps its opener as a workspace tab and closes with the page that closed itself', async () => {
  const { browser, events, contents } = loadBrowser();
  const opener = await browser.command({ action: 'open', tabId: 'browser:x', url: 'https://x.com/i/flow/login' });
  const handler = contents.find((item) => item.url === 'https://x.com/i/flow/login').openHandler;
  assert.deepEqual(handler({ url: 'javascript:alert(1)' }), { action: 'deny' });
  const answer = handler({ url: 'https://accounts.google.com/gsi/select' });
  assert.equal(answer.action, 'allow');
  // The engine's own contents (it carries window.opener) become the tab's page; the host does not load the address again.
  const popupContents = { ...contents[0], handlers: new Map(), loaded: [], url: '' };
  popupContents.on = function (event, fn) { this.handlers.set(event, fn); return this; };
  popupContents.once = popupContents.on;
  popupContents.isDestroyed = () => false;
  assert.equal(answer.createWindow({ webContents: popupContents }), popupContents);
  assert.deepEqual(popupContents.loaded, []);
  const created = events.find((event) => event.value?.type === 'newTab')?.value;
  assert.equal(created.tabId, opener.tabId);
  assert.equal(created.url, 'https://accounts.google.com/gsi/select');
  assert.equal((await browser.command({ action: 'list' })).length, 2);
  // A sign-in popup that starts empty is allowed too: its opener steers it.
  assert.equal(handler({ url: 'about:blank' }).action, 'allow');
  // window.close() in the popup destroys its contents: the tab goes and the page is told which tab opened it.
  popupContents.isDestroyed = () => true;
  popupContents.handlers.get('destroyed')();
  const closed = events.find((event) => event.value?.type === 'closed' && event.value.tabId === created.newTabId)?.value;
  assert.equal(closed.selfClosed, true);
  assert.equal(closed.openerId, opener.tabId);
  assert.equal((await browser.command({ action: 'list' })).length, 1);
  browser.destroy();
});
