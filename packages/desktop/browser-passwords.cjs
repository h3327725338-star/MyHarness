const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_ENTRIES = 1000;
const MAX_FIELD = 1024;
// A login removed here is remembered this long, so another computer's copy (browser-sync.cjs) cannot bring it back.
const REMOVED_KEEP_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_REMOVED = 1000;

const writeAtomic = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
};

/** The origin a credential belongs to: only http(s) pages, never a URL carrying its own user name or password. */
exports.credentialOrigin = (value) => {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    return url.origin;
  } catch {
    return '';
  }
};

/**
 * Saved site logins of the built-in browser. The whole file is one blob encrypted with the operating system's per-user
 * key (Electron `safeStorage`, DPAPI on Windows): neither the passwords nor the user names nor the sites are readable
 * in the file, and another Windows user or another machine cannot decrypt it. Without OS encryption nothing is saved.
 * The file lives in the desktop host's user-data folder, outside the Data root; it never leaves this computer. Browser
 * sync (browser-sync.cjs) carries the logins only inside a vault sealed with the user's sync passphrase.
 *
 * `crypto` is `{ available(), encrypt(text) -> Buffer, decrypt(Buffer) -> text }`.
 */
exports.createPasswordStore = ({ file, crypto }) => {
  let cache = null;
  // Logins the user removed: { origin, username, at } (browser sync only; kept inside the same encrypted blob).
  let removed = [];
  // A file this user cannot decrypt (another account, a reset key) is never overwritten: it may still be recoverable.
  let unreadable = false;
  const load = () => {
    if (cache) return cache;
    cache = [];
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return cache; }
    try {
      const outer = JSON.parse(text);
      if (outer?.version !== 1 || typeof outer.data !== 'string') throw new Error('unknown format');
      const inner = JSON.parse(crypto.decrypt(Buffer.from(outer.data, 'base64')));
      cache = (Array.isArray(inner?.entries) ? inner.entries : []).filter(
        (entry) => entry && typeof entry.id === 'string' && typeof entry.origin === 'string' && typeof entry.username === 'string' && typeof entry.password === 'string',
      );
      removed = (Array.isArray(inner?.removed) ? inner.removed : []).filter(
        (entry) => entry && typeof entry.origin === 'string' && typeof entry.username === 'string' && typeof entry.at === 'string',
      );
    } catch {
      unreadable = true;
      cache = [];
    }
    return cache;
  };
  const persist = (entries) => {
    if (!crypto.available()) throw new Error('系统加密不可用，未保存密码');
    if (unreadable) throw new Error('已保存的密码文件无法用当前 Windows 账户解密，未覆盖它');
    const now = Date.now();
    removed = removed.filter((entry) => now - Date.parse(entry.at) < REMOVED_KEEP_MS).slice(-MAX_REMOVED);
    const data = crypto.encrypt(JSON.stringify({ entries, removed })).toString('base64');
    writeAtomic(file, `${JSON.stringify({ version: 1, data })}\n`);
    cache = entries;
  };
  /** What the settings list shows: site and user name, never the password. */
  const summary = (entry) => ({ id: entry.id, origin: entry.origin, username: entry.username, updatedAt: entry.updatedAt });
  return {
    available: () => crypto.available(),
    list(origin) {
      return load()
        .filter((entry) => !origin || entry.origin === origin)
        .sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username))
        .map(summary);
    },
    /** Logins for one exact origin, most recently used first; a user name hint (two-step sign-in) goes to the front. */
    forOrigin(origin, hint) {
      if (!origin) return [];
      const entries = load().filter((entry) => entry.origin === origin);
      const rank = (entry) => (hint && entry.username === hint ? 1 : 0);
      return entries
        .sort((a, b) => rank(b) - rank(a) || String(b.usedAt || b.updatedAt).localeCompare(String(a.usedAt || a.updatedAt)))
        .map((entry) => ({ id: entry.id, username: entry.username, password: entry.password }));
    },
    /** Save or replace one login. The same site and user name keep one entry; a new password replaces the old one. */
    save({ origin, username, password }) {
      if (!origin) throw new Error('无法识别网站');
      const user = String(username ?? '').slice(0, MAX_FIELD);
      const secret = String(password ?? '');
      if (!secret || secret.length > MAX_FIELD) throw new Error('密码为空或过长');
      const entries = load();
      const now = new Date().toISOString();
      const existing = entries.find((entry) => entry.origin === origin && entry.username === user);
      // The account that just signed in is the one filled first next time.
      if (existing) {
        const unchanged = existing.password === secret;
        const next = unchanged ? { ...existing, usedAt: now } : { ...existing, password: secret, updatedAt: now, usedAt: now };
        persist(entries.map((entry) => (entry === existing ? next : entry)));
        return { result: unchanged ? 'unchanged' : 'updated', entry: summary(next) };
      }
      if (entries.length >= MAX_ENTRIES) throw new Error(`最多保存 ${MAX_ENTRIES} 个网站登录`);
      const entry = { id: randomUUID(), origin, username: user, password: secret, createdAt: now, updatedAt: now, usedAt: now };
      persist([...entries, entry]);
      return { result: 'created', entry: summary(entry) };
    },
    markUsed(id) {
      const entries = load();
      const found = entries.find((entry) => entry.id === id);
      if (!found) return;
      try { persist(entries.map((entry) => (entry === found ? { ...entry, usedAt: new Date().toISOString() } : entry))); } catch { /* ordering only */ }
    },
    remove(id) {
      const entries = load();
      const found = entries.find((entry) => entry.id === id);
      if (!found) throw new Error('这个已保存的登录已不存在');
      removed = [...removed.filter((entry) => entry.origin !== found.origin || entry.username !== found.username), { origin: found.origin, username: found.username, at: new Date().toISOString() }];
      persist(entries.filter((entry) => entry.id !== id));
      return { ok: true };
    },
    /** Everything browser sync seals: the logins with their passwords, and the logins removed here. */
    syncEntries() {
      const entries = load().map(({ origin, username, password, createdAt, updatedAt }) => ({ origin, username, password, createdAt, updatedAt }));
      return { entries: entries.sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username)), removed: removed.map((entry) => ({ ...entry })) };
    },
    /**
     * Take another computer's logins: the newer password of the same site and user name wins, and a login removed on
     * either computer after it last changed is removed. Returns how many logins changed here.
     */
    mergeEntries(remote) {
      if (!crypto.available()) return 0;
      let entries = load();
      if (unreadable) return 0;
      const sameLogin = (a, b) => a.origin === b.origin && a.username === b.username;
      const newer = (a, b) => String(a || '') > String(b || '');
      let changed = 0;
      for (const gone of Array.isArray(remote?.removed) ? remote.removed : []) {
        if (typeof gone?.origin !== 'string' || typeof gone?.username !== 'string' || typeof gone?.at !== 'string') continue;
        const here = entries.find((entry) => sameLogin(entry, gone));
        if (here && !newer(here.updatedAt, gone.at)) {
          entries = entries.filter((entry) => entry !== here);
          changed += 1;
        }
        const known = removed.find((entry) => sameLogin(entry, gone));
        if (!known) removed = [...removed, { origin: gone.origin, username: gone.username, at: gone.at }];
        else if (newer(gone.at, known.at)) known.at = gone.at;
      }
      for (const login of Array.isArray(remote?.entries) ? remote.entries : []) {
        if (typeof login?.origin !== 'string' || typeof login?.username !== 'string' || typeof login?.password !== 'string' || !login.password) continue;
        if (login.password.length > MAX_FIELD || login.username.length > MAX_FIELD) continue;
        const gone = removed.find((entry) => sameLogin(entry, login));
        if (gone && !newer(login.updatedAt, gone.at)) continue;
        const here = entries.find((entry) => sameLogin(entry, login));
        if (here) {
          if (here.password === login.password || !newer(login.updatedAt, here.updatedAt)) continue;
          entries = entries.map((entry) => (entry === here ? { ...here, password: login.password, updatedAt: login.updatedAt } : entry));
        } else {
          if (entries.length >= MAX_ENTRIES) continue;
          const at = typeof login.updatedAt === 'string' ? login.updatedAt : new Date().toISOString();
          entries = [...entries, { id: randomUUID(), origin: login.origin, username: login.username, password: login.password, createdAt: login.createdAt || at, updatedAt: at, usedAt: at }];
        }
        changed += 1;
      }
      if (changed) persist(entries);
      return changed;
    },
  };
};

