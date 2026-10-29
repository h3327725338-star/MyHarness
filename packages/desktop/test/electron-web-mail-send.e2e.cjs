/*
 * Real-Electron test of sending an email through the Gmail or Outlook website with no model working the page
 * (browser-web-mail-send.cjs through the browser's `webMailSend` command). Not part of `node --test`, because it needs an
 * Electron main process:
 *
 *   packages/desktop/node_modules/electron/dist/electron.exe <absolute path of this file> --profile=<empty dir>
 *
 * No real website is reached: the tabs' session answers https itself with stand-ins of the two compose pages, shaped
 * like the real ones where the sender looks (Gmail's subjectbox, editable text, address chips, "Send (Ctrl-Enter)"
 * button and "View message" link; Outlook's subject field, editable text and Send button). The window is never shown.
 * It covers: the address the page is opened at, a send by the real mouse, a form that shows up late, a button that only
 * Ctrl+Enter reaches, a complaint of the website, a sign-in redirect, a form missing the subject or the text, emoji
 * Gmail draws as pictures in the text, a send the website never confirms, Outlook, choosing Gmail by its sign-in cookies, two sends due together going one after the other, and
 * the off-screen pages being closed afterwards. It prints a JSON report and exits 1 at any broken invariant.
 */
const { app, BrowserWindow, session } = require('electron');
const { mkdirSync } = require('node:fs');

const args = Object.fromEntries(process.argv.slice(2).filter((value) => value.startsWith('--')).map((value) => {
  const [key, ...rest] = value.slice(2).split('=');
  return [key, rest.join('=')];
}));
const profile = args.profile;
if (!profile) {
  console.error('usage: electron electron-web-mail-send.e2e.cjs --profile=<dir>');
  app.exit(2);
}
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-features', 'MediaRouter,CalculateNativeWinOcclusion');

