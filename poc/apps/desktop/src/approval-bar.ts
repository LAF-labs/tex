import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { app, nativeTheme, screen, session, WebContentsView, type BrowserWindow, type Session } from 'electron';
import { attestSelfCheck, gateSelfCheck } from '@sax/engine/gate';
import type { EventLog } from '@sax/platform';
import {
  ACTION_TEXT,
  ACTIVATION_GRACE_MS,
  actionText,
  ATTEST_TEXT,
  attestRefusalText,
  attestRows,
  BAR_MESSAGES,
  BAR_PALETTE_DEFAULT,
  BAR_CSP,
  BarGate,
  barCss,
  barPalette,
  buildCardHtml,
  CARD_ROWS,
  cardHeight,
  cardTargets,
  GATE_TEXT,
  gateText,
  HandoffMark,
  inBox,
  issueLocalApproval,
  issueLocalAttestation,
  kstToday,
  overflowLine,
  REFUSAL_TEXT,
  refusalText,
  summarize,
  STOP_KEYS,
  summarizeAttest,
  type AttestRequest,
  type BarMode,
  type BarPalette,
  type CardTargets,
  type CardText,
  type GateRequest,
  type LocalApproval,
  type LocalAttestation,
  type SummaryLine,
} from './approval-gate.ts';
import { appHeaders, assertNoDebugSwitches, hardenSession, lastWebPrefs, webPrefsProblems } from './harden.ts';
import type { Rect } from './shell-layout.ts';
import { loadTokens } from './shell-tokens.ts';

// ADR-021 결정 1·7: main 소유 승인 카드. 메인 창 contentView의 맨 위 자식 WebContentsView이고, 스크립트·preload가 없는 정적 페이지다.
// 값 전체(엔진 게이트 요청 fields), 비가역 한 줄, 떨어진 두 버튼 [중지]·[승인하고 발급]을 그린다. 위치·높이는 main이 창 크기와
// 서류 종류별 줄 수로 정하고, 승인은 main이 이 뷰의 before-mouse-event로 직접 관찰한 [승인하고 발급] 영역 클릭으로만 인정한다.
// 이 파일과 shell-app의 '바'는 이 카드를 뜻한다(옛 이름).

export const APPROVAL_SCHEME = 'sax-approval';
const HOST = 'bar';
const pages = new Map<string, string>();
const BLANK = 'blank';
let ses: Session | null = null;
let colors: { palette: BarPalette; rejected: string | null } | null = null;

/** 바 색: 디자인 시스템 토큰을 형식·대비로 검사해 통과한 것만, 아니면 내장 팔레트(ADR-028 결정 7). 기동 때 한 번 정한다. */
function barColors(): { palette: BarPalette; rejected: string | null } {
  if (colors) return colors;
  try {
    colors = barPalette(loadTokens());
  } catch {
    colors = { palette: BAR_PALETTE_DEFAULT, rejected: 'unreadable' };
  }
  return colors;
}

function barSession(): Session {
  if (ses) return ses;
  ses = session.fromPartition('sax-approval'); // 메모리 파티션(persist: 아님)
  ses.protocol.handle(APPROVAL_SCHEME, (req) => {
    const u = new URL(req.url);
    if (u.host !== HOST) return new Response('', { status: 404 });
    if (u.pathname === '/bar.css') return new Response(barCss(barColors().palette), { headers: appHeaders('text/css', BAR_CSP) });
    const html = u.pathname === `/${BLANK}` ? '<!doctype html><meta charset="utf-8">' : pages.get(u.pathname.slice(1));
    // meta CSP와 같은 정책을 응답 헤더로도 건다(D11 §4 승인 바 행).
    return html ? new Response(html, { headers: appHeaders('text/html; charset=utf-8', BAR_CSP) }) : new Response('', { status: 404 });
  });
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith(`${APPROVAL_SCHEME}://${HOST}/`) }));
  // 권한·장치 거부, 내려받기 금지, 맞춤법 사전 끔(셸 기본 세션과 같은 함수).
  hardenSession(ses);
  return ses;
}

