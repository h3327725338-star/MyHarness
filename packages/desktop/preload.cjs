const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('myHarnessDesktop', Object.freeze({
  // Engine versions of this host, shown in the built-in browser so the user can tell which Chromium it runs.
  versions: Object.freeze({ chrome: process.versions.chrome, electron: process.versions.electron }),
  // Structured bridge for the workspace: browser tabs, navigation, snapshots, page scripts, accessibility and files.
  browser: (command) => ipcRenderer.invoke('desktop:browser', command),
  // Commands the host process asks the page to run on its workspace tabs (open/close/activate/media), and the answer
  // to such a command. The page owns the tab list, so it reports the state it actually reached.
  onWorkspace(callback) {
    const handler = (_event, request) => callback(request);
    ipcRenderer.on('desktop:workspace', handler);
    return () => ipcRenderer.removeListener('desktop:workspace', handler);
  },
  replyWorkspace: (payload) => ipcRenderer.invoke('desktop:workspace-reply', payload),
  // Native notification (a Windows toast owned by MyHarness). Resolves true when it was shown; a click on it arrives as the tag.
  notify: (payload) => ipcRenderer.invoke('desktop:notify', payload),
  onNotificationClick(callback) {
    const handler = (_event, tag) => callback(tag);
    ipcRenderer.on('desktop:notification-click', handler);
    return () => ipcRenderer.removeListener('desktop:notification-click', handler);
  },
  openPath: (target) => ipcRenderer.invoke('desktop:open-path', target),
  revealPath: (target) => ipcRenderer.invoke('desktop:reveal-path', target),
  // Buttons of the frameless window: each call resolves to { maximized, fullScreen } after the action; onState reports
  // changes made any other way (double-click on the drag area, Snap, Win+Up, the taskbar).
  windowControls: Object.freeze({
    minimize: () => ipcRenderer.invoke('desktop:window', 'minimize'),
    toggleMaximize: () => ipcRenderer.invoke('desktop:window', 'toggleMaximize'),
    close: () => ipcRenderer.invoke('desktop:window', 'close'),
    state: () => ipcRenderer.invoke('desktop:window', 'state'),
    onState(callback) {
      const handler = (_event, value) => callback(value);
      ipcRenderer.on('desktop:window-state', handler);
      return () => ipcRenderer.removeListener('desktop:window-state', handler);
    },
  }),
  // Legacy single-view surface (kept for the previous panel and older pages).
  navigate: (url) => ipcRenderer.invoke('desktop:navigate', url),
  bounds: (rect) => ipcRenderer.send('desktop:bounds', rect),
  destroy: () => ipcRenderer.send('desktop:destroy'),
  external: (url) => ipcRenderer.invoke('desktop:external', url),
  onStatus(callback) {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('desktop:status', handler);
    return () => ipcRenderer.removeListener('desktop:status', handler);
  },
}));
