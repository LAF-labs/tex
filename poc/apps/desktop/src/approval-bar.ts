import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { nativeTheme, screen, session, WebContentsView, type BrowserWindow, type Session } from 'electron';
import {
  ACTIVATION_GRACE_MS,
  BAR,
  BAR_MESSAGES,
  BarGate,
  barCss,
  buildBarHtml,
  gateHash,
  issueLocalApproval,
  overflowLine,
  REFUSAL_TEXT,
  refusalText,
  summarize,
  type BarMode,
  type GateRequest,
  type LocalApproval,
  type SummaryLine,
} from './approval-gate.ts';
import type { Rect } from './shell-layout.ts';
import { loadTokens } from './shell-tokens.ts';

// ADR-021 결정 1: main 소유 승인 바. 메인 창 contentView의 자식 WebContentsView이고, 스크립트·preload가 없는 정적 페이지다.
// 위치는 main이 창 크기(와 게이트 값의 폭)로 정하고, 승인은 main이 이 뷰의 before-mouse-event로 직접 관찰한 클릭으로만 인정한다.

export const APPROVAL_SCHEME = 'sax-approval';
const HOST = 'bar';
const pages = new Map<string, string>();
const BLANK = 'blank';
let ses: Session | null = null;

function barSession(): Session {
  if (ses) return ses;
  ses = session.fromPartition('sax-approval'); // 메모리 파티션(persist: 아님)
  ses.protocol.handle(APPROVAL_SCHEME, (req) => {
    const u = new URL(req.url);
    if (u.host !== HOST) return new Response('', { status: 404 });
    if (u.pathname === '/bar.css') return new Response(barCss(loadTokens()), { headers: { 'content-type': 'text/css' } });
    const html = u.pathname === `/${BLANK}` ? '<!doctype html><meta charset="utf-8">' : pages.get(u.pathname.slice(1));
    return html ? new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }) : new Response('', { status: 404 });
  });
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith(`${APPROVAL_SCHEME}://${HOST}/`) }));
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  return ses;
}

/** 바 자리 계산. wide면 레일 오른쪽부터 창 끝까지의 띠(값이 대화 열 폭에 안 들어갈 때). */
export type Placer = (contentWidth: number, contentHeight: number, wide: boolean) => Rect & { band?: boolean };

/** 개발 콘솔(main.ts)의 승인 바 시험용: 창 아래 띠, 발급 없는 시험 값. */
export const bottomStrip: Placer = (w, h) => ({ x: 0, y: h - BAR.height, width: w, height: BAR.height, band: true });
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

export type BarOutcome = { decision: 'approve'; approval: LocalApproval } | { decision: 'closed'; reason: string };

export interface BarSnapshot {
  visible: boolean;
  runId: string | null;
  reqId: string | null;
  /** main이 그리려는 모드와, 지금 실제로 화면에 올라온(커밋된) 페이지. */
  mode: BarMode;
  msg: string | null;
  committed: { reqId: string; mode: BarMode } | null;
  bounds: Rect;
  band: boolean;
  armed: boolean;
  refusal: string | null;
}

export interface BarOptions {
  armDelayMs?: number;
  /** OS 커서 위치(DIP 화면 좌표). e2e가 바꿔 끼운다. */
  cursorPoint?: () => { x: number; y: number };
}

/**
 * 한 번 뜬 바는 게이트가 끝날 때까지(승인·중지·만료) 남는다. 렌더러가 바를 숨기는 경로는 없다.
 * 열린 게이트가 있으면 새 게이트로 바꾸지 않는다(open이 'busy'로 끝난다).
 * 이벤트: 'shown'({band}) · 'layout'({band}) · 'hidden'(reason) · 'judged'({event, result}).
 */
export class ApprovalBar extends EventEmitter {
  readonly view: WebContentsView;
  private readonly gate: BarGate;
  private readonly win: BrowserWindow;
  private readonly key: Uint8Array;
  private readonly place: Placer;
  private readonly cursorPoint: () => { x: number; y: number };
  private req: GateRequest | null = null;
  private lines: SummaryLine[] | null = null;
  private baseRefusal: string | null = null;
  private refusal: string | null = null;
  private resolve: ((o: BarOutcome) => void) | null = null;
  private armTimer: NodeJS.Timeout | undefined;
  private activationTimer: NodeJS.Timeout | undefined;
  private bounds: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private band = false;
  private shown = false;
  private mode: BarMode = 'unarmed';
  private msg: string | null = null;
  private pageId: string | null = null;
  private committed: { id: string; reqId: string; mode: BarMode } | null = null;
  private lastRender: Promise<void> = Promise.resolve();
  /** 시계가 바뀌어도 무장 지연이 짧아지지 않게 단조 시계를 쓴다. */
  private readonly now = () => performance.now();

