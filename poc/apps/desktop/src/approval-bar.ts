import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { nativeTheme, screen, session, WebContentsView, type BrowserWindow, type Session } from 'electron';
import {
  BAR,
  BAR_MESSAGES,
  BarGate,
  REFUSAL_TEXT,
  barCss,
  buildBarHtml,
  gateHash,
  issueLocalApproval,
  overflowLine,
  summarize,
  type BarMode,
  type GateRequest,
  type LocalApproval,
  type SummaryLine,
} from './approval-gate.ts';
import type { Rect } from './shell-layout.ts';
import { loadTokens } from './shell-tokens.ts';

// ADR-021 결정 1: main 소유 승인 바. 메인 창 contentView의 자식 WebContentsView이고, 스크립트·preload가 없는 정적 페이지다.
// 위치는 main이 창 크기로 정하고(place), 승인은 main이 이 뷰의 before-mouse-event로 직접 관찰한 클릭으로만 인정한다.

export const APPROVAL_SCHEME = 'sax-approval';
const pages = new Map<string, string>();
let ses: Session | null = null;

function barSession(): Session {
  if (ses) return ses;
  ses = session.fromPartition('sax-approval'); // 메모리 파티션(persist: 아님)
  ses.protocol.handle(APPROVAL_SCHEME, (req) => {
    const u = new URL(req.url);
    if (u.pathname === '/bar.css') return new Response(barCss(loadTokens()), { headers: { 'content-type': 'text/css' } });
    const html = u.pathname === '/' ? pages.get(u.host) : undefined;
    return html ? new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }) : new Response('', { status: 404 });
  });
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith(`${APPROVAL_SCHEME}://`) }));
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  return ses;
}

/** 개발 콘솔(main.ts)의 승인 바 시험용: 창 아래 띠, 발급 없는 시험 값. */
export const bottomStrip = (w: number, h: number): Rect => ({ x: 0, y: h - BAR.height, width: w, height: BAR.height });
export function demoGateRequest(): GateRequest {
  const base = {
    runId: 'demo',
    gateStepId: 'demo-gate',
    reqId: randomUUID(),
    docType: 'H-01' as const,
    fields: [
      { fieldKey: 'counterpartName', value: '시험 거래처(발급 없음)' },
      { fieldKey: 'counterpartBizNo', value: '1234567891' },
      { fieldKey: 'counterpartEmail', value: 'test@example.com' },
      { fieldKey: 'totalAmount', value: '0' },
      { fieldKey: 'taxAmount', value: '0' },
    ],
  };
  return { ...base, actionHash: gateHash(base) };
}

export type BarOutcome ={ decision: 'approve'; approval: LocalApproval } | { decision: 'closed'; reason: string };

export interface BarSnapshot {
  visible: boolean;
  mode: BarMode;
  msg: string | null;
  bounds: Rect;
  armed: boolean;
  refusal: string | null;
}

/**
 * 한 번 뜬 바는 게이트가 끝날 때까지(승인·중지·만료) 남는다. 렌더러가 바를 숨기는 경로는 없다.
 * 이벤트: 'shown' · 'hidden'(reason) · 'judged'({event, result}) — 셸이 렌더러에 자리 비움을 알리고 e2e가 기록을 본다.
 */
export class ApprovalBar extends EventEmitter {
  readonly view: WebContentsView;
  private readonly gate: BarGate;
  private req: GateRequest | null = null;
  private lines: SummaryLine[] | null = null;
  private baseRefusal: string | null = null;
  private refusal: string | null = null;
  private resolve: ((o: BarOutcome) => void) | null = null;
  private armTimer: NodeJS.Timeout | undefined;
  private activationTimer: NodeJS.Timeout | undefined;
  private bounds: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private mode: BarMode = 'unarmed';
  private msg: string | null = null;
  private pageId: string | null = null;
  private readonly win: BrowserWindow;
  private readonly key: Uint8Array;
  private readonly place: (contentWidth: number, contentHeight: number) => Rect;

