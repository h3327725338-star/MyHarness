// Sync of the built-in browser between the user's computers, riding on the Google Drive sync of the coding agent
// (packages/coding-agent/src/sync/browser-data.ts), which uploads and writes the browser's files of this profile.
//
// Bookmarks, new-tab shortcuts and site settings travel as the stores' own files: when sync writes one, the store
// reloads it here. Sign-ins (the persistent cookies of the website session) and saved passwords travel only in this
// computer's vault, `browser-vault-<device>.json`, sealed with AES-256-GCM under a key derived (scrypt) from the user's
// sync passphrase. The passphrase stays on this computer, encrypted by Windows (safeStorage, browser-sync-key.bin.json,
// which sync never reads). Each computer writes only its own vault and reads the others', so vaults never conflict.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const zlib = require('node:zlib');

const KEY_FILE = 'browser-sync-key.bin.json';
const VAULT_FILE = /^browser-vault-([a-f0-9]{16})\.json$/;
const vaultName = (device) => `browser-vault-${device}.json`;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const MIN_PASSPHRASE = 8;
// Sites rewrite some cookie on almost every page, so the vault is sealed at most this often (and shortly after start).
const SEAL_EVERY_MS = 30 * 60 * 1000;
const SEAL_AFTER_START_MS = 20 * 1000;
// A sign-in removed here stays removed for this long, so another computer's older copy cannot bring it back.
const GONE_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const RELOAD_DELAY_MS = 300;

const writeAtomic = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
};
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const cookieKey = (cookie) => `${cookie.name}\t${cookie.domain}\t${cookie.path}`;
// Sign-ins of this computer's own servers (localhost, an address) mean nothing on another one.
const localDomain = (domain) => {
  const host = String(domain || '').replace(/^\./, '');
  return !host || host === 'localhost' || host.endsWith('.localhost') || /^[\d.]+$/.test(host) || host.includes(':');
};
const keptCookie = (cookie) => cookie && !cookie.session && typeof cookie.expirationDate === 'number' && cookie.expirationDate * 1000 > Date.now() && !localDomain(cookie.domain);
const cookieFields = (cookie) => ({
  name: cookie.name,
  value: cookie.value,
  domain: cookie.domain,
  hostOnly: !!cookie.hostOnly,
  path: cookie.path || '/',
  secure: !!cookie.secure,
  httpOnly: !!cookie.httpOnly,
  sameSite: cookie.sameSite || 'unspecified',
  expirationDate: cookie.expirationDate,
});

const deriveKey = (passphrase, salt) => new Promise((resolve, reject) => {
  crypto.scrypt(String(passphrase).normalize('NFC'), salt, 32, SCRYPT, (error, key) => (error ? reject(error) : resolve(key)));
});

/** Seal `plain` (any JSON value): gzip, then AES-256-GCM. Only salt, device and time stay readable. */
const sealVault = (key, { salt, device, deviceName }, plain) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(zlib.gzipSync(Buffer.from(JSON.stringify(plain)))), cipher.final()]);
  return `${JSON.stringify({
    version: 1,
    kind: 'myharness-browser-vault',
    device,
    deviceName,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
    sealedAt: new Date().toISOString(),
  })}\n`;
};

