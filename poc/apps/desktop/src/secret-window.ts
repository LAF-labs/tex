import path from 'node:path';
import { BrowserWindow, type MessagePortMain } from 'electron';
import { hardenWindow } from './harden.ts';
import { IPC } from './ipc.ts';

const STATIC = path.join(import.meta.dirname, '../static');

export function openVaultInputWindow(parent: BrowserWindow, port: MessagePortMain, url: string, title: string, height = 300, log?: (name: string, data: Record<string, string | number>) => void): BrowserWindow {
  const win = new BrowserWindow({
    parent,
    modal: true,
    width: 440,
    height,
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
  try {
    win.setMenu(null);
    win.setContentProtection(true);
    hardenWindow(win);
    win.on('page-title-updated', (e) => e.preventDefault());
  } catch (e) {
    win.destroy();
    throw e;
  }
  let sent = false;
  const drop = () => {
    if (!sent) port.close();
  };
  void win.loadURL(url).then(
    () => {
      if (win.isDestroyed()) return drop();
      win.webContents.postMessage(IPC.secretPort, null, [port]);
      sent = true;
    },
    () => {
      drop();
      if (!win.isDestroyed()) win.close();
    },
  );
  win.on('closed', drop);
  win.webContents.on('did-fail-load', (_e, code) => log?.('main.secret_window_blank', { step: 'load', code }));
  win.webContents.on('render-process-gone', (_e, d) => log?.('main.secret_window_blank', { step: 'gone', code: String(d.reason).slice(0, 20) }));
  win.webContents.on('unresponsive', () => log?.('main.secret_window_blank', { step: 'unresponsive' }));
  return win;
}