/**
 * Wire the per-tab sign-in helper (browser-tab-preload.cjs) to the store. A login is saved only after it looked
 * successful: the page left the form (a navigation to a page without a password field, or the field went away on a
 * single-page app). Filling only puts the values into the fields; the site's own button signs in.
 *
 * Every message is checked against the tab it came from and the origin of that tab's top frame; a page cannot ask for
 * another site's logins, and a sub-frame gets none.
 */
exports.attachPasswordManager = ({ ipcMain, store, tabFor, emit, log }) => {
  const ATTEMPT_TTL_MS = 60_000;
  const HINT_TTL_MS = 5 * 60_000;
  const attempts = new Map();
  const hints = new Map();
  const sender = (event) => {
    const frame = event.senderFrame;
    if (!frame || frame.parent) return null;
    const tab = tabFor(event.sender);
    if (!tab || tab.destroyed) return null;
    const origin = exports.credentialOrigin(frame.url);
    return origin ? { tab, origin, url: frame.url } : null;
  };
  const hintFor = (tab, origin) => {
    const hint = hints.get(tab.id);
    return hint && hint.origin === origin && Date.now() - hint.at < HINT_TTL_MS ? hint.username : '';
  };
  const commitAttempt = (tab) => {
    const attempt = attempts.get(tab.id);
    if (!attempt) return;
    attempts.delete(tab.id);
    if (Date.now() - attempt.at > ATTEMPT_TTL_MS) return;
    try {
      const saved = store.save(attempt);
      if (saved.result === 'unchanged') return;
      log(`已${saved.result === 'updated' ? '更新' : '保存'}网站登录：${attempt.origin}`);
      emit(tab.id, { type: 'credential-saved', origin: attempt.origin, username: attempt.username, updated: saved.result === 'updated' });
    } catch (error) {
      log(`网站登录未保存：${attempt.origin}（${error.message}）`);
      emit(tab.id, { type: 'credential-error', origin: attempt.origin, error: error.message });
    }
  };
  ipcMain.on('mh-browser:username', (event, value) => {
    const from = sender(event);
    const username = typeof value?.username === 'string' ? value.username.trim().slice(0, MAX_FIELD) : '';
    if (from && username) hints.set(from.tab.id, { origin: from.origin, username, at: Date.now() });
  });
  ipcMain.on('mh-browser:login-attempt', (event, value) => {
    const from = sender(event);
    if (!from || typeof value?.password !== 'string' || !value.password) return;
    const username = (typeof value.username === 'string' ? value.username.trim().slice(0, MAX_FIELD) : '') || hintFor(from.tab, from.origin);
    // Without a user name the login cannot be told apart from the next one; such a form is left alone.
    if (!username) return;
    attempts.set(from.tab.id, { origin: from.origin, username, password: value.password, at: Date.now(), url: from.url, navigated: false });
  });
  // The page reports whether a password field is still on screen: after a navigation, or when a single-page app
  // removed its form. A form that is still there after the submit is a failed or unfinished sign-in.
  ipcMain.on('mh-browser:form-state', (event, value) => {
    const from = sender(event);
    if (!from) return;
    const attempt = attempts.get(from.tab.id);
    if (!attempt || value?.passwordVisible) return;
    // The report may arrive before the host saw the navigation event; a different page address counts as one.
    if (attempt.navigated || from.url !== attempt.url || value?.settled === true) commitAttempt(from.tab);
  });
  ipcMain.handle('mh-browser:credentials', (event) => {
    const from = sender(event);
    if (!from || !store.available()) return [];
    try {
      return store.forOrigin(from.origin, hintFor(from.tab, from.origin));
    } catch {
      return [];
    }
  });
  ipcMain.on('mh-browser:filled', (event, value) => {
    const from = sender(event);
    if (from && typeof value?.id === 'string') store.markUsed(value.id);
  });
  // The answer of a tab to `agentLogin`: what was filled and pressed, never a password.
  const loginWaits = new Map();
  let loginSeq = 0;
  ipcMain.on('mh-browser:agent-login-result', (event, value) => {
    const from = sender(event);
    const wait = from && typeof value?.requestId === 'string' ? loginWaits.get(value.requestId) : undefined;
    if (!wait || wait.tab !== from.tab) return;
    loginWaits.delete(value.requestId);
    clearTimeout(wait.timer);
    wait.resolve({
      ok: value.ok === true,
      origin: from.origin,
      username: typeof value.username === 'string' ? value.username.slice(0, MAX_FIELD) : '',
      filledPassword: value.filledPassword === true,
      submitted: value.submitted === true,
      ...(typeof value.reason === 'string' ? { reason: value.reason.slice(0, 300) } : {}),
    });
  });
  return {
    /**
     * Sign in with the login saved for the tab's site: the tab's helper fills the saved user name and password into the
     * page's form and, when asked, submits it the way the form's own button would. The result names the account and what
     * happened; the password stays between this store and the page.
     */
    agentLogin(tab, { submit = true } = {}) {
      const contents = tab?.view?.webContents;
      if (!contents || contents.isDestroyed()) return Promise.reject(new Error('浏览器标签已不可用'));
      const requestId = `login${++loginSeq}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          loginWaits.delete(requestId);
          reject(new Error('页面没有在 10 秒内回应自动登录'));
        }, 10_000);
        loginWaits.set(requestId, { tab, resolve, timer });
        try {
          contents.send('mh-browser:agent-login', { requestId, submit: submit !== false });
        } catch (error) {
          loginWaits.delete(requestId);
          clearTimeout(timer);
          reject(error);
        }
      });
    },
    /** A main-frame navigation of the tab: the next form report decides whether the pending sign-in worked. */
    navigated(tab) {
      const attempt = attempts.get(tab.id);
      if (attempt) attempt.navigated = true;
    },
    forget(tab) {
      attempts.delete(tab.id);
      hints.delete(tab.id);
    },
  };
};