const report = { checks: [], failures: [] };
const check = (ok, name, detail) => {
  report.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) });
  process.stderr.write(`${ok ? 'ok' : 'FAIL'} - ${name}\n`);
  if (!ok) report.failures.push(`${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  return !!ok;
};

// How the stand-in Gmail behaves this time, and what it saw.
let mode = 'ok';
const opened = [];
const sent = [];
const html = (body) => new Response(`<!doctype html><html><head><meta charset="utf-8"><title>Gmail</title></head><body>${body}</body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const escape = (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function gmailCompose(params) {
  const bare = (value) => ((/[^\s<>",;]+@[^\s<>",;]+/.exec(value) || [''])[0]).toLowerCase();
  const chips = ['to', 'cc', 'bcc'].flatMap((key) => (params.get(key) || '').split(',')).filter(Boolean).map((value) => `<span email="${escape(bare(value))}" class="chip">${escape(value)}</span>`).join('');
  const subject = mode === 'noSubject' ? '' : params.get('su') || '';
  // Like Gmail: each emoji of the text is drawn as a picture whose alt is the emoji (without its variation mark).
  const emoji = (value) => value.replace(/\p{Extended_Pictographic}️?/gu, (found) => `<img data-emoji="${found.replace(/️/g, '')}" alt="${found.replace(/️/g, '')}" class="an1" src="data:,">`);
  const text = mode === 'noBody' ? '' : escape(params.get('body') || '').replace(/\n/g, '<br>');
  const form = `<div class="form"><div class="recipients">${chips}</div>
<input name="subjectbox" value="${escape(subject)}">
<div g_editable="true" contenteditable="true" role="textbox">${mode === 'emoji' ? emoji(text) : text}</div>
<div class="bar"><div role="button" class="T-I aoO" tabindex="1" data-tooltip="Send ‪(Ctrl-Enter)‬" id="send">Send</div></div></div>`;
  return html(`<div id="app"></div><script>
const mode = ${JSON.stringify(mode)};
const form = ${JSON.stringify(form)};
const done = () => {
  fetch('/sent', { method: 'POST', body: JSON.stringify({ to: [...document.querySelectorAll('[email]')].map((el) => el.getAttribute('email')), subject: document.querySelector('[name=subjectbox]').value, text: document.querySelector('[g_editable]').innerText }) });
  if (mode === 'complaint') {
    document.body.insertAdjacentHTML('beforeend', '<div role="alertdialog">The address "nobody@" in the "To" field was not recognized.</div>');
    return;
  }
  document.getElementById('app').innerHTML = '<div>Message sent <span id="link_vsm" role="link">View message</span></div>';
};
const show = () => {
  document.getElementById('app').innerHTML = form;
  const send = document.getElementById('send');
  // Like Gmail: the button acts on a trusted press, not on a scripted click(); here only the mouse or Ctrl+Enter.
  if (mode !== 'keysOnly' && mode !== 'silent') send.addEventListener('mouseup', (event) => { if (event.isTrusted) done(); });
  if (mode !== 'silent') document.querySelector('[g_editable]').addEventListener('keydown', (event) => { if (event.ctrlKey && event.key === 'Enter') done(); });
};
setTimeout(show, mode === 'late' ? 2500 : 50);
</script>`);
}

function outlookCompose(params) {
  const form = `<div class="compose"><div class="well">${escape((params.get('to') || '').split(',').join('; '))}</div>
<input aria-label="Add a subject" value="${escape(params.get('subject') || '')}">
<div contenteditable="true" aria-label="Message body">${escape(params.get('body') || '')}</div>
<button aria-label="Send" title="Send (Ctrl+Enter)" id="send">Send</button></div>`;
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>Mail - Bob Hu - Outlook</title></head><body><div id="app">${form}</div><script>
document.getElementById('send').addEventListener('click', (event) => {
  if (!event.isTrusted) return;
  fetch('/sent', { method: 'POST', body: JSON.stringify({ outlook: true, subject: document.querySelector('input').value }) });
  document.getElementById('app').innerHTML = '<div>Inbox</div>';
});
</script></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

async function answer(request) {
  const url = new URL(request.url);
  if (url.pathname === '/sent' && request.method === 'POST') {
    sent.push({ host: url.host, at: Date.now(), ...JSON.parse(await request.text()) });
    return new Response('ok');
  }
  if (url.host === 'mail.google.com' && url.pathname === '/mail/u/0/feed/atom') {
    return new Response('<feed><title>Gmail - Inbox for bob@gmail.com</title></feed>', { headers: { 'content-type': 'application/atom+xml' } });
  }
  if (url.host === 'mail.google.com' && url.pathname === '/mail/') {
    opened.push({ url: request.url, at: Date.now() });
    if (mode === 'signedOut') return Response.redirect('https://accounts.google.com/v3/signin/identifier?continue=gmail', 302);
    return gmailCompose(url.searchParams);
  }
  if (url.host === 'accounts.google.com') return html('<form><input type="email"><input type="password"></form>');
  if (url.host === 'outlook.live.com' && url.pathname.startsWith('/mail/0/deeplink/compose')) {
    opened.push({ url: request.url, at: Date.now() });
    return outlookCompose(url.searchParams);
  }
  return new Response('not here', { status: 404 });
}

async function main() {
  const partition = session.fromPartition('persist:myharness-third-party');
  partition.protocol.handle('https', answer);
  const window = new BrowserWindow({ width: 1280, height: 900, show: false });
  const { createBrowser } = require('../browser-view.cjs');
  const browser = createBrowser(window, () => {}, { profileDir: profile });
  const send = async (value) => {
    const started = Date.now();
    try {
      return { ...(await browser.command({ action: 'webMailSend', subject: '周报提醒', text: '记得交 DSA 作业\n第二行', to: ['Bob <bob@gmail.com>'], ...value })), took: Date.now() - started };
    } catch (error) {
      return { error: error.message, took: Date.now() - started };
    }
  };
  const windows = () => BrowserWindow.getAllWindows().length;

  // --- a send by the real mouse --------------------------------------------------------------------------------------
  mode = 'ok';
  let result = await send({ provider: 'google', account: 'me@gmail.com', cc: ['amy@x.co'] });
  const address = new URL(opened.at(-1)?.url || 'https://x/');
  check(result.ok === true && result.provider === 'google', 'Gmail sends the message', result);
  check(address.searchParams.get('to') === 'Bob <bob@gmail.com>' && address.searchParams.get('cc') === 'amy@x.co' && address.searchParams.get('su') === '周报提醒' && address.searchParams.get('body') === '记得交 DSA 作业\n第二行' && address.searchParams.get('authuser') === 'me@gmail.com', 'the compose page opens with the whole message in its address', address.search);
  check(sent.length === 1 && sent[0].subject === '周报提醒' && sent[0].to.includes('bob@gmail.com'), 'the website got the message as written', sent);
  check(result.took < 6000, 'it is sent within seconds', result.took);
  check(windows() === 1, 'the off-screen compose page is closed afterwards', windows());

  // --- a form that shows up late, and a button only Ctrl+Enter reaches ---------------------------------------------------
  mode = 'late';
  result = await send({ provider: 'google' });
  check(result.ok === true && sent.length === 2, 'a form that takes seconds to appear is waited for', result);
  mode = 'keysOnly';
  result = await send({ provider: 'google' });
  check(result.ok === true && sent.length === 3, 'a Send button that ignores the mouse is pressed with Ctrl+Enter', result);

  // --- what stops a send is said, and nothing is sent twice ----------------------------------------------------------
  mode = 'complaint';
  result = await send({ provider: 'google' });
  check(/拒绝|没有发出/.test(result.error || '') && /not recognized/.test(result.error || ''), "the website's complaint is passed on", result);
  mode = 'signedOut';
  result = await send({ provider: 'google' });
  check(/没有登录/.test(result.error || ''), 'a sign-in page says Gmail is not signed in', result);
  mode = 'noSubject';
  const before = sent.length;
  result = await send({ provider: 'google' });
  check(/没有填好：主题/.test(result.error || '') && sent.length === before, 'a form that lost the subject is not sent', result);
  mode = 'noBody';
  result = await send({ provider: 'google' });
  check(/没有填好：正文（页面上的正文是空的）/.test(result.error || '') && sent.length === before, 'a form that lost the text is not sent and says what it shows', result);

  // --- emoji, which Gmail draws as pictures in the text ----------------------------------------------------------------
  mode = 'emoji';
  result = await send({ provider: 'google', subject: '🙂', text: '🙂' });
  check(result.ok === true && sent.at(-1)?.subject === '🙂', 'a message that is only an emoji is sent', result);
  result = await send({ provider: 'google', text: '记得 ❤️ 交作业\n第二行' });
  check(result.ok === true, 'emoji drawn as pictures inside the text count as the text', result);
  mode = 'silent';
  result = await send({ provider: 'google', timeoutMs: 10000 });
  check(/没有表示已发出/.test(result.error || '') && result.took < 13000, 'a send the website never confirms fails within its time, pointing to Sent', result);
  check(windows() === 1, 'no compose page is left open after failures', windows());

  // --- Outlook ---------------------------------------------------------------------------------------------------------
  result = await send({ provider: 'microsoft', to: ['amy@outlook.com'] });
  check(result.ok === true && sent.at(-1)?.outlook === true && sent.at(-1)?.subject === '周报提醒', 'Outlook sends the message', { result, last: sent.at(-1) });
  check(new URL(opened.at(-1).url).host === 'outlook.live.com', 'a personal Outlook opens outlook.live.com', opened.at(-1));

  // --- no website named: the signed-in Gmail is chosen -------------------------------------------------------------------
  result = await send({});
  check(/没有登录 Gmail 或 Outlook/.test(result.error || ''), 'with no mailbox signed in, it says so', result);
  const future = Math.floor(Date.now() / 1000) + 3600;
  await partition.cookies.set({ url: 'https://mail.google.com/', domain: '.google.com', name: '__Secure-1PSID', value: 'lab', secure: true, expirationDate: future });
  mode = 'ok';
  result = await send({});
  check(result.ok === true && result.provider === 'google' && result.account === 'bob@gmail.com', 'Gmail, signed in by its cookies, is used and its address reported', result);

  // --- two sends due together go one after the other ---------------------------------------------------------------------
  mode = 'late';
  const count = sent.length;
  const pair = await Promise.all([send({ provider: 'google', subject: 'A' }), send({ provider: 'google', subject: 'B' })]);
  const opens = opened.slice(-2).map((item) => item.at);
  check(pair.every((item) => item.ok) && sent.length === count + 2 && sent.at(-2).subject === 'A' && sent.at(-1).subject === 'B', 'two emails due together are both sent, in order', pair);
  check(opens[1] >= sent.at(-2).at, 'the second compose page opens only after the first email went', { opens, sent: sent.slice(-2).map((item) => item.at) });
  check(windows() === 1, 'every compose page is closed in the end', windows());
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (error) {
    report.failures.push(`crashed: ${error.stack || error.message}`);
  }
  console.log(JSON.stringify(report, null, 2));
  app.exit(report.failures.length ? 1 : 0);
});
