// 폰 연결 창(S-03): main 소유 창. 화면 캡처를 막고(setContentProtection, ADR-016), 셸 렌더러와 통하지 않는다.
// 창은 화면 값(PairView)만 받고, 동작은 넷(보기·6자리·다시 하기·취소)이다. 6자리·다시 하기는 이 창에서 main이 직접 본 실제 입력 뒤에만(ADR-027 결정 8).
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { GestureClock, isGestureKey } from './gesture.ts';
import { hardenWindow } from './harden.ts';
import type { PairingHost, PairView } from './remote-pairing.ts';

const STATIC = path.join(import.meta.dirname, '../static');
export const PAIR_CHANNEL = 'sax:pair';
export const PAIR_VIEW_CHANNEL = 'sax:pair-view';

export interface PairWindowOptions {
  parent: BrowserWindow;
  /** main이 내는 창 페이지(sax-shell://shell/pair.html). */
  url: string;
  host: PairingHost;
  /** 창이 닫힐 때(연결했든 아니든). */
  onClosed?: (v: PairView) => void;
}

/** 창 하나를 관리한다. open()을 다시 부르면 열린 창을 앞으로 가져온다. */
export class PairWindow {
  #o: PairWindowOptions;
  #win: BrowserWindow | null = null;
  #gesture = new GestureClock();
  #handler = (e: IpcMainInvokeEvent, req: unknown) => this.#handle(e, req);

  constructor(o: PairWindowOptions) {
    this.#o = o;
    ipcMain.handle(PAIR_CHANNEL, this.#handler);
  }

  get window(): BrowserWindow | null {
    return this.#win && !this.#win.isDestroyed() ? this.#win : null;
  }

  /** 화면 값을 창에 보낸다(PairingHost.onView). */
  push(v: PairView): void {
    const w = this.window;
    if (w) w.webContents.send(PAIR_VIEW_CHANNEL, v);
  }

  open(): BrowserWindow {
    const cur = this.window;
    if (cur) {
      cur.focus();
      return cur;
    }
    const win = new BrowserWindow({
      parent: this.#o.parent,
      width: 420,
      height: 520,
      useContentSize: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: '폰 연결',
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
        spellcheck: false,
        disableDialogs: true,
        webviewTag: false,
        preload: path.join(STATIC, 'preload-pair.cjs'),
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
    const wc = win.webContents;
    wc.on('before-mouse-event', (_e, m) => {
      if (m.type === 'mouseUp') this.#gesture.note(performance.now());
    });
    wc.on('before-input-event', (_e, i) => {
      if (isGestureKey(i)) this.#gesture.note(performance.now());
    });
    win.on('closed', () => {
      this.#win = null;
      const v = this.#o.host.view();
      if (v.step !== 'paired') this.#o.host.cancel();
      this.#o.onClosed?.(v);
    });
    this.#win = win;
    const url = this.#o.url;
    void win.loadURL(url).catch(() => !win.isDestroyed() && win.close());
    void this.#o.host.start();
    return win;
  }

  close(): void {
    this.window?.close();
  }

  dispose(): void {
    ipcMain.removeHandler(PAIR_CHANNEL);
    this.close();
  }

  async #handle(e: IpcMainInvokeEvent, req: unknown): Promise<PairView> {
    const w = this.window;
    if (!w || e.sender !== w.webContents || e.senderFrame?.url !== this.#o.url) throw new Error('forbidden');
    const r = (req ?? {}) as { op?: unknown; code?: unknown };
    const host = this.#o.host;
    switch (r.op) {
      case 'view':
        return host.view();
      case 'submit':
        if (!this.#gesture.within(performance.now(), 3_000)) throw new Error('gesture_required');
        return host.submitSas(typeof r.code === 'string' ? r.code.slice(0, 6) : '');
      case 'retry':
        if (!this.#gesture.within(performance.now(), 3_000)) throw new Error('gesture_required');
        host.cancel();
        return host.start();
      case 'cancel':
        return host.cancel();
      default:
        throw new Error('bad_request');
    }
  }
}