/** 카드 자리 계산. wide면 레일 오른쪽부터 창 끝까지의 띠(값이 대화 열 폭에 안 들어갈 때). height는 main이 줄 수로 정한 카드 높이. */
export type Placer = (contentWidth: number, contentHeight: number, wide: boolean, height: number) => Rect & { band?: boolean };

export type BarOutcome = { decision: 'approve'; approval: LocalApproval } | { decision: 'closed'; reason: string };
export type AttestOutcome = { decision: 'attest'; attestation: LocalAttestation } | { decision: 'closed'; reason: string };

/**
 * 바 자리에 올라온 것(ADR-021 표시 조건). 게이트(비가역 승인)와 InDoubt 증언 두 가지이고, 우선순위는 게이트 > 증언이다.
 * id는 게이트면 reqId, 증언이면 attestReqId다.
 */
type BarItem =
  | { kind: 'gate'; id: string; runId: string; gate: GateRequest; done: (o: BarOutcome) => void }
  | { kind: 'attest'; id: string; runId: string; attest: AttestRequest; done: (o: AttestOutcome) => void };

export interface BarSnapshot {
  visible: boolean;
  /** 바 자리에 올라온 것. 증언 바는 'attest'. */
  kind: 'gate' | 'attest' | null;
  runId: string | null;
  /** 게이트면 reqId, 증언이면 attestReqId. */
  reqId: string | null;
  /** main이 그리려는 모드와, 지금 실제로 화면에 올라온(커밋된) 페이지. */
  mode: BarMode;
  msg: string | null;
  committed: { reqId: string; mode: BarMode } | null;
  bounds: Rect;
  band: boolean;
  armed: boolean;
  refusal: string | null;
  /** 동작 글자(중복 경고가 있으면 "같은 건 기록을 확인했고 발급"). */
  action: string;
  /** [중지] 자리 글자(증언 카드는 "닫기"). */
  stop: string;
  /** 두 판정 영역(카드 기준 DIP). */
  targets: CardTargets;
}

export interface BarOptions {
  armDelayMs?: number;
  /** OS 커서 위치(DIP 화면 좌표). e2e가 바꿔 끼운다. */
  cursorPoint?: () => { x: number; y: number };
  /** 토큰 거부(bar.tokens_rejected)를 남길 곳. */
  log?: EventLog;
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
  private req: BarItem | null = null;
  private lines: SummaryLine[] | null = null;
  private text: CardText = GATE_TEXT;
  /** 줄 수로 정한 카드 높이(게이트마다 한 번). */
  private height = cardHeight(CARD_ROWS['H-01']);
  private targets: CardTargets = cardTargets(0, 0, ACTION_TEXT);
  private baseRefusal: string | null = null;
  private refusal: string | null = null;
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
  /** 이 바가 만든 페이지 id. 게이트가 끝나면 지워 값(상호·금액·이메일)이 메모리에 남지 않게 한다. */
  private readonly myPages = new Set<string>();
  /** 무장 사건 때의 OS 커서 위치("멈춘 커서" 예외 확인용). */
  private armCursor: { x: number; y: number } | null = null;
  /** main이 다른 창을 앞에 올렸다 돌아온 표시(다음 활성화에 한 번 쓴다). */
  private readonly handoff = new HandoffMark();
  /** 시계가 바뀌어도 무장 지연이 짧아지지 않게 단조 시계를 쓴다. */
  private readonly now = () => performance.now();

