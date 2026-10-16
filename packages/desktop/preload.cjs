const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('myHarnessDesktop', Object.freeze({
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
