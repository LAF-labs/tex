const { ipcRenderer } = require('electron');
ipcRenderer.once('vault-secret-port', (e) => window.postMessage('vault-secret-port', '*', e.ports));
