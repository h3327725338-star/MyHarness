const { WebContentsView, session, Menu, shell, app, ipcMain, safeStorage } = require('electron');
// Absolute paths: the tests compile this file outside the normal module loader, where a relative require would not
// resolve against this folder.
const { createBookmarkStore } = require(require('node:path').join(__dirname, 'browser-bookmarks.cjs'));
const { createPasswordStore, attachPasswordManager } = require(require('node:path').join(__dirname, 'browser-passwords.cjs'));

exports.httpUrl = (value) => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('只允许 http 或 https 网页地址');
  return url.href;
};

/**
 * The user agent of a current desktop Chrome on this platform, built from Electron's own. Electron adds `Electron/x` and
 * the app's `<name>/<version>` tokens, and sites such as WhatsApp Web ("works with Google Chrome 100+") and Microsoft
 * Teams (blank page: it serves its Electron desktop client) sniff those tokens. Chrome itself reports only the major
 * version (`Chrome/152.0.0.0`), so the result matches what Chrome sends; the engine version stays the real one.
 */
exports.chromeUserAgent = (fallback, chromeVersion) => {
  const major = String(chromeVersion || '').split('.')[0];
  const platform = /\(([^)]*)\)/.exec(String(fallback || ''))?.[1] || 'Windows NT 10.0; Win64; x64';
  if (!/^\d+$/.test(major)) return String(fallback || '');
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
};

// One persistent partition for every tab: pages keep cookies, localStorage and logins across restarts and across the
// tabs that the workspace opens. Nothing here mirrors the system browser's profiles.
const PARTITION = 'persist:myharness-third-party';
const MAX_TABS = 40;
const DEFAULT_TAB = 'main';
// Agent-driven file uploads may only pick files inside the current workspace and only up to this size. The page's own
// file picker is the normal path; this limit is for the programmatic `upload` command and never exposes other files.
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
// A bookmark keeps its site icon inline; a bigger icon falls back to the bookmark's first letter.
const MAX_ICON_BYTES = 64 * 1024;

/** Whether `candidate` is the same as, or inside, `root` (Windows paths are case-insensitive). */
const insideRoot = (root, candidate) => {
  const path = require('node:path');
  const normal = (value) => path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
  const base = normal(root);
  const target = normal(candidate);
  return target === base || target.startsWith(`${base}${path.sep}`);
};

/** A rectangle from the page is usable only when every number is finite and it has a positive size. */
const cleanRect = (value) => {
  if (!value || typeof value !== 'object') return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const width = Number(value.width);
  const height = Number(value.height);
  if (![x, y, width, height].every(Number.isFinite) || width < 1 || height < 1) return null;
  return { x, y, width, height };
};

/**
 * A multi-tab browser made of one WebContentsView per tab. Each tab has its own history, title, loading state and
 * error; only the active tab is visible, and its rectangle is driven by the page (the view is drawn above the page and
 * cannot take part in its layout). The page can drive every tab through the `browser` command bridge; sites keep the
 * same persistent session. A site permission request waits for an explicit user decision in the workspace and is denied
 * by default; the Agent cannot grant it.
 *
 * Visibility is an invariant of this module, not of the caller: a view is visible only while it is the active tab and
 * a non-empty rectangle is known. `activate` without a rectangle hides the tab until the page sends fresh bounds, and a
 * closed tab can never leave a rectangle or a visible view behind. The page calls `hide` before it shows a non-browser
 * tab, so a native view cannot survive the switch for even one frame.
 */
