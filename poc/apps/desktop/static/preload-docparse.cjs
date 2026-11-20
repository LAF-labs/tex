const { ipcRenderer } = require('electron');
ipcRenderer.once('docparse-port', (e) => window.postMessage('docparse-port', '*', e.ports));
