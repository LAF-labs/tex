// 앱 안 브라우저(대표 지시 2026-11-13 "Claude 데스크톱 앱 작동 방식을 참고해라", "크롬 탭이 아예 열리지 않게 앱 내에서 처리해").
// 홈택스 페이지는 메인 창의 WebContentsView(영구 파티션)에 뜨고, 사람은 그 보기를 직접 누른다. 바깥 Chrome은 띄우지 않는다.
// 금고는 이 보기를 설치 Chrome처럼 다룬다: main이 'browser' 포트 위에서 브라우저 수준 CDP를 흉내 내고, 각 보기의
// webContents.debugger(Electron 45 실측: 같은 페이지에 Target.attachToTarget으로 독립 세션을 여러 개 연다)로 넘긴다.
// 금고 중계(노출·비밀 창·출처 검사)는 Chrome 때와 같은 코드다. 이 파일은 프레임을 나르고, 보기를 만들고 없애고, 패널 자리에 둔다.
import { randomUUID } from 'node:crypto';
import { app, session, WebContentsView, type App, type BaseWindow, type Rectangle, type Session, type WebContents } from 'electron';
import type { EventLog } from '@sax/platform';
import { CHROME_APP_START_URL } from '@sax/vault';
import { assertWebPrefs, NAV_EXEMPT_SESSIONS } from './harden.ts';

/** 쿠키·로컬 저장소가 실행과 앱 재시작 사이에 남는다(Claude 데스크톱 브라우저처럼). 이 보기들만 쓴다. */
export const EMBEDDED_PARTITION = 'persist:sax-hometax';

type Json = Record<string, unknown>;
interface CdpFrame {
  id?: number;
  method?: string;
  params?: Json;
  result?: Json;
  error?: { code: number; message: string };
  sessionId?: string;
}

/** 이보다 오래 답이 없는 보기 명령은 진단으로 남긴다(엔진 동작 제한 10초보다 짧게). */
const SLOW_CMD_MS = 3000;
const WATCHED_CMD = /^(Input|DOM)\./;

interface Tab {
  view: WebContentsView;
  wc: WebContents;
  targetId: string;
  openerId?: string;
  /** 이 보기에 열린 flatten 세션(금고 감시·엔진·그 자식). */
  sessions: Set<string>;
  gone: boolean;
}

/**
 * 페이지 배치 폭(CSS px). 옛 실행 Chrome 창(1280×900)과 같게 둔다: 홈택스는 좁은 폭에서 배치가 바뀐다(로그인 상자가 배너 아래로,
 * 머리말이 스크롤로 사라짐, 실화면 예행 run-7045a9c0 s2·run-4683a296 s13). H-01 패키지는 넓은 배치에서 맞췄다.
 * 패널이 더 좁으면 브라우저 확대·축소(setZoomFactor)로 줄여 그린다. CDP 클릭은 축소에서도 CSS 좌표 그대로 맞는다(측정, 기기 크기 흉내는 빗나감).
 */
const PAGE_WIDTH = 1280;
/** 패널에 한 번도 놓이지 않은 보기의 크기(숨김). 0×0이면 페이지가 그 크기로 배치돼 자동화가 깨진다. */
const HIDDEN_BOUNDS: Rectangle = { x: 0, y: 0, width: PAGE_WIDTH, height: 900 };

/** 이 보기 안에서 열면 안 되는 주소(앱 스킴·로컬 파일·브라우저 내부 화면). */
const BLOCKED_SCHEMES = /^(file|chrome|chrome-extension|devtools|view-source|sax-[a-z]+):/i;

/**
 * 설치 Chrome과 같은 꼴의 UA(줄인 판 Chrome/NNN.0.0.0). 앱 이름·Electron 토큰은 뺀다. 버전은 실제 엔진(Chromium) 판이라
 * Sec-CH-UA 브랜드 판과 맞는다. 홈택스는 Chrome·Edge만 지원 브라우저로 본다.
 */
