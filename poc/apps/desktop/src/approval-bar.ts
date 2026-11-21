import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { app, nativeTheme, screen, session, WebContentsView, type BrowserWindow, type Session } from 'electron';
import { attestSelfCheck, gateSelfCheck } from '@sax/engine/gate';
import type { EventLog } from '@sax/platform';
import {
  ACTION_TEXT,
  batchActionText,
  actionText,
  attestRefusalText,
  attestRows,
  attestText,
  BAR_AGAIN_TEXT,
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
  certGateText,
  GATE_TEXT,
  gateText,
  issueLocalApproval,
  issueLocalAttestation,
  kstToday,
  overflowLine,
  REFUSAL_TEXT,
  refusalText,
  summarize,
  summarizeCert,
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


export const APPROVAL_SCHEME = 'sax-approval';
const HOST = 'bar';
const pages = new Map<string, string>();
const BLANK = 'blank';
let ses: Session | null = null;
let colors: { palette: BarPalette; rejected: string | null } | null = null;

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
  ses = session.fromPartition('sax-approval');
  ses.protocol.handle(APPROVAL_SCHEME, (req) => {
    const u = new URL(req.url);
    if (u.host !== HOST) return new Response('', { status: 404 });
    if (u.pathname === '/bar.css') return new Response(barCss(barColors().palette), { headers: appHeaders('text/css', BAR_CSP) });
    const html = u.pathname === `/${BLANK}` ? '<!doctype html><meta charset="utf-8">' : pages.get(u.pathname.slice(1));
    return html ? new Response(html, { headers: appHeaders('text/html; charset=utf-8', BAR_CSP) }) : new Response('', { status: 404 });
  });
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith(`${APPROVAL_SCHEME}://${HOST}/`) }));
  hardenSession(ses);
  return ses;
}

type Placer = (contentWidth: number, contentHeight: number, wide: boolean, height: number) => Rect & { band?: boolean };

type BarOutcome = { decision: 'approve'; approval: LocalApproval; batch: number } | { decision: 'closed'; reason: string };
interface BarBatch {
  count: number;
  lines: ReadonlyArray<{ name: string; total: number }>;
}
type AttestOutcome = { decision: 'attest'; attestation: LocalAttestation } | { decision: 'closed'; reason: string };

type BarItem =
  | { kind: 'gate'; id: string; runId: string; gate: GateRequest; done: (o: BarOutcome) => void }
  | { kind: 'attest'; id: string; runId: string; attest: AttestRequest; done: (o: AttestOutcome) => void };

interface BarSnapshot {
  visible: boolean;
  kind: 'gate' | 'attest' | null;
  runId: string | null;
  reqId: string | null;
  mode: BarMode;
  msg: string | null;
  committed: { reqId: string; mode: BarMode } | null;
  bounds: Rect;
  band: boolean;
  armed: boolean;
  refusal: string | null;
  action: string;
  stop: string;
  irreversible: string;
  targets: CardTargets;
}

interface BarOptions {
  log?: EventLog;
}

export class ApprovalBar extends EventEmitter {
  readonly view: WebContentsView;
  private readonly gate: BarGate;
  private readonly win: BrowserWindow;
  private readonly key: Uint8Array;
  private readonly place: Placer;
  private req: BarItem | null = null;
  private lines: SummaryLine[] | null = null;
  private text: CardText = GATE_TEXT;
  private height = cardHeight(CARD_ROWS['H-01']);
  private batchShown = 0;
  private targets: CardTargets = cardTargets(0, 0);
  private baseRefusal: string | null = null;
  private refusal: string | null = null;
  private bounds: Rect = { x: 0, y: 0, width: 0, height: 0 };
  private band = false;
  private shown = false;
  private mode: BarMode = 'armed';
  private msg: string | null = null;
  private pageId: string | null = null;
  private committed: { id: string; reqId: string; mode: BarMode } | null = null;
  private lastRender: Promise<void> = Promise.resolve();
  private readonly myPages = new Set<string>();

