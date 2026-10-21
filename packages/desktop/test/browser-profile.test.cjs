const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBookmarkStore } = require('../browser-bookmarks.cjs');
const { createPasswordStore, attachPasswordManager, credentialOrigin } = require('../browser-passwords.cjs');

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'myharness-browser-profile-'));

/** A reversible stand-in for safeStorage that still keeps the plain text out of the file (bytes are inverted). */
const fakeCrypto = (available = true) => ({
  available: () => available,
  encrypt: (text) => Buffer.from(Buffer.from(text, 'utf8').map((byte) => 255 - byte)),
  decrypt: (buffer) => Buffer.from(buffer.map((byte) => 255 - byte)).toString('utf8'),
});

test('bookmarks are added, renamed, moved and removed, and survive a restart', () => {
  const dir = tempDir();
  const file = path.join(dir, 'browser-bookmarks.json');
  const store = createBookmarkStore(file);
  assert.deepEqual(store.list(), []);
  let list = store.add({ url: 'https://github.com/', title: '  Github  ', icon: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Github');
  assert.equal(list[0].icon, 'data:image/png;base64,iVBORw0KGgo=');
  list = store.add({ url: 'https://chatgpt.com/', title: '' });
  assert.equal(list[1].title, 'chatgpt.com');
  list = store.update(list[0].id, { title: 'GitHub Home' });
  assert.equal(list[0].title, 'GitHub Home');
  assert.equal(list[0].icon, 'data:image/png;base64,iVBORw0KGgo=');
  // Another site keeps no icon of the old one.
  list = store.update(list[0].id, { url: 'https://gitlab.com/' });
  assert.equal(list[0].icon, undefined);

  const reopened = createBookmarkStore(file);
  assert.deepEqual(reopened.list().map((item) => item.title), ['GitHub Home', 'chatgpt.com']);
  list = reopened.remove(list[1].id);
  assert.equal(list.length, 1);
  assert.equal(createBookmarkStore(file).list().length, 1);
});

test('bookmarks refuse non-web addresses and unusable icons, and set a damaged file aside', () => {
  const dir = tempDir();
  const file = path.join(dir, 'browser-bookmarks.json');
  const store = createBookmarkStore(file);
  assert.throws(() => store.add({ url: 'file:///C:/secret.txt' }));
  assert.throws(() => store.add({ url: 'https://user:pass@example.com/' }));
  const list = store.add({ url: 'https://example.com/', icon: 'javascript:alert(1)' });
  assert.equal(list[0].icon, undefined);

  fs.writeFileSync(file, '{ not json');
  const damaged = createBookmarkStore(file);
  assert.deepEqual(damaged.list(), []);
  damaged.add({ url: 'https://example.org/' });
  assert.equal(fs.readFileSync(`${file}.damaged`, 'utf8'), '{ not json');
});

test('saved logins are encrypted on disk, one per site and user name, newest password wins', () => {
  const dir = tempDir();
  const file = path.join(dir, 'browser-logins.bin.json');
  const store = createPasswordStore({ file, crypto: fakeCrypto() });
  assert.equal(store.save({ origin: 'https://github.com', username: 'alice', password: 'first-secret' }).result, 'created');
  assert.equal(store.save({ origin: 'https://github.com', username: 'bob', password: 'bob-secret' }).result, 'created');
  assert.equal(store.save({ origin: 'https://github.com', username: 'alice', password: 'first-secret' }).result, 'unchanged');
  assert.equal(store.save({ origin: 'https://github.com', username: 'alice', password: 'second-secret' }).result, 'updated');

  const raw = fs.readFileSync(file, 'utf8');
  for (const plain of ['first-secret', 'second-secret', 'bob-secret', 'alice', 'github.com']) assert.equal(raw.includes(plain), false, plain);

  const reopened = createPasswordStore({ file, crypto: fakeCrypto() });
  const logins = reopened.forOrigin('https://github.com');
  assert.equal(logins.length, 2);
  assert.equal(logins.find((entry) => entry.username === 'alice').password, 'second-secret');
  assert.deepEqual(reopened.forOrigin('https://evil.example'), []);
  // The list for the settings UI never carries a password.
  assert.equal(JSON.stringify(reopened.list()).includes('secret'), false);
  // A user name hint (two-step sign-in) goes first.
  assert.equal(reopened.forOrigin('https://github.com', 'bob')[0].username, 'bob');

  reopened.remove(logins.find((entry) => entry.username === 'alice').id);
  assert.deepEqual(createPasswordStore({ file, crypto: fakeCrypto() }).forOrigin('https://github.com').map((entry) => entry.username), ['bob']);
});

test('nothing is saved without OS encryption, and an undecryptable file is never overwritten', () => {
  const dir = tempDir();
  const file = path.join(dir, 'browser-logins.bin.json');
  const off = createPasswordStore({ file, crypto: fakeCrypto(false) });
  assert.throws(() => off.save({ origin: 'https://a.example', username: 'u', password: 'p' }));
  assert.equal(fs.existsSync(file), false);

  fs.writeFileSync(file, JSON.stringify({ version: 1, data: Buffer.from('garbage').toString('base64') }));
  const before = fs.readFileSync(file, 'utf8');
  const other = createPasswordStore({ file, crypto: fakeCrypto() });
  assert.deepEqual(other.forOrigin('https://a.example'), []);
  assert.throws(() => other.save({ origin: 'https://a.example', username: 'u', password: 'p' }));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('credential origins only come from plain http(s) pages', () => {
  assert.equal(credentialOrigin('https://accounts.example.com/login?x=1'), 'https://accounts.example.com');
  assert.equal(credentialOrigin('file:///C:/x.html'), '');
  assert.equal(credentialOrigin('https://u:p@example.com/'), '');
  assert.equal(credentialOrigin('not a url'), '');
});

/** The IPC side of the sign-in helper, driven like the tab preload would drive it. */
function managerHarness() {
  const dir = tempDir();
  const store = createPasswordStore({ file: path.join(dir, 'logins.json'), crypto: fakeCrypto() });
  const listeners = new Map();
  const handlers = new Map();
  const ipcMain = { on: (channel, fn) => listeners.set(channel, fn), handle: (channel, fn) => handlers.set(channel, fn) };
  const tab = { id: 'tab1', destroyed: false };
  const contents = {};
  const events = [];
  const manager = attachPasswordManager({ ipcMain, store, tabFor: (sender) => (sender === contents ? tab : undefined), emit: (tabId, value) => events.push({ tabId, ...value }), log: () => {} });
  const frame = { url: 'https://site.example/login', parent: null };
  const from = (url = frame.url, parent = null) => ({ sender: contents, senderFrame: { url, parent } });
  const send = (channel, value, event = from()) => listeners.get(channel)(event, value);
  const invoke = (channel, event = from()) => handlers.get(channel)(event);
  return { store, manager, tab, events, send, invoke, from };
}

test('a login is saved only after the page left the form, and filled again for the same site only', () => {
  const h = managerHarness();
  h.send('mh-browser:login-attempt', { username: 'alice', password: 'pw-1' });
  // The form is still there (wrong password): nothing is saved.
  h.manager.navigated(h.tab);
  h.send('mh-browser:form-state', { passwordVisible: true }, h.from('https://site.example/login'));
  assert.equal(h.store.list().length, 0);
  // The next page has no password field: the sign-in worked.
  h.send('mh-browser:form-state', { passwordVisible: false }, h.from('https://site.example/home'));
  assert.deepEqual(h.store.list().map((entry) => entry.username), ['alice']);
  assert.equal(h.events.at(-1).type, 'credential-saved');
  assert.equal(JSON.stringify(h.events).includes('pw-1'), false);

  assert.deepEqual(h.invoke('mh-browser:credentials').map((entry) => entry.password), ['pw-1']);
  assert.deepEqual(h.invoke('mh-browser:credentials', h.from('https://other.example/login')), []);
  // A sub-frame gets nothing, even on the same site.
  assert.deepEqual(h.invoke('mh-browser:credentials', h.from('https://site.example/frame', { url: 'https://site.example/' })), []);
});

test('a single-page sign-in counts once its form went away, and a two-step sign-in keeps the user name', () => {
  const h = managerHarness();
  h.send('mh-browser:username', { username: 'bob@site.example' });
  h.send('mh-browser:login-attempt', { username: '', password: 'pw-2' });
  h.send('mh-browser:form-state', { passwordVisible: false });
  assert.equal(h.store.list().length, 0);
  h.send('mh-browser:form-state', { passwordVisible: false, settled: true });
  assert.deepEqual(h.store.list().map((entry) => entry.username), ['bob@site.example']);

  // A changed password replaces the saved one; clearing it stops filling.
  h.send('mh-browser:login-attempt', { username: 'bob@site.example', password: 'pw-3' });
  h.send('mh-browser:form-state', { passwordVisible: false, settled: true });
  assert.deepEqual(h.invoke('mh-browser:credentials').map((entry) => entry.password), ['pw-3']);
  assert.equal(h.events.at(-1).updated, true);
  h.store.remove(h.store.list()[0].id);
  assert.deepEqual(h.invoke('mh-browser:credentials'), []);
});
