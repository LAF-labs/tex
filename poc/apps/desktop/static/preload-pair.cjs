// 폰 연결 창(S-03) preload: main이 정한 동작 넷(보기·6자리 넣기·다시 하기·취소)과 화면 갱신만. 창은 main 소유이고 셸 렌더러와 통하지 않는다.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('pair', {
  view: () => ipcRenderer.invoke('sax:pair', { op: 'view' }),
  submit: (code) => ipcRenderer.invoke('sax:pair', { op: 'submit', code: String(code).slice(0, 6) }),
  retry: () => ipcRenderer.invoke('sax:pair', { op: 'retry' }),
  cancel: () => ipcRenderer.invoke('sax:pair', { op: 'cancel' }),
  onView: (fn) => {
    ipcRenderer.on('sax:pair-view', (_e, v) => fn(v));
  },
});
