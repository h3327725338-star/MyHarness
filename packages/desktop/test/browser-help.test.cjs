const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHelpDesk, signInAddress } = require('../browser-help.cjs');
const { createBookmarkStore } = require('../browser-bookmarks.cjs');

/** A help desk with a hand-driven clock and timers; `commit` stores the patch on the tab like the host does. */
function desk() {
  let clock = 1000;
  let nextTimer = 1;
  const timers = new Map();
  const help = createHelpDesk({
    commit: (tab, patch) => Object.assign(tab, patch),
    stateOf: (tab) => ({ tabId: tab.id, url: tab.url, challenge: !!tab.challenge }),
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { fn, at: clock + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  const advance = (ms) => {
    clock += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= clock && timers.has(id)) {
        timers.delete(id);
        timer.fn();
      }
    }
  };
  return { help, advance, timers };
}

/** Whether a promise has settled, without waiting for it. */
const settled = async (promise) => {
  let done = false;
  promise.then(() => { done = true; });
  await new Promise((resolve) => setImmediate(resolve));
  return done;
};

test('a request waits for the user on the tab and ends with their answer', async () => {
  const { help, advance } = desk();
  const tab = { id: 't1', url: 'https://accounts.google.com/signin' };
  const asked = help.ask(tab, { reason: 'login', message: '  Please   sign in to Gmail ', timeoutMs: 60_000, sessionId: 's1', chatTitle: ' Mail  chat ' });
  assert.deepEqual(tab.help, { id: tab.help.id, reason: 'login', message: 'Please sign in to Gmail', since: 1000, until: 61_000, sessionId: 's1', chatTitle: 'Mail chat' });
  assert.equal(help.pending(tab), true);
  // A stale request and an unknown answer change nothing.
  assert.equal(help.answer(tab, 'help-999', 'done'), false);
  assert.equal(help.answer(tab, tab.help.id, 'maybe'), false);
  assert.equal(await settled(asked), false);

  advance(5000);
  assert.equal(help.answer(tab, tab.help.id, 'done'), true);
  assert.deepEqual(await asked, { tabId: 't1', url: 'https://accounts.google.com/signin', challenge: false, outcome: 'done', reason: 'login', waitedMs: 5000 });
  assert.equal(tab.help, null);
  assert.equal(help.pending(tab), false);
});

test('a request ends as declined, timeout, closed, cancelled or replaced', async () => {
  const { help, advance } = desk();
  const tab = { id: 't1', url: 'https://shop.example/' };

  let asked = help.ask(tab, { reason: 'other' });
  help.answer(tab, tab.help.id, 'declined');
  assert.equal((await asked).outcome, 'declined');

  // The wait is at least 30 seconds, whatever the Agent asked for.
  asked = help.ask(tab, { timeoutMs: 1 });
  advance(29_999);
  assert.equal(await settled(asked), false);
  advance(1);
  assert.equal((await asked).outcome, 'timeout');

  asked = help.ask(tab, {});
  help.cancel(tab);
  assert.equal((await asked).outcome, 'cancelled');

  const first = help.ask(tab, { reason: 'login' });
  const second = help.ask(tab, { reason: 'other', message: 'Pick the account' });
  assert.equal((await first).outcome, 'replaced');
  assert.equal(tab.help.reason, 'other');
  assert.equal(await settled(second), false);

  // A tab that went away answers with its id only and is not written to.
  tab.destroyed = true;
  const shown = tab.help;
  help.closed(tab);
  assert.deepEqual(await second, { tabId: 't1', outcome: 'closed', reason: 'other', waitedMs: 0 });
  assert.equal(tab.help, shown);
});

test('the reason defaults to the human check on the tab, or a sign-in', async () => {
  const { help } = desk();
  const checked = { id: 'a', url: 'https://shop.example/', challenge: { kind: 'turnstile' } };
  help.ask(checked, {});
  assert.equal(checked.help.reason, 'verify');
  const plain = { id: 'b', url: 'https://shop.example/account' };
  help.ask(plain, { reason: 'bogus' });
  assert.equal(plain.help.reason, 'login');
  help.cancel(checked);
  help.cancel(plain);
});

test('a human check that clears by itself ends the wait once the page stayed clear', async () => {
  const { help, advance } = desk();
  const tab = { id: 't2', url: 'https://shop.example/', challenge: { kind: 'cloudflare' } };
  const asked = help.ask(tab, { reason: 'verify' });
  help.observe(tab);
  advance(10_000);
  assert.equal(await settled(asked), false);

  tab.challenge = null;
  tab.loading = true;
  help.observe(tab);
  advance(5000);
  assert.equal(await settled(asked), false);

  tab.loading = false;
  help.observe(tab);
  advance(1000);
  // The check came back before the page settled: the count starts again.
  tab.challenge = { kind: 'cloudflare' };
  help.observe(tab);
  advance(1000);
  assert.equal(await settled(asked), false);

  tab.challenge = null;
  help.observe(tab);
  advance(1499);
  assert.equal(await settled(asked), false);
  advance(1);
  assert.equal((await asked).outcome, 'done-auto');
});

test('a sign-in ends by itself only after the page left the sign-in pages and stayed away', async () => {
  const { help, advance } = desk();
  const tab = { id: 't3', url: 'https://accounts.google.com/v3/signin/identifier' };
  const asked = help.ask(tab, { reason: 'login' });
  help.observe(tab);
  advance(5000);
  assert.equal(await settled(asked), false);

  // The password step is still part of the sign-in.
  tab.url = 'https://accounts.google.com/v3/signin/challenge/pwd';
  tab.passwordVisible = true;
  help.observe(tab);
  advance(5000);
  assert.equal(await settled(asked), false);

  // A site page that still shows a password field is not finished either.
  tab.url = 'https://mail.example/welcome';
  help.observe(tab);
  advance(5000);
  assert.equal(await settled(asked), false);

  tab.url = 'https://mail.google.com/mail/u/0/';
  tab.passwordVisible = false;
  help.observe(tab);
  advance(2999);
  assert.equal(await settled(asked), false);
  advance(1);
  assert.equal((await asked).outcome, 'done-auto');
});

test('a check never seen, or a request of another kind, waits for the user', async () => {
  const { help, advance } = desk();
  const quiet = { id: 'q', url: 'https://shop.example/' };
  const verify = help.ask(quiet, { reason: 'verify' });
  quiet.url = 'https://shop.example/cart';
  help.observe(quiet);
  advance(60_000);
  assert.equal(await settled(verify), false);

  const other = { id: 'o', url: 'https://shop.example/' };
  const asked = help.ask(other, { reason: 'other' });
  other.url = 'https://shop.example/done';
  help.observe(other);
  advance(60_000);
  assert.equal(await settled(asked), false);
  help.cancel(quiet);
  help.cancel(other);
});

test('sign-in pages are told apart by their address alone', () => {
  for (const url of [
    'https://accounts.google.com/',
    'https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x',
    'https://github.com/login',
    'https://github.com/sessions/two-factor',
    'https://elearn.example.edu/login/index.php',
    'https://company.okta.com/app/x',
    'https://example.com/signin',
    'https://id.example.com/auth/realms/main/protocol/openid-connect/auth',
  ]) assert.equal(signInAddress(url), true, url);
  for (const url of [
    'https://mail.google.com/mail/u/0/',
    'https://example.com/blog/login-tips',
    'https://example.com/catalog/index',
    'file:///C:/login',
    'not an address',
    '',
    undefined,
  ]) assert.equal(signInAddress(url), false, String(url));
});

test('bookmark notes: written by the user or the app, kept on edits, and use is recorded at most once an hour', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myharness-bookmark-notes-'));
  const file = path.join(dir, 'browser-bookmarks.json');
  const store = createBookmarkStore(file);
  let list = store.add({ url: 'https://elearn.example.edu/', title: 'eLearn', note: '  Course site:\n assignments and grades. ', noteAuto: true });
  assert.equal(list[0].note, 'Course site: assignments and grades.');
  assert.equal(list[0].noteAuto, true);
  assert.equal(typeof list[0].updatedAt, 'string');
  // An edit that does not touch the note keeps it, and the app's mark with it.
  list = store.update(list[0].id, { title: 'School' });
  assert.equal(list[0].note, 'Course site: assignments and grades.');
  assert.equal(list[0].noteAuto, true);
  // The user's own words are no longer the app's.
  list = store.update(list[0].id, { note: 'My course site, check every Monday.' });
  assert.equal(list[0].note, 'My course site, check every Monday.');
  assert.equal(list[0].noteAuto, undefined);
  list = store.update(list[0].id, { note: '   ' });
  assert.equal(list[0].note, undefined);
  assert.equal(store.add({ url: 'https://long.example/', note: 'x'.repeat(600) })[1].note.length, 500);

  const id = list[0].id;
  list = store.used(id);
  const first = list[0].lastUsedAt;
  assert.equal(typeof first, 'string');
  const before = fs.statSync(file).mtimeMs;
  list = store.used(id);
  assert.equal(list[0].lastUsedAt, first);
  assert.equal(fs.statSync(file).mtimeMs, before);
  assert.equal(store.used('missing').length, 2);
  assert.equal(createBookmarkStore(file).list()[0].lastUsedAt, first);
});