  constructor(win: BrowserWindow, key: Uint8Array, place: Placer, opts: BarOptions = {}) {
    // 디버그 스위치(CDP·검사기)가 있으면 바 입력을 믿을 수 없다. 바를 만들지 않는다(ADR-025 결정 8).
    assertNoDebugSwitches(app);
    super();
    const rejected = barColors().rejected;
    if (rejected) opts.log?.event('bar.tokens_rejected', { reason: rejected });
    this.win = win;
    this.key = key;
    this.place = place;
    this.cursorPoint = opts.cursorPoint ?? (() => screen.getCursorScreenPoint());
    this.gate = new BarGate(opts.armDelayMs);
    this.view = new WebContentsView({
      webPreferences: { session: barSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, devTools: false, spellcheck: false, focusOnNavigation: false, webviewTag: false },
    });
    // 자기 점검(D11 §4 승인 바 행): 실제로 걸린 값으로 본다. 스크립트가 켜져 있으면 바를 만들지 않는다(devTools는 이 값에 없어 소스 시험으로 본다).
    const prefs = lastWebPrefs(this.view.webContents);
    const bad = [...webPrefsProblems(prefs), ...(prefs?.javascript !== false ? ['javascript'] : [])];
    if (bad.length) {
      this.view.webContents.close();
      throw new Error(`harden.bar_webprefs:${bad.join(',')}`);
    }
    // 뷰는 미리 붙여 두고 setVisible로 보이고 숨긴다(ADR-021).
    this.view.setVisible(false);
    win.contentView.addChildView(this.view);
    const wc = this.view.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.on('will-redirect', (e) => e.preventDefault());
    wc.on('before-mouse-event', (_e, m) => this.onMouse(m));
    // 키보드 승인은 없다(Enter·Space·조합키 모두). 카드는 뜰 때 포커스를 가져가지 않는다(입력창 타이핑을 끊지 않음).
    // 사용자가 카드를 눌러 포커스가 카드에 오면 기본 포커스는 [중지]다: Enter·Space·Esc는 중지(안전한 실패), 나머지 키는 버린다.
    wc.on('before-input-event', (e, i) => {
      e.preventDefault();
      if (i.type === 'keyDown' && !i.isAutoRepeat && this.req && this.shown && STOP_KEYS.includes(i.key)) return this.stopByUser('key');
      // 키보드 승인은 꺼져 있다(KEYBOARD_APPROVAL). 켜더라도 무장 거부·숨김 중에는 승인하지 않는다.
      if (this.req?.kind === 'gate' && this.shown && !this.refusal && this.committedFor(this.req) && this.committed?.mode === 'armed' && this.gate.key({ type: i.type, key: i.key, alt: i.alt, control: i.control, meta: i.meta }, this.now())?.kind === 'approve') this.approve();
    });
    // 숨은 카드로 간 포커스는 대화 화면으로 돌려준다(보이는 동안만 카드가 키를 받는다).
    wc.on('focus', () => {
      if (!this.shown && !win.isDestroyed()) win.webContents.focus();
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
    // 창이 뒤로 가면 무장 전(흐림) 페이지로 바꿔 상태를 보인다. 무장 판정은 그대로 두고 돌아올 때 정한다(onActivate).
    win.on('blur', () => {
      if (!this.req || !this.shown) return;
      clearTimeout(this.armTimer);
      void this.render('unarmed', null);
    });
    const onDisplay = () => {
      this.relayout();
      this.rearm('display-metrics-changed');
    };
    screen.on('display-metrics-changed', onDisplay);
    // 페이지 CSS가 prefers-color-scheme로 스스로 바뀐다. 뷰 배경색만 맞춘다.
    const onTheme = () => this.paintBackground();
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
      } else this.rearm('cursor-restored');
    });
    this.relayout();
  }

  get visible(): boolean {
    return this.shown;
  }

  /** 지금 열린 게이트(또는 증언)의 실행 ID. */
  get runId(): string | null {
    return this.req?.runId ?? null;
  }

  /** 지금 바 자리에 올라온 것의 종류. */
  get kind(): 'gate' | 'attest' | null {
    return this.req?.kind ?? null;
  }

  snapshot(): BarSnapshot {
    const c = this.committed && this.committed.id === this.pageId ? { reqId: this.committed.reqId, mode: this.committed.mode } : null;
    const t = this.targets;
    return { visible: this.shown, kind: this.kind, runId: this.runId, reqId: this.req?.id ?? null, mode: this.mode, msg: this.msg, committed: c, bounds: { ...this.bounds }, band: this.band, armed: this.armedNow(), refusal: this.refusal, action: this.text.action, stop: this.text.stop, targets: { approve: { ...t.approve }, stop: { ...t.stop } } };
  }

  /**
   * 게이트 요청을 받아 바를 띄운다. 승인 또는 close()까지 기다린다. 열린 게이트가 있으면 바꾸지 않고 'busy'.
   * 증언 바가 떠 있으면 게이트가 자리를 가져간다(증언은 'gate'로 끝나고, 엔진도 그 증언 요청을 'gate'로 철회한다).
   */
  open(req: GateRequest): Promise<BarOutcome> {
    if (this.win.isDestroyed()) return Promise.resolve({ decision: 'closed', reason: 'window_closed' });
    if (this.req?.kind === 'gate') return Promise.resolve({ decision: 'closed', reason: 'busy' });
    if (this.req) this.finish({ decision: 'closed', reason: 'gate' });
    // 엔진이 보낸 fields로 readbackHash·cardHash·actionHash를 다시 계산해 같을 때만 무장한다(D03 §3, 자기 일치 확인이지 엔진 침해 방어가 아님).
    let bad: ReturnType<typeof gateSelfCheck> = 'field_key';
    try {
      if (req.v === 2 && Array.isArray(req.fields)) bad = gateSelfCheck(req);
    } catch {
      // 모양이 다르면 field_key로 둔다
    }
    const summary = bad ? null : summarize(req, kstToday(Date.now()));
    this.lines = Array.isArray(summary) ? summary : [];
    this.text = gateText(bad ? ACTION_TEXT : actionText(req));
    this.height = cardHeight(CARD_ROWS['H-01']);
    this.baseRefusal = bad ? (bad === 'duplicate' ? REFUSAL_TEXT.duplicate() : REFUSAL_TEXT.hash()) : Array.isArray(summary) ? null : refusalText(summary!);
    return new Promise<BarOutcome>((done) => {
      this.req = { kind: 'gate', id: req.reqId, runId: req.runId, gate: req, done };
      void this.show(this.req);
    });
  }

  /**
   * InDoubt 증언 바(ADR-021 결정 5). 사용자가 그 "확인 필요" 카드를 열었을 때만 shell-app이 부른다(자동으로 띄우지 않는다).
   * 게이트·다른 증언이 떠 있으면 바꾸지 않고 'busy'. 판정 규칙(무장 지연·머무름·커서·키보드 없음)은 승인과 같고,
   * 클릭이 인정되면 승인 근거가 아니라 LocalAttestation을 발급한다.
   */
  openAttest(req: AttestRequest): Promise<AttestOutcome> {
    if (this.win.isDestroyed()) return Promise.resolve({ decision: 'closed', reason: 'window_closed' });
    if (this.req) return Promise.resolve({ decision: 'closed', reason: 'busy' });
    let bad: ReturnType<typeof attestSelfCheck> = 'field_key';
    try {
      if (req.v === 1 && Array.isArray(req.fields)) bad = attestSelfCheck(req);
    } catch {
      // 모양이 다르면 field_key로 둔다
    }
    const summary = bad ? null : summarizeAttest(req);
    this.lines = Array.isArray(summary) ? summary : [];
    this.text = ATTEST_TEXT;
    this.height = cardHeight(attestRows(req.manualCheck));
    this.baseRefusal = bad ? attestRefusalText(REFUSAL_TEXT.hash()) : Array.isArray(summary) ? null : attestRefusalText(refusalText(summary!));
    return new Promise<AttestOutcome>((done) => {
      this.req = { kind: 'attest', id: req.attestReqId, runId: req.runId, attest: req, done };
      void this.show(this.req);
    });
  }

  /** 게이트가 끝남(중지·만료·엔진 취소). reqId를 주면 그 게이트일 때만 닫는다. 증언 바는 closeAttest로 닫는다. */
  close(reason: string, reqId?: string): void {
    if (this.req?.kind !== 'gate' && reqId) return;
    if (reqId && this.req?.id !== reqId) return;
    this.finish({ decision: 'closed', reason });
  }

  /** 증언 바를 내린다(엔진 철회·카드 닫음·실행 끝). attestReqId나 runId를 주면 그것일 때만. */
  closeAttest(reason: string, match: { attestReqId?: string; runId?: string } = {}): void {
    if (this.req?.kind !== 'attest') return;
    if (match.attestReqId && this.req.id !== match.attestReqId) return;
    if (match.runId && this.req.runId !== match.runId) return;
    this.finish({ decision: 'closed', reason });
  }

  /** 새 게이트의 첫 페이지가 화면에 올라온 뒤에만 보인다. 그 전에는 앞 게이트의 페이지가 보일 수 있기 때문이다. */
  private async show(req: BarItem): Promise<void> {
    this.keepOnScreen();
    this.relayout(false);
    this.gate.rearm(this.now(), this.cursorInside());
    this.armCursor = { ...this.cursorPoint() }; // 값으로 복사(같은 객체를 다시 받으면 비교가 늘 참이 된다)
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
    this.emit('shown', { band: this.band, kind: req.kind, height: this.bounds.height });
    this.rearm('shown');
  }

  private committedFor(req: BarItem): boolean {
    return !!this.committed && this.committed.id === this.pageId && this.committed.reqId === req.id;
  }

  private finish(o: BarOutcome | AttestOutcome): void {
    const item = this.req;
    if (!item) return;
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
      // 카드가 키보드 포커스를 가졌으면 대화 화면으로 돌려준다.
      const hadFocus = this.view.webContents.isFocused();
      this.view.setVisible(false);
      this.win.flashFrame(false);
      if (hadFocus) this.win.webContents.focus();
      // 다음 게이트에 앞 게이트의 값이 남아 보이지 않게 빈 페이지로 바꾸고, 이 게이트의 페이지를 지운다.
      this.pageId = null;
      this.committed = null;
      for (const id of this.myPages) pages.delete(id);
      this.myPages.clear();
      void this.view.webContents.loadURL(`${APPROVAL_SCHEME}://${HOST}/${BLANK}`).catch(() => {});
    }
    this.emit('hidden', o.decision === 'approve' ? 'approved' : o.decision === 'attest' ? 'attested' : o.reason, item.kind);
    // 근거의 종류는 바 자리에 올라온 것의 종류와 같아야 한다(승인 바에서 증언이, 증언 바에서 승인이 나가지 않게).
    if (item.kind === 'gate') item.done(o.decision === 'attest' ? { decision: 'closed', reason: 'kind_mismatch' } : o);
    else item.done(o.decision === 'approve' ? { decision: 'closed', reason: 'kind_mismatch' } : o);
  }

  /** [중지](또는 증언 카드의 [닫기]). main이 관찰한 카드 입력이다. 게이트는 shell-app이 실행 중지로 이어 간다. */
  private stopByUser(via: 'click' | 'key'): void {
    const req = this.req;
    if (!req) return;
    this.emit('judged', { event: `stop:${via}` });
    this.finish({ decision: 'closed', reason: req.kind === 'gate' ? 'stopped' : 'dismissed' });
  }

  private approve(): void {
    const req = this.req;
    if (!req) return;
    if (req.kind === 'gate') this.finish({ decision: 'approve', approval: issueLocalApproval(this.key, req.gate, 'click') });
    else this.finish({ decision: 'attest', attestation: issueLocalAttestation(this.key, req.attest) });
    if (!this.win.isDestroyed()) this.win.webContents.focus();
  }

  /** 창 크기와 게이트 값만으로 자리를 정한다. 값·버튼이 대화 열 폭에 안 들어가면 띠로 넓힌다. */
  private decide(w: number, h: number): Rect & { band?: boolean } {
    const b = this.place(w, h, false, this.height);
    return this.req && overflowLine(this.lines ?? [], b.width, this.text) ? this.place(w, h, true, this.height) : b;
  }

  private relayout(rearm = true): void {
    if (this.win.isDestroyed()) return;
    const [w, h] = this.win.getContentSize() as [number, number];
    const b = this.decide(w, h);
    const changed = b.x !== this.bounds.x || b.y !== this.bounds.y || b.width !== this.bounds.width || b.height !== this.bounds.height;
    this.bounds = { x: b.x, y: b.y, width: b.width, height: b.height };
    this.view.setBounds(this.bounds);
    this.targets = cardTargets(b.width, b.height, this.text.action);
    this.gate.setTargets(this.targets);
    const band = !!b.band;
    if (band !== this.band) {
      this.band = band;
      if (this.shown) this.emit('layout', { band, height: b.height });
    }
    if (this.req) this.updateRefusal();
    if (changed && rearm) this.rearm('resize');
  }

  /** 바가 디스플레이 작업 영역 밖이면 창을 작업 영역 안으로 옮긴다. */
  private keepOnScreen(): void {
    const cb = this.win.getContentBounds();
    const area = screen.getDisplayMatching(cb).workArea;
    const b = this.decide(cb.width, cb.height);
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

  /** OS 커서가 지금 [승인하고 발급] 영역의 화면 자리 안에 있는가(무장 사건 때 "멈춘 커서 아래 뜸"을 판단). */
  private cursorInside(): boolean {
    if (this.win.isDestroyed()) return false;
    const p = this.cursorPoint();
    const cb = this.win.getContentBounds();
    return inBox(this.targets.approve, p.x - cb.x - this.bounds.x, p.y - cb.y - this.bounds.y);
  }

  private updateRefusal(): void {
    if (!this.lines) return;
    const over = this.baseRefusal ? null : overflowLine(this.lines, this.bounds.width, this.text);
    this.refusal = this.baseRefusal ?? (over ? REFUSAL_TEXT.overflow(over) : null);
  }

  private armedNow(): boolean {
    return this.gate.armed(this.now()) && !!this.req && !this.refusal;
  }

  /** 무장 사건. 무장 전 페이지를 불러오고 600ms 뒤 무장됨 페이지로 바꾼다. */
  private rearm(why: string): void {
    if (!this.req) return;
    this.gate.rearm(this.now(), this.cursorInside());
    this.armCursor = { ...this.cursorPoint() }; // 값으로 복사(같은 객체를 다시 받으면 비교가 늘 참이 된다)
    this.emit('judged', { event: `rearm:${why}` });
    // 같은 페이지면 render가 다시 불러오지 않는다(창을 끄는 동안 연달아 오는 move).
    void this.render('unarmed', null);
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

  /**
   * main이 다른 창(비밀 창 등, Phase 1: 전용 Chrome·Hello)을 앞에 올렸다가 돌아왔다. 120초 안의 다음 활성화 한 번만
   * 클릭 활성화 예외(100ms)를 받는다. 그 밖의 활성화는 첫 클릭을 앞으로 가져오기로만 받는다(ADR-027 결정 5).
   */
  noteHandoff(now = this.now()): void {
    this.handoff.note(now);
  }

  private onActivate(): void {
    const now = this.now();
    // 게이트가 없을 때 온 활성화도 표시를 쓴다(표시는 한 번만).
    const fromHandoff = this.handoff.consume(now);
    if (!this.req) return;
    clearTimeout(this.activationTimer);
    this.gate.windowActivated(now, fromHandoff);
    if (!fromHandoff) return this.rearm('activate');
    // blur로 내린 무장됨 페이지를 되돌린다(무장 판정은 그대로). 100ms 안 바 클릭이 없으면 재무장한다.
    if (this.gate.armed(now)) void this.render('armed', null);
    this.activationTimer = setTimeout(() => {
      if (this.gate.activationSettled()) this.rearm('activate');
    }, ACTIVATION_GRACE_MS);
  }

  private onMouse(m: Electron.MouseInputEvent): void {
    const now = this.now();
    const ev = { type: m.type, x: m.x, y: m.y, button: m.button, movementX: m.movementX, movementY: m.movementY };
    // 들어옴·나감·움직임은 카드가 숨었거나 무장을 거부한 동안에도 기록한다(추적 상태가 게이트를 넘어 남지 않게).
    if (!this.req || !this.shown) return this.gate.track(ev, now);
    // [중지]는 무장을 기다리지 않고, 무장 거부 중에도 받는다(결정 7 원칙 4).
    if (this.gate.stop(ev)) return this.stopByUser('click');
    if (this.refusal) return this.gate.track(ev, now);
    // 무장은 "무장됨 페이지가 화면에 올라옴"까지 요구한다. 아직 앞 페이지가 보이면 무장 지연을 다시 센다.
    if (m.type === 'mouseDown' && m.button === 'left' && this.gate.armed(now) && !(this.committedFor(this.req) && this.committed?.mode === 'armed')) {
      this.gate.deferArm(now);
      this.emit('judged', { event: m.type, x: m.x, y: m.y, result: { kind: 'refused', reason: 'not_committed' } });
      void this.render('unarmed', BAR_MESSAGES.arming);
      this.scheduleArm();
      return;
    }
    const p = m.type === 'mouseDown' ? this.cursorPoint() : null;
    const unmoved = !!p && !!this.armCursor && p.x === this.armCursor.x && p.y === this.armCursor.y;
    const r = this.gate.mouse(ev, now, unmoved);
    if (m.type === 'mouseDown' || m.type === 'mouseUp' || r) this.emit('judged', { event: m.type, x: m.x, y: m.y, result: r });
    if (!r) return;
    if (r.kind === 'approve') return this.approve();
    if (r.reason === 'dwell') void this.render('armed', BAR_MESSAGES.dwell);
    else {
      void this.render('unarmed', BAR_MESSAGES[r.reason]);
      this.scheduleArm();
    }
  }

  /** 카드 바탕은 모드와 상관없이 surface다(동작 버튼만 색이 바뀐다). 페이지를 바꾸는 사이 빈 뷰가 다른 색으로 번쩍이지 않게 맞춘다. */
  private paintBackground(): void {
    if (this.win.isDestroyed()) return;
    this.view.setBackgroundColor(barColors().palette[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'].surface);
  }

  /**
   * 정적 페이지 세 가지(무장 전·무장됨·무장됨 + 문구)와 무장 거부([중지]만)를 바꿔 불러온다. 애니메이션·insertCSS 없음.
   * 페이지가 화면에 올라오면(loadURL 완료) committed가 그 페이지를 가리킨다.
   */
  private render(mode: BarMode, msg: string | null): Promise<void> {
    const req = this.req;
    if (!req || !this.lines || this.win.isDestroyed()) return Promise.resolve();
    const effective: BarMode = this.refusal ? 'refused' : mode;
    const text = this.refusal ?? msg;
    // 같은 내용의 페이지를 이미 불렀으면 다시 부르지 않는다(요약 줄은 게이트 동안 바뀌지 않는다).
    if (this.pageId && effective === this.mode && text === this.msg) return this.lastRender;
    this.mode = effective;
    this.msg = text;
    this.paintBackground();
    const id = randomUUID();
    pages.set(id, buildCardHtml(this.lines, effective, text ?? undefined, this.text));
    this.myPages.add(id);
    const prev = this.pageId;
    this.pageId = id;
    const done = (ok: boolean) => {
      if (ok && this.pageId === id) this.committed = { id, reqId: req.id, mode: effective };
      if (prev) {
        pages.delete(prev);
        this.myPages.delete(prev);
      }
    };
    this.lastRender = this.view.webContents.loadURL(`${APPROVAL_SCHEME}://${HOST}/${id}`).then(
      () => done(true),
      () => done(false),
    );
    return this.lastRender;
  }
}