  constructor(win: BrowserWindow, key: Uint8Array, place: Placer, opts: BarOptions = {}) {
    super();
    this.win = win;
    this.key = key;
    this.place = place;
    this.cursorPoint = opts.cursorPoint ?? (() => screen.getCursorScreenPoint());
    this.gate = new BarGate(opts.armDelayMs);
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
    wc.on('before-input-event', (e, i) => {
      e.preventDefault();
      if (this.req && this.gate.key({ type: i.type, key: i.key, alt: i.alt, control: i.control, meta: i.meta }, this.now())?.kind === 'approve') this.approve();
    });
    wc.on('focus', () => {
      if (!win.isDestroyed()) win.webContents.focus();
    });
    wc.on('did-finish-load', () => {
      wc.setZoomFactor(1);
      void wc.setVisualZoomLevelLimits(1, 1);
    });
    void wc.loadURL(`${APPROVAL_SCHEME}://${HOST}/${BLANK}`).catch(() => {});

    const rearm = (why: string) => () => this.rearm(why);
    win.on('resize', () => this.relayout());
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
    const onTheme = () => {
      if (this.req) void this.render(this.mode, this.msg);
    };
    nativeTheme.on('updated', onTheme);
    win.on('closed', () => {
      screen.off('display-metrics-changed', onDisplay);
      nativeTheme.off('updated', onTheme);
      this.finish({ decision: 'closed', reason: 'window_closed' });
    });
    // 커서 위장 감시: 대화 화면 커서가 none·custom이면 무장하지 않는다. 바뀔 때만 다시 그린다.
    win.webContents.on('cursor-changed', (_e, type) => {
      const blocked = type === 'none' || type === 'custom';
      if (blocked === this.gate.cursorBlocked) return;
      this.gate.setCursorBlocked(blocked);
      if (blocked) {
        clearTimeout(this.armTimer);
        if (this.req) void this.render('unarmed', null);
      } else this.rearm('cursor-restored', true);
    });
    this.relayout();
  }

  get visible(): boolean {
    return this.shown;
  }

  /** 지금 열린 게이트의 실행 ID. */
  get runId(): string | null {
    return this.req?.runId ?? null;
  }

  snapshot(): BarSnapshot {
    const c = this.committed && this.committed.id === this.pageId ? { reqId: this.committed.reqId, mode: this.committed.mode } : null;
    return { visible: this.shown, runId: this.runId, reqId: this.req?.reqId ?? null, mode: this.mode, msg: this.msg, committed: c, bounds: { ...this.bounds }, band: this.band, armed: this.armedNow(), refusal: this.refusal };
  }

  /** 게이트 요청을 받아 바를 띄운다. 승인 또는 close()까지 기다린다. 열린 게이트가 있으면 바꾸지 않고 'busy'. */
  open(req: GateRequest): Promise<BarOutcome> {
    if (this.win.isDestroyed()) return Promise.resolve({ decision: 'closed', reason: 'window_closed' });
    if (this.req) return Promise.resolve({ decision: 'closed', reason: 'busy' });
    this.req = req;
    // 엔진이 보낸 fields로 해시를 다시 계산해 같을 때만 무장한다(자기 일치 확인, 렌더러·엔진 침해 방어 아님).
    const { actionHash, ...rest } = req;
    const summary = summarize(req);
    this.lines = Array.isArray(summary) ? summary : [];
    this.baseRefusal = gateHash(rest) !== actionHash ? REFUSAL_TEXT.hash() : Array.isArray(summary) ? null : refusalText(summary);
    const result = new Promise<BarOutcome>((resolve) => {
      this.resolve = resolve;
    });
    void this.show(req);
    return result;
  }

  /** 게이트가 끝남(중지·만료·엔진 취소). reqId를 주면 그 게이트일 때만 닫는다. */
  close(reason: string, reqId?: string): void {
    if (reqId && this.req?.reqId !== reqId) return;
    this.finish({ decision: 'closed', reason });
  }

