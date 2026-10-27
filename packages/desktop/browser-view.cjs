const { BrowserWindow, View, WebContentsView, session, Menu, shell, app, ipcMain, safeStorage, nativeImage } = require('electron');
// Absolute paths: the tests compile this file outside the normal module loader, where a relative require would not
// resolve against this folder.
const { createBookmarkStore } = require(require('node:path').join(__dirname, 'browser-bookmarks.cjs'));
const { createSpeedDialStore } = require(require('node:path').join(__dirname, 'browser-speed-dial.cjs'));
const { keyEvents } = require(require('node:path').join(__dirname, 'browser-input.cjs'));
const { createPasswordStore, attachPasswordManager } = require(require('node:path').join(__dirname, 'browser-passwords.cjs'));
const { createPermissionStore } = require(require('node:path').join(__dirname, 'browser-permissions.cjs'));
const page = require(require('node:path').join(__dirname, 'browser-page-helpers.cjs'));
const { attachZoom, cleanZoom, createSiteZoomStore, stepZoom } = require(require('node:path').join(__dirname, 'zoom.cjs'));
const dark = require(require('node:path').join(__dirname, 'browser-dark.cjs'));
const { acceptLanguage, createLanguageStore, languageList } = require(require('node:path').join(__dirname, 'browser-language.cjs'));
const { createBrowserSync } = require(require('node:path').join(__dirname, 'browser-sync.cjs'));
const { INTERACTIVE_QUERY } = page;

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
 * It is only used on CHROME_UA_SITES (see `wantsChromeAgent`): everywhere else the engine's own string is sent.
 */
exports.chromeUserAgent = (fallback, chromeVersion) => {
  const major = String(chromeVersion || '').split('.')[0];
  const platform = /\(([^)]*)\)/.exec(String(fallback || ''))?.[1] || 'Windows NT 10.0; Win64; x64';
  if (!/^\d+$/.test(major)) return String(fallback || '');
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
};

