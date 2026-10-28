// 비밀 입력 창 preload: main이 보낸 금고 직결 포트를 페이지에 넘긴다. main은 이 포트로 오가는 내용을 보지 않는다(D05 §3.8).
const { ipcRenderer } = require('electron');
ipcRenderer.once('vault-secret-port', (e) => window.postMessage('vault-secret-port', '*', e.ports));
