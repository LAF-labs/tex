// 메인 UI preload: 허용된 채널 하나(sax)만. 렌더러는 엔진·금고와 직접 통신하지 않는다(D01 §2.1).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sax', {
  call: (method, params) => ipcRenderer.invoke('sax', { method, params: params || {} }),
});