  /** 새 게이트의 첫 페이지가 화면에 올라온 뒤에만 보인다. 그 전에는 앞 게이트의 페이지가 보일 수 있기 때문이다. */
  private async show(req: GateRequest): Promise<void> {
    this.keepOnScreen();
    this.relayout(false);
    this.gate.rearm(this.now(), this.cursorInside());
    void this.render('unarmed', null);
    // 그 사이 다시 그렸으면(창 크기 변경 등) 마지막 페이지가 올라올 때까지 기다린다.
    let p: Promise<void>;
    do {
      p = this.lastRender;
      await p;
    } while (p !== this.lastRender && this.req === req);
    if (this.req !== req || this.win.isDestroyed()) return;
    if (!this.committedFor(req)) return this.finish({ decision: 'closed', reason: 'load_failed' });
    this.win.contentView.addChildView(this.view); // 이미 붙은 뷰를 다시 더하면 맨 위로 올라온다.
    this.view.setVisible(true);
    this.shown = true;
    if (!this.win.isFocused()) this.win.flashFrame(true); // 포커스는 가져오지 않는다.
    this.emit('shown', { band: this.band });
    this.rearm('shown');
  }

  private committedFor(req: GateRequest): boolean {
    return !!this.committed && this.committed.id === this.pageId && this.committed.reqId === req.reqId;
  }

  private finish(o: BarOutcome): void {
    if (!this.req) return;
    this.req = null;
    this.lines = null;
    this.refusal = null;
    this.baseRefusal = null;
    this.msg = null;
    this.mode = 'unarmed';
    this.shown = false;
    clearTimeout(this.armTimer);
    clearTimeout(this.activationTimer);
    if (!this.win.isDestroyed()) {
      this.view.setVisible(false);
      this.win.flashFrame(false);
      // 다음 게이트에 앞 게이트의 값이 남아 보이지 않게 빈 페이지로 바꾼다.
      this.pageId = null;
      this.committed = null;
      void this.view.webContents.loadURL(`${APPROVAL_SCHEME}://${HOST}/${BLANK}`).catch(() => {});
    }
    const r = this.resolve;
    this.resolve = null;
    this.emit('hidden', o.decision === 'approve' ? 'approved' : o.reason);
    r?.(o);
  }

  private approve(): void {
    const req = this.req;
    if (!req) return;
    this.finish({ decision: 'approve', approval: issueLocalApproval(this.key, req) });
    if (!this.win.isDestroyed()) this.win.webContents.focus();
  }

  /** 창 크기와 게이트 값만으로 자리를 정한다. 값이 대화 열 폭에 안 들어가면 띠로 넓힌다. */
  private relayout(rearm = true): void {
    if (this.win.isDestroyed()) return;
    const [w, h] = this.win.getContentSize() as [number, number];
    let b = this.place(w, h, false);
    if (this.lines?.length && overflowLine(this.lines, b.width)) b = this.place(w, h, true);
    const changed = b.x !== this.bounds.x || b.y !== this.bounds.y || b.width !== this.bounds.width || b.height !== this.bounds.height;
    this.bounds = { x: b.x, y: b.y, width: b.width, height: b.height };
    this.view.setBounds(this.bounds);
    this.gate.setSize(b.width, b.height);
    const band = !!b.band;
    if (band !== this.band) {
      this.band = band;
      if (this.shown) this.emit('layout', { band });
    }
    if (this.req) this.updateRefusal();
    if (changed && rearm) this.rearm('resize', true);
  }

