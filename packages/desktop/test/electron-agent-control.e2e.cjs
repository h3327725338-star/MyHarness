/*
 * Real-Electron test of the Agent's control of the built-in browser (Windows). Not part of `node --test`, because it
 * needs an Electron main process:
 *
 *   npm exec -w @myharness/desktop -- electron packages/desktop/test/electron-agent-control.e2e.cjs --profile=<empty dir>
 *
 * The window is never shown (nothing takes the focus): every check runs on hidden tabs, which is exactly the case of a
 * tab the Agent drives in the background. It covers the Agent's own mouse (click on a canvas and an image, double
 * click, drag, wheel), keyboard (insertText, Control+A, Backspace, Enter), screenshots of hidden tabs in CSS pixels, the
 * Agent's pointer overlay, bookmark trust (permissions allowed at once), the Agent answering a permission request, a
 * saved login used by `login` on a bookmarked site, tab icons and speed-dial icons. It prints a JSON report and exits 1 at
 * any broken invariant.
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const http = require('node:http');
const { mkdirSync } = require('node:fs');

const args = Object.fromEntries(process.argv.slice(2).filter((value) => value.startsWith('--')).map((value) => {
  const [key, ...rest] = value.slice(2).split('=');
  return [key, rest.join('=')];
}));
const profile = args.profile;
const PORT = Number(args.port || 47851);
if (!profile) {
  console.error('usage: electron electron-agent-control.e2e.cjs --profile=<dir> [--port=47851]');
  app.exit(2);
}
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-features', 'MediaRouter,CalculateNativeWinOcclusion');

const report = { checks: [], failures: [] };
const check = (ok, name, detail) => {
  report.checks.push({ name, ok: !!ok, ...(ok ? {} : { detail }) });
  process.stderr.write(`${ok ? 'ok' : 'FAIL'} - ${name}
`);
  if (!ok) report.failures.push(`${name}${detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`);
  return !!ok;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await wait(60);
  }
  return undefined;
};

// A 16x16 red PNG, served as the site icon.
const ICON = nativeImage.createFromBitmap(Buffer.alloc(16 * 16 * 4, 0).map((_, index) => [0, 0, 255, 255][index % 4]), { width: 16, height: 16 }).toPNG();

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Agent Control</title><link rel="icon" href="/icon.png"></head>
<body style="margin:0;height:3000px;font:14px sans-serif">
<canvas id="canvas" width="200" height="100" style="position:absolute;left:20px;top:20px;background:rgb(255,0,0)"></canvas>
<img id="pic" alt="" width="60" height="60" style="position:absolute;left:260px;top:20px;background:rgb(0,0,255)" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
<div id="drag" style="position:absolute;left:20px;top:160px;width:300px;height:40px;background:#ccc"></div>
<input id="field" style="position:absolute;left:20px;top:230px;width:200px">
<div id="log" style="position:absolute;left:20px;top:280px"></div>
<script>
const log = [];
const add = (text) => { log.push(text); document.getElementById('log').textContent = log.join('|'); };
// Painted pixels, not only the CSS background: dark mode (Dark Reader, when installed) recolors styles but not drawings.
canvas.getContext('2d').fillStyle = 'rgb(255,0,0)';
canvas.getContext('2d').fillRect(0, 0, 200, 100);
canvas.addEventListener('click', (e) => add('canvas:' + e.offsetX + ',' + e.offsetY + ':' + e.isTrusted));
pic.addEventListener('click', (e) => add('img:' + e.isTrusted));
pic.addEventListener('dblclick', () => add('img-dbl'));
pic.addEventListener('contextmenu', (e) => { e.preventDefault(); add('img-right'); });
let dragging = false;
drag.addEventListener('mousedown', (e) => { dragging = true; add('down:' + e.clientX); });
window.addEventListener('mousemove', (e) => { if (dragging && e.buttons === 1) window.__moves = (window.__moves || 0) + 1; });
window.addEventListener('mouseup', (e) => { if (dragging) add('up:' + e.clientX); dragging = false; });
field.addEventListener('keydown', (e) => { if (e.key === 'Enter') add('enter:' + field.value); });
</script></body></html>`;
const LOGIN = '<!doctype html><title>Sign in</title><form method="post" action="/login"><input name="user" autocomplete="username"><input name="pass" type="password"><button type="submit">Sign in</button></form>';
const logins = [];

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(PAGE); return; }
  if (url.pathname === '/icon.png' || url.pathname === '/favicon.ico') { response.writeHead(200, { 'content-type': 'image/png' }); response.end(ICON); return; }
  if (url.pathname === '/signin') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(LOGIN); return; }
  if (url.pathname === '/login' && request.method === 'POST') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const form = new URLSearchParams(body);
      logins.push({ user: form.get('user'), pass: form.get('pass') });
      response.writeHead(302, { location: '/welcome' });
      response.end();
    });
    return;
  }
  if (url.pathname === '/welcome') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end('<!doctype html><title>Welcome</title><p>signed in</p>'); return; }
  response.writeHead(404); response.end();
});

async function main() {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${PORT}`;
  const other = `http://localhost:${PORT}`;
  const window = new BrowserWindow({ width: 1280, height: 900, show: false });
  const status = [];
  const realSend = window.webContents.send.bind(window.webContents);
  window.webContents.send = (channel, payload) => { if (channel === 'desktop:status') status.push(payload); return realSend(channel, payload); };
  const { createBrowser } = require('../browser-view.cjs');
  const browser = createBrowser(window, () => {}, { profileDir: profile });
  const run = (command) => browser.command(command);
  const pageLog = async (tabId) => (await run({ action: 'exec', tabId, code: "document.getElementById('log').textContent" })).result || '';
  const loaded = (tabId, title) => until(async () => { const state = await run({ action: 'state', tabId }); return state.loading === false && state.title === title ? state : undefined; });

  // Two tabs; neither is ever on screen (hidden window), the second never even had a rectangle.
  await run({ action: 'open', tabId: 'front', url: `${origin}/`, rect: { x: 0, y: 0, width: 900, height: 700 } });
  await run({ action: 'ensure', tabId: 'back', url: `${origin}/` });
  check(await loaded('front', 'Agent Control'), 'the first tab loads');
  check(await loaded('back', 'Agent Control'), 'the background tab loads');
  const viewport = (await run({ action: 'exec', tabId: 'back', code: '({ w: innerWidth, h: innerHeight })' })).result;
  check(viewport && viewport.w === 1280 && viewport.h === 800, 'the background tab has a desktop-size viewport even beside a smaller visible tab', viewport);

  // --- mouse --------------------------------------------------------------------------------------------------
  const onCanvas = await run({ action: 'mouse', tabId: 'back', kind: 'click', x: 70, y: 45 });
  check(onCanvas.target?.tag === 'canvas', 'the click reports what was under the pointer', onCanvas.target);
  await until(async () => (await pageLog('back')).includes('canvas:'));
  check((await pageLog('back')).includes('canvas:50,25:true'), 'a trusted click lands at the exact CSS point of a canvas in a background tab', await pageLog('back'));
  check((await pageLog('front')) === '', 'the other tab received nothing');
  await run({ action: 'mouse', tabId: 'back', kind: 'click', x: 290, y: 50 });
  await run({ action: 'mouse', tabId: 'back', kind: 'double_click', x: 290, y: 50 });
  await run({ action: 'mouse', tabId: 'back', kind: 'right_click', x: 290, y: 50 });
  await wait(150);
  const afterImage = await pageLog('back');
  check(afterImage.includes('img:true') && afterImage.includes('img-dbl') && afterImage.includes('img-right'), 'an image without selector or index takes click, double click and right click', afterImage);
  const cursor = (await run({ action: 'exec', tabId: 'back', code: "!!document.querySelector('myharness-agent-cursor')" })).result;
  check(cursor === true, 'the Agent pointer is drawn in the page');
  await run({ action: 'mouse', tabId: 'back', kind: 'click', x: 71, y: 46 });
  await wait(100);
  check((await pageLog('back')).includes('canvas:51,26:true'), 'the pointer overlay never swallows a click', await pageLog('back'));
  await run({ action: 'mouse', tabId: 'back', kind: 'drag', x: 30, y: 180, toX: 300, toY: 180 });
  await wait(100);
  const moves = (await run({ action: 'exec', tabId: 'back', code: 'window.__moves || 0' })).result;
  check((await pageLog('back')).includes('down:30') && (await pageLog('back')).includes('up:300') && moves >= 4, 'a drag presses, moves with the button held and releases at the end', { log: await pageLog('back'), moves });
  await run({ action: 'mouse', tabId: 'back', kind: 'wheel', x: 400, y: 400, deltaY: 500 });
  const scrolled = await until(async () => { const y = (await run({ action: 'exec', tabId: 'back', code: 'scrollY' })).result; return y > 0 ? y : undefined; }, 4000);
  check(scrolled > 0, 'the wheel scrolls the page under the pointer', scrolled);
  await run({ action: 'exec', tabId: 'back', code: 'scrollTo(0, 0)' });
  await assertRejects(() => run({ action: 'mouse', tabId: 'back', kind: 'click', x: 2000, y: 10 }), /之外/, 'a point outside the viewport is refused');

  // --- keyboard -----------------------------------------------------------------------------------------------
  await run({ action: 'mouse', tabId: 'back', kind: 'click', x: 100, y: 240 });
  await run({ action: 'insertText', tabId: 'back', text: 'hello 你好' });
  let value = (await run({ action: 'exec', tabId: 'back', code: 'field.value' })).result;
  check(value === 'hello 你好', 'text is typed where the click put the focus', value);
  await run({ action: 'keys', tabId: 'back', keys: 'Control+A Backspace' });
  value = (await run({ action: 'exec', tabId: 'back', code: 'field.value' })).result;
  check(value === '', 'Control+A then Backspace clears the field', value);
  await run({ action: 'insertText', tabId: 'back', text: 'go' });
  await run({ action: 'keys', tabId: 'back', keys: 'Enter' });
  await wait(100);
  check((await pageLog('back')).includes('enter:go'), 'Enter reaches the page as a key press', await pageLog('back'));

  // --- screenshots of hidden tabs -----------------------------------------------------------------------------
  const shot = await run({ action: 'snapshot', tabId: 'back' });
  const image = nativeImage.createFromDataURL(shot.snapshot);
  const size = image.getSize();
  check(size.width === 1280 && size.height === 800 && shot.width === 1280, 'a hidden tab is captured at its CSS size', { size, reported: [shot.width, shot.height] });
  const bitmap = image.toBitmap();
  const pixel = (x, y) => { const at = (y * size.width + x) * 4; return [bitmap[at + 2], bitmap[at + 1], bitmap[at]]; };
  const red = pixel(120, 90);
  check(red[0] > 200 && red[1] < 60 && red[2] < 60, 'the picture shows the real page (the red canvas where it is)', red);

  // --- bookmark trust and permissions ---------------------------------------------------------------------------
  await run({ action: 'bookmark-add', url: `${origin}/`, title: 'Trusted' });
  const granted = await run({ action: 'exec', tabId: 'back', code: 'Notification.requestPermission()' });
  check(granted.result === 'granted', 'a bookmarked site gets its permission at once', granted.result);
  check(status.some((event) => event.type === 'permission' && event.by === 'bookmark'), 'the bookmark grant is reported to the page');
  await run({ action: 'ensure', tabId: 'stranger', url: `${other}/` });
  await loaded('stranger', 'Agent Control');
  await run({ action: 'exec', tabId: 'stranger', code: "window.__answer = 'none'; Notification.requestPermission().then((v) => { window.__answer = v; }); true" });
  const pending = await until(async () => { const state = await run({ action: 'state', tabId: 'stranger' }); return state.pendingPermissions.length ? state.pendingPermissions[0] : undefined; });
  check(pending && pending.origin === other, 'an unknown site waits and the tab state names the pending request', pending);
  if (pending) {
    await run({ action: 'permission', requestId: pending.requestId, allow: true, by: 'agent' });
    const answer = await until(async () => { const v = (await run({ action: 'exec', tabId: 'stranger', code: 'window.__answer' })).result; return v !== 'none' ? v : undefined; });
    check(answer === 'granted', 'the Agent can allow a pending request', answer);
  }

  // --- saved login on a bookmarked site -------------------------------------------------------------------------
  await assertRejects(() => run({ action: 'login', tabId: 'stranger' }), /不在书签里/, 'login is refused on a site that is not bookmarked');
  await run({ action: 'ensure', tabId: 'signin', url: `${origin}/signin` });
  await loaded('signin', 'Sign in');
  // The user signs in once (trusted typing and click, as a person would); the password manager saves it.
  await run({ action: 'exec', tabId: 'signin', code: "document.querySelector('[name=user]').focus(); true" });
  await run({ action: 'insertText', tabId: 'signin', text: 'ada' });
  await run({ action: 'exec', tabId: 'signin', code: "document.querySelector('[name=pass]').focus(); true" });
  await run({ action: 'insertText', tabId: 'signin', text: 's3cret-pass' });
  const button = (await run({ action: 'exec', tabId: 'signin', code: "(() => { const r = document.querySelector('button').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()" })).result;
  await run({ action: 'mouse', tabId: 'signin', kind: 'click', x: button.x, y: button.y });
  const saved = await until(() => status.find((event) => event.type === 'credential-saved'), 10000);
  check(saved && saved.username === 'ada', 'the first sign-in is saved by the password manager', saved || status.filter((event) => event.type?.startsWith('credential')));
  logins.length = 0;
  await run({ action: 'navigate', tabId: 'signin', url: `${origin}/signin` });
  await loaded('signin', 'Sign in');
  // Clear what the automatic fill may have put in, so the login command has to fill it itself.
  await run({ action: 'exec', tabId: 'signin', code: "document.querySelectorAll('input').forEach((i) => { i.value = ''; }); true" });
  const signedIn = await run({ action: 'login', tabId: 'signin' });
  check(signedIn.ok === true && signedIn.username === 'ada' && signedIn.filledPassword === true && signedIn.submitted === true, 'login fills and submits the saved login', signedIn);
  check(!JSON.stringify(signedIn).includes('s3cret-pass'), 'the login result never carries the password');
  const posted = await until(() => logins[0], 8000);
  check(posted && posted.user === 'ada' && posted.pass === 's3cret-pass', 'the site received the saved user name and password', posted);
  check(await loaded('signin', 'Welcome'), 'the page reached the signed-in page');

  // --- icons ------------------------------------------------------------------------------------------------------
  const tabIcon = await until(() => status.find((event) => event.type === 'icon' && event.tabId === 'back'), 6000);
  check(tabIcon && /^data:image\/png;base64,/.test(tabIcon.icon) && tabIcon.url.startsWith(origin), 'the tab strip is told the site icon of a tab', tabIcon && { url: tabIcon.url });
  await run({ action: 'speeddial-save', items: [{ type: 'site', title: 'Stranger', url: `${other}/` }] });
  const dial = await until(async () => { const list = (await run({ action: 'speeddial' })).items; return list[0]?.icon ? list : undefined; }, 8000);
  check(dial && /^data:image\/png;base64,/.test(dial[0].icon), 'a new shortcut gets its site icon from the page', dial);

  await run({ action: 'close', tabId: '*' });
  report.passed = report.failures.length === 0;
}

async function assertRejects(fn, pattern, name) {
  try {
    await fn();
    check(false, name, 'did not reject');
  } catch (error) {
    check(pattern.test(error.message), name, error.message);
  }
}

// A step that never settles must still end the run with a report instead of hanging.
setTimeout(() => {
  report.failures.push('watchdog: the run did not finish within 150 s');
  console.log(JSON.stringify(report, null, 1));
  app.exit(1);
}, 150000).unref();

app.whenReady()
  .then(main)
  .catch((error) => { report.failures.push(`crash: ${error.stack || error.message}`); })
  .finally(() => {
    server.close();
    console.log(JSON.stringify(report, null, 1));
    app.exit(report.failures.length === 0 && report.passed ? 0 : 1);
  });
