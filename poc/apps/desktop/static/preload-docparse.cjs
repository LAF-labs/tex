// docparse 샌드박스 preload: main이 보낸 MessagePort 하나만 페이지로 넘긴다(ADR-014). 다른 API는 노출하지 않는다.
const { ipcRenderer } = require('electron');
ipcRenderer.once('docparse-port', (e) => window.postMessage('docparse-port', '*', e.ports));
