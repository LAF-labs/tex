const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sax', {
  call: (method, params) => ipcRenderer.invoke('sax', { method, params: params || {} }),
  onEvent: (fn) => {
    ipcRenderer.on('sax:event', (_e, ev) => fn(ev));
  },
});