test('bookmark notes say who wrote them, and the Agent improves only the notes the app wrote', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myharness-bookmark-writers-'));
  const file = path.join(dir, 'browser-bookmarks.json');
  const store = createBookmarkStore(file);
  let list = store.add({ url: 'https://elearn.example.edu/', title: 'eLearn', note: 'Course pages', noteAuto: true, noteBy: 'opencode/muse-spark' });
  const id = list[0].id;
  assert.equal(list[0].noteBy, 'opencode/muse-spark');
  // A note the user typed has no writer but the user.
  assert.equal(store.add({ url: 'https://a.example/', note: 'mine', noteBy: 'opencode/muse-spark' })[1].noteBy, undefined);
  list = store.setNote(id, { note: ' DSA and OS assignments, grades ', by: 'agent', keepUsers: true });
  assert.deepEqual([list[0].note, list[0].noteAuto, list[0].noteBy], ['DSA and OS assignments, grades', true, 'agent']);
  assert.equal(createBookmarkStore(file).list()[0].noteBy, 'agent');
  // The user rewrites it: the writer goes with the app's mark, and the Agent may no longer replace it.
  list = store.update(id, { note: 'My school: hand in work on Fridays' });
  assert.equal(list[0].noteBy, undefined);
  assert.throws(() => store.setNote(id, { note: 'Course pages', by: 'agent', keepUsers: true }), /用户自己写的/);
  assert.equal(store.list()[0].note, 'My school: hand in work on Fridays');
  // The app's own writing (the user asked for it in the list) may.
  assert.equal(store.setNote(id, { note: 'Course pages', by: 'm/x' })[0].noteBy, 'm/x');
  assert.throws(() => store.setNote(id, { note: '  ' }), /不能为空/);
  assert.throws(() => store.setNote('missing', { note: 'x' }), /不存在/);
});
