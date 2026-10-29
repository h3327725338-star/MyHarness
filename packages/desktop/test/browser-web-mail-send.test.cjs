const { test } = require('node:test');
const assert = require('node:assert/strict');
const { composeAddress, bareAddress, sendThroughPage } = require('../browser-web-mail-send.cjs');

test('the compose address carries the whole message, and the account picks the mailbox', () => {
  const message = { to: ['Bob <bob@gmail.com>', 'amy@x.co'], cc: ['c@x.co'], bcc: [], subject: '提醒 & 计划', text: '第一行\n第二行 ?=&' };
  const gmail = new URL(composeAddress('google', message, { account: 'Me <Me@Gmail.com>' }));
  assert.equal(gmail.origin + gmail.pathname, 'https://mail.google.com/mail/');
  assert.equal(gmail.searchParams.get('view'), 'cm');
  assert.equal(gmail.searchParams.get('to'), 'Bob <bob@gmail.com>,amy@x.co');
  assert.equal(gmail.searchParams.get('cc'), 'c@x.co');
  assert.equal(gmail.searchParams.has('bcc'), false);
  assert.equal(gmail.searchParams.get('su'), '提醒 & 计划');
  assert.equal(gmail.searchParams.get('body'), '第一行\n第二行 ?=&');
  assert.equal(gmail.searchParams.get('authuser'), 'me@gmail.com');
  // No account: whichever Gmail account the browser opens first.
  assert.equal(new URL(composeAddress('google', message)).searchParams.has('authuser'), false);

  const personal = new URL(composeAddress('microsoft', message, { account: 'me@hotmail.com' }));
  assert.equal(personal.origin + personal.pathname, 'https://outlook.live.com/mail/0/deeplink/compose');
  assert.equal(personal.searchParams.get('subject'), '提醒 & 计划');
  assert.equal(personal.searchParams.get('body'), '第一行\n第二行 ?=&');
  // A work or school address goes to Microsoft 365's Outlook; a name only (what Outlook's title shows) to the personal one.
  assert.equal(new URL(composeAddress('microsoft', message, { account: 'bob@school.edu.my' })).host, 'outlook.office.com');
  assert.equal(new URL(composeAddress('microsoft', message, { account: 'Bob Hu' })).host, 'outlook.live.com');
  assert.throws(() => composeAddress('yahoo', message), /未知的邮箱网站/);
  assert.equal(bareAddress('Bob <Bob@Gmail.com>'), 'bob@gmail.com');
  assert.equal(bareAddress('nobody'), '');
});

test('a message without a recipient or a subject is refused before any page opens', async () => {
  const contents = { loadURL: () => assert.fail('no page should open') };
  await assert.rejects(sendThroughPage(contents, { provider: 'google', message: { cc: ['a@b.co'], subject: 's' } }), /没有收件人/);
  await assert.rejects(sendThroughPage(contents, { provider: 'google', message: { to: ['a@b.co'], subject: ' ' } }), /需要主题/);
  await assert.rejects(sendThroughPage(contents, { provider: 'yahoo', message: { to: ['a@b.co'], subject: 's' } }), /未知的邮箱网站/);
});
