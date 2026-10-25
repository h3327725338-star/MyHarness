const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
test('browser URL policy rejects native schemes and credentials', () => {
  const file = path.join(__dirname, '../browser-view.cjs');
  const module = new Module(file);
  module.require = (name) => name === 'electron' ? {} : require(name);
  module._compile(fs.readFileSync(file, 'utf8'), file);
  for (const value of ['file:///C:/Windows', 'javascript:alert(1)', 'https://user:secret@example.com']) assert.throws(() => module.exports.httpUrl(value));
  assert.equal(module.exports.httpUrl('https://github.com'), 'https://github.com/');
});
test('Windows Job API can create and release a kill-on-close job', { skip: process.platform !== 'win32' }, () => {
  const job = require('../windows-job.cjs').createJob(); job.close();
});
test('closing a Job terminates its assigned process', { skip: process.platform !== 'win32' }, async () => {
  const { spawn } = require('node:child_process');
  const job = require('../windows-job.cjs').createJob();
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  job.assign(child.pid);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  job.close();
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Job did not terminate child')), 3000).unref())]);
  assert.notEqual(child.exitCode, null);
});
test('preload exposes no raw Electron or Node APIs', () => {
  const source = fs.readFileSync(path.join(__dirname, '../preload.cjs'), 'utf8');
  assert.doesNotMatch(source, /exposeInMainWorld\(['"](?:fs|require|ipcRenderer|electron)['"]/);
  assert.match(source, /contextBridge.exposeInMainWorld/);
});
test('legacy desktop preferences: the last change of each preference across earlier origins', () => {
  const os = require('node:os');
  const { readLegacyPrefs } = require('../legacy-prefs.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-prefs-'));
  try {
    const leveldb = path.join(dir, 'Local Storage', 'leveldb');
    fs.mkdirSync(leveldb, { recursive: true });
    // Minimal LevelDB write-ahead log: one FULL record per batch, each batch one put of a localStorage value.
    const varint = (n) => { const out = []; while (n > 127) { out.push((n & 127) | 128); n >>>= 7; } out.push(n); return Buffer.from(out); };
    const put = (seq, origin, prefs, utf16 = false) => {
      const key = Buffer.from(`_http://127.0.0.1:${origin}\x00\x01myharness.web.prefs`, 'latin1');
      const text = JSON.stringify(prefs);
      const value = Buffer.concat([Buffer.from([utf16 ? 0 : 1]), Buffer.from(text, utf16 ? 'utf16le' : 'latin1')]);
      const head = Buffer.alloc(12); head.writeUInt32LE(seq, 0); head.writeUInt32LE(1, 8);
      const batch = Buffer.concat([head, Buffer.from([1]), varint(key.length), key, varint(value.length), value]);
      const header = Buffer.alloc(7); header.writeUInt16LE(batch.length, 4); header[6] = 1;
      return Buffer.concat([header, batch]);
    };
    const defaults = { theme: 'system', motion: 'system', lang: 'en', panelTab: 'changes', sidebarW: 272 };
    fs.writeFileSync(path.join(leveldb, '000003.log'), Buffer.concat([
      put(1, 50000, defaults),
      put(2, 50000, { ...defaults, theme: 'dark' }),
      put(3, 50000, { ...defaults, theme: 'dark', motion: 'on' }, true),
      // A later start restarted from the defaults and only changed the panel tab.
      put(4, 50001, { ...defaults, panelTab: 'files' }),
      put(5, 50001, { ...defaults, panelTab: 'files', lang: 'zh-CN' }),
    ]));
    const result = readLegacyPrefs(dir);
    assert.equal(result.prefs.theme, 'dark');
    assert.equal(result.prefs.motion, 'on');
    assert.equal(result.prefs.panelTab, 'files');
    assert.equal(result.prefs.lang, 'zh-CN');
    assert.equal(result.prefs.sidebarW, 272);
    assert.ok(result.updatedAt > 0);
    fs.writeFileSync(path.join(leveldb, '000003.log'), put(1, 50000, 'not an object'));
    assert.deepEqual(readLegacyPrefs(dir), { unreadable: true });
    fs.rmSync(path.join(leveldb, '000003.log'));
    assert.equal(readLegacyPrefs(dir), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('desktop preferences: close action defaults to ask, saves valid choices and refuses unknown ones', () => {
  const os = require('node:os');
  const { createAppPrefs, loginItem } = require('../app-prefs.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-prefs-'));
  try {
    const prefs = createAppPrefs(dir);
    assert.deepEqual(prefs.get(), { closeAction: 'ask', appZoom: 1 });
    assert.deepEqual(prefs.set({ closeAction: 'tray' }), { closeAction: 'tray', appZoom: 1 });
    assert.equal(prefs.set({ appZoom: 1.25 }).appZoom, 1.25);
    assert.equal(prefs.set({ appZoom: 99 }).appZoom, 5, 'the app zoom is kept within the supported range');
    assert.throws(() => prefs.set({ closeAction: 'explode' }), /未知的关闭方式/);
    assert.equal(createAppPrefs(dir).get().closeAction, 'tray', 'the choice survives a restart');
    assert.equal(createAppPrefs(dir).get().appZoom, 5, 'the zoom survives a restart');
    fs.writeFileSync(path.join(dir, 'desktop-prefs.json'), '{ broken');
    assert.equal(createAppPrefs(dir).get().closeAction, 'ask', 'a damaged file falls back to asking');
    assert.deepEqual(loginItem({ isPackaged: true, getAppPath: () => 'x' }).args, ['--autostart']);
    assert.deepEqual(loginItem({ isPackaged: false, getAppPath: () => 'C:/app' }).args, ['C:/app', '--autostart']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('zoom: Chrome-like steps, keys and a per-site store', () => {
  const os = require('node:os');
  const { stepZoom, zoomKey, cleanZoom, createSiteZoomStore } = require('../zoom.cjs');
  assert.equal(stepZoom(1, 1), 1.1);
  assert.equal(stepZoom(1, -1), 0.9);
  assert.equal(stepZoom(1.05, 1), 1.1, 'an in-between factor goes to the next level');
  assert.equal(stepZoom(5, 1), 5);
  assert.equal(stepZoom(0.25, -1), 0.25);
  assert.equal(stepZoom(2.5, 0), 1);
  assert.equal(cleanZoom('nope'), 1);
  const key = (input) => zoomKey({ type: 'keyDown', control: true, ...input });
  assert.equal(key({ key: '=', code: 'Equal' }), 1);
  assert.equal(key({ key: '+', code: 'Equal', shift: true }), 1);
  assert.equal(key({ key: '+', code: 'NumpadAdd' }), 1);
  assert.equal(key({ key: '-', code: 'Minus' }), -1);
  assert.equal(key({ key: '0', code: 'Digit0' }), 0);
  assert.equal(key({ key: 'a', code: 'KeyA' }), undefined);
  assert.equal(zoomKey({ type: 'keyDown', key: '=', code: 'Equal' }), undefined, 'without Ctrl it is typing');
  assert.equal(key({ key: '=', code: 'Equal', alt: true }), undefined);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoom-'));
  try {
    const store = createSiteZoomStore(path.join(dir, 'browser-zoom.json'));
    store.set('https://example.com/a', 1.5);
    assert.equal(store.get('https://example.com/other'), 1.5, 'the zoom belongs to the host');
    assert.equal(store.get('https://other.example/'), 1);
    store.set('https://example.com/', 1);
    assert.equal(store.get('https://example.com/'), 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('website dark mode: auto follows the app, a site choice wins, settings survive', () => {
  const os = require('node:os');
  const { createDarkStore, themeFor } = require('../browser-dark.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dark-'));
  try {
    const file = path.join(dir, 'browser-dark.json');
    const store = createDarkStore(file);
    assert.equal(store.wanted('https://example.com/', true), true);
    assert.equal(store.wanted('https://example.com/', false), false);
    assert.equal(store.wanted('file:///C:/x.html', true), false, 'only web pages are recolored');
    store.setSite('https://example.com/page', 'off');
    assert.equal(store.wanted('https://example.com/other', true), false);
    store.setMode('on');
    assert.equal(store.wanted('https://news.example/', false), true);
    assert.throws(() => store.setMode('blue'), /未知的深色模式/);
    const again = createDarkStore(file);
    assert.deepEqual(again.get(), { mode: 'on', sites: { 'example.com': 'off' } });
    assert.equal(themeFor({ background: '#101010', text: 'red' }).darkSchemeTextColor, '#e3e3e3', 'only #rrggbb colors are taken');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('browser language: header and navigator list follow the choice, which survives a restart', () => {
  const os = require('node:os');
  const { acceptLanguage, createLanguageStore, languageList } = require('../browser-language.cjs');
  assert.deepEqual(languageList('zh-CN'), ['zh-CN', 'zh', 'en-US', 'en']);
  assert.deepEqual(languageList('en-GB'), ['en-GB', 'en']);
  assert.deepEqual(languageList('ja'), ['ja', 'en-US', 'en']);
  assert.deepEqual(languageList('xx'), []);
  assert.equal(acceptLanguage('zh-CN'), 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7');
  assert.equal(acceptLanguage(''), '');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lang-'));
  try {
    const file = path.join(dir, 'browser-language.json');
    const store = createLanguageStore(file);
    assert.equal(store.get(), '');
    assert.equal(store.set('ja'), 'ja');
    assert.equal(createLanguageStore(file).get(), 'ja');
    assert.equal(store.set('nonsense'), '', 'an unknown tag goes back to the default');
    assert.equal(createLanguageStore(file).get(), '');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('preload exposes the desktop preferences only through the fixed IPC channel', () => {
  const source = fs.readFileSync(path.join(__dirname, '../preload.cjs'), 'utf8');
  assert.match(source, /appPrefs: Object\.freeze/);
  assert.match(source, /ipcRenderer\.invoke\('desktop:app-prefs', patch\)/);
  const main = fs.readFileSync(path.join(__dirname, '../main.cjs'), 'utf8');
  assert.match(main, /ipcMain\.handle\('desktop:app-prefs', \(event, patch\) => \{\n\s+if \(!trusted\(event\)\)/);
});
test('the packaged build copies every local module the host loads', () => {
  const build = fs.readFileSync(path.join(__dirname, '../build.mjs'), 'utf8');
  const copied = new Set([...build.match(/for \(const name of \[([^\]]+)\]\) cpSync/)[1].matchAll(/'([^']+)'/g)].map((match) => match[1]));
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    const source = fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
    for (const match of source.matchAll(/require\((?:require\('node:path'\)\.join\(__dirname, )?'(?:\.\/)?([\w.-]+\.cjs)'\)?\)/g)) visit(match[1]);
  };
  visit('main.cjs');
  for (const name of seen) assert.ok(copied.has(name), `${name} is loaded by the host but not copied by build.mjs`);
});
