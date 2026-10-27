const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWebMailState, webMailFromTab, GMAIL_FEED } = require('../browser-web-mail.cjs');

const tempFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'myharness-web-mail-')), 'browser-web-mail.json');

test('a tab tells a signed-in mailbox by its address and title, and a sign-out by where it was sent', () => {
  assert.deepEqual(webMailFromTab('https://mail.google.com/mail/u/0/#inbox', 'Inbox (3) - bob@gmail.com - Gmail'), { provider: 'google', signedIn: true, account: 'bob@gmail.com' });
  assert.deepEqual(webMailFromTab('https://mail.google.com/mail/u/1/#inbox', '收件箱 - bob@school.edu.my - 学校邮件'), { provider: 'google', signedIn: true, account: 'bob@school.edu.my' });
  // Gmail still loading, and a title of another site with an address in it, say nothing.
  assert.equal(webMailFromTab('https://mail.google.com/mail/u/0/', 'Gmail'), null);
  assert.equal(webMailFromTab('https://example.com/mail', 'Contact bob@gmail.com'), null);
  assert.deepEqual(webMailFromTab('https://outlook.live.com/mail/0/', 'Mail - Bob Hu - Outlook'), { provider: 'microsoft', signedIn: true, account: 'Bob Hu' });
  assert.deepEqual(webMailFromTab('https://outlook.office.com/mail/inbox', '邮件 – 胡顺博 – Outlook'), { provider: 'microsoft', signedIn: true, account: '胡顺博' });
  // Outlook's start page is the same for everyone.
  assert.equal(webMailFromTab('https://outlook.live.com/mail/0/', 'Outlook'), null);
  assert.deepEqual(webMailFromTab('https://login.live.com/login.srf?wa=wsignin1.0', '', 'https://outlook.live.com/mail/0/'), { provider: 'microsoft', signedIn: false });
  assert.deepEqual(webMailFromTab('https://www.microsoft.com/en-us/microsoft-365/outlook/email-and-calendar-software-microsoft-outlook', '', 'https://outlook.live.com/owa/'), { provider: 'microsoft', signedIn: false });
  assert.deepEqual(webMailFromTab('https://outlook.live.com/owa/logoff.owa', ''), { provider: 'microsoft', signedIn: false });
  // A Microsoft sign-in page reached from anywhere else is not about Outlook.
  assert.equal(webMailFromTab('https://login.microsoftonline.com/common/oauth2', '', 'https://teams.microsoft.com/'), null);
  assert.equal(webMailFromTab('not a url', 'Mail - Bob - Outlook'), null);
});

test('Gmail is signed in while Google keeps its sign-in cookies, and its feed names the address', async () => {
  const file = tempFile();
  let jar = [{ name: 'NID', value: 'x' }];
  const asked = [];
  let feed = () => new Response('<feed><title>Gmail - Inbox for bob@gmail.com</title></feed>', { status: 200 });
  const options = {
    file,
    cookies: async (url) => { asked.push(url); return jar; },
    fetch: async (url, init) => { asked.push(`${url} ${init.credentials}`); return feed(); },
  };
  const state = createWebMailState(options);
  assert.deepEqual(await state.state(), { google: { signedIn: false }, microsoft: { signedIn: false } });
  // Without the sign-in cookies the feed is not asked at all.
  assert.deepEqual(asked, ['https://mail.google.com/']);

  jar = [{ name: 'NID', value: 'x' }, { name: '__Secure-1PSID', value: 'secret-cookie-value' }];
  assert.deepEqual((await state.state()).google, { signedIn: true, account: 'bob@gmail.com' });
  assert.ok(asked.includes(`${GMAIL_FEED} include`));
  const saved = fs.readFileSync(file, 'utf8');
  assert.match(saved, /bob@gmail\.com/);
  assert.doesNotMatch(saved, /secret-cookie-value/);

  // The feed failing keeps the address seen before; the cookies alone still say signed in.
  feed = () => { throw new Error('offline'); };
  assert.deepEqual((await createWebMailState(options).state()).google, { signedIn: true, account: 'bob@gmail.com' });
  // Signed out (the cookies are gone): no address stays behind.
  jar = [];
  assert.deepEqual((await state.state()).google, { signedIn: false });
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /bob@gmail\.com/);
});

test('Outlook is signed in once a tab shows its mailbox, stays so after the tab closes, and signs out by redirect', async () => {
  const file = tempFile();
  let open = [];
  const options = { file, cookies: async () => [], fetch: async () => { throw new Error('not asked'); }, openTabs: () => open };
  const state = createWebMailState(options);
  assert.equal((await state.state()).microsoft.signedIn, false);
  open = [{ url: 'https://outlook.live.com/mail/0/', title: 'Mail - Bob Hu - Outlook' }];
  assert.deepEqual((await state.state()).microsoft, { signedIn: true, account: 'Bob Hu' });
  open = [];
  assert.deepEqual((await createWebMailState(options).state()).microsoft, { signedIn: true, account: 'Bob Hu' });
  // The tab reports what it showed: the same state again changes nothing, a sign-out does.
  assert.equal(state.observe('https://outlook.live.com/mail/0/', 'Mail - Bob Hu - Outlook'), false);
  assert.equal(state.observe('https://login.live.com/login.srf', '', 'https://outlook.live.com/mail/0/'), true);
  assert.deepEqual((await state.state()).microsoft, { signedIn: false });
  // An open Gmail tab answers for Gmail without the cookies being asked.
  open = [{ url: 'https://mail.google.com/mail/u/0/#inbox', title: 'Inbox - bob@gmail.com - Gmail' }];
  assert.deepEqual((await state.state()).google, { signedIn: true, account: 'bob@gmail.com' });
});

test('an unreadable or foreign state file is ignored', async () => {
  const file = tempFile();
  fs.writeFileSync(file, '{ not json');
  const logs = [];
  const state = createWebMailState({ file, cookies: async () => [], fetch: async () => new Response('', { status: 401 }), log: (line) => logs.push(line) });
  assert.deepEqual(await state.state(), { google: { signedIn: false }, microsoft: { signedIn: false } });
  assert.equal(logs.length, 1);
  fs.writeFileSync(file, JSON.stringify({ microsoft: { signedIn: 'yes', account: 7 } }));
  assert.equal((await createWebMailState({ file, cookies: async () => [], fetch: async () => undefined }).state()).microsoft.signedIn, false);
});