/** Open a vault with `keyFor(salt)`; throws when the passphrase is not the one it was sealed with. */
const openVault = async (text, keyFor) => {
  const vault = JSON.parse(text);
  if (vault?.version !== 1 || vault.kind !== 'myharness-browser-vault') throw new Error('不是浏览器同步数据');
  const key = await keyFor(Buffer.from(vault.salt, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(vault.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(vault.tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(vault.data, 'base64')), decipher.final()]);
  return { vault, plain: JSON.parse(zlib.gunzipSync(plain).toString('utf8')) };
};

/**
 * `stores`: profile file name → function that reloads that store (and tells the page). `passwords`: the saved-login
 * store (browser-passwords.cjs) or undefined. `safeStorage`: Electron's, for the passphrase.
 */
exports.createBrowserSync = ({ profileDir, partition, passwords, stores = {}, safeStorage, log = () => {} }) => {
  const keyFile = path.join(profileDir, KEY_FILE);
  let secret = null; // { passphrase, device, salt: Buffer, plainHash }
  const keys = new Map();
  const keyFor = (salt) => {
    const id = salt.toString('base64');
    if (!keys.has(id)) keys.set(id, deriveKey(secret.passphrase, salt).catch((error) => { keys.delete(id); throw error; }));
    return keys.get(id);
  };
  // This computer's sealed cookies as of the last seal or import: key → { cookie, at }, and removals: key → at.
  let own = { cookies: new Map(), gone: new Map() };
  const imported = new Map();
  const unreadable = new Map();
  let lastSealAt = null;
  let lastImportAt = null;
  let sealTimer = null;
  let sealing = null;
  let disposed = false;

  const encryptionReady = () => {
    try { return !!safeStorage?.isEncryptionAvailable(); } catch { return false; }
  };
  // This computer's vault name outlives turning sealing off, so turning it on again does not leave an orphan vault
  // behind that would read as another computer's.
  let device = null;
  const saveSecret = () => {
    const inner = JSON.stringify(secret
      ? { passphrase: secret.passphrase, device: secret.device, salt: secret.salt.toString('base64'), plainHash: secret.plainHash || '' }
      : { device });
    writeAtomic(keyFile, `${JSON.stringify({ version: 1, data: safeStorage.encryptString(inner).toString('base64') })}\n`);
  };
  const loadSecret = () => {
    try {
      const outer = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
      const inner = JSON.parse(safeStorage.decryptString(Buffer.from(outer.data, 'base64')));
      if (!/^[a-f0-9]{16}$/.test(inner.device)) return null;
      device = inner.device;
      if (typeof inner.passphrase !== 'string' || !inner.passphrase) return null;
      return { passphrase: inner.passphrase, device: inner.device, salt: Buffer.from(inner.salt, 'base64'), plainHash: inner.plainHash || '' };
    } catch {
      return null;
    }
  };
  const otherVaults = () => {
    let names = [];
    try { names = fs.readdirSync(profileDir); } catch { return []; }
    return names.filter((name) => VAULT_FILE.test(name) && (!secret || name !== vaultName(secret.device)));
  };

  /** Read this computer's own vault back, so the times of its sign-ins survive a restart. */
  const restoreOwn = async () => {
    own = { cookies: new Map(), gone: new Map() };
    let text;
    try { text = fs.readFileSync(path.join(profileDir, vaultName(secret.device)), 'utf8'); } catch { return; }
    try {
      const { plain } = await openVault(text, keyFor);
      for (const entry of Array.isArray(plain.cookies) ? plain.cookies : []) if (entry?.cookie) own.cookies.set(cookieKey(entry.cookie), entry);
      for (const [key, at] of Object.entries(plain.gone || {})) if (typeof at === 'number') own.gone.set(key, at);
    } catch (error) {
      log(`本机浏览器同步数据无法打开，从头记录：${error.message}`);
    }
  };

  const seal = async () => {
    if (!secret || disposed) return;
    const now = Date.now();
    const current = (await partition.cookies.get({})).filter(keptCookie);
    const cookies = new Map();
    for (const cookie of current) {
      const key = cookieKey(cookie);
      const before = own.cookies.get(key);
      cookies.set(key, { cookie: cookieFields(cookie), at: before && before.cookie.value === cookie.value ? before.at : now });
    }
    for (const key of own.cookies.keys()) if (!cookies.has(key)) own.gone.set(key, now);
    for (const key of cookies.keys()) own.gone.delete(key);
    for (const [key, at] of own.gone) if (now - at > GONE_KEEP_MS) own.gone.delete(key);
    own.cookies = cookies;
    const plain = {
      cookies: [...cookies.keys()].sort().map((key) => cookies.get(key)),
      gone: Object.fromEntries([...own.gone.entries()].sort(([a], [b]) => a.localeCompare(b))),
      logins: passwords ? passwords.syncEntries() : { entries: [], removed: [] },
    };
    const plainHash = sha(JSON.stringify(plain));
    const file = path.join(profileDir, vaultName(secret.device));
    // Unchanged sign-ins write nothing: a new seal of the same content would still be a new version to upload.
    if (plainHash === secret.plainHash && fs.existsSync(file)) return;
    const key = await keyFor(secret.salt);
    if (!secret || disposed) return;
    writeAtomic(file, sealVault(key, { salt: secret.salt, device: secret.device, deviceName: os.hostname() }, plain));
    secret.plainHash = plainHash;
    saveSecret();
    lastSealAt = new Date().toISOString();
  };
  const sealNow = () => {
    clearTimeout(sealTimer);
    sealTimer = null;
    sealing = (sealing || Promise.resolve()).then(seal).catch((error) => log(`浏览器同步数据封存失败：${error.message}`));
    return sealing;
  };
  const scheduleSeal = (delay) => {
    if (!secret || disposed || sealTimer) return;
    sealTimer = setTimeout(() => { void sealNow(); }, delay);
    sealTimer.unref?.();
  };

  /** Take what another computer's vault has and this one does not, or has older. Nothing here is removed. */
  const importVault = async (name) => {
    const file = path.join(profileDir, name);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return 0; }
    const hash = sha(text);
    if (imported.get(name) === hash) return 0;
    let opened;
    try {
      opened = await openVault(text, keyFor);
    } catch {
      let deviceName = name;
      try { deviceName = JSON.parse(text).deviceName || name; } catch { /* the file name says enough */ }
      unreadable.set(name, deviceName);
      return 0;
    }
    unreadable.delete(name);
    const { plain } = opened;
    const local = new Map((await partition.cookies.get({})).map((cookie) => [cookieKey(cookie), cookie]));
    const now = Date.now();
    let changed = 0;
    for (const entry of Array.isArray(plain.cookies) ? plain.cookies : []) {
      const cookie = entry?.cookie;
      if (!cookie || typeof cookie.name !== 'string' || typeof cookie.domain !== 'string' || typeof entry.at !== 'number') continue;
      if (!(cookie.expirationDate * 1000 > now) || localDomain(cookie.domain)) continue;
      const key = cookieKey(cookie);
      const here = local.get(key);
      if (here && here.value === cookie.value) continue;
      const known = own.cookies.get(key);
      // A sign-in that changed here since the last seal is newer than anything another computer had.
      const hereAt = here ? (known && known.cookie.value === here.value ? known.at : now) : own.gone.get(key) ?? 0;
      if (entry.at <= hereAt) continue;
      const details = {
        url: `${cookie.secure ? 'https' : 'http'}://${cookie.domain.replace(/^\./, '')}${cookie.path || '/'}`,
        name: cookie.name,
        value: String(cookie.value ?? ''),
        path: cookie.path || '/',
        secure: !!cookie.secure,
        httpOnly: !!cookie.httpOnly,
        expirationDate: cookie.expirationDate,
        sameSite: cookie.sameSite || 'unspecified',
      };
      if (!cookie.hostOnly) details.domain = cookie.domain;
      try {
        await partition.cookies.set(details);
        own.cookies.set(key, { cookie: cookieFields(cookie), at: entry.at });
        own.gone.delete(key);
        changed += 1;
      } catch { /* a cookie this engine refuses (a prefix rule, a bad domain) is skipped */ }
    }
    if (passwords && plain.logins) {
      try { changed += passwords.mergeEntries(plain.logins); } catch (error) { log(`浏览器同步的密码无法合并：${error.message}`); }
    }
    imported.set(name, hash);
    return changed;
  };
  const importAll = async () => {
    if (!secret || disposed) return 0;
    let changed = 0;
    for (const name of otherVaults()) changed += await importVault(name);
    lastImportAt = new Date().toISOString();
    return changed;
  };

  // ---- Files written by sync -------------------------------------------------------------------------------------
  const reloadTimers = new Map();
  let watcher = null;
  try {
    fs.mkdirSync(profileDir, { recursive: true });
    watcher = fs.watch(profileDir, (_event, name) => {
      if (!name || disposed) return;
      const reload = stores[name];
      const vault = VAULT_FILE.test(name) && secret && name !== vaultName(secret.device);
      if (!reload && !vault) return;
      clearTimeout(reloadTimers.get(name));
      reloadTimers.set(name, setTimeout(() => {
        reloadTimers.delete(name);
        if (disposed) return;
        if (reload) {
          try { reload(); } catch (error) { log(`浏览器数据重新读取失败（${name}）：${error.message}`); }
        } else {
          void importAll().catch((error) => log(`浏览器同步的登录数据导入失败：${error.message}`));
        }
      }, vault ? 1000 : RELOAD_DELAY_MS));
    });
    watcher.on('error', () => {});
  } catch (error) {
    log(`无法监听浏览器资料文件夹：${error.message}`);
  }
  const onCookie = () => scheduleSeal(SEAL_EVERY_MS);
  partition.cookies.on('changed', onCookie);

  const start = async () => {
    if (!encryptionReady()) return;
    secret = loadSecret();
    if (!secret) return;
    await restoreOwn();
    await importAll();
    scheduleSeal(SEAL_AFTER_START_MS);
  };
  const started = start().catch((error) => log(`浏览器同步启动失败：${error.message}`));

  return {
    status() {
      return {
        available: encryptionReady(),
        on: !!secret,
        lastSealAt,
        lastImportAt,
        others: otherVaults().length,
        unreadable: [...unreadable.values()],
      };
    },
    /** Turn sealing on, or change the passphrase. It must open the vaults other computers already sealed. */
    async setPassphrase(passphrase) {
      await started;
      const text = String(passphrase ?? '');
      if (text.length < MIN_PASSPHRASE) throw new Error(`同步口令至少 ${MIN_PASSPHRASE} 个字符`);
      if (!encryptionReady()) throw new Error('系统加密不可用，无法保存同步口令');
      const previous = secret;
      device = device || crypto.randomBytes(8).toString('hex');
      const candidate = { passphrase: text, device, salt: crypto.randomBytes(16), plainHash: '' };
      const others = fs.readdirSync(profileDir).filter((name) => VAULT_FILE.test(name) && name !== vaultName(candidate.device));
      if (others.length) {
        const tryKeys = new Map();
        const tryKeyFor = (salt) => {
          const id = salt.toString('base64');
          if (!tryKeys.has(id)) tryKeys.set(id, deriveKey(text, salt));
          return tryKeys.get(id);
        };
        let opens = false;
        for (const name of others) {
          try { await openVault(fs.readFileSync(path.join(profileDir, name), 'utf8'), tryKeyFor); opens = true; break; } catch { /* try the next computer */ }
        }
        if (!opens) throw new Error('这个口令打不开其他电脑同步过来的登录数据，请输入与其他电脑相同的口令');
      }
      secret = candidate;
      keys.clear();
      imported.clear();
      unreadable.clear();
      saveSecret();
      // Turned on again: what this computer's vault knew is read back (each vault names its own salt) before resealing.
      if (!previous) await restoreOwn();
      await importAll();
      await sealNow();
      return this.status();
    },
    /** Stop sealing and importing on this computer. The sealed files stay; nothing can read them without the passphrase. */
    turnOff() {
      clearTimeout(sealTimer);
      sealTimer = null;
      secret = null;
      keys.clear();
      own = { cookies: new Map(), gone: new Map() };
      try { if (device && encryptionReady()) saveSecret(); else fs.rmSync(keyFile, { force: true }); } catch { /* nothing to keep */ }
      return this.status();
    },
    /** Seal now and read the other computers' vaults (Settings → Google Drive → Sync now). */
    async syncNow() {
      await started;
      if (!secret) return this.status();
      await importAll();
      await sealNow();
      return this.status();
    },
    dispose() {
      disposed = true;
      clearTimeout(sealTimer);
      for (const timer of reloadTimers.values()) clearTimeout(timer);
      try { watcher?.close(); } catch { /* already closed */ }
      try { partition.cookies.removeListener('changed', onCookie); } catch { /* session gone */ }
    },
  };
};

exports.VAULT_FILE = VAULT_FILE;
