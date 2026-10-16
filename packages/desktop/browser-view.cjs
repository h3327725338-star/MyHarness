const { WebContentsView, session, Menu, shell } = require('electron');
exports.httpUrl = (value) => {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('只允许 http 或 https 网页地址');
  return url.href;
};
exports.createBrowser = (window, log) => {
  let view, timer, rectangle;
  const status = (value) => { if (!window.isDestroyed()) window.webContents.send('desktop:status', value); };
  const destroy = () => {
    clearTimeout(timer);
    if (view) {
      window.contentView.removeChildView(view);
      view.webContents.close({ waitForBeforeUnload: false });
      view = undefined;
    }
  };
  const fail = (message, url) => { log(message); destroy(); status({ error: `网页加载失败：${message}`, url }); };
  const bounds = (rect) => {
    rectangle = rect;
    if (!view) return;
    const [width, height] = window.getContentSize();
    const valid = rect && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(rect[key]));
    if (!valid || rect.width < 1 || rect.height < 1) { view.setVisible(false); return; }
    const x = Math.max(0, Math.min(width, Math.round(rect.x)));
    const y = Math.max(0, Math.min(height, Math.round(rect.y)));
    view.setBounds({ x, y, width: Math.max(0, Math.min(width - x, Math.round(rect.width))), height: Math.max(0, Math.min(height - y, Math.round(rect.height))) });
    view.setVisible(true);
  };
  const navigate = async (value) => {
    const url = exports.httpUrl(value);
    destroy();
    const partition = session.fromPartition('persist:myharness-third-party');
    partition.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    partition.setPermissionCheckHandler(() => false);
    view = new WebContentsView({ webPreferences: { session: partition, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    const current = view;
    window.contentView.addChildView(current);
    bounds(rectangle);
    current.webContents.on('will-navigate', (event, target) => { try { exports.httpUrl(target); } catch { event.preventDefault(); } });
    current.webContents.setWindowOpenHandler(({ url: target }) => {
      try { void navigate(exports.httpUrl(target)).catch((e) => fail(e.message, target)); } catch { /* Reject non-web schemes. */ }
      return { action: 'deny' };
    });
    current.webContents.on('context-menu', (_event, params) => Menu.buildFromTemplate([
      { role: 'undo', enabled: params.isEditable }, { role: 'redo', enabled: params.isEditable },
      { type: 'separator' }, { role: 'cut', enabled: params.isEditable }, { role: 'copy' },
      { role: 'paste', enabled: params.isEditable }, { role: 'selectAll' },
      { type: 'separator' }, { label: '用系统浏览器打开', click: () => void shell.openExternal(exports.httpUrl(current.webContents.getURL())) },
    ]).popup({ window }));
    current.webContents.on('did-start-loading', () => {
      clearTimeout(timer);
      timer = setTimeout(() => { if (view === current) fail('加载超时（45 秒）', current.webContents.getURL() || url); }, 45000);
    });
    current.webContents.on('did-stop-loading', () => clearTimeout(timer));
    current.webContents.on('did-navigate', (_event, target) => status({ url: target }));
    current.webContents.on('did-fail-load', (_event, code, description, target, mainFrame) => {
      if (mainFrame && code !== -3 && view === current) fail(`${description} (${code})`, target || url);
    });
    current.webContents.on('render-process-gone', (_event, detail) => { if (view === current) fail(detail.reason, url); });
    try { await current.webContents.loadURL(url); if (view === current) status({ url, ready: true }); }
    catch (error) { if (view === current) fail(error.message, url); }
    return { ok: true };
  };
  return { navigate, bounds, destroy, get view() { return view; } };
};