  /** 바가 디스플레이 작업 영역 밖이면 창을 작업 영역 안으로 옮긴다. */
  private keepOnScreen(): void {
    const cb = this.win.getContentBounds();
    const area = screen.getDisplayMatching(cb).workArea;
    const b = this.place(cb.width, cb.height, false);
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

  /** OS 커서가 지금 바의 화면 영역 안에 있는가(무장 사건 때 "멈춘 커서 아래 뜸"을 판단). */
  private cursorInside(): boolean {
    if (this.win.isDestroyed()) return false;
    const p = this.cursorPoint();
    const cb = this.win.getContentBounds();
    const x = p.x - cb.x - this.bounds.x;
    const y = p.y - cb.y - this.bounds.y;
    return x >= 0 && y >= 0 && x < this.bounds.width && y < this.bounds.height;
  }

  private updateRefusal(): void {
    if (!this.lines) return;
    const over = this.baseRefusal ? null : overflowLine(this.lines, this.bounds.width);
    this.refusal = this.baseRefusal ?? (over ? REFUSAL_TEXT.overflow(over) : null);
  }

  private armedNow(): boolean {
    return this.gate.armed(this.now()) && !!this.req && !this.refusal;
  }

  /** 무장 사건. 무장 전 페이지를 불러오고 600ms 뒤 무장됨 페이지로 바꾼다. */
  private rearm(why: string, force = false): void {
    if (!this.req) return;
    this.gate.rearm(this.now(), this.cursorInside());
    this.emit('judged', { event: `rearm:${why}` });
    // 창을 끄는 동안 move가 연달아 오면 페이지를 매번 다시 불러오지 않는다.
    if (force || this.mode !== 'unarmed' || this.msg) void this.render('unarmed', null);
    this.scheduleArm();
  }

  private scheduleArm(): void {
    clearTimeout(this.armTimer);
    // 커서 위장 중에는 예약하지 않는다. 풀리면 rearm이 다시 예약한다.
    if (!this.req || this.gate.cursorBlocked) return;
    const delay = this.gate.armTime - this.now();
    if (!Number.isFinite(delay)) return;
    this.armTimer = setTimeout(() => {
      if (this.req && this.gate.armed(this.now())) void this.render('armed', null);
      else this.scheduleArm();
    }, Math.max(0, delay) + 5);
  }

  private onActivate(): void {
    if (!this.req) return;
    this.gate.windowActivated(this.now());
    clearTimeout(this.activationTimer);
    this.activationTimer = setTimeout(() => {
      if (this.gate.activationSettled()) this.rearm('activate', true);
    }, ACTIVATION_GRACE_MS);
  }

  private onMouse(m: Electron.MouseInputEvent): void {
    const now = this.now();
    const ev = { type: m.type, x: m.x, y: m.y, button: m.button, movementX: m.movementX, movementY: m.movementY };
    // 들어옴·나감·움직임은 바가 숨었거나 무장을 거부한 동안에도 기록한다(추적 상태가 게이트를 넘어 남지 않게).
    if (!this.req || !this.shown || this.refusal) return this.gate.track(ev, now);
    // 무장은 "무장됨 페이지가 화면에 올라옴"까지 요구한다. 아직 앞 페이지가 보이면 무장 지연을 다시 센다.
    if (m.type === 'mouseDown' && m.button === 'left' && this.gate.armed(now) && !(this.committedFor(this.req) && this.committed?.mode === 'armed')) {
      this.gate.deferArm(now);
      this.emit('judged', { event: m.type, x: m.x, y: m.y, result: { kind: 'refused', reason: 'not_committed' } });
      void this.render('unarmed', BAR_MESSAGES.arming);
      this.scheduleArm();
      return;
    }
    const r = this.gate.mouse(ev, now);
    if (m.type === 'mouseDown' || m.type === 'mouseUp' || r) this.emit('judged', { event: m.type, x: m.x, y: m.y, result: r });
    if (!r) return;
    if (r.kind === 'approve') return this.approve();
    if (r.reason === 'dwell') void this.render('armed', BAR_MESSAGES.dwell);
    else {
      void this.render('unarmed', BAR_MESSAGES[r.reason]);
      this.scheduleArm();
    }
  }

  /**
   * 정적 페이지 세 가지(무장 전·무장됨·무장됨 + 문구)와 무장 거부를 바꿔 불러온다. 애니메이션·insertCSS 없음.
   * 페이지가 화면에 올라오면(loadURL 완료) committed가 그 페이지를 가리킨다.
   */
  private render(mode: BarMode, msg: string | null): Promise<void> {
    const req = this.req;
    if (!req || !this.lines || this.win.isDestroyed()) return Promise.resolve();
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
    const done = (ok: boolean) => {
      if (ok && this.pageId === id) this.committed = { id, reqId: req.reqId, mode: effective };
      if (prev) pages.delete(prev);
    };
    this.lastRender = this.view.webContents.loadURL(`${APPROVAL_SCHEME}://${HOST}/${id}`).then(
      () => done(true),
      () => done(false),
    );
    return this.lastRender;
  }
}
