/*
 * Real-Electron test of the Agent pointing at page elements the way a person does (Windows). Not part of `node --test`,
 * because it needs an Electron main process:
 *
 *   packages/desktop/node_modules/electron/dist/electron.exe <absolute path of this file> --profile=<empty dir> [--agent=1]
 *
 * `--agent=1` sends the commands as the Agent does (desktop-size view under DevTools emulation).
 *
 * The window is never shown. It covers: click by visible text with the real mouse (a control that only answers trusted
 * pointer events), an element far below the fold, a clickable <div> found by its words, a covered link (the element's
 * own click() and the cover reported), typing into a field found by its placeholder with Enter, a field that refuses
 * keyboard input (value set directly), appending, a <select> by option label, a contenteditable, waiting for an element
 * to appear and to disappear, and the network-quiet wait. It prints a JSON report and exits 1 at any broken invariant.
 */
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const { mkdirSync } = require('node:fs');

const args = Object.fromEntries(process.argv.slice(2).filter((value) => value.startsWith('--')).map((value) => {
  const [key, ...rest] = value.slice(2).split('=');
  return [key, rest.join('=')];
}));
const profile = args.profile;
const PORT = Number(args.port || 47861);
if (!profile) {
  console.error('usage: electron electron-agent-limbs.e2e.cjs --profile=<dir> [--port=47861]');
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

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Limbs</title></head>
<body style="margin:0;font:14px sans-serif;height:3000px">
<button id="menu" style="position:absolute;left:20px;top:20px">Open menu</button>
<div id="items" style="position:absolute;left:20px;top:60px"></div>
<input id="search" placeholder="Search the site" style="position:absolute;left:300px;top:20px;width:200px">
<input id="masked" aria-label="Phone number" style="position:absolute;left:300px;top:60px;width:200px">
<select id="size" aria-label="Size" style="position:absolute;left:300px;top:100px"><option value="s">Small</option><option value="m">Medium</option><option value="l">Large</option></select>
<div id="editor" contenteditable="true" aria-label="Notes" style="position:absolute;left:300px;top:140px;width:200px;height:40px;border:1px solid #888">old</div>
<div id="more" style="position:absolute;left:20px;top:200px;cursor:pointer"><span>Load more</span></div>
<a id="docs" href="#docs" style="position:absolute;left:20px;top:260px">Read the docs</a>
<div id="cover" style="position:absolute;left:0;top:250px;width:600px;height:40px;background:rgba(0,0,0,.3)"></div>
<button id="far" style="position:absolute;left:20px;top:2400px">Far away button</button>
<div id="toast" style="position:absolute;left:20px;top:320px">Saving…</div>
<div id="log" style="position:absolute;left:20px;top:360px"></div>
<script>
const log = [];
const add = (text) => { log.push(text); document.getElementById('log').textContent = log.join('|'); };
// Like many component libraries: the menu opens on a trusted pointerdown, not on click().
menu.addEventListener('pointerdown', (e) => {
  if (!e.isTrusted) return;
  add('menu:trusted');
  setTimeout(() => { items.innerHTML = '<div role="menuitem" tabindex="0" id="del">Delete item</div>'; document.getElementById('del').addEventListener('click', (ev) => add('delete:' + ev.isTrusted)); }, 1200);
});
search.addEventListener('keydown', (e) => { if (e.key === 'Enter') add('search:' + search.value); });
search.addEventListener('beforeinput', (e) => add('beforeinput'));
masked.addEventListener('beforeinput', (e) => e.preventDefault());
masked.addEventListener('input', () => add('masked:' + masked.value));
size.addEventListener('change', () => add('size:' + size.value));
more.addEventListener('click', (e) => add('more:' + e.isTrusted));
docs.addEventListener('click', (e) => { e.preventDefault(); add('docs:' + e.isTrusted); });
far.addEventListener('click', (e) => add('far:' + e.isTrusted));
setTimeout(() => document.getElementById('toast').remove(), 800);
</script></body></html>`;

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/') { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(PAGE); return; }
  response.writeHead(404); response.end();
});

async function main() {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });
  const origin = `http://127.0.0.1:${PORT}`;
  const window = new BrowserWindow({ width: 1280, height: 900, show: false });
  const { createBrowser } = require('../browser-view.cjs');
  const browser = createBrowser(window, () => {}, { profileDir: profile });
  const run = (command) => browser.command(command, args.agent ? { agent: true } : {});
  const pageLog = async () => (await run({ action: 'exec', tabId: 't', code: "document.getElementById('log').textContent" })).result || '';
  const value = async (selector, property = 'value') => (await run({ action: 'exec', tabId: 't', code: `document.querySelector(${JSON.stringify(selector)}).${property}` })).result;

  await run({ action: 'ensure', tabId: 't', url: `${origin}/` });
  check(await until(async () => { const state = await run({ action: 'state', tabId: 't' }); return state.loading === false && state.title === 'Limbs'; }), 'the page loads');

  // --- click by text with the real mouse, then wait for what it opened -------------------------------------------------
  const opened = await run({ action: 'click', tabId: 't', label: 'Open menu' });
  check(opened.how === 'mouse' && opened.tag === 'button', 'a button found by its words is clicked with the real mouse', opened);
  check((await until(async () => (await pageLog()).includes('menu:trusted'))) !== undefined, 'a control that only answers trusted pointer events reacts', await pageLog());
  const appeared = await run({ action: 'wait', tabId: 't', label: 'Delete item', timeoutMs: 5000 });
  check(appeared.ok && appeared.waitedMs > 0, 'wait returns once the menu item appears', appeared);
  await run({ action: 'click', tabId: 't', label: 'Delete item' });
  check((await until(async () => (await pageLog()).includes('delete:true'))) !== undefined, 'a role=menuitem found by its text takes a trusted click', await pageLog());

  // --- a clickable <div> found by its words; an element far below the fold -------------------------------------------
  const more = await run({ action: 'click', tabId: 't', label: 'load more' });
  check(more.how === 'mouse' && (await until(async () => (await pageLog()).includes('more:true'))), 'plain text in a clickable <div> is found case-insensitively and clicked', more);
  const far = await run({ action: 'click', tabId: 't', label: 'Far away button' });
  check(far.how === 'mouse' && far.y > 0 && far.y < 800, 'an element below the fold is scrolled into view and clicked at its new place', far);
  check((await until(async () => (await pageLog()).includes('far:true'))) !== undefined, 'the far button received a trusted click', await pageLog());
  await run({ action: 'exec', tabId: 't', code: 'scrollTo(0, 0)' });

  // --- a covered link ------------------------------------------------------------------------------------------------
  const docs = await run({ action: 'click', tabId: 't', label: 'Read the docs' });
  check(docs.how === 'script' && docs.covered?.id === 'cover', 'a covered link is clicked through its own click() and the cover is named', docs);
  check((await until(async () => (await pageLog()).includes('docs:false'))) !== undefined, 'the covered link still received the click', await pageLog());

  // --- typing --------------------------------------------------------------------------------------------------------
  const typed = await run({ action: 'type', tabId: 't', label: 'Search the site', text: 'electron 45', enter: true });
  check(typed.how === 'keyboard' && typed.value === 'electron 45', 'a field found by its placeholder is typed into through the keyboard', typed);
  check((await until(async () => (await pageLog()).includes('search:electron 45'))) !== undefined && (await pageLog()).includes('beforeinput'), 'the page saw real input events and Enter with the typed value', await pageLog());
  const replaced = await run({ action: 'type', tabId: 't', selector: '#search', text: 'vitest' });
  check(replaced.value === 'vitest', 'typing again replaces what the field held', replaced);
  const appended = await run({ action: 'type', tabId: 't', selector: '#search', text: ' 4', replace: false });
  check(appended.value === 'vitest 4', 'replace=false appends at the end', appended);
  const masked = await run({ action: 'type', tabId: 't', label: 'Phone number', text: '555-0100' });
  check(masked.how === 'script' && (await value('#masked')) === '555-0100', 'a field that refuses keyboard input gets its value set directly, and says so', masked);
  const size = await run({ action: 'type', tabId: 't', label: 'Size', text: 'large' });
  check(size.how === 'select' && (await value('#size')) === 'l' && (await pageLog()).includes('size:l'), 'a <select> picks the option by its label and fires change', size);
  const notes = await run({ action: 'type', tabId: 't', label: 'Notes', text: 'new text' });
  check((await value('#editor', 'innerText')) === 'new text', 'a contenteditable is replaced by typed text', { notes, now: await value('#editor', 'innerText') });
  let refused;
  try { await run({ action: 'type', tabId: 't', label: 'No such field anywhere', text: 'x' }); } catch (error) { refused = error.message; }
  check(/nothing visible on the page reads/.test(refused || ''), 'an element that is not on the page is an error that says so', refused);

  // --- waiting --------------------------------------------------------------------------------------------------------
  const gone = await run({ action: 'wait', tabId: 't', text: 'Saving…', gone: true, timeoutMs: 5000 });
  check(gone.ok, 'wait with gone returns once the text has disappeared', gone);
  const timedOut = await run({ action: 'wait', tabId: 't', selector: '#never', timeoutMs: 400 });
  check(timedOut.ok === false && timedOut.timeout === true && timedOut.waitedMs >= 400, 'a wait that times out says so instead of hanging', timedOut);
  const quiet = await run({ action: 'wait', tabId: 't', timeoutMs: 5000 });
  check(quiet.ok, 'without a condition, wait returns when the page is loaded and quiet', quiet);

  // --- interactive listing ---------------------------------------------------------------------------------------------
  const list = (await run({ action: 'interactive', tabId: 't' })).elements;
  const farEntry = list.find((entry) => entry.id === 'far');
  check(farEntry && farEntry.visible === true && farEntry.inView === false, 'the listing marks an element below the fold as off-screen', farEntry);
  check(list.find((entry) => entry.id === 'size')?.value === 'l', 'the listing shows a field\'s current value', list.find((entry) => entry.id === 'size'));
  const byIndex = await run({ action: 'click', tabId: 't', index: list.findIndex((entry) => entry.id === 'menu') });
  check(byIndex.how === 'mouse', 'an index from the listing is clicked with the real mouse', byIndex);

  await run({ action: 'close', tabId: '*' });
  report.passed = report.failures.length === 0;
}

setTimeout(() => {
  report.failures.push('watchdog: the run did not finish within 120 s');
  console.log(JSON.stringify(report, null, 1));
  app.exit(1);
}, 120000).unref();

app.whenReady()
  .then(main)
  .catch((error) => { report.failures.push(`crash: ${error.stack || error.message}`); })
  .finally(() => {
    server.close();
    console.log(JSON.stringify(report, null, 1));
    app.exit(report.failures.length === 0 && report.passed ? 0 : 1);
  });