// Sites that refuse Electron's own user agent and get Chrome's instead. Everywhere else a tab keeps the engine's string:
// Cloudflare Turnstile fails every check ("Verification failed") on a page whose user agent claims Chrome while the
// engine is Electron (measured on Electron 45: the engine's own string passed 3 of 3 runs; Chrome's string, with or
// without the added client-hint brand, and the engine's string minus only `Electron/x` failed 6 of 6).
const CHROME_UA_SITES = /(^|\.)(whatsapp\.com|teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft)$/i;
/** Whether a page at `url` is one of CHROME_UA_SITES. */
exports.wantsChromeAgent = (url) => {
  try { return CHROME_UA_SITES.test(new URL(url).hostname); } catch { return false; }
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
// Titles that a bot check (Cloudflare's interstitial, its "verification failed" page and their kin) shows. Such a page
// has no control the workspace could press, so recognising it is only used to offer a way forward, never to answer it.
const VERIFY_PAGE = /just a moment|verification failed|attention required|checking your browser|verify you are human|are you a robot|access denied/i;
// A tab that has never been on screen still needs a viewport, so the Agent can read, click and screenshot it in the
// background; it gets the size the visible tab last had (this one before any), never less than AGENT_VIEWPORT.
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
// The isolated world that draws the Agent's mouse pointer: the site's own scripts cannot reach it.
const CURSOR_WORLD = 1207;
// A hidden page is throttled by Chromium and then ignores input events (a wheel event never even completes). While the
// Agent acts on a tab it is kept awake, and throttled again after this long without an Agent action.
const AGENT_AWAKE_MS = 20000;
// A background tab is laid out at least this large, so sites give the Agent their desktop layout there. The tab on
// screen always has exactly the panel's size: what the user sees is never a scaled-down picture of a bigger page.
const AGENT_VIEWPORT = { width: 1280, height: 800 };
// A clicked control whose text or link names a download or a file: the click waits a few seconds for a download to start.
const DOWNLOAD_HINT = /download|下载|下載|\.(pdf|docx?|xlsx?|pptx?|csv|txt|zip|rar|7z|gz|png|jpe?g|gif|mp3|mp4|mov|apk|exe|msi)\b/i;
// Agent commands that read or act on a page's layout; each keeps the tab awake first.
const AGENT_TAB_ACTIONS = new Set(['snapshot', 'read', 'mouse', 'keys', 'insertText', 'exec', 'ax', 'dom', 'interactive', 'click', 'type', 'text', 'scroll', 'find', 'upload', 'login', 'download', 'locate', 'wait']);

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
 * same persistent session. A site permission request waits for an explicit decision (the user in the workspace, or the
 * Agent through the workspace tool) and is denied by default; a bookmarked site's requests are allowed at once. Every tab,
 * hidden or not, keeps a real viewport, so the Agent can read, click, type into and capture background tabs.
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
  // The part of the active tab's box that the page leaves uncovered (a sidebar floated over its left side), or null when
  // the whole box is. The view keeps its full size and is cut at the edge, so a playing video stays live beside it.
  let clipRectangle = null;
  let lastViewport = DEFAULT_VIEWPORT;
  // What the pages did while the workspace watched: recent downloads and request metadata. Both stay small and are
  // only read by the workspace command surface (never persisted), so a page cannot grow them without bound.
  const downloadLog = [];
  const networkLog = [];
  let downloadSeq = 0;
  let permissionSeq = 0;
  // Site permission decisions: the first request for an origin/permission is shown in the workspace, a decision (by the
  // user, or by the Agent through the workspace tool) is kept in the desktop profile until the user revokes it, and a
  // request nobody answers is denied after the timeout without being remembered. A bookmarked site is the user's own
  // choice of a trusted site: its requests are allowed at once and reported as such.
  const permissionDecisions = createPermissionStore(options.profileDir ? require('node:path').join(require('node:path').resolve(options.profileDir), 'browser-permissions.json') : undefined, log);
  const pendingPermissions = new Map();
  const PERMISSION_TIMEOUT_MS = 60000;
  const permissionKey = (origin, permission) => `${origin || ''}\0${permission || ''}`;
  const permissionFor = (origin, permission) => permissionDecisions.get(permissionKey(origin, permission));
  const send = (value) => {
    if (!window.isDestroyed()) window.webContents.send('desktop:status', value);
  };
  const emit = (tabId, value) => send({ tabId, ...value });
  // Every tab's view lives in this container, which has the active view's box, or only the uncovered part of it
  // (`clipRectangle`). What lies outside is cut away without resizing the view: the site is not laid out again on every
  // frame of a sliding sidebar. View bounds are relative to the container, whose corner is `stageOrigin` in the window.
  const stage = new View();
  window.contentView.addChildView(stage);
  let stageOrigin = { x: 0, y: 0 };
  const partition = session.fromPartition(PARTITION);
  // Bookmarks and saved logins belong to this desktop profile (`options.profileDir`, the host's user-data folder),
  // never to the Data root or any workspace; browser sync (browser-sync.cjs) carries them. A host without a profile has neither.
  const profileDir = options.profileDir ? require('node:path').resolve(options.profileDir) : undefined;
  const bookmarks = profileDir ? createBookmarkStore(require('node:path').join(profileDir, 'browser-bookmarks.json')) : undefined;
  // Zoom of each website, by host (Ctrl + "+" / "-" / 0 or Ctrl + wheel inside a tab, or the toolbar's zoom badge).
  const siteZoom = createSiteZoomStore(profileDir ? require('node:path').join(profileDir, 'browser-zoom.json') : '', log);
  // The language websites are told the user reads (toolbar → language); '' keeps the engine's default (Windows').
  const siteLanguage = createLanguageStore(profileDir ? require('node:path').join(profileDir, 'browser-language.json') : '', log);
  // The app page measures the view's box in its own CSS pixels; with the app window zoomed those are not the window's
  // pixels any more (a 125 % app has 1.25 window pixels per CSS pixel).
  const appZoom = () => {
    try { return window.isDestroyed() ? 1 : window.webContents.getZoomFactor() || 1; } catch { return 1; }
  };
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
  /** Whether a bookmark points at this origin: the user marked the site as theirs, so the Agent may drive it fully. */
  const bookmarkedOrigin = (origin) => {
    if (!bookmarks || !origin) return false;
    try { return bookmarks.list().some((item) => safeOrigin(item.url) === origin); } catch { return false; }
  };
  const speedDial = profileDir
    ? createSpeedDialStore(require('node:path').join(profileDir, 'browser-speed-dial.json'), { seed: () => (bookmarks ? bookmarks.list() : []) })
    : undefined;
  const requireSpeedDial = () => { if (!speedDial) throw new Error('当前桌面宿主不支持快捷方式'); return speedDial; };
  const speedDialChanged = (items) => { send({ type: 'speeddial', items }); return items; };
  // A tab sends the engine's own user agent, except on CHROME_UA_SITES, which get Chrome's. The choice is made per
  // top-level navigation (`agentFor`, applied in `wire` and to the navigation request's header below), so a tab that
  // moves between such a site and any other site always presents the identity that belongs to the page it shows.
  const engineAgent = app.userAgentFallback;
  const chromeAgent = exports.chromeUserAgent(engineAgent, process.versions.chrome);
  const agentFor = (url) => (exports.wantsChromeAgent(url) ? chromeAgent : engineAgent);
  const setAgent = (contents, url) => {
    const want = agentFor(url);
    try { if (contents.getUserAgent() !== want) contents.setUserAgent(want); } catch { /* contents are going away */ }
    return want;
  };
  // On a page that sends Chrome's user agent the engine's own client hints (Chromium only) disagree with it in a way no
  // ordinary browser does. A real Chrome lists its own brand next to Chromium, so on those pages the same brand is added
  // to navigator.userAgentData in browser-tab-preload.cjs. Nothing else is changed: version, platform and full version
  // list stay the engine's own.
  const chromeBrand = (() => {
    const match = /Chrome\/(\d+)\./u.exec(chromeAgent);
    return match && chromeAgent !== engineAgent ? `"Google Chrome";v="${match[1]}"` : undefined;
  })();
  /** The last brand list a page reported, so the request headers can mirror exactly what navigator.userAgentData says. */
  let hintBrands;
  let hintAsked = false;
  /**
   * Electron 45 sends no client hints at all (measured: no sec-ch-ua, sec-ch-ua-mobile or sec-ch-ua-platform on any
   * secure request), while its user agent says Chrome, which always sends the three low-entropy hints. They are therefore
   * mirrored from the engine's own list as soon as a page has reported it: the header and navigator.userAgentData can
   * never disagree. Before that the header is left alone instead of being filled with a guessed brand list, because a
   * header that does not match what the page reports would be a signal of its own. Only a page with Chrome's user agent
   * is asked (its list carries the added brand) and only its requests get the headers.
   */
  const learnClientHints = (contents) => {
    if (hintAsked || !chromeBrand || !exports.wantsChromeAgent(contents.getURL())) return;
    hintAsked = true;
    contents
      .executeJavaScript('navigator.userAgentData ? navigator.userAgentData.brands : null')
      .then((brands) => {
        if (Array.isArray(brands) && brands.length) hintBrands = brands;
        else hintAsked = false;
      })
      .catch(() => {
        hintAsked = false;
      });
  };
  const clientHints = () => {
    if (!chromeBrand || !Array.isArray(hintBrands) || !hintBrands.length) return undefined;
    const list = hintBrands.map((item) => `"${item.brand}";v="${item.version}"`).join(', ');
    const platform = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
    return { list, platform };
  };
  if (partition.webRequest && typeof partition.webRequest.onBeforeSendHeaders === 'function') {
    partition.webRequest.onBeforeSendHeaders({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
      const headers = details.requestHeaders || {};
      const nameOf = (want) => Object.keys(headers).find((name) => name.toLowerCase() === want);
      const has = (want) => !!nameOf(want);
      // The navigation request itself already leaves with the agent of the page it opens; the tab follows in `wire`.
      if (details.resourceType === 'mainFrame') {
        const agent = details.webContents ? setAgent(details.webContents, details.url) : agentFor(details.url);
        headers[nameOf('user-agent') || 'User-Agent'] = agent;
      }
      const language = siteLanguage.get();
      if (language) headers[nameOf('accept-language') || 'Accept-Language'] = acceptLanguage(language);
      const hints = /^https:/i.test(details.url) && headers[nameOf('user-agent')] === chromeAgent ? clientHints() : undefined;
      if (hints && !has('sec-ch-ua')) {
        headers['sec-ch-ua'] = hints.list;
        if (!has('sec-ch-ua-mobile')) headers['sec-ch-ua-mobile'] = '?0';
        if (!has('sec-ch-ua-platform')) headers['sec-ch-ua-platform'] = `"${hints.platform}"`;
      }
      callback({ requestHeaders: headers });
    });
  }
  const settlePermission = (requestId, allow, options = {}) => {
    const entry = pendingPermissions.get(requestId);
    if (!entry) throw new Error(`没有待处理的网站权限请求 ${requestId}`);
    pendingPermissions.delete(requestId);
    clearTimeout(entry.timer);
    if (options.remember !== false) permissionDecisions.set(permissionKey(entry.origin, entry.permission), allow === true);
    const by = options.by === 'agent' ? 'agent' : undefined;
    emit(entry.tabId, { type: 'permission', requestId, permission: entry.permission, origin: entry.origin, allowed: allow === true, remembered: options.remember !== false, ...(by ? { by } : {}) });
    log(`网站权限请求${allow ? '已允许' : '已拒绝'}${by ? '（Agent）' : ''}：${entry.permission} ${entry.origin}`);
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
    if (permissionFor(origin, permission) === undefined && bookmarkedOrigin(origin)) {
      permissionDecisions.set(permissionKey(origin, permission), true);
      emit(tab.id, { type: 'permission', permission, origin, allowed: true, remembered: true, by: 'bookmark' });
      log(`网站权限请求自动允许（书签网站）：${permission} ${origin}`);
      callback(true);
      return;
    }
    const known = permissionFor(origin, permission);
    if (known !== undefined) {
      // A decision that is already known is applied silently: the user was told once, when it was made.
      emit(tab ? tab.id : undefined, { type: 'permission', permission, origin, allowed: known === true, remembered: true, reused: true });
      log(`网站权限请求沿用已保存决定：${permission} ${origin} → ${known ? '允许' : '拒绝'}`);
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
    const known = permissionFor(origin, permission);
    return known === undefined ? bookmarkedOrigin(origin) : known === true;
  });
  partition.on('will-download', (event, item, webContents) => {
    const tab = webContents ? tabFor(webContents) : undefined;
    if (!tab || tab.destroyed) { try { item.cancel(); } catch { /* already gone */ } return; }
    const downloads = app.getPath('downloads');
    const name = uniqueDownloadName(downloads, item.getFilename());
    item.setSavePath(require('node:path').join(downloads, name));
    const record = { id: `download${++downloadSeq}`, seq: downloadSeq, name, savePath: item.getSavePath(), url: item.getURL(), tabId: tab.id, total: item.getTotalBytes(), received: 0, state: 'started', at: Date.now() };
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

  // ---- Dark mode (browser-dark.cjs) ----------------------------------------------------------------------------------
  // "auto" follows the app: the page tells the host whether it is dark and its colors (`darkMode` command).
  const darkStore = dark.createDarkStore(profileDir ? require('node:path').join(profileDir, 'browser-dark.json') : '', log);
  let appDark = true;
  let appColors;
  // A dark page must not flash white while it loads. Until the engine runs, the document gets a dark canvas: the preload
  // puts it in before the first paint (`mh-browser:dark-early`), and the host puts the same rules in once the page has
  // committed if the preload did not (browser-dark.cjs putCanvas / dropCanvas). `body` too, since most pages paint a white body over the html background; `color-scheme` makes the
  // default text and form controls light meanwhile. The native view itself starts in that color, not white.
  const canvasColor = () => (typeof appColors?.background === 'string' && /^#[0-9a-f]{6}$/iu.test(appColors.background) ? appColors.background : '#1e1f1f');
  const darkCanvas = () => `html, body { background-color: ${canvasColor()} !important; } html { color-scheme: dark !important; }`;
  /** The color a tab's view shows before its page paints: the dark canvas when the page will be dark. */
  const paintViewBackground = (tab, url = tab.url) => {
    if (tab.destroyed || !tab.view) return;
    const darkFirst = url ? darkStore.wanted(url, appDark) : appDark;
    try { tab.view.setBackgroundColor(darkFirst ? canvasColor() : '#ffffff'); } catch { /* view is going away */ }
  };
  const darkState = (tab) => ({ dark: !!tab.dark, darkNative: !!tab.dark && tab.nativeDark === true, darkMode: darkStore.get().mode, darkSite: darkStore.get().sites[darkStore.hostOf(tab.url)] || null });
  /**
   * Tell the tab's pages whether the reader prefers dark (`prefers-color-scheme`), so a site with a dark theme of its own
   * shows it. The emulation lives in the page's debugger session, attached for as long as dark is wanted (the other
   * debugger users only borrow an attached session and leave it attached). Resolves true when the preference changed.
   */
  const setPrefersDark = async (tab, on) => {
    if (tab.destroyed || !tab.view || tab.view.webContents.isDestroyed()) return false;
    if (!!tab.prefersDark === on) return false;
    const debuggerApi = tab.view.webContents.debugger;
    try {
      if (on && !debuggerApi.isAttached()) {
        debuggerApi.attach('1.3');
        tab.schemeDebugger = true;
        debuggerApi.once('detach', () => { tab.schemeDebugger = false; tab.prefersDark = false; });
      }
      if (!debuggerApi.isAttached()) { tab.prefersDark = false; return false; }
      await debuggerApi.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: on ? 'dark' : '' }] });
      tab.prefersDark = on;
      if (!on && tab.schemeDebugger) { tab.schemeDebugger = false; debuggerApi.detach(); }
      return true;
    } catch (error) {
      log?.(`无法设置网页的深色偏好：${error.message}`);
      return false;
    }
  };
  const syncDark = async (tab) => {
    if (tab.destroyed || !tab.view || tab.view.webContents.isDestroyed()) return;
    const contents = tab.view.webContents;
    const wanted = darkStore.wanted(tab.url, appDark);
    // The site's own dark theme comes first: with the preference told, a page that turns dark by itself keeps its design
    // and the engine stays off. Asked once per document (and again when the preference changes), before the engine runs;
    // the check sets the loading canvas aside for its one read.
    if (await setPrefersDark(tab, wanted)) tab.nativeDark = undefined;
    if (wanted && tab.nativeDark === undefined && !tab.darkEngine) {
      tab.nativeDark = await dark.detectNativeDark(contents);
      if (tab.destroyed || contents.isDestroyed()) return;
    }
    const engine = wanted && tab.nativeDark !== true;
    // `darkTried`: the engine may run in this document even when it did not report back, so turning off always asks it.
    if (engine || tab.darkEngine || tab.darkTried) {
      tab.darkTried = engine;
      tab.darkEngine = await dark.applyDark(contents, engine, appColors);
    }
    tab.dark = engine ? tab.darkEngine : wanted && tab.nativeDark === true;
    // The loading canvas goes: the engine or the site's own theme colors the page now (or it stays in its own colors).
    await dark.dropCanvas(contents);
    try { contents.send('mh-browser:dark-settled'); } catch { /* view is going away */ }
    paintViewBackground(tab);
    if (!tab.destroyed) emit(tab.id, { type: 'dark', ...darkState(tab) });
  };
  const syncDarkAll = () => { for (const tab of tabs.values()) void syncDark(tab); };

  // ---- Sync between the user's computers (browser-sync.cjs) ----------------------------------------------------------
  // Drive sync writes a store's file: the store reads it again and the open tabs and the page follow.
  const browserSync = profileDir && safeStorage
    ? createBrowserSync({
      profileDir,
      partition,
      passwords,
      safeStorage,
      log,
      stores: {
        'browser-bookmarks.json': () => { if (bookmarks) { bookmarks.reload(); bookmarksChanged(bookmarks.list()); } },
        'browser-speed-dial.json': () => { if (speedDial) { speedDial.reload(); speedDialChanged(speedDial.list()); } },
        'browser-zoom.json': () => {
          siteZoom.reload();
          for (const tab of tabs.values()) if (tab.url) setTabZoom(tab, siteZoom.get(tab.url), false);
        },
        'browser-dark.json': () => { darkStore.reload(); syncDarkAll(); },
        'browser-language.json': () => {
          const before = siteLanguage.get();
          const language = siteLanguage.reload();
          if (language !== before) for (const tab of tabs.values()) emit(tab.id, { type: 'language', language });
        },
        'browser-permissions.json': () => permissionDecisions.reload(),
      },
    })
    : undefined;
  const requireSync = (context) => {
    if (context.agent) throw new Error('浏览器同步只能由用户在设置里打开或关闭');
    if (!browserSync) throw new Error('当前桌面宿主不支持浏览器同步');
    return browserSync;
  };
  if (ipcMain) {
    // Asked by a tab's preload as its document starts: navigator.languages for the chosen language (null: the engine's).
    ipcMain.removeAllListeners('mh-browser:languages');
    ipcMain.on('mh-browser:languages', (event) => {
      const language = tabFor(event.sender) ? siteLanguage.get() : '';
      event.returnValue = language ? languageList(language) : null;
    });
    // Asked by a tab's preload as its document starts (before the first paint): the canvas rules when the page will be
    // dark. Synchronous on purpose, it costs one round trip and is the only way to beat the first paint.
    ipcMain.removeAllListeners('mh-browser:dark-early');
    ipcMain.on('mh-browser:dark-early', (event, url) => {
      const tab = tabFor(event.sender);
      let wanted = false;
      try { wanted = !!tab && !tab.destroyed && darkStore.wanted(String(url || ''), appDark); } catch { wanted = false; }
      event.returnValue = wanted ? darkCanvas() : '';
    });
    // The engine in a tab reads cross-origin stylesheets and images through this (see browser-tab-preload.cjs).
    ipcMain.removeHandler('mh-browser:dark-fetch');
    ipcMain.handle('mh-browser:dark-fetch', (event, url) => {
      const tab = tabFor(event.sender);
      if (!tab || tab.destroyed || !darkStore.wanted(tab.url, appDark)) return { ok: false, status: 0 };
      return dark.darkFetch(partition, url);
    });
    // Selection translation in a page (see browser-tab-preload.cjs): the app's own service translates, with the model of
    // Settings → Agent → Assistants → Translation. Only a site tab may ask; the card takes the app's colors.
    ipcMain.removeHandler('mh-browser:translate-look');
    // British / American pronunciation for the card when Windows has no voice of that accent: the bytes of the
    // service's dictionary voice (GET /api/translate/voice), at most 1 MB.
    ipcMain.removeHandler('mh-browser:translate-voice');
    ipcMain.handle('mh-browser:translate-voice', async (event, request) => {
      if (!tabFor(event.sender) || typeof options.translationVoice !== 'function') return null;
      const text = String(request?.text || '').trim();
      const accent = request?.accent === 'uk' || request?.accent === 'us' ? request.accent : '';
      if (!accent || !/^[A-Za-z][A-Za-z' -]{0,59}$/.test(text)) return null;
      try {
        const bytes = await options.translationVoice(text, accent);
        return bytes && bytes.length <= 1024 * 1024 ? new Uint8Array(bytes) : null;
      } catch { return null; }
    });
    ipcMain.removeHandler('mh-browser:translate-language');
    ipcMain.handle('mh-browser:translate-language', async (event) => {
      if (!tabFor(event.sender) || typeof options.translationLanguage !== 'function') return null;
      try {
        const saved = await options.translationLanguage();
        return saved && typeof saved.preference === 'string' ? { preference: saved.preference, target: String(saved.target || '') } : null;
      } catch { return null; }
    });
    ipcMain.handle('mh-browser:translate-look', (event) => (tabFor(event.sender) ? { dark: appDark, ...(appColors || {}) } : null));
    ipcMain.removeHandler('mh-browser:translate');
    // `request`: the selected text, or { text, target, remember } when the card's language menu picked a language.
    ipcMain.handle('mh-browser:translate', async (event, request) => {
      const tab = tabFor(event.sender);
      if (!tab || tab.destroyed) return { ok: false, error: '拒绝非网页标签的请求' };
      if (typeof options.translate !== 'function') return { ok: false, error: '翻译服务还没有就绪' };
      const asked = request && typeof request === 'object' ? request : { text: request };
      const value = String(asked.text || '').trim().slice(0, 6000);
      if (!value) return { ok: false, error: '请先选中要翻译的文字。' };
      const target = typeof asked.target === 'string' && /^[A-Za-z-]{2,8}$/.test(asked.target) ? asked.target : undefined;
      try {
        const answer = await options.translate(value, target ? { target, remember: asked.remember === true } : {});
        const entry = answer?.entry && typeof answer.entry === 'object' ? answer.entry : undefined;
        return { ok: true, translation: String(answer?.translation || ''), target: String(answer?.target || ''), preference: String(answer?.preference || ''), ...(entry ? { entry } : {}), model: String(answer?.model || '') };
      } catch (error) {
        return { ok: false, error: error.message || String(error) };
      }
    });
  }

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

  /** Send the tab strip the site icon of a tab once per icon address, so a tab can be shown by its icon alone. */
  const pushIcon = async (tab) => {
    const key = tab.favicon || safeOrigin(tab.url);
    if (!key || tab.iconKey === key) return;
    tab.iconKey = key;
    const icon = await fetchIcon(tab);
    if (icon && !tab.destroyed && tabs.get(tab.id) === tab) emit(tab.id, { type: 'icon', icon, url: tab.url });
  };

  /** The icon of a site that is not open in any tab: its page's <link rel=icon>, else /favicon.ico. */
  const siteIcon = async (url) => {
    if (typeof partition.fetch !== 'function') return undefined;
    const tryImage = async (href) => {
      try {
        const response = await partition.fetch(href, { signal: AbortSignal.timeout(4000) });
        const type = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        if (!response.ok || !type.startsWith('image/')) return undefined;
        const body = Buffer.from(await response.arrayBuffer());
        if (!body.length || body.length > MAX_ICON_BYTES) return undefined;
        return `data:${type};base64,${body.toString('base64')}`;
      } catch {
        return undefined;
      }
    };
    try {
      const page = new URL(url);
      const response = await partition.fetch(page.href, { signal: AbortSignal.timeout(5000) });
      const text = response.ok ? (await response.text()).slice(0, 300000) : '';
      for (const match of text.matchAll(/<link\b[^>]*>/gi)) {
        const tag = match[0];
        if (!/rel\s*=\s*["']?[^"'>]*\bicon\b/i.test(tag)) continue;
        const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
        if (!href) continue;
        const icon = await tryImage(new URL(href, response.url || page.href).href);
        if (icon) return icon;
      }
      return tryImage(new URL('/favicon.ico', page.href).href);
    } catch {
      return undefined;
    }
  };

  let fillingIcons = false;
  /** Fetch the icons of shortcuts that have none yet (a bookmark of the same site lends its icon first). */
  const fillSpeedDialIcons = async (store) => {
    if (fillingIcons) return;
    fillingIcons = true;
    try {
      const known = new Map((bookmarks ? bookmarks.list() : []).filter((item) => item.icon).map((item) => [safeOrigin(item.url), item.icon]));
      let changed = false;
      for (const site of store.missingIcons()) {
        const icon = known.get(safeOrigin(site.url)) || (await siteIcon(site.url));
        if (store.setIcon(site.id, icon || null)) changed = true;
      }
      if (changed) speedDialChanged(store.list());
    } catch (error) {
      log(`快捷方式图标获取失败：${error.message}`);
    } finally {
      fillingIcons = false;
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
      // The page looks like a bot check (Cloudflare's interstitial or its failed variant). The workspace then offers the
      // way out: try again, or finish the check in the normal browser. Nothing here answers a challenge itself.
      challenge: !!tab.challenge,
      // The page's zoom (1 = 100 %), shown on the toolbar while it is not 100 %.
      zoom: tab.zoom ?? 1,
      // Dark mode: whether the page is recolored now, the general mode and this site's own choice (null: follows it).
      ...darkState(tab),
      // The language websites are told the user reads ('' : the engine's default).
      language: siteLanguage.get(),
      // Sound: whether the page is playing any now, and whether the tab is muted (an Agent's tab starts muted).
      audible: !!contents?.isCurrentlyAudible?.(),
      muted: !!contents?.isAudioMuted?.(),
      canGoBack: !!history?.canGoBack?.(),
      canGoForward: !!history?.canGoForward?.(),
      visible: tab.view?.getVisible?.() ?? false,
      // The rectangle the native view actually occupies (null while hidden); lets the page and the Agent verify placement.
      bounds: tab.view?.getVisible?.() ? (() => { try { const box = tab.view.getBounds(); return { ...box, x: box.x + stageOrigin.x, y: box.y + stageOrigin.y }; } catch { return null; } })() : null,
      active: tab.id === activeTabId,
      // Site permission questions of this tab that nobody has answered yet (the Agent can answer them).
      pendingPermissions: [...pendingPermissions.entries()]
        .filter(([, entry]) => entry.tabId === tab.id)
        .map(([requestId, entry]) => ({ requestId, permission: entry.permission, origin: entry.origin })),
    };
  };

  /**
   * Screenshot state pushed to the page: only for a tab that is on screen and whose page itself has loaded. A page that
   * keeps loading frames or requests (Google Drive, mail, chat apps) still gets its picture: waiting for `isLoading()`
   * left those without any, so a menu opened over them showed an empty panel.
   */
  const picture = async (tab) => {
    if (!tab || tab.destroyed || !tab.view || tab.view.webContents.isDestroyed() || tab.view.webContents.isLoadingMainFrame()) return;
    if (!tab.view.getVisible()) return;
    if (!tabs.has(tab.id) || tab.id !== activeTabId) return;
    try {
      const image = await tab.view.webContents.capturePage();
      if (image.isEmpty() || tabs.get(tab.id) !== tab) return;
      // The picture stands in for the native view, so it carries the view's own box.
      const frame = tab.view.getBounds?.() || {};
      const scale = appZoom();
      emit(tab.id, { type: 'snapshot', snapshot: `data:image/jpeg;base64,${image.toJPEG(85).toString('base64')}`, width: frame.width / scale, height: frame.height / scale });
    } catch (error) {
      log(`网页截图失败：${error.message}`);
    }
  };

  // Bounds requests in the order they came: a hide waiting for its picture is dropped when a newer request arrived.
  let boundsOrder = 0;

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

  /**
   * Moving frames of the hidden active view while the page plays an animation over its place (the mode reveal draws
   * the new screen in a growing circle): the page shows them in the view's place, so a playing video keeps moving
   * instead of standing still on the last picture. They are captured without showing the view or changing its
   * visibility for the site (`stayHidden`), skipped while nothing changed, and end when the view is placed again, another
   * tab becomes active, the page asks for a plain hide or after FRAMES_MAX_MS at the latest.
   */
  const FRAME_MS = 40;
  const FRAMES_MAX_MS = 5000;
  let frames = null;
  const stopFrames = () => {
    if (frames) clearTimeout(frames.timer);
    frames = null;
  };
  const startFrames = (tab) => {
    stopFrames();
    if (!tab?.view || tab.destroyed) return;
    const run = { timer: undefined, until: Date.now() + FRAMES_MAX_MS, last: null };
    frames = run;
    const step = async () => {
      if (frames !== run) return;
      const contents = tab.view.webContents;
      if (Date.now() > run.until || tab.destroyed || tab.id !== activeTabId || contents.isDestroyed() || tab.view.getVisible()) {
        stopFrames();
        return;
      }
      const started = Date.now();
      try {
        const image = await contents.capturePage(undefined, { stayHidden: true });
        if (frames === run && !image.isEmpty()) {
          const jpeg = image.toJPEG(75);
          if (!run.last || !jpeg.equals(run.last)) {
            run.last = jpeg;
            const box = tab.view.getBounds?.() || {};
            const scale = appZoom();
            emit(tab.id, { type: 'frame', frame: `data:image/jpeg;base64,${jpeg.toString('base64')}`, width: box.width / scale, height: box.height / scale });
          }
        }
      } catch { /* the page is going away */ }
      if (frames === run) run.timer = setTimeout(() => void step(), Math.max(0, FRAME_MS - (Date.now() - started)));
    };
    void step();
  };

  /** Clamp a page rectangle to the current content area; a zero-sized window hides the view instead of drawing it. */
  const inWindow = (value) => {
    if (!value) return null;
    const [width, height] = window.getContentSize();
    if (width < 1 || height < 1) return null;
    const scale = appZoom();
    const x = Math.max(0, Math.min(width - 1, Math.round(value.x * scale)));
    const y = Math.max(0, Math.min(height - 1, Math.round(value.y * scale)));
    const w = Math.max(0, Math.min(width - x, Math.round(value.width * scale)));
    const h = Math.max(0, Math.min(height - y, Math.round(value.height * scale)));
    if (w < 1 || h < 1) return null;
    return { x, y, width: w, height: h };
  };
  const boundsForRectangle = () => inWindow(rectangle);

  /** The part of `bounds` that is shown: all of it, the clip inside it, or null when the clip leaves nothing. */
  const shownPart = (bounds) => {
    if (!bounds || !clipRectangle) return bounds;
    const clip = inWindow(clipRectangle);
    if (!clip) return null;
    const x = Math.max(bounds.x, clip.x);
    const y = Math.max(bounds.y, clip.y);
    const right = Math.min(bounds.x + bounds.width, clip.x + clip.width);
    const bottom = Math.min(bounds.y + bounds.height, clip.y + clip.height);
    return right - x >= 1 && bottom - y >= 1 ? { x, y, width: right - x, height: bottom - y } : null;
  };

  /**
   * Apply the one visibility invariant: the active tab's view is visible exactly while a usable rectangle exists.
   * Every other view is hidden. Bounds are set before the view is shown so it never appears at the previous box.
   */
  const placeActive = () => {
    // A popup's contents can be destroyed while the app window itself is closing; there is nothing left to place.
    if (window.isDestroyed()) return;
    const bounds = boundsForRectangle();
    const shown = shownPart(bounds);
    if (bounds) lastViewport = { width: bounds.width, height: bounds.height };
    for (const tab of tabs.values()) {
      if (!tab.view || tab.destroyed) continue;
      const visible = tab.id === activeTabId && !!shown;
      // The active tab hidden only because a menu or dialog of the page lies over it keeps its size: resizing it to the
      // background size and back made the site lay itself out twice, a visible jump each time a menu closed.
      if (!visible) conceal(tab, { keepSize: tab.id === activeTabId });
      else {
        try {
          stage.setBounds(shown);
          stageOrigin = { x: shown.x, y: shown.y };
          tab.view.setBounds({ x: bounds.x - shown.x, y: bounds.y - shown.y, width: bounds.width, height: bounds.height });
        } catch { /* view is going away */ }
        try { tab.view.setVisible(true); } catch { /* view is going away */ }
      }
      updatePictureTimer(tab);
    }
  };

  /** A background tab's viewport: the panel's size, but never smaller than the Agent's desktop size. */
  const backgroundViewport = () => ({
    width: Math.max(lastViewport.width, AGENT_VIEWPORT.width),
    height: Math.max(lastViewport.height, AGENT_VIEWPORT.height),
  });

  /** Hide one view. A view leaving the screen first gets the background size: a hidden view ignores new bounds. */
  const conceal = (tab, { keepSize = false } = {}) => {
    try {
      if (tab.view.getVisible() && !keepSize) tab.view.setBounds({ x: 0, y: 0, ...backgroundViewport() });
      tab.view.setVisible(false);
    } catch { /* view is going away */ }
  };

  /** Hide every view and forget the rectangle: the next activation always starts from a fresh measurement. */
  const hideAll = () => {
    rectangle = null;
    clipRectangle = null;
    stopFrames();
    for (const tab of tabs.values()) {
      if (!tab.view || tab.destroyed) continue;
      conceal(tab);
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
    attachZoom(contents, { current: () => tab.zoom ?? 1, apply: (factor) => setTabZoom(tab, factor, true) });
    contents.on('will-navigate', (event, target) => {
      try { exports.httpUrl(target); } catch { event.preventDefault(); }
    });
    // Every new top-level document gets the user agent that belongs to its site (see CHROME_UA_SITES).
    contents.on('did-start-navigation', (details) => {
      if (details?.isMainFrame && !details.isSameDocument && details.url) {
        setAgent(contents, details.url);
        // The next page shows the right color before it paints (a dark site does not flash white), and already knows
        // whether the reader prefers dark, so a site's own dark theme is there from its first paint.
        paintViewBackground(tab, details.url);
        let wantedDark = false;
        try { wantedDark = darkStore.wanted(details.url, appDark); } catch { wantedDark = false; }
        void setPrefersDark(tab, wantedDark);
      }
    });
    contents.setWindowOpenHandler(({ url }) => {
      // A sign-in popup (Google, Apple, Microsoft…) often starts at about:blank and is steered by its opener.
      let target = '';
      if (url && url !== 'about:blank') {
        try { target = exports.httpUrl(url); } catch { return { action: 'deny' }; /* Non-web schemes are dropped. */ }
      }
      if (tabs.size >= MAX_TABS) return { action: 'deny' };
      // A page-requested window becomes a workspace tab. The engine creates its contents itself (createWindow), so the
      // popup keeps `window.opener`: "Sign in with Google" and other popup sign-ins post their result back to the page
      // that opened them and close themselves, which a freshly loaded tab without an opener can never do. The page adopts
      // the host tab by its id instead of opening a second view of the same address.
      return {
        action: 'allow',
        outlivesOpener: true,
        createWindow: (options) => {
          // A popup of a muted tab (one the Agent opened) stays as quiet as its opener.
          const created = createTab(target, undefined, options.webContents, { muted: contents.isAudioMuted?.() === true });
          created.openerId = tab.id;
          emit(tab.id, { type: 'newTab', newTabId: created.id, url: target });
          return created.view.webContents;
        },
      };
    });
    contents.on('context-menu', (_event, params) => Menu.buildFromTemplate([
      { role: 'undo', enabled: params.isEditable }, { role: 'redo', enabled: params.isEditable },
      { type: 'separator' }, { role: 'cut', enabled: params.isEditable }, { role: 'copy' },
      { role: 'paste', enabled: params.isEditable }, { role: 'selectAll' },
      { type: 'separator' },
      ...(params.selectionText?.trim() && !params.isEditable
        ? [{ label: '翻译所选文字', click: () => { if (live()) contents.send('mh-browser:translate-selection', { text: params.selectionText, x: params.x, y: params.y }); } }, { type: 'separator' }]
        : []),
      { label: '用系统浏览器打开', click: () => void shell.openExternal(tab.url) },
    ]).popup({ window }));
    // The first real page is the moment the engine's own client-hint list can be read (it needs a secure context).
    contents.on('dom-ready', () => learnClientHints(contents));
    // Each new document starts in its own colors: the engine runs again once its DOM is there.
    contents.on('dom-ready', () => { if (live()) void syncDark(tab); });
    contents.on('did-start-loading', () => {
      if (!live()) return;
      tab.error = '';
      // A new load starts with no known challenge: the page that is gone must not leave its flag behind.
      commit(tab, { loading: true, challenge: false });
      clearTimeout(tab.timer);
      tab.timer = later(tab, () => fail(tab, '加载超时（45 秒）', tab.url), 45000);
    });
    contents.on('did-stop-loading', () => {
      if (!live()) return;
      clearTimeout(tab.timer);
      let challenge = false;
      try { challenge = VERIFY_PAGE.test(contents.getTitle() || ''); } catch { /* view is going away */ }
      commit(tab, { loading: false, challenge });
      later(tab, () => void picture(tab), 300);
      later(tab, () => void pushIcon(tab), 500);
    });
    contents.on('did-navigate', (_event, target) => {
      if (!live()) return;
      // A site opens at the zoom the user chose for it last time.
      setTabZoom(tab, siteZoom.get(target), false);
      tab.dark = false;
      tab.darkEngine = false;
      tab.darkTried = false;
      tab.nativeDark = undefined;
      if (darkStore.wanted(target, appDark)) void dark.putCanvas(contents, darkCanvas());
      passwordManager?.navigated(tab);
      tab.favicon = undefined;
      tab.iconKey = undefined;
      commit(tab, { url: target, error: '' });
    });
    contents.on('page-favicon-updated', (_event, favicons) => { if (live()) tab.favicon = Array.isArray(favicons) ? favicons[0] : undefined; });
    // The tab strip shows a speaker while the page plays sound (or is muted), so the panel hears of every change.
    contents.on('audio-state-changed', () => { if (live()) commit(tab, {}); });
    contents.on('did-navigate-in-page', (_event, target, isMainFrame) => {
      // A frame inside the page (Gmail's side panel, an embedded player) moving within itself is not the tab's address:
      // taking it made the address bar, a bookmark of it and a reload open that bare frame page.
      if (!live() || isMainFrame === false) return;
      // An in-page navigation can resolve (or start) a challenge without a new load: follow the title it leaves behind.
      let challenge = false;
      try { challenge = VERIFY_PAGE.test(contents.getTitle() || ''); } catch { /* view is going away */ }
      commit(tab, { url: target, challenge });
    });
    contents.on('page-title-updated', (_event, title) => {
      // The title is what names a bot check and this event carries it before the load ends, so the flag follows it here
      // instead of being read only at did-stop-loading; a later in-page title change updates it again.
      if (!live()) return;
      commit(tab, { title, challenge: VERIFY_PAGE.test(title || '') });
    });
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

  /**
   * Zoom one tab (1 = 100 %). `remember` keeps the factor for the tab's site: a choice the user made, as opposed to the
   * saved factor being applied when the site opens. The workspace hears the new factor for its toolbar badge.
   */
  const setTabZoom = (tab, factor, remember) => {
    if (tab.destroyed || !tab.view || tab.view.webContents.isDestroyed()) return tab.zoom ?? 1;
    const value = cleanZoom(factor);
    try { tab.view.webContents.setZoomFactor(value); } catch { return tab.zoom ?? 1; }
    tab.zoom = value;
    if (remember) siteZoom.set(tab.url, value);
    emit(tab.id, { type: 'zoom', zoom: value });
    return value;
  };

  const fail = (tab, message, url) => {
    if (tab.destroyed || tabs.get(tab.id) !== tab) return;
    log(message);
    commit(tab, { error: `网页加载失败：${message}`, url: url || tab.url, loading: false });
    emit(tab.id, { type: 'snapshot', snapshot: null });
  };

  /**
   * `adopted` is the contents the engine made for a page's popup (it inherits the opener's preferences, partition and
   * preload). Such a tab is loaded by the engine itself, and closing itself (`window.close()` after a sign-in) closes it.
   */
  const createTab = (initialUrl, forcedId, adopted, options = {}) => {
    if (tabs.size >= MAX_TABS) throw new Error(`最多同时打开 ${MAX_TABS} 个浏览器标签`);
    const id = forcedId && !tabs.has(forcedId) ? String(forcedId) : `tab${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    // The sign-in helper runs in the page's isolated world and only when saved logins are available on this host.
    // It is attached to every tab: besides saved sign-ins it aligns the engine's client hints (see its header).
    const preload = require('node:path').join(__dirname, 'browser-tab-preload.cjs');
    const view = adopted
      ? new WebContentsView({ webContents: adopted })
      : new WebContentsView({ webPreferences: { session: partition, contextIsolation: true, nodeIntegration: false, sandbox: true, preload } });
    const tab = { id, view, url: initialUrl || '', title: '', loading: false, error: '', challenge: false, timer: undefined, pictures: undefined, timers: new Set(), downloads: new Map(), findPending: new Map(), destroyed: false };
    tabs.set(id, tab);
    // A hidden view keeps a real viewport: background tabs lay out, take input and can be captured like the visible one.
    // The size must be set before the view is hidden: Electron does not pass bounds set on a hidden view to its page.
    try { view.setBounds({ x: 0, y: 0, ...backgroundViewport() }); } catch { /* view is going away */ }
    view.setVisible(false);
    paintViewBackground(tab);
    // A tab opened for the Agent plays nothing aloud until the user turns its sound on (the speaker on its tab).
    if (options.muted === true) view.webContents.setAudioMuted(true);
    stage.addChildView(view);
    wire(tab);
    if (adopted) {
      view.webContents.once('destroyed', () => {
        if (tab.destroyed) return;
        tab.selfClosed = true;
        destroyTab(tab);
      });
      return tab;
    }
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
    try { stage.removeChildView(tab.view); } catch { /* already detached */ }
    emit(tab.id, { type: 'closed', tabId: tab.id, ...(tab.selfClosed ? { selfClosed: true, openerId: tab.openerId || null } : {}) });
    placeActive();
  };

  const navigateTab = async (tab, value) => {
    const url = exports.httpUrl(value);
    if (tab.destroyed) throw new Error(`浏览器标签 ${tab.id} 已关闭`);
    commit(tab, { url, error: '', loading: true, challenge: false });
    try {
      await tab.view.webContents.loadURL(url, { userAgent: setAgent(tab.view.webContents, url) });
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

  /**
   * Screenshot of any tab, on screen or not, through the page's own compositor (DevTools protocol), so a background tab
   * is captured without being shown. The picture is scaled to the page's CSS pixels: a point in it is the same point
   * the mouse commands take.
   */
  const snapshot = async (tab) => {
    if (tab.destroyed) throw new Error(`浏览器标签 ${tab.id} 已关闭`);
    keepAwake(tab);
    const viewport = await viewportOf(tab).catch(() => null);
    let buffer;
    try {
      const shot = await withDebugger(tab, (debuggerApi) => withTimeout(debuggerApi.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true }), 15000, '页面没有在 15 秒内完成截图'));
      buffer = Buffer.from(String(shot?.data || ''), 'base64');
    } catch (error) {
      // A page whose debugger is taken (its own DevTools open) can still be captured while it is on screen.
      if (!tab.view.getVisible()) throw error;
      buffer = (await contentsOf(tab).capturePage()).toPNG();
    }
    if (!buffer.length) throw new Error('截图没有返回图像');
    let image = nativeImage?.createFromBuffer ? nativeImage.createFromBuffer(buffer) : undefined;
    if (image && !image.isEmpty() && viewport?.width > 0 && viewport?.height > 0) {
      const size = image.getSize();
      if (size.width !== viewport.width || size.height !== viewport.height) {
        image = image.resize({ width: Math.round(viewport.width), height: Math.round(viewport.height), quality: 'best' });
        buffer = image.toPNG();
      }
    }
    const size = image && !image.isEmpty() ? image.getSize() : viewport || { width: 0, height: 0 };
    return { snapshot: `data:image/png;base64,${buffer.toString('base64')}`, width: size.width, height: size.height };
  };

  const withTimeout = (promise, ms, message) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });

  // ---- The Agent's own mouse and keyboard ------------------------------------------------------------------------
  // Real input events through the DevTools protocol: the page receives trusted pointer, mouse, wheel and key events at a
  // CSS-pixel point of its viewport, exactly as from a person, whether the tab is on screen or in the background. Nothing
  // needs a selector or an index, so images, canvases and custom controls can be clicked like anything else.
  const MODIFIER_BITS = { alt: 1, control: 2, ctrl: 2, meta: 4, command: 4, shift: 8 };
  const modifierBits = (list) => (Array.isArray(list) ? list : []).reduce((bits, name) => bits | (MODIFIER_BITS[String(name).toLowerCase()] || 0), 0);
  const BUTTON_BITS = { left: 1, right: 2, middle: 4 };

  const viewportOf = (tab) => runInPage(tab, '({ width: innerWidth, height: innerHeight })');

  /** Keep a tab's page running at full speed for a while, so a background tab takes the Agent's input and paints. */
  const keepAwake = (tab) => {
    const contents = contentsOf(tab);
    tab.agentInputAt = Date.now();
    if (!tab.awake) {
      try { contents.setBackgroundThrottling(false); } catch { /* older engine: input may wait for the tab to show */ }
      tab.awake = true;
    }
    clearTimeout(tab.awakeTimer);
    tab.awakeTimer = later(tab, () => {
      tab.awake = false;
      try { contentsOf(tab).setBackgroundThrottling(true); } catch { /* view is going away */ }
    }, AGENT_AWAKE_MS);
  };

  /** What sits at a point of the page: enough for the Agent to know what it is about to click. */
  const describePoint = (tab, x, y) => runInPage(tab, `(() => {
    // The innermost element, inside open shadow roots too (web components would otherwise report only their host).
    let element = document.elementFromPoint(${x}, ${y});
    while (element && element.shadowRoot) { const inner = element.shadowRoot.elementFromPoint(${x}, ${y}); if (!inner || inner === element) break; element = inner; }
    if (!element) return null;
    const clickable = 'a,button,input,select,textarea,label,[role],[onclick],[tabindex]';
    const pressable = element.closest(clickable);
    const target = pressable || element;
    const textOf = (node) => (node.getAttribute('aria-label') || node.getAttribute('alt') || node.getAttribute('title') || node.innerText || node.value || node.getAttribute('placeholder') || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
    const text = textOf(target);
    // The point fell on a plain container (often the gap between two links): name the control right next to it and its
    // centre, so a near miss is visible in the result instead of looking like a click that did nothing.
    let nearest;
    if (!pressable) {
      let best = Infinity;
      for (const node of document.querySelectorAll('a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[onclick]')) {
        const r = node.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        const dx = Math.max(r.left - ${x}, 0, ${x} - r.right);
        const dy = Math.max(r.top - ${y}, 0, ${y} - r.bottom);
        const distance = Math.hypot(dx, dy);
        if (distance <= 24 && distance < best) {
          best = distance;
          nearest = { tag: node.tagName.toLowerCase(), text: textOf(node) || undefined, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), distance: Math.round(distance) };
        }
      }
    }
    return { tag: target.tagName.toLowerCase(), id: target.id || undefined, role: target.getAttribute('role') || undefined, type: target.getAttribute('type') || undefined, href: target.getAttribute('href') || undefined, src: target.getAttribute('src') ? String(target.getAttribute('src')).slice(0, 200) : undefined, text: text || undefined, editable: !!(target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)), ...(nearest ? { missed: true, nearest } : {}) };
  })()`).catch(() => null);

  /** Draw (or move) the Agent's pointer at a point, so the user sees where it acts; it fades after a short pause. */
  const showCursor = (tab, x, y, pressed) => {
    const code = `(() => {
      const host = document.documentElement;
      if (!host) return;
      let el = window.__myharnessCursor;
      if (!el) {
        el = document.createElement('myharness-agent-cursor');
        const root = el.attachShadow({ mode: 'closed' });
        root.innerHTML = '<style>:host{all:initial;position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transition:transform .18s cubic-bezier(.2,0,0,1),opacity .4s;opacity:1}svg{display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))}.ring{position:absolute;left:-9px;top:-9px;width:18px;height:18px;border-radius:50%;border:2px solid #4f8cff;opacity:0;transform:scale(.4)}.ring.on{animation:p .45s ease-out}@keyframes p{0%{opacity:.9;transform:scale(.4)}100%{opacity:0;transform:scale(1.6)}}</style><div class=ring></div><svg width="22" height="22" viewBox="0 0 24 24"><path d="M4 2l16 9.5-7 1.6-3.6 6.9z" fill="#4f8cff" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
        el.__ring = root.querySelector('.ring');
        window.__myharnessCursor = el;
      }
      if (el.parentNode !== host) host.appendChild(el);
      el.style.opacity = '1';
      el.style.transform = 'translate(${x}px, ${y}px)';
      if (${pressed ? 'true' : 'false'}) { el.__ring.classList.remove('on'); void el.__ring.offsetWidth; el.__ring.classList.add('on'); }
      clearTimeout(el.__fade);
      el.__fade = setTimeout(() => { el.style.opacity = '0'; }, 2500);
    })()`;
    try { void contentsOf(tab).executeJavaScriptInIsolatedWorld(CURSOR_WORLD, [{ code }]).catch(() => undefined); } catch { /* page is going away */ }
  };

  /**
   * Move the pointer to a point and wait until the page has seen it. A page that has just loaded (or a tab that has not
   * painted yet) drops input until its first frame, so a click sent at once would vanish without an error; the move is
   * repeated, about every 80 ms for up to 2 s, until a mousemove arrives, and only then may the caller press.
   */
  const moveUntilSeen = async (tab, send, x, y) => {
    const isolated = (code) => contentsOf(tab).executeJavaScriptInIsolatedWorld(CURSOR_WORLD, [{ code }]).catch(() => undefined);
    const before = Number(await isolated(`(() => { if (!window.__myharnessMoves) { window.__myharnessMoves = { n: 0 }; addEventListener('mousemove', () => { window.__myharnessMoves.n++; }, true); } return window.__myharnessMoves.n; })()`));
    const deadline = Date.now() + 2000;
    for (let attempt = 0; ; attempt++) {
      // A repeated move to the very same point may be coalesced away; the retries wiggle by one pixel and come back.
      if (attempt > 0 && attempt % 2 === 1) await send({ type: 'mouseMoved', x: x > 0 ? x - 1 : x + 1, y, button: 'none', buttons: 0 });
      await send({ type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
      if (!Number.isFinite(before)) return;
      const seen = Number(await isolated('window.__myharnessMoves ? window.__myharnessMoves.n : 0'));
      if (seen > before || Date.now() > deadline) return;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  };

  const mouse = async (tab, value) => {
    const kind = String(value.kind || 'click');
    keepAwake(tab);
    const downloadsBefore = downloadSeq;
    let x = Number(value.x);
    let y = Number(value.y);
    // No point given: aim at an element (selector, index or visible label) like the click command does.
    if ((!Number.isFinite(x) || !Number.isFinite(y)) && hasTarget(value)) ({ x, y } = await requireTarget(tab, value, 'mouse'));
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('mouse 需要 x 与 y（页面 CSS 像素坐标），或 selector、index、label');
    const viewport = await viewportOf(tab);
    const inside = (px, py) => px >= 0 && py >= 0 && px < viewport.width && py < viewport.height;
    if (!inside(x, y)) throw new Error(`坐标 (${x}, ${y}) 在页面可视区域 ${viewport.width}×${viewport.height} 之外；先滚动页面或重新截图`);
    const toX = Number(value.toX);
    const toY = Number(value.toY);
    if (kind === 'drag' && (!Number.isFinite(toX) || !Number.isFinite(toY) || !inside(toX, toY))) throw new Error(`drag 需要可视区域 ${viewport.width}×${viewport.height} 内的 toX 与 toY`);
    const button = ['left', 'right', 'middle'].includes(value.button) ? value.button : kind === 'right_click' ? 'right' : 'left';
    const modifiers = modifierBits(value.modifiers);
    const target = kind === 'move' || kind === 'wheel' || kind === 'up' ? undefined : await describePoint(tab, x, y);
    await withDebugger(tab, async (debuggerApi) => {
      const send = (params) => {
        tab.agentInputAt = Date.now();
        return debuggerApi.sendCommand('Input.dispatchMouseEvent', { modifiers, pointerType: 'mouse', ...params });
      };
      const press = async (px, py, clickCount) => {
        await send({ type: 'mousePressed', x: px, y: py, button, buttons: BUTTON_BITS[button], clickCount });
        await send({ type: 'mouseReleased', x: px, y: py, button, buttons: 0, clickCount });
      };
      if (kind !== 'up') await moveUntilSeen(tab, send, x, y);
      if (kind === 'click' || kind === 'right_click') await press(x, y, 1);
      else if (kind === 'double_click') { await press(x, y, 1); await press(x, y, 2); }
      else if (kind === 'down') await send({ type: 'mousePressed', x, y, button, buttons: BUTTON_BITS[button], clickCount: 1 });
      else if (kind === 'up') await send({ type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 });
      else if (kind === 'drag') {
        await send({ type: 'mousePressed', x, y, button, buttons: BUTTON_BITS[button], clickCount: 1 });
        const steps = Math.max(4, Math.min(24, Math.round(Math.hypot(toX - x, toY - y) / 24)));
        for (let step = 1; step <= steps; step++) {
          await send({ type: 'mouseMoved', x: x + ((toX - x) * step) / steps, y: y + ((toY - y) * step) / steps, button, buttons: BUTTON_BITS[button] });
        }
        await send({ type: 'mouseReleased', x: toX, y: toY, button, buttons: 0, clickCount: 1 });
      } else if (kind === 'wheel') {
        await send({ type: 'mouseWheel', x, y, button: 'none', buttons: 0, deltaX: Number(value.deltaX) || 0, deltaY: Number(value.deltaY) || 0 });
      } else if (kind !== 'move') throw new Error(`未知的鼠标操作：${kind}`);
    });
    const endX = kind === 'drag' ? toX : x;
    const endY = kind === 'drag' ? toY : y;
    showCursor(tab, endX, endY, kind !== 'move' && kind !== 'wheel');
    // A click may start a download: report it (and wait for it) right here, so the Agent learns where the file went
    // without searching for it. A control that names a download or a file is given longer to start one.
    let downloads = [];
    if (kind === 'click' || kind === 'double_click' || kind === 'up') {
      const looksLikeFile = DOWNLOAD_HINT.test(`${target?.text || ''} ${target?.href || ''}`);
      downloads = await awaitDownloads(tab, downloadsBefore, looksLikeFile ? 6000 : 400, 30000);
    }
    return { ok: true, kind, x, y, ...(kind === 'drag' ? { toX, toY } : {}), viewport, target: target || undefined, ...(downloads.length ? { downloads } : {}) };
  };

  /**
   * Downloads the tab started after download number `since`: waits up to `startMs` for the first one to begin, then up
   * to `doneMs` for all of them to finish. Each entry says where the file is (or why it did not arrive).
   */
  const awaitDownloads = async (tab, since, startMs, doneMs) => {
    const mine = () => [
      ...downloadLog.filter((record) => record.tabId === tab.id && record.seq > since),
      ...[...tab.downloads.values()].map((entry) => entry.record).filter((record) => record.seq > since),
    ];
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const startBy = Date.now() + startMs;
    while (!mine().length && Date.now() < startBy && !tab.destroyed) await sleep(100);
    const doneBy = Date.now() + doneMs;
    while (mine().some((record) => tab.downloads.has(record.id)) && Date.now() < doneBy && !tab.destroyed) await sleep(150);
    return mine().map((record) => ({ ...record, state: tab.downloads.has(record.id) ? 'progressing' : record.state }));
  };

  const focusedElement = (tab) => runInPage(tab, page.inPage(page.pageFocused)).catch(() => null);

  /** Press keys ("Enter", "Control+A", "Shift+Tab") in the tab's focused element, `repeat` times. */
  const pressKeys = async (tab, value) => {
    const list = Array.isArray(value.keys) ? value.keys.map(String) : String(value.keys || '').split(/\s+/).filter(Boolean);
    if (!list.length) throw new Error('keys 需要按键，例如 "Enter" 或 "Control+A"');
    const repeat = Math.max(1, Math.min(50, Number.isInteger(value.repeat) ? value.repeat : 1));
    const events = list.map((combo) => keyEvents(combo));
    keepAwake(tab);
    await withDebugger(tab, async (debuggerApi) => {
      for (let round = 0; round < repeat; round++) {
        for (const sequence of events) for (const event of sequence) { tab.agentInputAt = Date.now(); await debuggerApi.sendCommand('Input.dispatchKeyEvent', event); }
      }
    });
    return { ok: true, keys: list, repeat, focused: await focusedElement(tab) };
  };

  /** Type text into whatever has the keyboard focus, as an input method would (any language, no per-key mapping). */
  /**
   * Type into whatever has the keyboard focus. `replace` first selects what a form field holds (and a rich editor's
   * content only when `replace` is exactly true), so the text replaces it instead of being appended.
   */
  const insertText = async (tab, text, options = {}) => {
    keepAwake(tab);
    if (options.replace) await runInPage(tab, page.inPage(page.pageSelectFocused, { richToo: options.replace === true }));
    await withDebugger(tab, async (debuggerApi) => {
      if (text) await debuggerApi.sendCommand('Input.insertText', { text });
      else if (options.replace) for (const event of keyEvents('Delete')) await debuggerApi.sendCommand('Input.dispatchKeyEvent', event);
    });
    return { ok: true, focused: await focusedElement(tab) };
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
        ? `(${page.pageHelpers})(${JSON.stringify(INTERACTIVE_QUERY)}).all(${JSON.stringify(INTERACTIVE_QUERY)})[${index}]`
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

  /**
   * Find one element the way a person would point at it: by the index from `interactive`, a CSS selector, or its visible
   * text / accessible name (`label`: exact, then the same letters and digits, then prefix, then substring; visible
   * elements only, open shadow roots included; plain text that is not inside a control counts too, so a clickable <div>
   * is found by its words). The element is scrolled to the middle of the viewport (unless `scroll: false`) and its centre
   * is returned, with what covers that point if it is not the element itself. A label that matches nothing answers with
   * the closest visible texts. The element stays reachable for the follow-up step as a hidden page property.
   */
  const locate = (tab, target) => runInPage(tab, page.inPage(page.pageLocate, { selector: target.selector || undefined, index: Number.isInteger(target.index) ? target.index : undefined, label: target.label || undefined, scroll: target.scroll }));

  const hasTarget = (value) => Number.isInteger(value.index) || (typeof value.selector === 'string' && !!value.selector) || (typeof value.label === 'string' && !!value.label.trim());
  const requireTarget = async (tab, value, verb) => {
    if (!hasTarget(value)) throw new Error(`${verb} 需要 selector、index 或 label`);
    const found = await locate(tab, value);
    if (!found?.ok) throw new Error(found?.error || '页面没有返回元素位置');
    return found;
  };

  /**
   * Click an element with the Agent's real mouse at its centre, as a person would, so pages that listen for pointer
   * events (menus, React/Vue controls, canvases inside buttons) react. When something else covers that point, or the
   * element has no box on screen, the element's own click() is used instead and the answer says why.
   */
  const click = async (tab, value) => {
    const found = await requireTarget(tab, value, 'click');
    const base = { ok: true, tag: found.tag, text: found.text || '', x: found.x, y: found.y };
    if (found.inView && !found.covered) {
      const pressed = await mouse(tab, { kind: value.double ? 'double_click' : 'click', x: found.x, y: found.y, button: value.button, modifiers: value.modifiers });
      return { ...base, how: 'mouse', ...(pressed.downloads ? { downloads: pressed.downloads } : {}) };
    }
    await runInPage(tab, 'window.__myharnessTarget && window.__myharnessTarget.click()');
    return { ...base, how: 'script', ...(found.covered ? { covered: found.covered } : { offscreen: true }) };
  };

  /**
   * Type into an element the way a person does: click it (or focus it when it cannot be clicked), select what is in it
   * unless `replace` is false, and enter the text through the input method, so every key/input/beforeinput handler
   * runs. A <select> gets the option whose value or label matches. When the page refused the typed text (masked or
   * framework-controlled fields), the value is set directly as a last resort. `enter` presses Enter afterwards.
   */
  const typeText = async (tab, value) => {
    const text = String(value.text ?? '');
    const found = await requireTarget(tab, value, 'type');
    if (found.disabled) throw new Error(`目标元素已禁用：${found.tag}${found.text ? ` "${found.text}"` : ''}`);
    if (found.select) {
      const chosen = await runInPage(tab, `((want) => {
        const el = window.__myharnessTarget; const w = want.trim().toLowerCase();
        const option = Array.from(el.options).find((o) => o.value.toLowerCase() === w || o.label.trim().toLowerCase() === w) || Array.from(el.options).find((o) => o.label.trim().toLowerCase().includes(w));
        if (!option) return { ok: false, error: 'no option matches ' + JSON.stringify(want) + '; options: ' + Array.from(el.options).map((o) => o.label.trim()).slice(0, 30).join(' | ') };
        el.value = option.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, tag: 'select', value: option.label.trim(), how: 'select' };
      })(${JSON.stringify(text)})`);
      if (!chosen?.ok) throw new Error(chosen?.error || '无法选择选项');
      return chosen;
    }
    if (found.inView && !found.covered) await mouse(tab, { kind: 'click', x: found.x, y: found.y });
    const replace = value.replace !== false;
    await runInPage(tab, `(() => {
      const el = window.__myharnessTarget; if (!el) return;
      if (document.activeElement !== el && !el.contains(document.activeElement)) el.focus();
      if (${replace}) {
        if (typeof el.select === 'function' && /^(INPUT|TEXTAREA)$/.test(el.tagName)) el.select();
        else if (el.isContentEditable) { const range = document.createRange(); range.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }
      } else if (/^(INPUT|TEXTAREA)$/.test(el.tagName) && typeof el.setSelectionRange === 'function') { try { const end = el.value.length; el.setSelectionRange(end, end); } catch {} }
    })()`);
    keepAwake(tab);
    await withDebugger(tab, async (debuggerApi) => {
      if (text) await debuggerApi.sendCommand('Input.insertText', { text });
      else if (replace) for (const event of keyEvents('Delete')) await debuggerApi.sendCommand('Input.dispatchKeyEvent', event);
    });
    const valueOf = 'String(window.__myharnessTarget ? (window.__myharnessTarget.value ?? window.__myharnessTarget.innerText ?? "") : "")';
    let how = 'keyboard';
    let now = String((await runInPage(tab, valueOf)) ?? '');
    if (text && !now.includes(text) && found.editable) {
      // The page dropped the typed text; set the value itself and announce it like an edit.
      await runInPage(tab, `((text) => {
        const el = window.__myharnessTarget;
        if (el.isContentEditable) el.textContent = text;
        else { const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${replace} ? text : el.value + text); }
        el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      })(${JSON.stringify(text)})`);
      now = String((await runInPage(tab, valueOf)) ?? '');
      how = 'script';
    }
    if (value.enter === true) await pressKeys(tab, { keys: 'Enter' });
    return { ok: true, tag: found.tag, value: now.slice(0, 200), how };
  };

  /**
   * Wait until the page shows (or, with `gone`, no longer shows) a CSS selector, a visible text or a labelled element;
   * without any of them, until the page has loaded and its network has been quiet for half a second. Never throws on a
   * timeout: the answer says it timed out, so the caller decides.
   */
  const waitFor = async (tab, value) => {
    const timeout = Math.max(200, Math.min(60000, Number(value.timeoutMs) || 10000));
    const started = Date.now();
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const gone = value.gone === true;
    const query = { selector: value.selector || undefined, text: value.text || undefined, label: value.label || undefined };
    const condition = query.selector || query.text || query.label;
    keepAwake(tab);
    while (Date.now() - started < timeout && !tab.destroyed) {
      if (condition) {
        const present = await runInPage(tab, page.inPage(page.pageWaitCondition, query)).catch(() => null);
        // An invalid selector never becomes valid by waiting.
        if (present && present.ok === false) throw new Error(present.error);
        if (present !== null && !!present !== gone) return { ok: true, waitedMs: Date.now() - started, url: tab.url };
      } else {
        const last = networkLog.reduce((latest, entry) => (entry.tabId === tab.id && entry.at > latest ? entry.at : latest), 0);
        if (!tab.loading && Date.now() - last >= 500) return { ok: true, waitedMs: Date.now() - started, url: tab.url };
      }
      await sleep(150);
    }
    return { ok: false, timeout: true, waitedMs: Date.now() - started, url: tab.url };
  };

  /**
   * The Agent's own script in the page, through the DevTools protocol: the result of its last expression (top-level
   * await allowed), and when it throws, the page's real error message instead of the engine's generic "Script failed".
   */
  const evaluateScript = (tab, code) => withDebugger(tab, async (debuggerApi) => {
    const group = 'myharness-exec';
    const failed = (answer) => {
      const details = answer?.exceptionDetails;
      if (details) throw new Error(`页面脚本出错：${details.exception?.description || details.exception?.value || details.text || '未知错误'}`);
      return answer?.result;
    };
    try {
      let result = failed(await debuggerApi.sendCommand('Runtime.evaluate', { expression: code, objectGroup: group, awaitPromise: true, userGesture: true, replMode: true }));
      // A script whose value is a promise is answered with what the promise resolves to, as executeJavaScript did.
      if (result?.subtype === 'promise' && result.objectId) result = failed(await debuggerApi.sendCommand('Runtime.awaitPromise', { promiseObjectId: result.objectId, returnByValue: true }));
      else if (result?.objectId) result = failed(await debuggerApi.sendCommand('Runtime.callFunctionOn', { objectId: result.objectId, functionDeclaration: 'function () { return this; }', returnByValue: true }));
      return result?.value ?? null;
    } finally {
      await debuggerApi.sendCommand('Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => undefined);
    }
  });

  /**
   * Scroll the way a person does, where the content is. Without an amount and with an element: bring the element to the
   * middle of the view. With `deltaY`/`deltaX` (px, or 'page' for most of the area's height): scroll the area under the
   * point `atX`/`atY`, the area holding the element, or the page's main scrolling area (apps such as Teams or Gmail
   * scroll an inner list, not the document). An area that scrolls only through wheel handlers gets a real wheel at its
   * centre. With `until`: keep scrolling (at most `maxSteps`) until those words are on screen, and answer where they are.
   */
  const scrollTab = async (tab, value) => {
    keepAwake(tab);
    const until = typeof value.until === 'string' ? value.until.trim() : '';
    const amountOf = (field) => (value[field] === 'page' ? 'page' : Number.isFinite(Number(value[field])) ? Number(value[field]) : 0);
    let dx = amountOf('deltaX');
    let dy = amountOf('deltaY');
    const point = value.atX !== undefined && value.atY !== undefined && Number.isFinite(Number(value.atX)) && Number.isFinite(Number(value.atY)) ? { x: Number(value.atX), y: Number(value.atY) } : undefined;
    let located;
    if (hasTarget(value)) {
      located = await requireTarget(tab, { ...value, scroll: !(dx || dy || until) }, 'scroll');
      // Bringing an element into view is the whole request when no amount and no words are given.
      if (!dx && !dy && !until) return { ok: true, element: located };
    }
    if (!dx && !dy) {
      // The older form: x/y are the amounts to scroll by.
      dx = Number(value.x) || 0;
      dy = Number(value.y) || 0;
      if (!dx && !dy) dy = 'page';
    }
    const query = { dx, dy, point, target: !!located };
    const sign = (amount) => (amount === 'page' ? 1 : Math.sign(amount));
    // Measures the same area again without moving it, judging "the end" in the direction asked for.
    const measure = () => runInPage(tab, page.inPage(page.pageScroll, { ...query, dx: 0, dy: 0, dirX: sign(dx), dirY: sign(dy) }));
    const once = async () => {
      const result = await runInPage(tab, page.inPage(page.pageScroll, query));
      if (!result || result.ok === false) throw new Error(result?.error || '页面没有返回滚动结果');
      if (result.moved || result.atEnd) return { ...result, how: 'script' };
      // Nothing moved by script: the area scrolls through its own wheel handlers (or is not a scroll area at all). A
      // real wheel at its centre, then the visible text tells whether anything changed.
      const pixels = (amount) => (amount === 'page' ? 600 : amount);
      await mouse(tab, { kind: 'wheel', x: result.x, y: result.y, deltaX: pixels(dx), deltaY: pixels(dy) });
      await new Promise((resolve) => setTimeout(resolve, 250));
      const after = await measure();
      return { ...result, how: 'wheel', changed: !!after && after.text !== result.text };
    };
    if (!until) {
      const { text, ...rest } = await once();
      return rest;
    }
    const maxSteps = Math.max(1, Math.min(60, Number.isInteger(Number(value.maxSteps)) ? Number(value.maxSteps) : 20));
    let last;
    for (let step = 0; step <= maxSteps; step++) {
      const hit = await runInPage(tab, page.inPage(page.pageTextOnScreen, { text: until }));
      if (hit && hit.ok !== false) return { ok: true, found: hit, steps: step, ...(last ? { container: last.container } : {}) };
      if (step === maxSteps) break;
      last = await once();
      // A list that renders more rows when it reaches its end grows a moment later: only an end that stays an end
      // (or a wheel that changed nothing) means scrolling further cannot reveal anything new.
      if (last.atEnd && !(last.how === 'wheel' && !last.changed)) {
        for (let waited = 0; waited < 1500 && last.atEnd; waited += 250) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          const again = await measure();
          if (again && again.ok !== false && !again.atEnd) last = { ...last, atEnd: false };
        }
      }
      if (last.atEnd || (last.how === 'wheel' && !last.changed)) {
        const final = await runInPage(tab, page.inPage(page.pageTextOnScreen, { text: until }));
        if (final && final.ok !== false) return { ok: true, found: final, steps: step + 1, container: last.container };
        return { ok: true, found: null, steps: step + 1, atEnd: true, container: last.container };
      }
      // Lists that render rows as they come into view need a moment before the new rows can be read.
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return { ok: true, found: null, steps: maxSteps, atEnd: false, ...(last ? { container: last.container } : {}) };
  };

  const interactive = async (tab) => {
    const list = await runInPage(tab, page.inPage(page.pageInteractive));
    if (list && list.ok === false) throw new Error(list.error);
    return list;
  };

  const bounded = (number, low, high, fallback) => (Number.isFinite(Number(number)) ? Math.max(low, Math.min(high, Math.round(Number(number)))) : fallback);
  /** What a `read` / `readUrl` command asks pageRead for, within bounds. */
  const readOptions = (value) => ({
    selector: typeof value.selector === 'string' && value.selector ? value.selector : undefined,
    scroll: value.scroll === true,
    restore: value.restore === true,
    maxScrolls: bounded(value.maxScrolls, 1, 80, 20),
    settleMs: bounded(value.settleMs, 100, 3000, 600),
    maxChars: bounded(value.maxChars, 200, 200000, 40000),
    links: value.links === true,
    maxLinks: bounded(value.maxLinks, 1, 2000, 300),
    tables: value.tables === true,
    maxTables: bounded(value.maxTables, 1, 20, 5),
    maxRows: bounded(value.maxRows, 1, 500, 100),
  });

  /** Reader pages open at once (readAddress); more wait for a free one. */
  const READERS_MAX = 6;
  let readersOpen = 0;
  const readerQueue = [];
  /**
   * Read an address in a reader page of its own: an off-screen rendering page in the tabs' session (the user's
   * sign-ins), muted, without dialogs or popups, never part of the workspace, closed when the reading is done. Unlike a
   * hidden tab it draws frames, so a page that loads while it scrolls (scroll handlers, IntersectionObserver, lazy
   * images) behaves as it does on screen. A load that takes longer than `timeoutMs` is read as far as it got.
   */
  const readAddress = async (value) => {
    const url = exports.httpUrl(value.url);
    if (readersOpen >= READERS_MAX) await new Promise((resolve) => readerQueue.push(resolve));
    readersOpen++;
    const reader = new BrowserWindow({
      show: false,
      width: AGENT_VIEWPORT.width,
      height: AGENT_VIEWPORT.height,
      webPreferences: { offscreen: true, session: partition, sandbox: true, contextIsolation: true, nodeIntegration: false, disableDialogs: true, backgroundThrottling: false },
    });
    const contents = reader.webContents;
    try {
      contents.setAudioMuted(true);
      contents.setFrameRate(15);
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
      contents.on('will-navigate', (event, target) => { try { exports.httpUrl(target); } catch { event.preventDefault(); } });
      const timeoutMs = bounded(value.timeoutMs, 3000, 60000, 25000);
      let timer;
      const loaded = contents.loadURL(url, { userAgent: setAgent(contents, url) }).catch((error) => {
        // A page that sends itself elsewhere aborts the first load; the page it went to is what gets read.
        if (!/ERR_ABORTED|\(-3\)/.test(String(error?.message))) throw error;
      });
      await Promise.race([loaded, new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); })]).finally(() => clearTimeout(timer));
      await new Promise((resolve) => setTimeout(resolve, bounded(value.settleMs, 100, 3000, 600)));
      const reading = await contents.executeJavaScript(page.inPage(page.pageRead, readOptions(value)), true);
      return reading && typeof reading === 'object' ? reading : { ok: false, error: '阅读页没有返回内容' };
    } finally {
      // The page closes before its window: an off-screen page whose window is already gone crashes Electron's
      // webContents.getFocusedWebContents() (used by menu roles such as Copy) until the page itself is destroyed.
      if (!contents.isDestroyed()) {
        const gone = new Promise((resolve) => { contents.once('destroyed', resolve); setTimeout(resolve, 2000); });
        try { contents.close(); } catch { /* already closing */ }
        await gone;
      }
      try { if (!reader.isDestroyed()) reader.destroy(); } catch { /* already gone */ }
      readersOpen--;
      readerQueue.shift()?.();
    }
  };

  /**
   * One browser command. `context.agent` marks a command from the Agent's workspace tool: before it reads or acts on a
   * tab, that tab is kept awake (a background tab would otherwise ignore its input).
   */
  const command = async (input, context = {}) => {
    const value = input && typeof input === 'object' ? input : {};
    const action = String(value.action || '');
    if (context.agent === true && AGENT_TAB_ACTIONS.has(action)) {
      const tab = tabs.get(value.tabId || activeTabId || DEFAULT_TAB);
      if (tab && !tab.destroyed) keepAwake(tab);
    }
    switch (action) {
      case 'open': {
        // The page owns the tab id (`browser:<url>`); the host view is created under that id so both sides agree, and a
        // later `ensure` from the panel finds the same tab instead of opening another one.
        const existing = value.tabId ? tabs.get(value.tabId) : undefined;
        const target = existing || createTab(value.url ? exports.httpUrl(value.url) : '', value.tabId, undefined, { muted: value.muted === true });
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
        const created = createTab(exports.httpUrl(value.url), value.tabId, undefined, { muted: value.muted === true });
        // A tab the Agent opens to work in loads at full speed even though nobody looks at it.
        if (context.agent === true) keepAwake(created);
        return { ...stateOf(created), created: true };
      }
      case 'activate': {
        const target = requireTab(value.tabId);
        activeTabId = target.id;
        // Never reuse the previous tab's or the previous activation's rectangle: the page measures and sends a fresh one.
        rectangle = cleanRect(value.rect);
        clipRectangle = null;
        stopFrames();
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
        const next = cleanRect(value.rect);
        const order = ++boundsOrder;
        // Hiding the view that is on screen (a menu or dialog of the page now lies over it): take its picture first, so the
        // page shows the site as it was instead of an empty panel. The capture is short; a slow one does not hold it up.
        const active = tabs.get(activeTabId);
        if (!next && rectangle && active?.view?.getVisible?.()) {
          await Promise.race([picture(active).catch(() => undefined), new Promise((done) => setTimeout(done, 250))]);
          if (order !== boundsOrder) return { ok: true, superseded: true };
        }
        rectangle = next;
        // `clip`: the part of the box the page leaves uncovered. `live`: the view is hidden for an animation over its
        // place, and the page shows moving frames of it there until the next rectangle.
        clipRectangle = next ? cleanRect(value.clip) : null;
        placeActive();
        if (!next && value.live === true) startFrames(tabs.get(activeTabId));
        else stopFrames();
        return { ok: true, visible: !!rectangle };
      }
      case 'hide': {
        hideAll();
        return { ok: true };
      }
      case 'permission': {
        if (typeof value.requestId !== 'string' || !value.requestId) throw new Error('permission 需要 requestId');
        return settlePermission(value.requestId, value.allow === true, { by: value.by });
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
      case 'mute': {
        // The speaker on a website tab (or the Agent): sound on or off for this tab only.
        const target = requireTab(value.tabId);
        contentsOf(target).setAudioMuted(value.muted === true);
        commit(target, {});
        return stateOf(target);
      }
      case 'darkMode': {
        // From the app page: whether it is dark and its colors (for "auto"), and/or a new general `mode`.
        if (typeof value.appDark === 'boolean') appDark = value.appDark;
        if (value.colors && typeof value.colors === 'object') appColors = { background: value.colors.background, text: value.colors.text };
        if (value.mode !== undefined) darkStore.setMode(value.mode);
        for (const tab of tabs.values()) paintViewBackground(tab);
        syncDarkAll();
        return { ok: true, ...darkStore.get(), appDark };
      }
      case 'language': {
        // The browser's language for every site. The active tab loads again so its site answers in that language at
        // once; other tabs follow on their next page.
        const before = siteLanguage.get();
        const language = siteLanguage.set(typeof value.language === 'string' ? value.language : '');
        const active = tabs.get(activeTabId);
        if (language !== before && active?.view && !active.view.webContents.isDestroyed() && active.url) active.view.webContents.reload();
        for (const tab of tabs.values()) emit(tab.id, { type: 'language', language });
        return { ok: true, language };
      }
      case 'darkSite': {
        // This tab's site the other way from the general mode ("on" / "off"), or back to following it (null).
        const target = requireTab(value.tabId);
        darkStore.setSite(target.url, value.value === 'on' || value.value === 'off' ? value.value : undefined);
        await syncDark(target);
        for (const other of tabs.values()) if (other !== target && darkStore.hostOf(other.url) === darkStore.hostOf(target.url)) void syncDark(other);
        return { ok: true, ...darkState(target) };
      }
      case 'zoom': {
        // `direction` 1 / -1 / 0 (in, out, 100 %) or an exact `factor`; the result is remembered for the site.
        const target = requireTab(value.tabId);
        const factor = Number.isFinite(Number(value.factor)) ? Number(value.factor) : stepZoom(target.zoom ?? 1, Math.sign(Number(value.direction) || 0));
        return { ok: true, zoom: setTabZoom(target, factor, true) };
      }
      case 'find': {
        if (typeof value.text !== 'string') throw new Error('find 需要 text 字符串');
        if (value.text.length > 500) throw new Error('find 的文本超过 500 个字符');
        const tab = requireTab(value.tabId);
        if (context.agent === true) {
          // The Agent only needs where the words are. The engine's own find would focus the page (taking the keyboard
          // from whatever the user is typing in) and highlight matches on a page the user may be reading.
          const hits = await runInPage(tab, page.inPage(page.pageFindText, { text: value.text, limit: 200, matchCase: value.matchCase === true })).catch(() => null);
          const list = Array.isArray(hits) ? hits : [];
          return { ok: true, text: value.text, matches: list.length, activeMatch: list.length ? 1 : 0, ...(list.length >= 200 ? { more: true } : {}), elements: list.slice(0, 10) };
        }
        const result = await findInTab(tab, value.text, {
          forward: value.forward !== false,
          findNext: value.findNext === true,
          matchCase: value.matchCase === true,
        });
        // The engine's find counts matches and highlights one; the elements that hold the words (with their centres,
        // on-screen first, open shadow roots included) are what the Agent can click or scroll to.
        const elements = await runInPage(tab, page.inPage(page.pageFindText, { text: value.text, limit: 10, matchCase: value.matchCase === true })).catch(() => null);
        return { ok: true, text: value.text, ...result, elements: Array.isArray(elements) ? elements : [] };
      }
      case 'stopFind':
        return stopFind(requireTab(value.tabId));
      case 'snapshot':
        return snapshot(requireTab(value.tabId));
      case 'mouse':
        return mouse(requireTab(value.tabId), value);
      case 'keys':
        return pressKeys(requireTab(value.tabId), value);
      case 'insertText': {
        if (typeof value.text !== 'string') throw new Error('insertText 需要 text 字符串');
        if (value.text.length > 20000) throw new Error('insertText 的文本超过 20000 个字符');
        return insertText(requireTab(value.tabId), value.text, { replace: value.replace === true ? true : value.replace === 'fields' ? 'fields' : false });
      }
      case 'login': {
        // Signing in with a saved login: the host fills and submits it in the page; no password reaches the caller.
        const tab = requireTab(value.tabId);
        const origin = safeOrigin(tab.url);
        if (!bookmarkedOrigin(origin)) throw new Error(`${origin || '这个页面'} 不在书签里；只有书签网站可以用已保存的登录自动登录`);
        if (!passwordManager || !passwords?.available()) throw new Error('当前桌面宿主没有可用的已保存密码');
        if (!passwords.list(origin).length) throw new Error(`${origin} 没有已保存的登录；用户需要先在这个网站登录一次并保存`);
        keepAwake(tab);
        return passwordManager.agentLogin(tab, { submit: value.submit !== false });
      }
      case 'exec': {
        if (typeof value.code !== 'string' || value.code.length === 0) throw new Error('exec 需要 code 字符串');
        if (value.code.length > 20000) throw new Error('exec 的代码超过 20000 个字符');
        return { result: await evaluateScript(requireTab(value.tabId), value.code) };
      }
      case 'ax':
        return { nodes: await accessibilityTree(requireTab(value.tabId)) };
      case 'dom': {
        const target = requireTab(value.tabId);
        return { html: await runInPage(target, 'document.documentElement.outerHTML.slice(0, 200000)'), text: await runInPage(target, 'document.body ? document.body.innerText.slice(0, 100000) : ""') };
      }
      case 'interactive':
        return { elements: await interactive(requireTab(value.tabId)) };
      case 'click':
        return click(requireTab(value.tabId), value);
      case 'type': {
        if (String(value.text ?? '').length > 20000) throw new Error('type 的文本超过 20000 个字符');
        return typeText(requireTab(value.tabId), value);
      }
      case 'locate':
        return requireTarget(requireTab(value.tabId), value, 'locate');
      case 'wait':
        return waitFor(requireTab(value.tabId), value);
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
      case 'read': {
        // The whole page in one call: text without repeated lines, optionally after scrolling to the end so lazily
        // loaded parts are read too, plus links and tables on request (browser-page-helpers.cjs pageRead).
        const target = requireTab(value.tabId);
        keepAwake(target);
        return runInPage(target, page.inPage(page.pageRead, readOptions(value)));
      }
      case 'readUrl':
        return readAddress(value);
      case 'downloads': {
        // Finished downloads and the ones still running, so a long download is visible while it happens.
        const running = [...tabs.values()].flatMap((tab) => [...tab.downloads.values()].map((entry) => ({ ...entry.record, state: 'progressing' })));
        return { folder: app.getPath('downloads'), downloads: [...downloadLog.slice(-50), ...running].filter((entry) => !value.tabId || entry.tabId === value.tabId) };
      }
      case 'download': {
        // Fetch one link as a download in the tab's own session (its cookies and sign-in), the way "Save link as" does.
        // A blob: or data: link the page made itself is accepted too; the answer waits for the file to arrive.
        const tab = requireTab(value.tabId);
        const raw = String(value.url || '').trim();
        if (!raw) throw new Error('download 需要 url');
        const url = /^(blob|data):/i.test(raw) ? raw : exports.httpUrl(raw);
        const before = downloadSeq;
        contentsOf(tab).downloadURL(url);
        const timeout = Math.max(5000, Math.min(600000, Number(value.timeoutMs) || 120000));
        const started = await awaitDownloads(tab, before, 15000, timeout);
        if (!started.length) throw new Error('这个链接没有开始下载（可能需要页面里的点击、登录，或链接已失效）');
        return { folder: app.getPath('downloads'), downloads: started };
      }
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
      case 'scroll':
        return scrollTab(requireTab(value.tabId), value);
      case 'external':
        return shell.openExternal(exports.httpUrl(value.url));
      // Settings → Google Drive → Built-in browser: sign-ins and saved passwords, sealed with the user's sync passphrase (browser-sync.cjs).
      case 'syncStatus':
        return browserSync ? browserSync.status() : { available: false, on: false };
      case 'syncPassphrase':
        return requireSync(context).setPassphrase(value.passphrase);
      case 'syncOff':
        return requireSync(context).turnOff();
      case 'syncNow':
        return requireSync(context).syncNow();
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
      case 'bookmarked':
        return { bookmarked: bookmarkedOrigin(safeOrigin(String(value.url || ''))) };
      case 'speeddial':
        return { items: requireSpeedDial().list() };
      case 'speeddial-save': {
        const store = requireSpeedDial();
        const saved = speedDialChanged(store.save(value.items));
        // New sites get their icon in the background; the page is told again when it arrives.
        void fillSpeedDialIcons(store);
        return { items: saved };
      }
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
      clipRectangle = null;
      if (rectangle && !tabs.has(activeTabId || DEFAULT_TAB)) {
        const tab = createTab(undefined);
        activeTabId = tab.id;
      }
      placeActive();
    },
    refresh: () => placeActive(),
    hide: () => hideAll(),
    destroy: () => {
      stopFrames();
      browserSync?.dispose();
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