  constructor(win: BrowserWindow, key: Uint8Array, place: (contentWidth: number, contentHeight: number) => Rect, armDelayMs?: number) {
    super();
    this.win = win;
    this.key = key;
    this.place = place;
    this.gate = new BarGate(armDelayMs);
    this.view = new WebContentsView({
      webPreferences: { session: barSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, devTools: false, spellcheck: false, focusOnNavigation: false, webviewTag: false },
    });
    // 뷰는 미리 붙여 두고 setVisible로 보이고 숨긴다(ADR-021).
    this.view.setVisible(false);
    win.contentView.addChildView(this.view);
    const wc = this.view.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.on('will-redirect', (e) => e.preventDefault());
    wc.on('before-mouse-event', (_e, m) => this.onMouse(m));
    // 키보드 승인은 없다(Enter·Space·조합키 모두). 바로 간 키보드 포커스는 대화 화면으로 돌려준다.
    wc.on('before-input-event', (e) => e.preventDefault());
    wc.on('focus', () => {
      if (!win.isDestroyed()) win.webContents.focus();
    });
    wc.on('did-finish-load', () => {
      wc.setZoomFactor(1);
      void wc.setVisualZoomLevelLimits(1, 1);
    });

    const relayout = () => this.relayout();
    const rearm = (why: string) => () => this.rearm(why);
    win.on('resize', relayout);
    win.on('move', rearm('move'));
    win.on('moved', rearm('moved'));
    win.on('show', rearm('show'));
    win.on('restore', rearm('restore'));
    win.on('focus', () => this.onActivate());
    const onDisplay = () => {
      this.relayout();
      this.rearm('display-metrics-changed');
    };
    screen.on('display-metrics-changed', onDisplay);
    nativeTheme.on('updated', () => this.render());
    win.on('closed', () => {
      screen.off('display-metrics-changed', onDisplay);
      this.finish({ decision: 'closed', reason: 'window_closed' });
    });
    // 커서 위장 감시: 대화 화면 커서가 none·custom이면 무장하지 않는다.
    win.webContents.on('cursor-changed', (_e, type) => {
      const blocked = type === 'none' || type === 'custom';
      this.gate.setCursorBlocked(blocked, Date.now());
      if (this.req) this.render(blocked ? 'unarmed' : undefined);
      if (!blocked) this.scheduleArm();
    });
    this.relayout();
  }

  get visible(): boolean {
    return this.req !== null;
  }

  snapshot(): BarSnapshot {
    return { visible: this.visible, mode: this.mode, msg: this.msg, bounds: { ...this.bounds }, armed: this.gate.armed(Date.now()), refusal: this.refusal };
  }

  /** 게이트 요청을 받아 바를 띄운다. 승인 또는 close()까지 기다린다. */
  open(req: GateRequest): Promise<BarOutcome> {
    if (this.req) this.finish({ decision: 'closed', reason: 'replaced' });
    this.req = req;
    // 엔진이 보낸 fields로 해시를 다시 계산해 같을 때만 무장한다(자기 일치 확인, 렌더러·엔진 침해 방어 아님).
    const { actionHash, ...rest } = req;
    const summary = summarize(req);
    if (gateHash(rest) !== actionHash) {
      this.lines = Array.isArray(summary) ? summary : [];
      this.baseRefusal = REFUSAL_TEXT.hash();
    } else if (!Array.isArray(summary)) {
      this.lines = [];
      this.baseRefusal = summary.reason === 'hash' ? REFUSAL_TEXT.hash() : REFUSAL_TEXT[summary.reason](summary.label);
    } else {
      this.lines = summary;
      this.baseRefusal = null;
    }
    this.keepOnScreen();
    this.relayout(false);
    this.updateRefusal();
    this.win.contentView.addChildView(this.view); // 이미 붙은 뷰를 다시 더하면 맨 위로 올라온다.
    this.view.setVisible(true);
    if (!this.win.isFocused()) this.win.flashFrame(true); // 포커스는 가져오지 않는다.
    this.emit('shown');
    const result = new Promise<BarOutcome>((resolve) => {
      this.resolve = resolve;
    });
    this.rearm('shown', true);
    return result;
  }

  /** 게이트가 끝남(중지·만료·엔진 취소). 거절·중지는 렌더러 신호로 받아도 안전한 실패다. */
  close(reason: string): void {
    this.finish({ decision: 'closed', reason });
  }

  private finish(o: BarOutcome): void {
    if (!this.req) return;
    this.req = null;
    this.lines = null;
    clearTimeout(this.armTimer);
    clearTimeout(this.activationTimer);
    if (!this.win.isDestroyed()) {
      this.view.setVisible(false);
      this.win.flashFrame(false);
    }
    const r = this.resolve;
    this.resolve = null;
    this.emit('hidden', o.decision === 'approve' ? 'approved' : o.reason);
    r?.(o);
  }

  private relayout(rearm = true): void {
    if (this.win.isDestroyed()) return;
    const [w, h] = this.win.getContentSize() as [number, number];
    const b = this.place(w, h);
    const changed = b.x !== this.bounds.x || b.y !== this.bounds.y || b.width !== this.bounds.width || b.height !== this.bounds.height;
    this.bounds = { x: b.x, y: b.y, width: b.width, height: b.height };
    this.view.setBounds(this.bounds);
    this.gate.setSize(b.width, b.height);
    if (changed && this.req) {
      this.updateRefusal();
      if (rearm) this.rearm('resize', true);
    }
  }

