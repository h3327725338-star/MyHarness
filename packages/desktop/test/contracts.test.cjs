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
    assert.deepEqual(prefs.get(), { closeAction: 'ask' });
    assert.deepEqual(prefs.set({ closeAction: 'tray' }), { closeAction: 'tray' });
    assert.throws(() => prefs.set({ closeAction: 'explode' }), /未知的关闭方式/);
    assert.equal(createAppPrefs(dir).get().closeAction, 'tray', 'the choice survives a restart');
    fs.writeFileSync(path.join(dir, 'desktop-prefs.json'), '{ broken');
    assert.equal(createAppPrefs(dir).get().closeAction, 'ask', 'a damaged file falls back to asking');
    assert.deepEqual(loginItem({ isPackaged: true, getAppPath: () => 'x' }).args, ['--autostart']);
    assert.deepEqual(loginItem({ isPackaged: false, getAppPath: () => 'C:/app' }).args, ['C:/app', '--autostart']);
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
