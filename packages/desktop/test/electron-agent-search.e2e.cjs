/*
 * Real-Electron test of the Agent finding things on app-like pages (Windows). Not part of `node --test`, because it needs
 * an Electron main process:
 *
 *   packages/desktop/node_modules/electron/dist/electron.exe <absolute path of this file> --profile=<empty dir>
 *
 * The window is never shown. The page is built like a web app such as Teams: the document itself does not scroll, a
 * chat list scrolls inside it and renders its rows lazily, a second list scrolls only through its own wheel handler, a
 * control lives inside a web component (shadow DOM), and names are full of the letter "s". It covers: a point's text
 * read back with every "s" intact, a label copied from a screenshot (cut off with "…", punctuation lost), "closest
 * visible texts" when nothing matches, a button inside a shadow root (label and index), scrolling the list under a
 * point, scrolling until words appear, the wheel fallback, `find` returning the elements with their positions, a clear
 * error for a Playwright-style selector and for a throwing script, and `type` replacing a focused field. It prints a
 * JSON report and exits 1 at any broken invariant.
 */
const { app, BrowserWindow } = require('electron');
const http = require('node:http');
const { mkdirSync } = require('node:fs');

const args = Object.fromEntries(process.argv.slice(2).filter((value) => value.startsWith('--')).map((value) => {
  const [key, ...rest] = value.slice(2).split('=');
  return [key, rest.join('=')];
}));
const profile = args.profile;
const PORT = Number(args.port || 47863);
if (!profile) {
  console.error('usage: electron electron-agent-search.e2e.cjs --profile=<dir> [--port=47863]');
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

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>App</title>
<style>
html, body { margin: 0; height: 100%; overflow: hidden; font: 14px sans-serif; }
#rail { position: absolute; left: 0; top: 0; width: 60px; height: 100%; }
#chats { position: absolute; left: 70px; top: 40px; width: 300px; height: 400px; overflow-y: auto; border: 1px solid #888; }
#chats .row { height: 40px; line-height: 40px; padding: 0 8px; cursor: pointer; }
#wheel { position: absolute; left: 400px; top: 40px; width: 300px; height: 200px; overflow: hidden; border: 1px solid #888; }
#wheel-inner { position: relative; }
#search { position: absolute; left: 400px; top: 300px; width: 250px; }
</style></head>
<body>
<div id="rail"><my-tab></my-tab></div>
<div id="chats" role="list"></div>
<div id="wheel"><div id="wheel-inner"></div></div>
<input id="search" placeholder="Search chats" value="Taylors DSA Lecture">
<div id="log" style="position:absolute;left:400px;top:340px"></div>
<script>
const log = [];
const add = (text) => { log.push(text); document.getElementById('log').textContent = log.join('|'); };
customElements.define('my-tab', class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<button id="inner" style="width:56px;height:40px">Chats</button>';
    root.getElementById('inner').addEventListener('click', (e) => add('chats:' + e.isTrusted));
  }
});
// A lazily rendered list: 20 rows at first, 20 more each time it is scrolled near the end (up to 200).
const chats = document.getElementById('chats');
let rendered = 0;
const names = (i) => i === 137 ? "Taylor's DSA in:CAO Lecture Class (Week 14_21/07) - Section 1" : 'Chat number ' + i + ' with classmates';
const more = () => { for (let i = 0; i < 20 && rendered < 200; i++, rendered++) { const row = document.createElement('div'); row.className = 'row'; row.setAttribute('role', 'listitem'); row.textContent = names(rendered); row.addEventListener('click', (e) => add('row:' + row.textContent + ':' + e.isTrusted)); chats.appendChild(row); } };
more();
chats.addEventListener('scroll', () => { if (chats.scrollTop + chats.clientHeight > chats.scrollHeight - 80) more(); });
// A list that never scrolls natively: its own wheel handler moves the rows.
const inner = document.getElementById('wheel-inner');
for (let i = 0; i < 60; i++) { const row = document.createElement('div'); row.style.height = '30px'; row.textContent = 'Wheel row ' + i; inner.appendChild(row); }
let offset = 0;
document.getElementById('wheel').addEventListener('wheel', (e) => { e.preventDefault(); offset = Math.max(0, Math.min(1600, offset + e.deltaY)); inner.style.top = -offset + 'px'; add('wheel'); }, { passive: false });
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
  const run = (command) => browser.command(command, { agent: true });
  const pageLog = async () => (await run({ action: 'exec', tabId: 't', code: "document.getElementById('log').textContent" })).result || '';
  const failure = async (command) => { try { await run(command); return ''; } catch (error) { return error.message; } };

  await run({ action: 'ensure', tabId: 't', url: `${origin}/` });
  check(await until(async () => { const state = await run({ action: 'state', tabId: 't' }); return state.loading === false && state.title === 'App'; }), 'the page loads');

  // --- what is under a point is read with its text intact ---------------------------------------------------------------
  const point = await run({ action: 'mouse', tabId: 't', kind: 'move', x: 150, y: 60 });
  const pressed = await run({ action: 'mouse', tabId: 't', kind: 'click', x: 150, y: 60 });
  check(pressed.target?.text === 'Chat number 0 with classmates', 'the element under a point is described with every letter s', { point, pressed: pressed.target });

  // --- a control inside a shadow root ----------------------------------------------------------------------------------
  const shadow = await run({ action: 'click', tabId: 't', label: 'Chats' });
  check(shadow.how === 'mouse' && (await until(async () => (await pageLog()).includes('chats:true'))), 'a button inside a shadow root is found by its words and clicked with the real mouse', { shadow, log: await pageLog() });
  const list = (await run({ action: 'interactive', tabId: 't' })).elements;
  const shadowIndex = list.findIndex((entry) => entry.id === 'inner');
  check(shadowIndex >= 0, 'the listing includes controls inside shadow roots', list.slice(0, 5));
  const byIndex = await run({ action: 'click', tabId: 't', index: shadowIndex });
  check(byIndex.tag === 'button' && byIndex.how === 'mouse', 'the same shadow control is clicked by its index', byIndex);

  // --- scrolling an inner list -----------------------------------------------------------------------------------------
  const page = await run({ action: 'scroll', tabId: 't', atX: 150, atY: 200, deltaY: 400 });
  check(page.how === 'script' && page.moved === 400 && page.container?.tag === 'div', 'the list under a point scrolls (the document itself cannot)', page);
  const top = await run({ action: 'exec', tabId: 't', code: "document.getElementById('chats').scrollTop" });
  check(top.result === 400, 'the list really moved', top);
  const back = await run({ action: 'scroll', tabId: 't', label: 'Chat number 12 with classmates', deltaY: -400 });
  check(back.moved === 400 && back.atEnd === true, 'a list found through an element in it scrolls back to its top', back);
  const plain = await run({ action: 'scroll', tabId: 't', y: 120 });
  check(plain.moved === 120, 'the older form (only y) scrolls the main list when the document cannot scroll', plain);

  // --- scrolling until words appear (rows rendered lazily) --------------------------------------------------------------
  const found = await run({ action: 'scroll', tabId: 't', atX: 150, atY: 200, deltaY: 'page', until: 'DSA in:CAO Lecture' });
  check(found.found && /DSA in:CAO Lecture/.test(found.found.text) && found.found.y > 40 && found.found.y < 440 && found.steps > 3, 'scroll until finds a row that was not rendered at first and says where it is', found);
  const missing = await run({ action: 'scroll', tabId: 't', atX: 150, atY: 200, deltaY: 'page', until: 'No such chat anywhere', maxSteps: 60 });
  check(missing.found === null && missing.atEnd === true, 'scroll until stops at the end of the list and says the words never appeared', missing);

  // --- a label copied from a screenshot --------------------------------------------------------------------------------
  const copied = await run({ action: 'click', tabId: 't', label: 'Taylors DSA inCAO Lecture Class (Week 14_21/07) - Se...' });
  check(copied.how === 'mouse' && (await until(async () => (await pageLog()).includes("row:Taylor's DSA in:CAO"))), 'a label cut off with "..." and missing punctuation still finds the row', { copied, log: await pageLog() });
  const near = await failure({ action: 'click', tabId: 't', label: 'Taylors DSA Tutorial group' });
  check(/closest visible texts: .*DSA in:CAO/.test(near), 'a label that matches nothing lists the closest visible texts', near);

  // --- a list that scrolls only through its wheel handler --------------------------------------------------------------
  const wheel = await run({ action: 'scroll', tabId: 't', atX: 500, atY: 100, deltaY: 300 });
  check(wheel.how === 'wheel' && wheel.changed === true && (await pageLog()).includes('wheel'), 'a list without native scrolling gets a real mouse wheel, and the result says its content changed', wheel);

  // --- find returns the elements that hold the words -------------------------------------------------------------------
  const finding = await run({ action: 'find', tabId: 't', text: 'Wheel row 3' });
  check(finding.matches >= 1 && finding.elements?.[0]?.text?.startsWith('Wheel row 3') && Number.isFinite(finding.elements[0].x), 'find returns the matching elements with their positions', finding);

  // --- clear errors -----------------------------------------------------------------------------------------------------
  const badSelector = await failure({ action: 'click', tabId: 't', selector: 'span:has-text("Chat")' });
  check(/not a valid CSS selector.*use label/.test(badSelector), 'a Playwright-style selector is refused with a clear reason', badSelector);
  const thrown = await failure({ action: 'exec', tabId: 't', code: 'null.length' });
  check(/页面脚本出错.*TypeError/.test(thrown), 'a throwing script reports the page\'s real error', thrown);
  const awaited = await run({ action: 'exec', tabId: 't', code: 'await new Promise((r) => setTimeout(() => r(41 + 1), 50))' });
  check(awaited.result === 42, 'a script may await at the top level', awaited);

  // --- typing into the focused field replaces it -----------------------------------------------------------------------
  await run({ action: 'mouse', tabId: 't', kind: 'click', x: 520, y: 310 });
  const typed = await run({ action: 'insertText', tabId: 't', text: 'DSA', replace: 'fields' });
  check(typed.focused?.value === 'DSA', 'typing into the focused field with replace takes its place', typed);
  const appended = await run({ action: 'insertText', tabId: 't', text: ' Lecture' });
  check(appended.focused?.value === 'DSA Lecture', 'without replace the text is appended', appended);

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
