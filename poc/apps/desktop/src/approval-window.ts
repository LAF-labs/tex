import { randomUUID } from 'node:crypto';
import { BrowserWindow, session, type Session } from 'electron';
import { ApprovalGate, LAYOUT, approvalCss, buildApprovalHtml, issueLocalApproval, type ApprovalCard, type Decision, type LocalApproval } from './approval-gate.ts';

// ADR-014 결정 2: main이 만드는 정적 승인 창. 스크립트 없음(javascript:false), preload 없음, 탐색·새 창·권한 거부.
// 승인은 main이 이 창의 before-mouse-event / before-input-event로 직접 관찰한 입력으로만 인정한다.

export const APPROVAL_SCHEME = 'sax-approval';
const pages = new Map<string, string>();
let ses: Session | null = null;

function approvalSession(): Session {
  if (ses) return ses;
  ses = session.fromPartition('sax-approval'); // 메모리 파티션(persist: 아님)
  ses.protocol.handle(APPROVAL_SCHEME, (req) => {
    const u = new URL(req.url);
    if (u.pathname === '/approval.css') return new Response(approvalCss(), { headers: { 'content-type': 'text/css' } });
    const html = pages.get(u.host);
    return html ? new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }) : new Response('', { status: 404 });
  });
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith(`${APPROVAL_SCHEME}://`) }));
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  return ses;
}

export interface ApprovalOutcome {
  decision: Decision | 'timeout' | 'closed';
  approval: LocalApproval | null;
  /** 판정에 쓴 입력 경로(진단용). */
  via?: 'mouse' | 'key';
}

export interface ApprovalWindowHandle {
  win: BrowserWindow;
  result: Promise<ApprovalOutcome>;
}

/** 창은 포커스를 빼앗지 않는다(showInactive). 사용자가 창으로 이동해 누른다. */
export function openApprovalWindow(card: ApprovalCard, key: Uint8Array, timeoutMs = 300_000): ApprovalWindowHandle {
  const id = randomUUID();
  pages.set(id, buildApprovalHtml(card));
  const win = new BrowserWindow({
    width: LAYOUT.width,
    height: LAYOUT.height,
    useContentSize: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: '승인',
    webPreferences: { session: approvalSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, devTools: false, spellcheck: false },
  });
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-redirect', (e) => e.preventDefault());
  const gate = new ApprovalGate();
  const result = new Promise<ApprovalOutcome>((resolve) => {
    let done = false;
    const finish = (o: ApprovalOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pages.delete(id);
      if (!win.isDestroyed()) win.destroy();
      resolve(o);
    };
    const decide = (d: Decision | null, via: 'mouse' | 'key') => {
      if (!d) return;
      finish({ decision: d, approval: d === 'approve' ? issueLocalApproval(key, card) : null, via });
    };
    const timer = setTimeout(() => finish({ decision: 'timeout', approval: null }), timeoutMs);
    win.on('show', () => gate.shown(Date.now()));
    win.on('focus', () => gate.shown(Date.now()));
    win.on('closed', () => finish({ decision: 'closed', approval: null }));
    wc.on('before-mouse-event', (_e, m) => decide(gate.mouse({ type: m.type, x: m.x, y: m.y, button: m.button, clickCount: m.clickCount }, Date.now()), 'mouse'));
    wc.on('before-input-event', (_e, i) => decide(gate.key({ type: i.type, key: i.key, alt: i.alt, control: i.control, meta: i.meta, shift: i.shift, isAutoRepeat: i.isAutoRepeat }, Date.now()), 'key'));
  });
  wc.loadURL(`${APPROVAL_SCHEME}://${id}/`).then(() => {
    wc.setZoomFactor(1);
    void wc.setVisualZoomLevelLimits(1, 1);
    if (!win.isDestroyed()) win.showInactive();
  }, (e: Error) => {
    console.error('approval load failed', e.message);
    if (!win.isDestroyed()) win.destroy();
  });
  return { win, result };
}