  /** 바가 디스플레이 작업 영역 밖이면 창을 작업 영역 안으로 옮긴다. */
  private keepOnScreen(): void {
    const cb = this.win.getContentBounds();
    const area = screen.getDisplayMatching(cb).workArea;
    const [, h] = this.win.getContentSize() as [number, number];
    const b = this.place(cb.width, h);
    const barBottom = cb.y + b.y + b.height;
    const barRight = cb.x + b.x + b.width;
    let dx = 0;
    let dy = 0;
    if (barBottom > area.y + area.height) dy = area.y + area.height - barBottom;
    if (barRight > area.x + area.width) dx = area.x + area.width - barRight;
    if (cb.x + b.x + dx < area.x) dx = area.x - (cb.x + b.x);
    if (dx || dy) {
      const wb = this.win.getBounds();
      this.win.setPosition(wb.x + dx, Math.max(area.y, wb.y + dy));
    }
  }

  private updateRefusal(): void {
    if (!this.lines) return;
    const over = this.baseRefusal ? null : overflowLine(this.lines, this.bounds.width);
    this.refusal = this.baseRefusal ?? (over ? REFUSAL_TEXT.overflow(over) : null);
  }

  /** 무장 사건. 무장 전 페이지를 불러오고 600ms 뒤 무장됨 페이지로 바꾼다. */
  private rearm(why: string, force = false): void {
    if (!this.req) return;
    this.gate.rearm(Date.now());
    this.emit('judged', { event: `rearm:${why}` });
    // 창을 끄는 동안 move가 연달아 오면 페이지를 매번 다시 불러오지 않는다.
    if (force || this.mode !== 'unarmed' || this.msg) this.render('unarmed', null);
    this.scheduleArm();
  }

  private scheduleArm(): void {
    clearTimeout(this.armTimer);
    if (!this.req) return;
    const delay = this.gate.armTime - Date.now();
    if (!Number.isFinite(delay)) return;
    this.armTimer = setTimeout(() => {
      if (this.req && this.gate.armed(Date.now())) this.render('armed');
      else this.scheduleArm();
    }, Math.max(0, delay) + 5);
  }

  private onActivate(): void {
    if (!this.req) return;
    this.gate.windowActivated(Date.now());
    clearTimeout(this.activationTimer);
    this.activationTimer = setTimeout(() => {
      if (this.req && this.gate.activationSettled(Date.now())) {
        this.emit('judged', { event: 'rearm:activate' });
        this.render('unarmed', null);
        this.scheduleArm();
      }
    }, 100);
  }

  private onMouse(m: Electron.MouseInputEvent): void {
    if (!this.req || this.refusal) return;
    const r = this.gate.mouse({ type: m.type, x: m.x, y: m.y, button: m.button, movementX: m.movementX, movementY: m.movementY }, Date.now());
    if (m.type === 'mouseDown' || m.type === 'mouseUp' || r) this.emit('judged', { event: m.type, x: m.x, y: m.y, result: r });
    if (!r) return;
    if (r.kind === 'approve') {
      const req = this.req;
      this.finish({ decision: 'approve', approval: issueLocalApproval(this.key, req) });
      if (!this.win.isDestroyed()) this.win.webContents.focus();
      return;
    }
    if (r.reason === 'arming') {
      this.render('unarmed', BAR_MESSAGES.arming);
      this.scheduleArm();
    } else {
      this.render('armed', BAR_MESSAGES.dwell);
    }
  }

  /** 정적 페이지 세 가지(무장 전·무장됨·무장됨 + 문구)와 무장 거부를 바꿔 불러온다. 애니메이션·insertCSS 없음. */
  private render(mode: BarMode = this.mode, msg: string | null = mode === this.mode ? this.msg : null): void {
    if (!this.lines || this.win.isDestroyed()) return;
    const effective: BarMode = this.refusal ? 'refused' : mode;
    const text = this.refusal ?? msg;
    this.mode = effective;
    this.msg = text;
    const t = loadTokens()[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];
    this.view.setBackgroundColor(effective === 'armed' ? t.accent! : effective === 'unarmed' ? t['accent-soft']! : t.surface!);
    const id = randomUUID();
    pages.set(id, buildBarHtml(this.lines, effective, text ?? undefined));
    const prev = this.pageId;
    this.pageId = id;
    void this.view.webContents.loadURL(`${APPROVAL_SCHEME}://${id}/`).then(
      () => prev && pages.delete(prev),
      () => prev && pages.delete(prev),
    );
  }
}
