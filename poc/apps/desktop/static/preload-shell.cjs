// 셸 preload: 호출 채널 하나(sax)와 main이 보내는 이벤트(sax:event)만. 렌더러는 엔진·금고·승인 바와 직접 통신하지 않는다.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sax', {
  call: (method, params) => ipcRenderer.invoke('sax', { method, params: params || {} }),
  onEvent: (fn) => {
    ipcRenderer.on('sax:event', (_e, ev) => fn(ev));
  },
});
