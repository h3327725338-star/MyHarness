const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const { spawn } = require('node:child_process');
const { mkdirSync, appendFileSync, readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { homedir } = require('node:os');
const { createBrowser, httpUrl } = require('./browser-view.cjs');
const { readLegacyPrefs } = require('./legacy-prefs.cjs');
const { removeForeignShortcuts } = require('./notification-routing.cjs');
const root = resolve(__dirname, '../..');
// Windows finds the app behind a toast click through this id and starts the executable that the matching Start Menu
// shortcut names. A development run of electron.exe gets an id of its own: Electron writes that shortcut without the app
// path, so sharing the installed app's id would let a click start Electron's default window instead of MyHarness.
const notificationAppId = app.isPackaged ? 'MyHarness' : 'MyHarness.Dev';
// The packaged app retains the checkout's data anchor, not the exe's arbitrary directory.
const anchor = app.isPackaged ? JSON.parse(readFileSync(join(__dirname, 'runtime.json'), 'utf8')).workingDirectory : root;
const cwd = resolve(process.env.MYHARNESS_DESKTOP_CWD || anchor);
const data = resolve(process.env.MYHARNESS_DATA_ROOT || join(cwd, 'data'));
const logs = join(data, 'logs');
mkdirSync(logs, { recursive: true });
const log = (message) => appendFileSync(join(logs, 'web-launch.err.log'), `[desktop ${new Date().toISOString()}] ${message}\n`);
let window, browser, child, job, serviceUrl, stopping = false, finished = false;
// Workspace commands are executed by the page itself (it owns the tab list and the media elements). One request is one
// round trip: the page answers with the state it reached, so the caller can verify the result instead of assuming it.
// A reload, a closed window or a timeout fails the pending request instead of hanging.
const pendingUi = new Map();
const settleUi = (requestId, ok, payload) => {
  const entry = pendingUi.get(requestId);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pendingUi.delete(requestId);
  if (ok) entry.resolve(payload);
  else entry.reject(new Error(String(payload || '页面执行失败')));
  return true;
};
const failPendingUi = (reason) => {
  for (const [requestId, entry] of pendingUi) {
    clearTimeout(entry.timer);
    pendingUi.delete(requestId);
    entry.reject(new Error(reason));
  }
};
const workspaceRequest = (command, timeoutMs = 15000) => new Promise((resolve, reject) => {
  if (!window || window.isDestroyed()) return reject(new Error('应用窗口已关闭'));
  const requestId = `ui${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const timer = setTimeout(() => { pendingUi.delete(requestId); reject(new Error('前端工作区未在超时内响应')); }, timeoutMs);
  pendingUi.set(requestId, { resolve, reject, timer });
  window.webContents.send('desktop:workspace', { requestId, command });
});
// Host browser storage only; Agent configuration and persisted data are not redirected.
app.setPath('userData', join(process.env.MYHARNESS_CODING_AGENT_DIR || join(homedir(), '.myharness', 'agent'), 'desktop-profile'));
app.setName('MyHarness');
const escaped = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// The window has no system title bar (frame: false), so the two pages the host shows itself (starting, cannot start) carry
// their own drag strip and window buttons. They are the only non-service pages allowed to use the window controls: the
// IPC check compares the sender with the exact page loaded here.
let shellUrl;
// Colors are the dark theme's own values (tokens.css is not loaded on these pages).
const shellGlyph = { min: '<path d="M6 12h12"/>', max: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>', restore: '<rect x="6" y="8.5" width="9.5" height="9.5" rx="1.5"/><path d="M8.5 8.5V7.5A1.5 1.5 0 0 1 10 6h6.5A1.5 1.5 0 0 1 18 7.5V14a1.5 1.5 0 0 1-1.5 1.5h-1"/>', close: '<path d="M6 18 18 6M6 6l12 12"/>' };
const shellButton = (action, label, glyph, id = '') => `<button ${id ? `id="${id}" ` : ''}aria-label="${label}" title="${label}" onclick="myHarnessDesktop.windowControls.${action}()"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${glyph}</svg></button>`;
const loadShell = (body) => {
  const style = '<style>.wc{position:fixed;top:0;right:0;height:44px;display:flex;color:#a8adad;-webkit-app-region:no-drag}.wc button{width:46px;height:44px;border:0;border-radius:0;background:transparent;color:inherit;display:inline-flex;align-items:center;justify-content:center}.wc button:hover{background:#2a2c2c;color:#eee}.wc #wc-close:hover{background:#e8665f;color:#fff}</style>';
  const sync = `<script>{const b=document.getElementById('wc-max'),c=window.myHarnessDesktop&&myHarnessDesktop.windowControls,g=${JSON.stringify({ max: shellGlyph.max, restore: shellGlyph.restore })},s=(v)=>{b.querySelector('svg').innerHTML=v&&v.maximized?g.restore:g.max;};if(c){c.state().then(s,()=>{});c.onState(s);}}</script>`;
  const bar = `<div style="position:fixed;top:0;left:0;right:0;height:44px;-webkit-app-region:drag"></div><div class="wc">${shellButton('minimize', '最小化', shellGlyph.min)}${shellButton('toggleMaximize', '最大化/还原', shellGlyph.max, 'wc-max')}${shellButton('close', '关闭', shellGlyph.close, 'wc-close')}</div>`;
  shellUrl = `data:text/html;charset=utf-8,${encodeURIComponent(`<html lang="zh-CN"><meta charset="utf-8"><title>MyHarness</title>${style}<body style="margin:0;background:#1e1f1f;color:#eee;font:16px system-ui;padding:64px 48px 48px">${bar}${body}${sync}</body></html>`)}`;
  return window.loadURL(shellUrl);
};
const errorPage = async (message) => {
  log(message);
  if (!window || window.isDestroyed()) { dialog.showErrorBox('MyHarness 桌面端启动失败', `${message}\n日志：${logs}`); return; }
  browser?.destroy();
  await loadShell(`<h2>MyHarness 无法启动</h2><pre style="white-space:pre-wrap">${escaped(message)}</pre><p>日志：${escaped(logs)}</p><p>请关闭窗口后重新启动。</p>`);
  window.show();
};
async function stop() {
  if (stopping) return;
  stopping = true;
  browser?.destroy();
  if (child && child.exitCode === null && serviceUrl) {
    try { await fetch(new URL('/api/shutdown', serviceUrl), { method: 'POST', headers: { 'x-myharness-web': '1' }, signal: AbortSignal.timeout(2000) }); } catch (error) { log(`正常退出请求：${error.message}`); }
    await Promise.race([new Promise((done) => child.once('exit', done)), new Promise((done) => setTimeout(done, 8000))]);
  }
  // KILL_ON_JOB_CLOSE handles remaining PTYs, shells, tasks and restart descendants.
  job?.close(); job = undefined;
  finished = true;
  app.quit();
}
// Earlier windows kept appearance preferences only in their own (random-port) origin. Move the user's choices to the
// shared server copy once; when they exist but cannot be read, the page says the defaults are in use.
async function migratePrefs(url) {
  try {
    const headers = { 'x-myharness-web': '1', 'content-type': 'application/json' };
    const current = await (await fetch(new URL('/api/web-prefs', url), { signal: AbortSignal.timeout(5000) })).json();
    if (current?.prefs) return '';
    const legacy = readLegacyPrefs(app.getPath('userData'));
    if (legacy?.unreadable) return '?prefsReset=1';
    if (legacy?.prefs) {
      const response = await fetch(new URL('/api/web-prefs', url), { method: 'PUT', headers, body: JSON.stringify(legacy), signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      log('已把早期桌面窗口的外观偏好迁移到共享设置');
    }
  } catch (error) { log(`外观偏好迁移失败：${error.message}`); }
  return '';
}
function startService(restart) {
  serviceUrl = undefined;
  let requestedRestart;
  const entry = app.isPackaged ? join(__dirname, 'runtime/node_modules/@myharness/coding-agent/dist/web.js') : join(root, 'packages/coding-agent/src/web.ts');
  const loader = app.isPackaged ? undefined : join(root, 'scripts/dev-fast-loader.mjs');
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', MYHARNESS_PROCESS_ENTRY: entry, MYHARNESS_DATA_ROOT: data, MYHARNESS_DESKTOP_HOST: '1' };
  if (loader) env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --import=${require('node:url').pathToFileURL(loader).href}`.trim();
  if (app.isPackaged) env.MYHARNESS_SYSTEM_PROMPT_DIR = join(__dirname, 'runtime/system-prompts');
  job?.close();
  job = require('./windows-job.cjs').createJob();
  child = spawn(process.execPath, [join(__dirname, 'service-entry.cjs')], { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const timeout = setTimeout(() => { if (!serviceUrl) { void errorPage('本地服务启动超时（180 秒）'); job?.close(); job = undefined; } }, 180000);
  let pending = '';
  for (const [stream, filename] of [[child.stdout, 'web-launch.out.log'], [child.stderr, 'web-launch.err.log']]) {
    stream.on('data', (chunk) => {
      appendFileSync(join(logs, filename), chunk);
      pending = (pending + chunk.toString()).slice(-16000);
      const found = pending.match(/MyHarness Web UI: (http:\/\/127\.0\.0\.1:\d+\/)/);
      if (found && !serviceUrl) {
        clearTimeout(timeout); serviceUrl = found[1];
        void migratePrefs(serviceUrl).then((query) => window.loadURL(serviceUrl + query)).then(() => window.show()).catch((error) => errorPage(`界面加载失败：${error.message}`));
      }
    });
  }
  child.once('spawn', () => {
    try { job.assign(child.pid); child.send({ type: 'start', entry, args: ['--port', String(restart?.port || 0), '--no-open', ...(restart?.session ? ['--session', restart.session] : ['--continue'])], loader }); }
    catch (error) { child.kill(); void errorPage(`无法建立服务进程管理：${error.message}`); }
  });
  child.once('error', (error) => { clearTimeout(timeout); void errorPage(`本地服务启动失败：${error.message}`); });
  let restartDeadline;
  child.on('message', (message) => {
    // The Agent session's workspace tool asks the host process for browser or page commands; the answer goes back over
    // the same channel with the request id. Nothing here trusts the child: each command is validated by the browser
    // command surface or by the page itself.
    if (message?.type === 'myharness:browser-command') {
      const requestId = String(message.requestId || '');
      Promise.resolve()
        .then(() => (message.action === 'workspace' ? workspaceRequest(message.command, Number(message.timeoutMs) || 15000) : browser.command(message.command, { agent: true })))
        .then((value) => { try { child.send({ type: 'myharness:browser-result', requestId, ok: true, value }); } catch (error) { log(`无法回传浏览器命令结果：${error.message}`); } })
        .catch((error) => { try { child.send({ type: 'myharness:browser-result', requestId, ok: false, error: error?.message || String(error) }); } catch { /* child already gone */ } });
      return;
    }
    if (message?.type !== 'myharness:restart') return;
    // This message is sent only after runtime disposal and HTTP close. Background
    // handles may still keep Node alive; don't let them strand a completed restart.
    requestedRestart = message;
    restartDeadline = setTimeout(() => { job?.close(); job = undefined; }, 1500);
  });
  child.once('exit', (code) => {
    clearTimeout(timeout);
    clearTimeout(restartDeadline);
    if (!stopping && requestedRestart) { startService(requestedRestart); return; }
    if (!stopping) void errorPage(`本地服务已退出（${code}）。请查看日志中的具体原因。`);
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('before-quit', (event) => { if (!finished) { event.preventDefault(); void stop(); } });
  app.whenReady().then(async () => {
    app.setAppUserModelId(notificationAppId);
    // A shortcut left by an earlier development run (bare electron.exe, no app path) or by a build folder that was
    // removed still claims this id, and Windows may pick it over this app's own shortcut on a toast click. Electron
    // writes its own shortcut again before the next notification, so the ones that cannot start this app are removed.
    if (app.isPackaged) void removeForeignShortcuts({ aumid: notificationAppId, log });
    window = new BrowserWindow({ width: 1440, height: 960, minWidth: 980, minHeight: 600, show: false, frame: false, title: 'MyHarness', backgroundColor: '#1e1f1f', icon: join(__dirname, 'icon.png'), webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    window.setMenu(null);
    browser = createBrowser(window, log, { workspaceRoot: cwd, profileDir: app.getPath('userData') });
    const trusted = (event) => event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && serviceUrl && new URL(event.senderFrame.url).origin === new URL(serviceUrl).origin;
    // Window buttons of the frameless window. The app page may use them, and so may the host's own starting/error page
    // (exactly the page loadShell produced, in the main frame); no other page or frame gets them.
    const windowCaller = (event) => trusted(event) || (event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && !!shellUrl && event.senderFrame.url === shellUrl);
    const windowState = () => ({ maximized: window.isMaximized(), fullScreen: window.isFullScreen() });
    ipcMain.handle('desktop:window', (event, action) => {
      if (!windowCaller(event)) throw new Error('拒绝非应用页面调用');
      if (action === 'minimize') window.minimize();
      else if (action === 'toggleMaximize') { if (window.isMaximized()) window.unmaximize(); else window.maximize(); }
      // Same path as the system close: the 'close' handler hides the window and stops the local service.
      else if (action === 'close') window.close();
      else if (action !== 'state') throw new Error('未知的窗口操作');
      return windowState();
    });
    const handleBrowserCommand = async (command) => {
      if (command && typeof command === 'object' && command.action === 'workspace') return workspaceRequest(command.command, Number(command.timeoutMs) || 15000);
      return browser.command(command);
    };
    ipcMain.handle('desktop:workspace-reply', (event, payload) => {
      if (!trusted(event)) throw new Error('拒绝非应用页面调用');
      const requestId = payload && typeof payload.requestId === 'string' ? payload.requestId : '';
      if (!requestId || !pendingUi.has(requestId)) return { ok: false, error: '未知或已超时的工作区请求' };
      settleUi(requestId, payload.ok === true, payload.ok === true ? payload.result : payload.error);
      return { ok: true };
    });
    // Native Windows notifications (toasts) owned by this app instead of PowerShell. The page plays the sound itself, so the
    // toast is silent; a click brings the window forward and tells the page which chat the notification was about. No
    // `icon` is passed on purpose: that image is a second logo beside the text, and without it the whole content area
    // belongs to the message. The small app logo in the toast header comes from the app itself, not from this option.
    const toasts = new Map();
    ipcMain.handle('desktop:notify', (event, payload) => {
      if (!trusted(event)) throw new Error('拒绝非应用页面调用');
      if (!Notification.isSupported() || !payload || typeof payload !== 'object') return false;
      const text = (value, max) => String(value ?? '').slice(0, max);
      const tag = text(payload.tag, 200);
      toasts.get(tag)?.close();
      const toast = new Notification({ title: text(payload.title, 120), body: text(payload.body, 300), silent: true });
      toast.on('click', () => {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        if (!window.webContents.isDestroyed()) window.webContents.send('desktop:notification-click', tag);
      });
      toast.on('close', () => { if (toasts.get(tag) === toast) toasts.delete(tag); });
      toasts.set(tag, toast);
      toast.show();
      return true;
    });
    ipcMain.handle('desktop:navigate', (event, url) => { if (!trusted(event)) throw new Error('拒绝非应用页面调用'); return browser.navigate(url); });
    ipcMain.handle('desktop:external', (event, url) => { if (!trusted(event)) throw new Error('拒绝非应用页面调用'); return shell.openExternal(httpUrl(url)); });
    // The workspace bridge: every browser tab, navigation, snapshot, script, accessibility tree and click goes through
    // this one command surface. Only the app's own page (same service origin, main frame) may call it.
    ipcMain.handle('desktop:browser', (event, command) => { if (!trusted(event)) throw new Error('拒绝非应用页面调用'); return handleBrowserCommand(command); });
    ipcMain.handle('desktop:open-path', async (event, target) => {
      if (!trusted(event)) throw new Error('拒绝非应用页面调用');
      if (typeof target !== 'string' || !target || !require('node:path').isAbsolute(target)) throw new Error('需要绝对路径');
      return (await shell.openPath(target)) || null;
    });
    ipcMain.handle('desktop:reveal-path', (event, target) => {
      if (!trusted(event)) throw new Error('拒绝非应用页面调用');
      if (typeof target !== 'string' || !target || !require('node:path').isAbsolute(target)) throw new Error('需要绝对路径');
      shell.showItemInFolder(target);
      return { ok: true };
    });
    ipcMain.on('desktop:bounds', (event, rect) => { if (trusted(event)) browser.bounds(rect); });
    ipcMain.on('desktop:destroy', (event) => { if (trusted(event)) browser.destroy(); });
    window.webContents.setWindowOpenHandler(({ url }) => { try { void shell.openExternal(httpUrl(url)); } catch {} return { action: 'deny' }; });
    window.webContents.on('will-navigate', (event, url) => { if (serviceUrl && new URL(url).origin !== new URL(serviceUrl).origin) event.preventDefault(); });
    window.webContents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => { if (mainFrame) { failPendingUi('页面已重新加载，工作区请求已取消'); browser.destroy(); } });
    // Moving, resizing or maximizing the window changes the content area that the page measured. Re-clamp the last
    // rectangle immediately; the page also re-measures every frame while a browser tab is active.
    for (const event of ['resize', 'maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen', 'show'])
      window.on(event, () => browser?.refresh());
    // The page's maximize/restore button follows the real state, whatever changed it (button, double-click, Snap, Win+Up, taskbar).
    for (const event of ['maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen'])
      window.on(event, () => { if (!window.webContents.isDestroyed()) window.webContents.send('desktop:window-state', windowState()); });
    window.on('close', (event) => { if (!finished) { event.preventDefault(); window.hide(); void stop(); } });
    await loadShell('<span style="color:#ccc">正在启动 MyHarness…</span>');
    window.show();
    startService();
  }).catch((error) => void errorPage(error.stack || error.message));
}
process.on('uncaughtException', (error) => { void errorPage(error.stack || error.message); });
