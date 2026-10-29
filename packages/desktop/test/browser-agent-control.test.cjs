const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { keyEvents } = require('../browser-input.cjs');
const { createSpeedDialStore } = require('../browser-speed-dial.cjs');

/**
 * browser-view.cjs with an Electron stand-in that records DevTools protocol commands, isolated-world scripts and view
 * bounds, and a real bookmark file in a temporary profile.
 */
function loadHost() {
  const file = path.join(__dirname, '../browser-view.cjs');
  const events = [];
  const cdp = [];
  const permission = {};
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-agent-control-'));
  let nextId = 1;
  const makeContents = () => {
    const webContents = {
      id: nextId++,
      url: '',
      handlers: {},
      on(name, handler) { this.handlers[name] = handler; return this; },
      setWindowOpenHandler() {},
      async loadURL(url) { this.url = url; },
      executeJavaScript: async (code) => {
        // Page-helper scripts (browser-page-helpers.cjs) carry the shared helpers' source, so they are told apart first.
        if (code.includes('function pageFocused(')) return { tag: 'input', value: 'typed' };
        if (code.includes('function pageHelpers(')) return null;
        if (code.includes('innerWidth')) return { width: 800, height: 600 };
        if (code.includes('elementFromPoint')) return { tag: 'img', src: '/logo.png' };
        if (code.includes('activeElement')) return { tag: 'input', value: 'typed' };
        return null;
      },
      executeJavaScriptInIsolatedWorld: async (world, scripts) => {
        webContents.isolated.push({ world, code: scripts[0].code });
        // Where the input-scale probe landed: set by a test, undefined (no measurement) otherwise.
        return scripts[0].code === 'window.__myharnessProbe.x' ? webContents.probeX : undefined;
      },
      capturePage: async () => ({ isEmpty: () => false, toPNG: () => Buffer.from('visible'), toJPEG: () => Buffer.from('jpg') }),
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      isDestroyed: () => false,
      isLoading: () => false,
      isLoadingMainFrame: () => false,
      getURL() { return this.url; },
      setBackgroundThrottling() {},
      debugger: {
        attached: false,
        isAttached() { return this.attached; },
        attach() { this.attached = true; },
        detach() { this.attached = false; },
        on() {},
        sendCommand: async (method, params) => {
          cdp.push({ id: webContents.id, method, params });
          if (method === 'Page.captureScreenshot') return { data: Buffer.from('cdp-png').toString('base64') };
          return {};
        },
      },
      close() {},
      isolated: [],
    };
    return webContents;
  };
  const desktopSession = {
    setPermissionRequestHandler(handler) { permission.request = handler; },
    setPermissionCheckHandler(handler) { permission.check = handler; },
    on(name, handler) { desktopSession[name] = handler; },
    webRequest: { onCompleted() {}, onErrorOccurred() {} },
  };
  const electron = {
    // The container all tab views live in (it cuts the active view at the part the page leaves uncovered).
    View: class { addChildView(child) { child.parent = this; } removeChildView(child) { if (child.parent === this) child.parent = null; } setBounds(bounds) { this.bounds = bounds; } },
    WebContentsView: class {
      constructor() { this.webContents = makeContents(); this.visible = false; this.bounds = null; }
      setVisible(value) { this.visible = value; }
      getVisible() { return this.visible; }
      setBounds(bounds) { this.bounds = bounds; }
      getBounds() { return this.bounds; }
    },
    session: { fromPartition: () => desktopSession },
    Menu: { buildFromTemplate: () => ({ popup() {} }) },
    shell: { openExternal: async () => undefined },
    app: { getPath: () => os.tmpdir() },
    nativeImage: {
      createFromBuffer: (buffer) => ({
        isEmpty: () => !buffer.length,
        getSize: () => ({ width: 800, height: 600 }),
        resize: () => { throw new Error('no resize expected'); },
        toPNG: () => buffer,
      }),
    },
  };
  const module = new Module(file);
  const original = module.require;
  module.require = (name) => (name === 'electron' ? electron : original.call(module, name));
  module._compile(fs.readFileSync(file, 'utf8'), file);
  const window = {
    isDestroyed: () => false,
    webContents: { send: (channel, value) => events.push(value) },
    contentView: { addChildView() {}, removeChildView() {} },
    getContentSize: () => [1200, 800],
  };
  const browser = module.exports.createBrowser(window, () => {}, { profileDir });
  const cleanup = () => { browser.destroy(); fs.rmSync(profileDir, { recursive: true, force: true }); };
  return { browser, events, cdp, permission, desktopSession, cleanup };
}