export function chromeLikeUserAgent(fallback = app.userAgentFallback, chromeVersion = process.versions.chrome): string {
  const major = chromeVersion.split('.')[0];
  return fallback
    .split(' ')
    .filter((t) => !/^[A-Za-z][\w.-]*\/[\w.-]+$/.test(t) || /^(Mozilla|AppleWebKit|Chrome|Safari)\//.test(t))
    .join(' ')
    .replace(/Chrome\/[\d.]+/, `Chrome/${major}.0.0.0`);
}

/**
 * 창이 가려지거나 최소화되거나 화면이 잠겨도 앱 안 보기가 계속 그린다(옛 실행 Chrome 인자 --disable-backgrounding-occluded-windows·
 * --disable-renderer-backgrounding·--disable-background-timer-throttling과 같다, vault chrome/launch.ts). 끄면 그동안 보기의
 * requestAnimationFrame이 0번이라(측정, 화면 잠김·최소화·가려짐) Playwright 클릭이 "안정" 확인에서 멈춘다(0.1.19 예행 s13·s3 step.timeout).
 * app ready 전에 부른다.
 */
export function keepDrawingWhenHidden(a: App = app): void {
  for (const s of ['disable-backgrounding-occluded-windows', 'disable-renderer-backgrounding', 'disable-background-timer-throttling']) a.commandLine.appendSwitch(s);
}

export interface EmbeddedBrowserOptions {
  win: BaseWindow;
  /** 금고로 가는 'browser' 포트 메시지({t:'cdp', m} 또는 {t:'cdp_closed'}). */
  post: (m: unknown) => void;
  log: EventLog;
  /** 보이는 보기(맨 위 page)의 주소·제목이 바뀌었다. 패널 주소창·탭 이름용. */
  onPage?: (p: { url: string; title: string } | null) => void;
}

export class EmbeddedBrowser {
  private readonly o: EmbeddedBrowserOptions;
  private readonly ses: Session;
  private readonly tabs = new Map<string, Tab>();
  private readonly bySession = new Map<string, Tab>();
  /** 보이는 순서: 마지막이 맨 위(새 창이 뜨면 그 창이 보인다). */
  private order: Tab[] = [];
  private autoAttach = false;
  private downloadBehavior: Json | null = null;
  private downloadHost: Tab | null = null;
  /** 금고가 Browser.setPermission으로 준 권한(출처 → 이름). 이것만 허용한다. */
  private readonly granted = new Map<string, Set<string>>();
  /** 보기마다 금고·엔진이 attachToTarget으로 연 페이지 세션(자식 iframe·워커 세션이 아닌 것). */
  private readonly topSessions = new Set<string>();
  /** Page.printToPDF(ReturnAsStream) 결과를 IO.read로 내주는 동안 들고 있는 PDF. */
  private readonly pdfStreams = new Map<string, { buf: Buffer; pos: number }>();
  private slot: Rectangle | null = null;
  /** 마지막으로 놓인 자리. 패널이 접혀 숨길 때도 이 크기·배율을 그대로 둔다(숨김 중에 배치가 바뀌지 않게). */
  private placed: Rectangle = HIDDEN_BOUNDS;
  private blocked = false;
  private connected = false;

  constructor(o: EmbeddedBrowserOptions) {
    this.o = o;
    this.ses = session.fromPartition(EMBEDDED_PARTITION);
    NAV_EXEMPT_SESSIONS.add(this.ses);
    this.ses.setUserAgent(chromeLikeUserAgent(), 'ko-KR,ko,en-US,en');
    this.ses.setPermissionRequestHandler((wc, permission, cb, details) => cb(this.allowed(permission, details.requestingUrl ?? wc.getURL())));
    this.ses.setPermissionCheckHandler((_wc, permission, origin) => this.allowed(permission, origin));
    this.ses.setDevicePermissionHandler(() => false);
    this.ses.setSpellCheckerEnabled(false);
    // 금고가 Browser.setDownloadBehavior로 staging에 받게 정한 것만 받는다. 저장 경로가 없는 받기(저장 대화상자)는 막는다.
    this.ses.on('will-download', (e, item) => {
      if (!item.getSavePath()) {
        e.preventDefault();
        this.o.log.event('main.embedded_download_refused');
      }
    });
    // 패널에 없는 보기는 창 오른쪽 아래 구석에 걸쳐 둔다(park). 창 크기가 바뀌면 다시 건다.
    o.win.on('resize', () => this.place());
  }

  private allowed(permission: string, url: string): boolean {
    try {
      return this.granted.get(new URL(url).origin)?.has(permission) === true;
    } catch {
      return false;
    }
  }

  // ───────────────────────── 금고 → 보기 ─────────────────────────

  /** 'browser' 포트에서 온 메시지. */
  feed(raw: unknown): void {
    const m = raw as { t?: unknown; m?: unknown } | null;
    if (m?.t === 'cdp_closed') return void this.closeAll('vault');
    if (m?.t !== 'cdp' || typeof m.m !== 'string') return;
    let msg: CdpFrame;
    try {
      msg = JSON.parse(m.m) as CdpFrame;
    } catch {
      return;
    }
    if (typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
    this.connected = true;
    const done = (p: Promise<Json>) =>
      void p.then(
        (result) => this.toVault({ id: msg.id, result, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) }),
        (e: Error) => this.toVault({ id: msg.id, error: { code: -32000, message: String(e?.message ?? e).slice(0, 300) }, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) }),
      );
    if (msg.sessionId) {
      const t = this.bySession.get(msg.sessionId);
      if (!t || t.gone) return done(Promise.reject(new Error(`No session with given id`)));
      return done(this.watch(t, msg.method, this.session(t, msg.sessionId, msg.method, msg.params ?? {}) ?? (t.wc.debugger.sendCommand(msg.method, msg.params ?? {}, msg.sessionId) as Promise<Json>)));
    }
    done(this.root(msg.method, msg.params ?? {}));
  }

  /**
   * 보기 명령이 SLOW_CMD_MS 넘게 답이 없으면 명령 이름과 그때 창·보기 상태를 남기고, 끝내 답이 오면 걸린 시간을 남긴다(값 없음).
   * 예행 run-309c3eeb(앱 창이 다른 Space): Playwright 클릭이 10초 넘게 멈췄는데 어느 명령에서인지 몰랐다.
   */
  private watch(t: Tab, method: string, p: Promise<Json>): Promise<Json> {
    // 페이지 안 기다림(Runtime.callFunctionOn awaitPromise 등)은 원래 길다. 입력·DOM 명령만 본다.
    if (!WATCHED_CMD.test(method)) return p;
    const t0 = Date.now();
    let slow = false;
    const timer = setTimeout(() => {
      slow = true;
      const w = this.o.win;
      this.o.log.event('main.embedded_cmd_slow', { method, top: this.top() === t, shown: this.shown(t), win: w.isVisible(), focused: w.isFocused(), minimized: w.isMinimized() });
    }, SLOW_CMD_MS);
    const end = () => {
      clearTimeout(timer);
      if (slow) this.o.log.event('main.embedded_cmd_done', { method, ms: Date.now() - t0 });
    };
    p.then(end, end);
    return p;
  }

  /** 브라우저 수준 명령. 금고 중계(relay.ts·service.ts·pdf/save.ts)가 쓰는 것만 흉내 낸다. */
  private async root(method: string, p: Json): Promise<Json> {
    switch (method) {
      case 'Browser.getVersion':
        return { protocolVersion: '1.3', product: `Chrome/${process.versions.chrome}`, revision: '', userAgent: this.ses.getUserAgent(), jsVersion: process.versions.v8 };
      case 'Target.setDiscoverTargets':
        return {};
      case 'Target.setAutoAttach': {
        this.autoAttach = true;
        // 설치 Chrome의 --app 시작 창과 같은 자리: 금고가 이 창을 실행 탭으로 쓴다(relay.createRunPage).
        if (!this.order.length) await this.openTab(CHROME_APP_START_URL);
        for (const t of this.order) await this.announce(t);
        return {};
      }
      case 'Target.createTarget': {
        const t = await this.openTab(String(p.url ?? 'about:blank'));
        return { targetId: t.targetId };
      }
      case 'Target.attachToTarget': {
        const t = this.tabs.get(String(p.targetId));
        if (!t || t.gone) throw new Error('No target with given id found');
        const r = (await t.wc.debugger.sendCommand('Target.attachToTarget', { targetId: t.targetId, flatten: true })) as { sessionId: string };
        this.own(t, r.sessionId);
        this.topSessions.add(r.sessionId);
        return r;
      }
      case 'Target.detachFromTarget': {
        const sid = String(p.sessionId);
        const t = this.bySession.get(sid);
        if (!t) throw new Error('No session with given id');
        this.bySession.delete(sid);
        this.topSessions.delete(sid);
        t.sessions.delete(sid);
        if (!t.gone) await t.wc.debugger.sendCommand('Target.detachFromTarget', { sessionId: sid }).catch(() => {});
        this.toVault({ method: 'Target.detachedFromTarget', params: { sessionId: sid, targetId: t.targetId } });
        return {};
      }
      case 'Target.getTargetInfo': {
        const t = this.tabs.get(String(p.targetId));
        if (!t || t.gone) throw new Error('No target with given id found');
        return { targetInfo: await this.info(t) };
      }
      case 'Target.closeTarget': {
        const t = this.tabs.get(String(p.targetId));
        if (!t || t.gone) throw new Error('No target with given id found');
        this.drop(t);
        return { success: true };
      }
      case 'Target.activateTarget':
        return {};
      case 'Browser.setPermission': {
        // 금고가 정한 출처·이름만(LOOPBACK_ORIGINS: 홈택스 → 이 PC 보안 프로그램 127.0.0.1). 보기 세션의 권한 처리기가 이 표만 본다.
        const name = String((p.permission as Json | undefined)?.name ?? '');
        const origin = String(p.origin ?? '');
        if (!name || !/^https:\/\/[^/]+$/.test(origin) || p.setting !== 'granted') throw new Error('unsupported permission');
        if (!this.granted.has(origin)) this.granted.set(origin, new Set());
        this.granted.get(origin)!.add(name);
        return {};
      }
      case 'Browser.setDownloadBehavior':
        this.downloadBehavior = p;
        await this.hostDownloads();
        return {};
      case 'Browser.cancelDownload':
        if (this.downloadHost && !this.downloadHost.gone) await this.downloadHost.wc.debugger.sendCommand('Browser.cancelDownload', p).catch(() => {});
        return {};
      case 'Browser.getWindowForTarget':
        return { windowId: 1, bounds: { left: 0, top: 0, width: 0, height: 0, windowState: 'normal' } };
      case 'Browser.setWindowBounds':
        return {};
      case 'Browser.close':
        setImmediate(() => this.closeAll('vault'));
        return {};
    }
    throw new Error(`'${method}' wasn't found`);
  }

  private toVault(m: CdpFrame): void {
    this.o.post({ t: 'cdp', m: JSON.stringify(m) });
  }

  // ───────────────────────── 보기 ─────────────────────────

  private async openTab(url: string, adopt?: WebContents, openerId?: string): Promise<Tab> {
    // 팝업은 Electron이 연 창(window.open)의 webContents를 그대로 받는다(여는 쪽 설정을 물려받는다). 어느 쪽이든 아래에서 실제 설정을 다시 확인한다.
    const view = new WebContentsView({ ...(adopt ? { webContents: adopt } : {}), webPreferences: { partition: EMBEDDED_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, spellcheck: false } });
    const wc = view.webContents;
    try {
      assertWebPrefs(wc);
    } catch (e) {
      wc.close();
      throw e;
    }
    this.policy(wc);
    // 패널이 접히거나 다른 창에 가려져도 자동화 타이머·그리기가 늦춰지지 않게(옛 Chrome의 --disable-renderer-backgrounding과 같은 뜻)
    wc.setBackgroundThrottling(false);
    wc.debugger.attach('1.3');
    // 첫 이동이 시작되기 전의 빈 webContents에는 렌더러가 없어 CDP 명령이 돌아오지 않는다(실측): 이동을 먼저 건다. 팝업은 Electron이 건다.
    const loaded = adopt ? Promise.resolve() : wc.loadURL(url).catch(() => {});
    const { targetInfo } = (await wc.debugger.sendCommand('Target.getTargetInfo')) as { targetInfo: { targetId: string } };
    const t: Tab = { view, wc, targetId: targetInfo.targetId, openerId, sessions: new Set(), gone: false };
    this.tabs.set(t.targetId, t);
    this.order.push(t);
    wc.debugger.on('message', (_e, method: string, params: Json, sessionId?: string) => this.fromTab(t, method, params, sessionId));
    wc.debugger.on('detach', () => this.drop(t));
    wc.once('destroyed', () => this.drop(t));
    // 금고 자기 점검(ADR-010): 자동화 중인 페이지는 navigator.webdriver === true여야 한다. 설치 Chrome은 파이프 기동이 켜 주고, 여기서는 이 보기에만 켠다.
    await wc.debugger.sendCommand('Emulation.setAutomationOverride', { enabled: true });
    await wc.debugger.sendCommand('Target.setDiscoverTargets', { discover: true });
    this.o.win.contentView.addChildView(view, 0);
    this.layout();
    if (this.downloadBehavior && !this.downloadHost) await this.hostDownloads();
    await loaded;
    if (this.autoAttach) await this.announce(t);
    this.o.log.event('main.embedded_tab_opened', { popup: !!openerId });
    return t;
  }

  /** 금고 감시 세션을 열어 금고에 새 타깃으로 알린다(설치 Chrome의 브라우저 수준 자동 부착과 같은 모양, 멈춰 세우지는 않는다). */
  private async announce(t: Tab): Promise<void> {
    if (t.gone || [...this.bySession.values()].includes(t)) return;
    const { sessionId } = (await t.wc.debugger.sendCommand('Target.attachToTarget', { targetId: t.targetId, flatten: true })) as { sessionId: string };
    this.own(t, sessionId);
    this.topSessions.add(sessionId);
    this.toVault({ method: 'Target.attachedToTarget', params: { sessionId, targetInfo: { ...(await this.info(t)), attached: true }, waitingForDebugger: false } });
  }

  /**
   * 세션 명령 중 Electron DevTools에 없는 것: Page.printToPDF(실측 "wasn't found"). 금고 PDF 저장(pdf/save.ts printStream)이 이 보기를
   * 인쇄할 때 보기의 webContents.printToPDF로 대신하고, ReturnAsStream이면 IO.read·IO.close도 여기서 낸다. 그 밖은 null(그대로 넘긴다).
   * 엔진의 Page.printToPDF·IO는 금고 중계가 막으므로 여기 오는 것은 금고 자신의 요청이다.
   */
  private session(t: Tab, sid: string, method: string, p: Json): Promise<Json> | null {
    if (method === 'Page.printToPDF') {
      if (!this.topSessions.has(sid)) return Promise.reject(new Error("'Page.printToPDF' wasn't found"));
      return (async () => {
        const buf = await t.wc.printToPDF({
          landscape: p.landscape === true,
          printBackground: p.printBackground === true,
          preferCSSPageSize: p.preferCSSPageSize === true,
          ...(typeof p.scale === 'number' ? { scale: p.scale } : {}),
          ...(typeof p.pageRanges === 'string' && p.pageRanges ? { pageRanges: p.pageRanges } : {}),
        });
        if (p.transferMode !== 'ReturnAsStream') return { data: buf.toString('base64') };
        const handle = `embedded-pdf-${randomUUID()}`;
        this.pdfStreams.set(handle, { buf, pos: 0 });
        return { stream: handle };
      })();
    }
    const handle = String(p.handle ?? '');
    const st = this.pdfStreams.get(handle);
    if (!st || (method !== 'IO.read' && method !== 'IO.close')) return null;
    if (method === 'IO.close') {
      this.pdfStreams.delete(handle);
      return Promise.resolve({});
    }
    const size = Math.max(1, Math.min(Number(p.size) || 65_536, 1 << 20));
    const chunk = st.buf.subarray(st.pos, st.pos + size);
    st.pos += chunk.length;
    return Promise.resolve({ data: chunk.toString('base64'), base64Encoded: true, eof: st.pos >= st.buf.length });
  }

  private async info(t: Tab): Promise<Json> {
    const { targetInfo } = (await t.wc.debugger.sendCommand('Target.getTargetInfo', { targetId: t.targetId })) as { targetInfo: Json };
    return { ...targetInfo, ...(t.openerId && !targetInfo.openerId ? { openerId: t.openerId } : {}) };
  }

  private own(t: Tab, sessionId: string): void {
    t.sessions.add(sessionId);
    this.bySession.set(sessionId, t);
  }

  private fromTab(t: Tab, method: string, params: Json, sessionId?: string): void {
    if (sessionId) {
      if (!t.sessions.has(sessionId) && !this.bySession.has(sessionId)) return;
      if (method === 'Target.attachedToTarget') this.own(t, String(params.sessionId));
      if (method === 'Target.detachedFromTarget') {
        this.bySession.delete(String(params.sessionId));
        t.sessions.delete(String(params.sessionId));
      }
      this.toVault({ method, params, sessionId });
      return;
    }
    // 보기의 뿌리 세션: 이 보기 것만(앱의 다른 webContents 타깃은 금고에 보이지 않는다)
    if (method === 'Target.targetInfoChanged') {
      const info = params.targetInfo as Json;
      if (info?.targetId !== t.targetId) return;
      this.toVault({ method, params: { targetInfo: { ...info, ...(t.openerId && !info.openerId ? { openerId: t.openerId } : {}) } } });
      if (this.top() === t) this.o.onPage?.({ url: String(info.url ?? ''), title: String(info.title ?? '') });
    } else if (method === 'Target.detachedFromTarget' && t.sessions.has(String(params.sessionId))) {
      this.bySession.delete(String(params.sessionId));
      t.sessions.delete(String(params.sessionId));
      this.toVault({ method, params });
    } else if (method.startsWith('Browser.download') && t === this.downloadHost) {
      this.toVault({ method, params });
    }
  }

  /** 받기 설정은 브라우저(파티션) 단위다. 이벤트가 두 번 오지 않게 보기 하나의 뿌리 세션에만 건다. 그 보기가 닫히면 다음 보기로 옮긴다. */
  private async hostDownloads(): Promise<void> {
    if (!this.downloadBehavior) return;
    const host = this.order.find((x) => !x.gone) ?? null;
    this.downloadHost = host;
    if (host) await host.wc.debugger.sendCommand('Browser.setDownloadBehavior', this.downloadBehavior).catch(() => {});
  }

  /** 보기 이동·새 창·권한 규칙. 셸 하드닝(harden.ts)은 이 파티션의 이동만 막지 않는다(NAV_EXEMPT_SESSIONS). */
  private policy(wc: WebContents): void {
    const guard = (e: { url: string; preventDefault(): void }) => {
      if (BLOCKED_SCHEMES.test(e.url)) {
        e.preventDefault();
        this.o.log.event('main.embedded_nav_blocked', { scheme: e.url.split(':')[0]!.slice(0, 20) });
      }
    };
    wc.on('will-navigate', guard);
    wc.on('will-frame-navigate', guard);
    wc.on('will-redirect', guard);
    wc.on('will-attach-webview', (e) => e.preventDefault());
    // 확대·축소는 호스트마다다(홈택스 ↔ teet 등 다른 호스트로 가면 1로 돌아간다): 문서가 바뀔 때마다 지금 배율을 다시 건다.
    wc.on('did-navigate', () => wc.setZoomFactor(this.zoom()));
    wc.on('before-input-event', (e) => {
      if (this.blocked) e.preventDefault();
    });
    wc.on('before-mouse-event', (e) => {
      if (this.blocked) e.preventDefault();
    });
    wc.setWindowOpenHandler(({ url }) => {
      // 포털 팝업(window.open): 같은 파티션의 숨은 보기로 열고 금고에 새 타깃으로 알린다(금고가 허용 출처만 엔진에 노출한다).
      if (!/^(https?:|about:blank)/i.test(url)) return { action: 'deny' };
      const opener = [...this.tabs.values()].find((x) => x.wc === wc);
      return {
        action: 'allow',
        createWindow: (options) => {
          const guest = (options as { webContents?: WebContents }).webContents;
          if (!guest) throw new Error('no guest webContents');
          void this.openTab(url, guest, opener?.targetId).catch((e: Error) => this.o.log.event('main.embedded_popup_failed', { error: e.message.slice(0, 120) }));
          return guest;
        },
      };
    });
  }

  private top(): Tab | undefined {
    return this.order.filter((x) => !x.gone).at(-1);
  }

  private drop(t: Tab): void {
    if (t.gone) return;
    t.gone = true;
    this.tabs.delete(t.targetId);
    this.order = this.order.filter((x) => x !== t);
    for (const sid of t.sessions) {
      this.bySession.delete(sid);
      this.topSessions.delete(sid);
      if (this.connected) this.toVault({ method: 'Target.detachedFromTarget', params: { sessionId: sid, targetId: t.targetId } });
    }
    t.sessions.clear();
    if (this.connected) this.toVault({ method: 'Target.targetDestroyed', params: { targetId: t.targetId } });
    try {
      this.o.win.contentView.removeChildView(t.view);
    } catch {
      // 창이 먼저 닫혔다
    }
    if (!t.wc.isDestroyed()) {
      try {
        t.wc.debugger.detach();
      } catch {
        // 이미 떨어졌다
      }
      t.wc.close();
    }
    if (this.downloadHost === t) void this.hostDownloads();
    this.layout();
  }

  /** 금고가 내렸거나(cdp_closed) 창이 닫힌다. 보기를 모두 닫는다. 창 쪽 닫힘이면 금고에 알린다. */
  closeAll(why: 'vault' | 'window'): void {
    const wasConnected = this.connected;
    this.connected = false;
    for (const t of [...this.order]) this.drop(t);
    this.autoAttach = false;
    this.downloadHost = null;
    this.downloadBehavior = null;
    this.granted.clear();
    this.pdfStreams.clear();
    this.setBlocked(false);
    if (why === 'window' && wasConnected) this.o.post({ t: 'cdp_closed' });
    this.o.onPage?.(null);
  }

  // ───────────────────────── 패널 자리 ─────────────────────────

  /** 패널의 화면 자리(창 콘텐츠 기준 DIP). null이면 보기를 패널에서 빼 구석에 걸쳐 둔다(자동화는 계속 돈다, place 참고). */
  setSlot(r: Rectangle | null): void {
    this.slot = r;
    this.layout();
  }

  /** 패널 폭에 PAGE_WIDTH CSS px가 들어가는 배율(넓으면 1). */
  private zoom(): number {
    return Math.min(1, this.placed.width / PAGE_WIDTH);
  }

  private layout(): void {
    this.place();
    const top = this.top();
    if (top) this.o.onPage?.({ url: top.wc.getURL(), title: top.wc.getTitle() });
  }

  /** 패널에 보이는 보기인가(맨 위 탭이고 패널 자리가 있다). */
  private shown(t: Tab): boolean {
    return t === this.top() && this.slot !== null;
  }

  /**
   * 보기 자리. 패널에 보이는 탭은 패널 자리에 둔다. 나머지는 숨기지 않고 같은 크기·배율로 창 콘텐츠 오른쪽 아래 구석에
   * 1px만 걸쳐 둔다(park). setVisible(false)나 창 밖으로 내보내면 viz가 그려지지 않는 보기의 BeginFrame을 초당 1번으로 줄여
   * (undrawn frame 제한) rAF가 멈추고, Playwright 클릭이 동작 가능 확인에서 시간 초과로 끝난다(0.1.21 예행 run-e675cd05: 창이 보이고
   * 포커스여도 클릭마다 raf 0). 1px이라도 그려지면 제한이 없다(측정 rAF 121). 걸친 1px은 창의 둥근 모서리 안이라 보이지 않는다.
   * 탭마다 구석 칸을 하나씩 왼쪽으로 옮긴다: 먼저 연 탭이 위(addChildView 0 = 맨 아래에 새 탭)라 k번째 탭의 왼쪽 끝 칸은 더 새 탭에 덮이지 않는다.
   */
  private place(): void {
    if (this.o.win.isDestroyed()) return;
    if (this.slot) this.placed = this.slot;
    const zoom = this.zoom();
    const [cw, ch] = this.o.win.getContentSize() as [number, number];
    this.order.forEach((t, k) => {
      if (t.gone) return;
      t.view.setBounds(this.shown(t) ? this.placed : { x: Math.max(0, cw - 1 - k), y: Math.max(0, ch - 1), width: this.placed.width, height: this.placed.height });
      if (Math.abs(t.wc.getZoomFactor() - zoom) > 0.001) t.wc.setZoomFactor(zoom);
      t.view.setVisible(true);
    });
  }

  /** 금고가 비밀 칸에 넣는 동안 사람 입력(키·마우스)을 막는다. */
  setBlocked(on: boolean): void {
    this.blocked = on;
  }

  /** 사람 차례: 보기에 키보드 포커스. */
  focus(): void {
    this.top()?.wc.focus();
  }

  get hasPage(): boolean {
    return this.order.length > 0;
  }
}