exports.createBrowser = (window, log, options = {}) => {
  const workspaceRoot = options.workspaceRoot ? require('node:path').resolve(options.workspaceRoot) : undefined;
  const tabs = new Map();
  let activeTabId = null;
  let rectangle = null;
  // What the pages did while the workspace watched: recent downloads and request metadata. Both stay small and are
  // only read by the workspace command surface (never persisted), so a page cannot grow them without bound.
  const downloadLog = [];
  const networkLog = [];
  let downloadSeq = 0;
  let permissionSeq = 0;
  // Session-scoped site permission decisions. Nothing is granted by default and nothing is written to disk: the first
  // request for an origin/permission is shown to the user in the workspace, an explicit decision is remembered for this
  // app session only, and a request nobody answers is denied after the timeout. The Agent cannot make this decision.
  const permissionDecisions = new Map();
  const pendingPermissions = new Map();
  const PERMISSION_TIMEOUT_MS = 60000;
  const permissionKey = (origin, permission) => `${origin || ''}\0${permission || ''}`;
  const permissionFor = (origin, permission) => permissionDecisions.get(permissionKey(origin, permission));
  const send = (value) => {
    if (!window.isDestroyed()) window.webContents.send('desktop:status', value);
  };
  const emit = (tabId, value) => send({ tabId, ...value });
  const partition = session.fromPartition(PARTITION);
  // Bookmarks and saved logins belong to this desktop profile (`options.profileDir`, the host's user-data folder),
  // never to the Data root: they are not synced and not part of any workspace. A host without a profile has neither.
  const profileDir = options.profileDir ? require('node:path').resolve(options.profileDir) : undefined;
  const bookmarks = profileDir ? createBookmarkStore(require('node:path').join(profileDir, 'browser-bookmarks.json')) : undefined;
  const passwords = profileDir && safeStorage
    ? createPasswordStore({
      file: require('node:path').join(profileDir, 'browser-logins.bin.json'),
      crypto: {
        available: () => safeStorage.isEncryptionAvailable(),
        encrypt: (text) => safeStorage.encryptString(text),
        decrypt: (buffer) => safeStorage.decryptString(buffer),
      },
    })
    : undefined;
  const requireBookmarks = () => { if (!bookmarks) throw new Error('当前桌面宿主不支持书签'); return bookmarks; };
  const requirePasswords = () => { if (!passwords) throw new Error('当前桌面宿主不支持保存密码'); return passwords; };
  const bookmarksChanged = (list) => { send({ type: 'bookmarks', bookmarks: list }); return list; };
  // Every tab (and every popup, which becomes a tab) shares the partition, so its user agent is set once here.
  if (typeof partition.setUserAgent === 'function') partition.setUserAgent(exports.chromeUserAgent(app.userAgentFallback, process.versions.chrome));
  const settlePermission = (requestId, allow, options = {}) => {
    const entry = pendingPermissions.get(requestId);
    if (!entry) throw new Error(`没有待处理的网站权限请求 ${requestId}`);
    pendingPermissions.delete(requestId);
    clearTimeout(entry.timer);
    if (options.remember !== false) permissionDecisions.set(permissionKey(entry.origin, entry.permission), allow === true);
    emit(entry.tabId, { type: 'permission', requestId, permission: entry.permission, origin: entry.origin, allowed: allow === true, remembered: options.remember !== false });
    log(`网站权限请求${allow ? '已允许' : '已拒绝'}：${entry.permission} ${entry.origin}`);
    try { entry.callback(allow === true); } catch { /* the page went away */ }
    return { ok: true, requestId, allowed: allow === true, origin: entry.origin, permission: entry.permission };
  };
  const denyPendingForTab = (tabId) => {
    for (const [requestId, entry] of [...pendingPermissions]) {
      if (entry.tabId !== tabId) continue;
      pendingPermissions.delete(requestId);
      clearTimeout(entry.timer);
      emit(entry.tabId, { type: 'permission', requestId, permission: entry.permission, origin: entry.origin, allowed: false, remembered: false });
      try { entry.callback(false); } catch { /* page is closing */ }
    }
  };
  // A page that wants the camera, microphone, clipboard, notifications or location is reported to the workspace; until
  // the user answers the request it stays pending, and the default (timeout, closed tab, switching away) is denial.
  partition.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const tab = tabFor(webContents);
    const origin = safeOrigin(details?.requestingUrl || (tab ? tab.url : ''));
    if (!tab) { callback(false); return; }
    const known = permissionFor(origin, permission);
    if (known !== undefined) {
      emit(tab ? tab.id : undefined, { type: 'permission', permission, origin, allowed: known === true, remembered: true });
      log(`网站权限请求沿用本会话决定：${permission} ${origin} → ${known ? '允许' : '拒绝'}`);
      callback(known === true);
      return;
    }
    const requestId = `p${++permissionSeq}`;
    const timer = setTimeout(() => {
      if (!pendingPermissions.has(requestId)) return;
      try { settlePermission(requestId, false, { remember: false }); } catch { /* already settled */ }
    }, PERMISSION_TIMEOUT_MS);
    pendingPermissions.set(requestId, { callback, timer, tabId: tab ? tab.id : undefined, origin, permission });
    emit(tab ? tab.id : undefined, { type: 'permission-request', requestId, permission, origin, mediaTypes: details?.mediaTypes || undefined });
    log(`网站权限请求等待用户决定：${permission} ${origin}`);
  });
  // Checks must agree with the remembered decisions; an undecided request fails its check first and asks afterwards.
  partition.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const origin = safeOrigin(requestingOrigin || details?.requestingUrl || (webContents && !webContents.isDestroyed() ? webContents.getURL() : ''));
    return permissionFor(origin, permission) === true;
  });
  partition.on('will-download', (event, item, webContents) => {
    const tab = webContents ? tabFor(webContents) : undefined;
    if (!tab || tab.destroyed) { try { item.cancel(); } catch { /* already gone */ } return; }
    const downloads = app.getPath('downloads');
    const name = uniqueDownloadName(downloads, item.getFilename());
    item.setSavePath(require('node:path').join(downloads, name));
    const record = { id: `download${++downloadSeq}`, name, savePath: item.getSavePath(), url: item.getURL(), tabId: tab.id, total: item.getTotalBytes(), received: 0, state: 'started', at: Date.now() };
    tab.downloads.set(record.id, { item, record });
    emit(tab.id, { type: 'download', state: 'started', ...record });
    item.on('updated', (_event, state) => {
      if (!tabs.has(tab.id)) return;
      record.received = item.getReceivedBytes();
      record.total = item.getTotalBytes();
      if (state === 'progressing') emit(tab.id, { type: 'download', state: 'progressing', ...record });
    });
    item.once('done', (_event, state) => {
      tab.downloads.delete(record.id);
      record.state = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'failed';
      record.reason = state;
      record.received = item.getReceivedBytes();
      record.total = item.getTotalBytes();
      record.at = Date.now();
      if (tab.destroyed) return;
      downloadLog.push(record);
      if (downloadLog.length > 50) downloadLog.shift();
      if (tabs.has(tab.id)) emit(tab.id, { type: 'download', ...record });
    });
  });
  // Request metadata only: method, URL, status and type. Response bodies and headers are neither collected nor stored.
  partition.webRequest.onCompleted((details) => {
    const tab = tabByContents(details.webContentsId);
    networkLog.push({ tabId: tab ? tab.id : undefined, method: details.method, url: String(details.url).slice(0, 500), status: details.statusCode, type: details.resourceType, at: Date.now() });
    if (networkLog.length > 200) networkLog.shift();
  });
  partition.webRequest.onErrorOccurred((details) => {
    const tab = tabByContents(details.webContentsId);
    networkLog.push({ tabId: tab ? tab.id : undefined, method: details.method, url: String(details.url).slice(0, 500), status: 0, error: details.error, type: details.resourceType, at: Date.now() });
    if (networkLog.length > 200) networkLog.shift();
  });

  const safeOrigin = (value) => {
    try { return new URL(value).origin; } catch { return ''; }
  };

  const tabFor = (webContents) => {
    for (const tab of tabs.values()) if (tab.view && !tab.view.webContents.isDestroyed() && tab.view.webContents === webContents) return tab;
    return undefined;
  };
  const passwordManager = passwords && ipcMain
    ? attachPasswordManager({ ipcMain, store: passwords, tabFor: (contents) => tabFor(contents), emit, log })
    : undefined;

  /** The current site icon of a tab as a small data URL, or undefined (the bar then shows the first letter). */
  const fetchIcon = async (tab) => {
    if (!tab || typeof partition.fetch !== 'function') return undefined;
    // Chromium reports the icon only for a page it has painted; otherwise the page's own <link rel=icon> or the
    // site's /favicon.ico is used.
    let source = tab.favicon;
    if (!source) {
      try {
        source = await contentsOf(tab).executeJavaScript(`(() => { const link = document.querySelector('link[rel~="icon" i]'); return link ? link.href : new URL('/favicon.ico', location.href).href; })()`, true);
      } catch {
        return undefined;
      }
    }
    try {
      const url = new URL(source);
      if (!['http:', 'https:', 'data:'].includes(url.protocol)) return undefined;
      if (url.protocol === 'data:') return source.length <= MAX_ICON_BYTES * 2 ? source : undefined;
      const response = await partition.fetch(url.href, { signal: AbortSignal.timeout(4000) });
      const type = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!response.ok || !type.startsWith('image/')) return undefined;
      const body = Buffer.from(await response.arrayBuffer());
      if (!body.length || body.length > MAX_ICON_BYTES) return undefined;
      return `data:${type === 'image/x-icon' ? 'image/x-icon' : type};base64,${body.toString('base64')}`;
    } catch {
      return undefined;
    }
  };

  const tabByContents = (webContentsId) => {
    for (const tab of tabs.values()) if (tab.view && !tab.view.webContents.isDestroyed() && tab.view.webContents.id === webContentsId) return tab;
    return undefined;
  };

  const uniqueDownloadName = (directory, rawName) => {
    const path = require('node:path');
    const fs = require('node:fs');
    const base = String(rawName || 'download').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 120) || 'download';
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const extension = dot > 0 ? base.slice(dot) : '';
    let candidate = base;
    for (let index = 1; index < 1000 && fs.existsSync(path.join(directory, candidate)); index++) candidate = `${stem} (${index})${extension}`;
    return candidate;
  };

  const stateOf = (tab) => {
    const contents = tab.view && !tab.view.webContents.isDestroyed() ? tab.view.webContents : undefined;
    const history = contents ? contents.navigationHistory : undefined;
    return {
      tabId: tab.id,
      url: tab.url,
      title: tab.title,
      loading: tab.loading,
      error: tab.error || '',
      canGoBack: !!history?.canGoBack?.(),
      canGoForward: !!history?.canGoForward?.(),
      visible: tab.view?.getVisible?.() ?? false,
      // The rectangle the native view actually occupies (null while hidden); lets the page and the Agent verify placement.
      bounds: tab.view?.getVisible?.() ? (() => { try { return tab.view.getBounds(); } catch { return null; } })() : null,
      active: tab.id === activeTabId,
    };
  };

  /** Screenshot state pushed to the page: only for a tab that is on screen and has finished loading. */
  const picture = async (tab) => {
    if (!tab || tab.destroyed || !tab.view || tab.view.webContents.isDestroyed() || tab.view.webContents.isLoading()) return;
    if (!tab.view.getVisible()) return;
    if (!tabs.has(tab.id) || tab.id !== activeTabId) return;
    try {
      const image = await tab.view.webContents.capturePage();
      if (!image.isEmpty() && tabs.get(tab.id) === tab) emit(tab.id, { type: 'snapshot', snapshot: `data:image/jpeg;base64,${image.toJPEG(85).toString('base64')}` });
    } catch (error) {
      log(`网页截图失败：${error.message}`);
    }
  };

  /** The interval that refreshes the fallback picture exists only while the view is actually the visible active tab. */
  const updatePictureTimer = (tab) => {
    const visible = !!tab.view && !tab.view.webContents.isDestroyed() && tab.view.getVisible();
    if (visible && !tab.pictures) {
      tab.pictures = setInterval(() => void picture(tab), 1000);
      void picture(tab);
    } else if (!visible && tab.pictures) {
      clearInterval(tab.pictures);
      tab.pictures = undefined;
    }
  };

  /** Clamp the page's rectangle to the current content area; a zero-sized window hides the view instead of drawing it. */
  const boundsForRectangle = () => {
    if (!rectangle) return null;
    const [width, height] = window.getContentSize();
    if (width < 1 || height < 1) return null;
    const x = Math.max(0, Math.min(width - 1, Math.round(rectangle.x)));
    const y = Math.max(0, Math.min(height - 1, Math.round(rectangle.y)));
    const w = Math.max(0, Math.min(width - x, Math.round(rectangle.width)));
    const h = Math.max(0, Math.min(height - y, Math.round(rectangle.height)));
    if (w < 1 || h < 1) return null;
    return { x, y, width: w, height: h };
  };

  /**
   * Apply the one visibility invariant: the active tab's view is visible exactly while a usable rectangle exists.
   * Every other view is hidden. Bounds are set before the view is shown so it never appears at the previous box.
   */
  const placeActive = () => {
    const bounds = boundsForRectangle();
    for (const tab of tabs.values()) {
      if (!tab.view || tab.destroyed) continue;
      const visible = tab.id === activeTabId && !!bounds;
      try { tab.view.setVisible(visible); } catch { /* view is going away */ }
      if (visible) { try { tab.view.setBounds(bounds); } catch { /* view is going away */ } }
      updatePictureTimer(tab);
    }
  };

  /** Hide every view and forget the rectangle: the next activation always starts from a fresh measurement. */
  const hideAll = () => {
    rectangle = null;
    for (const tab of tabs.values()) {
      if (!tab.view || tab.destroyed) continue;
      try { tab.view.setVisible(false); } catch { /* view is going away */ }
      updatePictureTimer(tab);
    }
  };

  const commit = (tab, patch) => {
    if (tab.destroyed || tabs.get(tab.id) !== tab) return;
    Object.assign(tab, patch);
    emit(tab.id, { type: 'state', state: stateOf(tab) });
  };

  /** A timer that is cleared when the tab is closed, so a slow load cannot touch a dead view. */
  const later = (tab, fn, ms) => {
    const timer = setTimeout(() => {
      tab.timers.delete(timer);
      if (!tab.destroyed && tabs.get(tab.id) === tab) fn();
    }, ms);
    tab.timers.add(timer);
    return timer;
  };

  const wire = (tab) => {
    const contents = tab.view.webContents;
    const live = () => !tab.destroyed && tabs.get(tab.id) === tab;
    contents.on('will-navigate', (event, target) => {
      try { exports.httpUrl(target); } catch { event.preventDefault(); }
    });
    contents.setWindowOpenHandler(({ url }) => {
      try {
        const target = exports.httpUrl(url);
        // A page-requested window becomes a workspace tab; the page is told and can also open it itself.
        const created = createTab(target);
        emit(tab.id, { type: 'newTab', newTabId: created.id, url: target });
      } catch { /* Non-web schemes are dropped. */ }
      return { action: 'deny' };
    });
    contents.on('context-menu', (_event, params) => Menu.buildFromTemplate([
      { role: 'undo', enabled: params.isEditable }, { role: 'redo', enabled: params.isEditable },
      { type: 'separator' }, { role: 'cut', enabled: params.isEditable }, { role: 'copy' },
      { role: 'paste', enabled: params.isEditable }, { role: 'selectAll' },
      { type: 'separator' }, { label: '用系统浏览器打开', click: () => void shell.openExternal(tab.url) },
    ]).popup({ window }));
    contents.on('did-start-loading', () => {
      if (!live()) return;
      tab.error = '';
      commit(tab, { loading: true });
      clearTimeout(tab.timer);
      tab.timer = later(tab, () => fail(tab, '加载超时（45 秒）', tab.url), 45000);
    });
    contents.on('did-stop-loading', () => {
      if (!live()) return;
      clearTimeout(tab.timer);
      commit(tab, { loading: false });
      later(tab, () => void picture(tab), 300);
    });
    contents.on('did-navigate', (_event, target) => {
      if (!live()) return;
      passwordManager?.navigated(tab);
      tab.favicon = undefined;
      commit(tab, { url: target, error: '' });
    });
    contents.on('page-favicon-updated', (_event, favicons) => { if (live()) tab.favicon = Array.isArray(favicons) ? favicons[0] : undefined; });
    contents.on('did-navigate-in-page', (_event, target) => { if (live()) commit(tab, { url: target }); });
    contents.on('page-title-updated', (_event, title) => { if (live()) commit(tab, { title }); });
    contents.on('did-fail-load', (_event, code, description, target, isMainFrame) => {
      // -3 is a client-side abort (a navigation replaced by another one), not a page error.
      if (isMainFrame && code !== -3 && live()) fail(tab, `${description} (${code})`, target || tab.url);
    });
    contents.on('render-process-gone', (_event, detail) => { if (live()) fail(tab, `页面进程退出：${detail.reason}`, tab.url); });
    // The workspace owns the find bar, the new-tab button and the tab strip (the native view has none of its own).
    // Ctrl+F inside the page asks the page to open its find bar; Ctrl+T / Ctrl+W ask for a new tab or to close this one,
    // so those shortcuts do the same thing whether the keyboard is in the panel or in the page.
    contents.on('before-input-event', (event, input) => {
      const key = String(input.key || '').toLowerCase();
      if (input.type !== 'keyDown' || !input.control || input.alt) return;
      if (input.shift) {
        // Ctrl+Shift+B shows or hides the workspace's bookmarks bar, as in Chrome.
        if (key === 'b') {
          event.preventDefault();
          if (live()) emit(tab.id, { type: 'shortcut', shortcut: 'bookmarks-bar' });
        }
        return;
      }
      if (key === 'f') {
        event.preventDefault();
        if (live()) emit(tab.id, { type: 'find-open' });
      } else if (key === 't' || key === 'w') {
        event.preventDefault();
        if (live()) emit(tab.id, { type: 'shortcut', shortcut: key === 't' ? 'new-tab' : 'close-tab' });
      }
    });
    contents.on('found-in-page', (_event, result) => {
      const found = { requestId: result.requestId, activeMatch: result.activeMatchOrdinal || 0, matches: result.matches || 0, finalUpdate: !!result.finalUpdate };
      const pending = tab.findPending.get(result.requestId);
      if (pending) {
        pending.partial = found;
        if (found.finalUpdate) {
          clearTimeout(pending.timer);
          clearTimeout(pending.settleTimer);
          tab.findPending.delete(result.requestId);
          pending.resolve(found);
        } else if (!pending.settleTimer) {
          // Some pages send intermediate counts; give the final update a moment, then report the latest real count.
          pending.settleTimer = setTimeout(() => {
            if (!tab.findPending.has(result.requestId)) return;
            tab.findPending.delete(result.requestId);
            clearTimeout(pending.timer);
            pending.resolve(pending.partial);
          }, 250);
        }
      }
      if (live()) emit(tab.id, { type: 'find', ...found });
    });
  };

  const fail = (tab, message, url) => {
    if (tab.destroyed || tabs.get(tab.id) !== tab) return;
    log(message);
    commit(tab, { error: `网页加载失败：${message}`, url: url || tab.url, loading: false });
    emit(tab.id, { type: 'snapshot', snapshot: null });
  };

  const createTab = (initialUrl, forcedId) => {
    if (tabs.size >= MAX_TABS) throw new Error(`最多同时打开 ${MAX_TABS} 个浏览器标签`);
    const id = forcedId && !tabs.has(forcedId) ? String(forcedId) : `tab${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    // The sign-in helper runs in the page's isolated world and only when saved logins are available on this host.
    const preload = passwordManager ? require('node:path').join(__dirname, 'browser-tab-preload.cjs') : undefined;
    const view = new WebContentsView({ webPreferences: { session: partition, contextIsolation: true, nodeIntegration: false, sandbox: true, ...(preload ? { preload } : {}) } });
    const tab = { id, view, url: initialUrl || '', title: '', loading: false, error: '', timer: undefined, pictures: undefined, timers: new Set(), downloads: new Map(), findPending: new Map(), destroyed: false };
    tabs.set(id, tab);
    window.contentView.addChildView(view);
    view.setVisible(false);
    wire(tab);
    // A load failure is reported through the tab state; the initial navigation must not leave an unhandled rejection.
    if (initialUrl) void navigateTab(tab, initialUrl).catch(() => undefined);
    return tab;
  };

  /**
   * Close one tab: stop its timers and screenshot interval, cancel downloads that still belong to it, drop its request
   * and download references, close and detach the native view and forget the active/rectangle state when it was the
   * active tab. The page is told once, after everything is gone.
   */
  const destroyTab = (tab) => {
    if (!tab || tab.destroyed) return;
    tab.destroyed = true;
    clearTimeout(tab.timer);
    for (const timer of tab.timers) clearTimeout(timer);
    tab.timers.clear();
    clearInterval(tab.pictures);
    tab.pictures = undefined;
    for (const entry of tab.downloads.values()) {
      try { entry.item.cancel(); } catch { /* already finished */ }
    }
    tab.downloads.clear();
    denyPendingForTab(tab.id);
    for (const entry of tab.findPending.values()) {
      clearTimeout(entry.timer);
      if (entry.settleTimer) clearTimeout(entry.settleTimer);
      entry.resolve({ activeMatch: 0, matches: 0, closed: true });
    }
    tab.findPending.clear();
    tabs.delete(tab.id);
    passwordManager?.forget(tab);
    if (activeTabId === tab.id) { activeTabId = null; rectangle = null; }
    for (let index = networkLog.length - 1; index >= 0; index--) if (networkLog[index].tabId === tab.id) networkLog.splice(index, 1);
    for (let index = downloadLog.length - 1; index >= 0; index--) if (downloadLog[index].tabId === tab.id && downloadLog[index].state !== 'completed') downloadLog.splice(index, 1);
    try {
      if (tab.view && !tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
    } catch (error) { log(`关闭网页失败：${error.message}`); }
    try { window.contentView.removeChildView(tab.view); } catch { /* already detached */ }
    emit(tab.id, { type: 'closed', tabId: tab.id });
    placeActive();
  };

  const navigateTab = async (tab, value) => {
    const url = exports.httpUrl(value);
    if (tab.destroyed) throw new Error(`浏览器标签 ${tab.id} 已关闭`);
    commit(tab, { url, error: '', loading: true });
    try {
      await tab.view.webContents.loadURL(url);
      if (!tab.destroyed && tabs.get(tab.id) === tab) commit(tab, { url: tab.view.webContents.getURL() || url, loading: false });
    } catch (error) {
      if (!tab.destroyed && tabs.get(tab.id) === tab) fail(tab, error.message, url);
      throw error;
    }
    return stateOf(tab);
  };

  const requireTab = (tabId) => {
    const tab = tabs.get(tabId || activeTabId || DEFAULT_TAB);
    if (!tab) throw new Error(tabId ? `没有浏览器标签 ${tabId}` : '没有打开的浏览器标签');
    return tab;
  };

  const contentsOf = (tab) => {
    if (tab.destroyed || !tab.view || tab.view.webContents.isDestroyed()) throw new Error(`浏览器标签 ${tab.id} 已不可用`);
    return tab.view.webContents;
  };

  /** Screenshot of the active (visible) tab; other tabs report that they must be activated first. */
  const snapshot = async (tab) => {
    if (tab.destroyed || activeTabId !== tab.id || !tab.view.getVisible()) throw new Error('只能对当前活动的浏览器标签截图；先激活该标签');
    const image = await contentsOf(tab).capturePage();
    return `data:image/png;base64,${image.toPNG().toString('base64')}`;
  };

  const accessibilityTree = async (tab) => {
    const contents = contentsOf(tab);
    const debuggerApi = contents.debugger;
    let attached = false;
    try {
      if (!debuggerApi.isAttached()) { debuggerApi.attach('1.3'); attached = true; }
    } catch (error) { throw new Error(`无法附加可访问性调试器：${error.message}`); }
    try {
      await debuggerApi.sendCommand('Accessibility.enable');
      const result = await debuggerApi.sendCommand('Accessibility.getFullAXTree');
      const nodes = Array.isArray(result?.nodes) ? result.nodes : [];
      const pick = (node) => {
        const properties = Object.fromEntries((node.properties || []).map((property) => [property.name, property.value?.value]));
        return {
          id: node.nodeId,
          role: node.role?.value,
          name: typeof node.name?.value === 'string' ? node.name.value.slice(0, 200) : '',
          description: typeof node.description?.value === 'string' ? node.description.value.slice(0, 200) : '',
          value: node.value?.value === undefined ? undefined : String(node.value.value).slice(0, 200),
          ignored: node.ignored === true,
          properties,
          children: (node.childIds || []).slice(0, 80),
        };
      };
      return nodes.map(pick);
    } finally {
      if (attached) { try { debuggerApi.detach(); } catch { /* already gone */ } }
    }
  };

  const runInPage = async (tab, expression) => {
    const value = await contentsOf(tab).executeJavaScript(expression, true);
    return value === undefined ? null : value;
  };

  /** Run `fn` with the page's debugger attached; detach again when this call attached it (an AX read may already hold it). */
  const withDebugger = async (tab, fn) => {
    const contents = contentsOf(tab);
    const debuggerApi = contents.debugger;
    let attached = false;
    try {
      if (!debuggerApi.isAttached()) { debuggerApi.attach('1.3'); attached = true; }
    } catch (error) {
      throw new Error(`无法附加网页调试器：${error.message}`);
    }
    try {
      return await fn(debuggerApi);
    } finally {
      if (attached) { try { debuggerApi.detach(); } catch { /* already gone */ } }
    }
  };

  const FIND_TIMEOUT_MS = 4000;
  /**
   * Find text in the tab's page. The answer is the real `found-in-page` result (active match and total matches), not
   * an assumption that the search found something; an unanswered request is a timeout result, not a hang.
   */
  const findInTab = (tab, text, { forward = true, findNext = false, matchCase = false } = {}) => {
    const contents = contentsOf(tab);
    const query = String(text ?? '');
    if (!query) {
      contents.stopFindInPage('clearSelection');
      return Promise.resolve({ activeMatch: 0, matches: 0, stopped: true });
    }
    // Find only runs in a focused page (the native view can otherwise be unfocused while the workspace UI has the
    // keyboard); focusing it also matches what Ctrl+F does in a normal browser window.
    try { contents.focus(); } catch { /* view is going away */ }
    // Electron's `findNext` means "start a new text finding session"; the workspace command uses it the intuitive way
    // ("go to the next match"). A new search must start a session, a follow-up must not, or Chromium has nothing to
    // search and emits no result at all.
    const startSession = findNext !== true;
    const requestId = contents.findInPage(query, { forward: forward !== false, findNext: startSession, matchCase: matchCase === true });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const entry = tab.findPending.get(requestId);
        tab.findPending.delete(requestId);
        if (entry?.settleTimer) clearTimeout(entry.settleTimer);
        resolve(entry?.partial ?? { activeMatch: 0, matches: 0, timeout: true, requestId });
      }, FIND_TIMEOUT_MS);
      tab.findPending.set(requestId, { resolve, timer });
    });
  };

  const stopFind = (tab) => {
    contentsOf(tab).stopFindInPage('clearSelection');
    for (const [requestId, entry] of tab.findPending) {
      clearTimeout(entry.timer);
      if (entry.settleTimer) clearTimeout(entry.settleTimer);
      entry.resolve({ activeMatch: 0, matches: 0, closed: true, requestId });
    }
    tab.findPending.clear();
    return { ok: true };
  };

  /** A workspace file that the Agent may hand to a page's file input; anything outside the workspace is refused. */
  const workspaceUploadFile = (value) => {
    if (!workspaceRoot) throw new Error('当前桌面宿主没有工作区根目录，不能上传文件');
    if (typeof value !== 'string' || !value) throw new Error('upload 需要工作区内的文件路径');
    const path = require('node:path');
    const fs = require('node:fs');
    let root;
    try { root = fs.realpathSync(workspaceRoot); } catch (error) { throw new Error(`无法读取工作区目录：${error.message}`); }
    let file;
    try { file = fs.realpathSync(path.resolve(root, value)); } catch { throw new Error(`上传文件不存在：${value}`); }
    if (!insideRoot(root, file)) throw new Error('只能上传当前工作区内的文件');
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('只能上传普通文件，不能上传目录或设备');
    if (stat.size > MAX_UPLOAD_BYTES) throw new Error(`上传文件超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MiB 上限`);
    return { absolute: file, name: path.basename(file), size: stat.size, relative: path.relative(root, file).replace(/\\/g, '/') };
  };

  /**
   * Put one workspace file into a page's `<input type="file">` without opening the system picker. The element is found by
   * CSS selector or by the index from `interactive`; a missing or non-file element is an error, and the page receives the
   * same input/change events a person's choice would produce.
   */
  const uploadFile = async (tab, info, selector, index) => {
    return withDebugger(tab, async (debuggerApi) => {
      const expression = Number.isInteger(index)
        ? `document.querySelectorAll(${JSON.stringify(INTERACTIVE_QUERY)})[${index}]`
        : `document.querySelector(${JSON.stringify(selector)})`;
      const found = await debuggerApi.sendCommand('Runtime.evaluate', { expression, objectGroup: 'myharness-upload' });
      const objectId = found?.result?.objectId;
      if (!objectId) {
        throw new Error(Number.isInteger(index) ? `没有索引为 ${index} 的可交互元素` : `没有匹配 ${selector} 的元素`);
      }
      try {
        const described = await debuggerApi.sendCommand('Runtime.callFunctionOn', {
          objectId,
          returnByValue: true,
          functionDeclaration: 'function(){ return { tag: this.tagName, type: this.type || "", disabled: !!this.disabled, multiple: !!this.multiple }; }',
        });
        const element = described?.result?.value || {};
        if (element.tag !== 'INPUT' || element.type !== 'file') throw new Error('目标元素不是 <input type="file">');
        if (element.disabled) throw new Error('目标文件输入框已禁用');
        try { await debuggerApi.sendCommand('DOM.enable'); } catch { /* older Electron may not need it */ }
        await debuggerApi.sendCommand('DOM.setFileInputFiles', { files: [info.absolute], objectId });
        const after = await debuggerApi.sendCommand('Runtime.callFunctionOn', {
          objectId,
          returnByValue: true,
          functionDeclaration: 'function(){ this.dispatchEvent(new Event("input", { bubbles: true })); this.dispatchEvent(new Event("change", { bubbles: true })); return { count: this.files ? this.files.length : 0, name: this.files && this.files[0] ? this.files[0].name : "" }; }',
        });
        const files = after?.result?.value || {};
        if (!files.count) throw new Error('文件输入框没有接收到文件');
        return { ok: true, name: files.name || info.name, size: info.size, path: info.relative, count: files.count };
      } finally {
        try { await debuggerApi.sendCommand('Runtime.releaseObjectGroup', { objectGroup: 'myharness-upload' }); } catch { /* debugger may be gone */ }
      }
    });
  };

  /** Interactive elements in document order; `index` addresses the same list for click/type without a CSS selector. */
  const INTERACTIVE_QUERY = 'a,button,input,select,textarea,[role="button"],[role="link"],[contenteditable="true"]';

  const click = (tab, selector, index) => runInPage(tab, `(() => {
    const element = ${Number.isInteger(index) ? `document.querySelectorAll(${JSON.stringify(INTERACTIVE_QUERY)})[${index}]` : `document.querySelector(${JSON.stringify(selector)})`};
    if (!element) return { ok: false, error: ${Number.isInteger(index) ? `'no interactive element at index ' + ${index}` : `'no element matches ' + ${JSON.stringify(selector)}`} };
    element.scrollIntoView({ block: 'center' });
    element.click();
    return { ok: true, tag: element.tagName, text: (element.textContent || '').trim().slice(0, 200) };
  })()`);

  const typeText = (tab, selector, text, index) => runInPage(tab, `(() => {
    const element = ${Number.isInteger(index) ? `document.querySelectorAll(${JSON.stringify(INTERACTIVE_QUERY)})[${index}]` : `document.querySelector(${JSON.stringify(selector)})`};
    if (!element) return { ok: false, error: ${Number.isInteger(index) ? `'no interactive element at index ' + ${index}` : `'no element matches ' + ${JSON.stringify(selector)}`} };
    element.focus();
    if (element.isContentEditable) {
      element.textContent = ${JSON.stringify(text)};
    } else {
      const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, ${JSON.stringify(text)});
    }
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, tag: element.tagName, value: String(element.value ?? element.textContent ?? '').slice(0, 200) };
  })()`);

  const interactive = (tab) => runInPage(tab, `(() => {
    const nodes = Array.from(document.querySelectorAll(${JSON.stringify(INTERACTIVE_QUERY)}));
    return nodes.slice(0, 400).map((element, index) => {
      const rect = element.getBoundingClientRect();
      const label = (element.getAttribute('aria-label') || element.textContent || element.getAttribute('placeholder') || element.getAttribute('name') || '').trim().slice(0, 120);
      return {
        index,
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute('type') || '',
        role: element.getAttribute('role') || '',
        label,
        name: element.getAttribute('name') || '',
        id: element.id || '',
        href: element.getAttribute('href') || '',
        disabled: !!element.disabled,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      };
    });
  })()`);

  const command = async (input) => {
    const value = input && typeof input === 'object' ? input : {};
    const action = String(value.action || '');
    switch (action) {
      case 'open': {
        // The page owns the tab id (`browser:<url>`); the host view is created under that id so both sides agree, and a
        // later `ensure` from the panel finds the same tab instead of opening another one.
        const existing = value.tabId ? tabs.get(value.tabId) : undefined;
        const target = existing || createTab(value.url ? exports.httpUrl(value.url) : '', value.tabId);
        activeTabId = target.id;
        // A new tab starts hidden until the page reports where its box is; an old rectangle must not place it.
        rectangle = cleanRect(value.rect);
        placeActive();
        if (existing && value.url) {
          const next = exports.httpUrl(value.url);
          if (next !== existing.url) return navigateTab(target, next);
          return stateOf(target);
        }
        return stateOf(target);
      }
      case 'ensure': {
        const existing = value.tabId ? tabs.get(value.tabId) : undefined;
        if (existing) return stateOf(existing);
        if (typeof value.url !== 'string' || !value.url) throw new Error('ensure 需要 url 才能创建标签');
        const created = createTab(exports.httpUrl(value.url), value.tabId);
        return { ...stateOf(created), created: true };
      }
      case 'activate': {
        const target = requireTab(value.tabId);
        activeTabId = target.id;
        // Never reuse the previous tab's or the previous activation's rectangle: the page measures and sends a fresh one.
        rectangle = cleanRect(value.rect);
        placeActive();
        return stateOf(target);
      }
      case 'bounds': {
        // A hidden tab reporting its (now unplaced) box must not steal the active tab's place or hide it.
        if (value.tabId && value.tabId !== activeTabId) {
          const other = tabs.get(value.tabId);
          if (other?.view) { try { other.view.setVisible(false); } catch { /* going away */ } }
          return { ok: true, ignored: true };
        }
        rectangle = cleanRect(value.rect);
        placeActive();
        return { ok: true, visible: !!rectangle };
      }
      case 'hide': {
        hideAll();
        return { ok: true };
      }
      case 'permission': {
        if (typeof value.requestId !== 'string' || !value.requestId) throw new Error('permission 需要 requestId');
        return settlePermission(value.requestId, value.allow === true);
      }
      case 'permissions': {
        const origin = value.origin ? safeOrigin(value.origin) : '';
        const permissions = [];
        for (const [key, allowed] of permissionDecisions) {
          const separator = key.indexOf('\0');
          const entryOrigin = key.slice(0, separator);
          if (!origin || entryOrigin === origin) permissions.push({ origin: entryOrigin, permission: key.slice(separator + 1), allowed });
        }
        const pending = [...pendingPermissions.entries()]
          .filter(([, entry]) => !value.tabId || entry.tabId === value.tabId)
          .filter(([, entry]) => !origin || entry.origin === origin)
          .map(([requestId, entry]) => ({ requestId, permission: entry.permission, origin: entry.origin }));
        return { permissions, pending };
      }
      case 'revokePermission': {
        const origin = safeOrigin(value.origin || '');
        const revoke = Array.isArray(value.permissions)
          ? value.permissions.map(String)
          : typeof value.permission === 'string'
            ? [value.permission]
            : [];
        if (!origin || !revoke.length) throw new Error('revokePermission 需要 origin 与 permission');
        let revoked = 0;
        for (const permission of revoke) if (permissionDecisions.delete(permissionKey(origin, permission))) revoked += 1;
        for (const [requestId, entry] of [...pendingPermissions]) {
          if (entry.origin === origin && revoke.includes(entry.permission)) settlePermission(requestId, false, { remember: false });
        }
        return { ok: true, origin, revoked };
      }
      case 'denyPending': {
        denyPendingForTab(requireTab(value.tabId).id);
        return { ok: true };
      }
      case 'refresh': {
        // The window moved/resized: re-clamp the rectangle that the page last reported; the page also re-measures.
        placeActive();
        return { ok: true };
      }
      case 'close': {
        if (value.tabId === '*') { for (const item of [...tabs.values()]) destroyTab(item); return { ok: true }; }
        destroyTab(requireTab(value.tabId));
        return { ok: true };
      }
      case 'list':
        return [...tabs.values()].map(stateOf);
      case 'state':
        return stateOf(requireTab(value.tabId));
      case 'navigate':
        return navigateTab(requireTab(value.tabId), value.url);
      case 'back': { const target = requireTab(value.tabId); contentsOf(target).navigationHistory.goBack(); return { ok: true }; }
      case 'forward': { const target = requireTab(value.tabId); contentsOf(target).navigationHistory.goForward(); return { ok: true }; }
      case 'reload': { const target = requireTab(value.tabId); contentsOf(target).reload(); return { ok: true }; }
      case 'stop': { const target = requireTab(value.tabId); contentsOf(target).stop(); return { ok: true }; }
      case 'find': {
        if (typeof value.text !== 'string') throw new Error('find 需要 text 字符串');
        if (value.text.length > 500) throw new Error('find 的文本超过 500 个字符');
        const result = await findInTab(requireTab(value.tabId), value.text, {
          forward: value.forward !== false,
          findNext: value.findNext === true,
          matchCase: value.matchCase === true,
        });
        return { ok: true, text: value.text, ...result };
      }
      case 'stopFind':
        return stopFind(requireTab(value.tabId));
      case 'snapshot':
        return { snapshot: await snapshot(requireTab(value.tabId)) };
      case 'exec': {
        if (typeof value.code !== 'string' || value.code.length === 0) throw new Error('exec 需要 code 字符串');
        if (value.code.length > 20000) throw new Error('exec 的代码超过 20000 个字符');
        return { result: await runInPage(requireTab(value.tabId), value.code) };
      }
      case 'ax':
        return { nodes: await accessibilityTree(requireTab(value.tabId)) };
      case 'dom': {
        const target = requireTab(value.tabId);
        return { html: await runInPage(target, 'document.documentElement.outerHTML.slice(0, 200000)'), text: await runInPage(target, 'document.body ? document.body.innerText.slice(0, 100000) : ""') };
      }
      case 'interactive':
        return { elements: await interactive(requireTab(value.tabId)) };
      case 'click': {
        const index = Number.isInteger(value.index) ? value.index : undefined;
        if (index === undefined && (typeof value.selector !== 'string' || !value.selector)) throw new Error('click 需要 selector 或 index');
        return click(requireTab(value.tabId), value.selector, index);
      }
      case 'type': {
        const index = Number.isInteger(value.index) ? value.index : undefined;
        if (index === undefined && (typeof value.selector !== 'string' || !value.selector)) throw new Error('type 需要 selector 或 index');
        return typeText(requireTab(value.tabId), value.selector, String(value.text ?? ''), index);
      }
      case 'upload': {
        const index = Number.isInteger(value.index) ? value.index : undefined;
        if (index === undefined && (typeof value.selector !== 'string' || !value.selector)) throw new Error('upload 需要 selector 或 index');
        const info = workspaceUploadFile(value.path);
        return uploadFile(requireTab(value.tabId), info, value.selector, index);
      }
      case 'text': {
        const target = requireTab(value.tabId);
        return { result: await runInPage(target, 'document.body ? document.body.innerText.slice(0, 100000) : ""') };
      }
      case 'downloads':
        return { downloads: downloadLog.slice(-50).filter((entry) => !value.tabId || entry.tabId === value.tabId) };
      case 'download-cancel': {
        for (const tab of tabs.values()) {
          const entry = tab.downloads.get(String(value.id || ''));
          if (entry) { try { entry.item.cancel(); } catch (error) { throw new Error(`无法取消下载：${error.message}`); } return { ok: true, id: value.id }; }
        }
        throw new Error(`没有正在进行的下载 ${value.id || ''}`);
      }
      case 'download-retry': {
        const record = downloadLog.find((entry) => entry.id === value.id && entry.url);
        const tab = record ? tabs.get(record.tabId) : undefined;
        if (!record || !tab) throw new Error(`没有可重试的下载 ${value.id || ''}`);
        contentsOf(tab).downloadURL(record.url);
        return { ok: true, id: record.id, url: record.url };
      }
      case 'network':
        return { requests: networkLog.slice(-200).filter((entry) => !value.tabId || entry.tabId === value.tabId) };
      case 'scroll': {
        const target = requireTab(value.tabId);
        const x = Number(value.x || 0), y = Number(value.y || 0);
        return { result: await runInPage(target, `window.scrollBy(${Number.isFinite(x) ? x : 0}, ${Number.isFinite(y) ? y : 0}); ({x: window.scrollX, y: window.scrollY})`) };
      }
      case 'external':
        return shell.openExternal(exports.httpUrl(value.url));
      case 'bookmarks':
        return { bookmarks: requireBookmarks().list() };
      case 'bookmark-add': {
        const store = requireBookmarks();
        const tab = value.tabId ? tabs.get(value.tabId) : undefined;
        const icon = tab && tab.url && safeOrigin(tab.url) === safeOrigin(value.url) ? await fetchIcon(tab) : undefined;
        return { bookmarks: bookmarksChanged(store.add({ url: value.url, title: value.title, icon })) };
      }
      case 'bookmark-update':
        return { bookmarks: bookmarksChanged(requireBookmarks().update(String(value.id || ''), { url: value.url, title: value.title })) };
      case 'bookmark-remove':
        return { bookmarks: bookmarksChanged(requireBookmarks().remove(String(value.id || ''))) };
      case 'passwords': {
        // Site and user name only: a saved password never leaves the host towards the workspace page.
        const store = requirePasswords();
        const origin = value.origin ? safeOrigin(value.origin) : '';
        return { available: store.available(), logins: store.list(origin || undefined) };
      }
      case 'password-remove':
        return requirePasswords().remove(String(value.id || ''));
      default:
        throw new Error(`未知的浏览器命令：${action}`);
    }
  };

  return {
    command,
    // Legacy single-view surface kept for the old panel and its tests: one default tab, same call shape.
    navigate: async (url) => {
      const existing = tabs.get(DEFAULT_TAB);
      const tab = existing || createTab(exports.httpUrl(url));
      activeTabId = tab.id;
      placeActive();
      await navigateTab(tab, url);
      return { ok: true };
    },
    bounds: (rect) => {
      rectangle = cleanRect(rect);
      if (rectangle && !tabs.has(activeTabId || DEFAULT_TAB)) {
        const tab = createTab(undefined);
        activeTabId = tab.id;
      }
      placeActive();
    },
    refresh: () => placeActive(),
    hide: () => hideAll(),
    destroy: () => {
      for (const tab of [...tabs.values()]) destroyTab(tab);
      activeTabId = null;
      rectangle = null;
    },
    snapshot: () => {
      const tab = tabs.get(activeTabId);
      if (!tab) return;
      void picture(tab);
    },
    get view() { return tabs.get(activeTabId)?.view; },
    get tabs() { return [...tabs.values()]; },
    get activeTabId() { return activeTabId; },
    get rectangle() { return rectangle; },
  };
};