  constructor(win: BrowserWindow, key: Uint8Array, place: Placer, opts: BarOptions = {}) {
    assertNoDebugSwitches(app);
    super();
    const rejected = barColors().rejected;
    if (rejected) opts.log?.event('bar.tokens_rejected', { reason: rejected });
    this.win = win;
    this.key = key;
    this.place = place;
    this.gate = new BarGate();
    this.view = new WebContentsView({
      webPreferences: { session: barSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, devTools: false, spellcheck: false, focusOnNavigation: false, webviewTag: false },
    });
    const prefs = lastWebPrefs(this.view.webContents);
    const bad = [...webPrefsProblems(prefs), ...(prefs?.javascript !== false ? ['javascript'] : [])];
    if (bad.length) {
      this.view.webContents.close();
      throw new Error(`harden.bar_webprefs:${bad.join(',')}`);
    }
    this.view.setVisible(false);
    win.contentView.addChildView(this.view);
    const wc = this.view.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.on('will-redirect', (e) => e.preventDefault());
    wc.on('before-mouse-event', (_e, m) => this.onMouse(m));
    wc.on('before-input-event', (e, i) => {
      e.preventDefault();
      if (i.type === 'keyDown' && !i.isAutoRepeat && this.req && this.shown && STOP_KEYS.includes(i.key)) return this.stopByUser('key');
      if (this.req?.kind === 'gate' && this.shown && !this.refusal && this.committedFor(this.req) && this.committed?.mode === 'armed' && this.gate.key({ type: i.type, key: i.key, alt: i.alt, control: i.control, meta: i.meta })?.kind === 'approve') this.approve();
    });
    wc.on('focus', () => {
      if (!this.shown && !win.isDestroyed()) win.webContents.focus();
    });
    wc.on('did-finish-load', () => {
      wc.setZoomFactor(1);
      void wc.setVisualZoomLevelLimits(1, 1);
    });
    void wc.loadURL(`${APPROVAL_SCHEME}://${HOST}/${BLANK}`).catch(() => {});

    const reset = (why: string) => () => this.reset(why);
    win.on('resize', () => this.relayout());
    win.on('move', reset('move'));
    win.on('moved', reset('moved'));
    win.on('show', reset('show'));
    win.on('restore', reset('restore'));
    win.on('focus', reset('activate'));
    const onDisplay = () => {
      this.relayout();
      this.reset('display-metrics-changed');
    };
    screen.on('display-metrics-changed', onDisplay);
    const onTheme = () => this.paintBackground();
    nativeTheme.on('updated', onTheme);
    win.on('closed', () => {
      screen.off('display-metrics-changed', onDisplay);
      nativeTheme.off('updated', onTheme);
      this.finish({ decision: 'closed', reason: 'window_closed' });
    });
    win.webContents.on('cursor-changed', (_e, type) => {
      const blocked = type === 'none' || type === 'custom';
      if (blocked === this.gate.cursorBlocked) return;
      this.gate.setCursorBlocked(blocked);
      if (blocked) {
        if (this.req) void this.render('unarmed', null);
      } else this.reset('cursor-restored');
    });
    this.relayout();
  }

  get visible(): boolean {
    return this.shown;
  }

  get active(): boolean {
    return this.req !== null;
  }

  get runId(): string | null {
    return this.req?.runId ?? null;
  }

  get kind(): 'gate' | 'attest' | null {
    return this.req?.kind ?? null;
  }

  snapshot(): BarSnapshot {
    const c = this.committed && this.committed.id === this.pageId ? { reqId: this.committed.reqId, mode: this.committed.mode } : null;
    const t = this.targets;
    return { visible: this.shown, kind: this.kind, runId: this.runId, reqId: this.req?.id ?? null, mode: this.mode, msg: this.msg, committed: c, bounds: { ...this.bounds }, band: this.band, armed: this.armedNow(), refusal: this.refusal, action: this.text.action, stop: this.text.stop, irreversible: this.text.irreversible, targets: { approve: { ...t.approve }, stop: { ...t.stop } } };
  }