test('keys: names and combinations become the key events of a real key press', () => {
  const enter = keyEvents('Enter');
  assert.deepEqual(enter.map((event) => event.type), ['keyDown', 'keyUp']);
  assert.equal(enter[0].text, '\r');
  assert.equal(enter[0].windowsVirtualKeyCode, 13);
  const selectAll = keyEvents('Control+A');
  assert.deepEqual(selectAll.map((event) => `${event.type}:${event.key}:${event.modifiers}`), ['rawKeyDown:Control:2', 'rawKeyDown:A:2', 'keyUp:A:2', 'keyUp:Control:0']);
  assert.equal(selectAll[1].text, undefined, 'a command key types no character');
  const shifted = keyEvents('Shift+a');
  assert.equal(shifted.find((event) => event.type === 'keyDown').text, 'A');
  assert.equal(keyEvents('Control++')[1].key, '+');
  assert.throws(() => keyEvents('Hyper+A'), /修饰键/);
  assert.throws(() => keyEvents('NotAKey'), /未知的按键/);
});

test('speed dial: seeds from bookmarks, keeps groups, drops unsafe entries and remembers icons', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mh-speed-dial-'));
  try {
    const file = path.join(dir, 'browser-speed-dial.json');
    const store = createSpeedDialStore(file, { seed: () => [{ title: 'Mail', url: 'https://mail.example/', icon: 'data:image/png;base64,AA==' }] });
    assert.equal(store.list()[0].title, 'Mail');
    assert.equal(fs.existsSync(file), false, 'nothing is written before the first change');
    const saved = store.save([
      { id: 'g1', type: 'group', title: 'Work', items: [{ title: 'Docs', url: 'https://docs.example' }, { title: 'Bad', url: 'javascript:alert(1)' }] },
      { type: 'site', title: '', url: 'https://news.example/' },
      { type: 'site', title: 'Creds', url: 'https://user:pw@example.com/' },
      { type: 'group', title: 'Empty', items: [] },
    ]);
    assert.equal(saved.length, 2);
    assert.equal(saved[0].items.length, 1);
    assert.equal(saved[1].title, '', 'a shortcut saved without a name stays icon-only');
    assert.deepEqual(store.missingIcons().map((site) => site.url), ['https://docs.example/', 'https://news.example/']);
    assert.equal(store.setIcon(saved[1].id, null), true);
    assert.equal(store.setIcon(saved[0].items[0].id, 'data:image/png;base64,AA=='), true);
    assert.deepEqual(store.missingIcons(), []);
    const reread = createSpeedDialStore(file).list();
    assert.equal(reread[0].items[0].icon, 'data:image/png;base64,AA==');
    assert.equal(reread[1].noIcon, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a background tab has a real viewport and is captured through the page compositor', async () => {
  const { browser, cdp, cleanup } = loadHost();
  try {
    const shown = await browser.command({ action: 'open', url: 'https://a.example/', rect: { x: 10, y: 10, width: 900, height: 700 } });
    const hidden = await browser.command({ action: 'ensure', tabId: 'bg', url: 'https://b.example/' });
    const view = browser.tabs.find((tab) => tab.id === 'bg').view;
    assert.equal(view.getVisible(), false);
    assert.deepEqual(view.bounds, { x: 0, y: 0, width: 1280, height: 800 }, 'a hidden tab is never laid out smaller than the Agent desktop size');
    const shot = await browser.command({ action: 'snapshot', tabId: hidden.tabId });
    assert.equal(Buffer.from(shot.snapshot.split(',')[1], 'base64').toString(), 'cdp-png');
    assert.equal(shot.width, 800);
    assert.ok(cdp.some((entry) => entry.method === 'Page.captureScreenshot'));
    assert.notEqual(shown.tabId, hidden.tabId);
  } finally {
    cleanup();
  }
});

test('the mouse sends trusted events at a point, draws the agent pointer and refuses points outside the page', async () => {
  const { browser, cdp, cleanup } = loadHost();
  try {
    await browser.command({ action: 'ensure', tabId: 't1', url: 'https://a.example/' });
    const clicked = await browser.command({ action: 'mouse', tabId: 't1', kind: 'click', x: 30, y: 40 });
    assert.deepEqual(clicked.target, { tag: 'img', src: '/logo.png' });
    const types = cdp.filter((entry) => entry.method === 'Input.dispatchMouseEvent').map((entry) => entry.params.type);
    assert.deepEqual(types, ['mouseMoved', 'mousePressed', 'mouseReleased']);
    assert.equal(cdp.find((entry) => entry.params?.type === 'mousePressed').params.x, 30);
    const contents = browser.tabs[0].view.webContents;
    assert.ok(contents.isolated.some((entry) => entry.code.includes('translate(30px, 40px)')), 'the pointer is drawn where it clicked');
    cdp.length = 0;
    await browser.command({ action: 'mouse', tabId: 't1', kind: 'drag', x: 10, y: 10, toX: 200, toY: 10 });
    const drag = cdp.filter((entry) => entry.method === 'Input.dispatchMouseEvent');
    assert.equal(drag.at(-1).params.type, 'mouseReleased');
    assert.equal(drag.at(-1).params.x, 200);
    assert.ok(drag.filter((entry) => entry.params.type === 'mouseMoved').length >= 4);
    await assert.rejects(browser.command({ action: 'mouse', tabId: 't1', kind: 'click', x: 900, y: 10 }), /可视区域 800×600 之外/);
    cdp.length = 0;
    const pressed = await browser.command({ action: 'keys', tabId: 't1', keys: 'Control+A Backspace' });
    assert.equal(pressed.focused.tag, 'input');
    assert.equal(cdp.filter((entry) => entry.method === 'Input.dispatchKeyEvent').length, 6);
    await browser.command({ action: 'insertText', tabId: 't1', text: '你好' });
    assert.deepEqual(cdp.at(-1), { id: contents.id, method: 'Input.insertText', params: { text: '你好' } });
  } finally {
    cleanup();
  }
});

test('the Agent writes a bookmark note only where the user did not', async () => {
  const { browser, cleanup } = loadHost();
  try {
    const { bookmarks } = await browser.command({ action: 'bookmark-add', url: 'https://school.example/', title: 'School', note: 'Course site', noteAuto: true, noteBy: 'm/x' });
    const mine = (await browser.command({ action: 'bookmark-add', url: 'https://mine.example/', title: 'Mine', note: 'my own words' })).bookmarks[1];
    const written = await browser.command({ action: 'bookmark-note', id: bookmarks[0].id, note: 'DSA assignments', by: 'pretend' }, { agent: true });
    assert.deepEqual([written.bookmarks[0].note, written.bookmarks[0].noteBy], ['DSA assignments', 'agent']);
    await assert.rejects(browser.command({ action: 'bookmark-note', id: mine.id, note: 'something else' }, { agent: true }), /用户自己写的/);
    assert.equal((await browser.command({ action: 'bookmarks' })).bookmarks[1].note, 'my own words');
  } finally {
    cleanup();
  }
});

test('site permissions: a bookmarked site is allowed at once, others wait and the Agent can answer them', async () => {
  const { browser, events, permission, cleanup } = loadHost();
  try {
    await browser.command({ action: 'bookmark-add', url: 'https://trusted.example/home', title: 'Trusted' });
    await browser.command({ action: 'ensure', tabId: 'trusted', url: 'https://trusted.example/home' });
    await browser.command({ action: 'ensure', tabId: 'other', url: 'https://other.example/' });
    const contentsOf = (id) => browser.tabs.find((tab) => tab.id === id).view.webContents;
    const answers = [];
    permission.request(contentsOf('trusted'), 'media', (allowed) => answers.push(['trusted', allowed]), { requestingUrl: 'https://trusted.example/home' });
    assert.deepEqual(answers, [['trusted', true]]);
    assert.equal(events.some((event) => event.type === 'permission' && event.by === 'bookmark' && event.allowed === true), true);
    assert.equal(permission.check(contentsOf('trusted'), 'notifications', 'https://trusted.example'), true);
    assert.equal(permission.check(contentsOf('other'), 'notifications', 'https://other.example'), false);
    permission.request(contentsOf('other'), 'geolocation', (allowed) => answers.push(['other', allowed]), { requestingUrl: 'https://other.example/' });
    assert.equal(answers.length, 1, 'an unknown site waits for a decision');
    const state = await browser.command({ action: 'state', tabId: 'other' });
    assert.equal(state.pendingPermissions.length, 1);
    const settled = await browser.command({ action: 'permission', requestId: state.pendingPermissions[0].requestId, allow: true, by: 'agent' });
    assert.equal(settled.allowed, true);
    assert.deepEqual(answers.at(-1), ['other', true]);
    assert.equal(events.some((event) => event.type === 'permission' && event.by === 'agent'), true);
    assert.equal((await browser.command({ action: 'bookmarked', url: 'https://trusted.example/x' })).bookmarked, true);
  } finally {
    cleanup();
  }
});

test('signing in with a saved login is only offered on bookmarked sites', async () => {
  const { browser, cleanup } = loadHost();
  try {
    await browser.command({ action: 'ensure', tabId: 'x', url: 'https://unknown.example/login' });
    await assert.rejects(browser.command({ action: 'login', tabId: 'x' }), /不在书签里/);
    await browser.command({ action: 'bookmark-add', url: 'https://unknown.example/', title: 'Now trusted' });
    // This stand-in host has no OS encryption, so there is no saved login to use.
    await assert.rejects(browser.command({ action: 'login', tabId: 'x' }), /没有可用的已保存密码/);
  } finally {
    cleanup();
  }
});

test('speed dial commands save the layout and tell every page', async () => {
  const { browser, events, cleanup } = loadHost();
  try {
    const listed = await browser.command({ action: 'speeddial' });
    assert.deepEqual(listed.items, []);
    const saved = await browser.command({ action: 'speeddial-save', items: [{ type: 'site', title: 'A', url: 'https://a.example/' }] });
    assert.equal(saved.items.length, 1);
    assert.equal(events.some((event) => event.type === 'speeddial' && event.items.length === 1), true);
  } finally {
    cleanup();
  }
});

test('the visible tab in a narrow panel gets the desktop size while the Agent drives it, the panel shows the part that fits, and its clicks are page pixels', async () => {
  const { browser, cdp, cleanup } = loadHost();
  try {
    const rect = { x: 700, y: 10, width: 426, height: 780 };
    const opened = await browser.command({ action: 'open', url: 'https://a.example/', rect });
    const tab = browser.tabs.find((entry) => entry.id === opened.tabId);
    const metrics = () => cdp.filter((entry) => entry.method.startsWith('Emulation.'));
    await browser.command({ action: 'snapshot', tabId: tab.id }, { agent: true });
    assert.equal(metrics().length, 0, 'no device metrics override: the page is never a scaled-down picture');
    assert.deepEqual(tab.view.parent.bounds, rect, 'what shows is still the panel');
    assert.deepEqual(tab.view.bounds, { x: 0, y: 0, width: 1280, height: 800 }, 'the page is laid out at the desktop size from the panel corner');
    cdp.length = 0;
    await browser.command({ action: 'mouse', tabId: tab.id, kind: 'click', x: 200, y: 300 }, { agent: true });
    const pressed = cdp.find((entry) => entry.params?.type === 'mousePressed').params;
    assert.deepEqual([pressed.x, pressed.y], [200, 300]);
    assert.equal(tab.view.webContents.debugger.isAttached(), false, 'the debugger is released after the click');
  } finally {
    cleanup();
  }
});

test('a click that starts a download waits for the file and reports where it was saved', async () => {
  const { browser, desktopSession, cleanup } = loadHost();
  try {
    await browser.command({ action: 'ensure', tabId: 't1', url: 'https://a.example/' });
    const tab = browser.tabs.find((entry) => entry.id === 't1');
    tab.view.webContents.executeJavaScript = async (code) => {
      if (code.includes('innerWidth')) return { width: 800, height: 600 };
      if (code.includes('elementFromPoint')) return { tag: 'div', role: 'button', text: '下载“report.docx”' };
      return null;
    };
    const listeners = {};
    const item = {
      getFilename: () => 'report.docx', getURL: () => 'https://a.example/report.docx', getTotalBytes: () => 10, getReceivedBytes: () => 10,
      setSavePath(value) { this.path = value; }, getSavePath() { return this.path; }, cancel() {},
      on(name, handler) { listeners[name] = handler; }, once(name, handler) { listeners[name] = handler; },
    };
    // The page starts the download a moment after the click and it finishes shortly after.
    setTimeout(() => {
      desktopSession['will-download']({}, item, tab.view.webContents);
      setTimeout(() => listeners.done({}, 'completed'), 300);
    }, 500);
    const clicked = await browser.command({ action: 'mouse', tabId: 't1', kind: 'click', x: 30, y: 40 }, { agent: true });
    assert.equal(clicked.downloads.length, 1);
    assert.equal(clicked.downloads[0].state, 'completed');
    assert.equal(path.basename(clicked.downloads[0].savePath), clicked.downloads[0].name);
    assert.match(clicked.downloads[0].name, /^report.*\.docx$/);

    // An ordinary click does not wait long for a download that never comes.
    tab.view.webContents.executeJavaScript = async (code) => (code.includes('innerWidth') ? { width: 800, height: 600 } : code.includes('elementFromPoint') ? { tag: 'div', text: 'Inbox' } : null);
    const started = Date.now();
    const plain = await browser.command({ action: 'mouse', tabId: 't1', kind: 'click', x: 30, y: 40 }, { agent: true });
    assert.equal(plain.downloads, undefined);
    assert.ok(Date.now() - started < 1500);
    assert.equal((await browser.command({ action: 'downloads' })).folder, os.tmpdir());
  } finally {
    cleanup();
  }
});
