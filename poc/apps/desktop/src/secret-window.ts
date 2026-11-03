// 비밀 입력 창(main이 연다, 금고 secret.needed가 부를 때만). OS 프레임·제목줄이 있는 메인 창의 모달이다(N-11 PoC 부분).
// 렌더러는 이 창을 열거나 라벨을 정할 수 없다. 포트는 금고 직결이고 main은 내용을 보지 않는다(D05 §3.8).
import path from 'node:path';
import { BrowserWindow, type MessagePortMain } from 'electron';
import { hardenWindow } from './harden.ts';
import { secretTitle, type SecretInputBind } from './secret-labels.ts';

const STATIC = path.join(import.meta.dirname, '../static');

/** 창을 띄우고 페이지가 뜨면 금고 포트를 넘긴다. url은 main이 만든 비밀 창 페이지(sax-shell://shell/secret.html). */
export function openSecretWindow(parent: BrowserWindow, bind: SecretInputBind, port: MessagePortMain, url: string): BrowserWindow {
  const title = secretTitle(bind.kind);
  const win = new BrowserWindow({
    parent,
    modal: true,
    width: 440,
    height: 300,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
      spellcheck: false,
      disableDialogs: true,
      webviewTag: false,
      preload: path.join(STATIC, 'preload-secret.cjs'),
    },
  });
  win.setMenu(null);
  win.setContentProtection(true);
  hardenWindow(win);
  // 제목줄은 main이 정한 글자 그대로(페이지 <title>로 바꾸지 못한다).
  win.on('page-title-updated', (e) => e.preventDefault());
  // 넘기기 전에 창이 닫히면 포트를 닫아 금고 쪽 결속을 끝낸다(넘긴 뒤에는 창과 함께 사라진다).
  let sent = false;
  const drop = () => {
    if (!sent) port.close();
  };
  void win.loadURL(url).then(
    () => {
      if (win.isDestroyed()) return drop();
      win.webContents.postMessage('vault-secret-port', null, [port]);
      sent = true;
    },
    () => {
      drop();
      if (!win.isDestroyed()) win.close();
    },
  );
  win.on('closed', drop);
  return win;
}