  open(req: GateRequest, auth?: string, batch?: BarBatch | null, certName?: string): Promise<BarOutcome> {
    if (this.win.isDestroyed()) return Promise.resolve({ decision: 'closed', reason: 'window_closed' });
    if (this.req?.kind === 'gate') return Promise.resolve({ decision: 'closed', reason: 'busy' });
    if (this.req) this.finish({ decision: 'closed', reason: 'gate' });
    let bad: ReturnType<typeof gateSelfCheck> = 'field_key';
    try {
      if (req.v === 2 && Array.isArray(req.fields)) bad = gateSelfCheck(req);
    } catch {
      // 모양이 다르면 field_key로 둔다
    }
    const cert = req.docType === 'cert';
    const summary = bad ? null : cert ? summarizeCert(req) : summarize(req, kstToday(Date.now()));
    this.lines = Array.isArray(summary) ? summary : [];
    const f = Array.isArray(summary) ? new Map(req.fields.map((x) => [x.fieldKey, x.value])) : null;
    const action = bad ? ACTION_TEXT : actionText(req);
    const many = !cert && !!batch && batch.count > 1 && batch.lines.length === batch.count - 1 && action === ACTION_TEXT && !!f;
    this.batchShown = many ? batch.count : 0;
    if (many) this.lines.push(...batch.lines.map((l, i) => ({ label: `${i + 2}번째`, pieces: [{ text: l.name, shrink: true }, { text: `, ${Number(l.total).toLocaleString('en-US')}원` }] })));
    this.text = cert ? certGateText(certName ?? '증명서', action) : gateText(many ? batchActionText(batch.count) : action, many ? `${f.get('counterpartName') ?? ''} 외 ${batch.count - 1}건` : f?.get('counterpartName'), !!f?.get('counterpartEmail'), auth);
    this.height = cardHeight(cert ? CARD_ROWS.cert : CARD_ROWS['H-01'] + (many ? batch.count - 1 : 0));
    this.baseRefusal = bad ? (bad === 'duplicate' ? REFUSAL_TEXT.duplicate() : REFUSAL_TEXT.hash()) : Array.isArray(summary) ? null : refusalText(summary!);
    return new Promise<BarOutcome>((done) => {
      this.req = { kind: 'gate', id: req.reqId, runId: req.runId, gate: req, done };
      void this.show(this.req);
    });
  }

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
    this.text = attestText(Array.isArray(summary) ? req.fields.find((x) => x.fieldKey === 'counterpartName')?.value : undefined);
    this.height = cardHeight(attestRows(req.manualCheck));
    this.baseRefusal = bad ? attestRefusalText(REFUSAL_TEXT.hash()) : Array.isArray(summary) ? null : attestRefusalText(refusalText(summary!));
    return new Promise<AttestOutcome>((done) => {
      this.req = { kind: 'attest', id: req.attestReqId, runId: req.runId, attest: req, done };
      void this.show(this.req);
    });
  }

  close(reason: string, reqId?: string): void {
    if (this.req?.kind !== 'gate' && reqId) return;
    if (reqId && this.req?.id !== reqId) return;
    this.finish({ decision: 'closed', reason });
  }

  closeAttest(reason: string, match: { attestReqId?: string; runId?: string } = {}): void {
    if (this.req?.kind !== 'attest') return;
    if (match.attestReqId && this.req.id !== match.attestReqId) return;
    if (match.runId && this.req.runId !== match.runId) return;
    this.finish({ decision: 'closed', reason });
  }

  private async show(req: BarItem): Promise<void> {
    this.keepOnScreen();
    this.relayout(false);
    this.gate.reset();
    void this.render(this.liveMode(), null);
    let p: Promise<void>;
    do {
      p = this.lastRender;
      await p;
    } while (p !== this.lastRender && this.req === req);
    if (this.req !== req || this.win.isDestroyed()) return;
    if (!this.committedFor(req)) return this.finish({ decision: 'closed', reason: 'load_failed' });
    this.win.contentView.addChildView(this.view);
    this.view.setVisible(true);
    this.shown = true;
    if (!this.win.isFocused()) this.win.flashFrame(true);
    this.emit('shown', { band: this.band, kind: req.kind, height: this.bounds.height });
    this.reset('shown');
  }

  private committedFor(req: BarItem): boolean {
    return !!this.committed && this.committed.id === this.pageId && this.committed.reqId === req.id;
  }

  private finish(o: BarOutcome | AttestOutcome): void {
    const item = this.req;
    if (!item) return;
    this.req = null;
    this.lines = null;
    this.batchShown = 0;
    this.refusal = null;
    this.baseRefusal = null;
    this.msg = null;
    this.mode = 'armed';
    this.shown = false;
    if (!this.win.isDestroyed()) {
      const hadFocus = this.view.webContents.isFocused();
      this.view.setVisible(false);
      this.win.flashFrame(false);
      if (hadFocus) this.win.webContents.focus();
      this.pageId = null;
      this.committed = null;
      for (const id of this.myPages) pages.delete(id);
      this.myPages.clear();
      void this.view.webContents.loadURL(`${APPROVAL_SCHEME}://${HOST}/${BLANK}`).catch(() => {});
    }
    this.emit('hidden', o.decision === 'approve' ? 'approved' : o.decision === 'attest' ? 'attested' : o.reason, item.kind);
    if (item.kind === 'gate') item.done(o.decision === 'attest' ? { decision: 'closed', reason: 'kind_mismatch' } : o);
    else item.done(o.decision === 'approve' ? { decision: 'closed', reason: 'kind_mismatch' } : o);
  }

  private stopByUser(via: 'click' | 'key'): void {
    const req = this.req;
    if (!req) return;
    this.emit('judged', { event: `stop:${via}` });
    this.finish({ decision: 'closed', reason: req.kind === 'gate' ? 'stopped' : 'dismissed' });
  }

  private approve(): void {
    const req = this.req;
    if (!req) return;
    if (req.kind === 'gate') this.finish({ decision: 'approve', approval: issueLocalApproval(this.key, req.gate, 'click'), batch: this.batchShown });
    else this.finish({ decision: 'attest', attestation: issueLocalAttestation(this.key, req.attest) });
    if (!this.win.isDestroyed()) this.win.webContents.focus();
  }

  private decide(w: number, h: number): Rect & { band?: boolean } {
    const b = this.place(w, h, false, this.height);
    return this.req && overflowLine(this.lines ?? [], b.width, this.text) ? this.place(w, h, true, this.height) : b;
  }

  layoutChanged(): void {
    this.relayout();
  }

  private relayout(reset = true): void {
    if (this.win.isDestroyed()) return;
    const [w, h] = this.win.getContentSize() as [number, number];
    const b = this.decide(w, h);
    const changed = b.x !== this.bounds.x || b.y !== this.bounds.y || b.width !== this.bounds.width || b.height !== this.bounds.height;
    this.bounds = { x: b.x, y: b.y, width: b.width, height: b.height };
    this.view.setBounds(this.bounds);
    this.targets = cardTargets(b.width, b.height);
    this.gate.setTargets(this.targets);
    const band = !!b.band;
    if (band !== this.band) {
      this.band = band;
      if (this.shown) this.emit('layout', { band, height: b.height });
    }
    if (this.req) this.updateRefusal();
    if (changed && reset) this.reset('resize');
  }

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

  private updateRefusal(): void {
    if (!this.lines) return;
    const over = this.baseRefusal ? null : overflowLine(this.lines, this.bounds.width, this.text);
    this.refusal = this.baseRefusal ?? (over ? REFUSAL_TEXT.overflow(over) : this.bounds.y < 0 ? REFUSAL_TEXT.tall() : null);
  }

  private armedNow(): boolean {
    return this.gate.armed() && !!this.req && !this.refusal;
  }

  private liveMode(): BarMode {
    return this.gate.cursorBlocked ? 'unarmed' : 'armed';
  }

  private reset(why: string): void {
    if (!this.req) return;
    this.gate.reset();
    this.emit('judged', { event: `reset:${why}` });
    void this.render(this.liveMode(), why === 'activate' && this.shown && this.pointerOn('approve') ? BAR_AGAIN_TEXT : null);
  }

  private pointerOn(k: 'approve' | 'stop'): boolean {
    if (this.win.isDestroyed()) return false;
    const p = screen.getCursorScreenPoint();
    const c = this.win.getContentBounds();
    const t = this.targets[k];
    const x = p.x - c.x - this.bounds.x;
    const y = p.y - c.y - this.bounds.y;
    return x >= t.x && x < t.x + t.width && y >= t.y && y < t.y + t.height;
  }

  private onMouse(m: Electron.MouseInputEvent): void {
    const ev = { type: m.type, x: m.x, y: m.y, button: m.button };
    if (!this.req || !this.shown) return this.gate.track(ev);
    if (this.gate.stop(ev)) return this.stopByUser('click');
    if (this.refusal) return this.gate.track(ev);
    if (m.type === 'mouseDown' && m.button === 'left' && this.gate.armed() && !(this.committedFor(this.req) && this.committed?.mode === 'armed')) {
      this.gate.reset();
      this.emit('judged', { event: m.type, x: m.x, y: m.y, result: { kind: 'refused', reason: 'not_committed' } });
      return;
    }
    const r = this.gate.mouse(ev);
    if (m.type === 'mouseDown' || m.type === 'mouseUp' || r) this.emit('judged', { event: m.type, x: m.x, y: m.y, result: r });
    if (!r) return;
    if (r.kind === 'approve') return this.approve();
    void this.render('unarmed', BAR_MESSAGES[r.reason]);
  }

  private paintBackground(): void {
    if (this.win.isDestroyed()) return;
    this.view.setBackgroundColor(barColors().palette[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'].surface);
  }

  private render(mode: BarMode, msg: string | null): Promise<void> {
    const req = this.req;
    if (!req || !this.lines || this.win.isDestroyed()) return Promise.resolve();
    const effective: BarMode = this.refusal ? 'refused' : mode;
    const text = this.refusal ?? msg;
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
